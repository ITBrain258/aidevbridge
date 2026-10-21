// Lesender CDP-Sampler der Lastmessung (aus mon.mjs der Rasterabnahme). Keine Eingaben,
// keine Emulation. Haengt sich nur an die Seite der Testinstanz (URL beginnt mit
// http://tauri.localhost; jede andere Seite auf dem Port bleibt unberuehrt), setzt hook.js
// fuer jedes neue Dokument und sofort ein und schreibt nach <logdir>: die Meldungen des Hakens nach
// page.jsonl, Konsole und Ausnahmen nach console.txt, alle 5 s Performance.getMetrics und
// einen Schnappschuss (Sichtbarkeit, Kacheln, GL-Canvas, offene DevTools) nach cdp.jsonl.
// Nach einem Neustart der App oder einem Abriss haengt er sich neu an (gen zaehlt mit).
// Usage: node sampler.mjs <port> <logdir>
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2]);
const dir = process.argv[3];
const hook = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hook.js"), "utf8");
const append = (file, line) => appendFileSync(join(dir, file), `${line}\n`);
const note = (text) => append("console.txt", `${new Date().toISOString()} ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const METRICS = ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "JSEventListeners", "LayoutCount", "TaskDuration", "ScriptDuration"];
const SNAP = `(() => { const tiles = [...document.querySelectorAll('.tile')];
  return { vis: document.visibilityState, focus: document.hasFocus(), tiles: tiles.length,
    shown: tiles.filter((x) => x.style.display !== 'none').length,
    gl: document.querySelectorAll('.xterm-screen canvas:not([class])').length,
    order: tiles.map((x) => [Number(x.dataset.position), x.querySelector('.tile-title')?.textContent ?? '?'])
      .sort((a, b) => a[0] - b[0]).map(([p, name]) => (p + 1) + ':' + name).join(' '),
    inner: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio, hook: !!window.__abHook }; })()`;
writeFileSync(join(dir, "sampler.pid"), String(process.pid));

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return [];
  }
}

for (let gen = 1; ; gen++) {
  let page;
  while (!(page = (await targets()).find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost")))) await sleep(25);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  if (!(await new Promise((resolve) => ((ws.onopen = () => resolve(true)), (ws.onerror = () => resolve(false)))))) {
    await sleep(200);
    continue;
  }
  let nextId = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++nextId, { resolve, reject });
      ws.send(JSON.stringify({ id: nextId, method, params }));
    });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const call = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) call?.reject(new Error(JSON.stringify(msg.error)));
      else call?.resolve(msg.result);
      return;
    }
    const p = msg.params;
    if (msg.method === "Runtime.bindingCalled" && p.name === "__abReport") append("page.jsonl", JSON.stringify({ gen, ...JSON.parse(p.payload) }));
    else if (msg.method === "Runtime.consoleAPICalled") note(`[console.${p.type}] ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    else if (msg.method === "Runtime.exceptionThrown") note(`[exception] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
    else if (msg.method === "Log.entryAdded") note(`[log.${p.entry.source}.${p.entry.level}] ${p.entry.text}`);
  };
  const closed = new Promise((resolve) => (ws.onclose = resolve));
  try {
    // Runtime.enable vor addBinding: sonst legt WebView2 die Bindung nicht in den schon
    // bestehenden Kontext, und der Haken meldet still nichts (Messung 21.10.).
    await send("Runtime.enable");
    await send("Runtime.addBinding", { name: "__abReport" });
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: hook });
    await send("Log.enable");
    await send("Performance.enable");
    await send("Runtime.evaluate", { expression: hook });
    const ua = await send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
    note(`SAMPLER gen ${gen} attached ${page.url} ${ua.result.value}`);
  } catch (error) {
    note(`SAMPLER gen ${gen} setup error ${error}`);
  }
  const timer = setInterval(async () => {
    try {
      const [metrics, snap, list] = await Promise.all([
        send("Performance.getMetrics"),
        send("Runtime.evaluate", { expression: SNAP, returnByValue: true }),
        targets(),
      ]);
      const m = Object.fromEntries(metrics.metrics.filter((x) => METRICS.includes(x.name)).map((x) => [x.name, x.value]));
      append("cdp.jsonl", JSON.stringify({ t: Date.now(), gen, ...snap.result.value, devtools: list.some((t) => t.url.startsWith("devtools://")), m }));
    } catch {
      /* Seite gerade weg */
    }
  }, 5000);
  await closed;
  clearInterval(timer);
  for (const call of pending.values()) call.reject(new Error("closed"));
  note(`SAMPLER gen ${gen} disconnected`);
  await sleep(200);
}
