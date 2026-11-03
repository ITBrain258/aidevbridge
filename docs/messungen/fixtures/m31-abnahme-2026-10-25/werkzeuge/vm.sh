#!/bin/bash
# Usage: vm.sh <host> <befehl>
exec ssh -i "$HOME/.ssh/test_ed25519" -o UserKnownHostsFile="$HOME/.ssh/known_hosts_test" -o BatchMode=yes -o ConnectTimeout=8 "u@$1" "$2"
