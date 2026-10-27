#!/bin/bash
# Messung 2026-10-26, Ergaenzung zu cwd-format-measure.sh: Wie oft fuehrt
# der Ordner '#(touch MARK)' den Befehl aus, roh und in der App-Form?
#
# Usage: bash cwd-format-job-count.sh <tmux-binary> <leeres Arbeitsverzeichnis> [n]
#
# tmux haengt einen Format-Job an den Client, der new-session schickt, und
# beendet den Job, sobald dieser Client geht (format_lost_client). Mit -d
# geht der Client sofort; ob touch vorher fertig wird, entscheidet das
# Timing. Ein einzelner Lauf sagt deshalb nichts, gezaehlt werden n Laeufe.
#
# Socket wie in cwd-format-measure.sh: nur relativ (-S ./s), nie -L, nie der
# Standard-Socket.
set -u
TMUX_BIN=$1
W=$2
N=${3:-10}
cd "$W" || exit 1
unset TMUX TMUX_PANE
mkdir -p home d
export HOME="$W/home"
T() { "$TMUX_BIN" -S ./s -f /dev/null "$@"; }

name='#(touch MARK)'
mkdir -p "d/$name"
dir="$W/d/$name"
echo "version: $("$TMUX_BIN" -V)"
for form in roh app; do
    case $form in
        roh) arg=$dir ;;
        # Kein '#' vor '[': die App-Form ist hier jedes '#' verdoppelt.
        app) arg=${dir//\#/##} ;;
    esac
    hits=0
    for _ in $(seq "$N"); do
        rm -f s
        find "$W" -name MARK -exec rm -f {} +
        T new-session -d -s t -c "$arg" 'sleep 30'
        sleep 1
        if [ -n "$(find "$W" -name MARK)" ]; then hits=$((hits + 1)); fi
        T kill-server 2>/dev/null
        rm -f s
    done
    printf '%s\t%s\tMARK in %d von %d Laeufen\n' "$name" "$form" "$hits" "$N"
done
find "$W" -name MARK -exec rm -f {} +
