#!/usr/bin/env python3
"""tmux 3.6 measurement for agentbridge, run on 192.0.2.20 via `ssh ... python3 -I -`.

Only own sockets are addressed:
  abtest_ux36_5  inventory matrix like the 2026-09-12 3.4 run: -f /dev/null,
                 addressed as -S /tmp/tmux-<uid>/abtest_ux36_5 (the same socket
                 file that -L abtest_ux36_5 derives), LC_ALL=C, TMUX* removed.
  abtest_ux36_1  product flow: exact product command lines (remote::build
                 encoding, executed by bash -c like sshd does), default config
                 (~/.tmux.conf is read by the server start, as in the product).
Every server started here is killed in `finally`; socket files of exactly these
names are removed afterwards. Pane programs are sleep or a tiny python process
that renames itself (prctl) and sets an OSC 2 title; no agent and no
interactive shell is started. Output: one JSON object per line on stdout.
"""
import base64
import fcntl
import hashlib
import json
import os
import select
import stat
import struct
import subprocess
import sys
import termios
import threading
import time

UID = os.getuid()
SOCKDIR = f"/tmp/tmux-{UID}"
S1 = "abtest_ux36_1"
S5 = "abtest_ux36_5"
OWN = (S1, S5)
P1 = f"{SOCKDIR}/{S1}"
P5 = f"{SOCKDIR}/{S5}"
OWN_PATHS = (P1, P5)
TMUX = "/usr/bin/tmux"
START = time.monotonic()
TOTAL = 240.0
PTYS = []
SERVER_PIDS = set()
FAKE_PIDS = set()

# --- verbatim product constants (agentbridge HEAD 101b454) -----------------
LIST_FORMAT = "L|#{pid}|#{start_time}|#{session_id}|#{session_name}"
RESOLVE_FORMAT = ("R|#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}"
                  "|#{window_active}|#{session_windows}")
CREATE_FORMAT = "C|#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}"
GUARD_REJECT = "list-commands -F '#{?#{==:#{command_list_name},display-message},AB_M1_REJECT,}'"
BEGIN = "B|#{pid}|#{start_time}"
END = "E|#{pid}|#{start_time}"
SESSIONS = "Q|#{session_id}|#{session_windows}"
PANES = ("P|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{window_active}|#{pane_active}"
         "|#{pane_dead}|#{alternate_on}|#{session_attached}|#{window_activity}"
         "|#{window_bell_flag}|#{window_panes}")
PANES_COMMAND = "list-panes -a -F '" + PANES + "'"
BEGIN_3_0 = "list-commands -F '#{?#{==:#{command_list_name},display-message},B|#{pid}|#{start_time},}'"
END_3_0 = "list-commands -F '#{?#{==:#{command_list_name},display-message},E|#{pid}|#{start_time},}'"
J_FORMAT = ("J|#{pid}|#{start_time}|#{client_pid}|#{client_created}|#{session_id}|#{window_id}"
            "|#{pane_id}|#{pane_pid}|#{window_active}|#{pane_active}|#{pane_dead}"
            "|#{client_control_mode}|#{client_readonly}|#{client_tty}|#{client_uid}|#{client_flags}")
SOCKET_FORMAT = "S|#{pid}|#{start_time}|#{session_id}|#{socket_path}"
INV_DIRECT = ["display-message", "-p", BEGIN, ";", "list-sessions", "-F", SESSIONS, ";",
              "if-shell", "-F", "#{session_id}", PANES_COMMAND, ";", "display-message", "-p", END]
INV_GUARDED = ["if-shell", "-F", "1", BEGIN_3_0, ";", "list-sessions", "-F", SESSIONS, ";",
               "if-shell", "-F", "#{session_id}", PANES_COMMAND, ";", "if-shell", "-F", "1", END_3_0]

WRAPPER = r'''set -efu
nonce=$1
shift
IFS= read -r stamp < "/proc/$$/stat"
stamp=${stamp##*) }
set_args_unused=1
ticks=$(printf '%s\n' "$stamp" | { read -r state ppid pgrp sid device rest; set -- $rest; printf '%s' "${15}"; })
set -- "$@"
device=$(printf '%s\n' "$stamp" | { read -r state ppid pgrp sid device rest; printf '%s' "$device"; })
uid=$(id -u)
terminal=$(tty)
printf 'W|%s|%s|%s|%s|%s|%s\n' "$nonce" "$$" "$ticks" "$uid" "$device" "$terminal"
exec "$@"
'''

PROCESS = r'''set -efu
pid=$1
IFS= read -r stamp < "/proc/$pid/stat"
stamp=${stamp##*) }
set -- $stamp
state=$1
device=$5
ticks=${20}
found=0
while IFS= read -r line; do
 case "$line" in
  Uid:*) set -- $line; test "$#" -eq 5; test "$2" = "$3"; test "$2" = "$4"; test "$2" = "$5"; uid=$2; found=$((found + 1));;
 esac
done < "/proc/$pid/status"
test "$found" -eq 1
terminal=$(readlink "/proc/$pid/fd/0")
printf 'P|%s|%s|%s|%s|%s|%s\n' "$pid" "$ticks" "$uid" "$device" "$terminal" "$state"
'''

DETAILS_SCRIPT = r'''sock=$1
shift
while [ "$#" -ge 2 ]; do
  pane=$1
  pid=$2
  shift 2
  title=$(tmux -u -L "$sock" display-message -p -t "$pane" '#{pane_title}' 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
  printf 'T %s %s\n' "$pane" "$title"
  for child in $(cat /proc/"$pid"/task/*/children 2>/dev/null); do
    printf 'C %s %s\n' "$pane" "$(od -An -v -tx1 /proc/"$child"/comm 2>/dev/null | tr -d ' \n')"
    for grandchild in $(cat /proc/"$child"/task/*/children 2>/dev/null); do
      printf 'G %s %s\n' "$pane" "$(od -An -v -tx1 /proc/"$grandchild"/comm 2>/dev/null | tr -d ' \n')"
    done
  done
done
exit 0'''

SOCKET_PATH_SCRIPT = r'''d=${TMUX_TMPDIR:-/tmp}
r=$(cd -- "$d/tmux-$(id -u)" 2>/dev/null && pwd -P) || exit 1
printf 'S|%s/%s\n' "$r" "$1"'''

# Fake agent: sh (pane start process) forks python, which renames itself to the
# given comm and sets the pane title via OSC 2, then sleeps.
FAKE_PY = ("import ctypes,os,sys,time\n"
           "ctypes.CDLL(None).prctl(15, sys.argv[1].encode(), 0, 0, 0)\n"
           "os.write(1, b'\\x1b]2;' + sys.argv[2].encode() + b'\\x1b\\\\')\n"
           "time.sleep(float(sys.argv[3]))\n")
FAKE_SH = 'python3 -I -c "$0" "$1" "$2" "$3"; :'


def fake(comm, title, seconds="240"):
    return ["/bin/sh", "-c", FAKE_SH, FAKE_PY, comm, title, seconds]


# --- helpers ---------------------------------------------------------------
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def check_deadline():
    if time.monotonic() - START > TOTAL:
        raise RuntimeError("total_deadline")


def build(argv):
    """Same line as agentbridge remote::build."""
    assert argv and all("\0" not in a for a in argv)
    prelude = "".join(" A%d=$(printf %%s '%s' | base64 -d);"
                      % (i, base64.b64encode(a.encode()).decode()) for i, a in enumerate(argv))
    call = "".join(' "$A%d"' % i for i in range(len(argv)))
    return "set -eu;%s exec%s" % (prelude, call)


def guard_argv(argv):
    """Refuse any tmux invocation that does not address one of the own sockets."""
    for index, value in enumerate(argv):
        if value in ("tmux", TMUX):
            rest = argv[index + 1:]
            if rest[:1] == ["-u"]:
                rest = rest[1:]
            if rest == ["-V"]:
                return  # version query, contacts no server
            ok = len(rest) >= 2 and ((rest[0] == "-L" and rest[1] in OWN)
                                     or (rest[0] == "-S" and rest[1] in OWN_PATHS))
            if not ok:
                raise RuntimeError("refusing foreign tmux socket: %r" % (argv,))
            return
    if argv[:2] == ["sh", "-c"] and argv[3] in ("agentbridge-panes", "agentbridge-socket"):
        if argv[4] not in OWN:
            raise RuntimeError("refusing foreign socket in script: %r" % (argv,))


def text(data):
    try:
        return data.decode("utf-8"), True
    except UnicodeDecodeError:
        return data.decode("utf-8", "replace"), False


def run(name, argv, *, via="product", env=None, timeout=10.0, extra=None):
    check_deadline()
    guard_argv(argv)
    cmd = ["/bin/bash", "-c", build(argv)] if via == "product" else argv
    started = time.monotonic()
    try:
        proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout,
                              env=env, close_fds=True, start_new_session=True)
        code, out, err, term = proc.returncode, proc.stdout, proc.stderr, "exit"
    except subprocess.TimeoutExpired as error:
        code, out, err, term = None, error.stdout or b"", error.stderr or b"", "deadline"
    so, sv = text(out)
    se, ev = text(err)
    row = {"kind": "command", "name": name, "via": via, "argv": argv, "exit_code": code,
           "termination": term, "complete_eof": term == "exit", "stdout": so, "stderr": se,
           "stdout_utf8_valid": sv, "stderr_utf8_valid": ev,
           "ms": round((time.monotonic() - started) * 1000, 3)}
    if not sv:
        row["stdout_b64"] = base64.b64encode(out).decode()
    if extra:
        row.update(extra)
    emit(row)
    return row


def lines(row, marker):
    return [line.split("|") for line in row["stdout"].split("\n") if line.startswith(marker + "|")]


def server_of(row):
    for marker in ("B", "C", "R", "L", "S", "J"):
        found = lines(row, marker)
        if found:
            SERVER_PIDS.add(int(found[0][1]))
            return int(found[0][1]), int(found[0][2])
    return None


def wait_pid_gone(pid, seconds=3.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not os.path.exists(f"/proc/{pid}"):
            return True
        time.sleep(0.02)
    return not os.path.exists(f"/proc/{pid}")


def remove_own_socket(path):
    assert path in OWN_PATHS
    if not os.path.lexists(path):
        return "absent"
    st = os.lstat(path)
    if stat.S_ISSOCK(st.st_mode) and st.st_uid == UID:
        os.unlink(path)
        return "removed"
    return "kept_not_own_socket"


class Pty:
    def __init__(self, label, line, cols=120, rows=30):
        self.label = label
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.tty = os.ttyname(slave)
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        for key in ("TMUX", "TMUX_PANE"):
            env.pop(key, None)

        def controlling():
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.proc = subprocess.Popen(["/bin/bash", "-c", line], stdin=slave, stdout=slave,
                                     stderr=slave, env=env, start_new_session=True,
                                     preexec_fn=controlling, close_fds=True)
        os.close(slave)
        PTYS.append(self)
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.eof = False
        self.stop = False
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        while not self.stop:
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if not ready:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                data = b""
            if not data:
                self.eof = True
                return
            with self.lock:
                room = (1 << 20) - len(self.buf)
                if room > 0:
                    self.buf.extend(data[:room])

    def snapshot(self):
        with self.lock:
            return bytes(self.buf)

    def wait_for(self, predicate, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            data = self.snapshot()
            if predicate(data):
                return data
            if self.proc.poll() is not None and self.eof:
                return None
            time.sleep(0.01)
        return None

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(2)
        self.stop = True
        self.reader.join(1)
        try:
            os.close(self.master)
        except OSError:
            pass


# --- product argv builders ---------------------------------------------------
def q(sock):
    return ["env", "LC_ALL=C", "tmux", "-u", "-L", sock]


def qs(path):
    return ["env", "LC_ALL=C", "tmux", "-u", "-S", path]


def plain(sock):
    return ["tmux", "-L", sock]


def guard_kill(pid, start, sid):
    target = f"${sid}"
    test = "#{==:#{pid}/#{start_time}/#{session_id}," + f"{pid}/{start}/{target}" + "}"
    return ["if-shell", "-F", "-t", target, test, f"kill-session -t '{target}'", GUARD_REJECT]


def guard_attach(sel):
    pid, start, sid, wid, pane, pane_pid = sel
    target = f"${sid}"
    test = ("#{==:#{pid}/#{start_time}/#{session_id}/#{window_id}/#{pane_id}/#{pane_pid}"
            "/#{window_active}/#{pane_active}/#{pane_dead},"
            + f"{pid}/{start}/{target}/@{wid}/%{pane}/{pane_pid}/1/1/0" + "}")
    return ["if-shell", "-F", "-t", target, test, f"attach-session -t '{target}'", GUARD_REJECT]


def create(sock, name, program, cwd="/tmp"):
    return plain(sock) + ["new-session", "-d", "-P", "-F", CREATE_FORMAT, "-s", name, "-c", cwd] \
        + program + [";", "set", "-g", "exit-empty", "on"]


def selected_from_resolve(row):
    for f in lines(row, "R"):
        if f[7] == "1":
            return (int(f[1]), int(f[2]), int(f[3][1:]), int(f[4][1:]), int(f[5][1:]), int(f[6]))
    return None


def open_flow(prefix, sock, sel):
    """The confirmed open: S probes, wrapper PTY, process probe, J poll, L/R/I/R/L."""
    sid = sel[2]
    named = run(prefix + "_named_probe", q(sock) + ["display-message", "-p", "-t", f"${sid}",
                                                      "-F", SOCKET_FORMAT])
    found = lines(named, "S")
    if not found:
        emit({"kind": "note", "name": prefix, "error": "no S line"})
        return
    path = "|".join(found[0][4:])
    if path not in OWN_PATHS:
        emit({"kind": "note", "name": prefix, "error": "unexpected socket path", "path": path})
        return
    run(prefix + "_absolute_probe", qs(path) + ["display-message", "-p", "-t", f"${sid}",
                                                "-F", SOCKET_FORMAT])
    guard_line_argv = qs(path) + guard_attach(sel)
    guard_argv(guard_line_argv)
    nonce = "%032x" % time.time_ns()
    attach_argv = ["sh", "-c", WRAPPER, "agentbridge-wrapper", nonce, "sh", "-c",
                   build(guard_line_argv)]
    pty = Pty(prefix, build(attach_argv))
    raw = pty.wait_for(lambda data: b"\n" in data, 5.0)
    w_line = None
    w = None
    if raw is not None:
        w_line = raw.split(b"\n", 1)[0].rstrip(b"\r").decode("ascii", "replace")
        f = w_line.split("|")
        if len(f) == 7 and f[0] == "W" and f[1] == nonce:
            w = {"pid": int(f[2]), "ticks": int(f[3]), "uid": int(f[4]), "tty_nr": int(f[5]),
                 "tty": f[6]}
    emit({"kind": "pty_wrapper", "name": prefix, "tty": pty.tty, "nonce": nonce,
          "attach_argv": attach_argv, "guard_argv": guard_line_argv, "w_line": w_line, "w": w})
    if w is None:
        pty.close()
        return
    run(prefix + "_process", ["sh", "-c", PROCESS, "agentbridge-process", str(w["pid"])])
    registered = None
    for attempt in range(64):
        j = run(f"{prefix}_j_{attempt}", qs(path) + ["list-clients", "-F", J_FORMAT])
        rows = [r for r in lines(j, "J") if len(r) >= 4 and r[3] == str(w["pid"])]
        if rows and rows[0][-1] != "":
            registered = attempt
            break
        time.sleep(0.02)
    emit({"kind": "note", "name": prefix + "_registered_attempt", "attempt": registered})
    run(prefix + "_confirm_l0", qs(path) + ["list-sessions", "-F", LIST_FORMAT])
    run(prefix + "_confirm_r0", qs(path) + ["list-windows", "-t", f"${sid}", "-F", RESOLVE_FORMAT])
    run(prefix + "_confirm_inventory", qs(path) + INV_GUARDED)
    run(prefix + "_confirm_r1", qs(path) + ["list-windows", "-t", f"${sid}", "-F", RESOLVE_FORMAT])
    run(prefix + "_confirm_l1", qs(path) + ["list-sessions", "-F", LIST_FORMAT])
    run(prefix + "_j_after", qs(path) + ["list-clients", "-F", J_FORMAT])
    run(prefix + "_detach", qs(path) + ["detach-client", "-t", w["tty"]])
    try:
        pty.proc.wait(5)
    except subprocess.TimeoutExpired:
        pass
    pty.wait_for(lambda data: False, 0.3)
    data = pty.snapshot()
    emit({"kind": "pty_end", "name": prefix, "exit_code": pty.proc.poll(), "bytes": len(data),
          "head_b64": base64.b64encode(data[:4096]).decode(),
          "tail_b64": base64.b64encode(data[-1024:]).decode()})
    pty.close()
    run(prefix + "_j_detached", qs(path) + ["list-clients", "-F", J_FORMAT])


# --- phases -------------------------------------------------------------------
def preflight():
    for path in OWN_PATHS:
        if os.path.lexists(path):
            raise RuntimeError("own socket path already exists: " + path)
    with open(TMUX, "rb") as handle:
        binary = handle.read()
    release = {}
    try:
        with open("/etc/os-release", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(("PRETTY_NAME=", "VERSION_ID=")):
                    key, _, value = line.strip().partition("=")
                    release[key] = value.strip('"')
    except OSError:
        pass
    emit({"kind": "meta", "started_unix_ms": time.time_ns() // 1000000, "uid": UID,
          "host": os.uname().nodename, "kernel": os.uname().release, "os_release": release,
          "python": sys.version.split()[0], "tmux_path": TMUX,
          "tmux_sha256": hashlib.sha256(binary).hexdigest(), "tmux_bytes": len(binary),
          "binary_has_nul_3_6a_nul": binary.count(b"\x003.6a\x00"),
          "binary_has_nul_3_6_nul": binary.count(b"\x003.6\x00"),
          "env": {k: os.environ.get(k) for k in ("LANG", "LC_ALL", "LC_CTYPE", "TERM",
                                                  "TMUX", "TMUX_TMPDIR", "SHELL", "PATH")},
          "sockdir_before": sorted(os.listdir(SOCKDIR)) if os.path.isdir(SOCKDIR) else None})


def matrix():
    env = dict(os.environ)
    for key in ("TMUX", "TMUX_PANE", "TMUX_TMPDIR"):
        env.pop(key, None)
    env["LC_ALL"] = "C"

    def tm(name, args, **kwargs):
        return run(name, [TMUX, "-u", "-S", P5, "-f", "/dev/null"] + args, via="direct", env=env,
                   **kwargs)

    def panes(row):
        server_of(row)
        return lines(row, "P")

    run("matrix_version", [TMUX, "-V"], via="direct", env=env)
    for i in range(1, 4):
        tm(f"absent_poll_{i}", INV_DIRECT, extra={"socket_absent_after": None})
        emit({"kind": "note", "name": f"absent_poll_{i}_socket_absent_after",
              "value": not os.path.lexists(P5)})
    tm("start_empty_server", ["start-server", ";", "set-option", "-s", "exit-empty", "off"])
    tm("confirm_exit_empty", ["show-options", "-sv", "exit-empty"])
    tm("plain_empty_panes", ["list-panes", "-a", "-F", PANES])
    for i in range(1, 4):
        server_of(tm(f"guarded_empty_{i}", INV_DIRECT))
    tm("create_named", ["new-session", "-d", "-s", "same_name", "/bin/sleep", "300"])
    first = panes(tm("first_named", INV_DIRECT))
    for i in range(1, 4):
        tm(f"replace_kill_{i}", ["kill-session", "-t", "=same_name"])
        tm(f"replace_create_{i}", ["new-session", "-d", "-s", "same_name", "/bin/sleep", "300"])
        first = panes(tm(f"same_name_replaced_{i}", INV_DIRECT))
    for i in range(1, 4):
        tm(f"respawn_{i}", ["respawn-pane", "-k", "-t", first[0][3], "/bin/sleep", "300"])
        first = panes(tm(f"respawn_snapshot_{i}", INV_DIRECT))
    pane, session = first[0][3], first[0][1]
    for name, title in [("separator", "alpha|Q|$999|1"), ("controls", "alpha\nbeta\rgamma\tdelta")]:
        tm("set_title_" + name, ["select-pane", "-t", pane, "-T", title])
        tm("read_title_" + name, ["display-message", "-p", "-t", pane, "#{pane_title}"])
        tm("metadata_excluded_" + name, INV_DIRECT)
    tm("set_control_option", ["set-option", "-t", session, "@ab_inventory_probe",
                              "Q|$999|1\nP|fake\tend"])
    tm("read_control_option", ["display-message", "-p", "-t", pane, "#{@ab_inventory_probe}"])
    tm("option_excluded", INV_DIRECT)
    # Extra (not one of the 28 cases): output escaping of other control bytes.
    tm("set_escape_option", ["set-option", "-t", session, "@ab_escape_probe",
                             "a\x1bb\x01c\rd\x7fe"])
    tm("read_escape_option", ["display-message", "-p", "-t", pane, "#{@ab_escape_probe}"])
    tm("split_second_pane", ["split-window", "-d", "-t", pane, "/bin/sleep", "300"])
    tm("two_panes", INV_DIRECT)
    tm("partial_failure", ["display-message", "-p", "B|#{pid}|#{start_time}", ";",
                           "list-panes", "-t", "%999999999", "-F", PANES, ";",
                           "display-message", "-p", "E|#{pid}|#{start_time}"])
    after = None
    for i in range(1, 4):
        old = server_of(tm(f"before_restart_{i}", INV_DIRECT))
        tm(f"restart_stop_{i}", ["kill-server"])
        gone = wait_pid_gone(old[0])
        tm(f"inert_poll_{i}", INV_DIRECT)
        removed = remove_own_socket(P5)
        waited = time.monotonic()
        while int(time.time()) <= old[1] and time.monotonic() - waited < 1.5:
            time.sleep(0.02)
        emit({"kind": "note", "name": f"restart_{i}", "old_server_gone": gone,
              "socket": removed, "restart_wait_ms": round((time.monotonic() - waited) * 1000, 3)})
        tm(f"restart_create_{i}", ["new-session", "-d", "-s", "same_name", "/bin/sleep", "300"])
        after = tm(f"after_restart_{i}", INV_DIRECT)
        server_of(after)
    # J reference without ~/.tmux.conf: same confirmed open flow on this server.
    p = lines(after, "P")[0]
    srv = server_of(after)
    sel = (srv[0], srv[1], int(p[1][1:]), int(p[2][1:]), int(p[3][1:]), int(p[4]))
    open_flow("m_open", S5, sel)
    tm("matrix_stop", ["kill-server"])
    wait_pid_gone(srv[0])
    emit({"kind": "note", "name": "matrix_socket_cleanup", "socket": remove_own_socket(P5)})


def product():
    s = S1
    run("p_version", q(s) + ["-V"])
    run("p_absent_list", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    run("p_absent_socket_path", ["sh", "-c", SOCKET_PATH_SCRIPT, "agentbridge-socket", s])
    run("p_absent_inventory_direct", q(s) + INV_DIRECT)
    run("p_absent_inventory_guarded", q(s) + INV_GUARDED)
    run("p_absent_names", q(s) + ["list-sessions", "-F", "#{session_name}"])
    run("p_absent_kill_name", q(s) + ["kill-session", "-t", "=ab_missing"])
    run("p_absent_guard_kill", q(s) + guard_kill(1, 1, 0))
    run("p_absent_socket_probe", q(s) + ["display-message", "-p", "-t", "$0", "-F", SOCKET_FORMAT])
    emit({"kind": "note", "name": "p_absent_socket_absent_after", "value": not os.path.lexists(P1)})
    # prepare_server, exactly as TmuxClient::prepare_server (history_limit 10000)
    run("p_prepare_1", plain(s) + ["start-server", ";", "set", "-g", "exit-empty", "off"])
    run("p_prepare_2", plain(s) + ["set", "-g", "history-limit", "10000"])
    run("p_prepare_3", plain(s) + ["setw", "-g", "remain-on-exit", "on"])
    run("p_prepare_4", plain(s) + ["set", "-g", "terminal-overrides", ",*:smcup@:rmcup@"])
    for name, args in [("history", ["show-options", "-gv", "history-limit"]),
                       ("mouse", ["show-options", "-gv", "mouse"]),
                       ("exit_empty", ["show-options", "-gv", "exit-empty"]),
                       ("remain", ["show-options", "-gwv", "remain-on-exit"]),
                       ("allow_set_title", ["show-options", "-gwv", "allow-set-title"])]:
        run("p_cfg_" + name, q(s) + args)
    run("p_empty_list", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    empty = run("p_empty_inventory_direct", q(s) + INV_DIRECT)
    run("p_empty_inventory_guarded", q(s) + INV_GUARDED)
    run("p_empty_names", q(s) + ["list-sessions", "-F", "#{session_name}"])
    run("p_empty_kill_name", q(s) + ["kill-session", "-t", "=ab_missing"])
    srv = server_of(empty)
    run("p_empty_guard_kill", q(s) + guard_kill(srv[0], srv[1], 0))
    run("p_empty_resolve_missing", q(s) + ["list-windows", "-t", "$4294967295", "-F", RESOLVE_FORMAT])
    run("p_empty_clients", qs(P1) + ["list-clients", "-F", J_FORMAT])

    created = {}
    for label, name, program in [
            ("codex", "ab_ux36_codex", fake("codex", "⠸ thread | home")),
            ("grok", "ab_ux36_grok", fake("grok", "⠴ - Thinking - chat - grok")),
            ("grokwait", "ab_ux36_grokwait",
             fake("grok", "⚠ Action Required - ⠧ - step… - chat - grok")),
            ("plain", "ab_ux36_plain", ["/bin/sleep", "240"]),
            ("dead", "ab_ux36_dead", ["/bin/sh", "-c", "exit 3"]),
            ("kill", "ab_ux36_kill", ["/bin/sleep", "240"]),
            ("namekill", "ab_ux36_namekill", ["/bin/sleep", "240"]),
            ("rename", "ab_ux36_rename", ["/bin/sleep", "240"]),
            ("repl", "ab_ux36_repl", ["/bin/sleep", "240"])]:
        run(f"p_{label}_names_before", q(s) + ["list-sessions", "-F", LIST_FORMAT])
        row = run(f"p_{label}_create", create(s, name, program))
        run(f"p_{label}_names_after", q(s) + ["list-sessions", "-F", LIST_FORMAT])
        c = lines(row, "C")
        if c:
            created[label] = {"sid": int(c[0][3][1:]), "wid": int(c[0][4][1:]),
                              "pane": int(c[0][5][1:]), "pane_pid": int(c[0][6]),
                              "server": (int(c[0][1]), int(c[0][2]))}
            SERVER_PIDS.add(int(c[0][1]))
    run("p_duplicate_create", create(s, "ab_ux36_plain", ["/bin/sleep", "240"]))
    run("p_missing_exact_name", q(s) + ["list-windows", "-t", "=ab_ux36", "-F", RESOLVE_FORMAT])

    foreign = [("unicode", "prüfung"), ("spaces", " edge "),
               ("punctuation", "cash$back\\slash|semi;quote'#[x]"),
               ("leading_dollar", "$legacy"), ("backslash_dollar", "back\\$pair")]
    foreign_ids = {}
    for label, name in foreign:
        row = run("p_foreign_create_" + label, plain(s) + ["new-session", "-d", "-P", "-F",
                                                           "#{session_id}", "-s", name,
                                                           "/bin/sleep", "240"])
        foreign_ids[label] = row["stdout"].strip()
    listed = run("p_foreign_list", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    names_by_id = {f[3]: "|".join(f[4:]) for f in lines(listed, "L")}
    for label, name in foreign:
        listed_name = names_by_id.get(foreign_ids[label])
        emit({"kind": "note", "name": "p_foreign_name_" + label, "requested": name,
              "session_id": foreign_ids[label], "listed": listed_name,
              "equal": listed_name == name})
        run("p_has_requested_" + label, q(s) + ["has-session", "-t", "=" + name])
        if listed_name is not None and listed_name != name:
            run("p_has_listed_" + label, q(s) + ["has-session", "-t", "=" + listed_name])

    if "plain" in created:
        c = created["plain"]
        run("p_plain_new_window", plain(s) + ["new-window", "-d", "-t", f"${c['sid']}:",
                                              "/bin/sleep", "240"])
        split = run("p_plain_split", plain(s) + ["split-window", "-d", "-P", "-F", "#{pane_id}",
                                                 "-t", f"%{c['pane']}", "/bin/sleep", "240"])
        new_pane = split["stdout"].strip()
        if new_pane.startswith("%"):
            run("p_plain_select_pane", plain(s) + ["select-pane", "-t", new_pane])
    time.sleep(1.0)  # titles of the fake panes

    # observe_sessions sequence
    l0 = run("p_obs_l0", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    sids = [f[3] for f in lines(l0, "L")]
    resolved = {}
    for sid in sids:
        resolved[sid] = run(f"p_obs_r0_{sid}", q(s) + ["list-windows", "-t", sid, "-F", RESOLVE_FORMAT])
    inventory = run("p_obs_inventory", q(s) + INV_DIRECT)
    for sid in sids:
        run(f"p_obs_r1_{sid}", q(s) + ["list-windows", "-t", sid, "-F", RESOLVE_FORMAT])
    run("p_obs_l1", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    run("p_obs_inventory_guarded_named", q(s) + INV_GUARDED)
    run("p_obs_inventory_guarded_absolute", qs(P1) + INV_GUARDED)
    run("p_obs_names", q(s) + ["list-sessions", "-F", "#{session_name}"])

    # title details for each session's single live active pane (title_panes)
    actives = {}
    for f in lines(inventory, "P"):
        if f[5] == "1" and f[6] == "1":
            actives.setdefault(f[1], []).append(f)
    args = []
    for sid in sorted(actives, key=lambda v: int(v[1:])):
        rows = actives[sid]
        if len(rows) == 1 and rows[0][7] == "0":
            args += [rows[0][3], rows[0][4]]
            FAKE_PIDS.add(int(rows[0][4]))
    if args:
        run("p_details", ["sh", "-c", DETAILS_SCRIPT, "agentbridge-panes", s] + args)
    children = {}
    for pid in sorted(FAKE_PIDS):
        found = []
        try:
            for task in os.listdir(f"/proc/{pid}/task"):
                with open(f"/proc/{pid}/task/{task}/children", encoding="ascii") as handle:
                    found += [int(v) for v in handle.read().split()]
        except OSError:
            pass
        children[pid] = found
        FAKE_PIDS.update(found)
    emit({"kind": "note", "name": "p_pane_children", "value": children})
    run("p_title_default_plain", q(s) + ["display-message", "-p", "-t", f"%{created['plain']['pane']}",
                                         "#{pane_title}"]) if "plain" in created else None

    # numeric guards (conservatively guarded named, as kill_session_bound)
    srv = server_of(inventory)
    if "kill" in created:
        k = created["kill"]["sid"]
        run("p_guard_kill_wrong_pid", q(s) + guard_kill(srv[0] + 1, srv[1], k))
        run("p_guard_kill_wrong_start", q(s) + guard_kill(srv[0], srv[1] + 1, k))
        run("p_guard_kill_missing_session", q(s) + guard_kill(srv[0], srv[1], 4294967295))
    if "plain" in created:
        sel_plain = selected_from_resolve(resolved.get(f"${created['plain']['sid']}", {"stdout": ""}))
        if sel_plain:
            wrong = sel_plain[:5] + (sel_plain[5] + 1,)
            run("p_guard_attach_wrong_pane_pid", q(s) + guard_attach(wrong))
            run("p_guard_attach_true_without_pty", q(s) + guard_attach(sel_plain))
    if "kill" in created:
        run("p_guard_kill_true", q(s) + guard_kill(srv[0], srv[1], created["kill"]["sid"]))
        run("p_guard_kill_true_after", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    run("p_name_kill_missing", q(s) + ["kill-session", "-t", "=ab_ux36_nosuch"])
    run("p_name_kill_existing", q(s) + ["kill-session", "-t", "=ab_ux36_namekill"])

    # observed rename
    if "rename" in created:
        r = f"${created['rename']['sid']}"
        run("p_rename_l0", q(s) + ["list-sessions", "-F", LIST_FORMAT])
        run("p_rename_r0", q(s) + ["list-windows", "-t", r, "-F", RESOLVE_FORMAT])
        run("p_rename_do", plain(s) + ["rename-session", "-t", r, "ab_ux36_renamed"])
        run("p_rename_inventory", q(s) + INV_DIRECT)
        run("p_rename_r1", q(s) + ["list-windows", "-t", r, "-F", RESOLVE_FORMAT])
        run("p_rename_l1", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    # replacement under the same name
    if "repl" in created:
        old = f"${created['repl']['sid']}"
        run("p_repl_l0", q(s) + ["list-sessions", "-F", LIST_FORMAT])
        run("p_repl_r0", q(s) + ["list-windows", "-t", old, "-F", RESOLVE_FORMAT])
        run("p_repl_kill", q(s) + ["kill-session", "-t", "=ab_ux36_repl"])
        run("p_repl_names_before", q(s) + ["list-sessions", "-F", LIST_FORMAT])
        fresh = run("p_repl_create", create(s, "ab_ux36_repl", ["/bin/sleep", "240"]))
        run("p_repl_names_after", q(s) + ["list-sessions", "-F", LIST_FORMAT])
        run("p_repl_inventory", q(s) + INV_DIRECT)
        run("p_repl_r_old", q(s) + ["list-windows", "-t", old, "-F", RESOLVE_FORMAT])
        c = lines(fresh, "C")
        if c:
            run("p_repl_r_new", q(s) + ["list-windows", "-t", c[0][3], "-F", RESOLVE_FORMAT])
        run("p_repl_l1", q(s) + ["list-sessions", "-F", LIST_FORMAT])

    # confirmed open on the fake Codex session
    if "codex" in created:
        sel = selected_from_resolve(resolved.get(f"${created['codex']['sid']}", {"stdout": ""}))
        if sel:
            open_flow("p_open", s, sel)

    # end: server gone, socket file left behind (inert) -> absence proof inputs
    final = run("p_final_inventory", q(s) + INV_DIRECT)
    srv = server_of(final)
    run("p_end_kill_server", plain(s) + ["kill-server"])
    if srv:
        emit({"kind": "note", "name": "p_end_server_gone", "value": wait_pid_gone(srv[0])})
    emit({"kind": "note", "name": "p_end_socket_file_exists", "value": os.path.lexists(P1)})
    run("p_inert_list", q(s) + ["list-sessions", "-F", LIST_FORMAT])
    run("p_inert_socket_path", ["sh", "-c", SOCKET_PATH_SCRIPT, "agentbridge-socket", s])
    run("p_inert_inventory_direct", q(s) + INV_DIRECT)
    run("p_inert_names", q(s) + ["list-sessions", "-F", "#{session_name}"])
    run("p_inert_kill_name", q(s) + ["kill-session", "-t", "=ab_missing"])
    emit({"kind": "note", "name": "p_inert_socket_cleanup", "socket": remove_own_socket(P1)})


def cleanup():
    result = {"kind": "cleanup", "pty_exit": [], "kill_server": {}, "sockets": {}}
    for pty in PTYS:
        try:
            pty.close()
            result["pty_exit"].append(pty.proc.returncode)
        except Exception as error:  # noqa: BLE001
            result["pty_exit"].append("error:" + repr(error))
    for sock, path in zip(OWN, OWN_PATHS):
        try:
            proc = subprocess.run([TMUX, "-L", sock, "kill-server"], stdin=subprocess.DEVNULL,
                                  capture_output=True, timeout=5)
            result["kill_server"][sock] = [proc.returncode, proc.stderr.decode("utf-8", "replace")]
        except Exception as error:  # noqa: BLE001
            result["kill_server"][sock] = ["error", repr(error)]
    for pid in sorted(SERVER_PIDS):
        wait_pid_gone(pid, 2.0)
    for path in OWN_PATHS:
        try:
            result["sockets"][path] = remove_own_socket(path)
        except Exception as error:  # noqa: BLE001
            result["sockets"][path] = "error:" + repr(error)
    result["server_pids_alive"] = [pid for pid in sorted(SERVER_PIDS)
                                   if os.path.exists(f"/proc/{pid}")]
    result["pane_pids_alive"] = [pid for pid in sorted(FAKE_PIDS) if os.path.exists(f"/proc/{pid}")]
    result["sockdir_after"] = sorted(os.listdir(SOCKDIR)) if os.path.isdir(SOCKDIR) else None
    pgrep = subprocess.run(["pgrep", "-af", "abtest_ux36"], capture_output=True, timeout=5)
    result["pgrep_abtest_ux36"] = pgrep.stdout.decode("utf-8", "replace")
    emit(result)


def main():
    status = "ok"
    try:
        preflight()
        matrix()
        product()
    except Exception as error:  # noqa: BLE001
        status = "error:" + repr(error)
        emit({"kind": "error", "error": repr(error)})
    finally:
        cleanup()
        emit({"kind": "end", "status": status,
              "elapsed_s": round(time.monotonic() - START, 3)})


if __name__ == "__main__":
    main()
