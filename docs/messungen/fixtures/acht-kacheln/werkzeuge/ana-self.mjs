// Selbsttest der Auswertung: schreibt einen kuenstlichen Lauf mit bekannten Werten nach <ordner>
// und ruft ana.mjs in beiden Arten auf. Usage: node ana-self.mjs <ordner>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const dir = process.argv[2];
mkdirSync(dir, { recursive: true });
const w = (f, rows) => writeFileSync(join(dir, f), `${rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`);
w("phases.jsonl", [["idle", 100000], ["flood", 160000], ["rest", 340000], ["end", 400000]].map(([mark, t]) => ({ t, run: "N4-L1", mark })));
w("clock.jsonl", [{ t: 0, label: "N4-L1-before", rtt: 2, offset: 1650 }, { t: 0, label: "N4-L1-after", rtt: 2, offset: 1750 }]);
// VM-Zeit = Windows-Zeit + 1700 ms; der letzte Wechsel kommt nie an.
w("probe.txt", ["111700 busy", "119000 idle", "171700 busy", "179000 idle", "186300 busy"]);
const dom = (t, probe, extra = {}) => ({ gen: 1, t, cmd: "dom", probe, tiles: 4, opening: [], quiet: [], lock: [], banner: null, ...extra });
const poll = (t, ms, outcome) => ({ gen: 1, t, cmd: "poll_status", hostId: "rt-A", ev: "done", ms, outcome });
const win = (t, acks, lags) => ({ gen: 1, t, cmd: "window", acks, lags });
const open = ([session, openId, t, ms, hostId]) => [
  { gen: 1, t, cmd: "open_terminal", hostId, session, openId, cols: 55, rows: 13, ev: "send" },
  { gen: 1, t, cmd: "open_terminal", hostId, session, openId, cols: 55, rows: 13, ev: "done", ms, outcome: "ok" },
];
w("page.jsonl", [
  dom(100000, "idle"), dom(111500, "busy"), dom(119300, "idle"), poll(150000, 900, "ok"), win(155000, {}, [0, 1, 2, 300]),
  win(165000, { o1: [100000, 60000] }, []),
  { gen: 1, t: 170000, cmd: "poll_partial", hostId: "rt-A", titles_ok: true, agents_ok: false }, dom(173100, "busy"),
  win(175000, { o1: [200000, 300], o2: [200000, 400], o3: [0, 99999] }, []), win(180000, { o1: [200000, 900], o2: [0, 5400] }, []),
  dom(180500, "idle"), dom(186000, "stale"), poll(200000, 1500, "ok"), win(200000, {}, [5, 10, 250]),
  dom(200000, "stale", { quiet: ["f2"] }), dom(205000, "stale"), { ...poll(210000, 5000, "error"), err: "timeout" },
  ...[["f1", "o11", 250000, 1800, "rt-A"], ["f2", "o12", 250010, 1900, "rt-A"], ["f3", "o13", 250020, 2000, "rt-A"],
    ["f4", "o14", 250030, 2100, "rt-A"], ["b1", "o15", 250040, 1700, "rt-B"], ["f5", "o16", 252000, 1500, "rt-A"]].flatMap(open),
  dom(250050, "stale", { opening: ["f5"] }),
  { gen: 1, t: 251500, cmd: "send_input", hostId: "rt-A", session: "f2", openId: "o12", ev: "send" },
  { gen: 1, t: 251000, cmd: "resize_terminal", hostId: "rt-A", session: "f2", openId: "o12", cols: 85, rows: 13, ev: "send" },
  { gen: 1, t: 253000, cmd: "resize_terminal", hostId: "rt-A", session: "f3", openId: "o13", cols: 85, rows: 13, ev: "send" },
  win(340000, { o1: [100000, 200] }, []), win(345000, {}, [1]),
]);
w("cdp.jsonl", [[150000, 4, 50e6], [250000, 1, 80e6], [390000, 4, 60e6]].map(([t, shown, heap]) =>
  ({ t, gen: 1, vis: "visible", tiles: 4, shown, gl: 4, devtools: false, m: { JSHeapUsedSize: heap } })));
const mem = (t, renderer, [rc, gc, ac] = [0, 0, 0], [ded, shr] = [30, 200]) =>
  ({ t, p: [[1, "app", 50, 60, ac, 0, 0], [2, "browser", 40, 50, 5, 0, 0], [3, "renderer", renderer, 150, rc, 0, 0], [4, "gpu-process", 100, 90, gc, ded, shr]] });
w("mem.jsonl", [mem(155000, 200), mem(165000, 300, [30, 10, 11]), mem(285000, 400, [100, 30, 15]), mem(335000, 410, [150, 40, 21], [35, 220]), mem(395000, 250)]);
w("vm-N4-L1-before.txt", ["1792505000000", "0.10 0.20 0.30 1/200 300", "1111 1791000000 f1 85x21", "1112 1791000001 f2 85x21"]);
w("vm-N4-L1-after.txt", ["1792505400000", "0.50 0.30 0.30 2/210 333", "1111 1791000000 f1 85x21", "1112 1791000001 f2 85x21"]);
const ana = join(dirname(fileURLToPath(import.meta.url)), "ana.mjs");
process.stdout.write(execFileSync("node", [ana, dir], { encoding: "utf8" }));
process.stdout.write(execFileSync("node", [ana, dir, "check", "240000", "270000"], { encoding: "utf8" }));
