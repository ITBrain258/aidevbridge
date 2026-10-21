#!/usr/bin/env python3
"""Temporary Linux-only Claude hook measurement; not an aidevbridge runtime dependency.

Copy this file into a newly created /tmp/ab-m1-hooks-* directory on the test VM.
Run `python3 <path> init`, then start/observe/send/keys/export/cleanup.
Only this directory and its explicit tmux socket are controlled. Claude itself may
create its normal session/trust metadata; existing settings/hooks are never edited.
Python is a measurement dependency, not the proposed production hook contract.
"""

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

HARNESS = "agentbridge-m1-claude-hooks-v1"
# The default ~/.local/bin/claude symlink may advance between measurement runs.
# Keep interactive launches on the same exact version as m1-probe-agents.py.
BINARY = Path.home() / ".local/share/claude/versions/2.1.268"
BINARY_SHA256 = "9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653"
MARKS = {"permission-visible", "dialog-closed", "input-ready", "tool-running",
         "model-working", "agent-exited", "login-required", "test-incomplete"}
CONTEXTS = {"detached", "tile-closed", "tile-focused", "tile-unfocused", "other-client"}
EVENTS = {
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
    "PermissionDenied", "PostToolUse", "PostToolUseFailure", "Notification",
    "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop",
}
PROMPTS = {
    "short": "Run exactly this one Bash command: python3 -c \"import time; time.sleep(3); print('M1_SHORT_DONE')\". Do not run any other commands. Then respond DONE. If permission is denied, respond DENIED and do not retry.",
    "long": "Run exactly this one foreground Bash command: python3 -c \"import time; time.sleep(45); print('M1_LONG_DONE')\". Set timeout to 90000 milliseconds, do not run it in the background, and do not run any other commands. Then respond DONE. If permission is denied, respond DENIED and do not retry.",
    "reply": "Reply DONE without using tools.",
}
ENUMS = {
    "permission_mode": {"default", "manual", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"},
    "source": {"startup", "resume", "clear", "compact", "fork"},
    "reason": {"clear", "resume", "logout", "prompt_input_exit", "other"},
    "notification_type": {"permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog", "agent_needs_input", "agent_completed"},
    "tool_name": {"Bash", "Read", "Write", "Edit", "Agent", "Task", "TaskOutput", "TaskStop"},
    "error": {"rate_limit", "overloaded", "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "invalid_request", "model_not_found", "server_error", "max_output_tokens", "unknown"},
}


def identity(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def verify_binary(binary=BINARY, expected=BINARY_SHA256):
    if binary.is_symlink() or not binary.is_file():
        raise RuntimeError("pinned measurement binary unavailable")
    actual = hashlib.sha256(binary.read_bytes()).hexdigest()
    if actual != expected:
        raise RuntimeError("pinned measurement binary checksum mismatch")
    return actual


def sanitize(payload):
    """Never return prompts, messages, paths, tool input/output, or transcript data."""
    if (not isinstance(payload, dict) or not isinstance(payload.get("hook_event_name"), str)
            or payload["hook_event_name"] not in EVENTS):
        raise ValueError("unsupported event")
    row = {"kind": "hook", "event": payload["hook_event_name"]}
    for key in ("session_id", "agent_id", "tool_use_id"):
        value = payload.get(key)
        if isinstance(value, str) and 0 < len(value) <= 256:
            row[key + "_hash"] = identity(value)
    for key, allowed in ENUMS.items():
        value = payload.get(key)
        if isinstance(value, str):
            row[key] = value if value in allowed else "other"
    for key in ("stop_hook_active", "is_interrupt"):
        if isinstance(payload.get(key), bool):
            row[key] = payload[key]
    for key in ("background_tasks", "session_crons"):
        value = payload.get(key)
        if isinstance(value, list):
            row[key + "_count"] = len(value)
        else:
            row[key + "_present"] = False
    return row


def root_dir():
    root = Path(__file__).parent
    if root.is_symlink() or root.resolve() != root or root.parent != Path("/tmp"):
        raise RuntimeError("harness must live directly in an isolated /tmp directory")
    if not re.fullmatch(r"ab-m1-hooks-[A-Za-z0-9-]{8,80}", root.name):
        raise RuntimeError("unexpected measurement directory name")
    return root


def require_owner(root):
    marker = root / "owner.json"
    if not marker.is_file() or marker.is_symlink():
        raise RuntimeError("measurement ownership marker missing")
    data = json.loads(marker.read_text())
    if data.get("root") != str(root) or data.get("harness") != HARNESS:
        raise RuntimeError("measurement ownership mismatch")
    return data


def directory_binding(root):
    require_owner(root)
    if (root.parent != Path("/tmp") or root.resolve() != root
            or not re.fullmatch(r"ab-m1-hooks-[A-Za-z0-9-]{8,80}", root.name)):
        raise RuntimeError("invalid measurement root")
    result = {}
    for name, target in (("root", root), ("work", root / "work")):
        info = target.lstat()
        if (not stat.S_ISDIR(info.st_mode) or target.resolve() != target or info.st_uid != os.getuid()
                or (name == "root" and stat.S_IMODE(info.st_mode) != 0o700)):
            raise RuntimeError("measurement directory ownership changed")
        result[name] = {"dev": info.st_dev, "ino": info.st_ino, "uid": info.st_uid}
    return result


def write_once(target, value):
    # O_EXCL preserves failed/partial reservations; never retry an unclear start.
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, sort_keys=True)


def error_profile_module():
    path = Path(__file__).resolve().with_name("m1-error-profile.py")
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("explicit error profile helper unavailable")
    spec = importlib.util.spec_from_file_location("m1_error_profile", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_launch_profile(root, launch, require_live=False):
    expected = launch.get("error_profile_binding")
    if require_owner(root).get("error_profile", False) or expected is not None:
        module = error_profile_module()
        module.require_mode(root, True)
        if expected is None or module.binding(root, require_live=require_live) != expected:
            raise RuntimeError("error profile launch binding changed")
        module.validate_client(root, launch)
    return expected


def launch_source(launch):
    source = launch.get("start_source", "startup")
    if source not in {"startup", "resume"}:
        raise RuntimeError("unsupported launch source")
    return source


def launch_effort(launch):
    # Historical launches have no field and retain the former fixed low effort.
    effort = launch.get("effort", "low")
    if not isinstance(effort, str) or effort not in {"low", "high"}:
        raise RuntimeError("unsupported measurement effort")
    if launch.get("error_profile_binding") is not None and effort != "low":
        raise RuntimeError("error profile effort must remain low")
    return effort


def verify_effort_start(rows, launch):
    starts = [row for row in rows if row.get("action") == "start"
              and row.get("launch_id_hash") == identity(launch["launch_id"])]
    if len(starts) != 1 or starts[0].get("effort") != launch.get("effort"):
        raise RuntimeError("launch effort changed after start reservation")
    launch_effort(launch)


def call(argv, timeout=10, check=True, env=None):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=check, env=env)


def tmux(root, *args, check=True):
    return call(["tmux", "-S", str(root / "tmux.sock"), *args], check=check)


def exact_target(label):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", label):
        raise RuntimeError("invalid test label")
    return "=" + label + ":"


def read_events(root):
    with (root / "events.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        target = root / "events.jsonl"
        return [json.loads(line) for line in target.read_text().splitlines()] if target.exists() else []


def append(root, row):
    require_owner(root)
    with (root / "events.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target = root / "events.jsonl"
        if target.exists() and target.stat().st_size > 2 * 1024 * 1024:
            raise RuntimeError("measurement event limit reached")
        counter = root / "sequence"
        seq = int(counter.read_text()) + 1 if counter.exists() else 1
        row = {"seq": seq, "unix_ms": time.time_ns() // 1000000,
               "monotonic_ns": time.monotonic_ns(), **row}
        with target.open("a") as stream:
            stream.write(json.dumps(row, sort_keys=True) + "\n")
        counter.write_text(str(seq))
    return row


def proc_identity(pid):
    # /proc reads are limited to the measured pane process or its ancestors.
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        rest = raw[raw.rfind(")") + 2:].split()
        return {"pid": pid, "ppid": int(rest[1]), "start_ticks": int(rest[19]), "state": rest[0]}
    except (FileNotFoundError, ProcessLookupError):
        return None
    except (ValueError, IndexError):
        raise RuntimeError("process stat could not be parsed") from None


def same_process(left, right):
    # Reparenting does not end a process; PID reuse does change start_ticks.
    return bool(left and right and all(isinstance(left.get(key), int)
                                      and left[key] > 0 and left[key] == right.get(key)
                                      for key in ("pid", "start_ticks")))


def process_alive(owner, current):
    # Retain a zombie's generation for ownership checks without calling it live.
    # Unknown states do not establish either liveness or a qualified dead binding.
    return bool(same_process(owner, current) and current.get("state") in {"R", "S", "D", "T", "t", "I", "W", "P"})


def ancestors(pid, stop_pid):
    chain = []
    while pid > 1 and len(chain) < 16:
        item = proc_identity(pid)
        if not item or any(previous["pid"] == pid for previous in chain):
            break
        chain.append(item)
        if pid == stop_pid:
            break
        pid = item["ppid"]
    return chain


def launch_path(root, label):
    exact_target(label)
    return root / ("launch-" + label + ".json")


def read_launch(root, label):
    path = launch_path(root, label)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("no launch owned by this harness")
    data = json.loads(path.read_text())
    if data.get("label") != label or data.get("mode") != "direct":
        raise RuntimeError("invalid launch marker")
    if (not re.fullmatch(r"[0-9a-f]{32}", data["launch_id"])
            or str(uuid.UUID(data["session_id"])) != data["session_id"]):
        raise RuntimeError("invalid owned launch identifiers")
    source = launch_source(data)
    launch_effort(data)
    if data.get("directory_identity") is not None and data["directory_identity"] != directory_binding(root):
        raise RuntimeError("launch root or work directory replaced")
    if source == "resume" and (not data.get("directory_identity") or not data.get("resume_origin")):
        raise RuntimeError("resume origin missing")
    verify_launch_profile(root, data)
    return data


def bound_owner(root, label):
    launch = read_launch(root, label)
    rows = read_events(root)
    verify_effort_start(rows, launch)
    matches = [row for row in rows if row.get("action") == "bind_owner"
               and row.get("launch_id_hash") == identity(launch["launch_id"])]
    if len(matches) != 1:
        raise RuntimeError("launch not yet bound or ambiguous; inspect before continuing")
    bound = matches[0]
    if (bound.get("start_source", "startup") != launch_source(launch)
            or bound.get("directory_identity") != launch.get("directory_identity")
            or bound.get("resume_origin") != launch.get("resume_origin")
            or bound.get("effort") != launch.get("effort")
            or bound.get("error_profile_binding") != launch.get("error_profile_binding")):
        raise RuntimeError("launch provenance changed after binding")
    if launch_source(launch) == "resume":
        validate_resume_lineage(root, launch)
        require_new_generation(launch, bound["agent_process"])
    return launch, matches[0]


def measured_snapshot(root, label, require_live=False):
    launch, bound = bound_owner(root, label)
    profile = verify_launch_profile(root, launch, require_live=require_live)
    snap = pane_snapshot(root, label)
    for key in ("server_pid", "server_start_time", "session_id", "window_id", "pane_id"):
        if snap[key] != bound[key]:
            raise RuntimeError("measured pane/server replaced; refusing stale label")
    if not same_process(snap["process"], bound["process"]):
        # A dead direct pane has no process, and is still observable.
        if not snap["pane_dead"] or snap["process"]:
            raise RuntimeError("pane process generation changed")
    owner = bound["agent_process"]
    current = snap["process"] if owner["pid"] == snap["pane_pid"] else proc_identity(owner["pid"])
    live = process_alive(owner, current)
    if require_live and (snap["pane_dead"] or not live):
        raise RuntimeError("measured agent is no longer alive; no input sent")
    return {**snap, **({"error_profile_binding": profile} if profile is not None else {}),
            **({"effort": launch_effort(launch)} if "effort" in launch else {}),
            "launch_id_hash": identity(launch["launch_id"]),
            "initial_session_id_hash": identity(launch["session_id"]),
            "agent_process": owner, "agent_observation": current,
            "agent_alive": live, "launch_mode": launch["mode"],
            "start_source": launch_source(launch), "directory_identity": launch.get("directory_identity"),
            "resume_origin": launch.get("resume_origin")}


def record(root):
    started_ms = time.time_ns() // 1000000
    started_mono = time.monotonic_ns()
    raw = sys.stdin.buffer.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        append(root, {"kind": "recorder_error", "reason": "input_limit"})
        return
    try:
        row = sanitize(json.loads(raw))
    except (ValueError, UnicodeDecodeError):
        append(root, {"kind": "recorder_error", "reason": "invalid_input"})
        return
    pane = os.environ.get("TMUX_PANE", "")
    row["pane"] = pane if re.fullmatch(r"%\d+", pane) else None
    row["recorder_pid"] = os.getpid()
    row["recorder_started_unix_ms"] = started_ms
    row["recorder_started_monotonic_ns"] = started_mono
    row["recorder_parent"] = proc_identity(os.getppid())
    launch_id = os.environ.get("AB_M1_LAUNCH_ID", "")
    owner_pid = os.environ.get("AB_M1_AGENT_PID", "")
    if re.fullmatch(r"[0-9a-f]{32}", launch_id) and owner_pid.isdigit():
        row["launch_id_hash"] = identity(launch_id)
        row["recorder_ancestors"] = ancestors(os.getppid(), int(owner_pid))
        row["declared_agent_ancestor_present"] = any(
            item["pid"] == int(owner_pid) for item in row["recorder_ancestors"])
    append(root, row)


def initialize(root, error_profile=False):
    binary_sha256 = verify_binary()
    profile_module = error_profile_module() if error_profile else None
    if profile_module is not None:
        profile_module.managed_absent()
    if (root / "owner.json").exists():
        raise RuntimeError("already initialized")
    os.chmod(root, 0o700)
    marker = {"harness": HARNESS, "root": str(root),
              "created_unix_ms": time.time_ns() // 1000000}
    if error_profile:
        marker["error_profile"] = True
        write_once(root / "owner.json", marker)
    else:
        (root / "owner.json").write_text(json.dumps(marker))
    (root / "work").mkdir()
    command = "python3 " + shlex.quote(str(root / Path(__file__).name)) + " record"
    config = {"hooks": {event: [{"hooks": [{"type": "command", "command": command,
                                          "timeout": 3}]}] for event in sorted(EVENTS)}}
    if error_profile:
        # These three files are ours to create, independently of the caller's
        # umask. Do not repair permissions of transferred helper inputs here.
        write_once(root / "settings.json", config)
        write_once(root / "mcp.json", {"mcpServers": {}})
    else:
        (root / "settings.json").write_text(json.dumps(config))
        (root / "mcp.json").write_text('{"mcpServers":{}}')
    profile_env = None
    if profile_module is not None:
        profile_module.prepare(root)
        profile_env = profile_module.environment(root, initialization=True)
    binary = BINARY
    metadata = {"claude_version": call([str(binary), "--version"], env=profile_env).stdout.strip(),
                "binary_resolved": str(binary.resolve()).replace(str(Path.home()), "~"),
                "binary_sha256": binary_sha256,
                "tmux_version": call(["tmux", "-V"], env=profile_env).stdout.strip(),
                "python_version": sys.version.split()[0]}
    if error_profile:
        metadata.update(error_profile=True, config_namespace="own_synthetic_api_key",
                        runtime_compatibility_proven=False, network_isolation_claimed=False)
    (root / "environment.json").write_text(json.dumps(metadata, indent=2))
    append(root, {"kind": "harness", "action": "init"})
    return metadata


def agent_argv(root, launch):
    binary = str(BINARY)
    argv = [binary, "--restricted", "--tools", "Bash", "--permission-mode", "manual",
            "--setting-sources", "", "--settings", str(root / "settings.json"),
            "--strict-mcp-config", "--mcp-config", str(root / "mcp.json"),
            "--no-chrome", "--effort", launch_effort(launch),
            "--resume" if launch_source(launch) == "resume" else "--session-id", launch["session_id"],
            "--name", "agentbridge-m1-synthetic",
            "--system-prompt", "This is an authorized synthetic terminal-state measurement. Work only in the current temporary directory. Follow the exact harmless test commands. Never inspect other directories, settings, accounts, or transcripts. After a command completes, respond DONE. If a command is denied, respond DENIED and do not retry."]
    if not launch["enable_lifecycle"]:
        argv.append("--disable-slash-commands")
    if launch.get("error_profile_binding") is not None:
        # No tool execution is needed to exercise a synthetic API failure.
        argv[argv.index("--tools") + 1] = ""
    return argv


def run_agent(root, label, launch_id):
    """Internal exec launcher: binds the exact future Claude PID before exec."""
    launch = read_launch(root, label)
    if launch_id != launch["launch_id"]:
        raise RuntimeError("stale launch command")
    verify_effort_start(read_events(root), launch)
    verify_binary()
    profile = verify_launch_profile(root, launch, require_live=True)
    if ((profile is None and os.environ.get("CLAUDE_CONFIG_DIR")) or Path.cwd() != root / "work"):
        raise RuntimeError("launcher namespace or working directory changed")
    if os.environ.get("TMUX", "").rsplit(",", 2)[0] != str(root / "tmux.sock"):
        raise RuntimeError("launcher is outside the owned tmux server")
    snap = pane_snapshot(root, label)
    if os.environ.get("TMUX_PANE") != snap["pane_id"]:
        raise RuntimeError("launcher pane mismatch")
    owner = proc_identity(os.getpid())
    chain = ancestors(os.getpid(), snap["pane_pid"])
    if not owner or not any(same_process(item, snap["process"]) for item in chain):
        raise RuntimeError("launcher does not descend from measured pane")
    if launch_source(launch) == "resume":
        validate_resume_lineage(root, launch)
        require_new_generation(launch, owner)
        recheck_resume_end(root, launch)
    argv = agent_argv(root, launch)
    # Even the internal launcher is single-use. An exec failure keeps its claim.
    write_once(root / ("exec-claim-" + launch["launch_id"] + ".json"), {"agent_process": owner})
    append(root, {"kind": "harness", "action": "bind_owner", "label": label,
                  "launch_id_hash": identity(launch_id), "agent_process": owner,
                  "session_id_hash": identity(launch["session_id"]), "start_source": launch_source(launch),
                  "directory_identity": launch.get("directory_identity"),
                  "resume_origin": launch.get("resume_origin"),
                  **({"effort": launch_effort(launch)} if "effort" in launch else {}),
                  **({"error_profile_binding": profile} if profile is not None else {}), **snap})
    env = {**os.environ, "DISABLE_AUTOUPDATER": "1", "AB_M1_LAUNCH_ID": launch_id,
           "AB_M1_AGENT_PID": str(os.getpid())}
    if profile is not None:
        env = error_profile_module().environment(root, profile, terminal={
            "TMUX": os.environ.get("TMUX", ""), "TMUX_PANE": os.environ.get("TMUX_PANE", ""),
            "AB_M1_LAUNCH_ID": launch_id, "AB_M1_AGENT_PID": str(os.getpid())})
    os.execve(argv[0], argv, env)


def start_launch(root, launch):
    launch_effort(launch)
    label = launch["label"]
    target = exact_target(label)
    require_owner(root)
    verify_binary()
    profile = verify_launch_profile(root, launch, require_live=True)
    if profile is None and os.environ.get("CLAUDE_CONFIG_DIR"):
        raise RuntimeError("measurement launch requires the normal default namespace")
    if launch["directory_identity"] != directory_binding(root):
        raise RuntimeError("launch directories changed before start")
    write_once(launch_path(root, label), launch)
    action = append(root, {"kind": "harness", "action": "start", "label": label,
                  "launch_id_hash": identity(launch["launch_id"]),
                  "session_id_hash": identity(launch["session_id"]),
                  "launch_mode": "direct",
                  "start_source": launch_source(launch), "directory_identity": launch["directory_identity"],
                  "resume_origin": launch.get("resume_origin"),
                  **({"effort": launch_effort(launch)} if "effort" in launch else {}),
                  **({"error_profile_binding": profile} if profile is not None else {}),
                  "enable_lifecycle": launch["enable_lifecycle"]})
    # No upgrades, editor/MCP integrations, or persisted hook edits for this process.
    launcher = shlex.join(["python3", str(root / Path(__file__).name), "run-agent",
                           "--label", label, "--launch-id", launch["launch_id"]])
    # No interactive shell survives Claude. A check/send race can therefore not
    # reinterpret a delayed synthetic prompt as a shell command after agent exit.
    if launch_source(launch) == "resume":
        recheck_resume_end(root, launch)
    call(["tmux", "-f", "/dev/null", "-S", str(root / "tmux.sock"),
          "new-session", "-d", "-s", label, "-x", "120", "-y", "40",
          "-c", str(root / "work"), "exec " + launcher],
         env=error_profile_module().environment(root, profile) if profile is not None else None)
    tmux(root, "set-option", "-w", "-t", target, "remain-on-exit", "on")
    return {"start_requested": True, "start_seq": action["seq"], "start_source": launch_source(launch),
            **({"effort": launch_effort(launch)} if "effort" in launch else {}),
            "launch_id_hash": identity(launch["launch_id"]),
            "next": "observe must confirm bind_owner before sending input"}


def start(root, label, enable_lifecycle=False, error_profile=False, effort=None):
    if effort is not None:
        launch_effort({"effort": effort})
        if error_profile or require_owner(root).get("error_profile", False):
            raise RuntimeError("explicit effort is only supported by normal starts")
    profile = None
    if error_profile or require_owner(root).get("error_profile", False):
        module = error_profile_module()
        module.require_mode(root, error_profile)
        if enable_lifecycle:
            raise RuntimeError("error profile does not support lifecycle chains")
        profile = module.binding(root)
    launch = {"label": label, "launch_id": uuid.uuid4().hex, "mode": "direct", "start_source": "startup",
              "session_id": str(uuid.uuid4()), "enable_lifecycle": enable_lifecycle,
              "directory_identity": directory_binding(root)}
    if profile is None:
        launch["effort"] = "low" if effort is None else effort
    if profile is not None:
        launch["error_profile_binding"] = profile
        write_once(root / "error-profile" / "client-claim.json",
                   {"launch_id": launch["launch_id"], "profile_id": profile["profile_id"]})
    return start_launch(root, launch)


def pane_snapshot(root, label):
    fmt = "#{pid}|#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_attached}|#{window_bell_flag}|#{window_activity}"
    value = tmux(root, "display-message", "-p", "-t", exact_target(label), fmt).stdout.strip().split("|")
    keys = ("server_pid", "server_start_time", "session_id", "window_id", "pane_id", "pane_pid", "pane_dead", "attached", "bell", "activity")
    if len(value) != len(keys):
        raise RuntimeError("unexpected structured tmux snapshot")
    data = dict(zip(keys, value))
    for key in ("server_pid", "server_start_time", "pane_pid", "pane_dead", "attached", "bell", "activity"):
        data[key] = int(data[key])
    data["process"] = proc_identity(data["pane_pid"])
    return data


def observe(root, label):
    snap = measured_snapshot(root, label)
    # Only the isolated synthetic pane is captured; the capture is not persisted.
    screen = tmux(root, "capture-pane", "-p", "-t", exact_target(label)).stdout
    flags = {"trust_dialog": "trust this folder" in screen.lower() or "trust the files" in screen.lower(),
             "permission_dialog": "Do you want to proceed?" in screen or "Allow this" in screen,
             "interrupted": "Interrupted" in screen,
             "done_text": bool(re.search(r"(?m)^\s*(?:[●⏺]\s*)?DONE\s*$", screen)),
             "denied_text": bool(re.search(r"(?m)^\s*(?:[●⏺]\s*)?DENIED\s*$", screen)),
             "login_required": "Please run /login" in screen or "Select login method" in screen,
             "unknown_option": "unknown option" in screen.lower(),
             "settings_error": "Invalid settings" in screen or "Settings Error" in screen}
    row = append(root, {"kind": "observation", "label": label, **snap, **flags})
    return {"observation": row, "recent_events": [
        {key: event[key] for key in ("seq", "unix_ms", "kind", "event", "notification_type", "action", "source", "reason", "session_id_hash", "launch_id_hash", "agent_id_hash", "background_tasks_count") if key in event}
        for event in [item for item in read_events(root)
                      if item.get("launch_id_hash") == snap["launch_id_hash"]][-12:]]}


def screen(root, label):
    # Explicit diagnostic action, prints only the bottom of our synthetic pane.
    measured_snapshot(root, label)
    value = tmux(root, "capture-pane", "-p", "-t", exact_target(label)).stdout
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[redacted-email]", value)
    return {"synthetic_pane_tail": "\n".join([line for line in value.splitlines() if line.strip()][-12:])}


def send(root, label, prompt, trial=None, case=None):
    # Store an action label/hash, never the prompt. Only callers supply synthetic text.
    snap = measured_snapshot(root, label, require_live=True)
    if trial is not None:
        if not 1 <= trial <= 99 or case not in {"short", "long", "reply"}:
            raise RuntimeError("trial requires a built-in case and a number from 1 to 99")
        # Distinct harmless command text avoids assuming cached permission is a dialog.
        prompt = prompt.replace("_DONE'", f"_DONE_T{trial:02d}'")
    action = append(root, {"kind": "harness", "action": "send_prompt", "label": label,
                  "prompt_hash": identity(prompt), "trial": trial, "case": case,
                  "launch_id_hash": snap["launch_id_hash"], "pane": snap["pane_id"]})
    tmux(root, "send-keys", "-t", exact_target(label), "-l", prompt)
    tmux(root, "send-keys", "-t", exact_target(label), "Enter")
    return {"sent": True, "send_seq": action["seq"]}


def keys(root, label, values):
    allowed = {"Enter", "Escape", "C-c", "C-d", "Up", "Down", "1", "2", "3"}
    if not values or any(value not in allowed for value in values):
        raise RuntimeError("key not in measurement allowlist")
    snap = measured_snapshot(root, label, require_live=True)
    exit_binding = ({"snapshot": snap, "epoch": session_epoch(read_events(root), snap),
                     "server_process": proc_identity(snap["server_pid"])}
                    if values == ["C-c", "C-c"] else None)
    action = append(root, {"kind": "harness", "action": "keys", "label": label, "keys": values,
                          "launch_id_hash": snap["launch_id_hash"], "pane": snap["pane_id"],
                          "exit_binding": exit_binding})
    tmux(root, "send-keys", "-t", exact_target(label), *values)
    return {"sent": True, "key_seq": action["seq"]}


def mark(root, label, observation, context, trial):
    if observation not in MARKS or context not in CONTEXTS or not 1 <= trial <= 99:
        raise RuntimeError("mark requires an allowed observation, context, and trial 1..99")
    snap = measured_snapshot(root, label)
    return append(root, {"kind": "manual_observation", "label": label,
                         "observation": observation, "context": context, "trial": trial,
                         **snap})


def clear_session(root, label):
    launch = read_launch(root, label)
    if launch_source(launch) == "resume":
        raise RuntimeError("clear/resume mixed chains are not supported by this measurement")
    if not launch["enable_lifecycle"]:
        raise RuntimeError("clear requires an explicitly lifecycle-enabled launch")
    # No transcript/session picker; only this running synthetic instance receives /clear.
    return send(root, label, "/clear", case="clear")


def generation(value):
    if not isinstance(value, dict) or not all(type(value.get(key)) is int and value[key] > 0
                                             for key in ("pid", "start_ticks")):
        raise RuntimeError("process generation unavailable")
    return {key: value[key] for key in ("pid", "start_ticks")}


def ended_observation(value, owner):
    return value is None or (isinstance(value, dict) and value.get("state") == "Z"
                             and generation(value) == generation(owner))


def observe_terminated_owner(owner):
    """Read only this owner; a zombie requires a pinned, revalidated ready pidfd."""
    current = proc_identity(owner["pid"])
    if current is None:
        return {"process": None, "pidfd_exit_observed": False}
    if not ended_observation(current, owner):
        raise RuntimeError("previous owner is live, unknown, or replaced")
    if not hasattr(os, "pidfd_open"):
        raise RuntimeError("zombie end observation requires pidfd support")
    try:
        descriptor = os.pidfd_open(owner["pid"])
    except ProcessLookupError:
        if proc_identity(owner["pid"]) is None:
            return {"process": None, "pidfd_exit_observed": False}
        raise RuntimeError("owner changed while opening pidfd") from None
    try:
        current = proc_identity(owner["pid"])
        if not ended_observation(current, owner):
            raise RuntimeError("owner changed after pidfd open")
        poller = select.poll()
        poller.register(descriptor, select.POLLIN)
        ready = poller.poll(0)
        if not ready or any(fd != descriptor or not flags & select.POLLIN
                            or flags & ~(select.POLLIN | select.POLLHUP) for fd, flags in ready):
            raise RuntimeError("previous owner exit not proven by pidfd")
        return {"process": current, "pidfd_exit_observed": True}
    finally:
        os.close(descriptor)


def regular_end_binding(rows, snap, exit_seq, end_seq):
    """Pure normal-exit proof; Stop/clear/hard-kill cannot substitute for it."""
    if not all(type(value) is int and value > 0 for value in (exit_seq, end_seq)) or end_seq <= exit_seq:
        raise RuntimeError("explicit ordered exit and SessionEnd sequences required")
    scoped = [row for row in rows if row.get("launch_id_hash") == snap["launch_id_hash"]]
    if any((row.get("action") == "send_prompt" and row.get("case") == "clear")
           or (row.get("event") == "SessionStart" and row.get("source") == "clear")
           or (row.get("event") == "SessionEnd" and row.get("reason") == "clear") for row in scoped):
        raise RuntimeError("clear/resume mixed chains are not supported by this measurement")
    if any(row.get("action") in {"kill_measured_process", "hard_kill_result"} for row in scoped):
        raise RuntimeError("hard-kill is not a regular resume end")
    exits = [row for row in scoped if row.get("seq") == exit_seq]
    epoch = session_epoch(rows, snap)
    if len(exits) != 1 or not epoch or epoch["session_id_reused"]:
        raise RuntimeError("exit mark or current epoch missing or ambiguous")
    action = exits[0]
    if (action.get("kind") != "harness" or action.get("action") != "keys"
            or action.get("keys") != ["C-c", "C-c"] or action.get("pane") != snap["pane_id"]
            or not action.get("exit_binding")):
        raise RuntimeError("not the explicit normal-exit key mark")
    if any(row.get("seq", 0) > exit_seq and row.get("action") in {"keys", "send_prompt"} for row in scoped):
        raise RuntimeError("input after the selected exit mark")
    before = action["exit_binding"]["snapshot"]
    if (before["agent_alive"] is not True or before["pane_dead"] != 0
            or not same_process(before["process"], before["agent_process"])
            or generation(before["agent_process"]) != generation(snap["agent_process"])
            or before["launch_id_hash"] != snap["launch_id_hash"]
            or before.get("effort") != snap.get("effort")
            or not before.get("directory_identity")
            or before["directory_identity"] != snap.get("directory_identity")
            or action["exit_binding"]["epoch"] != epoch):
        raise RuntimeError("exit key binding changed")
    tmux_keys = ("server_pid", "server_start_time", "session_id", "window_id", "pane_id", "pane_pid")
    if any(before[key] != snap[key] for key in tmux_keys):
        raise RuntimeError("pane/server changed after normal exit")
    if (snap["agent_alive"] is not False or snap["pane_dead"] != 1
            or not ended_observation(snap["process"], snap["agent_process"])
            or not ended_observation(snap["agent_observation"], snap["agent_process"])):
        raise RuntimeError("regular-exit owner is not dead")
    ends = select_wait_events(rows, snap, "SessionEnd", exit_seq)
    if len(ends) != 1 or ends[0]["seq"] != end_seq or ends[0].get("reason") != "prompt_input_exit":
        raise RuntimeError("fresh owned normal SessionEnd missing or ambiguous")
    return {"source_launch_id_hash": snap["launch_id_hash"],
            **({"effort": snap["effort"]} if "effort" in snap else {}),
            "session_id_hash": snap["initial_session_id_hash"], "source_agent_process": generation(snap["agent_process"]),
            "exit_key_seq": exit_seq, "session_end_seq": end_seq, "epoch": epoch,
            "directory_identity": snap["directory_identity"], "tmux": {key: snap[key] for key in tmux_keys},
            "server_process": generation(action["exit_binding"]["server_process"])}


def regular_end_proof(root, label, exit_seq, end_seq):
    began = time.monotonic_ns()
    launch = read_launch(root, label)
    if not launch.get("directory_identity"):
        raise RuntimeError("legacy launch has no resume directory binding")
    snap = measured_snapshot(root, label)
    binding = regular_end_binding(read_events(root), snap, exit_seq, end_seq)
    if (binding["session_id_hash"] != identity(launch["session_id"])
            or binding["epoch"]["session_id_hash"] != identity(launch["session_id"])):
        raise RuntimeError("resume UUID is not the own launch UUID; clear chains unsupported")
    if binding["server_process"] != generation(proc_identity(snap["server_pid"])):
        raise RuntimeError("server process changed after normal exit")
    end = observe_terminated_owner(snap["agent_process"])
    if snap["agent_observation"] is None and end["process"] is not None:
        raise RuntimeError("missing owner reappeared during end proof")
    if launch != read_launch(root, label):
        raise RuntimeError("source launch changed during end proof")
    binding.update(source_label=label,
                   source_launch_sha256=hashlib.sha256(launch_path(root, label).read_bytes()).hexdigest())
    return {"binding": binding, "process_observation": snap["process"],
            "agent_observation": snap["agent_observation"], "confirmed_owner": end,
            "started_monotonic_ns": began, "ended_monotonic_ns": time.monotonic_ns()}


def resume_claim(root, source, launch):
    target = root / ("resume-claim-" + source["launch_id"] + ".json")
    value = {"source_launch_id_hash": identity(source["launch_id"]),
             "successor_launch_id_hash": identity(launch["launch_id"]), "successor_label": launch["label"],
             "session_id_hash": identity(source["session_id"])}
    return target, value


def validate_resume_lineage(root, launch):
    binding = launch["resume_origin"]["binding"]
    source = read_launch(root, binding["source_label"])
    if source.get("effort") != launch.get("effort"):
        raise RuntimeError("resume effort differs from its source launch")
    if (source["session_id"] != launch["session_id"] or source["launch_id"] == launch["launch_id"]
            or binding["source_launch_id_hash"] != identity(source["launch_id"])
            or binding["session_id_hash"] != identity(launch["session_id"])
            or hashlib.sha256(launch_path(root, source["label"]).read_bytes()).hexdigest() != binding["source_launch_sha256"]
            or source.get("directory_identity") != launch["directory_identity"]
            or binding["directory_identity"] != launch["directory_identity"]):
        raise RuntimeError("resume source lineage changed")
    target, expected = resume_claim(root, source, launch)
    if target.is_symlink() or not target.is_file() or json.loads(target.read_text()) != expected:
        raise RuntimeError("resume successor claim missing or different")


def require_new_generation(launch, owner):
    previous = launch["resume_origin"]["binding"]["source_agent_process"]
    if generation(owner) == generation(previous):
        raise RuntimeError("resume did not create a new process generation")


def recheck_resume_end(root, launch):
    validate_resume_lineage(root, launch)
    original = launch["resume_origin"]
    binding = original["binding"]
    current = regular_end_proof(root, binding["source_label"], binding["exit_key_seq"], binding["session_end_seq"])
    if (current["binding"] != binding
            or any(original[key] is None and current[key] is not None
                   for key in ("process_observation", "agent_observation"))
            or (original["confirmed_owner"]["process"] is None
                and current["confirmed_owner"]["process"] is not None)):
        raise RuntimeError("source end binding changed before resume")


def resume(root, source_label, exit_seq, end_seq, label):
    if require_owner(root).get("error_profile", False):
        raise RuntimeError("error profile does not support resume chains")
    exact_target(source_label)
    exact_target(label)
    if label == source_label:
        raise RuntimeError("resume requires a new never-used label")
    if launch_path(root, label).exists() or launch_path(root, label).is_symlink():
        raise RuntimeError("resume label already used")
    source = read_launch(root, source_label)
    proof = regular_end_proof(root, source_label, exit_seq, end_seq)
    launch = {"label": label, "launch_id": uuid.uuid4().hex, "mode": "direct", "start_source": "resume",
              "session_id": source["session_id"], "enable_lifecycle": False,
              "directory_identity": source["directory_identity"], "resume_origin": proof}
    if "effort" in source:
        launch["effort"] = launch_effort(source)
    target, claim = resume_claim(root, source, launch)
    write_once(target, claim)
    return start_launch(root, launch)


def pidfd_kill_and_observe(owner, before_signal):
    """Pin, revalidate, signal, and observe exit; never reap a non-child.

    before_signal runs while the pidfd is held. The three-second observation
    budget starts after signal delivery; it is not a whole-helper deadline.
    """
    # pidfd pins the actual bound agent across PID reuse. No PID-only fallback.
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("hard-kill needs Linux pidfd support; no PID-only fallback")
    descriptor = os.pidfd_open(owner["pid"])
    try:
        if not same_process(owner, proc_identity(owner["pid"])):
            raise RuntimeError("agent process generation changed")
        poller = select.poll()
        poller.register(descriptor, select.POLLIN)
        if poller.poll(0):
            raise RuntimeError("process already ended before hard-kill")
        context = before_signal()
        if not same_process(owner, proc_identity(owner["pid"])):
            raise RuntimeError("agent process generation changed before signal")
        if poller.poll(0):
            raise RuntimeError("process ended during hard-kill prebinding")
        result = {"signal": "SIGKILL", "signal_sent": False,
                  "pidfd_exit_observed": False, "pidfd_ready_before_signal": False,
                  "signal_attempt_monotonic_ns": time.monotonic_ns(),
                  "non_child_reap_attempted": False}
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            result["signal_sent"] = True
            result["signal_sent_monotonic_ns"] = time.monotonic_ns()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                ready = poller.poll(max(1, int((deadline - time.monotonic()) * 1000 + 0.999)))
                if ready:
                    if any(fd != descriptor or not flags & select.POLLIN
                           or flags & ~(select.POLLIN | select.POLLHUP) for fd, flags in ready):
                        raise RuntimeError("unexpected pidfd poll event")
                    result["pidfd_exit_observed"] = True
                    result["pidfd_exit_observed_monotonic_ns"] = time.monotonic_ns()
                    break
        except (OSError, RuntimeError):
            result["signal_or_observation_error"] = True
        result["observation_ended_monotonic_ns"] = time.monotonic_ns()
        return context, result
    finally:
        os.close(descriptor)


def hard_kill(root, label):
    owner = measured_snapshot(root, label, require_live=True)["agent_process"]

    def bind_before_signal():
        began = time.monotonic_ns()
        checksum = verify_binary()
        binary = BINARY.stat()
        executable = os.stat(f'/proc/{owner["pid"]}/exe')
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
        if any(getattr(binary, key) != getattr(executable, key) for key in fields):
            raise RuntimeError("bound agent is not the pinned measurement binary")
        snap = measured_snapshot(root, label, require_live=True)
        if not same_process(owner, snap["agent_process"]):
            raise RuntimeError("agent binding changed before hard-kill")
        epoch = session_epoch(read_events(root), snap)
        if not epoch or epoch["session_id_reused"]:
            raise RuntimeError("current session epoch unavailable or reused")
        server = proc_identity(snap["server_pid"])
        if not server:
            raise RuntimeError("server process unavailable before hard-kill")
        return append(root, {"kind": "harness", "action": "kill_measured_process", "label": label,
                             "launch_id_hash": snap["launch_id_hash"],
                             "pid": owner["pid"], "start_ticks": owner["start_ticks"],
                             "binding_started_monotonic_ns": began,
                             "binding_before": snap, "server_process": server,
                             "session_epoch": epoch, "agent_binary_sha256": checksum})

    attempt, result = pidfd_kill_and_observe(owner, bind_before_signal)
    recorded = append(root, {"kind": "harness", "action": "hard_kill_result", "label": label,
                             "launch_id_hash": attempt["launch_id_hash"],
                             "attempt_seq": attempt["seq"], "pid": owner["pid"],
                             "start_ticks": owner["start_ticks"], **result})
    return {"attempt_seq": attempt["seq"], "result_seq": recorded["seq"],
            "signal_sent": result["signal_sent"],
            "pidfd_exit_observed": result["pidfd_exit_observed"],
            "non_child_reap_attempted": False}


def cleanup(root):
    require_owner(root)
    if require_owner(root).get("error_profile", False):
        error_profile_module().cleanup_guard(root)
    listed = tmux(root, "list-panes", "-a", "-F", "#{pane_pid}", check=False)
    pane_owners = [proc_identity(int(line)) for line in listed.stdout.splitlines() if line.isdigit()]
    agent_owners = [row["agent_process"] for row in read_events(root)
                    if row.get("action") == "bind_owner"]
    result = tmux(root, "kill-server", check=False)
    if result.returncode and (root / "tmux.sock").exists():
        raise RuntimeError("test server cleanup failed; directory preserved")
    deadline = time.monotonic() + 3
    while any(owner and same_process(proc_identity(owner["pid"]), owner)
              for owner in pane_owners + agent_owners):
        if time.monotonic() > deadline:
            raise RuntimeError("test pane process still alive; directory preserved")
        time.sleep(0.1)
    # Check only processes matching our synthetic marker, then require our exact cwd.
    candidates = call(["pgrep", "-f", "M1_(SHORT|LONG)_DONE"], check=False)
    if candidates.returncode not in (0, 1):
        raise RuntimeError("test child check failed; directory preserved")
    for value in candidates.stdout.splitlines():
        if not value.isdigit():
            continue
        try:
            if Path(f"/proc/{value}/cwd").resolve(strict=True) == root / "work":
                raise RuntimeError("synthetic child still alive; directory preserved")
        except (FileNotFoundError, PermissionError):
            continue
    # Never recurse outside the validated /tmp directory with the ownership marker.
    if root_dir() != root:
        raise RuntimeError("cleanup target changed")
    shutil.rmtree(root)
    return {"removed_test_directory": str(root), "tmux_exit": result.returncode,
            "synthetic_children_remaining": 0, "directory_exists": root.exists(),
            "socket_exists": (root / "tmux.sock").exists()}


def export(root):
    require_owner(root)
    return {"environment": json.loads((root / "environment.json").read_text()),
            "events": read_events(root)}


def fresh_owned_hook(row, snap, minimum):
    began = row.get("recorder_started_monotonic_ns")
    return (row.get("kind") == "hook" and row.get("pane") == snap["pane_id"]
            and isinstance(began, int) and minimum <= began <= row.get("monotonic_ns", -1)
            and any(same_process(item, snap["agent_process"])
                    for item in row.get("recorder_ancestors", [])))


def session_epoch(rows, snap):
    """The existing waiter selector, shared with live/dead CLI measurements.

    Clear intent is a boundary even without its SessionStart. No raw UUID or
    registry lookup is needed. Reused hashes are metadata, not a new waiter rule.
    """
    launch = snap["launch_id_hash"]
    scoped = [row for row in rows if row.get("launch_id_hash") == launch]
    starts = [row for row in scoped if row.get("kind") == "harness"
              and row.get("action") == "start"]
    if len(starts) != 1:
        return None
    expected_source = snap.get("start_source", "startup")
    if (expected_source not in {"startup", "resume"}
            or starts[0].get("start_source", "startup") != expected_source):
        return None
    clears = [row for row in scoped if row.get("kind") == "harness"
              and row.get("action") == "send_prompt" and row.get("case") == "clear"]
    boundary = clears[-1] if clears else starts[0]
    if expected_source == "resume" and (clears or any(
            (row.get("event") == "SessionStart" and row.get("source") == "clear")
            or (row.get("event") == "SessionEnd" and row.get("reason") == "clear") for row in scoped)):
        return None

    # A clear request is a boundary even when its SessionStart is delayed/missing.
    # An old startup writer cannot select the previous UUID again. More than one
    # eligible start is ambiguous, including duplicate callbacks for one UUID.
    session_starts = [row for row in scoped if row.get("event") == "SessionStart"
                      and not row.get("agent_id_hash")
                      and row.get("source") == ("clear" if clears else expected_source)
                      and isinstance(row.get("session_id_hash"), str)
                      and fresh_owned_hook(row, snap, boundary["monotonic_ns"])]
    if len(session_starts) != 1:
        return None
    current = session_starts[0]
    if not clears and current["session_id_hash"] != snap["initial_session_id_hash"]:
        return None
    reused = bool(clears and any(
        row.get("event") == "SessionStart" and not row.get("agent_id_hash")
        and row.get("session_id_hash") == current["session_id_hash"]
        and row.get("seq", 0) < boundary["seq"]
        and fresh_owned_hook(row, snap, starts[0]["monotonic_ns"])
        for row in scoped))
    return {"session_id_hash": current["session_id_hash"], "source": current["source"],
            "session_start_seq": current["seq"],
            "recorder_started_monotonic_ns": current["recorder_started_monotonic_ns"],
            "boundary_seq": boundary["seq"], "boundary_monotonic_ns": boundary["monotonic_ns"],
            "session_id_reused": reused}


def select_wait_events(rows, snap, event, after):
    """Reject known stale/ambiguous writers; write order is not session order."""
    epoch = session_epoch(rows, snap)
    if epoch is None:
        return []
    scoped = [row for row in rows if row.get("launch_id_hash") == snap["launch_id_hash"]]
    anchor = (next((row for row in rows if row.get("seq") == after), None) if after else
              next(row for row in scoped if row.get("kind") == "harness" and row.get("action") == "start"))
    if anchor is None:
        return []
    sends = [row for row in scoped if row.get("kind") == "harness"
             and row.get("action") == "send_prompt"]
    minimum = max(anchor["monotonic_ns"], epoch["boundary_monotonic_ns"],
                  epoch["recorder_started_monotonic_ns"],
                  sends[-1]["monotonic_ns"] if sends else 0)
    return [row for row in scoped if row.get("seq", 0) > after and row.get("event") == event
            and row.get("session_id_hash") == epoch["session_id_hash"]
            and fresh_owned_hook(row, snap, minimum)
            and (not row.get("agent_id_hash") or event in {"SubagentStart", "SubagentStop"})]


def wait_event(root, label, event, after, seconds):
    if event not in EVENTS or not 0 < seconds <= 45:
        raise RuntimeError("invalid bounded event wait")
    snap = measured_snapshot(root, label)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        matches = select_wait_events(read_events(root), snap, event, after)
        if matches:
            return {"matched": matches[-1]}
        time.sleep(0.1)
    return {"matched": None, "timeout_seconds": seconds}


def waiter_selftest():
    """Pure fixtures: no process, socket, filesystem, or agent access."""
    owner = {"pid": 102, "ppid": 101, "start_ticks": 6}
    snap = {"launch_id_hash": "b" * 16, "pane_id": "%0", "agent_process": owner,
            "initial_session_id_hash": "a" * 16}
    rows = []

    def add(**values):
        row = {"seq": len(rows) + 1, "monotonic_ns": 1000 + len(rows),
               "launch_id_hash": snap["launch_id_hash"], **values}
        if row.get("kind") == "hook":
            row = {"pane": "%0", "recorder_ancestors": [owner],
                   "recorder_started_monotonic_ns": row["monotonic_ns"], **row}
        rows.append(row)
        return row

    add(kind="harness", action="start")
    startup = add(kind="hook", event="SessionStart", source="startup", session_id_hash="a" * 16)
    prompt = add(kind="harness", action="send_prompt", case="short")
    old_stop = add(kind="hook", event="Stop", session_id_hash="a" * 16)
    assert select_wait_events(rows, snap, "Stop", prompt["seq"]) == [old_stop]
    clear = add(kind="harness", action="send_prompt", case="clear")
    assert select_wait_events(rows, snap, "Stop", prompt["seq"]) == []
    cleared = add(kind="hook", event="SessionStart", source="clear", session_id_hash="c" * 16)
    # Earlier callback appended after the clear must not restore the old session.
    add(**{**startup, "seq": len(rows) + 1, "monotonic_ns": 1000 + len(rows)})
    add(**{**old_stop, "seq": len(rows) + 1, "monotonic_ns": 1000 + len(rows)})
    assert select_wait_events(rows, snap, "Stop", clear["seq"]) == []
    assert select_wait_events(rows, snap, "SessionStart", clear["seq"]) == [cleared]
    current_stop = add(kind="hook", event="Stop", session_id_hash="c" * 16)
    assert select_wait_events(rows, snap, "Stop", clear["seq"]) == [current_stop]
    assert select_wait_events(rows, {**snap, "launch_id_hash": "d" * 16}, "Stop", clear["seq"]) == []
    assert select_wait_events(rows, {**snap, "pane_id": "%1"}, "Stop", clear["seq"]) == []
    assert select_wait_events(rows, {**snap, "agent_process": {**owner, "start_ticks": 7}}, "Stop", clear["seq"]) == []
    # A current-session callback started before the next prompt is still stale.
    next_prompt = add(kind="harness", action="send_prompt", case="short")
    add(**{**current_stop, "seq": len(rows) + 1, "monotonic_ns": 1000 + len(rows)})
    assert select_wait_events(rows, snap, "Stop", next_prompt["seq"]) == []
    valid = add(kind="hook", event="Stop", session_id_hash="c" * 16)
    assert select_wait_events(rows, snap, "Stop", next_prompt["seq"]) == [valid]
    valid["recorder_ancestors"] = []
    assert select_wait_events(rows, snap, "Stop", next_prompt["seq"]) == []
    valid["recorder_ancestors"] = [owner]
    valid.pop("recorder_started_monotonic_ns")
    assert select_wait_events(rows, snap, "Stop", next_prompt["seq"]) == []
    valid["recorder_started_monotonic_ns"] = valid["monotonic_ns"]
    add(kind="hook", event="SessionStart", source="clear", session_id_hash="e" * 16)
    assert select_wait_events(rows, snap, "Stop", next_prompt["seq"]) == []
    return {"checks": 13, "scope": "pure waiter fixtures"}


def resume_selftest():
    """Pure binding cases and own temporary claim files; no tmux/agent execution."""
    from unittest.mock import patch

    checks = []

    def check(name, value):
        assert value, name
        checks.append(name)

    def rejects(action):
        try:
            action()
        except (OSError, RuntimeError, ValueError, KeyError):
            return True
        return False

    owner = {"pid": 123, "start_ticks": 456, "state": "S"}
    directories = {"root": {"dev": 1, "ino": 2, "uid": 3}, "work": {"dev": 1, "ino": 4, "uid": 3}}
    live = {"server_pid": 9, "server_start_time": 10, "session_id": "$0", "window_id": "@0",
            "pane_id": "%0", "pane_pid": 123, "process": owner, "agent_process": owner,
            "agent_observation": owner, "agent_alive": True, "pane_dead": 0, "launch_mode": "direct",
            "launch_id_hash": "b" * 16, "initial_session_id_hash": "a" * 16,
            "start_source": "startup", "directory_identity": directories}
    rows = [{"seq": 1, "monotonic_ns": 101, "kind": "harness", "action": "start", "start_source": "startup"},
            {"seq": 2, "monotonic_ns": 102, "kind": "hook", "event": "SessionStart", "source": "startup",
             "session_id_hash": "a" * 16, "pane": "%0", "recorder_started_monotonic_ns": 102,
             "recorder_ancestors": [owner]}]
    rows = [{"launch_id_hash": live["launch_id_hash"], **row} for row in rows]
    epoch = session_epoch(rows, live)
    key = {"seq": 3, "monotonic_ns": 103, "kind": "harness", "action": "keys", "keys": ["C-c", "C-c"],
           "launch_id_hash": live["launch_id_hash"], "pane": "%0",
           "exit_binding": {"snapshot": live, "epoch": epoch, "server_process": {"pid": 9, "start_ticks": 10}}}
    end = {**rows[1], "seq": 4, "monotonic_ns": 104, "recorder_started_monotonic_ns": 104,
           "event": "SessionEnd", "reason": "prompt_input_exit"}
    rows += [key, end]
    dead = {**live, "process": None, "agent_observation": None, "agent_alive": False, "pane_dead": 1}
    binding = regular_end_binding(rows, dead, 3, 4)
    check("normal_end_requires_owned_exit_and_hook", binding["exit_key_seq"] == 3 and binding["session_end_seq"] == 4)
    for name, altered in (
            ("missing_end", rows[:-1]),
            ("old_writer", rows[:-1] + [{**end, "recorder_started_monotonic_ns": 102}]),
            ("wrong_reason", rows[:-1] + [{**end, "reason": "clear"}]),
            ("wrong_uuid", rows[:-1] + [{**end, "session_id_hash": "c" * 16}]),
            ("wrong_launch", rows[:-1] + [{**end, "launch_id_hash": "c" * 16}]),
            ("duplicate_end", rows + [{**end, "seq": 5}]),
            ("not_exit_keys", rows[:2] + [{**key, "keys": ["Escape"]}, end]),
            ("hard_kill", rows + [{"seq": 5, "launch_id_hash": live["launch_id_hash"], "action": "kill_measured_process"}]),
            ("clear_request", rows + [{"seq": 5, "launch_id_hash": live["launch_id_hash"], "action": "send_prompt", "case": "clear"}])):
        check("normal_end_rejects_" + name, rejects(lambda: regular_end_binding(altered, dead, 3, 4)))
    for name, value in (("pane_id", "%1"), ("server_pid", 10), ("agent_alive", True),
                        ("agent_process", {**owner, "start_ticks": 457}), ("directory_identity", {})):
        check("normal_end_rejects_changed_" + name,
              rejects(lambda: regular_end_binding(rows, {**dead, name: value}, 3, 4)))
    new_owner = {"pid": 124, "start_ticks": 789, "state": "S"}
    resumed = {**live, "launch_id_hash": "c" * 16, "start_source": "resume", "agent_process": new_owner}
    resumed_rows = [{**rows[0], "seq": 5, "monotonic_ns": 105, "launch_id_hash": "c" * 16, "start_source": "resume"},
                    {**rows[1], "seq": 6, "monotonic_ns": 106, "recorder_started_monotonic_ns": 106,
                     "launch_id_hash": "c" * 16, "source": "resume", "recorder_ancestors": [new_owner]}]
    resumed_epoch = session_epoch(rows + resumed_rows, resumed)
    check("resume_preserves_uuid_in_new_launch", resumed_epoch["session_id_hash"] == "a" * 16
          and resumed_epoch["source"] == "resume" and not resumed_epoch["session_id_reused"])
    for name, changes in (("startup_fallback", {"source": "startup"}), ("wrong_uuid", {"session_id_hash": "d" * 16}),
                          ("old_owner", {"recorder_ancestors": [owner]})):
        check("resume_hook_rejects_" + name,
              session_epoch(resumed_rows[:1] + [{**resumed_rows[1], **changes}], resumed) is None)
    check("resume_ignores_late_old_launch_writer", session_epoch(
        rows + resumed_rows + [{**end, "seq": 7, "monotonic_ns": 107}], resumed) == resumed_epoch)
    check("resume_rejects_clear_hook", session_epoch(resumed_rows + [
        {**resumed_rows[1], "seq": 7, "source": "clear"}], resumed) is None)
    resumed_launch = {"start_source": "resume", "session_id": "00000000-0000-4000-8000-000000000001",
                      "enable_lifecycle": False, "resume_origin": {"binding": binding}}
    args = agent_argv(Path("/tmp/ab-m1-hooks-selftest00"), resumed_launch)
    check("resume_argv_is_explicit_uuid_only", args[args.index("--resume") + 1] == resumed_launch["session_id"]
          and not any(flag in args for flag in ("--session-id", "--continue", "--fork-session")))
    check("resume_rejects_same_process_generation", rejects(lambda: require_new_generation(resumed_launch, owner)))
    require_new_generation(resumed_launch, new_owner)

    zombie = {**owner, "state": "Z"}
    for name, current, ready in (("wrong_ticks", {**zombie, "start_ticks": 457}, [(23, select.POLLIN)]),
                                 ("not_ready", zombie, [])):
        observations = [zombie, current]
        with patch.dict(globals(), proc_identity=lambda _pid: observations.pop(0)), patch.object(os, "pidfd_open", return_value=23), \
                patch.object(os, "close"), patch.object(select, "poll") as polling:
            polling.return_value.poll.return_value = ready
            check("regular_end_pidfd_rejects_" + name, rejects(lambda: observe_terminated_owner(owner)))
    with patch.dict(globals(), proc_identity=lambda _pid: zombie), patch.object(os, "pidfd_open", return_value=23), \
            patch.object(os, "close"), patch.object(select, "poll") as polling:
        polling.return_value.poll.return_value = [(23, select.POLLIN)]
        check("regular_end_pidfd_accepts_original_zombie", observe_terminated_owner(owner)["pidfd_exit_observed"])

    root = Path("/tmp") / ("ab-m1-hooks-resume-selftest-" + uuid.uuid4().hex)
    root.mkdir(mode=0o700)
    actual_dirs = None
    try:
        (root / "work").mkdir()
        (root / "owner.json").write_text(json.dumps({"harness": HARNESS, "root": str(root)}))
        actual_dirs = directory_binding(root)
        source = {"label": "initial", "mode": "direct", "launch_id": "1" * 32, "start_source": "startup",
                  "session_id": resumed_launch["session_id"], "enable_lifecycle": False, "directory_identity": actual_dirs}
        write_once(launch_path(root, "initial"), source)
        proof = {"binding": {**binding, "source_label": "initial", "source_launch_id_hash": identity(source["launch_id"]),
                             "source_launch_sha256": hashlib.sha256(launch_path(root, "initial").read_bytes()).hexdigest(),
                             "session_id_hash": identity(source["session_id"]), "directory_identity": actual_dirs},
                 "process_observation": None, "agent_observation": None,
                 "confirmed_owner": {"process": None, "pidfd_exit_observed": False}}

        def fail_tmux(*_args, **_kwargs):
            raise RuntimeError("synthetic tmux failure")

        with patch.dict(globals(), regular_end_proof=lambda *_args: proof, recheck_resume_end=lambda *_args: None,
                        verify_binary=lambda: BINARY_SHA256), patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": ""}), \
                patch.dict(globals(), call=fail_tmux):
            check("failed_tmux_start_is_failure", rejects(lambda: resume(root, "initial", 3, 4, "resumed-one")))
            successor = read_launch(root, "resumed-one")
            claim_path, _claim = resume_claim(root, source, successor)
            check("failed_start_keeps_marker_and_claim", claim_path.is_file() and launch_path(root, "resumed-one").is_file())
            check("different_label_cannot_retry_same_source", rejects(lambda: resume(root, "initial", 3, 4, "resumed-two"))
                  and not launch_path(root, "resumed-two").exists())
        validate_resume_lineage(root, successor)
        check("lineage_rejects_wrong_uuid", rejects(lambda: validate_resume_lineage(
            root, {**successor, "session_id": "00000000-0000-4000-8000-000000000002"})))
        for directory_name in ("root", "work"):
            for field in ("dev", "ino", "uid"):
                changed = {**actual_dirs, directory_name: {**actual_dirs[directory_name], field: actual_dirs[directory_name][field] + 1}}
                with patch.dict(globals(), directory_binding=lambda _root: changed):
                    check("rejects_changed_" + directory_name + "_" + field, rejects(lambda: read_launch(root, "initial")))
    finally:
        # Only this fresh UUID root, with its unchanged recorded directory IDs.
        if actual_dirs is None or directory_binding(root) != actual_dirs:
            raise RuntimeError("synthetic resume root changed; retained")
        shutil.rmtree(root)
    return {"checks": len(checks), "checks_passed": True, "names": checks}


def selftest():
    from unittest.mock import patch

    waiter = waiter_selftest()
    resume_checks = resume_selftest()
    effort_checks = effort_selftest()
    sentinel = "MUST_NOT_LEAK_USER_CONTENT"
    source = {"hook_event_name": "Stop", "session_id": "synthetic-session", "prompt": sentinel,
              "message": sentinel, "transcript_path": sentinel, "tool_input": {"command": sentinel},
              "last_assistant_message": sentinel, "error": sentinel,
              "background_tasks": [{"description": sentinel}], "session_crons": [],
              "stop_hook_active": False}
    result = sanitize(source)
    assert sentinel not in json.dumps(result)
    assert result["background_tasks_count"] == 1 and result["error"] == "other"
    assert result["stop_hook_active"] is False
    try:
        sanitize({"hook_event_name": sentinel})
    except ValueError:
        pass
    else:
        raise AssertionError("unknown event accepted")
    owner = {"pid": 123, "ppid": 5, "start_ticks": 77}
    assert same_process(owner, {**owner, "ppid": 1})
    assert not same_process(owner, {**owner, "start_ticks": 78})
    assert not same_process(owner, None)
    assert not same_process({"pid": 123}, {"pid": 123})
    assert process_alive(owner, {**owner, "state": "S"})
    assert not process_alive(owner, {**owner, "state": "Z"})
    assert not process_alive(owner, {**owner, "state": "?"})
    assert not process_alive(owner, {**owner, "state": "S", "start_ticks": 78})
    for raw in ("123 (synthetic) Z invalid", "123 (synthetic) Z 1"):
        with patch.object(Path, "read_text", return_value=raw):
            try:
                proc_identity(123)
            except RuntimeError:
                pass
            else:
                raise AssertionError("process parse error was treated as absence")
    with patch.object(Path, "read_text", side_effect=PermissionError):
        try:
            proc_identity(123)
        except PermissionError:
            pass
        else:
            raise AssertionError("process read error was treated as absence")
    with patch.object(Path, "read_text", side_effect=FileNotFoundError):
        assert proc_identity(123) is None
    try:
        sanitize({"hook_event_name": [sentinel]})
    except ValueError:
        pass
    else:
        raise AssertionError("non-string event accepted")
    launch = {"session_id": "00000000-0000-4000-8000-000000000001",
              "enable_lifecycle": False}
    argv = agent_argv(Path("/tmp/ab-m1-hooks-selftest00"), launch)
    assert argv[0] == str(BINARY)
    assert "--session-id" in argv and "--resume" not in argv
    assert "--disable-slash-commands" in argv
    argv = agent_argv(Path("/tmp/ab-m1-hooks-selftest00"),
                      {**launch, "enable_lifecycle": True})
    assert "--session-id" in argv and "--resume" not in argv
    assert "--disable-slash-commands" not in argv
    with tempfile.TemporaryDirectory(prefix="ab-m1-binary-selftest-") as directory:
        binary = Path(directory) / "synthetic-binary"
        binary.write_bytes(b"synthetic pinned bytes; never executed")
        checksum = hashlib.sha256(binary.read_bytes()).hexdigest()
        assert verify_binary(binary, checksum) == checksum
        binary.write_bytes(b"replaced bytes; never executed")
        try:
            verify_binary(binary, checksum)
        except RuntimeError:
            pass
        else:
            raise AssertionError("replaced binary was accepted")
        link = Path(directory) / "mutable-launcher"
        link.symlink_to(binary)
        try:
            verify_binary(link, hashlib.sha256(binary.read_bytes()).hexdigest())
        except RuntimeError:
            pass
        else:
            raise AssertionError("mutable binary symlink was accepted")
    return {"sanitizer_checks": "passed", "process_generation_checks": "passed",
            "launch_argument_checks": "passed", "pinned_binary_checks": 3,
            "waiter": waiter, "resume": resume_checks, "effort": effort_checks}


def effort_selftest():
    """Pure effort/argument/provenance tests; no files, commands or agents."""
    from contextlib import redirect_stderr
    from io import StringIO
    from unittest.mock import patch

    checks = []
    def check(name, passed):
        if not passed:
            raise AssertionError(name)
        checks.append(name)

    def rejects(function):
        try:
            function()
        except RuntimeError:
            return True
        return False

    root = Path("/tmp/ab-m1-hooks-effort-selftest00")
    legacy = {"label": "initial", "launch_id": "1" * 32, "mode": "direct",
              "session_id": "00000000-0000-4000-8000-000000000001", "enable_lifecycle": False}
    base = agent_argv(root, legacy)
    index = base.index("--effort") + 1
    check("legacy_argv_remains_low", base[index] == "low")
    check("explicit_low_argv_unchanged", agent_argv(root, {**legacy, "effort": "low"}) == base)
    high = {**legacy, "effort": "high"}
    changed = agent_argv(root, high)
    check("high_changes_only_effort_argument", changed == base[:index] + ["high"] + base[index + 1:])
    profile = {**legacy, "error_profile_binding": {"synthetic": True}}
    profile_args = agent_argv(root, profile)
    check("error_profile_still_low_and_toolless", profile_args[index] == "low"
          and profile_args[profile_args.index("--tools") + 1] == "")
    check("error_profile_cannot_encode_high", rejects(lambda: agent_argv(root, {**profile, "effort": "high"})))
    for n, value in enumerate(("medium", "max", "LOW", "", None, True, 1, [], {})):
        check("invalid_effort_" + str(n), rejects(lambda: launch_effort({"effort": value})))

    start_row = {"action": "start", "launch_id_hash": identity(legacy["launch_id"])}
    verify_effort_start([start_row], legacy)
    verify_effort_start([{**start_row, "effort": "high"}], high)
    check("legacy_and_high_start_bindings", True)
    for name, rows, launch in (
            ("missing", [], high), ("duplicate", [start_row, start_row], legacy),
            ("wrong_launch", [{**start_row, "launch_id_hash": "2" * 16}], legacy),
            ("changed", [{**start_row, "effort": "low"}], high),
            ("removed", [{**start_row, "effort": "high"}], legacy),
            ("added_to_legacy", [start_row], high)):
        check("start_effort_rejects_" + name, rejects(lambda: verify_effort_start(rows, launch)))

    with patch.dict(globals(), require_owner=lambda _root: {}, directory_binding=lambda _root: {},
                    start_launch=lambda _root, launch: launch):
        check("normal_start_default_is_recorded_low", start(root, "initial")["effort"] == "low")
        check("normal_start_records_explicit_high", start(root, "initial", effort="high")["effort"] == "high")
        check("normal_start_records_explicit_low", start(root, "initial", effort="low")["effort"] == "low")
        check("invalid_start_rejected", rejects(lambda: start(root, "initial", effort="medium")))
        for value in ("low", "high"):
            check("explicit_profile_rejects_" + value,
                  rejects(lambda: start(root, "initial", error_profile=True, effort=value)))
        with patch.dict(globals(), require_owner=lambda _root: {"error_profile": True}):
            check("owned_profile_rejects_effort_override", rejects(lambda: start(root, "initial", effort="high")))

    for source in (legacy, {**legacy, "effort": "low"}, high):
        with patch.dict(globals(), require_owner=lambda _root: {}, read_launch=lambda *_args: source,
                        regular_end_proof=lambda *_args: {}, write_once=lambda *_args: None,
                        start_launch=lambda _root, launch: launch), \
                patch.object(Path, "exists", return_value=False), patch.object(Path, "is_symlink", return_value=False):
            source = {**source, "directory_identity": {}}
            successor = resume(root, "initial", 3, 4, "resumed")
            check("resume_inherits_" + source.get("effort", "historical_low"),
                  successor.get("effort") == source.get("effort")
                  and ("effort" in successor) == ("effort" in source)
                  and launch_effort(successor) == launch_effort(source))
        with patch.dict(globals(), read_launch=lambda *_args: source):
            altered = {**successor, "effort": "low" if launch_effort(source) == "high" else "high",
                       "resume_origin": {"binding": {"source_label": "initial"}}}
            check("resume_rejects_changed_" + source.get("effort", "historical_low"),
                  rejects(lambda: validate_resume_lineage(root, altered)))

    bound = {"action": "bind_owner", "launch_id_hash": identity(high["launch_id"]), "effort": "high"}
    with patch.dict(globals(), read_launch=lambda *_args: high,
                    read_events=lambda _root: [{**start_row, "effort": "high"}, bound]):
        check("bound_owner_preserves_high", bound_owner(root, "initial")[0]["effort"] == "high")
        for value in (None, "low"):
            bound["effort"] = value
            check("bound_owner_rejects_" + str(value), rejects(lambda: bound_owner(root, "initial")))

    owner = {"pid": 123, "ppid": 9, "start_ticks": 456, "state": "R"}
    reservation = {**start_row, "effort": "high"}
    written, recorded = [], []
    with patch.dict(globals(), read_launch=lambda *_args: high, read_events=lambda _root: [reservation],
                    verify_binary=lambda: BINARY_SHA256, verify_launch_profile=lambda *_args, **_kwargs: None,
                    pane_snapshot=lambda *_args: {"pane_id": "%0", "pane_pid": 123, "process": owner},
                    proc_identity=lambda _pid: owner, ancestors=lambda *_args: [owner],
                    write_once=lambda *args: written.append(args), append=lambda _root, row: recorded.append(row)), \
            patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": "", "TMUX": str(root / "tmux.sock") + ",9,0", "TMUX_PANE": "%0"}), \
            patch.object(Path, "cwd", return_value=root / "work"), patch.object(os, "getpid", return_value=123), \
            patch.object(os, "execve") as execute:
        run_agent(root, "initial", high["launch_id"])
        check("launcher_binds_and_executes_same_high_argv", execute.call_args.args[1] == changed
              and len(written) == len(recorded) == 1 and recorded[0]["effort"] == "high")
        reservation["effort"] = "low"
        execute.reset_mock()
        check("changed_reservation_rejected_before_claim_or_exec",
              rejects(lambda: run_agent(root, "initial", high["launch_id"]))
              and not execute.called and len(written) == len(recorded) == 1)

    for argv in (("resume", "--effort", "high"), ("init", "--effort", "low"),
                 ("start", "--error-profile", "--effort", "high"), ("start", "--effort", "medium")):
        with patch.object(sys, "argv", ["m1-claude-hooks.py", *argv]), redirect_stderr(StringIO()):
            try:
                main()
            except SystemExit as error:
                check("cli_rejects_" + "_".join(argv), error.code == 2)
            else:
                raise AssertionError("invalid effort CLI accepted")
    return {"checks": len(checks), "checks_passed": True, "names": checks,
            "filesystem_or_agent_started": False}


def hard_kill_selftest():
    """Only a fixed Python child: exercise the actual pidfd signal/exit path.

    The production helper never reaps the tmux-owned Claude process. Here the
    test owns the Popen child and explicitly waits for it after the pidfd proof.
    """
    report = {"kind": "hard_kill_pidfd_selftest", "checks_passed": False}
    child = subprocess.Popen(
        [sys.executable, "-I", "-S", "-c",
         "import time; print('ready', flush=True); time.sleep(30)"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        ready = select.poll()
        ready.register(child.stdout.fileno(), select.POLLIN)
        if not ready.poll(3000) or os.read(child.stdout.fileno(), 16) != b"ready\n":
            raise RuntimeError("synthetic child did not reach its wait")
        owner = proc_identity(child.pid)
        if not owner or child.poll() is not None:
            raise RuntimeError("synthetic owner unavailable")
        rejected = False
        try:
            pidfd_kill_and_observe({**owner, "start_ticks": owner["start_ticks"] + 1},
                                   lambda: None)
        except RuntimeError:
            rejected = True
        report["wrong_generation_rejected_while_child_alive"] = rejected and child.poll() is None

        def before_signal():
            if not same_process(owner, proc_identity(child.pid)) or child.poll() is not None:
                raise RuntimeError("synthetic prebinding lost")
            return {"pid": owner["pid"], "start_ticks": owner["start_ticks"],
                    "bound_monotonic_ns": time.monotonic_ns()}

        binding, result = pidfd_kill_and_observe(owner, before_signal)
        report["binding_before"] = binding
        report["signal_and_exit"] = result
        zombie = proc_identity(child.pid)
        report["unreaped_process_observation"] = zombie
        report["unreaped_zombie_not_live"] = bool(
            same_process(owner, zombie) and zombie.get("state") == "Z"
            and not process_alive(owner, zombie))
        report["resume_end_observation"] = observe_terminated_owner(owner)
        # This join occurs only after the tested routine returned its independent
        # pidfd observation, so wait()/task teardown cannot manufacture that proof.
        report["owned_child_exit_code"] = child.wait(timeout=3)
        report["owned_child_joined"] = True
        report["joined_process_observation"] = proc_identity(child.pid)
        report["checks_passed"] = bool(
            report["wrong_generation_rejected_while_child_alive"]
            and report["unreaped_zombie_not_live"]
            and report["resume_end_observation"]["pidfd_exit_observed"]
            and report["joined_process_observation"] is None
            and result["signal_sent"] and result["pidfd_exit_observed"]
            and not result.get("signal_or_observation_error")
            and binding["bound_monotonic_ns"] <= result["signal_attempt_monotonic_ns"]
            <= result["signal_sent_monotonic_ns"] <= result["pidfd_exit_observed_monotonic_ns"]
            and report["owned_child_exit_code"] == -signal.SIGKILL)
        natural = subprocess.Popen(
            [sys.executable, "-I", "-S", "-c", "import sys; sys.stdin.buffer.read(1)"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        observer = None
        try:
            natural_owner = proc_identity(natural.pid)
            observer = os.pidfd_open(natural.pid)
            ended_during_binding = False

            def end_before_signal():
                nonlocal ended_during_binding
                natural.stdin.close()
                poller = select.poll()
                poller.register(observer, select.POLLIN)
                # Do not call poll()/wait() on Popen here: leave the dead child
                # unreaped, retaining /proc identity exactly as in the countercase.
                ended_during_binding = any(flags & select.POLLIN for _fd, flags in poller.poll(3000))
                if not ended_during_binding or not same_process(natural_owner, proc_identity(natural.pid)):
                    raise RuntimeError("synthetic natural exit not proven")

            rejected = False
            try:
                pidfd_kill_and_observe(natural_owner, end_before_signal)
            except RuntimeError as error:
                rejected = str(error) == "process ended during hard-kill prebinding"
            report["callback_exit_rejected_before_signal"] = bool(
                rejected and ended_during_binding and natural.wait(timeout=3) == 0)
        finally:
            if observer is not None:
                os.close(observer)
            natural.stdin.close()
            if natural.poll() is None:
                natural.kill()
            natural.wait(timeout=3)
            report["natural_child_joined"] = True
        report["checks_passed"] = bool(report["checks_passed"]
                                       and report["callback_exit_rejected_before_signal"])
    except (OSError, RuntimeError, subprocess.SubprocessError):
        report["checks_passed"] = False
        report["failure"] = "synthetic_hard_kill_check_failed"
    finally:
        # This exact Popen is our unreaped child, never a process-name/PID scan.
        if child.poll() is None:
            child.kill()
        try:
            child.wait(timeout=3)
            report["final_owned_child_joined"] = True
        except subprocess.TimeoutExpired:
            report["final_owned_child_joined"] = False
        child.stdout.close()
        report["checks_passed"] = bool(report["checks_passed"] and report["final_owned_child_joined"])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "start", "resume", "run-agent", "record", "observe", "screen", "send", "keys", "mark", "clear", "hard-kill", "export", "cleanup", "selftest", "selftest-hard-kill", "wait"])
    parser.add_argument("--label", default="case-a")
    parser.add_argument("--prompt")
    parser.add_argument("--case", choices=sorted(PROMPTS))
    parser.add_argument("--keys", nargs="+")
    parser.add_argument("--event", choices=sorted(EVENTS))
    parser.add_argument("--after", type=int, default=0)
    parser.add_argument("--from-label")
    parser.add_argument("--after-exit", type=int)
    parser.add_argument("--after-end", type=int)
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--enable-lifecycle", action="store_true")
    parser.add_argument("--effort", choices=("low", "high"),
                        help="explicit normal-start effort; default low, resume inherits its source")
    parser.add_argument("--error-profile", action="store_true",
                        help="explicit isolated synthetic API-key profile for init/start")
    parser.add_argument("--launch-id")
    parser.add_argument("--trial", type=int)
    parser.add_argument("--observation", choices=sorted(MARKS))
    parser.add_argument("--context", choices=sorted(CONTEXTS))
    args = parser.parse_args()
    if args.effort is not None and (args.action != "start" or args.error_profile):
        parser.error("--effort is only supported by a fresh normal start")
    if args.error_profile and args.action not in {"init", "start", "selftest"}:
        parser.error("--error-profile is only used with init/start/selftest; later actions use the owned launch marker")
    if args.action == "resume" and (not args.from_label or args.after_exit is None or args.after_end is None
                                     or args.after_exit <= 0 or args.after_end <= 0):
        parser.error("resume requires --from-label, --after-exit and --after-end")
    if args.action != "resume" and any(value is not None for value in (args.from_label, args.after_exit, args.after_end)):
        parser.error("resume provenance arguments require the resume action")
    if args.action == "selftest":
        result = selftest()
        if args.error_profile:
            result["error_profile"] = error_profile_module().selftest()
    elif args.action == "selftest-hard-kill":
        result = hard_kill_selftest()
    else:
        root = root_dir()
        if args.action == "record":
            record(root)
            return
        if args.action != "init":
            require_owner(root)
        result = {"init": lambda: initialize(root, args.error_profile),
                  "start": lambda: start(root, args.label, args.enable_lifecycle, args.error_profile, args.effort),
                  "resume": lambda: resume(root, args.from_label, args.after_exit, args.after_end, args.label),
                  "run-agent": lambda: run_agent(root, args.label, args.launch_id),
                  "observe": lambda: observe(root, args.label), "screen": lambda: screen(root, args.label),
                  "send": lambda: send(root, args.label, PROMPTS[args.case] if args.case else args.prompt or PROMPTS["reply"], args.trial, args.case),
                  "keys": lambda: keys(root, args.label, args.keys),
                  "mark": lambda: mark(root, args.label, args.observation, args.context, args.trial or 0),
                  "clear": lambda: clear_session(root, args.label),
                  "hard-kill": lambda: hard_kill(root, args.label),
                  "wait": lambda: wait_event(root, args.label, args.event, args.after, args.seconds),
                  "export": lambda: export(root), "cleanup": lambda: cleanup(root)}[args.action]()
    print(json.dumps(result, sort_keys=True))
    if args.action == "selftest-hard-kill" and not result["checks_passed"]:
        raise SystemExit(1)
    if args.action == "hard-kill" and not (result["signal_sent"] and result["pidfd_exit_observed"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
