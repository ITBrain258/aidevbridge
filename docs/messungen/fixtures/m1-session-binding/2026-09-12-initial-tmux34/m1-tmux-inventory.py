#!/usr/bin/env python3
"""Bounded Linux-only tmux inventory measurement; no application adapter.

Run with Python 3.11+ on the authorized test host. Creates exactly one fresh
/tmp/ab-m1-inventory-<uuid> directory and one private -S socket. No existing
tmux socket, agent, user config, title, or transcript is read. The only pane
programs are direct /bin/sleep children. JSON is exported before directory
removal, followed by a separate cleanup record. Python is a measurement-only
dependency, not a proposed remote application prerequisite.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid


HARNESS = "agentbridge-m1-tmux-inventory-v2"
TMUX = "/usr/bin/tmux"
EXPECTED_VERSION = "3.4"
EXPECTED_SHA256 = None
CAP = 256 * 1024
SECONDS = 5.0
STOP = 0
OUTPUT_BROKEN = False
REAPED_ADOPTED = []
SERVER = "#{pid}|#{start_time}"
SESSIONS = "Q|#{session_id}|#{session_windows}"
PANES = ("P|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|"
         "#{window_active}|#{pane_active}|#{pane_dead}|#{alternate_on}|"
         "#{session_attached}|#{window_activity}|#{window_bell_flag}|#{window_panes}")
# Static nested tmux syntax only. No shell command, untrusted format, or free
# metadata is interpolated into this string.
POLL = ["display-message", "-p", "B|" + SERVER, ";",
        "list-sessions", "-F", SESSIONS, ";",
        "if-shell", "-F", "#{session_id}", "list-panes -a -F '" + PANES + "'", ";",
        "display-message", "-p", "E|" + SERVER]


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def configure_binary(argv):
    global TMUX, EXPECTED_VERSION, EXPECTED_SHA256
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--parser-selftest", action="store_true")
    mode.add_argument("--session-binding", action="store_true",
                      help="run only the own-session R/C binding cases")
    mode.add_argument("--binding-selftest", action="store_true")
    parser.add_argument("--tmux-binary")
    parser.add_argument("--expected-version", choices=("3.0", "3.4"))
    parser.add_argument("--expected-sha256")
    args = parser.parse_args(argv)
    supplied = [args.tmux_binary, args.expected_version, args.expected_sha256]
    if any(value is not None for value in supplied):
        if not all(value is not None for value in supplied):
            parser.error("explicit binary requires path, expected version, and SHA-256 together")
        if not Path(args.tmux_binary).is_absolute():
            parser.error("explicit binary path must be absolute")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expected_sha256):
            parser.error("expected SHA-256 must contain exactly 64 hexadecimal characters")
        TMUX = args.tmux_binary
        EXPECTED_VERSION = args.expected_version
        EXPECTED_SHA256 = args.expected_sha256.lower()
    return args


def binary_identity():
    path = Path(TMUX)
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= 64 * 1024 * 1024,
            "binary_not_bounded_regular_file")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    require(EXPECTED_SHA256 is None or digest == EXPECTED_SHA256, "binary_sha256_mismatch")
    return {"path": TMUX, "sha256": digest, "expected_sha256": EXPECTED_SHA256,
            "expected_version": EXPECTED_VERSION}


def inventory_command():
    if EXPECTED_VERSION != "3.0":
        return POLL
    # 3.0 display-message requires a pane even for server metadata. The
    # targetless list-commands formatter can emit it, but DIRECT list-commands
    # has CMD_STARTSERVER. Keep it inside a constant if-shell -F command so
    # only an already-connected server parses/runs it. Never emit command names.
    def metadata(marker):
        template = "#{?#{==:#{command_list_name},display-message}," + marker + "|" + SERVER + ",}"
        return ["if-shell", "-F", "1", "list-commands -F '" + template + "'"]
    return metadata("B") + [";"] + POLL[4:-4] + [";"] + metadata("E")


def interrupted(signum, _frame):
    global STOP
    STOP = STOP or signum


def install_boundary():
    require(sys.platform == "linux" and sys.version_info >= (3, 11), "linux_python_3_11_required")
    require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "pidfd_required")
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(36, 1, 0, 0, 0) == 0, "subreaper_required")
    enabled = ctypes.c_int()
    require(libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) == 0 and enabled.value == 1,
            "subreaper_verification_failed")
    require(not children(), "unexpected_initial_children")
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)


def children():
    return [int(v) for v in Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()]


def process_identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "start_ticks": int(fields[19]), "state": fields[0]}
    except FileNotFoundError:
        return None


def same_live_process(identity):
    now = process_identity(identity["pid"])
    return now is not None and now["start_ticks"] == identity["start_ticks"] and now["state"] != "Z"


def owned_child_signal(pid, sig):
    """Pin a direct/adopted child, verify child ownership, then signal only it."""
    fd = None
    try:
        fd = os.pidfd_open(pid, 0)
        os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        signal.pidfd_send_signal(fd, sig)
        return True
    except (ChildProcessError, ProcessLookupError):
        return False
    finally:
        if fd is not None:
            os.close(fd)


def reap_adopted():
    # Called only when no subprocess.Popen command is active.
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False
        REAPED_ADOPTED.append(pid)


def command(argv, cwd, env, *, cleanup=False, stdout_utf8=False):
    require(cleanup or not STOP, "interrupted")
    started = time.monotonic()
    row = {"argv": argv, "started_unix_ms": time.time_ns() // 1000000,
           "exit_code": None, "termination": "not_started", "complete_eof": False,
           "stdout": "", "stderr": "", "byte_counts": [0, 0]}
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            close_fds=True, start_new_session=True)
    selector = selectors.DefaultSelector()
    streams = [proc.stdout, proc.stderr]
    buffers = [bytearray(), bytearray()]
    try:
        for index, stream in enumerate(streams):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, index)
        while True:
            if time.monotonic() - started >= SECONDS:
                row["termination"] = "deadline"
                break
            if STOP and not cleanup:
                row["termination"] = "interrupted"
                break
            for key, _event in selector.select(0.02):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                index = key.data
                row["byte_counts"][index] += len(data)
                buffers[index].extend(data[:max(0, CAP - len(buffers[index]))])
            if any(count > CAP for count in row["byte_counts"]):
                row["termination"] = "output_limit"
                break
            if not selector.get_map() and proc.poll() is not None:
                row["termination"] = "exit"
                row["complete_eof"] = True
                break
    finally:
        if proc.poll() is None:
            owned_child_signal(proc.pid, signal.SIGKILL)
        try:
            row["exit_code"] = proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            row["termination"] = "direct_child_cleanup_failed"
        selector.close()
        for stream in streams:
            stream.close()
        row["stdout"] = buffers[0].decode("ascii", errors="backslashreplace")
        if stdout_utf8:
            # Only the new own-name roundtrip uses this mode. Never interpret
            # ASCII backslashreplace output as the original Unicode name.
            try:
                row["stdout"] = buffers[0].decode("utf-8")
                row["stdout_utf8_valid"] = True
            except UnicodeDecodeError:
                row["stdout_utf8_valid"] = False
        row["stderr"] = buffers[1].decode("ascii", errors="backslashreplace")
        row["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
    return row


def snapshot(row):
    """Strict measurement classifier. Unsupported topology fails closed.

    This parser has no names, hooks, UI state, absence reducer, or production
    socket matching. It intentionally rejects linked-window duplicate panes.
    """
    if row["termination"] != "exit" or not row["complete_eof"] or row["exit_code"] is None:
        return {"class": "Incomplete"}
    if row["exit_code"] != 0 or row["stderr"]:
        return {"class": "TmuxError"}
    data = row["stdout"]
    if len(data) > CAP or not data.endswith("\n") or any(ord(c) < 32 and c != "\n" for c in data):
        return {"class": "Incomplete"}
    lines = data.splitlines()
    if len(lines) < 2 or not re.fullmatch(r"B\|[1-9][0-9]*\|[1-9][0-9]*", lines[0]):
        return {"class": "Incomplete"}
    if lines[-1] != "E" + lines[0][1:]:
        return {"class": "Incomplete"}
    sessions, panes, windows = {}, [], {}
    try:
        for line in lines[1:-1]:
            if re.fullmatch(r"Q\|\$[0-9]+\|[1-9][0-9]*", line):
                _, sid, count = line.split("|")
                require(not panes and sid not in sessions, "duplicate_or_late_session")
                sessions[sid] = int(count)
            else:
                require(re.fullmatch(r"P\|\$[0-9]+\|@[0-9]+\|%[0-9]+\|[1-9][0-9]*"
                                     r"(?:\|[01]){4}\|[0-9]+\|[0-9]+\|[01]\|[1-9][0-9]*", line),
                        "invalid_pane_row")
                values = line.split("|")[1:]
                sid, wid, pane_id = values[:3]
                require(sid in sessions and all(p[2] != pane_id for p in panes), "unknown_or_duplicate_pane")
                panes.append(values)
                windows.setdefault((sid, wid), []).append(values)
        for sid, count in sessions.items():
            owned_windows = [rows for (session, _window), rows in windows.items() if session == sid]
            require(len(owned_windows) == count, "missing_window")
            require(sum(int(rows[0][4]) for rows in owned_windows) == 1, "invalid_active_window")
            for rows in owned_windows:
                require(len(rows) == int(rows[0][11]), "missing_pane")
                require(sum(int(p[5]) for p in rows) == 1, "invalid_active_pane")
                require(all(p[4] == rows[0][4] and p[11] == rows[0][11] for p in rows),
                        "contradictory_window")
        return {"class": "Snapshot", "server": [int(v) for v in lines[0].split("|")[1:]],
                "sessions": sessions, "panes": panes}
    except RuntimeError:
        return {"class": "Incomplete"}


def noserver(row, socket):
    # Candidate diagnostics must be actually observed under the pinned version
    # before claiming that version's NoServer evidence. Unknown text fails closed.
    return (row["termination"] == "exit" and row["complete_eof"] and row["exit_code"] == 1
            and not row["stdout"] and row["stderr"] in (
                f"error connecting to {socket} (No such file or directory)\n",
                f"no server running on {socket}\n"))


def parser_checks():
    base = {"termination": "exit", "complete_eof": True, "exit_code": 0, "stderr": "",
            "stdout": "B|100|1000\nQ|$0|1\nP|$0|@0|%0|101|1|1|0|0|0|1000|0|1\nE|100|1000\n"}
    cases = [("valid_one_pane", {}, "Snapshot"),
             ("empty_live_server", {"stdout": "B|100|1000\nE|100|1000\n"}, "Snapshot"),
             ("missing_exit", {"exit_code": None}, "Incomplete"),
             ("incomplete_eof", {"complete_eof": False}, "Incomplete"),
             ("deadline", {"termination": "deadline"}, "Incomplete"),
             ("output_limit", {"termination": "output_limit"}, "Incomplete"),
             ("stderr_only", {"exit_code": 1, "stdout": "", "stderr": "Permission denied\n"}, "TmuxError"),
             ("program_missing", {"exit_code": 127, "stdout": "", "stderr": "tmux: not found\n"}, "TmuxError"),
             ("contradictory_success", {"stderr": "unexpected\n"}, "TmuxError"),
             ("missing_end", {"stdout": base["stdout"].rsplit("E", 1)[0]}, "Incomplete"),
             ("missing_pane", {"stdout": "B|100|1000\nQ|$0|1\nE|100|1000\n"}, "Incomplete"),
             ("server_changed", {"stdout": base["stdout"].replace("E|100", "E|102")}, "Incomplete"),
             ("duplicate_pane", {"stdout": base["stdout"].replace("E|", base["stdout"].splitlines()[2] + "\nE|")}, "Incomplete"),
             ("control_byte", {"stdout": base["stdout"].replace("@0", "@0\t")}, "Incomplete"),
             ("non_ascii", {"stdout": base["stdout"].replace("@0", "@\u00e4")}, "Incomplete"),
             ("free_metadata_line", {"stdout": base["stdout"].replace("E|", "free title\nE|")}, "Incomplete")]
    checks = []
    for name, overrides, expected in cases:
        actual = snapshot(dict(base, **overrides))["class"]
        checks.append({"name": name, "expected": expected, "actual": actual, "passed": actual == expected})
    no_base = dict(base, exit_code=1, stdout="", stderr="no server running on /tmp/own/socket\n")
    for name, overrides, expected in [
        ("exact_no_server", {}, True),
        ("wrong_socket", {"stderr": "no server running on /tmp/other/socket\n"}, False),
        ("translated_diagnostic", {"stderr": "Kein Server auf /tmp/own/socket\n"}, False),
        ("generic_missing_file", {"stderr": "No such file or directory\n"}, False),
        ("no_server_payload", {"stdout": base["stdout"]}, False),
        ("no_server_missing_exit", {"exit_code": None}, False)]:
        actual = noserver(dict(no_base, **overrides), "/tmp/own/socket")
        checks.append({"name": name, "expected": expected, "actual": actual, "passed": actual == expected})
    return checks


class Probe:
    def __init__(self, report):
        self.report = report
        self.root = Path("/tmp") / ("ab-m1-inventory-" + uuid.uuid4().hex)
        self.owner = None
        self.socket = self.root / "tmux.sock"
        self.env = dict(os.environ)
        for key in ("TMUX", "TMUX_PANE", "TMUX_TMPDIR"):
            self.env.pop(key, None)
        self.env["LC_ALL"] = "C"
        self.processes = []
        self.socket_identity = None
        report["root"] = str(self.root)

    def prepare(self):
        # main already owns this Probe before the first filesystem mutation.
        require(self.root.parent == Path("/tmp") and not os.path.lexists(self.root), "root_not_absent")
        previous_umask = os.umask(0o077)
        try:
            self.root.mkdir(mode=0o700)
        finally:
            os.umask(previous_umask)
        self.owner = self.root.lstat()
        report = self.report
        report["root_owner"] = {"uid": self.owner.st_uid, "device": self.owner.st_dev,
                                "inode": self.owner.st_ino, "mode": oct(stat.S_IMODE(self.owner.st_mode))}
        report["socket_absent_before"] = not os.path.lexists(self.socket)
        self.check_owner()

    def check_owner(self):
        now = self.root.lstat()
        require(stat.S_ISDIR(now.st_mode) and now.st_uid == os.getuid()
                and stat.S_IMODE(now.st_mode) == 0o700
                and (now.st_dev, now.st_ino) == (self.owner.st_dev, self.owner.st_ino), "root_ownership_changed")

    def tm(self, label, args, *, success=False, cleanup=False, stdout_utf8=False):
        self.check_owner()
        if EXPECTED_SHA256 is not None:
            binary_identity()
        row = command([TMUX, "-u", "-S", str(self.socket), "-f", "/dev/null"] + args,
                      self.root, self.env, cleanup=cleanup, stdout_utf8=stdout_utf8)
        row["name"] = label
        self.report["commands"].append(row)
        if success:
            require(row["termination"] == "exit" and row["complete_eof"]
                    and row["exit_code"] == 0 and not row["stderr"], label + "_failed")
        return row

    def poll(self, label):
        row = self.tm(label, inventory_command())
        parsed = snapshot(row)
        row["classification"] = parsed
        require(parsed["class"] == "Snapshot", label + "_not_snapshot")
        for pid in [parsed["server"][0]] + [int(p[3]) for p in parsed["panes"]]:
            identity = process_identity(pid)
            require(identity is not None and identity["state"] != "Z", "measured_process_not_live")
            if not any(p["pid"] == pid and p["start_ticks"] == identity["start_ticks"] for p in self.processes):
                self.processes.append(identity)
        return parsed

    def capture_socket(self):
        self.check_owner()
        now = self.socket.lstat()
        require(stat.S_ISSOCK(now.st_mode) and now.st_uid == os.getuid(), "socket_owner_or_type")
        self.socket_identity = (now.st_dev, now.st_ino)
        self.report["socket_generations"].append({"device": now.st_dev, "inode": now.st_ino, "uid": now.st_uid})

    def stop_server(self, label):
        self.check_owner()
        now = self.socket.lstat()
        require(stat.S_ISSOCK(now.st_mode) and now.st_uid == os.getuid()
                and (now.st_dev, now.st_ino) == self.socket_identity, "socket_ownership_changed")
        self.tm(label, ["kill-server"], success=True, cleanup=True)
        deadline = time.monotonic() + 3
        while any(same_live_process(p) for p in self.processes) and time.monotonic() < deadline:
            reap_adopted()
            time.sleep(0.02)
        require(not any(same_live_process(p) for p in self.processes), "server_or_pane_still_live")
        reap_adopted()

    def remove_socket(self):
        self.check_owner()
        if os.path.lexists(self.socket):
            now = self.socket.lstat()
            require(stat.S_ISSOCK(now.st_mode) and now.st_uid == os.getuid()
                    and (now.st_dev, now.st_ino) == self.socket_identity, "socket_ownership_changed")
            self.socket.unlink()


def measure(probe):
    report = probe.report
    report["binary"] = binary_identity()
    version = command([TMUX, "-V"], probe.root, probe.env)
    report["version_command"] = version
    require(version["exit_code"] == 0 and version["stdout"] == "tmux " + EXPECTED_VERSION + "\n"
            and version["complete_eof"] and not version["stderr"], "expected_tmux_version_required")
    report["tmux_3_0_executed"] = EXPECTED_VERSION == "3.0"
    report["inventory_argv"] = inventory_command()
    for i in range(3):
        previous_reaped = len(REAPED_ADOPTED)
        row = probe.tm(f"absent_poll_{i + 1}", inventory_command())
        require(noserver(row, probe.socket), "absent_diagnostic_not_allowlisted")
        require(not os.path.lexists(probe.socket) and reap_adopted()
                and len(REAPED_ADOPTED) == previous_reaped, "absent_poll_started_resource")
        row["socket_absent_after"] = True
        row["echild_after"] = True
        row["adopted_children_reaped"] = len(REAPED_ADOPTED) - previous_reaped
    probe.tm("start_empty_server", ["start-server", ";", "set-option", "-s", "exit-empty", "off"], success=True)
    probe.capture_socket()
    probe.tm("confirm_exit_empty", ["show-options", "-sv", "exit-empty"], success=True)
    plain = probe.tm("plain_empty_panes", ["list-panes", "-a", "-F", PANES])
    require(plain["exit_code"] == 1 and not plain["stdout"]
            and plain["stderr"] == "no current target\n", "plain_empty_changed")
    for i in range(3):
        value = probe.poll(f"guarded_empty_{i + 1}")
        require(not value["sessions"] and not value["panes"], "empty_inventory_not_empty")
    probe.tm("create_named", ["new-session", "-d", "-s", "same_name", "/bin/sleep", "300"], success=True)
    first = probe.poll("first_named")
    require(len(first["sessions"]) == len(first["panes"]) == 1, "not_single_pane")
    for i in range(3):
        probe.tm(f"replace_kill_{i + 1}", ["kill-session", "-t", "=same_name"], success=True)
        probe.tm(f"replace_create_{i + 1}", ["new-session", "-d", "-s", "same_name", "/bin/sleep", "300"], success=True)
        later = probe.poll(f"same_name_replaced_{i + 1}")
        require(later["server"] == first["server"] and len(later["panes"]) == 1
                and all(later["panes"][0][n] != first["panes"][0][n] for n in (0, 1, 2, 3)),
                "replacement_identity_not_changed")
        first = later
    for i in range(3):
        probe.tm(f"respawn_{i + 1}", ["respawn-pane", "-k", "-t", first["panes"][0][2], "/bin/sleep", "300"], success=True)
        later = probe.poll(f"respawn_snapshot_{i + 1}")
        require(later["server"] == first["server"] and later["panes"][0][:3] == first["panes"][0][:3]
                and later["panes"][0][3] != first["panes"][0][3], "respawn_identity_not_changed")
        first = later
    # Synthetics only. Read the accepted title to avoid claiming tmux accepted
    # control bytes merely because select-pane returned success.
    for name, title in [("separator", "alpha|Q|$999|1"), ("controls", "alpha\nbeta\rgamma\tdelta")]:
        probe.tm("set_title_" + name, ["select-pane", "-t", first["panes"][0][2], "-T", title], success=True)
        read = probe.tm("read_title_" + name, ["display-message", "-p", "-t", first["panes"][0][2], "#{pane_title}"], success=True)
        if name == "separator":
            require(read["stdout"] == title + "\n", "separator_title_not_stored")
        else:
            read["control_title_accepted_exactly"] = read["stdout"] == title + "\n"
        later = probe.poll("metadata_excluded_" + name)
        require(later == first, "title_changed_inventory")
    # An option retains synthetic LF/TAB even where pane title rejects them.
    probe.tm("set_control_option", ["set-option", "-t", first["panes"][0][0], "@ab_inventory_probe", "Q|$999|1\nP|fake\tend"], success=True)
    option = probe.tm("read_control_option", ["display-message", "-p", "-t", first["panes"][0][2], "#{@ab_inventory_probe}"], success=True)
    require(option["stdout"] == "Q|$999|1\nP|fake\tend\n", "control_option_not_stored")
    require(probe.poll("option_excluded") == first, "option_changed_inventory")
    probe.tm("split_second_pane", ["split-window", "-d", "-t", first["panes"][0][2], "/bin/sleep", "300"], success=True)
    split = probe.poll("two_panes")
    require(len(split["panes"]) == 2, "second_pane_missing")
    mixed = probe.tm("partial_failure", ["display-message", "-p", "B|" + SERVER, ";",
                     "list-panes", "-t", "%999999999", "-F", PANES, ";",
                     "display-message", "-p", "E|" + SERVER])
    mixed["classification"] = snapshot(mixed)
    require(mixed["exit_code"] != 0 and mixed["stdout"] and mixed["stderr"]
            and mixed["classification"]["class"] == "TmuxError", "partial_failure_not_detected")
    for i in range(3):
        old = probe.poll(f"before_restart_{i + 1}")
        probe.stop_server(f"restart_stop_{i + 1}")
        previous_reaped = len(REAPED_ADOPTED)
        row = probe.tm(f"inert_poll_{i + 1}", inventory_command())
        require(noserver(row, probe.socket) and reap_adopted()
                and len(REAPED_ADOPTED) == previous_reaped, "inert_poll_started_server")
        row["echild_after"] = True
        row["adopted_children_reaped"] = len(REAPED_ADOPTED) - previous_reaped
        probe.remove_socket()
        wait_started = time.monotonic()
        while int(time.time()) <= old["server"][1] and time.monotonic() - wait_started < 1.2:
            require(not STOP, "interrupted")
            time.sleep(0.02)
        require(int(time.time()) > old["server"][1], "server_restart_clock_did_not_advance")
        row["restart_wait_ms"] = round((time.monotonic() - wait_started) * 1000, 3)
        probe.tm(f"restart_create_{i + 1}", ["new-session", "-d", "-s", "same_name", "/bin/sleep", "300"], success=True)
        probe.capture_socket()
        later = probe.poll(f"after_restart_{i + 1}")
        require(all(new != previous for new, previous in zip(later["server"], old["server"])),
                "restart_pid_or_start_time_not_changed")
    report["observed_processes"] = probe.processes
    report["checks_passed"] = True


RESOLVE_FORMAT = ("R|#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|"
                  "#{pane_pid}|#{window_active}|#{session_windows}")
CREATE_FORMAT = "C|#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}"


def resolve_command(name):
    require(isinstance(name, str) and 0 < len(name.encode("utf-8")) <= 4096
            and not any(ord(c) < 32 or ord(c) == 127 for c in name), "invalid_own_name")
    return ["list-windows", "-t", "=" + name, "-F", RESOLVE_FORMAT]


def binding_record(row, marker):
    """Pure bounded R/C classifier; a failed record contains no partial binding."""
    if (row["termination"] != "exit" or not row["complete_eof"]
            or row["exit_code"] is None or len(row["stdout"]) + len(row["stderr"]) > CAP):
        return {"class": "Incomplete"}
    if row["exit_code"] != 0 or row["stderr"]:
        return {"class": "TmuxError"}
    text = row["stdout"]
    if not text.endswith("\n") or any(not (32 <= ord(c) <= 126 or c == "\n") for c in text):
        return {"class": "Incomplete"}

    def number(value, maximum, positive=False):
        require(re.fullmatch(r"0|[1-9][0-9]{0,19}", value), "noncanonical_integer")
        result = int(value)
        require(int(positive) <= result <= maximum, "integer_out_of_range")
        return result

    def ident(value, prefix):
        require(value.startswith(prefix), "wrong_id_prefix")
        number(value[1:], 2**32 - 1)
        return value

    try:
        require(marker in {"R", "C"}, "unknown_marker")
        parsed = []
        for line in text.splitlines():
            fields = line.split("|")
            require(len(fields) == (9 if marker == "R" else 7) and fields[0] == marker,
                    "invalid_binding_frame")
            value = {"server": [number(fields[1], 2**32 - 1, True),
                                number(fields[2], 2**64 - 1, True)],
                     "session_id": ident(fields[3], "$"), "window_id": ident(fields[4], "@"),
                     "pane_id": ident(fields[5], "%"),
                     "pane_pid": number(fields[6], 2**32 - 1, True)}
            if marker == "R":
                value.update(window_active=number(fields[7], 1),
                             window_count=number(fields[8], 2**32 - 1, True))
            parsed.append(value)
        require(parsed, "empty_binding")
        if marker == "C":
            require(len(parsed) == 1, "multiple_creation_rows")
            return {"class": "Created", **parsed[0]}
        first = parsed[0]
        require(len(parsed) == first["window_count"]
                and sum(p["window_active"] for p in parsed) == 1
                and len({p["window_id"] for p in parsed}) == len(parsed)
                and len({p["pane_id"] for p in parsed}) == len(parsed), "invalid_window_selection")
        require(all(p["server"] == first["server"] and p["session_id"] == first["session_id"]
                    and p["window_count"] == first["window_count"] for p in parsed), "mixed_binding")
        return {"class": "Resolved", "server": first["server"], "session_id": first["session_id"],
                "windows": sorted(parsed, key=lambda p: int(p["window_id"][1:]))}
    except (RuntimeError, ValueError):
        return {"class": "Incomplete"}


def correlate_binding(before, inventory, after, created=None):
    """R/Inventory/R equality, including the actually active pane per window."""
    if before.get("class") != "Resolved" or before != after or inventory.get("class") != "Snapshot":
        return {"class": "Unverified"}
    sid = before["session_id"]
    if inventory["server"] != before["server"] or inventory["sessions"].get(sid) != len(before["windows"]):
        return {"class": "Unverified"}
    panes = [p for p in inventory["panes"] if p[0] == sid]
    for window in before["windows"]:
        active = [p for p in panes if p[1] == window["window_id"] and p[5] == "1"]
        if (len(active) != 1 or active[0][2] != window["pane_id"]
                or int(active[0][3]) != window["pane_pid"]
                or int(active[0][4]) != window["window_active"]):
            return {"class": "Unverified"}
    if created is not None and (created.get("class") != "Created"
            or created["server"] != before["server"] or created["session_id"] != sid
            or not any(p[1:4] == [created["window_id"], created["pane_id"], str(created["pane_pid"])]
                       for p in panes)):
        return {"class": "Unverified"}
    selected = next(w for w in before["windows"] if w["window_active"] == 1)
    return {"class": "Bound", "server": before["server"], "session_id": sid,
            "window_id": selected["window_id"], "pane_id": selected["pane_id"],
            "pane_pid": selected["pane_pid"], "creation_matched": created is not None}


def binding_checks():
    def row(text, **changes):
        return dict({"termination": "exit", "complete_eof": True, "exit_code": 0,
                     "stdout": text, "stderr": ""}, **changes)
    r = "R|100|1000|$0|@0|%0|101|1|1\n"
    c = "C|100|1000|$0|@0|%0|101\n"
    checks = []
    cases = [("resolved", row(r), "R", "Resolved"), ("created", row(c), "C", "Created"),
             ("missing_exit", row(r, exit_code=None), "R", "Incomplete"),
             ("missing_eof", row(r, complete_eof=False), "R", "Incomplete"),
             ("deadline", row(r, termination="deadline"), "R", "Incomplete"),
             ("error_is_not_absence", row("", exit_code=1, stderr="no current target\n"), "R", "TmuxError"),
             ("stderr_success", row(r, stderr="warning\n"), "R", "TmuxError"),
             ("missing_lf", row(r[:-1]), "R", "Incomplete"),
             ("injected_row", row(r + "free\n"), "R", "Incomplete"),
             ("tab", row(r.replace("@0", "@0\t")), "R", "Incomplete"),
             ("non_ascii", row(r.replace("@0", "@ä")), "R", "Incomplete"),
             ("leading_zero_id", row(r.replace("$0", "$00")), "R", "Incomplete"),
             ("pid_overflow", row(r.replace("|101|", "|4294967296|")), "R", "Incomplete"),
             ("time_overflow", row(r.replace("|1000|", "|18446744073709551616|")), "R", "Incomplete"),
             ("duplicate_window", row(r.replace("|1|1\n", "|1|2\n") * 2), "R", "Incomplete"),
             ("missing_window", row(r.replace("|1|1\n", "|1|2\n")), "R", "Incomplete"),
             ("no_active_window", row(r.replace("|1|1\n", "|0|1\n")), "R", "Incomplete"),
             ("multiple_created", row(c * 2), "C", "Incomplete"),
             ("output_limit", row("R" * (CAP + 1)), "R", "Incomplete")]
    for name, value, marker, expected in cases:
        actual = binding_record(value, marker)["class"]
        checks.append({"name": name, "expected": expected, "actual": actual, "passed": actual == expected})
    two = r.replace("|1|1\n", "|1|2\n") + "R|100|1000|$0|@1|%1|102|0|2\n"
    for name, text, expected in [
        ("two_windows", two, "Resolved"),
        ("mixed_server", two.replace("R|100|1000|$0|@1", "R|103|1000|$0|@1"), "Incomplete"),
        ("two_active_windows", two.replace("|102|0|2", "|102|1|2"), "Incomplete")]:
        actual = binding_record(row(text), "R")["class"]
        checks.append({"name": name, "expected": expected, "actual": actual, "passed": actual == expected})
    before = binding_record(row(r), "R")
    created = binding_record(row(c), "C")
    inv = snapshot(row("B|100|1000\nQ|$0|1\nP|$0|@0|%0|101|1|1|0|0|0|1|0|1\nE|100|1000\n"))
    for name, start, middle, end, creation, expected in [
        ("bound_created", before, inv, before, created, "Bound"),
        ("without_creation", before, inv, before, None, "Bound"),
        ("changed_after", before, inv, {**before, "server": [102, 1001]}, None, "Unverified"),
        ("incomplete_inventory", before, {"class": "Incomplete"}, before, None, "Unverified"),
        ("missing_session", before, {**inv, "sessions": {}}, before, None, "Unverified"),
        ("stale_creation", before, inv, before, {**created, "session_id": "$1"}, "Unverified"),
        ("wrong_pane", before, {**inv, "panes": [["$0", "@0", "%2", "101", "1", "1"]]}, before, None, "Unverified"),
        ("missing_name_after_rename", before, inv, {"class": "TmuxError"}, None, "Unverified")]:
        actual = correlate_binding(start, middle, end, creation)["class"]
        checks.append({"name": name, "expected": expected, "actual": actual, "passed": actual == expected})
    return checks


def measure_binding(probe):
    """Only new R/C observations, with real own creations, not a read-only run."""
    report = probe.report
    report["binary"] = binary_identity()
    version = command([TMUX, "-V"], probe.root, probe.env)
    report["version_command"] = version
    require(version["exit_code"] == 0 and version["stdout"] == "tmux " + EXPECTED_VERSION + "\n"
            and version["complete_eof"] and not version["stderr"], "expected_tmux_version_required")
    report["tmux_3_0_executed"] = EXPECTED_VERSION == "3.0"
    report["bindings"] = []

    def resolve(label, name):
        result = probe.tm(label, resolve_command(name))
        parsed = binding_record(result, "R")
        result["binding_classification"] = parsed
        return parsed

    def names(label):
        result = probe.tm(label, ["list-sessions", "-F", "#{session_name}"],
                          success=True, stdout_utf8=True)
        text = result["stdout"]
        require(result.get("stdout_utf8_valid") is True and (not text or text.endswith("\n"))
                and not any(ord(c) < 32 and c != "\n" or ord(c) == 127 for c in text), "invalid_listed_names")
        values = text.splitlines()
        require(all(values) and len(set(values)) == len(values), "ambiguous_listed_names")
        return values

    def bound(label, name, created=None):
        before = resolve(label + "_r_before", name)
        inventory = probe.poll(label + "_inventory")
        after = resolve(label + "_r_after", name)
        result = correlate_binding(before, inventory, after, created)
        report["bindings"].append({"name": label, "listed_name": name, "result": result})
        require(result["class"] == "Bound", label + "_not_bound")
        return result

    def create(label, requested):
        previous = names(label + "_names_before")
        result = probe.tm(label + "_create", ["new-session", "-d", "-P", "-F", CREATE_FORMAT,
                          "-s", requested, "/bin/sleep", "300", ";", "set", "-g", "exit-empty", "on"])
        created = binding_record(result, "C")
        result["binding_classification"] = created
        require(created["class"] == "Created", label + "_creation_not_bound")
        listed = names(label + "_names_after")
        added = set(listed) - set(previous)
        require(set(previous).issubset(listed) and len(added) == 1, "creation_list_not_one_new_name")
        name = next(iter(added))
        report.setdefault("created_sessions", []).append({"name": label, "requested_name": requested,
                         "listed_name": name, "request_equals_listed": requested == name, "created": created})
        bound(label, name, created)
        return {"listed_name": name, "created": created}

    previous_reaped = len(REAPED_ADOPTED)
    absent = probe.tm("binding_absent_r", resolve_command("dev"))
    require(noserver(absent, probe.socket) and not os.path.lexists(probe.socket)
            and reap_adopted() and len(REAPED_ADOPTED) == previous_reaped, "binding_absent_started_resource")
    absent.update(socket_absent_after=True, echild_after=True, adopted_children_reaped=0)
    probe.tm("binding_start_empty", ["start-server", ";", "set-option", "-s", "exit-empty", "off"], success=True)
    probe.capture_socket()
    empty = probe.poll("binding_empty_inventory")
    require(not empty["sessions"], "expected_empty_server")
    missing = resolve("binding_empty_r", "dev")
    require(missing["class"] == "TmuxError", "empty_target_unexpected_success")
    require(probe.poll("binding_empty_after_r") == empty, "empty_query_changed_server")
    anchor = create("prefix_anchor", "dev2")
    missing = resolve("binding_missing_prefix", "dev")
    require(missing["class"] == "TmuxError", "missing_exact_name_matched_prefix")
    bound("prefix_unchanged", anchor["listed_name"], anchor["created"])
    current = create("normal", "dev")
    for label, requested in [("unicode", "prüfung"), ("spaces", " edge "),
                             ("punctuation", "cash$back\\slash|semi;quote'#[x]")]:
        create(label, requested)

    duplicate = probe.tm("creation_duplicate", ["new-session", "-d", "-P", "-F", CREATE_FORMAT,
                         "-s", "dev", "/bin/sleep", "300", ";", "set", "-g", "exit-empty", "on"])
    require(duplicate["termination"] == "exit" and duplicate["complete_eof"]
            and duplicate["exit_code"] == 1 and not duplicate["stdout"]
            and "duplicate session" in duplicate["stderr"], "duplicate_not_rejected")
    bound("duplicate_preserves_original", current["listed_name"], current["created"])

    sid = current["created"]["session_id"]
    probe.tm("binding_new_window", ["new-window", "-d", "-t", sid + ":", "/bin/sleep", "300"], success=True)
    probe.tm("binding_split", ["split-window", "-d", "-t", current["created"]["pane_id"],
                              "/bin/sleep", "300"], success=True)
    multi = probe.poll("binding_multi_inventory")
    own_panes = [p for p in multi["panes"] if p[0] == sid]
    require(len(own_panes) == 3 and multi["sessions"][sid] == 2, "expected_two_windows_three_panes")
    for trial, pane in enumerate(own_panes, 1):
        probe.tm(f"select_window_{trial}", ["select-window", "-t", pane[1]], success=True)
        probe.tm(f"select_pane_{trial}", ["select-pane", "-t", pane[2]], success=True)
        result = bound(f"selection_{trial}", current["listed_name"])
        require(result["window_id"] == pane[1] and result["pane_id"] == pane[2], "selection_binding_wrong_pane")

    for trial in range(1, 4):
        before = resolve(f"replacement_{trial}_r_before", current["listed_name"])
        previous_creation = current["created"]
        probe.tm(f"replacement_{trial}_kill", ["kill-session", "-t", previous_creation["session_id"]], success=True)
        current = create(f"replacement_{trial}", "dev")
        inventory = probe.poll(f"replacement_{trial}_inventory")
        after = resolve(f"replacement_{trial}_r_after", current["listed_name"])
        changed = correlate_binding(before, inventory, after)
        old_creation = correlate_binding(after, inventory, after, previous_creation)
        require(changed["class"] == old_creation["class"] == "Unverified", "replacement_inherited_binding")
        report["bindings"].append({"name": f"replacement_{trial}_reject_old", "result": changed,
                                   "old_creation_result": old_creation})
        before = resolve(f"rename_{trial}_r_before", current["listed_name"])
        renamed = f"renamed_{trial}"
        probe.tm(f"rename_{trial}", ["rename-session", "-t", current["created"]["session_id"], renamed], success=True)
        inventory = probe.poll(f"rename_{trial}_inventory")
        after = resolve(f"rename_{trial}_old_name", current["listed_name"])
        changed = correlate_binding(before, inventory, after)
        require(after["class"] == "TmuxError" and changed["class"] == "Unverified", "renamed_name_not_rejected")
        listed = names(f"rename_{trial}_names")
        require(renamed in listed and current["listed_name"] not in listed, "rename_not_listed")
        bound(f"rename_{trial}_new_name", renamed, current["created"])
        report["bindings"].append({"name": f"rename_{trial}_reject_old_name", "result": changed})
        probe.tm(f"rename_{trial}_restore", ["rename-session", "-t", current["created"]["session_id"], "dev"], success=True)
    bound("binding_final", "dev", current["created"])
    report["observed_processes"] = probe.processes
    report["checks_passed"] = True


def cleanup(probe):
    result = {"kind": "cleanup", "root": str(probe.root), "signals": [], "echild": False,
              "socket_absent": False, "directory_removed": False, "exported_before_remove": False}
    if probe.owner is None:
        result["directory_not_created"] = not os.path.lexists(probe.root)
        result["retained_without_owner_identity"] = not result["directory_not_created"]
        result["echild"] = reap_adopted()
        report_exported = emit(probe.report)
        cleanup_exported = emit(result)
        return result["directory_not_created"] and result["echild"] and report_exported and cleanup_exported
    # The ordinary path gracefully stops only the pinned own socket. If a
    # command failed before socket capture, the child boundary still owns all
    # descendants; never infer process ownership from PID or tmux name alone.
    try:
        probe.check_owner()
        if probe.socket_identity is not None and os.path.lexists(probe.socket):
            current = probe.tm("cleanup_server_query", ["display-message", "-p", "#{pid}"], cleanup=True)
            if current["exit_code"] == 0:
                probe.stop_server("cleanup_kill_server")
    except (OSError, RuntimeError):
        result["graceful_cleanup_failed"] = True
    deadline = time.monotonic() + 5
    while not reap_adopted() and time.monotonic() < deadline:
        for pid in children():
            if owned_child_signal(pid, signal.SIGKILL):
                result["signals"].append(pid)
        time.sleep(0.02)
    result["echild"] = reap_adopted()
    result["all_measured_processes_ended"] = not any(same_live_process(p) for p in probe.processes)
    if result["echild"] and result["all_measured_processes_ended"]:
        try:
            probe.check_owner()
            row = probe.tm("cleanup_no_server", inventory_command(), cleanup=True)
            require(noserver(row, probe.socket) and reap_adopted(), "cleanup_absence_not_verified")
            # Startup may have timed out before first capture. Once every own
            # descendant is reaped and exact NoServer is proven, the still
            # private directory permits capturing and unlinking its own socket.
            if probe.socket_identity is None and os.path.lexists(probe.socket):
                probe.capture_socket()
            probe.remove_socket()
            result["socket_absent"] = not os.path.lexists(probe.socket)
            require(not list(probe.root.iterdir()), "unexpected_owned_directory_entry")
            # An unavailable SSH output channel must not retain an otherwise
            # verified empty resource directory. Preserve the failed export
            # in the return status; report emission never gates safe cleanup.
            result["exported_before_remove"] = emit(probe.report)
            probe.check_owner()
            probe.root.rmdir()
            result["directory_removed"] = not os.path.lexists(probe.root)
        except (OSError, RuntimeError):
            result["directory_cleanup_failed"] = True
    if not result["exported_before_remove"]:
        emit(probe.report)
    cleanup_exported = emit(result)
    return (result["directory_removed"] and result["echild"] and result["all_measured_processes_ended"]
            and result["exported_before_remove"] and cleanup_exported)


def emit(value):
    global OUTPUT_BROKEN
    if OUTPUT_BROKEN:
        return False
    try:
        print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)
        return True
    except OSError:
        OUTPUT_BROKEN = True
        return False


def main():
    args = configure_binary(sys.argv[1:])
    if args.binding_selftest:
        checks = binding_checks()
        exported = emit({"kind": "binding_selftest", "harness": HARNESS, "checks": checks})
        return 0 if all(c["passed"] for c in checks) and exported else 1
    if args.parser_selftest:
        checks = parser_checks()
        exported = emit({"kind": "parser_selftest", "harness": HARNESS, "checks": checks})
        return 0 if all(c["passed"] for c in checks) and exported else 1
    report = {"kind": "session_binding_measurement" if args.session_binding else "inventory_measurement",
              "harness": HARNESS, "commands": [],
              "socket_generations": [], "checks_passed": False,
              "parser_checks": binding_checks() if args.session_binding else parser_checks(),
              "tmux_3_0_executed": False, "status_adapter_validated": False}
    probe = None
    clean = False
    try:
        install_boundary()
        # Pin mismatch must fail before even creating the measurement directory.
        report["binary"] = binary_identity()
        require(all(c["passed"] for c in report["parser_checks"]), "parser_selftest_failed")
        probe = Probe(report)
        probe.prepare()
        require(emit({"kind": "probe_start", "harness": HARNESS, "root": str(probe.root),
                      "socket_absent_before": report["socket_absent_before"]}), "initial_export_failed")
        (measure_binding if args.session_binding else measure)(probe)
    except (OSError, RuntimeError) as error:
        report["failure"] = str(error)
        report["checks_passed"] = False
    finally:
        if probe is not None:
            clean = cleanup(probe)
        else:
            emit(report)
    return 0 if report["checks_passed"] and clean and not STOP else 1


if __name__ == "__main__":
    sys.exit(main())
