// Oeffnet eine Session n-mal ueber die Seitenleiste und schliesst die Kachel wieder;
// zaehlt, wie oft das Oeffnen scheitert. Usage: node trials.mjs <port> <host> <session> <n>
import { connect, FIND, sleep, now } from "../../m1-tor-2026-10-23/werkzeuge/cdp.mjs";

const [port, label, session, n] = process.argv.slice(2);
const cdp = await connect(Number(port));
const q = JSON.stringify;
const tile = () => cdp.js(`${FIND}.tiles().find((t) => t.s === ${q(session)}) ?? null`);
const banner = () => cdp.js(`(() => { const b = document.querySelector('.global-error-banner'); return b && !b.hidden ? b.firstChild.textContent : null; })()`);
const results = [];
for (let i = 0; i < Number(n); i++) {
  await cdp.js(`window.__abCopied = []; navigator.clipboard.writeText = async (t) => { window.__abCopied.push(t); }; true`);
  const p = await cdp.js(`${FIND}.row(${q(label)}, ${q(session)})`);
  const t0 = now();
  await cdp.click(p);
  let t = null;
  // Ein gescheitertes Anhaengen zeigt sich erst nach der Pruefung: Sperre oder Banner.
  let b = null;
  for (const until = now() + 5000; now() < until; await sleep(100)) {
    t = await tile();
    b = await banner();
    if (b || t?.lock) break;
  }
  let detail = null;
  if (b) {
    await cdp.js(`[...document.querySelectorAll('.global-error-banner button')].find((x) => x.textContent.trim() === 'Copy details')?.click(); true`);
    await sleep(200);
    detail = (await cdp.js(`window.__abCopied`)).join(" ").split("\n").slice(1).join(" ");
    await cdp.js(`[...document.querySelectorAll('.global-error-banner button')].find((x) => x.textContent.trim() === 'Dismiss')?.click(); true`);
  }
  results.push({ i, ok: !!t && !t.lock && !b, ms: now() - t0, detail });
  console.log(JSON.stringify(results.at(-1)));
  await cdp.js(`(() => { const t = [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.tile-title')?.textContent === ${q(session)}); t?.querySelector(".tile-btn[aria-label='Close terminal']")?.click(); return true; })()`);
  await sleep(1500);
}
console.log(`ergebnis ${results.filter((r) => r.ok).length}/${results.length} geoeffnet`);
cdp.close();
