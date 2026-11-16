# Sets the shell startup file of the throwaway account to one variant and
# shows what a plain non-interactive SSH command then prints.
# Usage: sh shellvar.sh <host> <account> stock|stdout|stderr|tty|interactive
# Reads: MEASURE_KEY (private key of the account), MEASURE_KNOWN_HOSTS
# The account needs a copy of its untouched startup file as ~/.bashrc.stock.
host=$1
account=$2
variant=$3
run() {
  ssh -i "$MEASURE_KEY" -o BatchMode=yes -o ConnectTimeout=8 \
    -o UserKnownHostsFile="$MEASURE_KNOWN_HOSTS" "$account@$host" "$@"
}
case "$variant" in
  stock)  run 'cp -p ~/.bashrc.stock ~/.bashrc' ;;
  stdout) run '{ echo "echo hello"; cat ~/.bashrc.stock; } > ~/.bashrc' ;;
  stderr) run '{ echo "echo warn >&2"; cat ~/.bashrc.stock; } > ~/.bashrc' ;;
  tty)    run '{ echo "[ -t 1 ] && echo hello"; cat ~/.bashrc.stock; } > ~/.bashrc' ;;
  interactive)
    run '{ echo "case \$- in *i*) echo hello;; esac"; cat ~/.bashrc.stock; } > ~/.bashrc' ;;
  *) echo "unknown variant: $variant" >&2; exit 2 ;;
esac
out=$(run 'true' 2>/dev/null)
err=$(run 'true' 2>&1 >/dev/null)
tty=$(run -tt 'true' 2>/dev/null | tr -d '\r')
echo "variant $variant: first line of ~/.bashrc: $(run 'head -1 ~/.bashrc' 2>/dev/null | tail -1)"
echo "variant $variant: 'ssh <account>@<host> true' prints on stdout: [$out]"
echo "variant $variant: 'ssh <account>@<host> true' prints on stderr: [$err]"
echo "variant $variant: 'ssh -tt <account>@<host> true' (with a terminal) prints: [$tty]"
if [ "$variant" = interactive ]; then
  # The line of this variant shows only in an interactive shell; the three
  # commands above are none.
  inter=$(run 'bash -i -c true' 2>/dev/null)
  echo "variant $variant: 'ssh <account>@<host> bash -i -c true' (an interactive shell) prints: [$inter]"
fi
