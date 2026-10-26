#!/bin/bash
# Messung 2026-10-26: Wertet tmux das Argument von `new-session -c` als Format
# aus, und welche Schreibweise ergibt den Ordner wortwoertlich?
#
# Usage: bash cwd-format-measure.sh <tmux-binary> <leeres Arbeitsverzeichnis>
#
# Formen je Ordner:
#   roh         der Pfad unveraendert
#   verdoppelt  jedes '#' verdoppelt
#   app         jedes '#' verdoppelt, ausser einer '#'-Folge direkt vor '['
#               (die Regel von session_binding.rs::escape_cwd_format)
#
# Nur ein privater Socket ueber einen RELATIVEN Pfad (-S ./s) im
# Arbeitsverzeichnis: absolute Pfade im Scratch-Ordner sprengen die
# Laengengrenze fuer Socketpfade. Kein -L, nie der Standard-Socket.
# Ein Format-Job (#(...)) laeuft im Ordner des Clients; HOME zeigt auf einen
# eigenen Unterordner, damit der Rueckfall auf HOME sichtbar ist und MARK im
# Arbeitsverzeichnis bleibt.
set -u
TMUX_BIN=$1
W=$2
cd "$W" || exit 1
unset TMUX TMUX_PANE
mkdir -p home d
export HOME="$W/home"
T() { "$TMUX_BIN" -S ./s -f /dev/null "$@"; }

echo "version: $("$TMUX_BIN" -V)"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' fall form argv session_path pane_current_path MARK
for name in '#(touch MARK)' 'C#Project' 'A#{session_name}B' 'trail#' 'D####Q' \
    'E#[x]' 'F##[x]' 'G#(touch MARK)#[y]'; do
    mkdir -p "d/$name"
    dir="$W/d/$name"
    for form in roh verdoppelt app; do
        case $form in
            roh) arg=$dir ;;
            verdoppelt) arg=${dir//\#/##} ;;
            app) arg=$(printf '%s' "$dir" | sed -E 's/(#+)([^#[]|$)/\1\1\2/g') ;;
        esac
        rm -f s
        find "$W" -name MARK -exec rm -f {} +
        T new-session -d -s t -c "$arg" 'sleep 30'
        # Format-Jobs laufen asynchron; ohne Pause fehlte MARK auch beim Fehler.
        sleep 1
        sp=$(T display -p -t t '#{session_path}' 2>&1)
        pp=$(T display -p -t t '#{pane_current_path}' 2>&1)
        if [ -n "$(find "$W" -name MARK)" ]; then mark=ja; else mark=nein; fi
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$form" "${arg//$W/<W>}" \
            "${sp//$W/<W>}" "${pp//$W/<W>}" "$mark"
        T kill-server 2>/dev/null
        rm -f s
    done
done
find "$W" -name MARK -exec rm -f {} +
