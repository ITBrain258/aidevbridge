// Uhrabstand VM - lokal ueber eine stehende ssh-Verbindung: 20 Proben, die mit der kuerzesten
// Rundreise zaehlt. Usage: node clock.mjs <vm-skript> <host>
import { spawn } from "node:child_process";
const [vm, host] = process.argv.slice(2);
const p = spawn("bash", [vm, host, "while read x; do date +%s.%N; done"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const lines = [];
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
const next = () => new Promise((r) => { const t = setInterval(() => { if (lines.length) { clearInterval(t); r(lines.shift()); } }, 1); });
p.stdin.write("x\n"); await next();
let best = null;
for (let i = 0; i < 20; i++) {
  const t0 = performance.timeOrigin + performance.now();
  p.stdin.write("x\n");
  const out = await next();
  const t1 = performance.timeOrigin + performance.now();
  const rtt = t1 - t0;
  const offset = Number(out) * 1000 - (t0 + t1) / 2;
  if (!best || rtt < best.rtt) best = { rtt: Math.round(rtt * 10) / 10, offset: Math.round(offset) };
}
p.stdin.end(); p.kill();
console.log(JSON.stringify({ host, ...best, at: new Date().toISOString() }));
