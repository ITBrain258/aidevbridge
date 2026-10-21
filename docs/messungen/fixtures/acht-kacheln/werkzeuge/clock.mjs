// Uhrabstand VM minus Windows in ms: 20 Ping-Pongs ueber EINE ssh-Sitzung; es zaehlt die
// Probe mit der kuerzesten Rundreise. Haengt {t, label, rtt, offset} an <clock.jsonl> an.
// Usage: node clock.mjs <clock.jsonl> <label>
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [out, label] = process.argv.slice(2);
const ssh = spawn(
  "ssh",
  ["-i", "C:/Users/U/.ssh/abtest_rsa", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
    "u@192.0.2.20", "while read x; do date +%s%3N; done"],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const lines = createInterface({ input: ssh.stdout })[Symbol.asyncIterator]();
const samples = [];
for (let i = 0; i < 20; i++) {
  const t0 = Date.now();
  ssh.stdin.write("x\n");
  const { value, done } = await lines.next();
  if (done) throw new Error("ssh endete vor der Antwort");
  const t1 = Date.now();
  samples.push({ rtt: t1 - t0, offset: Number(value) - (t0 + t1) / 2 });
}
ssh.stdin.end();
const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
const rec = { t: Date.now(), label, rtt: best.rtt, offset: Math.round(best.offset) };
appendFileSync(out, `${JSON.stringify(rec)}\n`);
console.log(JSON.stringify(rec));
