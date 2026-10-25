#!/bin/bash
# Messung Plan M3.1, Schritt 1a: der Waechter zum Anhaengen mit und ohne
# attach-session -E, nur auf dem eigenen Testsocket. Usage: bash -s <tag>
set -u
S=abtest_20261025_guard
D=/tmp/abtest_20261025_guard
mkdir -p "$D"
MARK="$D/marker"
printf 'run-shell "touch %s"\n' "$MARK" > "$D/conf"
T() { tmux -L "$S" "$@"; }
REJECT="list-commands -F '#{?#{==:#{command_list_name},display-message},AB_M1_REJECT,}'"

envsnap() {
  T show-environment -t g1 2>&1 | grep -E '^-?(SSH_AUTH_SOCK|SSH_CONNECTION|DISPLAY)(=|$)' | sort | tr '\n' ' '
}

# $1: "-E" oder "", $2: "ok" oder "wrong" (falsche Pane-PID), $3: Extra-Argumente fuer tmux (-f conf)
write_guard() {
  local flags=$1 mode=$2 extra=${3:-}
  local pid st sid wid paneid ppid
  read -r pid st sid wid paneid ppid <<<"$(T display -p -t g1 '#{pid} #{start_time} #{session_id} #{window_id} #{pane_id} #{pane_pid}' 2>/dev/null)"
  if [ -z "${pid:-}" ]; then pid=1; st=1; sid='$0'; wid='@0'; paneid='%0'; ppid=1; fi
  [ "$mode" = wrong ] && ppid=$((ppid + 99999))
  local test="#{==:#{pid}/#{start_time}/#{session_id}/#{window_id}/#{pane_id}/#{pane_pid}/#{window_active}/#{pane_active}/#{pane_dead},$pid/$st/$sid/$wid/$paneid/$ppid/1/1/0}"
  local sid_esc=${sid//\$/\\\$}
  local action="attach-session${flags:+ $flags} -t '$sid_esc'"
  printf '%s\n' "exec env -u DISPLAY TERM=xterm-256color SSH_AUTH_SOCK=/tmp/client-sock SSH_CONNECTION='client conn' LC_ALL=C tmux -u -L $S $extra if-shell -F -t '$sid' '$test' \"$action\" \"$REJECT\"" > "$D/cmd.sh"
}

run_guard() {
  # Eine leere, offene Eingabe: sonst tippte der angehaengte Client den Rest
  # dieses Skripts (bash -s) samt Dateiende in die Session.
  sleep 4 | script -qfec "bash $D/cmd.sh" /dev/null > "$D/out" 2>&1 &
  local child=$!
  sleep 1.5
  echo "clients=$(T list-clients -t g1 2>/dev/null | wc -l) sessions=[$(T list-sessions -F '#S' 2>&1 | tr '\n' ' ')] env=[$(envsnap)]"
  echo "    raw=[$(T show-environment -t g1 2>&1 | grep -E 'SSH_AUTH|SSH_CONN|DISPLAY|rror|no ' | tr '\n' ' ' | cut -c1-140)] out=[$(tr -d '\r' < "$D/out" | tr -cd '[:print:]' | tail -c 120)]"
  T detach-client -s g1 2>/dev/null
  sleep 0.5
  kill "$child" 2>/dev/null
  wait "$child" 2>/dev/null
}

T kill-server 2>/dev/null
rm -f "$MARK"
echo "tmux $(tmux -V | cut -d' ' -f2)"
env SSH_AUTH_SOCK=/tmp/server-sock SSH_CONNECTION='server conn' DISPLAY=:9 tmux -L "$S" -f /dev/null new-session -d -s g1
echo "vorher:            env=[$(envsnap)]"
write_guard "-E" ok;    printf 'mit -E, passend:   '; run_guard
write_guard "-E" wrong; printf 'mit -E, falsch:    '; run_guard
write_guard ""   ok;    printf 'ohne -E, passend:  '; run_guard
T kill-server 2>/dev/null
sleep 1; rm -f "/tmp/tmux-$(id -u)/$S"
write_guard "-E" ok "-f $D/conf"
echo "socket vorher: $([ -e "/tmp/tmux-$(id -u)/$S" ] && echo da || echo fehlt)"
printf 'mit -E, kein Server: '
bash "$D/cmd.sh" > "$D/out" 2>&1 < /dev/null
echo "exit=$? out=[$(tr '\n' ' ' < "$D/out" | cut -c1-80)] marker=$([ -e "$MARK" ] && echo ANGELEGT || echo fehlt) socket=$([ -e "/tmp/tmux-$(id -u)/$S" ] && echo da || echo fehlt)"
T kill-server 2>/dev/null
rm -rf "$D" "/tmp/tmux-$(id -u)/$S"
echo "aufgeraeumt: $(ls /tmp/tmux-$(id -u)/ | tr '\n' ' ')"
