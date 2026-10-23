// Seiten-Sampler: alle 100 ms Pillen aller Sessionzeilen, Kacheln, Wartet-Spur,
// Fenstertitel und Hinweise; schreibt bei Aenderung eine JSON-Zeile mit lokaler Zeit.
// Usage: node pagesamp.mjs <port> <ausgabe.jsonl> <sekunden>
import { appendFileSync } from "node:fs";
import { connect, FIND, sleep, now } from "./cdp.mjs";

const [port, out, secs] = process.argv.slice(2);
const end = now() + Number(secs) * 1000;
let cdp = null;
let last = "";
while (now() < end) {
  try {
    if (!cdp) cdp = await connect(Number(port), 2000);
    const t0 = now();
    const st = await cdp.js(`(() => { const f = ${FIND}; return { rows: f.rows(), tiles: f.tiles(), lane: f.lane(), title: f.title(), banner: f.banner(), notices: f.notices() }; })()`);
    const t1 = now();
    const key = JSON.stringify(st);
    if (key !== last) {
      appendFileSync(out, JSON.stringify({ t: Math.round((t0 + t1) / 2), dt: t1 - t0, ...st }) + "\n");
      last = key;
    }
  } catch (e) {
    appendFileSync(out, JSON.stringify({ t: now(), err: String(e).slice(0, 200) }) + "\n");
    try { cdp?.close(); } catch { /* weg */ }
    cdp = null;
    await sleep(500);
  }
  await sleep(100);
}
cdp?.close();
