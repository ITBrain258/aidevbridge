// Erzwingt in der Testinstanz eine Speicherbereinigung (HeapProfiler.collectGarbage) und haengt
// den JS-Heap vorher und nachher an <logdir>/gc.jsonl an. Nachtrag zur Messung vom 21.10.: der
// Heap waechst unter Flut durch Muell, den V8 erst spaet einsammelt; ein Leck zeigt sich erst
// nach der Bereinigung. Usage: node gc.mjs <port> <logdir> <label>
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const [port, dir, label] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
if (!page) { console.error("keine Seite der Testinstanz"); process.exit(3); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const heap = async () => (await send("Runtime.getHeapUsage")).result;
const before = await heap();
await send("HeapProfiler.enable");
await send("HeapProfiler.collectGarbage");
await new Promise((r) => setTimeout(r, 2000));
const after = await heap();
await send("HeapProfiler.disable");
ws.close();
const rec = { t: Date.now(), label, beforeMB: +(before.usedSize / 1e6).toFixed(1), afterMB: +(after.usedSize / 1e6).toFixed(1), totalAfterMB: +(after.totalSize / 1e6).toFixed(1) };
appendFileSync(join(dir, "gc.jsonl"), JSON.stringify(rec) + "\n");
console.log(JSON.stringify(rec));
