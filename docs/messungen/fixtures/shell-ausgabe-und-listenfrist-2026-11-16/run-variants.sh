# Runs the walk through the app's commands for each shell variant and puts
# the stock startup file back afterwards, also when a run fails.
# Usage: sh run-variants.sh
# Reads: MEASURE_HOST, MEASURE_ACCOUNT, MEASURE_TREE, MEASURE_DIR (this folder
#        and the place of the outputs), MEASURE_KEY, MEASURE_KNOWN_HOSTS
as_account() {
  ssh -i "$MEASURE_KEY" -o BatchMode=yes -o ConnectTimeout=8 \
    -o UserKnownHostsFile="$MEASURE_KNOWN_HOSTS" "$MEASURE_ACCOUNT@$MEASURE_HOST" "$@"
}
for variant in stock stdout stderr tty interactive; do
  sh "$MEASURE_DIR/shellvar.sh" "$MEASURE_HOST" "$MEASURE_ACCOUNT" "$variant" > "$MEASURE_DIR/precondition-$variant.txt" 2>&1
  sh "$MEASURE_DIR/measure.sh" shell_variant "$variant" "$MEASURE_DIR/variant-$variant.txt"
  # What the account's own measuring socket holds after the run, read with a
  # shell that is silent again; then end its server, if one runs.
  sh "$MEASURE_DIR/shellvar.sh" "$MEASURE_HOST" "$MEASURE_ACCOUNT" stock > /dev/null 2>&1
  {
    echo "after variant $variant, sessions on the measuring socket:"
    as_account 'tmux -L abmess_20261116 list-sessions -F "#{session_name}" 2>&1'
    as_account 'tmux -L abmess_20261116 kill-server 2>&1; true'
  } > "$MEASURE_DIR/after-$variant.txt" 2>&1
done
sh "$MEASURE_DIR/shellvar.sh" "$MEASURE_HOST" "$MEASURE_ACCOUNT" stock
