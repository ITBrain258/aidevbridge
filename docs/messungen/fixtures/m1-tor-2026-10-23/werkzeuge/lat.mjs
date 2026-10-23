// Latenz JSON-Zustand (VM, um den Uhrabstand verschoben) -> Pille der Sessionzeile (Seite).
// Usage: node lat.mjs <vmgate.log> <page.jsonl> <offsetMs> <session> <hostLabel>
import { readFileSync } from "node:fs";
const [vmlog, pagelog, offArg, session, label] = process.argv.slice(2);
const off = Number(offArg);
const panes = []; const json = [];
for (const l of readFileSync(vmlog, "utf8").split("\n")) {
  const [k, ts, ...rest] = l.split(" ");
  if (!isFinite(+ts)) continue;
  const t = Number(ts) * 1000 - off;
  if (k === "P") {
    for (const p of rest.join(" ").split("|")) { const [s, pid] = p.split(" "); if (s === session) panes.push([t, Number(pid)]); }
  } else if (k === "A") {
    let rows; try { rows = JSON.parse(rest.join(" ")); } catch { continue; }
    json.push([t, rows]);
  }
}
const panePid = (t) => { let pid = null; for (const [pt, p] of panes) if (pt <= t + 5000) pid = p; return pid; };
const stateAt = (rows, pid) => { const r = rows.find(([p, pp]) => p === pid || pp === pid); return r ? (r[3] ? `${r[2]}/${r[3]}` : r[2]) : "none"; };
const jt = []; let last = null;
for (const [t, rows] of json) { const s = stateAt(rows, panePid(t)); if (s !== last) { jt.push([t, s]); last = s; } }
const pt = []; last = null;
for (const l of readFileSync(pagelog, "utf8").split("\n")) {
  if (!l) continue; const r = JSON.parse(l); if (!r.rows) continue;
  const row = r.rows.find((x) => x.host.includes(label) && x.s === session);
  const s = row?.p?.kind ?? "none"; if (s !== last) { pt.push([r.t, s, row?.p?.title]); last = s; }
}
const fmt = (t) => new Date(t).toISOString().slice(11, 23);
for (const [t, s] of jt) {
  const kind = s.split("/")[0] === "none" ? null : s.split("/")[0];
  const hit = kind && pt.find(([p, k]) => p >= t - 500 && k === kind);
  console.log(`${fmt(t)} JSON ${s.padEnd(28)} -> Seite ${hit ? fmt(hit[0]) + "  +" + ((hit[0] - t) / 1000).toFixed(2) + " s" : "-"}`);
}
