#!/usr/bin/env python3
"""Explicit, synthetic API-key measurement profile; never a production adapter.

After hooks init --error-profile, run `serve ROOT --status 401|500` in a
foreground process whose caller retains and joins its handle. `stop ROOT`
only requests its exit; it does not claim to join a non-child. No forwarding,
real credentials, header/body logging, namespace or machine-policy changes.
The profile separates configuration, not all possible outbound network access.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import sys
import time
import uuid


PROFILE = "agentbridge-m1-synthetic-api-key-v1"
DUMMY_KEY = "sk-ant-api03-agentbridge-synthetic-not-a-real-key"
MANAGED_ROOT = Path("/etc/claude-code")
DIRECTORIES = ("home", "config", "anthropic", "xdg-config", "xdg-cache", "xdg-data", "runtime")
INPUTS = ("settings.json", "mcp.json", "m1-claude-hooks.py", "m1-snapshot-session.py",
          "m1-probe-agents.py", "m1-error-profile.py")
SERVER_SECONDS = 300
REQUEST_SECONDS = 3
MAX_REQUESTS = 32
MAX_HEADERS = 16 * 1024
MAX_BODY = 256 * 1024
STOP = False
REQUEST_REASONS = frozenset((
    "request_header_limit_or_framing", "unexpected_request_target",
    "invalid_header_framing", "invalid_header_name", "duplicate_or_invalid_header",
    "unexpected_authentication", "unexpected_host", "unsupported_body_framing",
    "request_body_limit_or_framing", "request_deadline", "incomplete_request",
    "unexpected_pipelined_bytes", "non_loopback_peer", "profile_changed",
))
REQUEST_METHODS = {b"GET": "GET", b"POST": "POST", b"HEAD": "HEAD", b"OPTIONS": "OPTIONS"}


def sibling(name):
    path = Path(__file__).resolve().with_name(name)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("profile helper unavailable")
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


class RequestRejected(RuntimeError):
    """Carry only allowlisted diagnostics; never keep the rejected request."""

    def __init__(self, reason, *, request_line=None):
        self.reason = reason if type(reason) is str and reason in REQUEST_REASONS else "unclassified_runtime_error"
        super().__init__(self.reason)
        self.method = "other"
        self.target_sha256 = None
        if self.reason == "unexpected_request_target" and type(request_line) is bytes:
            # Preserve the raw second SP-delimited token for the digest only.
            # This observes an already rejected line; it does not accept a new
            # method, target, HTTP version or whitespace form.
            tokens = request_line.split(b" ", 2)
            self.method = REQUEST_METHODS.get(tokens[0], "other")
            if len(tokens) > 1:
                self.target_sha256 = sha(tokens[1])


def request_failure(error):
    """Safe event/end-report payload, independent of arbitrary exception text."""
    if type(error) is RequestRejected:
        result = {"reason": error.reason}
        if error.reason == "unexpected_request_target":
            result.update(method=error.method, target_sha256=error.target_sha256)
        return result
    if isinstance(error, OSError):
        return {"reason": "request_os_error"}
    return {"reason": "unclassified_runtime_error"}


def checked_file(path, maximum=256 * 1024):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o022 or info.st_size > maximum or path.resolve() != path):
        raise RuntimeError("profile file ownership or size invalid")
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    if (len(data) > maximum or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        raise RuntimeError("profile file changed while reading")
    return data


def directory_id(path):
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or path.resolve() != path
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise RuntimeError("profile directory ownership changed")
    return {"dev": info.st_dev, "ino": info.st_ino, "uid": info.st_uid}


def managed_absent():
    # Exact Linux contract: reject the whole machine directory, even empty or
    # symlinked. Never read machine-policy contents or follow an override.
    if sys.platform != "linux" or "microsoft" in os.uname().release.lower():
        raise RuntimeError("error profile supports native Linux only")
    try:
        MANAGED_ROOT.lstat()
    except FileNotFoundError:
        return {"native_linux": True, "etc_claude_code_absent": True}
    raise RuntimeError("managed configuration is present or unresolved")


def require_mode(root, requested):
    hooks = sibling("m1-claude-hooks.py")
    actual = hooks.require_owner(root).get("error_profile", False)
    if type(actual) is not bool or actual != requested:
        raise RuntimeError("explicit error profile does not match root")


def prepare(root):
    hooks = sibling("m1-claude-hooks.py")
    require_mode(root, True)
    managed = managed_absent()
    base = root / "error-profile"
    base.mkdir(mode=0o700)
    for name in DIRECTORIES:
        (base / name).mkdir(mode=0o700)
    manifest = {"profile": PROFILE, "profile_id": uuid.uuid4().hex,
                "binary_sha256": hooks.BINARY_SHA256, "managed_sources": managed,
                "root_work": hooks.directory_binding(root), "base": directory_id(base),
                "directories": {name: directory_id(base / name) for name in DIRECTORIES},
                "inputs": {name: sha(checked_file(root / name)) for name in INPUTS},
                "network_isolation_claimed": False, "runtime_compatibility_proven": False}
    hooks.write_once(base / "manifest.json", manifest)
    return manifest


def load_manifest(root):
    hooks = sibling("m1-claude-hooks.py")
    require_mode(root, True)
    raw = checked_file(root / "error-profile" / "manifest.json", 16384)
    data = json.loads(raw)
    if (data.get("profile") != PROFILE or not re.fullmatch(r"[0-9a-f]{32}", data.get("profile_id", ""))
            or data.get("binary_sha256") != hooks.BINARY_SHA256
            or data.get("root_work") != hooks.directory_binding(root)
            or data.get("managed_sources") != managed_absent()
            or data.get("base") != directory_id(root / "error-profile")
            or data.get("directories") != {n: directory_id(root / "error-profile" / n) for n in DIRECTORIES}
            or data.get("inputs") != {name: sha(checked_file(root / name)) for name in INPUTS}):
        raise RuntimeError("immutable error profile changed")
    return data, sha(raw)


def validate_endpoint(value):
    if (not isinstance(value, dict) or value.get("host") != "127.0.0.1"
            or type(value.get("port")) is not int or not 1024 <= value["port"] <= 65535
            or value.get("url") != "http://127.0.0.1:" + str(value["port"])
            or value.get("status") not in (401, 500) or type(value.get("status")) is not int
            or type(value.get("socket_fd")) is not int or value["socket_fd"] < 0
            or not re.fullmatch(r"socket:\[\d+\]", value.get("socket_identity", ""))):
        raise RuntimeError("invalid owned numeric loopback endpoint")
    owner = value.get("process", {})
    if not all(type(owner.get(k)) is int and owner[k] > 0 for k in ("pid", "start_ticks")):
        raise RuntimeError("HTTP server process generation missing")


def binding(root, require_live=True):
    manifest, checksum = load_manifest(root)
    base = root / "error-profile"
    raw = checked_file(base / "endpoint.json", 8192)
    endpoint = json.loads(raw)
    validate_endpoint(endpoint)
    if endpoint.get("manifest_sha256") != checksum or endpoint.get("profile_id") != manifest["profile_id"]:
        raise RuntimeError("HTTP endpoint belongs to another profile")
    if require_live:
        hooks = sibling("m1-claude-hooks.py")
        owner = endpoint["process"]
        if (os.path.lexists(base / "stop.json") or os.path.lexists(base / "ended.json")
                or os.path.lexists(base / "retain.json")
                or not hooks.process_alive(owner, hooks.proc_identity(owner["pid"]))
                or os.readlink(f'/proc/{owner["pid"]}/fd/{endpoint["socket_fd"]}') != endpoint["socket_identity"]):
            raise RuntimeError("owned HTTP endpoint no longer active")
    return {"profile": PROFILE, "manifest_sha256": checksum, "endpoint_sha256": sha(raw),
            "profile_id": manifest["profile_id"], "directories": manifest["directories"],
            "root_work": manifest["root_work"], "endpoint": endpoint}


def environment(root, expected=None, *, terminal=None, initialization=False):
    # Deliberately never merge os.environ. This excludes tokens, proxies, cloud
    # credentials, CA overrides, SDK/provider/launcher and credential helpers.
    manifest, _checksum = load_manifest(root)
    current = None if initialization else binding(root)
    if expected is not None and current != expected:
        raise RuntimeError("agent and snapshot error profiles differ")
    base = root / "error-profile"
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "HOME": str(base / "home"), "CLAUDE_CONFIG_DIR": str(base / "config"),
           "ANTHROPIC_CONFIG_DIR": str(base / "anthropic"),
           "XDG_CONFIG_HOME": str(base / "xdg-config"), "XDG_CACHE_HOME": str(base / "xdg-cache"),
           "XDG_DATA_HOME": str(base / "xdg-data"), "XDG_RUNTIME_DIR": str(base / "runtime"),
           "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
           "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"}
    if current is not None:
        env.update(ANTHROPIC_API_KEY=DUMMY_KEY, ANTHROPIC_BASE_URL=current["endpoint"]["url"])
    if terminal is not None:
        if (set(terminal) != {"TMUX", "TMUX_PANE", "AB_M1_LAUNCH_ID", "AB_M1_AGENT_PID"}
                or terminal["TMUX"].rsplit(",", 2)[0] != str(root / "tmux.sock")
                or not re.fullmatch(r"%\d+", terminal["TMUX_PANE"])
                or not re.fullmatch(r"[0-9a-f]{32}", terminal["AB_M1_LAUNCH_ID"])
                or not re.fullmatch(r"[1-9]\d*", terminal["AB_M1_AGENT_PID"])):
            raise RuntimeError("terminal context is not owned")
        env.update(terminal)
        env["TERM"] = "xterm-256color"
    return env


def validate_client(root, launch):
    claim = json.loads(checked_file(root / "error-profile" / "client-claim.json", 4096))
    if claim != {"launch_id": launch["launch_id"], "profile_id": launch["error_profile_binding"]["profile_id"]}:
        raise RuntimeError("exclusive profile client claim changed")


def inspect_headers(raw, endpoint):
    """Pure framing/auth gate. Return only safe counts; never retain headers."""
    if len(raw) > MAX_HEADERS or not raw.endswith(b"\r\n\r\n"):
        raise RequestRejected("request_header_limit_or_framing")
    lines = raw[:-4].split(b"\r\n")
    # Claude 2.1.268 performs an unauthenticated HEAD preconnect to this
    # exact path before SessionStart. This is a separate synthetic helper
    # response, never evidence that an API request/authentication succeeded.
    preconnect = lines[0] == b"HEAD /api/hello HTTP/1.1"
    if not preconnect and lines[0] not in (b"POST /v1/messages HTTP/1.1", b"POST /v1/messages?beta=true HTTP/1.1"):
        raise RequestRejected("unexpected_request_target", request_line=lines[0])
    fields = {}
    for line in lines[1:]:
        if b":" not in line or line[:1] in (b" ", b"\t"):
            raise RequestRejected("invalid_header_framing")
        name, value = line.split(b":", 1)
        if not re.fullmatch(rb"[A-Za-z0-9!#$%&'*+.^_`|~-]+", name):
            raise RequestRejected("invalid_header_name")
        key = name.lower()
        if key in fields or any(c < 32 or c == 127 for c in value.strip()):
            raise RequestRejected("duplicate_or_invalid_header")
        fields[key] = value.strip()
    if ((b"x-api-key" in fields if preconnect else fields.get(b"x-api-key") != DUMMY_KEY.encode())
            or any(k in fields for k in (b"authorization", b"proxy-authorization", b"cookie"))):
        raise RequestRejected("unexpected_authentication")
    if fields.get(b"host") != f'127.0.0.1:{endpoint["port"]}'.encode():
        raise RequestRejected("unexpected_host")
    if any(k in fields for k in (b"transfer-encoding", b"expect")):
        raise RequestRejected("unsupported_body_framing")
    if preconnect:
        # Bun fetch supplies no body/authentication for this preconnect.
        # A missing length or exactly zero is sufficient; all buffered extra
        # bytes still fail receive_request's existing pipelining check.
        if fields.get(b"content-length", b"0") != b"0":
            raise RequestRejected("request_body_limit_or_framing")
        return {"request_kind": "preconnect", "body_bytes": 0, "authentication_headers_absent": True}
    length = fields.get(b"content-length", b"")
    if not re.fullmatch(rb"[0-9]{1,6}", length) or not 0 < int(length) <= MAX_BODY:
        raise RequestRejected("request_body_limit_or_framing")
    return {"request_kind": "api_error", "body_bytes": int(length),
            "dummy_key_confirmed": True, "additional_auth_absent": True}


def receive_request(connection, endpoint, end):
    header = bytearray()
    def receive(count):
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise RequestRejected("request_deadline")
        connection.settimeout(remaining)
        value = connection.recv(count)
        if not value:
            raise RequestRejected("incomplete_request")
        return value
    # Bound all header bytes before parsing. No makefile/readline or unbounded
    # Content-Length read; a slow sender shares one absolute request deadline.
    while b"\r\n\r\n" not in header:
        if len(header) >= MAX_HEADERS:
            raise RequestRejected("request_header_limit_or_framing")
        header.extend(receive(min(1024, MAX_HEADERS - len(header))))
    split = header.index(b"\r\n\r\n") + 4
    result = inspect_headers(bytes(header[:split]), endpoint)
    remaining = result["body_bytes"] - (len(header) - split)
    if remaining < 0:
        raise RequestRejected("unexpected_pipelined_bytes")
    del header
    while remaining:
        remaining -= len(receive(min(8192, remaining)))
    return result


def response(status, *, request_kind="api_error"):
    if type(status) is not int or status not in (401, 500):
        raise RuntimeError("unsupported synthetic response")
    if request_kind == "preconnect":
        # Our empty start response, not an observed real-provider response.
        return b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    if request_kind != "api_error":
        raise RuntimeError("unsupported synthetic request kind")
    kind = "authentication_error" if status == 401 else "api_error"
    payload = json.dumps({"type": "error", "error": {"type": kind, "message": "Synthetic M1 error"},
                          "request_id": "req_agentbridge_synthetic"}, separators=(",", ":")).encode()
    reason = "Unauthorized" if status == 401 else "Internal Server Error"
    return (f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n").encode() + payload


def completed_response(result, safe, status):
    """Count only a completed send, independently of accepted TCP connections."""
    if safe["request_kind"] == "preconnect":
        counter, action, sent_status = "preconnect_responses", "synthetic_http_preconnect", 200
    elif safe["request_kind"] == "api_error":
        counter, action, sent_status = "api_error_responses", "synthetic_http_error", status
    else:
        raise RuntimeError("unsupported synthetic request kind")
    result[counter] += 1
    return {"action": action, "status": sent_status, **safe}


def serve(root, status):
    global STOP
    hooks = sibling("m1-claude-hooks.py")
    manifest, checksum = load_manifest(root)
    hooks.verify_binary()
    base = root / "error-profile"
    # Any earlier/uncertain serve owns this profile permanently. No port/owner
    # replacement, restart or implicit retry on the same immutable launch set.
    hooks.write_once(base / "server-claim.json", {"profile_id": manifest["profile_id"]})
    def stopped(_sig, _frame):
        global STOP
        STOP = True
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stopped)
    result = {"kind": "error_http_server_end", "requests": 0,
              "preconnect_responses": 0, "api_error_responses": 0, "reason": "setup_failed",
              "socket_closed": False, "spawned_children": 0}
    listener = None
    try:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(2)
        listener.setblocking(False)
        endpoint = {"profile_id": manifest["profile_id"], "manifest_sha256": checksum,
                    "host": "127.0.0.1", "port": listener.getsockname()[1], "status": status,
                    "process": hooks.generation(hooks.proc_identity(os.getpid())),
                    "socket_fd": listener.fileno(),
                    "socket_identity": os.readlink(f"/proc/self/fd/{listener.fileno()}"),
                    "started_monotonic_ns": time.monotonic_ns(), "lifetime_seconds": SERVER_SECONDS}
        endpoint["url"] = f'http://127.0.0.1:{endpoint["port"]}'
        validate_endpoint(endpoint)
        hooks.write_once(base / "endpoint.json", endpoint)
        print(json.dumps({"kind": "error_http_server_ready", "binding": binding(root)}), flush=True)
        end = time.monotonic() + SERVER_SECONDS
        result["reason"] = "lifetime_limit"
        while time.monotonic() < end and result["requests"] < MAX_REQUESTS:
            if STOP or os.path.lexists(base / "stop.json"):
                result["reason"] = "explicit_stop"
                break
            if not select.select([listener], [], [], min(0.1, max(0, end - time.monotonic())))[0]:
                continue
            connection, address = listener.accept()
            began = time.monotonic_ns()
            request_end = min(end, time.monotonic() + REQUEST_SECONDS)
            result["requests"] += 1
            try:
                with connection:
                    if address[0] != "127.0.0.1":
                        raise RequestRejected("non_loopback_peer")
                    # Revalidate immutable settings/ownership before receiving
                    # any request; no request/header/body content is exported.
                    if load_manifest(root)[1] != checksum:
                        raise RequestRejected("profile_changed")
                    safe = receive_request(connection, endpoint, request_end)
                    remaining = request_end - time.monotonic()
                    if remaining <= 0:
                        raise RequestRejected("request_deadline")
                    connection.settimeout(remaining)
                    connection.sendall(response(status, request_kind=safe["request_kind"]))
                sent = completed_response(result, safe, status)
                hooks.append(root, {"kind": "harness",
                                    "profile_id": manifest["profile_id"], "request": result["requests"],
                                    "request_started_monotonic_ns": began, **sent})
            except (OSError, RuntimeError) as error:
                # Never echo exception text: it could contain a rejected header.
                result["reason"] = "request_rejected_or_failed"
                result["request_failure"] = request_failure(error)
                hooks.append(root, {"kind": "harness", "action": "synthetic_http_rejected",
                                    "profile_id": manifest["profile_id"], "request": result["requests"],
                                    "request_failure": result["request_failure"]})
                break
        else:
            if result["requests"] >= MAX_REQUESTS:
                result["reason"] = "request_limit"
    finally:
        if listener is not None:
            listener.close()
            result["socket_closed"] = True
        result["ended_monotonic_ns"] = time.monotonic_ns()
        hooks.write_once(base / "ended.json", result)
        print(json.dumps(result, sort_keys=True), flush=True)
    # This result proves socket closure, not this process's future reap. The
    # caller must retain/join its own foreground handle and observe pipe EOF.
    return 0 if result["reason"] == "explicit_stop" else 1


def request_stop(root):
    hooks = sibling("m1-claude-hooks.py")
    current = binding(root, require_live=False)
    hooks.write_once(root / "error-profile" / "stop.json", {"endpoint_sha256": current["endpoint_sha256"]})
    return {"stop_requested": True, "joined": False, "caller_must_join_foreground_server": True}


def retain(root):
    """A known unsafe query outcome forbids automated continued use/deletion."""
    hooks = sibling("m1-claude-hooks.py")
    require_mode(root, True)
    try:
        hooks.write_once(root / "error-profile" / "retain.json",
                         {"reason": "snapshot_process_or_stream_ownership_unresolved"})
    except FileExistsError:
        pass


def cleanup_guard(root):
    hooks = sibling("m1-claude-hooks.py")
    _manifest, _checksum = load_manifest(root)
    base = root / "error-profile"
    if os.path.lexists(base / "retain.json"):
        raise RuntimeError("unresolved profile process/stream ownership; retain root")
    if os.path.lexists(base / "server-claim.json"):
        endpoint = json.loads(checked_file(base / "endpoint.json", 8192))
        validate_endpoint(endpoint)
        ended = json.loads(checked_file(base / "ended.json", 8192))
        if not ended.get("socket_closed") or hooks.proc_identity(endpoint["process"]["pid"]) is not None:
            raise RuntimeError("HTTP process not absent; retain root and join its owner first")


def selftest():
    from unittest.mock import patch
    checks = []
    def check(name, value):
        if not value:
            raise AssertionError(name)
        checks.append(name)
    def rejects(fn):
        try:
            fn()
        except (RuntimeError, OSError):
            return True
        return False
    endpoint = {"host": "127.0.0.1", "port": 12345, "url": "http://127.0.0.1:12345", "status": 401,
                "process": {"pid": 123, "start_ticks": 456}, "socket_fd": 3, "socket_identity": "socket:[789]"}
    validate_endpoint(endpoint)
    for key, value in (("host", "localhost"), ("host", "192.0.2.1"), ("port", True),
                       ("url", "http://127.0.0.1:12345/forward"), ("url", "http://dummy@127.0.0.1:12345"),
                       ("status", 302), ("process", {"pid": 123}), ("socket_identity", "/tmp/socket")):
        check("endpoint_" + key + "_" + str(value), rejects(lambda: validate_endpoint({**endpoint, key: value})))
    header = (b"POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nX-Api-Key: "
              + DUMMY_KEY.encode() + b"\r\nContent-Length: 2\r\n\r\n")
    check("expected_dummy_request", inspect_headers(header, endpoint)["dummy_key_confirmed"])
    for name, value in (("wrong_key", header.replace(DUMMY_KEY.encode(), b"unexpected-value")),
                        ("wrong_host", header.replace(b"127.0.0.1:12345", b"other:12345")),
                        ("external_target", header.replace(b"/v1/messages", b"http://example.invalid/")),
                        ("oversize_body", header.replace(b"Length: 2", b"Length: 999999")),
                        ("incomplete", header[:-2])):
        check(name, rejects(lambda: inspect_headers(value, endpoint)))
    for name in (b"Authorization: Bearer unexpected", b"Proxy-Authorization: unexpected", b"Cookie: unexpected",
                 b"Transfer-Encoding: chunked", b"Expect: 100-continue", b"Content-Length: 2"):
        check("reject_" + name.split(b":")[0].decode(), rejects(lambda: inspect_headers(header[:-2] + name + b"\r\n\r\n", endpoint)))
    def rejected_header(raw):
        try:
            inspect_headers(raw, endpoint)
        except RequestRejected as error:
            return request_failure(error)
        raise AssertionError("request unexpectedly accepted")
    target = b"https://synthetic-private.invalid/first-run?token=synthetic-private-target"
    for method in (b"GET", b"POST", b"HEAD", b"OPTIONS", b"synthetic-private-method"):
        raw = header.replace(b"POST /v1/messages", method + b" " + target)
        failure = rejected_header(raw)
        expected_method = method.decode() if method in (b"GET", b"POST", b"HEAD", b"OPTIONS") else "other"
        check("rejected_target_" + expected_method, failure == {
            "reason": "unexpected_request_target", "method": expected_method,
            "target_sha256": hashlib.sha256(target).hexdigest()})
        check("target_redacted_" + expected_method, "synthetic-private" not in json.dumps(failure))
    check("missing_target_is_not_invented", rejected_header(b"GET\r\n\r\n") == {
        "reason": "unexpected_request_target", "method": "GET", "target_sha256": None})
    for raw, reason in (
            (header[:-2] + b"synthetic-private-header\r\n\r\n", "invalid_header_framing"),
            (header[:-2] + b"private header: synthetic-private-value\r\n\r\n", "invalid_header_name"),
            (header[:-2] + b"Authorization: synthetic-private-value\r\n\r\n", "unexpected_authentication"),
            (header.replace(b"127.0.0.1:12345", b"synthetic-private-host"), "unexpected_host")):
        check("redacted_" + reason, rejected_header(raw) == {"reason": reason})
    check("unknown_header_semantics_unchanged", inspect_headers(
        header[:-2] + b"X-Synthetic-Private: synthetic-private-value\r\n\r\n", endpoint)
        == inspect_headers(header, endpoint))
    for name, error in (("arbitrary", RuntimeError("synthetic-private exception /path?token=value")),
                        ("enum_looking", RuntimeError("unexpected_host")),
                        ("unknown_structured", RequestRejected("synthetic-private reason"))):
        check("unclassified_exception_redacted_" + name, request_failure(error) == {"reason": "unclassified_runtime_error"})
    check("os_error_details_redacted", request_failure(OSError(13, "synthetic-private error", "/synthetic-private-file"))
          == {"reason": "request_os_error"})
    hello = b"HEAD /api/hello HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n\r\n"
    hello_safe = {"request_kind": "preconnect", "body_bytes": 0, "authentication_headers_absent": True}
    check("preconnect_no_length", inspect_headers(hello, endpoint) == hello_safe)
    check("preconnect_zero_length", inspect_headers(
        hello[:-2] + b"Content-Length: 0\r\n\r\n", endpoint) == hello_safe)
    check("preconnect_standard_fetch_headers", inspect_headers(hello[:-2]
        + b"User-Agent: synthetic\r\nAccept: */*\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
        endpoint) == hello_safe)
    for name, line in (
            ("get", b"GET /api/hello HTTP/1.1"), ("post", b"POST /api/hello HTTP/1.1"),
            ("options", b"OPTIONS /api/hello HTTP/1.1"), ("other_path", b"HEAD /v1/messages HTTP/1.1"),
            ("query", b"HEAD /api/hello?beta=true HTTP/1.1"), ("slash", b"HEAD /api/hello/ HTTP/1.1"),
            ("absolute", b"HEAD http://127.0.0.1:12345/api/hello HTTP/1.1"),
            ("space", b"HEAD  /api/hello HTTP/1.1"), ("case", b"head /api/hello HTTP/1.1"),
            ("version", b"HEAD /api/hello HTTP/1.0")):
        check("preconnect_reject_" + name, rejects(lambda: inspect_headers(
            line + b"\r\nHost: 127.0.0.1:12345\r\n\r\n", endpoint)))
    for name, field in (
            ("dummy_key", b"X-Api-Key: " + DUMMY_KEY.encode()),
            ("other_key", b"X-Api-Key: synthetic-private-key"), ("empty_key", b"X-Api-Key:"),
            ("authorization", b"Authorization: synthetic-private-value"),
            ("proxy_auth", b"Proxy-Authorization: synthetic-private-value"),
            ("cookie", b"Cookie: synthetic-private-value"),
            ("body", b"Content-Length: 1"), ("negative", b"Content-Length: -1"),
            ("padded_zero", b"Content-Length: 00"), ("empty_length", b"Content-Length:"),
            ("chunked", b"Transfer-Encoding: chunked"), ("expect", b"Expect: 100-continue"),
            ("duplicate_host", b"Host: 127.0.0.1:12345"),
            ("duplicate_length", b"Content-Length: 0\r\nContent-Length: 0")):
        check("preconnect_reject_" + name, rejects(lambda: inspect_headers(
            hello[:-2] + field + b"\r\n\r\n", endpoint)))
    check("preconnect_reject_wrong_host", rejects(lambda: inspect_headers(
        hello.replace(b"127.0.0.1:12345", b"other:12345"), endpoint)))
    check("preconnect_reject_missing_host", rejects(lambda: inspect_headers(
        b"HEAD /api/hello HTTP/1.1\r\n\r\n", endpoint)))
    check("preconnect_header_limit_unchanged", rejects(lambda: inspect_headers(
        hello[:-2] + b"X-Synthetic: " + b"x" * MAX_HEADERS + b"\r\n\r\n", endpoint)))
    check("post_still_requires_dummy_key", rejects(lambda: inspect_headers(
        header.replace(b"X-Api-Key: " + DUMMY_KEY.encode() + b"\r\n", b""), endpoint)))
    class BufferedRequest:
        def __init__(self, data):
            self.data = data
        def settimeout(self, _seconds):
            pass
        def recv(self, count):
            chunk, self.data = self.data[:count], self.data[count:]
            return chunk
    with patch.object(time, "monotonic", return_value=0):
        check("preconnect_receive_zero_body", receive_request(BufferedRequest(hello), endpoint, 3) == hello_safe)
        check("preconnect_reject_buffered_body", rejects(lambda: receive_request(
            BufferedRequest(hello + b"x"), endpoint, 3)))
        check("preconnect_reject_buffered_pipeline", rejects(lambda: receive_request(
            BufferedRequest(hello + hello), endpoint, 3)))
    with patch.object(time, "monotonic", side_effect=[0, 4]):
        check("preconnect_deadline_unchanged", rejects(lambda: receive_request(
            BufferedRequest(hello[:-2]), endpoint, 3)))
    for status in (401, 500):
        wire = response(status, request_kind="preconnect")
        check("preconnect_response_is_empty_200_" + str(status), wire ==
              b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        result = {"requests": 2, "preconnect_responses": 0, "api_error_responses": 0}
        sent = completed_response(result, hello_safe, status)
        check("preconnect_separate_count_" + str(status), result == {
            "requests": 2, "preconnect_responses": 1, "api_error_responses": 0}
            and sent == {"action": "synthetic_http_preconnect", "status": 200, **hello_safe})
        sent = completed_response(result, inspect_headers(header, endpoint), status)
        check("api_error_separate_count_" + str(status), result == {
            "requests": 2, "preconnect_responses": 1, "api_error_responses": 1}
            and sent["action"] == "synthetic_http_error" and sent["status"] == status
            and sent["dummy_key_confirmed"])
    check("unknown_response_kind_rejected", rejects(lambda: response(401, request_kind="other")))
    with patch.object(Path, "lstat", side_effect=FileNotFoundError):
        check("managed_absent", managed_absent()["etc_claude_code_absent"])
    with patch.object(Path, "lstat", return_value=object()):
        check("any_managed_root_rejected", rejects(managed_absent))
    with patch.object(Path, "lstat", side_effect=PermissionError):
        check("managed_read_failure_rejected", rejects(managed_absent))
    root = Path("/tmp/ab-m1-hooks-profile-selftest")
    with patch.dict(globals(), load_manifest=lambda _r: ({}, "hash"), binding=lambda _r: {"endpoint": endpoint}), \
            patch.dict(os.environ, {"ANTHROPIC_AUTH_TOKEN": "secret", "HTTPS_PROXY": "secret", "LD_PRELOAD": "secret"}):
        env = environment(root, {"endpoint": endpoint})
        check("positive_environment_only", "secret" not in json.dumps(env) and "LD_PRELOAD" not in env)
        check("separate_home_config", env["HOME"] != env["CLAUDE_CONFIG_DIR"] != env["ANTHROPIC_CONFIG_DIR"])
        check("marketplace_disabled", env["CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL"] == "1")
        check("snapshot_profile_mismatch", rejects(lambda: environment(root, {"endpoint": {**endpoint, "port": 12346}})))
    check("no_redirect_responses", all(b"Location:" not in response(s) and b"Connection: close" in response(s) for s in (401, 500)))
    # Exercise real immutable files in an exclusively owned synthetic directory;
    # no listener, Claude, HTTP connection or subprocess is started by this test.
    import shutil
    hooks = sibling("m1-claude-hooks.py")
    root = Path("/tmp") / ("ab-m1-hooks-error-selftest-" + uuid.uuid4().hex)
    root.mkdir(mode=0o700)
    owned = None
    try:
        hooks.write_once(root / "owner.json", {"root": str(root), "harness": hooks.HARNESS, "error_profile": True})
        (root / "work").mkdir(mode=0o700)
        owned = hooks.directory_binding(root)
        for name in INPUTS:
            (root / name).write_bytes(b"synthetic, never executed: " + name.encode())
            (root / name).chmod(0o600)
        with patch.dict(globals(), managed_absent=lambda: {"native_linux": True, "etc_claude_code_absent": True}), \
                patch.dict(globals(), sibling=lambda _name: hooks):
            manifest = prepare(root)
            base = root / "error-profile"
            manifest_bytes = (base / "manifest.json").read_bytes()
            own_endpoint = {**endpoint, "profile_id": manifest["profile_id"], "manifest_sha256": sha(manifest_bytes)}
            hooks.write_once(base / "endpoint.json", own_endpoint)
            endpoint_bytes = (base / "endpoint.json").read_bytes()
            stable = binding(root, require_live=False)
            check("missing_explicit_profile_rejected", rejects(lambda: require_mode(root, False)))
            check("immutable_file_binding_accepted", stable["manifest_sha256"] == sha(manifest_bytes))
            original = (root / "settings.json").read_bytes()
            (root / "settings.json").write_bytes(b"changed synthetic settings")
            check("changed_settings_rejected", rejects(lambda: binding(root, require_live=False)))
            (root / "settings.json").write_bytes(original)
            (base / "manifest.json").write_text(json.dumps({**manifest, "profile_id": "f" * 32}))
            check("changed_manifest_rejected", rejects(lambda: binding(root, require_live=False)))
            (base / "manifest.json").write_bytes(manifest_bytes)
            with patch.object(hooks, "proc_identity", return_value={**endpoint["process"], "state": "S"}), \
                    patch.object(os, "readlink", return_value=endpoint["socket_identity"]):
                check("live_original_endpoint", binding(root) == stable)
                replacement = {**own_endpoint, "port": 12346, "url": "http://127.0.0.1:12346"}
                (base / "endpoint.json").write_text(json.dumps(replacement))
                check("changed_endpoint_rejected_by_client_binding", rejects(lambda: environment(root, stable)))
                (base / "endpoint.json").write_bytes(endpoint_bytes)
                (base / "stop.json").write_text("{}")
                check("stopping_endpoint_not_live", rejects(lambda: binding(root)))
                (base / "stop.json").unlink()
                (base / "ended.json").write_text("{}")
                check("ended_endpoint_not_live", rejects(lambda: binding(root)))
                (base / "ended.json").unlink()
                retain(root)
                check("unsafe_snapshot_prevents_continuation", rejects(lambda: binding(root)))
                check("unsafe_snapshot_prevents_root_deletion", rejects(lambda: cleanup_guard(root)))
                (base / "retain.json").unlink()
            with patch.object(hooks, "proc_identity", return_value={**endpoint["process"], "state": "S", "start_ticks": 457}):
                check("reused_server_pid_rejected", rejects(lambda: binding(root)))
            with patch.object(hooks, "proc_identity", return_value=None):
                check("absent_server_rejected", rejects(lambda: binding(root)))
            with patch.object(hooks, "proc_identity", return_value={**endpoint["process"], "state": "S"}), \
                    patch.object(os, "readlink", return_value="socket:[999]"):
                check("replaced_server_socket_rejected", rejects(lambda: binding(root)))
            changed = dict(manifest)
            changed["directories"] = {**manifest["directories"], "config": {"dev": 0, "ino": 0, "uid": 0}}
            (base / "manifest.json").write_text(json.dumps(changed))
            check("changed_config_directory_rejected", rejects(lambda: binding(root, require_live=False)))
            (base / "manifest.json").write_bytes(manifest_bytes)
    finally:
        if owned is None or hooks.directory_binding(root) != owned:
            raise RuntimeError("selftest ownership changed; retain directory")
        shutil.rmtree(root)
    # Exercise the actual init entry point with a group-writable umask. The
    # transferred helper fixtures are already safe; only init creates settings.
    # Mock only external metadata calls and the binary check, never file modes.
    from types import SimpleNamespace
    init_root = Path("/tmp") / ("ab-m1-hooks-init-selftest-" + uuid.uuid4().hex)
    init_root.mkdir(mode=0o700)
    init_owner = directory_id(init_root)
    previous_umask = os.umask(0o002)
    calls = []
    try:
        for name in INPUTS:
            if name.endswith(".py"):
                descriptor = os.open(init_root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(b"synthetic safe transfer; never executed")
        def metadata_call(argv, **kwargs):
            if argv not in ([str(hooks.BINARY), "--version"], ["tmux", "-V"]):
                raise AssertionError("unexpected external init command")
            calls.append((argv, kwargs))
            return SimpleNamespace(stdout="2.1.268 (Claude Code)\n" if argv[0] == str(hooks.BINARY) else "tmux 3.4\n")
        profile_api = SimpleNamespace(managed_absent=managed_absent, prepare=prepare, environment=environment)
        with patch.dict(globals(), managed_absent=lambda: {"native_linux": True, "etc_claude_code_absent": True},
                        sibling=lambda _name: hooks), \
                patch.object(hooks, "error_profile_module", return_value=profile_api), \
                patch.object(hooks, "verify_binary", return_value=hooks.BINARY_SHA256), \
                patch.object(hooks, "call", side_effect=metadata_call):
            metadata = hooks.initialize(init_root, error_profile=True)
            check("profile_init_under_umask_0002", metadata["error_profile"] and len(calls) == 2)
            check("profile_init_files_are_0600", all(stat.S_IMODE((init_root / name).stat().st_mode) == 0o600
                  for name in ("owner.json", "settings.json", "mcp.json")))
            check("profile_init_manifest_valid", load_manifest(init_root)[0]["profile"] == PROFILE)
            before = {name: (init_root / name).read_bytes() for name in ("owner.json", "settings.json", "mcp.json")}
            check("initialized_profile_is_not_restarted", rejects(lambda: hooks.initialize(init_root, error_profile=True)))
            check("init_did_not_overwrite_owned_files", before == {name: (init_root / name).read_bytes() for name in before})
            helper = init_root / "m1-probe-agents.py"
            helper.chmod(0o664)  # Only this known synthetic test file.
            check("group_writable_transfer_still_rejected", rejects(lambda: load_manifest(init_root)))
            helper.chmod(0o600)
    finally:
        os.umask(previous_umask)
        if directory_id(init_root) != init_owner:
            raise RuntimeError("init selftest ownership changed; retain directory")
        shutil.rmtree(init_root)
    class SlowRequest:
        def settimeout(self, _seconds):
            pass
        def recv(self, _count):
            return header  # Body remains pending after the header.
    with patch.object(time, "monotonic", side_effect=[0, 4]):
        check("request_uses_one_absolute_deadline", rejects(lambda: receive_request(SlowRequest(), endpoint, 3)))
    return {"checks_passed": True, "checks": len(checks), "check_names": checks, "http_or_agent_started": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("serve", "stop", "selftest"))
    parser.add_argument("root", nargs="?")
    parser.add_argument("--status", type=int, choices=(401, 500))
    args = parser.parse_args()
    if args.action == "selftest":
        if args.root or args.status:
            parser.error("selftest takes no root or status")
        print(json.dumps(selftest(), sort_keys=True))
        return 0
    if not args.root or (args.action == "serve") != (args.status is not None):
        parser.error("serve requires root and --status; stop requires only root")
    root = Path(args.root)
    if args.action == "serve":
        return serve(root, args.status)
    print(json.dumps(request_stop(root), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
