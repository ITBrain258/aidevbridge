#!/bin/bash
# VM-Seite der Lastmessung auf 192.0.2.20, aufgerufen ueber vm.ps1 (Skript auf stdin):
#   ssh ... bash -s -- <socket> setup|go <L1|L2> <namen...>|state|info|check|logs <datei>|cleanup
# Fasst nur den eigenen Socket abtest_<datum>_acht und den Ordner /tmp/<socket> an.
set -eu
S=$1
shift
[[ $S =~ ^abtest_[0-9]{8}_acht$ ]] || { echo "fremder Socket: $S" >&2; exit 2; }
D=/tmp/$S
t() { tmux -L "$S" "$@"; }
case $1 in
  setup)
    mkdir -p "$D"
    cat > "$D/flood.sh" <<'EOF'
# Flut einer Kachel: wartet auf go.<name>; der Inhalt (L1 oder L2) waehlt die Last.
d=$(dirname "$0"); n=$1
while :; do
  while [ ! -e "$d/go.$n" ]; do sleep 0.2; done
  m=$(cat "$d/go.$n"); rm -f "$d/go.$n"
  echo "$(date +%s%3N) start $n $m" >> "$d/flood.log"
  case $m in
    L1) timeout --foreground 180 sh -c 'while :; do head -c 15000 /dev/urandom | base64 -w 76; sleep 0.1; done' ;;
    L2) timeout --foreground 120 yes ;;
  esac
  echo "$(date +%s%3N) stop $n $m" >> "$d/flood.log"
done
EOF
    cat > "$D/probe.py" <<'EOF'
# Statusprobe: nennt sich grok (prctl) und wechselt den OSC-2-Titel alle 7,3 s zwischen
# einer gemessenen Busy- und Idle-Form (src-tauri/src/status/title.rs); jeder Wechsel
# steht mit Millisekunden in probe.log.
import ctypes, sys, time
ctypes.CDLL(None).prctl(15, b"grok", 0, 0, 0)
busy = chr(0x2834) + " - Thinking - probe - grok"
while True:
    for title, kind in ((busy, "busy"), ("probe - grok", "idle")):
        sys.stdout.buffer.write((chr(27) + "]2;" + title + chr(7)).encode())
        sys.stdout.flush()
        with open(sys.argv[1], "a") as f:
            print(int(time.time() * 1000), kind, file=f)
        time.sleep(7.3)
EOF
    # Dieselben Serveroptionen wie prepare_server (src-tauri/src/tmux/client.rs:368-385).
    t start-server \; set -g exit-empty off
    t set -g history-limit 10000
    t setw -g remain-on-exit on
    t set -ga terminal-overrides ',*:smcup@:rmcup@'
    for n in f1 f2 f3 f4 f5 f6 f7 f8 p1 b1 x1 x2; do t new-session -d -s "$n" -c "$D"; done
    t set -g exit-empty on
    for n in f1 f2 f3 f4 f5 f6 f7 f8; do t send-keys -t "=$n:" "sh $D/flood.sh $n" Enter; done
    t send-keys -t "=p1:" "python3 $D/probe.py $D/probe.log" Enter
    t list-sessions -F '#{session_name}' ;;
  go)
    m=$2
    shift 2
    for n in "$@"; do echo "$m" > "$D/.go.$n"; done
    for n in "$@"; do mv "$D/.go.$n" "$D/go.$n"; done
    date +%s%3N ;;
  state)
    date +%s%3N
    cat /proc/loadavg
    t list-clients -F '#{client_pid} #{client_created} #{session_name} #{client_width}x#{client_height}' | sort -k3 ;;
  info)
    tmux -V
    echo "nproc $(nproc), Kernel $(uname -r), $(. /etc/os-release && echo "$PRETTY_NAME")"
    cat /proc/loadavg
    grep -rhi '^[[:space:]]*MaxSessions' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null || echo 'MaxSessions nicht gesetzt (Vorgabe 10)'
    echo "SSH-Verbindungen auf Port 22: $(ss -Htn state established '( sport = :22 )' | wc -l)"
    export PATH="$HOME/.local/bin:$PATH" DISABLE_AUTOUPDATER=1
    claude --version 2>&1 | head -1 || true
    a=$(date +%s%3N)
    claude agents --json > /dev/null 2>&1 || true
    echo "claude agents --json: $(( $(date +%s%3N) - a )) ms" ;;
  check)
    p=$(t display-message -p -t "=p1:" '#{pane_pid}')
    echo "p1: Titel '$(t display-message -p -t "=p1:" '#{pane_title}')', Kinder der Pane-Shell $p:"
    for c in $(cat /proc/"$p"/task/*/children); do echo "  $c $(cat /proc/"$c"/comm)"; done
    echo "wartende Fluten: $(pgrep -fc "$D/flood.sh") von 8" ;;
  logs)
    cat "$D/$2" ;;
  cleanup)
    t kill-server 2> /dev/null || true
    rm -f "/tmp/tmux-$(id -u)/$S"
    rm -rf -- "$D"
    sleep 1
    pgrep -af "$D/" || echo "kein Prozess aus $D mehr"
    ls -la "/tmp/tmux-$(id -u)/" ;;
  *)
    echo "unbekannter Befehl: $1" >&2
    exit 2 ;;
esac
