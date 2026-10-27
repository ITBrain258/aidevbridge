// Dauer von poll_status je Host und Pause bis zur naechsten Abfrage. Usage: node netsum.mjs <net.jsonl...>
import { readFileSync } from "node:fs";
for (const f of process.argv.slice(2)) {
  const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.host && r.cmd === "poll_status");
  for (const h of [...new Set(rows.map((r) => r.host))].sort()) {
    const own = rows.filter((r) => r.host === h).sort((a, b) => a.t - b.t);
    const d = own.map((r) => r.dt).sort((a, b) => a - b);
    const g = own.slice(1).map((r, i) => r.t - (own[i].t + own[i].dt)).filter((x) => x < 5000).sort((a, b) => a - b);
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    console.log(`${f.split("/").pop()} ${h}: n=${d.length} Dauer min ${d[0]} Median ${q(d, 0.5)} p90 ${q(d, 0.9)} max ${d.at(-1)} ms; Pause Median ${q(g, 0.5)} p90 ${q(g, 0.9)} ms`);
  }
}
