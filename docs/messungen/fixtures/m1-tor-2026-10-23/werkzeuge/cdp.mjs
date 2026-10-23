// CDP-Anbindung an die Testinstanz (WebView2 mit --remote-debugging-port).
// Liest die Seite und schickt echte Eingaben; schreibt nichts in die App.
import { writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();

export async function connect(port, timeoutMs = 10000) {
  const until = now() + timeoutMs;
  let page;
  for (;;) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
      if (page) break;
    } catch {
      /* Instanz startet noch */
    }
    if (now() > until) throw new Error("keine Seite der Testinstanz");
    await sleep(100);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  let closed = false;
  ws.addEventListener("close", () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error("CDP geschlossen"));
    pending.clear();
  });
  const send = (method, params = {}) => {
    if (closed) return Promise.reject(new Error("CDP geschlossen"));
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const js = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`EXCEPTION ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    return r.result.value;
  };
  const mouse = async (type, [x, y], extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  const click = async (p, { ctrl = false, count = 1 } = {}) => {
    const modifiers = ctrl ? 2 : 0;
    await mouse("mouseMoved", p, { modifiers });
    for (let i = 1; i <= count; i++) {
      await mouse("mousePressed", p, { button: "left", buttons: 1, clickCount: i, modifiers });
      await mouse("mouseReleased", p, { button: "left", buttons: 0, clickCount: i, modifiers });
    }
  };
  const drag = async (from, to, steps = 12) => {
    await mouse("mouseMoved", from);
    await mouse("mousePressed", from, { button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const p = [Math.round(from[0] + ((to[0] - from[0]) * i) / steps), Math.round(from[1] + ((to[1] - from[1]) * i) / steps)];
      await mouse("mouseMoved", p, { button: "left", buttons: 1 });
      await sleep(25);
    }
    await mouse("mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 });
  };
  const KEYS = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  };
  const key = async (combo) => {
    const parts = combo.split("+");
    const name = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    const modifiers = (mods.has("alt") ? 1 : 0) | (mods.has("ctrl") ? 2 : 0) | (mods.has("shift") ? 8 : 0);
    let info = KEYS[name];
    if (!info && /^[0-9]$/.test(name)) info = { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
    if (!info) {
      const lower = name.toLowerCase();
      const k = mods.has("shift") ? lower.toUpperCase() : lower;
      info = { key: k, code: `Key${lower.toUpperCase()}`, keyCode: lower.toUpperCase().charCodeAt(0), text: k };
    }
    const text = !mods.has("ctrl") && !mods.has("alt") ? info.text : undefined;
    const base = { modifiers, key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
    await send("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text });
    await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  };
  const type = (text) => send("Input.insertText", { text });
  const shot = async (file, clip) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(file, Buffer.from(data, "base64"));
  };
  return { send, js, click, drag, key, type, shot, close: () => ws.close() };
}

// Finder in der Seite. Hostblock nach Anzeigename (Initialen vorn abgezogen).
export const FIND = `(() => {
  const vis = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
  const tiles = () => [...document.querySelectorAll('.tile')];
  const tileN = (n) => tiles().find((t) => t.querySelector('.badge')?.textContent?.trim() === String(n));
  const hostName = (b) => (b.querySelector('.row-host .row-label, .row-host .row-name, .row-host')?.textContent ?? '').trim();
  const block = (label) => [...document.querySelectorAll('.sb-host-block')].find((b) => {
    const h = b.querySelector('.row-host');
    return h && (h.textContent ?? '').includes(label);
  });
  const row = (label, s) => [...(block(label)?.querySelectorAll('.row-session') ?? [])].find((r) => r.querySelector('.row-label')?.textContent === s);
  const pt = (r, dx) => r ? [Math.round(dx === undefined ? r.x + r.width / 2 : r.x + dx), Math.round(r.y + r.height / 2)] : null;
  const btn = (t, pred) => t ? [...t.querySelectorAll('.tile-btn')].find(pred) : null;
  const pill = (el) => { const p = el?.querySelector('.st'); return p ? { kind: [...p.classList].find((c) => c.startsWith('st-'))?.slice(3), word: p.textContent.trim(), title: p.title } : null; };
  return {
    head: (n) => { const t = tileN(n); const h = t?.querySelector('.tile-title') ?? t?.querySelector('.tile-head'); return pt(vis(h)); },
    term: (n) => pt(vis(tileN(n)?.querySelector('.xterm-screen') ?? tileN(n)?.querySelector('.tile-terminal'))),
    max: (n) => pt(vis(btn(tileN(n), (b) => (b.title || '').includes('Ctrl+Shift+M')))),
    close: (n) => pt(vis(btn(tileN(n), (b) => b.getAttribute('aria-label') === 'Close terminal'))),
    row: (label, s) => pt(vis(row(label, s)), 48),
    hostRow: (label) => pt(vis(block(label)?.querySelector('.row-host')), 60),
    hostButton: (label, text) => { const b = block(label); const e = b && [...b.querySelectorAll('button')].find((x) => x.textContent.trim() === text || x.getAttribute('aria-label') === text); if (e) { e.click(); return true; } return false; },
    tileRect: (n) => { const r = vis(tileN(n)); return r ? { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } : null; },
    rows: () => [...document.querySelectorAll('.sb-host-block')].flatMap((b) => {
      const host = (b.querySelector('.row-host')?.textContent ?? '?').trim().slice(0, 40);
      return [...b.querySelectorAll('.row-session')].map((r) => ({ host, s: r.querySelector('.row-label')?.textContent, p: pill(r) }));
    }),
    tiles: () => tiles().sort((a, c) => Number(a.dataset.position) - Number(c.dataset.position)).map((t) => ({
      n: t.querySelector('.badge')?.textContent?.trim(), s: t.querySelector('.tile-title')?.textContent, p: pill(t.querySelector('.tile-head') ?? t),
      shown: !!vis(t), focused: t.classList.contains('focused'),
      opening: t.classList.contains('tile--opening') || !!t.querySelector('.tile--opening'),
      lock: (() => { const q = t.querySelector('.tile-lock'); return !!q && !q.hidden; })(),
      quiet: (() => { const q = t.querySelector('.tile-quiet'); return q && !q.hidden ? q.textContent.trim() : null; })(),
      max: t.classList.contains('tile--maximized') || t.classList.contains('maximized'),
    })),
    lane: () => [...document.querySelectorAll('.sb-lane .row-lane')].map((r) => (r.querySelector('.row-label')?.textContent ?? '') + ' | ' + (r.querySelector('.row-lane-time')?.textContent ?? '') + ' | ' + (r.querySelector('.row-lane-reason')?.textContent ?? '')),
    banner: () => { const b = document.querySelector('.global-error-banner'); return b && !b.hidden ? b.textContent.trim() : null; },
    notices: () => [...document.querySelectorAll('.host-notice, .control-notice, .sb-host-block .row-meta')].filter((e) => vis(e)).map((e) => e.textContent.trim()).filter(Boolean),
    title: () => document.title,
  };
})()`;
