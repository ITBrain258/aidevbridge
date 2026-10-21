# Numeric tmux inventory inputs

These three fixtures retain the complete stdout, stderr and exit code of the
accepted tmux 3.0/3.4 inventory measurements of 2026-09-12 and the tmux 3.6
inventory measurement of 2026-10-11. `source` and its SHA-256
identify the original JSONL report in this repository; byte-identical copies of
the reports sit next to them as `2026-09-12-tmux-3.0.jsonl`,
`2026-09-12-tmux-3.4.jsonl` and `2026-10-11-tmux-3.6.jsonl`, so the tests do not
read from `docs/`. Selection retains all
classified snapshot/partial-failure records, the six initial/inert NoServer
probes and the live-empty-server `plain_empty_panes` failure per version.
No new remote command was run to create these files.

The 3.6 JSONL is an excerpt of the raw data of the measurement described in
`docs/messungen/messung-2026-10-11-tmux36.md`: its inventory matrix, with the
same 28 cases as `tmux-3.4.json` in the same order and with the same classes.
Its `version_output` is `tmux 3.6\n`, the exact answer of the Ubuntu 26.04
package `tmux 3.6a-2ubuntu0.1`. An unmodified upstream 3.6a build answers
`tmux 3.6a\n`; that answer is not covered by this fixture and stays unadmitted.
The files are stored with LF line endings (`.gitattributes`); the recorded
SHA-256 refers to exactly these bytes. Before publication the VM host name in
the `host` field of the 3.6 JSONL was replaced by `test-vm` (here, in the copy
under `docs/messungen/` and in the raw data it is derived from); the recorded
hashes refer to these neutralized bytes, and no test reads `host`.

Expected numeric snapshot data comes unchanged from that measurement's
classification. NoServer expectations refer only to the exact recorded socket
path and diagnosis. Synthetic parser counterexamples live in the Rust tests,
not in these historical inputs.

`query_argv` retains the measured inventory arguments with `env LC_ALL=C` and
the product's PATH lookup for `tmux`. The measurement-only `-f /dev/null` is
omitted: this is a query to an existing server, never a server start or a change
to its configuration. The 3.0 static `if-shell -F` wrapper is retained exactly.
Tests compare the decoded product command to these arguments, verify source
hashes, and compare every retained result to its original command record.

These inputs prove neither the current product runtime nor a status adapter,
free metadata codec, linked-window support, SSH latency or Windows UI behavior.
