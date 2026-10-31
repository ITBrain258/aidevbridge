// Rendert die Bilder fuer README, GitHub und den Store-Eintrag aus der echten
// Oberflaeche mit Beispieldaten (`scenes.mjs`), ohne Host und ohne Backend
// (`tauri-stub.js`):
//
//   node scripts/readme-images/render.mjs [hero details phones how-it-works social]
//
// Vite liefert das Frontend, Microsoft Edge (oder der Browser aus
// AIDEVBRIDGE_BROWSER) rendert es ueber das DevTools-Protokoll; neue Abhaengigkeiten
// gibt es nicht. Die Version im Bild kommt aus package.json, der Commit aus dem Tag
// dieser Version. Nach einem Release, das die Oberflaeche aendert, neu ausfuehren.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { desktopScene, phoneScene, waitingSteps } from "./scenes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const images = join(root, "docs", "images");
const stores = join(root, "fastlane", "metadata", "android");
const stubSource = readFileSync(join(here, "tauri-stub.js"), "utf8");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function tagCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", `v${version}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  }
}

function findBrowser() {
  const candidates = [
    process.env.AIDEVBRIDGE_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("Kein Browser gefunden; AIDEVBRIDGE_BROWSER setzen.");
  return found;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function startBrowser() {
  const profile = mkdtempSync(join(tmpdir(), "aidevbridge-readme-images-"));
  // Die doppelte Dichte kommt als Startoption, nicht aus der Emulation: Mit
  // emuliertem Faktor zeichnet der WebGL-Renderer von xterm.js doppelt so gross.
  const child = spawn(
    findBrowser(),
    ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=2", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port] = readFileSync(portFile, "utf8").split("\n");
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  let nextId = 1;
  const waiting = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.fail(new Error(`${pending.method}: ${message.error.message}`));
    else pending.done(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      const id = nextId++;
      waiting.set(id, { done, fail, method });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return {
    send,
    async close() {
      socket.close();
      child.kill();
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Edge haelt den Profilordner manchmal noch kurz; er liegt im Temp-Ordner.
      }
    },
  };
}

async function openPage(browser, { width, height, userAgent, touch = false, init = "" }) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
  if (userAgent) await send("Emulation.setUserAgentOverride", { userAgent });
  if (touch) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  if (init) await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
  return {
    send,
    goto: (url) => send("Page.navigate", { url }),
    async evaluate(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      return result.value;
    },
    async waitFor(expression, what = expression, timeoutMs = 20000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await this.evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error(`Zeitueberschreitung: ${what}`);
    },
    async press(key, code, windowsVirtualKeyCode, modifiers = 0) {
      const base = { key, code, windowsVirtualKeyCode, modifiers };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async click(x, y) {
      const base = { x, y, button: "left", clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    },
    async rect(selector) {
      return this.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    },
    /** `outScale` 0.5 ergibt ein Bild in CSS-Pixeln statt in doppelter Dichte. */
    async shot(target, clip, outScale = 1) {
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        ...(clip ? { clip: { ...clip, scale: outScale } } : {}),
      });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(data, "base64"));
      if (target.startsWith(root)) console.log(target.slice(root.length + 1).replaceAll("\\", "/"));
    },
    close: () => browser.send("Target.closeTarget", { targetId }),
  };
}

function appInit(scene) {
  return `window.__SCENE__ = ${JSON.stringify(scene)};\ntry { localStorage.setItem("ab.theme", ${JSON.stringify(scene.settings.theme)}); } catch {}\n${stubSource}`;
}

function sessionName(scene, id) {
  for (const host of scene.hosts) {
    const found = host.sessions.find((session) => session.id === id);
    if (found) return found.name;
  }
  throw new Error(`Session ${id} fehlt`);
}

/** Oeffnet die App und bringt die wartenden Sessions in die Reihenfolge der Szene: Die
 * Uhr laeuft zwischen den Schritten vor, und der naechste Poll traegt den Status ein. */
async function openApp(browser, url, scene, viewport) {
  const page = await openPage(browser, { ...viewport, init: appInit(scene) });
  await page.goto(url);
  await page.waitFor(`document.querySelectorAll('.xterm-screen').length >= ${scene.settings.workspace.tiles.length}`, "Terminals offen");
  await page.waitFor(`document.querySelectorAll('.st').length > 0`, "Statuspillen");
  let clock = 0;
  const latest = Math.max(...waitingSteps.map((step) => step.minutesAgo));
  for (const step of [...waitingSteps].sort((a, b) => b.minutesAgo - a.minutesAgo)) {
    const target = latest - step.minutesAgo;
    await page.evaluate(`window.__sceneControl.advance(${(target - clock) * 60000})`);
    clock = target;
    await page.evaluate(`window.__sceneControl.setStatus(${step.id}, "waiting", ${JSON.stringify(step.reason)})`);
    const inLane = `[...document.querySelectorAll('.row-lane .row-label')].some((el) => el.textContent === ${JSON.stringify(sessionName(scene, step.id))})`;
    await page.waitFor(inLane, `Wartet-Spur ${step.id}`);
  }
  await page.evaluate(`window.__sceneControl.advance(${(latest - clock) * 60000 + 5000})`);
  return page;
}

/** Fokus auf die erste Kachel; das Neuzeichnen zeigt zugleich die Wartezeiten der Spur. */
async function focusFirstTile(page) {
  const box = await page.rect(".tile .xterm-screen");
  await page.click(box.x + box.width / 2, box.y + box.height - 40);
  await sleep(500);
}

const clickByText = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)})); el.click(); return true; })()`;

const DESKTOP = { width: 1560, height: 960 };
const PHONE = {
  width: 484,
  height: 960,
  touch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
};

/** Ein Quellbild in einer Vorlage aus diesem Ordner rendern. */
async function renderTemplate(browser, template, viewport, target, query = {}, outScale = 1) {
  const page = await openPage(browser, viewport);
  const search = new URLSearchParams(query).toString();
  await page.goto(`${pathToFileURL(join(here, template)).href}${search ? `?${search}` : ""}`);
  await page.waitFor(`document.readyState === 'complete' && [...document.images].every((img) => img.complete && img.naturalWidth > 0)`, template);
  await page.evaluate(`document.fonts.ready.then(() => true)`);
  await sleep(200);
  await page.shot(target, { x: 0, y: 0, width: viewport.width, height: viewport.height }, outScale);
  await page.close();
}

export const renderers = {
  async hero({ browser, url, temp }) {
    const page = await openApp(browser, url, desktopScene, DESKTOP);
    await focusFirstTile(page);
    const raw = join(temp, "hero-raw.png");
    await page.shot(raw);
    const title = await page.evaluate("document.title");
    await page.close();
    await renderTemplate(browser, "window-frame.html", { width: DESKTOP.width + 2, height: DESKTOP.height + 38 }, join(images, "hero.png"), {
      src: pathToFileURL(raw).href,
      title,
    });
  },

  async details({ browser, url }) {
    const page = await openApp(browser, url, desktopScene, DESKTOP);
    await focusFirstTile(page);
    const sidebar = await page.rect("#sidebar");
    await page.shot(join(images, "waiting-lane.png"), { x: sidebar.x, y: sidebar.y, width: sidebar.width + 2, height: 480 });

    await page.press("P", "KeyP", 80, 10);
    await page.waitFor(`document.querySelector('.quick-open-input') !== null`, "Schnelloeffnen");
    await page.send("Input.insertText", { text: "build" });
    await sleep(300);
    const quick = await page.rect(".quick-open");
    const margin = 10;
    await page.shot(join(images, "quick-open.png"), { x: quick.x - margin, y: quick.y - margin, width: quick.width + 2 * margin, height: quick.height + 2 * margin });
    await page.press("Escape", "Escape", 27);
    await sleep(200);

    await page.press(",", "Comma", 188, 2);
    await page.waitFor(`document.querySelector('.settings-view') !== null`, "Einstellungen");
    await page.evaluate(clickByText(".settings-tab", "Appearance"));
    await page.waitFor(`document.querySelector('.settings-appearance') !== null`, "Darstellung");
    await sleep(200);
    const dialog = await page.rect(".settings-view");
    await page.shot(join(images, "themes.png"), { ...dialog, height: 284 });
    await page.close();
  },

  async phones({ browser, url, temp }) {
    const shots = [join(temp, "phone-1.png"), join(temp, "phone-2.png"), join(temp, "phone-3.png")];
    const page = await openApp(browser, url, phoneScene, PHONE);
    await focusFirstTile(page);
    await page.shot(shots[0]);
    await page.evaluate(`document.querySelector('.compact-bar-toggle').click()`);
    await sleep(500);
    await page.shot(shots[1]);
    await page.evaluate(clickByText("button", "Add host"));
    await page.waitFor(`document.querySelector('select[name=auth]') !== null`, "Hostformular");
    await page.evaluate(`(() => {
      const set = (name, value) => {
        const el = document.querySelector('[name=' + name + ']');
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('label', 'build-box');
      set('hostname', '192.0.2.10');
      set('user', 'dev');
      const auth = document.querySelector('select[name=auth]');
      auth.value = 'generate-key';
      auth.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(500);
    await page.evaluate(`document.activeElement?.blur()`);
    await sleep(200);
    await page.shot(shots[2]);
    await page.close();
    for (const locale of readdirSync(stores)) {
      shots.forEach((shot, index) => {
        const target = join(stores, locale, "images", "phoneScreenshots", `${index + 1}.png`);
        writeFileSync(target, readFileSync(shot));
        console.log(target.slice(root.length + 1).replaceAll("\\", "/"));
      });
    }
    await renderTemplate(browser, "phones.html", { width: 760, height: 780 }, join(images, "phones.png"), {
      a: pathToFileURL(shots[0]).href,
      b: pathToFileURL(shots[1]).href,
    });
  },

  async "how-it-works"({ browser }) {
    await renderTemplate(browser, "how-it-works.html", { width: 1200, height: 420 }, join(images, "how-it-works.png"));
  },

  async social({ browser }) {
    await renderTemplate(browser, "social-preview.html", { width: 1280, height: 640 }, join(images, "social-preview.png"), {}, 0.5);
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((name) => !(name in renderers));
  if (unknown.length > 0) throw new Error(`Unbekannte Bilder: ${unknown.join(", ")}`);
  const server = await createServer({
    configFile: join(root, "vite.config.ts"),
    root,
    logLevel: "error",
    define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(tagCommit()) },
    server: { port: 1437, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const browser = await startBrowser();
  const temp = mkdtempSync(join(tmpdir(), "aidevbridge-readme-shots-"));
  try {
    for (const [name, render] of Object.entries(renderers)) {
      if (wanted.length === 0 || wanted.includes(name)) await render({ browser, url, temp });
    }
  } finally {
    await browser.close();
    await server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
