#!/bin/bash
# 6 s lang alle 0,2 s: Prozesse unter den sshd-Sitzungen der App (notty = Kontrolle,
# pts = Terminals) und tmux-Clients des App-Sockets; eigene Helfer ausgenommen.
sock=$1
me=$(ps -o ppid= -p $$ | tr -d ' ')
declare -A seen
for i in $(seq 1 30); do
  for s in $(pgrep -u "$(id -u)" -f '^sshd(-session)?: .*@'); do
    # eigene Sitzung (Vorfahre dieses Skripts) auslassen
    p=$$; own=; while [ "$p" -gt 1 ]; do [ "$p" = "$s" ] && own=1 && break; p=$(ps -o ppid= -p $p | tr -d ' '); done
    [ -n "$own" ] && continue
    kids=$(for c in $(pgrep -P $s); do tr '\0' ' ' < /proc/$c/cmdline 2>/dev/null | cut -c1-70; echo; done | sed '/^$/d' | sort | tr '\n' ';')
    case "$kids" in *"$sock"*|*"claude agents"*|*aidevbridge*) ;; *) [ -n "$kids" ] && continue ;; esac
    seen["$(tr '\0' ' ' < /proc/$s/cmdline | cut -c1-40) -> ${kids:-<keine Kinder>}"]=1
  done
  sleep 0.2
done
for k in "${!seen[@]}"; do echo "$k"; done | sort
echo "tmux-Clients des App-Sockets: $(tmux -L "$sock" list-clients 2>/dev/null | wc -l)"
echo "tmux-Server des App-Sockets: $(pgrep -u "$(id -u)" -f "tmux.* -L $sock" | wc -l) Prozess(e) mit -L im Namen"
