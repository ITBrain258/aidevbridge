# Measures what `tmux new-session -c` does with a start folder that ends in
# `;`, in the argument form the app sends: an argv of its own, followed by the
# separator `;` and `set -g exit-empty on`, without a shell in between.
#
# Run on the host: sh cwd-semicolon-measure.sh
# It uses one private socket per case (abtest_semicolon_<n>), no configuration
# (-f /dev/null) and the folder /tmp/zz_cwd_semicolon; all of it is removed at
# the end. The pause before the reading gives the pane's shell time to start.
set -u
base=/tmp/zz_cwd_semicolon
rm -rf /tmp/zz_cwd_semicolon
mkdir -p "$base/job;" "$base/job" "$base/a;b" "$base/back\\;" "$base/two;;"
echo "version: $(tmux -V)"
n=0
run() {
  label=$1
  arg=$2
  n=$((n + 1))
  sock=abtest_semicolon_$n
  out=$(tmux -L "$sock" -f /dev/null new-session -d -P -F 'created' -s t -c "$arg" ';' set -g exit-empty on 2>&1)
  code=$?
  sleep 1
  pane=$(tmux -L "$sock" display -p -t t '#{pane_current_path}' 2>&1)
  sess=$(tmux -L "$sock" display -p -t t '#{session_path}' 2>&1)
  tmux -L "$sock" kill-server 2>/dev/null
  printf '%s\n  -c argument : %s\n  exit        : %s (%s)\n  pane        : %s\n  session     : %s\n' \
    "$label" "$arg" "$code" "$out" "$pane" "$sess" | sed "s#$base#<W>#g"
}
run '1 folder "job;", raw'                       "$base/job;"
run '2 folder "job;", backslash before the last' "$base/job\\;"
run '3 folder "a;b", raw (semicolon inside)'     "$base/a;b"
run '4 folder "back\;", raw'                     "$base/back\\;"
run '5 folder "back\;", backslash before the last' "$base/back\\\\;"
run '6 folder "two;;", raw'                      "$base/two;;"
run '7 folder "two;;", backslash before the last' "$base/two;\\;"
run '8 folder "job", raw (control)'              "$base/job"
sleep 1
rm -rf /tmp/zz_cwd_semicolon
rm -f /tmp/tmux-1000/abtest_semicolon_1 /tmp/tmux-1000/abtest_semicolon_2 \
  /tmp/tmux-1000/abtest_semicolon_3 /tmp/tmux-1000/abtest_semicolon_4 \
  /tmp/tmux-1000/abtest_semicolon_5 /tmp/tmux-1000/abtest_semicolon_6 \
  /tmp/tmux-1000/abtest_semicolon_7 /tmp/tmux-1000/abtest_semicolon_8
echo "left over: $(ls -d /tmp/zz_cwd_semicolon /tmp/tmux-1000/abtest_semicolon_* 2>/dev/null | wc -l)"
