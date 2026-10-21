// Bildraten-Fuehler: zaehlt alle <intervalMs> eine Sekunde lang requestAnimationFrame der Seite und
// haengt {t, raf, vis} an <out>. Belegt, dass die Seite waehrend der Laeufe wirklich zeichnete
// (unter Remote Desktop etwa 30 je Sekunde; minimiert oder verdeckt faellt der Wert auf 0).
// Usage: node raf.mjs <port> <out.jsonl> [intervalMs=30000]
import { appendFileSync } from "node:fs";

const [portArg, out, intervalArg] = process.argv.slice(2);
const port = Number(portArg);
const interval = Number(intervalArg ?? 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPR = "new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res({ raf: n, vis: document.visibilityState }); }; requestAnimationFrame(f); setTimeout(() => res({ raf: n, vis: document.visibilityState }), 3000); })";

for (;;) {
  const started = Date.now();
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
      const value = await new Promise((resolve, reject) => {
        ws.addEventListener("message", (event) => { const msg = JSON.parse(event.data); if (msg.id === 1) (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result.result.value)); });
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: EXPR, awaitPromise: true, returnByValue: true } }));
      });
      ws.close();
      appendFileSync(out, JSON.stringify({ t: started, ...value }) + "\n");
    }
  } catch (error) {
    appendFileSync(out, JSON.stringify({ t: started, err: String(error).slice(0, 200) }) + "\n");
  }
  await sleep(Math.max(0, interval - (Date.now() - started)));
}
