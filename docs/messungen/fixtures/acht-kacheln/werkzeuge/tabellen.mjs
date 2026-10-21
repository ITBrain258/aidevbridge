// Tabellen fuer den Messbericht aus ana.txt (Ausgabe von ana.mjs), phases.jsonl, clock.jsonl,
// gc.jsonl und win.jsonl eines Log-Ordners. Gibt Markdown aus; jede Zahl stammt aus diesen Dateien.
// Usage: node tabellen.mjs <logdir>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const lines = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter(Boolean) : []);
const jl = (f) => lines(f).map((l) => JSON.parse(l));
const ana = readFileSync(join(dir, "ana.txt"), "utf8").split(/\r?\n/);
const marks = jl("phases.jsonl");
const clock = jl("clock.jsonl");
const gc = jl("gc.jsonl");
const win = jl("win.jsonl");

const runs = [];
let cur = null;
for (const line of ana) {
  const head = line.match(/^== (\S+): Uhrabstand VM minus Windows (-?\d+) ms \((-?\d+), (-?\d+)\)/);
  if (head) {
    cur = { name: head[1], offsets: [head[3], head[4]], phases: {} };
    runs.push(cur);
    continue;
  }
  if (!cur) continue;
  const ph = line.match(/^(idle|flood|rest)\s+Status: Wechsel (\d+), verpasst (\d+), Latenz ms n=\d+ med=(\S+) p95=(\S+) max=(\S+), veraltet (\d+) \| Poll ms n=\d+ med=(\S+) p95=(\S+) max=(\S+), gescheitert (\d+) \| Ereignisschleife ms n=\d+ med=(\S+) p95=(\S+) max=(\S+) \| Teilausfaelle Titel\/Claude (\d+)\/(\d+)/);
  if (ph) {
    const [, phase, sw, missed, med, p95, max, stale, pmed, pp95, pmax, failed, lmed, lp95, lmax, pt, pc] = ph;
    cur.phases[phase] = { sw, missed, med, p95, max, stale, pmed, pp95, pmax, failed, lmed, lp95, lmax, partial: `${pt}/${pc}` };
    continue;
  }
  let m;
  if ((m = line.match(/^Verluste: Ruhe-Chip (\d+), Sperre (\d+), Banner (\[.*?\]), open\/close in der Flut (\d+), abgewiesen (\d+)(.*)$/))) {
    cur.loss = { quiet: m[1], lock: m[2], banner: m[3], openclose: m[4], rejected: m[5], text: m[6].replace(/^: /, "").trim() };
  } else if ((m = line.match(/^Acks in der Flut: (\d+) Kacheln, MB je Kachel n=\d+ med=(\S+) p95=\S+ max=(\S+), laengste Luecke (\d+) ms/))) {
    cur.acks = { tiles: m[1], med: m[2], max: m[3], gap: m[4] };
  } else if ((m = line.match(/^Fenster: immer sichtbar (\w+), DevTools offen (\w+), Kacheln (\d+), davon sichtbar (\d+), GL-Canvas (\d+), JS-Heap hoechstens (\S+) MB/))) {
    cur.window = { visible: m[1], devtools: m[2], tiles: m[3], shown: m[4], gl: m[5], heapMax: m[6] };
  } else if ((m = line.match(/^Speicher privat MB: Leerlauf (\S+), letzte 60 s der Flut (\S+)-(\S+) \((\S+) %\), nach dem Nachlauf (\S+) \((\S+) % ueber Leerlauf\); Renderer (\S+) -> (\S+); Working Set Flutende (\S+); GPU dediziert\/geteilt (\S+)\/(\S+); GPU-PIDs (\S+); Renderer-Prozesse (\d+) \| CPU % in der Flut: Renderer (\S+), GPU (\S+), App (\S+)/))) {
    cur.mem = { idle: m[1], lo: m[2], hi: m[3], plateau: m[4], after: m[5], afterPct: m[6], r0: m[7], r1: m[8], ws: m[9], gded: m[10], gshr: m[11], gpids: m[12], renderers: m[13], cpuR: m[14], cpuG: m[15], cpuA: m[16] };
  } else if ((m = line.match(/^tmux-Clients: vorher (\d+), nachher dieselben (\w+)/))) {
    cur.clients = { before: m[1], same: m[2] };
  }
}
const growth = ana.find((l) => l.startsWith("Zuwachs je Kachel"));

const at = (run, mark) => marks.find((x) => x.run === run && x.mark === mark)?.t;
const utc = (t) => (t ? new Date(t).toISOString().slice(11, 19) : "-");
const out = [];
out.push("| Lauf | Kacheln | Last | Beginn (UTC) | Uhrabstand vorher / nachher (ms) | Fenster maximiert, Sitzung verbunden |", "| --- | --- | --- | --- | --- | --- |");
for (const r of runs) {
  const [, n, mode] = r.name.match(/^N(\d+)-(L\d)$/) ?? [];
  const from = at(r.name, "idle");
  const to = at(r.name, "end");
  const samples = win.filter((w) => from && to && w.t >= from && w.t <= to);
  const ok = samples.length ? (samples.every((w) => w.zoomed && !w.iconic && !w.locked) ? `ja (${samples.length} Proben)` : `NEIN (${samples.filter((w) => !(w.zoomed && !w.iconic && !w.locked)).length} von ${samples.length})`) : "nicht erfasst";
  out.push(`| ${r.name} | f1–f${n} | ${mode} | ${utc(from)} | ${r.offsets.join(" / ")} | ${ok} |`);
}
out.push("", "| Lauf | Phase | Wechsel | verpasst | Median | p95 | Max | veraltet | Poll Median / p95 / Max | Ereignisschleife p95 / Max |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of runs) {
  for (const phase of ["idle", "flood", "rest"]) {
    const p = r.phases[phase];
    if (!p) continue;
    out.push(`| ${r.name} | ${{ idle: "Ruhe", flood: "Flut", rest: "Nachlauf" }[phase]} | ${p.sw} | ${p.missed} | ${p.med} | ${p.p95} | ${p.max} | ${p.stale} | ${p.pmed} / ${p.pp95} / ${p.pmax} | ${p.lp95} / ${p.lmax} |`);
  }
}
out.push("", "| Lauf | Ruhe-Chip / Sperre / Banner | open/close in der Flut | abgewiesen | tmux-Clients gleich | MB je Kachel (Median) | längste Ack-Lücke (ms) |", "| --- | --- | --- | --- | --- | --- | --- |");
for (const r of runs) {
  const l = r.loss ?? {};
  out.push(`| ${r.name} | ${l.quiet} / ${l.lock} / ${l.banner === "[]" ? "keins" : l.banner} | ${l.openclose} | ${l.rejected}${l.text ? ` (${l.text})` : ""} | ${r.clients?.same === "true" ? "ja" : "nein"} | ${r.acks?.med} | ${r.acks?.gap} |`);
}
out.push("", "| Lauf | privat Leerlauf | letzte 60 s der Flut | nach dem Nachlauf | Renderer vorher → Flutende | JS-Heap nach erzwungener Bereinigung vor / nach dem Lauf | GPU dediziert / geteilt | CPU Renderer / GPU / App (%) |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of runs) {
  const m = r.mem ?? {};
  const before = gc.find((g) => g.label === `${r.name}-vor`)?.afterMB ?? "-";
  const after = gc.find((g) => g.label === `${r.name}-nach`)?.afterMB ?? gc.find((g) => g.label === `${r.name}-nach-gc`)?.afterMB ?? "-";
  out.push(`| ${r.name} | ${m.idle} MB | ${m.lo}–${m.hi} MB (${m.plateau} %) | ${m.after} MB (${m.afterPct} %) | ${m.r0} → ${m.r1} MB | ${before} / ${after} MB | ${m.gded} / ${m.gshr} MB | ${m.cpuR} / ${m.cpuG} / ${m.cpuA} |`);
}
if (growth) out.push("", growth);
console.log(out.join("\n"));
