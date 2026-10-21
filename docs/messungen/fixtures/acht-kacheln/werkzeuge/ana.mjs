// Auswertung der Lastmessung (Task 6) und der Fensterabnahme (Task 7) aus den Dateien in <logdir>.
// Usage: node ana.mjs <logdir>                        je Lauf aus phases.jsonl die Zahlen fuer den Bericht
//        node ana.mjs <logdir> check <vonMs> <bisMs>  Oeffnungen je Host und Kachel, Acks und Fenster im Zeitraum
// Quantile nach dem naechsten Rang (bei gerader Zahl ist der Median der untere Wert).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [dir, mode, fromArg, toArg] = process.argv.slice(2);
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter(Boolean) : []);
const jl = (f) => read(f).map((line) => JSON.parse(line));
const q = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * xs.length) - 1)] : null);
const st = (xs) => `n=${xs.length} med=${q(xs, 0.5)} p95=${q(xs, 0.95)} max=${xs.length ? Math.max(...xs) : null}`;
const inside = (t, [a, b]) => t >= a && t < b;
const most = (xs) => Math.max(0, ...xs);
const page = jl("page.jsonl");
const cdp = jl("cdp.jsonl");
const ipc = page.filter((r) => r.ev);
const doms = page.filter((r) => r.cmd === "dom");
const sessionOf = new Map(ipc.filter((r) => r.openId).map((r) => [r.openId, r.session]));
const lagsIn = (w) => page.filter((r) => r.cmd === "window" && inside(r.t, w)).flatMap((r) => r.lags);
// Je openId bestaetigte Bytes und laengste Ack-Luecke aus den 5-s-Fenstern mit a <= t <= b.
function acksIn(a, b) {
  const per = {};
  for (const w of page.filter((r) => r.cmd === "window" && r.t >= a && r.t <= b)) {
    for (const [id, [bytes, gap]] of Object.entries(w.acks)) {
      const o = (per[id] ??= { bytes: 0, gap: 0 });
      o.bytes += bytes;
      if (o.bytes > 0) o.gap = Math.max(o.gap, gap);
    }
  }
  return Object.entries(per).filter(([, o]) => o.bytes > 0);
}
const losses = (d) => `Ruhe-Chip ${most(d.map((r) => r.quiet.length))}, Sperre ${most(d.map((r) => r.lock.length))}, Banner ${JSON.stringify([...new Set(d.map((r) => r.banner).filter(Boolean))])}`;

if (mode === "check") {
  const win = [Number(fromArg), Number(toArg)];
  const byOpen = new Map();
  for (const r of ipc) if (r.openId && inside(r.t, win)) byOpen.set(r.openId, [...(byOpen.get(r.openId) ?? []), r]);
  const spans = [];
  let problems = 0;
  for (const rs of byOpen.values()) {
    const open = rs.find((r) => r.cmd === "open_terminal" && r.ev === "done") ?? rs.find((r) => r.cmd === "open_terminal");
    const ready = open?.outcome === "ok" ? open.t + open.ms : null;
    if (open) spans.push([open.t, open.ev === "done" ? open.t + open.ms : win[1], open.hostId]);
    const resizes = rs.filter((r) => r.cmd === "resize_terminal" && r.ev === "send");
    const early = open ? resizes.filter((r) => ready === null || r.t < ready).length : 0;
    const typed = open ? rs.filter((r) => r.cmd === "send_input" && r.ev === "send" && (ready === null || r.t < ready)).length : 0;
    const failed = rs.filter((r) => r.ev === "done" && r.outcome !== "ok");
    problems += early + typed + failed.length;
    const opened = open ? `${open.cols}x${open.rows} bei +${open.t - win[0]} ms, ${open.outcome ?? "offen"} nach ${open.ms ?? "-"} ms` : "-";
    const closes = rs.filter((r) => r.cmd === "close_terminal" && r.ev === "send").length;
    const bad = failed.map((r) => `${r.cmd} ${r.err}`).join("; ");
    console.log(`${String(rs[0].session).padEnd(4)} Host ...${String(rs[0].hostId).slice(-6)} open ${opened} | resize ${resizes.map((r) => `${r.cols}x${r.rows}`).join(", ") || "-"}${early ? ` | ${early} VOR DEM EIGENEN OPEN` : ""}${typed ? ` | ${typed} EINGABEN VOR DEM OPEN` : ""} | close ${closes}${bad ? ` | ABGEWIESEN ${bad}` : ""}`);
  }
  const peak = {};
  for (const [a, , h] of spans) peak[h] = Math.max(peak[h] ?? 0, spans.filter(([b, e, h2]) => h2 === h && b <= a && a < e).length);
  const d = doms.filter((r) => inside(r.t, win));
  const snaps = cdp.filter((s) => inside(s.t, win));
  const inputs = ipc.filter((r) => r.cmd === "send_input" && r.ev === "done" && inside(r.t, win)).map((r) => r.ms);
  console.log(`hoechstens gleichzeitig offene open_terminal je Host: ${JSON.stringify(peak)}`);
  console.log(`erstes open_terminal bis letzte Antwort: ${spans.length ? Math.max(...spans.map(([, e]) => e)) - Math.min(...spans.map(([b]) => b)) : "-"} ms`);
  console.log(`Opening-Kacheln hoechstens ${most(d.map((r) => r.opening.length))} (${[...new Set(d.flatMap((r) => r.opening))].join(", ")}), ${losses(d)}`);
  console.log(`Acks ab +10 s: ${acksIn(win[0] + 10000, win[1]).map(([id, o]) => `${sessionOf.get(id) ?? id.slice(0, 8)} ${(o.bytes / 1e6).toFixed(1)} MB, Luecke ${o.gap} ms`).join("; ") || "-"}`);
  console.log(`GL-Canvas ${[...new Set(snaps.map((s) => s.gl))].join(",")}, sichtbare Kacheln ${[...new Set(snaps.map((s) => s.shown))].join(",")}, Reihenfolge zuletzt ${snaps.at(-1)?.order ?? "-"} | Eingaben ms ${st(inputs)} | Ereignisschleife ms ${st(lagsIn(win))}`);
  console.log(`Probleme (abgewiesen, resize oder Eingabe vor dem eigenen open): ${problems}`);
  process.exit(0);
}

const marks = jl("phases.jsonl");
const clock = jl("clock.jsonl");
const mem = jl("mem.jsonl");
const probe = read("probe.txt")
  .map((line) => line.trim().split(" "))
  .filter(([v, kind]) => /^\d+$/.test(v) && (kind === "busy" || kind === "idle"))
  .map(([v, kind]) => ({ v: Number(v), kind }));
const pills = [];
for (const r of doms) if (!pills.length || pills.at(-1).probe !== r.probe) pills.push({ t: r.t, probe: r.probe });
// mem.jsonl: {t, p: [[pid, typ, privat, ws, cpu, gpuDed, gpuShr], ...]}
const sum = (s, i, type) => (s ? s.p.filter((x) => !type || x[1] === type).reduce((a, x) => a + x[i], 0) : NaN);
const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1)} %`;
const plateau = {};
for (const run of [...new Set(marks.map((x) => x.run))]) {
  const m = Object.fromEntries(marks.filter((x) => x.run === run).map((x) => [x.mark, x.t]));
  const offs = clock.filter((c) => c.label === `${run}-before` || c.label === `${run}-after`).map((c) => c.offset);
  const off = offs.reduce((a, b) => a + b, 0) / offs.length;
  const ph = { idle: [m.idle, m.flood], flood: [m.flood, m.rest], rest: [m.rest, m.end] };
  const all = [m.idle, m.end];
  console.log(`\n== ${run}: Uhrabstand VM minus Windows ${Math.round(off)} ms (${offs.join(", ")})`);
  for (const [name, w] of Object.entries(ph)) {
    const lat = [];
    let missed = 0;
    for (const s of probe) {
      const at = s.v - off;
      if (!inside(at, w)) continue;
      const hit = pills.find((p) => p.t >= at && p.t < at + 7300 && p.probe === s.kind);
      if (hit) lat.push(Math.round(hit.t - at));
      else missed++;
    }
    const stale = pills.filter((p) => inside(p.t, w) && p.probe === "stale").length;
    const polls = ipc.filter((r) => r.cmd === "poll_status" && r.ev === "done" && inside(r.t, w));
    const errs = polls.filter((r) => r.outcome !== "ok").map((r) => r.err);
    // R3: eine Statusabfrage kann ok sein, obwohl Titel oder `claude agents` scheiterten (etwa an der Exec-Grenze).
    const partial = page.filter((r) => r.cmd === "poll_partial" && inside(r.t, w));
    console.log(`${name.padEnd(5)} Status: Wechsel ${lat.length + missed}, verpasst ${missed}, Latenz ms ${st(lat)}, veraltet ${stale} | Poll ms ${st(polls.map((r) => r.ms))}, gescheitert ${errs.length}${errs.length ? ` ${JSON.stringify([...new Set(errs)])}` : ""} | Ereignisschleife ms ${st(lagsIn(w))} | Teilausfaelle Titel/Claude ${partial.filter((r) => !r.titles_ok).length}/${partial.filter((r) => !r.agents_ok).length}`);
  }
  const term = ipc.filter((r) => r.ev === "send" && inside(r.t, ph.flood) && (r.cmd === "open_terminal" || r.cmd === "close_terminal"));
  const failed = ipc.filter((r) => r.ev === "done" && r.outcome !== "ok" && r.cmd !== "poll_status" && inside(r.t, all));
  console.log(`Verluste: ${losses(doms.filter((r) => inside(r.t, all)))}, open/close in der Flut ${term.length}, abgewiesen ${failed.length}${failed.length ? `: ${failed.map((r) => `${r.cmd} ${r.err}`).join("; ")}` : ""}`);
  const flooding = acksIn(m.flood + 10000, m.rest).map(([, o]) => o);
  console.log(`Acks in der Flut: ${flooding.length} Kacheln, MB je Kachel ${st(flooding.map((o) => Math.round(o.bytes / 1e5) / 10))}, laengste Luecke ${most(flooding.map((o) => o.gap))} ms`);
  const lists = ipc.filter((r) => r.cmd === "list_sessions" && r.ev === "done" && inside(r.t, all)).map((r) => r.ms);
  const resizes = ipc.filter((r) => r.cmd === "resize_terminal" && r.ev === "send" && inside(r.t, ph.flood));
  console.log(`list_sessions ms ${st(lists)}; resize_terminal in der Flut: ${resizes.map((r) => `${r.session} ${r.cols}x${r.rows}`).join(", ") || "-"}`);
  const snaps = cdp.filter((s) => inside(s.t, all));
  const hidden = page.some((r) => r.cmd === "visibility" && r.state !== "visible" && inside(r.t, all));
  const set = (key) => [...new Set(snaps.map((s) => s[key]))].join(",");
  console.log(`Fenster: immer sichtbar ${!hidden && snaps.every((s) => s.vis === "visible")}, DevTools offen ${snaps.some((s) => s.devtools)}, Kacheln ${set("tiles")}, davon sichtbar ${set("shown")}, GL-Canvas ${set("gl")}, JS-Heap hoechstens ${Math.round(most(snaps.map((s) => s.m?.JSHeapUsedSize ?? 0)) / 1e6)} MB`);
  const samples = (w) => mem.filter((s) => inside(s.t, w));
  const idleEnd = samples(ph.idle).at(-1);
  const restEnd = samples(ph.rest).at(-1);
  const flood = samples(ph.flood);
  const last60 = samples([m.rest - 60000, m.rest]).map((s) => sum(s, 2));
  const lo = Math.min(...last60);
  const hi = Math.max(...last60);
  plateau[run] = hi;
  const cpu = (type) => (flood.length > 1 ? Math.round(((sum(flood.at(-1), 4, type) - sum(flood[0], 4, type)) / ((flood.at(-1).t - flood[0].t) / 1000)) * 100) : null);
  const gpuPids = [...new Set(samples(all).flatMap((s) => s.p.filter((x) => x[1] === "gpu-process").map((x) => x[0])))];
  const renderers = [...new Set(samples(all).map((s) => s.p.filter((x) => x[1] === "renderer").length))];
  console.log(`Speicher privat MB: Leerlauf ${sum(idleEnd, 2).toFixed(0)}, letzte 60 s der Flut ${lo.toFixed(0)}-${hi.toFixed(0)} (+${pct(hi, lo)}), nach dem Nachlauf ${sum(restEnd, 2).toFixed(0)} (${pct(sum(restEnd, 2), sum(idleEnd, 2))} ueber Leerlauf); Renderer ${sum(idleEnd, 2, "renderer").toFixed(0)} -> ${sum(flood.at(-1), 2, "renderer").toFixed(0)}; Working Set Flutende ${sum(flood.at(-1), 3).toFixed(0)}; GPU dediziert/geteilt ${sum(flood.at(-1), 5).toFixed(0)}/${sum(flood.at(-1), 6).toFixed(0)}; GPU-PIDs ${gpuPids.join(",")}; Renderer-Prozesse ${renderers.join(",")} | CPU % in der Flut: Renderer ${cpu("renderer")}, GPU ${cpu("gpu-process")}, App ${cpu("app")}`);
  const clients = (f) => read(f).filter((line) => /^\d+ \d+ \S+ \d+x\d+$/.test(line));
  const before = clients(`vm-${run}-before.txt`);
  console.log(`tmux-Clients: vorher ${before.length}, nachher dieselben ${before.join("|") === clients(`vm-${run}-after.txt`).join("|")}; Last vorher ${read(`vm-${run}-before.txt`)[1]}, nachher ${read(`vm-${run}-after.txt`)[1]}`);
}
if (["N4-L1", "N6-L1", "N8-L1"].every((r) => r in plateau)) {
  const g46 = (plateau["N6-L1"] - plateau["N4-L1"]) / 2;
  const g68 = (plateau["N8-L1"] - plateau["N6-L1"]) / 2;
  console.log(`\nZuwachs je Kachel (Hoechstwert privat, letzte 60 s der Flut): 4->6 ${g46.toFixed(1)} MB, 6->8 ${g68.toFixed(1)} MB, Verhaeltnis ${(g68 / g46).toFixed(2)}`);
}
