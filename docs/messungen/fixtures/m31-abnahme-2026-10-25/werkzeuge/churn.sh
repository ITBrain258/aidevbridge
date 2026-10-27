#!/bin/bash
# Legt auf dem Testsocket <sock> <sekunden> lang alle ~0,2 s eine Session zz an und beendet sie wieder.
sock=$1; end=$(( $(date +%s) + $2 )); i=0
while [ "$(date +%s)" -lt "$end" ]; do
  i=$((i+1)); tmux -L "$sock" new -d -s "zz$i" -c /tmp; sleep 0.1; tmux -L "$sock" kill-session -t "=zz$i"; sleep 0.1
done
echo "churn fertig nach $i Runden"
