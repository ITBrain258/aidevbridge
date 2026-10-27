// Liest ueber CDP (Network) passiv mit, wann die Seite poll_status und list_sessions
// aufruft und wann die Antwort kommt. Usage: node netpoll.mjs <port> <ausgabe.jsonl> <sekunden>
import { appendFileSync } from "node:fs";

const [port, out, secs] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
const open = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  const p = msg.params;
  if (msg.method === "Network.requestWillBeSent") {
    const m = /ipc\.localhost\/(poll_status|list_sessions)/.exec(p.request.url);
    if (m) {
      let host = null;
      try { host = JSON.parse(p.request.postData ?? "{}").hostId ?? null; } catch { /* kein JSON */ }
      open.set(p.requestId, { cmd: m[1], host, wall: p.wallTime * 1000, ts: p.timestamp });
    }
  } else if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") {
    const r = open.get(p.requestId);
    if (r) {
      open.delete(p.requestId);
      appendFileSync(out, JSON.stringify({ cmd: r.cmd, host: r.host, t: Math.round(r.wall), dt: Math.round((p.timestamp - r.ts) * 1000), failed: msg.method === "Network.loadingFailed" }) + "\n");
    }
  }
});
ws.send(JSON.stringify({ id: 1, method: "Network.enable", params: {} }));
setTimeout(() => { ws.close(); process.exit(0); }, Number(secs) * 1000);
