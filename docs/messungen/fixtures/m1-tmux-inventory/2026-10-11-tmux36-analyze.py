"""Replay the measured tmux 3.6 outputs through a faithful Python port of the
agentbridge parsers (HEAD 101b454) and compare them with the 3.4 fixtures.

Usage: python -I analyze_tmux36.py <raw-measure.jsonl> <repo root> <out dir>
Writes analysis-results.json, analysis-results.txt and fixture-proposal/*.
"""
import base64
import hashlib
import json
import os
import re
import sys

MAX = 256 * 1024
P5 = "/tmp/tmux-1000/abtest_ux36_5"
P1 = "/tmp/tmux-1000/abtest_ux36_1"
S1 = "abtest_ux36_1"


class Fail(Exception):
    pass


# ---------------------------------------------------------------- inventory.rs
def number(v):
    if v == "" or (len(v) > 1 and v.startswith("0")) or not all("0" <= c <= "9" for c in v):
        raise Fail("InvalidNumber")
    n = int(v)
    if n > 2**64 - 1:
        raise Fail("InvalidNumber")
    return n


def number32(v, positive):
    n = number(v)
    if n > 2**32 - 1 or (positive and n == 0):
        raise Fail("InvalidNumber")
    return n


def ident(v, prefix):
    if not v.startswith(prefix):
        raise Fail("InvalidNumber")
    return number32(v[1:], False)


def flag(v):
    if v == "0":
        return False
    if v == "1":
        return True
    raise Fail("InvalidNumber")


def inv_server(line, marker):
    f = line.split("|")
    if len(f) != 3 or f[0] != marker:
        raise Fail("InvalidFrame")
    pid = number32(f[1], True)
    start = number(f[2])
    if start == 0:
        raise Fail("InvalidNumber")
    return (pid, start)


def parse_numeric(data):
    if not data.endswith("\n") or not all(c == "\n" or " " <= c <= "~" for c in data):
        raise Fail("InvalidFrame")
    lines = data[:-1].split("\n") if data else []
    if not lines:
        raise Fail("InvalidFrame")
    begin = inv_server(lines[0], "B")
    sessions, panes, pane_ids, owners = {}, [], set(), {}
    ended = False
    rest = lines[1:]
    for i, line in enumerate(rest):
        if i == len(rest) - 1:
            if inv_server(line, "E") != begin:
                raise Fail("InvalidFrame")
            ended = True
            break
        f = line.split("|")
        if len(f) == 3 and f[0] == "Q" and not panes:
            sid = ident(f[1], "$")
            if sid in sessions:
                raise Fail("DuplicateIdentity")
            sessions[sid] = number32(f[2], True)
        elif len(f) == 13 and f[0] == "P":
            sid, wid, pid = ident(f[1], "$"), ident(f[2], "@"), ident(f[3], "%")
            if sid not in sessions:
                raise Fail("InconsistentInventory")
            if wid in owners and owners[wid] != sid:
                raise Fail("UnsupportedLinkedWindows")
            owners[wid] = sid
            if pid in pane_ids:
                raise Fail("DuplicateIdentity")
            pane_ids.add(pid)
            panes.append({"sid": sid, "wid": wid, "pane": pid, "pane_pid": number32(f[4], True),
                          "wa": flag(f[5]), "pa": flag(f[6]), "dead": flag(f[7]),
                          "alt": flag(f[8]), "attached": number32(f[9], False),
                          "activity": number(f[10]), "bell": flag(f[11]),
                          "wpanes": number32(f[12], True)})
        else:
            raise Fail("InvalidFrame")
    if not ended:
        raise Fail("InvalidFrame")
    validate_inventory(sessions, panes)
    return {"server": begin, "sessions": dict(sorted(sessions.items())), "panes": panes}


def validate_inventory(sessions, panes):
    windows = {}
    for p in panes:
        windows.setdefault(p["sid"], {}).setdefault(p["wid"], []).append(p)
    for sid, count in sessions.items():
        owned = windows.get(sid)
        if owned is None:
            raise Fail("InconsistentInventory")
        if len(owned) != count or sum(1 for rows in owned.values() if rows[0]["wa"]) != 1:
            raise Fail("InconsistentInventory")
        attached = None
        for rows in owned.values():
            first = rows[0]
            if len(rows) != first["wpanes"] or sum(1 for p in rows if p["pa"]) != 1:
                raise Fail("InconsistentInventory")
            for p in rows:
                if (p["wa"] != first["wa"] or p["wpanes"] != first["wpanes"]
                        or p["activity"] != first["activity"] or p["bell"] != first["bell"]
                        or (attached is not None and attached != p["attached"])):
                    raise Fail("InconsistentInventory")
                attached = p["attached"]


def classify(row, absolute_path=None):
    out, err, code = row["stdout"], row["stderr"], row["exit_code"]
    if len(out.encode()) + len(err.encode()) > MAX:
        return ("Incomplete", "OutputLimit")
    if code != 0 or err:
        if absolute_path and code == 1 and out == "" and err in (
                f"no server running on {absolute_path}\n",
                f"error connecting to {absolute_path} (No such file or directory)\n"):
            return ("NoServer", None)
        return ("TmuxError", code)
    try:
        return ("Snapshot", parse_numeric(out))
    except Fail as error:
        return ("Incomplete", str(error))


def from_response(row, accepted=("tmux 3.0\n", "tmux 3.3a\n", "tmux 3.4\n")):
    if row["exit_code"] != 0 or row["stderr"]:
        return None
    return row["stdout"] if row["stdout"] in accepted else None


# ----------------------------------------------------------- session_binding.rs
def payload(row, unicode):
    out = row["stdout"]
    if len(out.encode()) + len(row["stderr"].encode()) > MAX:
        raise Fail("OutputLimit")
    if row["exit_code"] != 0 or row["stderr"]:
        raise Fail("TmuxError:%s" % row["exit_code"])
    if not row.get("stdout_utf8_valid", True):
        raise Fail("InvalidUtf8")
    if out and not out.endswith("\n"):
        raise Fail("InvalidFrame")
    for b in out.encode():
        if b != 10 and (b < 32 or b == 127 or (not unicode and b >= 128)):
            raise Fail("InvalidFrame")
    return out


def sb_server(pid, start):
    p = number32(pid, True)
    s = number(start)
    if s == 0:
        raise Fail("InvalidNumber")
    return (p, s)


def parse_list(row):
    text = payload(row, True)
    server, sessions = None, {}
    for line in (text[:-1].split("\n") if text else []):
        f = line.split("|", 4)
        if len(f) != 5 or f[0] != "L":
            raise Fail("InvalidFrame")
        cur = sb_server(f[1], f[2])
        if server is not None and server != cur:
            raise Fail("InconsistentInventory")
        server = cur
        if f[4] == "" or len(f[4].encode()) > 4096:
            raise Fail("InvalidFrame")
        sid = ident(f[3], "$")
        if sid in sessions:
            raise Fail("DuplicateIdentity")
        sessions[sid] = f[4]
    return {"server": server, "sessions": dict(sorted(sessions.items()))}


def pane_identity(f):
    return (sb_server(f[1], f[2]), ident(f[3], "$"), ident(f[4], "@"), ident(f[5], "%"),
            number32(f[6], True))


def parse_created(row):
    text = payload(row, False)
    lines = text[:-1].split("\n") if text else [""]
    f = lines[0].split("|")
    if len(f) != 7 or f[0] != "C" or len(lines) > 1:
        raise Fail("InvalidFrame")
    return pane_identity(f)


def parse_resolved(row):
    text = payload(row, False)
    result, count, pane_ids = None, None, set()
    for line in (text[:-1].split("\n") if text else []):
        f = line.split("|")
        if len(f) != 9 or f[0] != "R":
            raise Fail("InvalidFrame")
        identity = pane_identity(f)
        active = flag(f[7])
        c = number32(f[8], True)
        if result is None:
            count = c
            result = {"server": identity[0], "sid": identity[1], "windows": {}}
        if result["server"] != identity[0] or result["sid"] != identity[1] or count != c:
            raise Fail("InconsistentInventory")
        if identity[3] in pane_ids or identity[2] in result["windows"]:
            raise Fail("DuplicateIdentity")
        pane_ids.add(identity[3])
        result["windows"][identity[2]] = {"pane": identity[3], "pane_pid": identity[4],
                                          "active": active}
    if result is None:
        raise Fail("InvalidFrame")
    if len(result["windows"]) != count or sum(w["active"] for w in result["windows"].values()) != 1:
        raise Fail("InconsistentInventory")
    return result


def selected(resolved):
    for wid, w in resolved["windows"].items():
        if w["active"]:
            return (resolved["server"], resolved["sid"], wid, w["pane"], w["pane_pid"])
    raise Fail("no active")


def confirm_listed_inventory(before, inv, after):
    if before != after:
        return "ListingChanged"
    ids = set(inv["sessions"])
    if set(before["sessions"]) != ids or (before["server"] is not None
                                          and before["server"] != inv["server"]):
        return "ListingInventoryMismatch"
    return None


def confirm_created_listing(before, created, after):
    server, sid = created[0], created[1]
    if (before["server"] is not None and before["server"] != server) or after["server"] != server \
            or sid in before["sessions"] or sid not in after["sessions"] \
            or len(after["sessions"]) != len(before["sessions"]) + 1 \
            or any(after["sessions"].get(k) != v for k, v in before["sessions"].items()):
        return "CreationMismatch"
    return None


def correlate(l0, r0, inv, r1, l1, sid, created=None):
    problem = confirm_listed_inventory(l0, inv, l1)
    if problem:
        return problem
    if r0 != r1 or r0["sid"] != sid:
        return "ResolutionChanged"
    if sid not in l0["sessions"]:
        return "ListingInventoryMismatch"
    if r0["server"] != inv["server"] or inv["sessions"].get(sid) != len(r0["windows"]):
        return "PaneInventoryMismatch"
    for wid, w in r0["windows"].items():
        active = [p for p in inv["panes"] if p["sid"] == sid and p["wid"] == wid and p["pa"]]
        if len(active) != 1 or active[0]["pane"] != w["pane"] or active[0]["pane_pid"] != w["pane_pid"] \
                or active[0]["wa"] != w["active"]:
            return "PaneInventoryMismatch"
    if created is not None:
        c_server, c_sid, c_wid, c_pane, c_pid = created
        if c_server != r0["server"] or c_sid != sid or not any(
                p["sid"] == sid and p["wid"] == c_wid and p["pane"] == c_pane and p["pane_pid"] == c_pid
                for p in inv["panes"]):
            return "CreationMismatch"
    return ("Bound", l0["sessions"][sid], selected(r0))


# ------------------------------------------------------ attach_confirmation.rs
def ac_number(v, maximum, positive):
    if v == "" or len(v) > 20 or not all("0" <= c <= "9" for c in v) or (len(v) > 1 and v[0] == "0"):
        raise Fail("Frame")
    n = int(v)
    if n > maximum or (positive and n == 0):
        raise Fail("Frame")
    return n


def ac_u32(v, positive):
    return ac_number(v, 2**32 - 1, positive)


def ac_id(v, prefix):
    if not v.startswith(prefix):
        raise Fail("Frame")
    return ac_u32(v[1:], False)


def ac_tty(v):
    if not v.startswith("/dev/pts/"):
        raise Fail("Frame")
    n = v[len("/dev/pts/"):]
    if n == "" or not n.isdigit() or (len(n) > 1 and n[0] == "0"):
        raise Fail("Frame")


def parse_w(line_bytes, nonce):
    if line_bytes.endswith(b"\r"):
        line_bytes = line_bytes[:-1]
    if not line_bytes.isascii():
        raise Fail("Frame")
    f = line_bytes.decode().split("|")
    if len(f) != 7 or f[0] != "W" or f[1] != nonce:
        raise Fail("Frame")
    ac_tty(f[6])
    return {"pid": ac_u32(f[2], True), "ticks": ac_number(f[3], 2**64 - 1, True),
            "uid": ac_u32(f[4], False), "tty_nr": ac_u32(f[5], True), "tty": f[6]}


def complete(row):
    out = row["stdout"]
    if row["exit_code"] != 0 or row["stderr"] or not row.get("stdout_utf8_valid", True) \
            or len(out.encode()) > MAX or (out and not out.endswith("\n")):
        raise Fail("Frame")
    return out


ALLOWED_FLAGS = {"attached", "focused", "UTF-8", "suspended", "read-only", "ignore-size",
                 "control-mode", "active-pane", "no-output", "wait-exit"}


def parse_clients(row):
    text = complete(row)
    if not all(32 <= b <= 126 or b == 10 for b in text.encode()):
        raise Fail("Frame")
    records, pids = [], set()
    for line in (text[:-1].split("\n") if text else []):
        f = line.split("|")
        if len(f) != 17 or f[0] != "J" or len(records) == 32:
            raise Fail("Frame")
        ac_tty(f[14])
        flags = set()
        for fl in [x for x in f[16].split(",") if x]:
            if fl not in ALLOWED_FLAGS or fl in flags:
                raise Fail("Frame")
            flags.add(fl)
        if f[16] and (f[16].startswith(",") or f[16].endswith(",") or ",," in f[16]):
            raise Fail("Frame")
        r = {"binding": ((ac_u32(f[1], True), ac_number(f[2], 2**64 - 1, True)), ac_id(f[5], "$"),
                         ac_id(f[6], "@"), ac_id(f[7], "%"), ac_u32(f[8], True)),
             "pid": ac_u32(f[3], True), "created": ac_number(f[4], 2**64 - 1, True),
             "active": [ac_number(f[i], 1, False) for i in range(9, 14)], "tty": f[14],
             "uid": None if f[15] == "" else ac_u32(f[15], False), "flags": flags}
        if r["pid"] in pids or (records and records[0]["binding"][0] != r["binding"][0]):
            raise Fail("Changed")
        pids.add(r["pid"])
        records.append(r)
    return records


def verify_process(row, w):
    text = complete(row)
    if not text.endswith("\n"):
        raise Fail("Process")
    f = text[:-1].split("|")
    if len(f) != 7 or f[0] != "P" or len(f[6]) != 1 or not f[6].isalpha() or f[6] in ("Z", "X"):
        raise Fail("Process")
    p = {"pid": ac_u32(f[1], True), "ticks": ac_number(f[2], 2**64 - 1, True),
         "uid": ac_u32(f[3], False), "tty_nr": ac_u32(f[4], True), "tty": f[5]}
    if p != w:
        raise Fail("Process")


def registered_with_process(rows, w, binding, process):
    verify_process(process, w)
    if any(r["binding"][0] != binding[0] for r in rows):
        raise Fail("Changed")
    row = next((r for r in rows if r["pid"] == w["pid"]), None)
    if row is None:
        return None
    if row["binding"] != binding or row["tty"] != w["tty"]:
        raise Fail("Changed")
    if row["uid"] is not None and row["uid"] != w["uid"]:
        raise Fail("Changed")
    if not row["flags"]:
        raise Fail("FlagsUnavailable")
    if row["active"] != [1, 1, 0, 0, 0] or "attached" not in row["flags"] or row["flags"] & {
            "active-pane", "suspended", "read-only", "control-mode", "no-output"}:
        raise Fail("ClientMode")
    return row


def valid_absolute(path):
    return (path != "" and len(path) <= 4096 and not any(ord(c) < 32 or ord(c) == 127 for c in path)
            and path.startswith("/") and all(s not in ("", ".", "..") for s in path[1:].split("/")))


def socket_response(row, sel):
    text = complete(row)
    if not text.endswith("\n"):
        raise Fail("Frame")
    f = text[:-1].split("|", 4)
    if len(f) != 5 or f[0] != "S" or ac_u32(f[1], True) != sel[0][0] \
            or ac_number(f[2], 2**64 - 1, True) != sel[0][1] or ac_id(f[3], "$") != sel[1]:
        raise Fail("Changed")
    if not valid_absolute(f[4]):
        raise Fail("Frame")
    return f[4]


# ------------------------------------------------------------------- title.rs
def t_decode(hexs):
    if len(hexs) % 2 or not all(c in "0123456789abcdefABCDEF" for c in hexs):
        return None
    try:
        s = bytes.fromhex(hexs).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    return s[:-1] if s.endswith("\n") else None


def parse_details(stdout):
    details = {}
    for line in stdout.splitlines():
        parts = line.split(" ", 2)
        if len(parts) != 3:
            continue
        kind, pane, hexs = parts
        if not pane.startswith("%") or not pane[1:].isdigit() or pane[1:] == "":
            continue
        pane = int(pane[1:])
        if kind == "T" and hexs == "":
            details.setdefault(pane, {"title": None, "children": [], "grandchildren": []})
        elif kind == "T":
            t = t_decode(hexs)
            if t is not None:
                details.setdefault(pane, {"title": None, "children": [], "grandchildren": []})["title"] = t
        elif kind in ("C", "G"):
            n = t_decode(hexs)
            if n is not None:
                d = details.setdefault(pane, {"title": None, "children": [], "grandchildren": []})
                d["children" if kind == "C" else "grandchildren"].append(n)
    return details


AGENTS = {"claude": "Claude", "codex": "Codex", "grok": "Grok", "agy": "Agy", "opencode": "OpenCode"}


def detect(d):
    for level in (d["children"], d["grandchildren"]):
        found = [AGENTS[n] for n in level if n in AGENTS]
        if found:
            return found[0] if all(x == found[0] for x in found) else None
    return None


def spinner(c):
    return "⠀" <= c <= "⣿"


def after_spinner(title, sep):
    if title and spinner(title[0]) and title[1:].startswith(sep):
        return title[1 + len(sep):]
    return None


def codex(title):
    if title.startswith("[ ! ] Action Required") or title.startswith("[ . ] Action Required"):
        return ("Waiting", "action required (Codex title)")
    if after_spinner(title, " ") is not None:
        return ("Busy", "working (Codex title)")
    plain = not title.startswith("[") and not (title and spinner(title[0]))
    return ("Idle", "ready (Codex title)") if plain and " | " in title else None


def grok(title):
    if not title.endswith(" - grok"):
        return None
    body = title[:-len(" - grok")]
    if body.startswith("⚠ Action Required - "):
        return ("Waiting", "approval required (Grok title)")
    activity = after_spinner(body, " - ")
    if activity is None:
        plain = body != "" and not spinner(body[0]) and not body.startswith("⚠") \
            and "Action Required" not in body
        return ("Idle", "ready (Grok title)") if plain else None
    if activity.startswith("Running: Ask: "):
        return ("Waiting", "question open (Grok title)")
    if any(activity.startswith(m) for m in ("Thinking - ", "Responding - ",
                                             "Waiting for response… - ", "Running: ")):
        return ("Busy", "working (Grok title)")
    return None


def pane_status(d):
    agent = detect(d)
    if agent is None or agent == "Claude":
        return None
    if agent == "Agy":
        return ("Unknown", "agy shows no status in its title")
    if agent == "OpenCode":
        return ("Unknown", "OpenCode shows no status in its title")
    title = d["title"] or ""
    result = codex(title) if agent == "Codex" else grok(title)
    return result or ("Unknown", "the %s title shows no known status" % agent)


def statuses_from_inventory(inv, titles):
    result = {}
    for sid in inv["sessions"]:
        active = [p for p in inv["panes"] if p["sid"] == sid and p["wa"] and p["pa"]]
        if len(active) != 1:
            result[sid] = ("Unknown", "no single active pane")
        elif active[0]["dead"]:
            result[sid] = ("Ended", "the session's pane is dead")
        else:
            st = pane_status(titles[active[0]["pane"]]) if active[0]["pane"] in titles else None
            result[sid] = st or ("Unknown", "no agent source is attached yet")
    return result


# ------------------------------------------------------------------ client.rs
def names_this_socket(path, socket):
    return path.startswith("/") and not any(ord(c) < 32 or ord(c) == 127 for c in path) \
        and path.endswith(socket) and path[:-len(socket)].endswith("/")


def absent_diagnosis(row, socket):
    if row["exit_code"] != 1 or row["stdout"] or not row.get("stdout_utf8_valid", True):
        return None
    if not row["stderr"].endswith("\n"):
        return None
    line = row["stderr"][:-1]
    path = None
    if line.startswith("no server running on "):
        path = line[len("no server running on "):]
    elif line.startswith("error connecting to ") and line.endswith(" (No such file or directory)"):
        path = line[len("error connecting to "):-len(" (No such file or directory)")]
    return path if path is not None and names_this_socket(path, socket) else None


def predicted_path(row, socket):
    if row["exit_code"] != 0 or row["stderr"]:
        return None
    out = row["stdout"]
    if not out.startswith("S|") or not out.endswith("\n"):
        return None
    path = out[2:-1]
    return path if names_this_socket(path, socket) else None


def server_absent(row, socket):
    if row["exit_code"] != 1 or row["stdout"]:
        return False
    msg = row["stderr"].rstrip("\r\n")
    path = None
    if msg.startswith("no server running on "):
        path = msg[len("no server running on "):]
    elif msg.startswith("error connecting to ") and msg.endswith(" (No such file or directory)"):
        path = msg[len("error connecting to "):-len(" (No such file or directory)")]
    return path is not None and path.startswith("/") and not any(ord(c) < 32 for c in path) \
        and path.rsplit("/", 1)[-1] == socket


# ------------------------------------------------------------------- builders
GUARD_REJECT = "list-commands -F '#{?#{==:#{command_list_name},display-message},AB_M1_REJECT,}'"


def guarded_kill(socket_args, server, sid):
    target = f"${sid}"
    test = "#{==:#{pid}/#{start_time}/#{session_id}," + f"{server[0]}/{server[1]}/{target}" + "}"
    return ["env", "LC_ALL=C", "tmux", "-u"] + socket_args + [
        "if-shell", "-F", "-t", target, test, f"kill-session -t '{target}'", GUARD_REJECT]


def guarded_attach(socket_args, sel):
    server, sid, wid, pane, pid = sel
    target = f"${sid}"
    test = ("#{==:#{pid}/#{start_time}/#{session_id}/#{window_id}/#{pane_id}/#{pane_pid}"
            "/#{window_active}/#{pane_active}/#{pane_dead},"
            + f"{server[0]}/{server[1]}/{target}/@{wid}/%{pane}/{pid}/1/1/0" + "}")
    return ["env", "LC_ALL=C", "tmux", "-u"] + socket_args + [
        "if-shell", "-F", "-t", target, test, f"attach-session -t '{target}'", GUARD_REJECT]


def remote_build(argv):
    prelude = "".join(" A%d=$(printf %%s '%s' | base64 -d);"
                      % (i, base64.b64encode(a.encode()).decode()) for i, a in enumerate(argv))
    return "set -eu;%s exec%s" % (prelude, "".join(' "$A%d"' % i for i in range(len(argv))))


# ------------------------------------------------------------------ analysis
FIRST = {}


def load(path):
    rows, notes, others = {}, {}, []
    for line in open(path, encoding="utf-8"):
        v = json.loads(line)
        if v["kind"] == "command":
            FIRST.setdefault(v["name"], v)  # p_repl_* labels occur twice
            rows[v["name"]] = v
        elif v["kind"] == "note":
            notes[v["name"]] = v
        else:
            others.append(v)
    return rows, notes, others


def normalize_inventory(text):
    out = []
    for line in text.split("\n"):
        f = line.split("|")
        if f[0] in ("B", "E") and len(f) == 3:
            out.append(f"{f[0]}|<pid>|<start>")
        elif f[0] == "P" and len(f) == 13:
            f[4], f[10] = "<pane_pid>", "<activity>"
            out.append("|".join(f))
        else:
            out.append(line)
    return "\n".join(out)


def main():
    raw, repo, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    rows, notes, others = load(raw)
    R = {}  # results
    log = []

    def check(name, ok, detail=""):
        R[name] = {"ok": bool(ok), "detail": detail}
        log.append(f"[{'OK ' if ok else 'BAD'}] {name}: {detail}")

    meta = next(o for o in others if o["kind"] == "meta")
    # A. version gate
    v = rows["p_version"]
    check("version_output_exact", v["stdout"] == "tmux 3.6\n" and v["stderr"] == "" and v["exit_code"] == 0,
          repr(v["stdout"]) + " stderr=" + repr(v["stderr"]))
    check("version_current_gate_rejects", from_response(v) is None, "MeasuredVersion::from_response -> None today")
    check("version_with_v3_6_arm", from_response(v, ("tmux 3.0\n", "tmux 3.3a\n", "tmux 3.4\n", "tmux 3.6\n")) is not None,
          "an arm \"tmux 3.6\\n\" => V3_6 would accept it")
    check("binary_identity", meta["binary_has_nul_3_6_nul"] == 1 and meta["binary_has_nul_3_6a_nul"] == 0,
          f"sha256 {meta['tmux_sha256']}, '\\0 3.6 \\0' x{meta['binary_has_nul_3_6_nul']}, '3.6a' x{meta['binary_has_nul_3_6a_nul']}")

    # B. inventory matrix vs. 3.4 golden
    golden34 = json.load(open(os.path.join(repo, "src-tauri/tests/fixtures/tmux-inventory/tmux-3.4.json"), encoding="utf-8"))
    matrix = []
    for case in golden34["cases"]:
        name = case["name"]
        r36 = rows[name]
        cls36 = classify(r36, P5)
        cls34 = case["expected"]["class"]
        same_class = cls36[0] == cls34
        norm34 = normalize_inventory(case["stdout"])
        norm36 = normalize_inventory(r36["stdout"])
        err34 = case["stderr"].replace(golden34["socket"], "<socket>")
        err36 = r36["stderr"].replace(P5, "<socket>")
        same_shape = norm34 == norm36 and err34 == err36 and case["code"] == r36["exit_code"]
        matrix.append({"name": name, "class34": cls34, "class36": cls36[0], "same_class": same_class,
                       "same_shape": same_shape, "stdout36": r36["stdout"], "stderr36": r36["stderr"],
                       "code36": r36["exit_code"]})
    check("matrix_28_classes_equal", all(m["same_class"] for m in matrix),
          f"{sum(m['same_class'] for m in matrix)}/28 gleiche Klasse")
    check("matrix_28_shapes_equal", all(m["same_shape"] for m in matrix),
          f"{sum(m['same_shape'] for m in matrix)}/28 gleiche Form (Zahlenwerte maskiert)")
    for m in matrix:
        if not m["same_shape"]:
            log.append("   shape diff: " + m["name"])
    R["matrix"] = matrix
    esc = rows["read_escape_option"]["stdout"]
    check("output_escaping_changed", esc == "a\x1bb\x01c\rd\x7fe\n",
          "3.6 gibt " + repr(esc) + " roh aus; 3.4 haette laut Quelle a\\033b\\001c\\rd\\177e ausgegeben")
    check("title_controls_rejected", rows["read_title_controls"]["stdout"] == "alpha|Q|$999|1\n",
          "select-pane -T mit LF/CR/TAB wird wie unter 3.4 nicht uebernommen")
    check("option_lf_tab_raw", rows["read_control_option"]["stdout"] == "Q|$999|1\nP|fake\tend\n",
          "LF/TAB in eigener Option wie unter 3.4 roh")

    # C. product: absence
    for label in ("p_absent_list", "p_inert_list"):
        diag = absent_diagnosis(rows[label], S1)
        pred = predicted_path(rows[label.replace("_list", "_socket_path")], S1)
        check(label + "_server_absent", diag is not None and diag == pred,
              f"diagnosis={diag!r} prediction={pred!r} -> ServerAbsent, sobald V3_6 nicht wie V3_0 ausgenommen wird")
    for label in ("p_absent_names", "p_inert_names", "p_absent_kill_name", "p_inert_kill_name"):
        check(label + "_server_absent_tolerant", server_absent(rows[label], S1), repr(rows[label]["stderr"]))
    for label in ("p_absent_inventory_direct", "p_absent_inventory_guarded", "p_inert_inventory_direct"):
        check(label + "_named_is_error", classify(rows[label])[0] == "TmuxError",
              "benannter Socket: kein NoServer im Klassifizierer (wie 3.4)")
    check("absent_probes_started_nothing", notes["p_absent_socket_absent_after"]["value"] is True
          and all(notes[f"absent_poll_{i}_socket_absent_after"]["value"] for i in (1, 2, 3)),
          "Socketdatei nach allen Abwesenheitsproben weiter abwesend")

    # D. empty server
    empty_l = parse_list(rows["p_empty_list"])
    inv_e = classify(rows["p_empty_inventory_direct"])
    inv_eg = classify(rows["p_empty_inventory_guarded"])
    check("empty_server_inventory", inv_e[0] == "Snapshot" and inv_eg[0] == "Snapshot"
          and not inv_e[1]["sessions"] and inv_e[1] == inv_eg[1]
          and confirm_listed_inventory(empty_l, inv_e[1], empty_l) is None,
          "B/E ohne Q/P, direkt == bewacht")
    check("empty_guard_kill_rejects", rows["p_empty_guard_kill"]["stdout"] == "AB_M1_REJECT\n"
          and rows["p_empty_guard_kill"]["exit_code"] == 0, "AB_M1_REJECT, Exit 0")
    check("empty_resolve_error", rows["p_empty_resolve_missing"]["stderr"] == "no current target\n",
          repr(rows["p_empty_resolve_missing"]["stderr"]))

    # E. creations
    created = {}
    for label in ("codex", "grok", "grokwait", "plain", "dead", "kill", "namekill", "rename", "repl"):
        c = parse_created(FIRST[f"p_{label}_create"])
        before = parse_list(FIRST[f"p_{label}_names_before"])
        after = parse_list(FIRST[f"p_{label}_names_after"])
        problem = confirm_created_listing(before, c, after)
        created[label] = c
        check(f"create_{label}", problem is None, f"C={FIRST[f'p_{label}_create']['stdout'].strip()}")
    # the replacement creation (second p_repl_create) and its own list transition
    repl_new = parse_created(rows["p_repl_create"])
    check("create_repl_replacement", confirm_created_listing(
        parse_list(rows["p_repl_names_before"]), repl_new, parse_list(rows["p_repl_names_after"])) is None,
        f"C={rows['p_repl_create']['stdout'].strip()}")
    dup = rows["p_duplicate_create"]
    check("duplicate_create", dup["exit_code"] == 1 and "duplicate session" in dup["stderr"], repr(dup["stderr"]))
    check("missing_exact_name", rows["p_missing_exact_name"]["stderr"] == "can't find session: ab_ux36\n",
          repr(rows["p_missing_exact_name"]["stderr"]))

    # F. observe_sessions
    l0, l1 = parse_list(rows["p_obs_l0"]), parse_list(rows["p_obs_l1"])
    inv = classify(rows["p_obs_inventory"])
    check("obs_inventory_snapshot", inv[0] == "Snapshot", f"{len(inv[1]['sessions'])} Sessions, {len(inv[1]['panes'])} Panes")
    inv = inv[1]
    gn, ga = classify(rows["p_obs_inventory_guarded_named"]), classify(rows["p_obs_inventory_guarded_absolute"], P1)
    check("obs_guarded_equals_direct", gn[0] == ga[0] == "Snapshot" and gn[1] == inv and ga[1] == inv,
          "list-commands-Huelle (bewacht) liefert dasselbe Inventar")
    bound = {}
    for sid in l0["sessions"]:
        r0 = parse_resolved(rows[f"p_obs_r0_${sid}"])
        r1 = parse_resolved(rows[f"p_obs_r1_${sid}"])
        res = correlate(l0, r0, inv, r1, l1, sid)
        bound[sid] = res
    all_bound = all(isinstance(b, tuple) and b[0] == "Bound" for b in bound.values())
    check("obs_all_sessions_bound", all_bound, f"{sum(isinstance(b, tuple) for b in bound.values())}/{len(bound)} Bound")
    R["bound"] = {f"${k}": (v if isinstance(v, str) else [v[0], v[1], list(v[2][0]) + list(v[2][1:])])
                  for k, v in bound.items()}
    dead = [p for p in inv["panes"] if p["dead"]]
    check("dead_pane_numeric", len(dead) == 1 and dead[0]["pane_pid"] > 0,
          f"pane_dead=1 mit pane_pid={dead[0]['pane_pid'] if dead else None}")
    multi = parse_resolved(rows[f"p_obs_r0_${created['plain'][1]}"])
    check("multi_window_resolve", len(multi["windows"]) == 2, json.dumps(multi["windows"]))
    names = l0["sessions"]
    R["listed_names"] = {f"${k}": v for k, v in names.items()}

    # G. titles and status
    details = parse_details(rows["p_details"]["stdout"])
    statuses = statuses_from_inventory(inv, details)
    R["statuses"] = {f"${k}": list(v) for k, v in statuses.items()}
    expected = {created["codex"][1]: "Busy", created["grok"][1]: "Busy", created["grokwait"][1]: "Waiting",
                created["dead"][1]: "Ended"}
    check("title_status_pipeline", all(statuses[k][0] == v for k, v in expected.items())
          and all(statuses[k][0] == "Unknown" for k in statuses if k not in expected),
          json.dumps({f"${k}": statuses[k] for k in expected}, ensure_ascii=False))
    check("title_default", rows["p_title_default_plain"]["stdout"] == "test-vm\n", "Standardtitel = Hostname wie unter 3.4")
    R["details"] = {f"%{k}": v for k, v in details.items()}

    # H. guards
    server = inv["server"]
    sockL = ["-L", S1]
    exp = {
        "p_guard_kill_wrong_pid": guarded_kill(sockL, (server[0] + 1, server[1]), created["kill"][1]),
        "p_guard_kill_wrong_start": guarded_kill(sockL, (server[0], server[1] + 1), created["kill"][1]),
        "p_guard_kill_missing_session": guarded_kill(sockL, server, 4294967295),
        "p_guard_kill_true": guarded_kill(sockL, server, created["kill"][1]),
    }
    sel_plain = selected(parse_resolved(rows[f"p_obs_r0_${created['plain'][1]}"]))
    exp["p_guard_attach_true_without_pty"] = guarded_attach(sockL, sel_plain)
    exp["p_guard_attach_wrong_pane_pid"] = guarded_attach(sockL, sel_plain[:4] + (sel_plain[4] + 1,))
    check("guard_argv_equals_builder", all(rows[k]["argv"] == v for k, v in exp.items()),
          "ausgefuehrte argv == BindingQuery-Builder (Python-Nachbau)")
    rej = [k for k in exp if k not in ("p_guard_kill_true", "p_guard_attach_true_without_pty")]
    check("guard_false_rejects", all(rows[k]["stdout"] == "AB_M1_REJECT\n" and rows[k]["exit_code"] == 0
                                     and rows[k]["stderr"] == "" for k in rej), ", ".join(rej))
    after_kill = parse_list(rows["p_guard_kill_true_after"])
    check("guard_true_kill", rows["p_guard_kill_true"]["exit_code"] == 0 and rows["p_guard_kill_true"]["stdout"] == ""
          and created["kill"][1] not in after_kill["sessions"], "Exit 0, leer, Session weg")
    na = rows["p_guard_attach_true_without_pty"]
    check("guard_true_attach_without_pty", na["exit_code"] == 1 and na["stderr"] == "open terminal failed: not a terminal\n",
          repr(na["stderr"]))
    nk = rows["p_name_kill_missing"]
    check("name_kill_missing_idempotent", nk["exit_code"] == 1 and nk["stdout"] == ""
          and nk["stderr"].rstrip("\r\n") == "can't find session: ab_ux36_nosuch", repr(nk["stderr"]))

    # I. rename and replacement
    rn = correlate(parse_list(rows["p_rename_l0"]), parse_resolved(rows["p_rename_r0"]),
                   classify(rows["p_rename_inventory"])[1], parse_resolved(rows["p_rename_r1"]),
                   parse_list(rows["p_rename_l1"]), created["rename"][1])
    check("rename_detected", rn == "ListingChanged", str(rn))
    try:
        parse_resolved(rows["p_repl_r_old"])
        old_err = None
    except Fail as error:
        old_err = str(error)
    fresh = parse_resolved(rows["p_repl_r_new"])
    repl_l1 = parse_list(rows["p_repl_l1"])
    repl_inv = classify(rows["p_repl_inventory"])[1]
    stale = correlate(repl_l1, fresh, repl_inv, fresh, repl_l1, fresh["sid"], created["repl"])
    good = correlate(repl_l1, fresh, repl_inv, fresh, repl_l1, fresh["sid"], parse_created(rows["p_repl_create"]))
    check("replacement_rejects_old", old_err == "TmuxError:1" and stale == "CreationMismatch"
          and isinstance(good, tuple), f"r_old={old_err} old_creation={stale} new_creation={good[0] if isinstance(good, tuple) else good}")

    # J. confirmed open (with config: p_open, without: m_open)
    for prefix, sock, path in (("p_open", S1, P1), ("m_open", "abtest_ux36_5", P5)):
        wrapper = next(o for o in others if o["kind"] == "pty_wrapper" and o["name"] == prefix)
        end = next(o for o in others if o["kind"] == "pty_end" and o["name"] == prefix)
        head = base64.b64decode(end["head_b64"])
        w = parse_w(head.split(b"\n", 1)[0], wrapper["nonce"])
        guard = wrapper["guard_argv"]
        sel_server = (int(guard[-3].split(",")[1].split("/")[0]), int(guard[-3].split(",")[1].split("/")[1]))
        r0 = parse_resolved(rows[prefix + "_confirm_r0"])
        sel = selected(r0)
        path_named = socket_response(rows[prefix + "_named_probe"], sel)
        path_abs = socket_response(rows[prefix + "_absolute_probe"], sel)
        expected_guard = guarded_attach(["-S", path], sel)
        j_rows = parse_clients(rows[prefix + "_j_0"])
        reg = registered_with_process(j_rows, w, sel, rows[prefix + "_process"])
        l0c, l1c = parse_list(rows[prefix + "_confirm_l0"]), parse_list(rows[prefix + "_confirm_l1"])
        invc = classify(rows[prefix + "_confirm_inventory"], path)
        conf = correlate(l0c, r0, invc[1], parse_resolved(rows[prefix + "_confirm_r1"]), l1c, sel[1])
        ok = (path_named == path_abs == path and wrapper["guard_argv"] == expected_guard
              and sel_server == sel[0] and reg is not None and isinstance(conf, tuple) and conf[2] == sel
              and end["exit_code"] == 0 and parse_clients(rows[prefix + "_j_detached"]) == [])
        check(prefix + "_confirmed_open", ok,
              f"W={w}, J flags={sorted(reg['flags']) if reg else None}, uid={reg['uid'] if reg else None}, "
              f"J-Felder=17, confirm={conf[0] if isinstance(conf, tuple) else conf}, Exit nach detach={end['exit_code']}")
        R[prefix + "_j_line"] = rows[prefix + "_j_0"]["stdout"]
        R[prefix + "_attach_line_sha256"] = hashlib.sha256(remote_build(wrapper["attach_argv"]).encode()).hexdigest()

    # K. foreign names vs 3.4
    b34 = None
    for line in open(os.path.join(repo, "src-tauri/tests/fixtures/tmux-session-binding/binding-tmux34.jsonl"), encoding="utf-8"):
        vv = json.loads(line)
        if vv.get("kind") == "session_binding_measurement":
            b34 = {c["requested_name"]: c["listed_name"] for c in vv["created_sessions"]}
    foreign = {}
    for label in ("unicode", "spaces", "punctuation", "leading_dollar", "backslash_dollar"):
        n = notes["p_foreign_name_" + label]
        has_req = rows["p_has_requested_" + label]["exit_code"]
        has_list = rows.get("p_has_listed_" + label, {}).get("exit_code")
        foreign[label] = {"requested": n["requested"], "listed36": n["listed"],
                          "listed34": b34.get(n["requested"]), "has_requested_exit": has_req,
                          "has_listed_exit": has_list}
    R["foreign_names"] = foreign
    check("foreign_names_parse", all(names.get(int(notes['p_foreign_name_' + k]['session_id'][1:])) == v["listed36"]
                                     for k, v in foreign.items()), "parse_list behaelt die gelisteten Bytes")
    diff = {k: v for k, v in foreign.items() if v["listed34"] is not None and v["listed34"] != v["listed36"]}
    check("foreign_names_display_differs_from_34", len(diff) == 1 and "punctuation" in diff,
          json.dumps(diff, ensure_ascii=False))

    # L. 3.4 guard fixture J line shape vs 3.6
    j34 = None
    for line in open(os.path.join(repo, "src-tauri/tests/fixtures/tmux-guard/guard-tmux34.jsonl"), encoding="utf-8"):
        vv = json.loads(line)
        if vv.get("kind") == "guard_wj_measurement":
            j34 = next(c["stdout"] for c in vv["commands"] if c["name"] == "reference_attach_j0_0")
    def jshape(s):
        f = s.strip().split("\n")[0].split("|")
        return [f[0], "<n>", "<n>", "<n>", "<n>"] + [re.sub(r"\d+", "N", x) for x in f[5:9]] + f[9:14] + [
            re.sub(r"\d+", "N", f[14]), f[15], f[16]]
    check("j_shape_equals_34", jshape(j34) == jshape(R["p_open_j_line"]) == jshape(R["m_open_j_line"]),
          "3.4: " + j34.strip() + " | 3.6: " + R["p_open_j_line"].strip())

    # summary
    R["all_ok"] = all(v["ok"] for k, v in R.items() if isinstance(v, dict) and "ok" in v)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "analysis-results.json"), "w", encoding="utf-8") as h:
        json.dump(R, h, ensure_ascii=False, indent=1, default=str)
    with open(os.path.join(out_dir, "analysis-results.txt"), "w", encoding="utf-8") as h:
        h.write("\n".join(log) + "\n" + ("ALL OK\n" if R["all_ok"] else "NOT ALL OK\n"))
    print("\n".join(log))
    print("ALL OK" if R["all_ok"] else "NOT ALL OK")

    # M. fixture proposal (same schema as tmux-3.4.json)
    prop = os.path.join(out_dir, "fixture-proposal")
    os.makedirs(prop, exist_ok=True)
    commands = []
    names_needed = {c["name"] for c in golden34["cases"]}
    for name, row in rows.items():
        if row["via"] != "direct":
            continue
        entry = {k: row[k] for k in ("name", "argv", "exit_code", "termination", "complete_eof", "stdout", "stderr")}
        if name in names_needed:
            cls = classify(row, P5)
            if cls[0] == "Snapshot":
                s = cls[1]
                entry["classification"] = {"class": "Snapshot", "server": list(s["server"]),
                                           "sessions": {f"${k}": v for k, v in s["sessions"].items()},
                                           "panes": [row_fields(p) for p in s["panes"]]}
            else:
                entry["classification"] = {"class": cls[0]}
        commands.append(entry)
    report = {"kind": "inventory_measurement", "host": meta["host"], "binary": {
        "path": "/usr/bin/tmux", "sha256": meta["tmux_sha256"], "package": "tmux 3.6a-2ubuntu0.1"},
        "version_command": {k: rows["matrix_version"][k] for k in ("argv", "exit_code", "stdout", "stderr")},
        "socket": P5, "started_unix_ms": meta["started_unix_ms"], "commands": commands}
    source = (json.dumps({"kind": "measurement_note", "text": "tmux 3.6 inventory matrix, abtest_ux36_5, -f /dev/null; derived from raw-measure.jsonl"}, ensure_ascii=True)
              + "\n" + json.dumps(report, ensure_ascii=True) + "\n")
    src_name = "2026-10-11-tmux-3.6.jsonl"
    with open(os.path.join(prop, src_name), "w", encoding="utf-8", newline="\n") as h:
        h.write(source)
    golden = {"source": "docs/messungen/fixtures/m1-tmux-inventory/" + src_name,
              "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
              "version_output": "tmux 3.6\n", "socket": P5,
              "query_argv": ["env", "LC_ALL=C", "tmux", "-u", "-S", P5] + golden34["query_argv"][6:],
              "cases": []}
    for case in golden34["cases"]:
        row = rows[case["name"]]
        entry = next(c for c in commands if c["name"] == case["name"])
        golden["cases"].append({"name": case["name"], "code": row["exit_code"], "stdout": row["stdout"],
                                "stderr": row["stderr"], "expected": entry["classification"]})
    with open(os.path.join(prop, "tmux-3.6.json"), "w", encoding="utf-8", newline="\n") as h:
        json.dump(golden, h, ensure_ascii=False, indent=2)
        h.write("\n")
    print("fixture proposal:", golden["source_sha256"], len(golden["cases"]), "cases")


def row_fields(p):
    return [f"${p['sid']}", f"@{p['wid']}", f"%{p['pane']}", str(p["pane_pid"]), str(int(p["wa"])),
            str(int(p["pa"])), str(int(p["dead"])), str(int(p["alt"])), str(p["attached"]),
            str(p["activity"]), str(int(p["bell"])), str(p["wpanes"])]


if __name__ == "__main__":
    main()
