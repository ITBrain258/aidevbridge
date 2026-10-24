#!/bin/bash
# Hilfen auf der VM fuer das M1-Tor, nur auf dem eigenen App-Socket <sock>.
# Usage: vmhelp.sh <sock> <befehl> [args]
#   mk <name...>          Sessions in /tmp anlegen (Server richtet die App beim ersten Anlegen ein)
#   keys <session> <text> Text tippen und Enter (wie von Hand in der Pane)
#   raw <session> <key>   eine Taste (C-c, Escape, Enter, 1 ...)
#   screen <session> [n]  letzte n Zeilen der Pane
#   winch <session>       Zahl der WINCH-Zeilen in Bildschirm und Verlauf
#   control               sshd-session der Kontrollverbindung: ihre Kinder fragen den Socket ab
#   procs                 Prozesse des Kontos ausserhalb von tmux-Panes, die zum Socket gehoeren
#   clients               tmux list-clients mit tty und Startzeit
sock=$1; cmd=$2; shift 2
case $cmd in
  mk) for n in "$@"; do tmux -L "$sock" new-session -d -s "$n" -c /tmp && echo "angelegt $n"; done ;;
  keys) tmux -L "$sock" send-keys -t "=$1:" -l "$2" && sleep 0.3 && tmux -L "$sock" send-keys -t "=$1:" Enter ;;
  raw) tmux -L "$sock" send-keys -t "=$1:" "$2" ;;
  screen) tmux -L "$sock" capture-pane -p -t "=$1:" | sed '/^\s*$/d' | tail -"${2:-15}" ;;
  winch) tmux -L "$sock" capture-pane -p -S -2000 -t "=$1:" | grep -c '^WINCH$' ;;
  control)
    # 4 s lang die Kinder jeder sshd-session des Kontos beobachten; die Kontrollverbindung
    # der App ist die, unter der Befehle mit dem eigenen Socket oder "claude agents" laufen
    # und die keinen tmux-Client (attach) traegt.
    declare -A hit att
    for i in $(seq 1 40); do
      for s in $(pgrep -u "$(id -u)" -f '^sshd(-session)?: .*@notty'); do
        for c in $(pgrep -P "$s"); do
          a=$(tr '\0' ' ' < /proc/$c/cmdline 2>/dev/null)
          case $a in *"$sock"*attach*|*attach*"$sock"*) att[$s]=1 ;; esac
          for g in $(pgrep -P "$c") ; do a="$a $(tr '\0' ' ' < /proc/$g/cmdline 2>/dev/null)"; done
          case $a in *"-L $sock"*|*"claude agents"*|*aidevbridge-panes*) hit[$s]=1 ;; esac
        done
      done
      sleep 0.1
    done
    for s in "${!hit[@]}"; do [ -z "${att[$s]}" ] && echo "$s $(ps -o etimes= -p $s)"; done ;;
  procs) ps -o pid,ppid,etimes,args -u "$(id -u)" | grep -E "$sock|sshd|claude agents|aidevbridge" | grep -v -E "grep|vmhelp|vmgate" ;;
  clients) tmux -L "$sock" list-clients -F '#{client_tty} #{client_created} #{session_name} #{client_width}x#{client_height}' ;;
  *) echo "unbekannt: $cmd" >&2; exit 2 ;;
esac
