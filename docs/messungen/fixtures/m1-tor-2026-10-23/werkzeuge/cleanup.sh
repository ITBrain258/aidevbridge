u=$(id -u)
for s in abtest_20261023_m1 abtest_20261023_t1_title abtest_20261023_dbg abtest_20261023_mess; do
  tmux -L "$s" kill-server 2>/dev/null
  rm -f "/tmp/tmux-$u/$s"
done
rm -f /tmp/m1-probe /tmp/m1-probe2 /tmp/m1-a /tmp/m1-b /tmp/m1-c /tmp/m1-gedicht*.txt /tmp/m1-claude-probe* /var/tmp/m1-codex-probe*.txt
rm -rf /tmp/abm1-20261023 /tmp/abmess-20261023 /tmp/abtitle.*
echo "$(hostname): Sockets: $(ls /tmp/tmux-$u/ | tr '\n' ' ')| Reste: $(ls -d /tmp/ab* /tmp/m1-* /var/tmp/m1-* 2>/dev/null | tr '\n' ' ')"
