// Einzelschritte am Fenster der Testinstanz ueber CDP.
// Usage: node gate.mjs <port> <befehl> [args]
//   state | rows | tiles | lane | title
//   addhost <label> <host> <user> <keyPath>    Eintrag ueber das Formular
//   hostbtn <label> <text>                      Knopf im Hostblock (Connect, Disconnect, Reload sessions)
//   open <label> <session> [ctrl]               Klick (Strg+Klick) auf die Sessionzeile
//   head|term|max|close <n>                     Kachel n
//   swap <a> <b>                                Zug am Kopf von Kachel a auf Kachel b
//   key <combo> | type <text> | shot <datei> [n]
//   waitrow <label> <session> <kind> <ms>       wartet, bis die Zeile die Pille kind zeigt
import { connect, FIND, sleep, now } from "./cdp.mjs";

const [portArg, cmd, ...args] = process.argv.slice(2);
const cdp = await connect(Number(portArg));
const q = (s) => JSON.stringify(s);
const find = (call) => cdp.js(`${FIND}.${call}`);
const must = async (call) => {
  const p = await find(call);
  if (!p) throw new Error(`nicht gefunden: ${call}`);
  return p;
};
const log = (label, value) =>
  console.log(`${new Date().toISOString().slice(11, 23)} ${label}${value === undefined ? "" : " " + (typeof value === "string" ? value : JSON.stringify(value))}`);

try {
  switch (cmd) {
    case "state":
      log("tiles", await find("tiles()"));
      log("lane", await find("lane()"));
      log("title", await find("title()"));
      log("banner", await find("banner()"));
      log("notices", await find("notices()"));
      break;
    case "rows": for (const r of await find("rows()")) log(`${r.host} / ${r.s}`, r.p); break;
    case "tiles": for (const t of await find("tiles()")) log(`${t.n}:${t.s}`, t); break;
    case "lane": log("lane", await find("lane()")); break;
    case "title": log("title", await find("title()")); break;
    case "hostbtn": log(`hostbtn ${args[0]} ${args[1]}`, await find(`hostButton(${q(args[0])}, ${q(args[1])})`)); break;
    case "open": {
      await cdp.click(await must(`row(${q(args[0])}, ${q(args[1])})`), { ctrl: args[2] === "ctrl" });
      log(`open ${args[0]}/${args[1]}${args[2] === "ctrl" ? " (Strg)" : ""}`);
      break;
    }
    case "head": case "term": case "max": case "close":
      await cdp.click(await must(`${cmd}(${args[0]})`));
      log(cmd, args[0]);
      break;
    case "swap": {
      const from = await must(`head(${args[0]})`);
      const to = await must(`head(${args[1]})`);
      await cdp.drag(from, to);
      log("swap", `${args[0]} -> ${args[1]}`);
      break;
    }
    case "key": await cdp.key(args[0]); log("key", args[0]); break;
    case "type": await cdp.type(args[0]); log("type", args[0]); break;
    case "shot": await cdp.shot(args[0], args[1] ? await find(`tileRect(${args[1]})`) : undefined); log("shot", args[0]); break;
    case "waitrow": {
      const [label, s, kind, ms] = args;
      const until = now() + Number(ms);
      let p = null;
      for (; now() < until; await sleep(100)) {
        p = (await find("rows()")).find((r) => r.host.includes(label) && r.s === s)?.p ?? null;
        if (p?.kind === kind) break;
      }
      log(`waitrow ${label}/${s}`, p);
      break;
    }
    case "addhost": {
      const [label, host, user, keyPath] = args;
      const center = (sel) =>
        cdp.js(`(() => { const e = [...document.querySelectorAll(${q(sel)})].pop(); const r = e?.getBoundingClientRect(); return r && r.width ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null; })()`);
      const open = await cdp.js(`document.querySelectorAll(".host-form-view").length`);
      if (open < 2) await cdp.click(await center(".sb-btn"));
      let ready = false;
      for (const until = now() + 10000; !ready && now() < until; await sleep(100)) {
        ready = await cdp.js(`(() => { const s = [...document.querySelectorAll('.host-form-view')].pop()?.querySelector('select[name="auth"]'); return !!s && [...s.options].some((o) => o.title === ${q(keyPath)} || o.textContent.includes(${q(keyPath)})); })()`);
      }
      if (!ready) {
        log("Formular", await cdp.js(`(() => { const s = [...document.querySelectorAll('.host-form-view')].pop()?.querySelector('select[name="auth"]'); return s ? [...s.options].map((o) => o.value + '|' + o.title + '|' + o.textContent) : 'kein Formular'; })()`));
        throw new Error("Formular oder Schluessel nicht da");
      }
      log("Formular", await cdp.js(`(() => {
        const f = [...document.querySelectorAll('.host-form-view')].pop().querySelector('form');
        const set = (name, value) => { const el = f.elements.namedItem(name); const proto = Object.getPrototypeOf(el); Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        set('label', ${q(label)}); set('hostname', ${q(host)}); set('user', ${q(user)});
        const sel = f.elements.namedItem('auth');
        sel.value = [...sel.options].find((o) => o.title === ${q(keyPath)} || o.textContent.includes(${q(keyPath)})).value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { label: f.elements.namedItem('label').value, host: f.elements.namedItem('hostname').value, user: f.elements.namedItem('user').value, auth: sel.value };
      })()`));
      const submit = ".host-form-view .host-form-actions button[type=submit]";
      await cdp.click(await center(submit));
      await sleep(800);
      const warning = await cdp.js(`document.querySelector('.host-form-view [role=alert]')?.textContent?.trim() ?? null`);
      log("nach dem Absenden", warning);
      if (warning && (await center(submit))) {
        await cdp.click(await center(submit));
        await sleep(1500);
        log("zweites Absenden", await cdp.js(`document.querySelector('.host-form-view') ? 'Formular offen: ' + (document.querySelector('.host-form-view [role=alert]')?.textContent ?? '') : 'Formular zu'`));
      }
      break;
    }
    case "newsession": {
      // Dialog "New session" des Hosts: Name und Ordner per Setter, Absenden per echtem Klick.
      const [label, name, cwd] = args;
      log("Knopf", await find(`hostButton(${q(label)}, "New session")`));
      let ready = false;
      for (const until = now() + 10000; !ready && now() < until; await sleep(100)) {
        ready = await cdp.js(`!!document.querySelector('.session-dialog-view input[name="sessionName"]')`);
      }
      if (!ready) throw new Error("Dialog nicht da");
      await sleep(300);
      log("Dialog", await cdp.js(`(() => {
        const set = (name, value) => { const el = document.querySelector('.session-dialog-view [name="' + name + '"]'); const proto = Object.getPrototypeOf(el); Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; };
        return { cwd: set('cwd', ${q(cwd)}), name: set('sessionName', ${q(name)}) };
      })()`));
      const p = await cdp.js(`(() => { const e = document.querySelector('.session-dialog-actions .btn--primary'); const r = e?.getBoundingClientRect(); return r && r.width ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null; })()`);
      await cdp.click(p);
      await sleep(1500);
      log("nach dem Absenden", await cdp.js(`document.querySelector('.session-dialog-view') ? 'Dialog offen: ' + (document.querySelector('.session-dialog-view [role=alert]')?.textContent ?? '') : 'Dialog zu'`));
      break;
    }
    case "button": {
      // sichtbarer Knopf mit genau dieser Beschriftung, der zuletzt im Dokument stehende (oberster Dialog)
      const p = await cdp.js(`(() => { const b = [...document.querySelectorAll("button")].filter((e) => (e.textContent.trim() === ${q(args[0])} || e.getAttribute("aria-label") === ${q(args[0])}) && e.getBoundingClientRect().width > 0).pop(); const r = b?.getBoundingClientRect(); return r ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null; })()`);
      if (!p) throw new Error(`kein Knopf ${args[0]}`);
      await cdp.click(p);
      log("button", args[0]);
      break;
    }
    case "eval": log("eval", await cdp.js(args[0])); break;
    default:
      throw new Error(`unbekannter Befehl ${cmd}`);
  }
} finally {
  cdp.close();
}
