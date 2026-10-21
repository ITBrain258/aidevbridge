// Seitenhaken der Lastmessung (per CDP eingesetzt, nie Teil der App; aendert an ihr nichts).
// Meldet ueber die Bindung __abReport, die sampler.mjs nach page.jsonl schreibt:
// - IPC mit Sende- und Antwortzeit fuer open/resize/close_terminal, poll_status,
//   list_sessions und send_input: {ev:"send"} und {ev:"done", ms, outcome, err};
// - {cmd:"poll_partial"}, wenn poll_status ok antwortet, aber ohne Titel oder ohne
//   `claude agents` (titles_ok/agents_ok false, etwa an der Exec-Grenze gescheitert);
// - alle 5 s {cmd:"window"}: je openId [bestaetigte Bytes, laengste Luecke zwischen zwei
//   ack_output bis zum Fensterende] und die Verspaetungen eines 100-ms-Takts (lags);
// - {cmd:"dom"} bei jeder Aenderung: Pille der Probe p1, Kacheln, Kacheln mit
//   tile--opening, sichtbarer Ruhe-Chip ohne opening, Sperrleiste, Banner;
// - {cmd:"visibility"} bei jedem visibilitychange.
(() => {
  if (window.__abHook) return;
  window.__abHook = Date.now();
  const report = (rec) => {
    try { window.__abReport(JSON.stringify(rec)); } catch { /* ohne Bindung still */ }
  };
  const TIMED = new Set(["open_terminal", "resize_terminal", "close_terminal", "poll_status", "list_sessions", "send_input"]);
  const acks = new Map();
  const origFetch = window.fetch;
  window.fetch = function (resource, init) {
    const promise = origFetch.apply(window, arguments);
    try {
      const url = typeof resource === "string" ? resource : resource?.url;
      const cmd = url?.includes("ipc.localhost") ? decodeURIComponent(url.split("?")[0].split("/").pop() || "") : "";
      if (cmd !== "ack_output" && !TIMED.has(cmd)) return promise;
      const t = Date.now();
      const a = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (cmd === "ack_output") {
        const s = acks.get(a.openId) ?? { bytes: 0, last: t, gap: 0 };
        s.gap = Math.max(s.gap, t - s.last);
        s.last = t;
        s.bytes += a.byteCount ?? 0;
        acks.set(a.openId, s);
        return promise;
      }
      const rec = { t, cmd, hostId: a.hostId, session: a.session, openId: a.openId, cols: a.cols, rows: a.rows };
      report({ ...rec, ev: "send" });
      const done = (extra) => report({ ...rec, ev: "done", ms: Date.now() - t, ...extra });
      promise.then((resp) => {
        const outcome = resp.headers.get("Tauri-Response");
        if (outcome === "ok") {
          done({ outcome });
          if (cmd === "poll_status") resp.clone().json().then((b) => { if (!b.titles_ok || !b.agents_ok) report({ t, cmd: "poll_partial", hostId: a.hostId, titles_ok: b.titles_ok, agents_ok: b.agents_ok }); }, () => {});
        } else resp.clone().text().then((text) => done({ outcome, err: text.slice(0, 300) }), () => done({ outcome }));
      }, (error) => done({ err: String(error) }));
    } catch { /* nie die App stoeren */ }
    return promise;
  };
  let lags = [];
  let tick = performance.now();
  setInterval(() => {
    const now = performance.now();
    lags.push(Math.round(now - tick - 100));
    tick = now;
  }, 100);
  setInterval(() => {
    const t = Date.now();
    const per = {};
    for (const [id, s] of acks) {
      per[id] = [s.bytes, Math.max(s.gap, t - s.last)];
      if (s.bytes === 0 && t - s.last > 60000) acks.delete(id);
      s.bytes = 0;
      s.gap = 0;
    }
    report({ t, cmd: "window", acks: per, lags });
    lags = [];
  }, 5000);
  document.addEventListener("visibilitychange", () => report({ t: Date.now(), cmd: "visibility", state: document.visibilityState }));
  let last = "";
  const shown = (el) => el !== null && !el.hidden;
  const opening = (x) => x.classList.contains("tile--opening") || x.querySelector(".tile--opening") !== null;
  const names = (tiles) => tiles.map((x) => x.querySelector(".tile-title")?.textContent ?? "?");
  const scan = () => {
    try {
      const tiles = [...document.querySelectorAll(".tile")];
      const pill = document.querySelector('.sb-host-block .row-session[data-session-key$="/p1"] .st');
      const banner = document.querySelector(".global-error-banner");
      const state = {
        probe: pill ? pill.className.replace(/^st st-/, "") : null,
        tiles: tiles.length,
        opening: names(tiles.filter(opening)),
        quiet: names(tiles.filter((x) => !opening(x) && shown(x.querySelector(".tile-quiet")))),
        lock: names(tiles.filter((x) => shown(x.querySelector(".tile-lock")))),
        banner: shown(banner)
          ? `${banner.classList.contains("global-error-banner--neutral") ? "neutral" : "danger"}: ${(banner.firstElementChild ?? banner).textContent.trim().slice(0, 200)}`
          : null,
      };
      const key = JSON.stringify(state);
      if (key !== last) {
        last = key;
        report({ t: Date.now(), cmd: "dom", ...state });
      }
    } catch { /* nie die App stoeren */ }
  };
  const observe = () => {
    if (!document.body) return void setTimeout(observe, 50);
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden"] });
    scan();
  };
  observe();
})();
