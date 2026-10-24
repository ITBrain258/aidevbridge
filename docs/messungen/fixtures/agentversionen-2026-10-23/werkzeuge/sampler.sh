#!/bin/bash
# Lesender Sampler fuer eine Session auf einem eigenen Testsocket.
# Usage: sampler.sh <socket> <session> <ausgabe> <sekunden> [claude]
# Zeilen (Zeitstempel in Sekunden seit Epoche, VM-Uhr):
#   T <ts> <titel-hex>                    bei jeder Aenderung des Panetitels
#   P <ts> <ebene> <pid> <comm> <exe>     Prozessbaum unter der Pane-Shell, bei Aenderung
#   A <ts> <json>                         claude agents --json, bei Aenderung (nur mit "claude")
#   S <ts> <bildschirm-hex>               letzte 25 Zeilen der Pane, bei Aenderung
sock=$1 sess=$2 out=$3 dur=$4 withclaude=$5
end=$(( $(date +%s) + dur ))
last_t= last_p= last_a= last_s=
export PATH="$HOME/.local/bin:$PATH"
while [ "$(date +%s)" -lt "$end" ]; do
  ts=$(date +%s.%N)
  ppid=$(tmux -L "$sock" display-message -p -t "$sess" '#{pane_pid}' 2>/dev/null) || break
  t=$(tmux -u -L "$sock" display-message -p -t "$sess" '#{pane_title}' 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
  if [ "$t" != "$last_t" ]; then printf 'T %s %s\n' "$ts" "$t" >>"$out"; last_t=$t; fi
  p=
  for c in $(cat /proc/"$ppid"/task/*/children 2>/dev/null); do
    p="$p|1 $c $(cat /proc/$c/comm 2>/dev/null) $(readlink /proc/$c/exe 2>/dev/null)"
    for g in $(cat /proc/"$c"/task/*/children 2>/dev/null); do
      p="$p|2 $g $(cat /proc/$g/comm 2>/dev/null) $(readlink /proc/$g/exe 2>/dev/null)"
    done
  done
  if [ "$p" != "$last_p" ]; then
    printf '%s\n' "$p" | tr '|' '\n' | sed '/^$/d' | while read -r lvl pid comm exe; do
      printf 'P %s %s %s %s %s\n' "$ts" "$lvl" "$pid" "$comm" "$exe" >>"$out"
    done
    [ -z "$p" ] && printf 'P %s 0 - - -\n' "$ts" >>"$out"
    last_p=$p
  fi
  if [ -n "$withclaude" ]; then
    a=$(DISABLE_AUTOUPDATER=1 claude agents --json 2>/dev/null | tr -d '\n')
    if [ "$a" != "$last_a" ]; then printf 'A %s %s\n' "$ts" "$a" >>"$out"; last_a=$a; fi
  fi
  s=$(tmux -L "$sock" capture-pane -p -t "$sess" -S -25 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
  if [ "$s" != "$last_s" ]; then printf 'S %s %s\n' "$ts" "$s" >>"$out"; last_s=$s; fi
  sleep 0.25
done
printf 'E %s\n' "$(date +%s.%N)" >>"$out"
