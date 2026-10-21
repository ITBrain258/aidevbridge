#!/usr/bin/env python3
"""One bounded, private tmux 3.0 build; no installation or server startup.

Run by stdin on the authorized Linux test VM. Retains its fresh private root
for the separately owned inventory probe. The caller must export the returned
report/logs, then remove only this verified root after that probe has finished.
"""
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import uuid

SOURCES = [
    ("tmux-3.0.tar.gz", "https://github.com/tmux/tmux/releases/download/3.0/tmux-3.0.tar.gz", 546099, None),
    ("libevent-dev.deb", "https://archive.ubuntu.com/ubuntu/pool/main/libe/libevent/libevent-dev_2.1.12-stable-9ubuntu2.1_amd64.deb", 274094,
     "6576bd85cdf314da2cc14a9f7a8797c2f6a0ee6864c784eda14a783f96c6716c"),
    ("libncurses-dev.deb", "https://archive.ubuntu.com/ubuntu/pool/main/n/ncurses/libncurses-dev_6.4+20240113-1ubuntu2.2_amd64.deb", 384098,
     "2c32ce182e90e6636ddb037ba2810cace9e1f076b13fac89034277d8ba943c38"),
]
STOP = 0
DOWNLOAD_WORKER = r'''
import json,sys,urllib.parse,urllib.request
url,path,limit=sys.argv[1],sys.argv[2],int(sys.argv[3])
request=urllib.request.Request(url,headers={"User-Agent":"AgentBridge-isolated-tmux30-measurement"})
with urllib.request.urlopen(request,timeout=15) as response, open(path,"xb") as output:
    host=urllib.parse.urlparse(response.geturl()).hostname
    if host not in ("github.com","release-assets.githubusercontent.com","archive.ubuntu.com"):
        raise RuntimeError("unexpected_download_host")
    received=0
    while True:
        block=response.read1(65536)
        if not block: break
        received+=len(block)
        if received>limit: raise RuntimeError("archive_size_exceeded")
        output.write(block)
print(json.dumps({"final_host":host,"received":received}))
'''


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def emit(value):
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


def request_stop(signum, _frame):
    global STOP
    STOP = STOP or signum


def children():
    return [int(p) for p in Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()]


def reap_all():
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False


def stop_children():
    signals = []
    deadline = time.monotonic() + 5
    while not reap_all() and time.monotonic() < deadline:
        for pid in children():
            fd = None
            try:
                fd = os.pidfd_open(pid, 0)
                os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                signals.append(pid)
            except (ProcessLookupError, ChildProcessError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        time.sleep(0.02)
    return {"echild": reap_all(), "fallback_signals": signals}


def download(root, name, url, size, expected, env):
    require(not STOP, "interrupted")
    path = root / name
    # A separate owned process bounds DNS, headers, redirects, chunk framing,
    # and body together. Socket inactivity timeouts alone do not do that.
    worker = run(root, "download-" + name,
                 [sys.executable, "-c", DOWNLOAD_WORKER, url, str(path), str(size)], root, env, 60)
    require(worker["exit_code"] == 0 and worker["termination"] == "exit"
            and worker["cleanup"]["echild"] and not worker["cleanup"]["fallback_signals"], "download_failed")
    require(path.is_file() and path.stat().st_size == size, "archive_size_mismatch")
    metadata = json.loads((root / ("download-" + name + ".log")).read_text())
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    require(len(data) == size, "archive_size_mismatch")
    require(expected is None or digest == expected, "archive_hash_mismatch")
    return {"name": name, "source_url": url, "final_host": metadata["final_host"], "bytes": len(data),
            "sha256": digest, "expected_sha256": expected,
            "upstream_digest_available": expected is not None, "worker": worker}, data


def extract_checked(data, destination, *, compression):
    destination.mkdir(mode=0o700)
    require(hasattr(tarfile, "data_filter"), "safe_tar_filter_required")
    with tarfile.open(fileobj=io.BytesIO(data), mode=compression) as archive:
        members = archive.getmembers()
        require(len(members) <= 5000 and sum(max(0, m.size) for m in members) <= 64 * 1024 * 1024,
                "archive_unpacked_size_exceeded")
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and ".." not in path.parts and len(member.name) < 4096,
                    "unsafe_archive_path")
            require(member.isdir() or member.isfile() or member.issym() or member.islnk(),
                    "unsafe_archive_entry_type")
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                require(not target.is_absolute(), "absolute_archive_link")
                resolved = (destination / str(path.parent if member.issym() else PurePosixPath("."))
                            / str(target)).resolve()
                require(resolved.is_relative_to(destination.resolve()), "escaping_archive_link")
            # Validate every entry before any extraction. The data filter also
            # rechecks actual resolved paths while writing, including symlinks.
            tarfile.data_filter(member, str(destination))
        archive.extractall(destination, filter="data")
    return {"members": len(members), "declared_bytes": sum(max(0, m.size) for m in members),
            "all_paths_checked_before_extraction": True}


def run(root, name, argv, cwd, env, seconds):
    require(not STOP and reap_all(), "unexpected_child_or_interrupted_before_command")
    log_path = root / (name + ".log")
    started = time.monotonic()
    with log_path.open("xb") as output:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        termination = "exit"
        while process.poll() is None:
            if STOP or time.monotonic() - started > seconds or log_path.stat().st_size > 5 * 1024 * 1024:
                termination = "interrupted_or_limit"
                fd = os.pidfd_open(process.pid, 0)
                try:
                    os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                finally:
                    os.close(fd)
                break
            time.sleep(0.05)
        try:
            code = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            code = None
    natural_end = time.monotonic() + 0.5
    while not reap_all() and time.monotonic() < natural_end:
        time.sleep(0.02)
    clean = reap_all()
    cleanup = {"echild": True, "fallback_signals": []} if clean else stop_children()
    log_bytes = log_path.stat().st_size
    if log_bytes > 5 * 1024 * 1024:
        termination = "output_limit"
    with log_path.open("rb") as source:
        source.seek(max(0, log_bytes - 12000))
        tail = source.read(12000)
    digest = None
    if log_bytes <= 5 * 1024 * 1024 and cleanup["echild"]:
        hasher = hashlib.sha256()
        with log_path.open("rb") as source:
            remaining = 5 * 1024 * 1024
            while remaining:
                block = source.read(min(65536, remaining))
                if not block:
                    break
                hasher.update(block)
                remaining -= len(block)
        digest = hasher.hexdigest()
    row = {"name": name, "argv": argv, "exit_code": code, "termination": termination,
           "elapsed_ms": round((time.monotonic() - started) * 1000, 3), "cleanup": cleanup,
           "log_bytes": log_bytes, "log_sha256": digest,
           "log_tail": tail.decode("utf-8", errors="replace")}
    return row


def main():
    report = {"kind": "tmux30_private_build", "downloads": [], "extracts": [], "commands": [],
              "build_passed": False, "root_retained_for_probe": True}
    root = None
    try:
        require(sys.platform == "linux", "linux_required")
        libc = ctypes.CDLL(None, use_errno=True)
        require(libc.prctl(36, 1, 0, 0, 0) == 0 and not children(), "subreaper_required")
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, request_stop)
        root = Path("/tmp") / ("ab-m1-tmux30-" + uuid.uuid4().hex)
        require(not os.path.lexists(root), "root_not_absent")
        original_umask = os.umask(0o077)
        try:
            root.mkdir(mode=0o700)
        finally:
            os.umask(original_umask)
        owner = root.lstat()
        require(stat.S_ISDIR(owner.st_mode) and owner.st_uid == os.getuid()
                and stat.S_IMODE(owner.st_mode) == 0o700, "invalid_root_owner")
        report["root"] = str(root)
        report["owner"] = {"uid": owner.st_uid, "device": owner.st_dev, "inode": owner.st_ino}
        marker = root / "owner.json"
        marker.write_text(json.dumps({"root": str(root), **report["owner"]}), encoding="utf-8")
        emit({"kind": "build_start", "root": str(root), "owner": report["owner"]})
        env = dict(os.environ)
        for key in ("TMUX", "TMUX_PANE", "TMUX_TMPDIR"):
            env.pop(key, None)
        env["LC_ALL"] = "C"
        for name, url, size, expected in SOURCES:
            row, data = download(root, name, url, size, expected, env)
            report["downloads"].append(row)
            if name.endswith(".deb"):
                process = subprocess.run(["/usr/bin/dpkg-deb", "--fsys-tarfile", str(root / name)],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         timeout=5, env=env)
                require(process.returncode == 0 and not process.stderr and len(process.stdout) <= 64 * 1024 * 1024,
                        "deb_unpack_failed")
                extracted = extract_checked(process.stdout, root / name.removesuffix(".deb"), compression="r:")
            else:
                extracted = extract_checked(data, root / "source", compression="r:gz")
            report["extracts"].append({"name": name, **extracted})
        source = root / "source" / "tmux-3.0"
        require((source / "configure").is_file() and (source / "cmd-parse.c").is_file(),
                "release_generated_files_missing")
        report["release_configure_version_line"] = next(
            line for line in (source / "configure").read_text().splitlines() if line.startswith("PACKAGE_VERSION="))
        require(report["release_configure_version_line"] == "PACKAGE_VERSION='3.0'", "release_version_not_3_0")
        event = root / "libevent-dev" / "usr"
        curses = root / "libncurses-dev" / "usr"
        event_lib = event / "lib" / "x86_64-linux-gnu"
        curses_lib = curses / "lib" / "x86_64-linux-gnu"
        env["CPPFLAGS"] = f"-I{event}/include -I{curses}/include -I{curses}/include/ncursesw"
        # Static development archives avoid broken private .so symlinks and
        # do not require any system linker configuration or LD_LIBRARY_PATH.
        env["LIBEVENT_CFLAGS"] = f"-I{event}/include"
        env["LIBEVENT_LIBS"] = str(event_lib / "libevent.a")
        env["LIBNCURSES_CFLAGS"] = f"-I{curses}/include"
        env["LIBNCURSES_LIBS"] = str(curses_lib / "libncurses.a") + " " + str(curses_lib / "libtinfo.a")
        report["build_environment_overrides"] = {k: env[k] for k in
            ("CPPFLAGS", "LIBEVENT_CFLAGS", "LIBEVENT_LIBS", "LIBNCURSES_CFLAGS", "LIBNCURSES_LIBS")}
        commands = [("configure", ["./configure", "--prefix=" + str(root / "unused-prefix"),
                                   "--sysconfdir=" + str(root / "unused-config")], 90),
                    ("make", ["/usr/bin/make", "-j", "2"], 180),
                    ("version", [str(source / "tmux"), "-V"], 5)]
        for name, argv, seconds in commands:
            row = run(root, name, argv, source, env, seconds)
            report["commands"].append(row)
            require(row["exit_code"] == 0 and row["termination"] == "exit"
                    and row["cleanup"]["echild"] and not row["cleanup"]["fallback_signals"], name + "_failed")
        require((root / "version.log").read_bytes() == b"tmux 3.0\n", "built_binary_version_mismatch")
        binary = source / "tmux"
        report["binary"] = {"path": str(binary), "bytes": binary.stat().st_size,
                            "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
        report["build_passed"] = True
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        report["final_process_cleanup"] = stop_children() if root is not None else {"echild": True, "fallback_signals": []}
        emit(report)
    return 0 if report["build_passed"] and report["final_process_cleanup"]["echild"] and not STOP else 1


if __name__ == "__main__":
    sys.exit(main())
