// Ersetzt im Browser das Rust-Backend der App: Die Oberflaeche laeuft unveraendert
// und bekommt aus `window.__SCENE__` nur Beispieldaten, ohne Netz und ohne Host.
// Nur fuer `scripts/readme-images/render.mjs`; geht in keine App.
(() => {
  const scene = window.__SCENE__;
  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;

  const statusById = new Map();
  for (const host of scene.hosts) {
    for (const session of host.sessions ?? []) statusById.set(session.id, { status: session.status, reason: session.reason });
  }
  let settings = { ...scene.settings };
  const runtimeHost = new Map();
  let clockOffset = 0;
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + clockOffset;

  const encoder = new TextEncoder();

  function transformCallback(callback, once) {
    const id = nextId++;
    callbacks.set(id, (payload) => {
      if (once) callbacks.delete(id);
      return callback?.(payload);
    });
    return id;
  }

  function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) callbacks.get(handler)?.({ event, id: 0, payload });
  }

  function sessionRow(session) {
    const live = statusById.get(session.id);
    return {
      display_name: session.name,
      session_id: session.id,
      server_pid: 4000,
      server_start_time: 1700000000,
      window_id: session.id,
      pane_id: session.id,
      pane_pid: 5000 + session.id,
      unverified: null,
      status: live.status,
      status_reason: live.reason,
      session_attached: 0,
    };
  }

  const hostOf = (runtimeId) => runtimeHost.get(runtimeId);

  const commands = {
    ui_settings: ({ patch }) => {
      if (patch) settings = { ...settings, ...patch };
      return settings;
    },
    list_hosts: () => scene.hosts.map(({ sessions: _sessions, ...entry }) => entry),
    begin_connect: () => `runtime-${nextId++}`,
    connect_host: ({ hostId, spec }) => {
      runtimeHost.set(hostId, scene.hosts.find((host) => host.hostname === spec.hostname));
      return hostId;
    },
    list_sessions: ({ hostId }) => ({
      own: { sessions: (hostOf(hostId)?.sessions ?? []).map(sessionRow), error: null, unsupported_version: null },
      default: null,
    }),
    poll_status: ({ hostId }) => ({
      own: {
        poll: {
          complete: true,
          server_pid: 4000,
          server_start_time: 1700000000,
          sessions: (hostOf(hostId)?.sessions ?? []).map((session) => {
            const live = statusById.get(session.id);
            return { session_id: session.id, status: live.status, status_reason: live.reason };
          }),
          agents_ok: true,
          titles_ok: true,
        },
        error: null,
      },
      default: null,
    }),
    open_terminal: ({ hostId, session, openId }) => {
      const text = hostOf(hostId)?.sessions.find((candidate) => candidate.name === session)?.screen ?? "";
      setTimeout(() => {
        emit("terminal://output", {
          host_id: hostId,
          session,
          open_id: openId,
          bytes: Array.from(encoder.encode(text.replace(/\n/g, "\r\n"))),
        });
      }, 50);
      return null;
    },
    list_ssh_keys: () => scene.sshKeys ?? [],
    generate_ssh_key: () => scene.generatedKey,
    suggest_hosts: () => [],
    "plugin:event|listen": ({ event, handler }) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return handler;
    },
    "plugin:event|unlisten": ({ event, eventId }) => {
      listeners.get(event)?.delete(eventId);
      return null;
    },
    "plugin:window|set_title": ({ value, title }) => {
      window.__sceneWindowTitle = value ?? title ?? "";
      return null;
    },
  };

  window.isTauri = true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) => path,
    invoke: async (command, args = {}) => (commands[command] ? commands[command](args) : null),
  };

  /** Steuerung fuer `render.mjs`: Status setzen und die Uhr vorstellen, damit die
   * Wartezeiten der Wartet-Spur nicht erst echte Minuten brauchen. */
  window.__sceneControl = {
    setStatus(id, status, reason) {
      statusById.set(id, { status, reason });
    },
    advance(ms) {
      clockOffset += ms;
    },
  };
})();
