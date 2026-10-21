// Treiber der Fensterabnahme (Task 7, Step 2 und 3): echte CDP-Eingaben (Maus mit Modifikatoren,
// Tasten, Texteinfuegen) in die Testinstanz und Zeitmarken fuer `ana.mjs <logdir> check <von> <bis>`.
// Liest nur die Seite und page.jsonl des Samplers; schreibt nichts in die App ausser den Eingaben.
// Usage: node abnahme.mjs <port> <punkt> [args]
//   state                      Kacheln, Fokus, Opening, Banner
//   addhost <label> <host> <user> <keyPath>   Eintrag ueber das Formular (zweimal Absenden bei Doppelung)
//   open <hostLabel> <session> [ctrl]         Klick (oder Strg+Klick) auf die Sessionzeile
//   p1 <page.jsonl> <startMs>  waehrend Opening in Kachel 6 klicken und x tippen, nach ihrem open ok "da"
//   p2a | p2b | p3 | p3c | p4  die Punkte 2a, 2b (ohne Flut-Start), 3a/3b, 3c und 4 der Abnahme
//   head <n> | max <n> | close <n> | key <combo> | type <text>   Einzelschritte
//   shot <datei> [n]           Bildschirmfoto der Seite oder nur von Kachel n
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [portArg, point, ...args] = process.argv.slice(2);
const port = Number(portArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (label, value) => console.log(`${new Date().toISOString().slice(11, 23)} ${label}${value === undefined ? "" : " " + (typeof value === "string" ? value : JSON.stringify(value))}`);

async function pageTarget(timeoutMs) {
  const until = now() + timeoutMs;
  for (;;) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
      if (page) return page;
    } catch { /* Instanz startet noch */ }
    if (now() > until) throw new Error("keine Seite der Testinstanz");
    await sleep(50);
  }
}
const page = await pageTarget(point === "p1" ? 60000 : 5000);
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
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`EXCEPTION ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result.value;
}

// --- Seite: Finder (liefern Punkte in CSS-Pixeln) --------------------------------------------
const FIND = `(() => {
  const vis = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
  const tiles = () => [...document.querySelectorAll('.tile')];
  const tileN = (n) => tiles().find((t) => t.querySelector('.badge')?.textContent?.trim() === String(n));
  const tileS = (s) => tiles().find((t) => t.querySelector('.tile-title')?.textContent === s);
  const block = (label) => [...document.querySelectorAll('.sb-host-block')].find((b) => {
    const name = b.querySelector('.row-host .row-name, .row-host .host-label, .row-host')?.textContent ?? '';
    return name.replace(/^[A-Z]{1,2}/, '').startsWith(label);
  });
  const row = (label, s) => block(label)?.querySelector('.row-session[data-session-key$="/' + s + '"]');
  const pt = (r, dx) => r ? [Math.round(dx === undefined ? r.x + r.width / 2 : r.x + dx), Math.round(r.y + r.height / 2)] : null;
  const btn = (t, pred) => t ? [...t.querySelectorAll('.tile-btn')].find(pred) : null;
  return {
    head: (n) => { const t = tileN(n); const h = t?.querySelector('.tile-title') ?? t?.querySelector('.tile-head'); return pt(vis(h)); },
    term: (n) => pt(vis(tileN(n)?.querySelector('.xterm-screen') ?? tileN(n)?.querySelector('.tile-terminal'))),
    max: (n) => pt(vis(btn(tileN(n), (b) => (b.title || '').includes('Ctrl+Shift+M')))),
    close: (n) => pt(vis(btn(tileN(n), (b) => b.getAttribute('aria-label') === 'Close terminal'))),
    row: (label, s) => pt(vis(row(label, s)), 48),
    hostRow: (label) => pt(vis(block(label)?.querySelector('.row-host')), 60),
    tileRect: (n) => { const r = vis(tileN(n)); return r ? { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } : null; },
    state: () => {
      const b = document.querySelector('.global-error-banner');
      const all = tiles().sort((a, c) => Number(a.dataset.position) - Number(c.dataset.position));
      const name = (t) => t.querySelector('.badge')?.textContent?.trim() + ':' + t.querySelector('.tile-title')?.textContent;
      return {
        order: all.map(name).join(' '),
        shown: all.filter((t) => t.style.display !== 'none' && vis(t)).length,
        focused: all.filter((t) => t.classList.contains('focused')).map(name).join(','),
        opening: all.filter((t) => t.classList.contains('tile--opening') || t.querySelector('.tile--opening')).map(name).join(','),
        quiet: all.filter((t) => { const q = t.querySelector('.tile-quiet'); return q && !q.hidden; }).map(name).join(','),
        lock: all.filter((t) => { const q = t.querySelector('.tile-lock'); return q && !q.hidden; }).map(name).join(','),
        maximized: all.filter((t) => t.classList.contains('tile--maximized') || t.classList.contains('maximized')).map(name).join(','),
        banner: b && !b.hidden ? (b.classList.contains('global-error-banner--neutral') ? 'neutral: ' : 'danger: ') + (b.firstElementChild ?? b).textContent.trim() : null,
        gl: document.querySelectorAll('canvas').length,
        inner: innerWidth + 'x' + innerHeight,
      };
    },
  };
})()`;
const find = async (call) => js(`${FIND}.${call}`);
const state = () => find("state()");

// --- Eingaben -------------------------------------------------------------------------------
async function click([x, y], { ctrl = false } = {}) {
  const modifiers = ctrl ? 2 : 0;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, modifiers });
}
const KEYS = { Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }, Escape: { key: "Escape", code: "Escape", keyCode: 27 } };
async function key(combo) {
  const parts = combo.split("+");
  const name = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const modifiers = (mods.has("alt") ? 1 : 0) | (mods.has("ctrl") ? 2 : 0) | (mods.has("shift") ? 8 : 0);
  let info = KEYS[name];
  if (!info) {
    const lower = name.toLowerCase();
    const k = mods.has("shift") ? lower.toUpperCase() : lower;
    info = { key: k, code: `Key${lower.toUpperCase()}`, keyCode: lower.toUpperCase().charCodeAt(0), text: k };
  }
  const text = !mods.has("ctrl") && !mods.has("alt") ? info.text : undefined;
  const base = { modifiers, key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
  await send("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text });
  await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
const typeText = (text) => send("Input.insertText", { text });
async function must(call) {
  const p = await find(call);
  if (!p) throw new Error(`nicht gefunden: ${call}`);
  return p;
}
async function shot(file, n) {
  const clip = n ? await find(`tileRect(${n})`) : null;
  const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  writeFileSync(file, Buffer.from(data, "base64"));
  log("shot", file);
}
const q = (s) => JSON.stringify(s);

try {
  switch (point) {
    case "state":
      log("state", await state());
      break;
    case "hosts":
      log("hosts", await js(`[...document.querySelectorAll('.sb-host-block')].map((b) => { const h = b.querySelector('.row-host'); return (h?.textContent ?? '?').trim() + ' expanded=' + h?.getAttribute('aria-expanded') + ' sessions=' + b.querySelectorAll('.row-session').length; })`));
      break;
    case "head": await click(await must(`head(${args[0]})`)); log("head", args[0]); break;
    case "max": await click(await must(`max(${args[0]})`)); log("max", args[0]); break;
    case "close": await click(await must(`close(${args[0]})`)); log("close", args[0]); break;
    case "key": await key(args[0]); log("key", args[0]); break;
    case "type": await typeText(args[0]); log("type", args[0]); break;
    case "shot": await shot(args[0], args[1]); break;
    case "open": {
      const p = await must(`row(${q(args[0])}, ${q(args[1])})`);
      await click(p, { ctrl: args[2] === "ctrl" });
      log(`open ${args[0]}/${args[1]}${args[2] === "ctrl" ? " (Strg)" : ""}`);
      break;
    }
    case "addhost": {
      // Eintrag ueber das Formular: Felder per Setter und input-Ereignis, Schluessel in der Auswahl,
      // Absenden per echtem Klick; meldet das Formular eine Doppelung, ein zweites Mal absenden.
      const [label, host, user, keyPath] = args;
      const center = (sel) => js(`(() => { const e = document.querySelector(${q(sel)}); const r = e?.getBoundingClientRect(); return r && r.width ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null; })()`);
      await click(await center(".sb-btn"));
      let ready = false;
      for (const until = now() + 10000; !ready && now() < until; await sleep(100)) {
        ready = await js(`(() => { const s = document.querySelector('.host-form-view select[name="auth"]'); return !!s && [...s.options].some((o) => o.title === ${q(keyPath)}); })()`);
      }
      if (!ready) throw new Error("Formular oder Schluessel nicht da");
      log("Formular", await js(`(() => {
        const f = document.querySelector('.host-form-view form');
        const set = (name, value) => { const el = f.elements.namedItem(name); const proto = Object.getPrototypeOf(el); Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        set('label', ${q(label)}); set('hostname', ${q(host)}); set('user', ${q(user)});
        const sel = f.elements.namedItem('auth');
        sel.value = [...sel.options].find((o) => o.title === ${q(keyPath)}).value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { label: f.elements.namedItem('label').value, host: f.elements.namedItem('hostname').value, user: f.elements.namedItem('user').value, port: f.elements.namedItem('port').value, auth: sel.value };
      })()`));
      await click(await center(".host-form-view .host-form-actions button[type=submit]"));
      await sleep(800);
      const warning = await js(`document.querySelector('.host-form-view [role=alert]')?.textContent?.trim() ?? null`);
      log("nach dem ersten Absenden", warning);
      if (warning && (await center(".host-form-view .host-form-actions button[type=submit]"))) {
        await click(await center(".host-form-view .host-form-actions button[type=submit]"));
        await sleep(1500);
        log("nach dem zweiten Absenden", await js(`document.querySelector('.host-form-view') ? 'Formular noch offen: ' + (document.querySelector('.host-form-view [role=alert]')?.textContent ?? '') : 'Formular zu'`));
      }
      break;
    }
    case "p1": {
      // Punkt 1: waehrend Kachel 6 "Opening…" zeigt, in sie klicken und x tippen; nach ihrem
      // open_terminal ok (page.jsonl) "da" tippen. args: <page.jsonl> <startMs>
      const [pageFile, startArg] = args;
      const start = Number(startArg);
      let x = null;
      for (const until = now() + 60000; now() < until; await sleep(20)) {
        const st = await state().catch(() => null);
        if (st && st.opening.split(",").some((n) => n.startsWith("6:"))) {
          const p = await find("term(6)");
          if (p) {
            await click(p);
            await key("x");
            x = now();
            log("x in Kachel 6 waehrend Opening", st);
            break;
          }
        }
      }
      if (!x) log("Opening von Kachel 6 nicht gesehen: Review Focus 5 am Fenster nicht beobachtet");
      let done = null;
      for (const until = now() + 60000; !done && now() < until; await sleep(50)) {
        if (!existsSync(pageFile)) continue;
        done = readFileSync(pageFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
          .find((r) => r.cmd === "open_terminal" && r.ev === "done" && r.session === "f6" && r.t >= start);
      }
      if (!done) throw new Error("kein open_terminal f6 in page.jsonl");
      log("open_terminal f6", { outcome: done.outcome, ms: done.ms, err: done.err });
      await sleep(400);
      const p = await must("term(6)");
      await click(p);
      await key("d");
      await key("a");
      log("da getippt", await state());
      break;
    }
    case "p2a": {
      const from = now();
      log("von", from);
      await click(await must("head(3)"));
      await sleep(400);
      await click(await must("max(3)"));
      await sleep(600);
      log("maximiert (Knopf)", await state());
      await sleep(12000);
      await click(await must("max(3)"));
      await sleep(600);
      log("zurueck (Knopf)", await state());
      await sleep(1500);
      await key("Ctrl+Shift+M");
      await sleep(600);
      log("maximiert (Strg+Umschalt+M)", await state());
      await sleep(12000);
      await key("Ctrl+Shift+M");
      await sleep(1500);
      log("zurueck (Strg+Umschalt+M)", await state());
      log("bis", now());
      break;
    }
    case "p2b": {
      // Die Flut startet der Aufrufer unmittelbar vorher (vm.ps1 go L1 f1..f8, 180 s).
      const [shotDir] = args;
      await sleep(20000);
      await click(await must("term(1)"));
      await sleep(300);
      const typed = now();
      await typeText("echo ok");
      await key("Enter");
      log("echo ok getippt", typed);
      await sleep(250);
      if (shotDir) await shot(`${shotDir}\\p2b-echo-250ms.png`, 1);
      await sleep(750);
      if (shotDir) await shot(`${shotDir}\\p2b-echo-1000ms.png`, 1);
      await click(await must("head(2)"));
      await sleep(400);
      await click(await must("max(2)"));
      await sleep(600);
      log("Kachel 2 maximiert", await state());
      await sleep(45000);
      await click(await must("max(2)"));
      await sleep(1500);
      log("Kachel 2 zurueck", await state());
      break;
    }
    case "p3": {
      // 3a/3b: Kopf von Kachel 8, dann binnen ~3 s Strg+Klick auf x1, x2, f8 unter acht-a.
      const from = now();
      log("von", from);
      await click(await must("head(8)"));
      await sleep(500);
      for (const s of ["x1", "x2", "f8"]) {
        await click(await must(`row("acht-a", ${q(s)})`), { ctrl: true });
        log(`Strg+Klick ${s}`, now());
        await sleep(900);
      }
      await sleep(6000);
      log("danach", await state());
      log("bis", now());
      break;
    }
    case "p3c": {
      const from = now();
      log("von", from);
      await click(await must("head(9)"));
      await sleep(500);
      await click(await must('row("acht-a", "x1")'), { ctrl: true });
      await sleep(1500);
      log("danach", await state());
      log("bis", now());
      break;
    }
    case "p4": {
      const from = now();
      log("von", from);
      for (let n = 8; n >= 3; n--) {
        const st = await state();
        const at = st.order.split(" ").find((x) => x.startsWith(`${n}:`));
        if (at && /:f[3-8]$/.test(at)) {
          await click(await must(`close(${n})`));
          await sleep(500);
        }
      }
      await sleep(2500);
      log("nach dem Schliessen", await state());
      const picks = now();
      for (const s of ["f3", "f4", "f5", "f6", "f7"]) {
        await click(await must(`row("acht-a", ${q(s)})`));
        await sleep(350);
      }
      log("fuenf Klicks in ms", now() - picks);
      log("gleich danach", await state());
      await key("Ctrl+Shift+M");
      await sleep(600);
      log("Strg+Umschalt+M", await state());
      await sleep(5000);
      await key("Ctrl+Shift+M");
      await sleep(2000);
      log("zurueck", await state());
      await sleep(8000);
      log("nach den Oeffnungen", await state());
      await click(await must('row("acht-a", "f8")'));
      await sleep(4000);
      log("f8", await state());
      await click(await must('row("acht-a", "x1")'));
      await sleep(1500);
      log("x1 unter acht-a", await state());
      await click(await must('row("acht-b", "x2")'));
      await sleep(1500);
      log("x2 unter acht-b", await state());
      log("bis", now());
      break;
    }
    default:
      throw new Error(`unbekannter Punkt ${point}`);
  }
} finally {
  ws.close();
}
