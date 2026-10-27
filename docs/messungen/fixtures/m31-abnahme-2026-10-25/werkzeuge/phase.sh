#!/bin/bash
# Ein Messdurchgang unter Last: Fluten in f3 f4 r2 r3, Claude in den genannten Sessions,
# je Runde eine Freigabe pro Session (Write-Werkzeug), abgelehnt mit Esc.
# Usage: [SOCK=<testsocket>] [FLOOD="<sessions>"] HOST=<vm> phase.sh <name> <runden> <session...>
#        (abnahme = Standard-Socket, sonst Testsocket; Nachmessung: SOCK=abtest_20261027_m31 FLOOD="f1 f2 f3 f4")
here=$(cd "$(dirname "$0")" && pwd); M=${OUT:-$PWD}  # Ausgaben ins aktuelle Verzeichnis
W=$here/../../m1-tor-2026-10-23/werkzeuge
export PATH="/c/Program Files/nodejs:$PATH" MSYS_NO_PATHCONV=1
S=${SOCK:-abtest_20261025_m31}; FLOOD=${FLOOD:-"f3 f4 r2 r3"}; name=$1; rounds=$2; shift 2
V() { bash $here/vm.sh ${HOST:?HOST setzen} "$1"; }
sockf() { [ "$1" = abnahme ] && echo "" || echo "-L $S"; }
dur=$(( 60 + rounds * $# * 22 ))
rm -f $M/page-$name.jsonl $M/net-$name.jsonl
node $here/netpoll.mjs 9333 $M/net-$name.jsonl $dur & node $W/pagesamp.mjs 9333 $M/page-$name.jsonl $dur &
V "rm -f /tmp/abnahme-m31/vmgate-$name.txt; nohup /tmp/abnahme-m31/vmgate2.sh 'default $S' /tmp/abnahme-m31/vmgate-$name.txt $dur >/dev/null 2>&1 & for s in $FLOOD; do tmux -L $S send-keys -t \"=\$s:\" -l yes; tmux -L $S send-keys -t \"=\$s:\" Enter; done"
for s in "$@"; do V "tmux $(sockf $s) send-keys -t =$s: -l 'clear; DISABLE_AUTOUPDATER=1 ~/.local/bin/claude --model haiku --permission-mode default'; tmux $(sockf $s) send-keys -t =$s: Enter"; done
for s in "$@"; do node $W/gate.mjs 9333 waitrow vm20 $s idle 40000; done; sleep 4
for k in $(seq 1 $rounds); do
  for s in "$@"; do
    V "tmux $(sockf $s) send-keys -t =$s: -l 'Use the Write tool to create the file /tmp/abnahme-m31/w/$name-$s-$k.txt containing the single word x. Do nothing else.'; sleep 0.3; tmux $(sockf $s) send-keys -t =$s: Enter"
    node $W/gate.mjs 9333 waitrow vm20 $s waiting 45000
    sleep 3; V "tmux $(sockf $s) send-keys -t =$s: Escape"
    node $W/gate.mjs 9333 waitrow vm20 $s idle 30000; sleep 4
  done
done
V "for s in $FLOOD; do tmux -L $S send-keys -t \"=\$s:\" C-c; done"
for s in "$@"; do V "tmux $(sockf $s) send-keys -t =$s: -l '/exit'; sleep 0.3; tmux $(sockf $s) send-keys -t =$s: Enter"; done
sleep 3; V "for p in \$(pgrep -u \$(id -u) -f '^/bin/bash /tmp/abnahme-m31/vmgate2.sh'); do kill \$p; done; cat /tmp/abnahme-m31/vmgate-$name.txt" > $M/vmgate-$name.txt
kill %1 %2 2>/dev/null; wait 2>/dev/null
node $W/clock.mjs $here/vm.sh ${HOST:?HOST setzen} > $M/clock-$name.json
echo "fertig $name: $(wc -l < $M/vmgate-$name.txt) VM-Zeilen, $(wc -l < $M/page-$name.jsonl) Seitenzeilen, $(wc -l < $M/net-$name.jsonl) Abfragen"
