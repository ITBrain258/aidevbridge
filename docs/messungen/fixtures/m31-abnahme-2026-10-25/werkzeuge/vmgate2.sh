#!/bin/bash
# Wie vmgate.sh vom M1-Tor, aber mit den Panes mehrerer Sockets (ohne Titel):
# alle ~0,3 s die interaktiven Claude-Zeilen (pid, PPid, status, waitingFor) und je
# Session pane_pid; Zeile bei Aenderung.
# Usage: vmgate2.sh "<socket> <socket>" <ausgabe> <sekunden>
socks=$1 out=$2 dur=$3
end=$(( $(date +%s) + dur ))
last_a= last_p=
export PATH="$HOME/.local/bin:$PATH"
while [ "$(date +%s)" -lt "$end" ]; do
  ts=$(date +%s.%N)
  a=$(DISABLE_AUTOUPDATER=1 claude agents --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let rows=[];try{rows=JSON.parse(s)}catch{}
    const fs=require("fs");const ppid=(p)=>{try{return +fs.readFileSync("/proc/"+p+"/status","utf8").match(/PPid:\s+(\d+)/)[1]}catch{return null}};
    console.log(JSON.stringify(rows.filter(r=>r.kind==="interactive").map(r=>[r.pid,ppid(r.pid),r.status??null,r.waitingFor??null])))})')
  if [ "$a" != "$last_a" ]; then printf 'A %s %s\n' "$ts" "$a" >>"$out"; last_a=$a; fi
  p=$(for s in $socks; do tmux -u -L "$s" list-panes -a -F '#{session_name} #{pane_pid} #{pane_active}' 2>/dev/null; done | tr '\n' '|')
  if [ "$p" != "$last_p" ]; then printf 'P %s %s\n' "$ts" "$p" >>"$out"; last_p=$p; fi
  sleep 0.2
done
printf 'E %s\n' "$(date +%s.%N)" >>"$out"
