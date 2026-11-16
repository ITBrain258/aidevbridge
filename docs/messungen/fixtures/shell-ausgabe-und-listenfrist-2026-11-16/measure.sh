# Runs one scenario of the measurement tool and writes its output to a file.
# The tool, measure_shell_and_walk.rs, has to lie under src-tauri/tests/ of
# the tree for the run.
# Usage: sh measure.sh <scenario> <label> <output file> [via-proxy]
# Reads: MEASURE_HOST, MEASURE_ACCOUNT, MEASURE_TREE, MEASURE_KEY,
#        MEASURE_KNOWN_HOSTS, MEASURE_PROXY_PORT, MEASURE_SESSIONS,
#        MEASURE_POLL, MEASURE_STALL_FLAG
scenario=$1
label=$2
out=$3
via=${4:-direct}
key=$(awk -v h="$MEASURE_HOST" '$1 == h && $2 == "ssh-ed25519" { print $3; exit }' "$MEASURE_KNOWN_HOSTS")
if [ -z "$key" ]; then
  echo "no ed25519 host key for the host" > "$out"
  exit 2
fi
export AIDEVBRIDGE_MEASURE_DIRECT=$MEASURE_HOST
if [ "$via" = via-proxy ]; then
  export AIDEVBRIDGE_MEASURE_HOST=127.0.0.1
  export AIDEVBRIDGE_MEASURE_PORT=$MEASURE_PROXY_PORT
else
  export AIDEVBRIDGE_MEASURE_HOST=$MEASURE_HOST
fi
export AIDEVBRIDGE_MEASURE_USER=$MEASURE_ACCOUNT
export AIDEVBRIDGE_MEASURE_HOST_KEY=$key
export AIDEVBRIDGE_MEASURE_KEY=$MEASURE_KEY
export AIDEVBRIDGE_MEASURE_SOCKET=abmess_20261116
export AIDEVBRIDGE_MEASURE_LABEL=$label
[ -n "$MEASURE_SESSIONS" ] && export AIDEVBRIDGE_MEASURE_SESSIONS=$MEASURE_SESSIONS
[ -n "$MEASURE_POLL" ] && export AIDEVBRIDGE_MEASURE_POLL=$MEASURE_POLL
[ -n "$MEASURE_STALL_FLAG" ] && export AIDEVBRIDGE_MEASURE_STALL_FLAG=$MEASURE_STALL_FLAG
cd "$MEASURE_TREE/src-tauri" || exit 2
cargo test -j 4 --locked --test measure_shell_and_walk -- --ignored --exact "$scenario" --nocapture --test-threads=1 > "$out" 2>&1
echo "exit: $?" >> "$out"
