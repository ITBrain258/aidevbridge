// Gemeinsame DTO-Typen fuer die Hostverwaltungs-Ansichten (Task 13).
// Deckungsgleich mit den `serde::Serialize`-Typen auf der Rust-Seite --
// `ssh::config_parser::SshConfigHost` bzw. `settings::HostEntry`.

export interface SshConfigHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  /** Aus der `IdentityFile`-Direktive, Tilde bereits aufgeloest. `null`,
   * wenn die Direktive fehlt. Ohne dieses Feld verlor jeder angeklickte
   * Vorschlag seinen Schluessel und landete still auf ssh-agent -- unter
   * Windows 11 ein ab Werk DEAKTIVIERTER Dienst (Spec §9.1). */
  identity_file: string | null;
}

export interface HostEntry {
  id: string;
  label: string;
  hostname: string;
  user: string;
  port: number;
  tmux_socket: string;
  history_limit: number;
  // M-D (Abschlussreview): fehlte bislang komplett -- der damalige
  // Hostlisten-Weg (`host-list.ts`, inzwischen durch `sidebar.ts` ersetzt,
  // Shell-Task 9) verdrahtete beim Verbinden fest `key_path: null`,
  // unabhaengig davon, ob der Host ueber eine Schluesseldatei gespeichert
  // wurde. `null`, nicht optional/fehlend: Rust-Seite serialisiert
  // `Option<String>` als JSON `null` bei Abwesenheit
  // (serde_json-Standardverhalten), niemals als fehlendes Feld.
  key_path: string | null;
  /** Anmeldeart (Task 8, Spec §4.8) -- NIE `null`/fehlend, wenn dieses Objekt
   * von `list_hosts` oder `add_host` kommt: `list_hosts_impl` liefert
   * `HostEntry::effective_auth_kind()` statt des rohen, moeglicherweise
   * `None`-Feldes (eine aeltere `settings.toml` hat `auth_kind` nie
   * geschrieben), `add_host_impl` speichert seit diesem Task ebenfalls immer
   * ein konkretes `Some(..)`. Deckungsgleich mit `AuthKind`
   * (`settings.rs`, `#[serde(rename_all = "lowercase")]`) und mit
   * `AuthChoice.kind` (`host-form.ts`). */
  auth_kind: "key" | "agent" | "password";
  /** Schalter "Show tmux sessions" (Spec 2026-10-25 §10.1); fehlt er, gilt
   * an. */
  show_default_socket?: boolean;
}

/** Ein belegter Kachelplatz im gespeicherten Arbeitsplatz (UX-Spec §7.1);
 * `slot` 0 bis 8. Rust `commands::TileEntryDto`. */
export interface TileEntryDto {
  slot: number;
  host_id: string;
  session: string;
  /** Eine Kachel des Standard-Sockets (Spec 2026-10-25 §5): `session` ist
   * leer, der Name steht hier, `socket` ist "default". 0.2.x verwirft sie. */
  foreign_session?: string;
  socket?: "default";
}

/** Die Verzeichnisse eines Hosts (UX-Spec §7.6): das zuletzt genutzte und die
 * letzten fuenf, neueste zuerst, nur absolute Pfade. Rust `HostDirsDto`. */
export interface HostDirsDto {
  last: string | null;
  recent: string[];
}

/** `[workspace]` aus settings.toml (UX-Spec §7.1, §9.2). In einem Patch nur als
 * vollstaendiger Schnappschuss: Rust ersetzt den Arbeitsplatz als Ganzes und
 * lehnt ein unvollstaendiges Objekt ab. Der Lesepfad liefert auch Eintraege
 * unbekannter Hosts (erst das Speichern verwirft sie). Rust `WorkspaceDto`. */
export interface WorkspaceDto {
  layout: 1 | 2 | 4;
  /** 2: die Kachelliste (Spec 2026-10-19 §4.6). Fehlt der Schluessel in der
   * Datei, liefert Rust 1 (altes Platzmodell); das Frontend schreibt immer 2. */
  tiles_version: number;
  sidebar_collapsed: boolean;
  /** Host-Ids. */
  expanded: string[];
  /** Host-Ids. */
  connected: string[];
  tiles: TileEntryDto[];
  /** Schluessel ist die Host-Id. */
  dirs: Record<string, HostDirsDto>;
}

/** Antwort von `ui_settings` (UX-Spec §9.2): alle Felder aus `[ui]`, dazu der
 * Arbeitsplatz und der Pfad der Datei. Rust klemmt ungueltige Werte, die
 * Antwort zeigt also immer den gespeicherten Stand. Rust `UiSettingsDto`. */
export interface UiSettingsDto {
  theme: string;
  /** Ganzzahlig 10 bis 20. */
  terminal_font_size: number;
  copy_on_select: boolean;
  ctrl_cv_clipboard: boolean;
  right_click: "menu" | "paste";
  restore_workspace: boolean;
  /** 200 bis 480, wie Rust klemmt; die Seitenleiste zeigt einen Wert unter 208
   * als 208 (`views/sidebar-resize.ts`). */
  sidebar_width: number;
  workspace: WorkspaceDto;
  settings_path: string;
}

/** One tmux session from list_sessions. Names are display-only. */
export interface SessionListItemDto {
  display_name: string;
  session_id: number | null;
  server_pid: number | null;
  server_start_time: number | null;
  window_id: number | null;
  pane_id: number | null;
  pane_pid: number | null;
  unverified: string | null;
  status: string | null;
  status_reason: string | null;
}

/** One `poll_status` answer. Rows carry numeric identity only; `complete` is
 * true only for one complete numeric inventory of one tmux server. */
export interface StatusPollDto {
  complete: boolean;
  server_pid: number | null;
  server_start_time: number | null;
  sessions: Array<{ session_id: number; status: string; status_reason: string }>;
  /** `false`, wenn der claude-Befehl uebersprungen wurde oder ohne Antwort
   * scheiterte; jede Antwort zaehlt, auch Exitcode 127. Nennt claude Agenten,
   * gilt dasselbe fuer die Lesung ihrer Elternprozesse. */
  agents_ok: boolean;
  /** `false`, wenn der Titelbefehl uebersprungen wurde oder ohne Antwort
   * scheiterte; jede Antwort zaehlt. */
  titles_ok: boolean;
}

/** Structured failure from list_sessions. No generation is inferred for legacy
 * string errors; only authoritative control state may advance that generation. */
export interface SessionListErrorDto {
  code: string;
  message: string;
  control_generation: number;
}

/** Ein Socket aus `list_sessions` (Spec 2026-10-25 §6.2): seine Zeilen, sein
 * Fehler oder die Version eines Servers, an dem die App nicht anhaengt.
 * Rust `commands::SocketSessionsDto`. */
export interface SocketSessionsDto {
  sessions: SessionListItemDto[];
  error: SessionListErrorDto | null;
  unsupported_version: string | null;
}

/** `list_sessions` je Socket; `default` fehlt, wenn er nicht verlangt war.
 * Rust `commands::SessionListDto`. */
export interface SessionListDto {
  own: SocketSessionsDto;
  default: SocketSessionsDto | null;
}

/** Ein Socket aus `poll_status`: sein Ergebnis oder sein Fehler. */
export interface SocketPollDto {
  poll: StatusPollDto | null;
  error: SessionListErrorDto | null;
}

/** `poll_status` je Socket (Spec 2026-10-25 §6.3). Rust
 * `commands::StatusPollsDto`. */
export interface StatusPollsDto {
  own: SocketPollDto;
  default: SocketPollDto | null;
}

export interface ControlStateEventDto {
  host_id: string;
  control_generation: number;
  state: "ready" | "degraded" | "reconnecting" | "authentication_required";
  message?: string;
}
