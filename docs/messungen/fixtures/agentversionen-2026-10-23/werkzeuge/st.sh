#!/bin/bash
# st.sh <socket> <session>: Uhrzeit, Panetitel und die Claude-Zeile der Pane (pid == pane_pid oder Kind).
S=$1 T=$2
pp=$(tmux -L "$S" display-message -p -t "$T" '#{pane_pid}')
title=$(tmux -L "$S" display-message -p -t "$T" '#{pane_title}')
kids=" $(cat /proc/$pp/task/*/children 2>/dev/null) "
row=$(DISABLE_AUTOUPDATER=1 ~/.local/bin/claude agents --json 2>/dev/null | PP=$pp KIDS="$kids" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const pp=+process.env.PP, kids=process.env.KIDS;
const rows=JSON.parse(s).filter(r=>r.kind==="interactive"&&(r.pid===pp||kids.includes(" "+r.pid+" ")));
console.log(rows.map(r=>r.status+(r.waitingFor?"/"+r.waitingFor:"")).join(",")||"-")})')
printf '%s | %s | %s\n' "$(date +%T.%N | cut -c1-12)" "$title" "$row"
