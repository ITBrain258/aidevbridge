#!/bin/bash
# Zustand des tmux-Servers auf dem Standard-Socket, nur lesend.
# Usage: snap.sh <name>        schreibt /tmp/abnahme-m31/<name>.txt (bleibt auf der VM)
#                              und gibt je Abschnitt Zeilen und SHA-256 aus, ohne Werte
#        snap.sh diff <a> <b>  vergleicht; Umgebungswerte werden maskiert
d=/tmp/abnahme-m31
if [ "$1" = diff ]; then
  if diff -q "$d/$2.txt" "$d/$3.txt" >/dev/null; then echo "gleich ($2 = $3)"; exit 0; fi
  diff "$d/$2.txt" "$d/$3.txt" | sed -E 's/^([<>] ENV-[^ ]* [A-Za-z_][A-Za-z0-9_]*)=.*/\1=<Wert>/'
  exit 1
fi
out="$d/$1.txt"
sec() { echo "## $1"; shift; "$@" 2>&1; }
{
  sec "server" tmux display -p -t "$(tmux ls -F '#{session_name}' | head -1)" '#{pid} #{start_time} #{version}'
  sec "sessions" tmux ls -F '#{session_name} #{session_id} #{session_windows} #{session_created} #{session_group}'
  sec "show -g" tmux show -g
  sec "show -gw" tmux show -gw
  sec "show -s" tmux show -s
  sec "show-hooks -g" tmux show-hooks -g
  echo "## show-environment -g"; tmux show-environment -g 2>&1 | sed 's/^/ENV-g /'
  for s in $(tmux ls -F '#{session_name}'); do
    sec "show -t $s" tmux show -t "=$s"
    sec "show -w -t $s" tmux show -w -t "=$s:"
    sec "show-hooks -t $s" tmux show-hooks -t "=$s"
    echo "## show-environment -t $s"; tmux show-environment -t "=$s" 2>&1 | sed "s/^/ENV-$s /"
  done
} > "$out"
node -e '
const fs=require("fs"),c=require("crypto");
for (const s of fs.readFileSync(process.argv[1],"utf8").split(/^## /m).filter(Boolean)) {
  const [h,...rest]=s.split("\n"); const body=rest.filter(Boolean);
  const names=h.startsWith("show-environment")?" "+body.map(l=>l.split(" ")[1].replace(/=.*/,"")).join(","):"";
  console.log(`${h}: ${body.length} Zeilen sha256=${c.createHash("sha256").update(body.join("\n")).digest("hex").slice(0,16)}${names}`);
}' "$out"
