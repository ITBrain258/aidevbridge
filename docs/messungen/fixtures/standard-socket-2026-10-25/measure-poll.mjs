// Plan M3.1, Schritt 1b: Dauer jeder poll_status-Abfrage der App, je Host,
// ueber einen Wrapper um __TAURI_INTERNALS__.invoke.
// Usage: node measure-poll.mjs <werkzeuge-dir> <port> <sekunden> <ausgabe.json>
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [tools, portArg, secondsArg, outFile] = process.argv.slice(2);
const { connect, sleep } = await import(pathToFileURL(join(tools, "cdp.mjs")).href);
const cdp = await connect(Number(portArg));
await cdp.js(`(() => {
  window.__polls = [];
  if (window.__pollWrapped) return "reset";
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.endsWith("/poll_status")) return original(input, init);
    const start = performance.now();
    return original(input, init).then((response) => {
      window.__polls.push({ host: "vm10", ms: Math.round(performance.now() - start), ok: response.ok, at: Date.now() });
      return response;
    });
  };
  window.__pollWrapped = true;
  return "installed";
})()`);
await sleep(Number(secondsArg) * 1000);
const polls = await cdp.js("window.__polls");
writeFileSync(outFile, JSON.stringify(polls));
const byHost = new Map();
for (const p of polls) {
  if (!byHost.has(p.host)) byHost.set(p.host, []);
  byHost.get(p.host).push(p);
}
for (const [host, list] of byHost) {
  const ms = list.filter((p) => p.ok).map((p) => p.ms).sort((a, b) => a - b);
  const q = (f) => ms[Math.min(ms.length - 1, Math.floor(f * ms.length))];
  console.log(JSON.stringify({ host, n: list.length, failed: list.length - ms.length, median: q(0.5), p95: q(0.95), max: ms[ms.length - 1] }));
}
cdp.close();
