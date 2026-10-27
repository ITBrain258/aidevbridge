// Schreiber der [ui]-Felder von settings.toml (UX-Spec §6.7, §9.2): die
// Terminal-Einstellungen (`terminal-prefs`), "Restore hosts and terminals" und
// die Breite der Seitenleiste (UX-Spec §7.8). Das Thema hat seinen eigenen
// Weg (Appearance), den Arbeitsplatz schreibt ein eigener Schreiber
// (`state/workspace.ts`).
//
// Eine Feldtabelle bestimmt alles, was Felder betrifft: welche es gibt, wie ein
// Wert geprueft wird (Zahlen ganzzahlig -- `ui_settings` lehnt Bruchzahlen ab)
// und wo ein Feld in `terminal-prefs` steht. Geschrieben wird 500 ms nach der
// letzten Aenderung, in einem Patch mit nur den Feldern, die settings.toml nach
// unserem Wissen noch nicht so haelt (`stored`: aus dem Laden und jedem
// gelungenen Schreiben). Das haelt das Echo des Ladens und jeden Hin-und-Rueckweg
// heraus, und ohne gelesenen Stand geht nie ein unberuehrtes Feld mit -- dessen
// Standard ueberschriebe sonst die Datei.
import { clampFontSize, type TerminalPrefs } from "../terminal-prefs";
import type { UiSettingsDto } from "../views/types";

/** UX-Spec §6.7, §9.2: Ruhe vor dem Schreiben -- ein Zug am Mausrad oder ein
 * gehaltenes Strg+= schreibt einmal, nicht je Rastung. */
export const UI_SETTINGS_PERSIST_MS = 500;

/** Die [ui]-Felder dieses Schreibers. */
export type UiField =
  | "terminal_font_size"
  | "copy_on_select"
  | "ctrl_cv_clipboard"
  | "right_click"
  | "restore_workspace"
  | "sidebar_width";

/** Ein Teil der [ui]-Felder, wie `ui_settings` ihn als Patch annimmt. */
export type UiFieldsPatch = { [F in UiField]?: UiSettingsDto[F] };

interface FieldSpec<F extends UiField> {
  /** Prueft einen Wert aus einer Antwort oder von einem Aufrufer; `undefined`
   * heisst unbrauchbar. */
  accept(value: unknown): UiSettingsDto[F] | undefined;
  /** Nur fuer Felder aus `terminal-prefs`: lesen und schreiben dort. */
  pref?: {
    read(prefs: Readonly<TerminalPrefs>): UiSettingsDto[F];
    write(value: UiSettingsDto[F]): Partial<TerminalPrefs>;
  };
}

function acceptBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Die eine Tabelle der Felder. */
const FIELDS: { readonly [F in UiField]: FieldSpec<F> } = {
  terminal_font_size: {
    // Ganzzahlig 10 bis 20, wie `setTerminalPrefs` es haelt.
    accept: (value) => (typeof value === "number" ? clampFontSize(value) : undefined),
    pref: { read: (prefs) => prefs.fontSize, write: (value) => ({ fontSize: value }) },
  },
  copy_on_select: {
    accept: acceptBoolean,
    pref: { read: (prefs) => prefs.copyOnSelect, write: (value) => ({ copyOnSelect: value }) },
  },
  ctrl_cv_clipboard: {
    accept: acceptBoolean,
    pref: { read: (prefs) => prefs.ctrlCvClipboard, write: (value) => ({ ctrlCvClipboard: value }) },
  },
  right_click: {
    accept: (value) => (value === "menu" || value === "paste" ? value : undefined),
    pref: { read: (prefs) => prefs.rightClick, write: (value) => ({ rightClick: value }) },
  },
  restore_workspace: { accept: acceptBoolean },
  // Nur ganzzahlig; die Grenzen der Anzeige (208 bis 480) haelt der Ziehgriff
  // (`views/sidebar-resize.ts`). Rust setzt alles ausserhalb von 200
  // bis 480 auf 240.
  sidebar_width: {
    accept: (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined),
  },
};

const FIELD_NAMES = Object.keys(FIELDS) as UiField[];

function put<F extends UiField>(target: UiFieldsPatch, field: F, value: UiSettingsDto[F]): void {
  target[field] = value;
}

/** Was eine Antwort von `ui_settings` fuer diesen Schreiber enthaelt. */
export interface StoredUi {
  /** Die brauchbaren [ui]-Felder. */
  fields: UiFieldsPatch;
  /** Dieselben Werte als Patch fuer `setTerminalPrefs`. */
  prefs: Partial<TerminalPrefs>;
}

export interface UiSettingsSync {
  /** Uebernimmt eine Antwort von `ui_settings` als gespeicherten Stand. Erst
   * danach `setTerminalPrefs(prefs)` rufen, dann schreibt dessen Echo nichts. */
  applyStored(dto: Partial<UiSettingsDto>): StoredUi;
  /** Plant die Felder aus `terminal-prefs`, in denen sich `next` von
   * `previous` unterscheidet. */
  prefsChanged(previous: Readonly<TerminalPrefs>, next: Readonly<TerminalPrefs>): void;
  /** Plant ein einzelnes Feld; Zahlen gehen ganzzahlig hinaus, ein
   * unbrauchbarer Wert wird verworfen. */
  schedule<F extends UiField>(field: F, value: UiSettingsDto[F]): void;
  /** Verwirft einen ausstehenden Schreibvorgang. */
  dispose(): void;
}

/** `write` schickt einen Patch (in der App `invoke("ui_settings", { patch })`). */
export function createUiSettingsSync(
  write: (patch: UiFieldsPatch) => Promise<unknown>,
  delayMs = UI_SETTINGS_PERSIST_MS,
): UiSettingsSync {
  let stored: UiFieldsPatch = {};
  let pending: UiFieldsPatch = {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  function queue(patch: UiFieldsPatch): void {
    if (Object.keys(patch).length === 0) return;
    pending = { ...pending, ...patch };
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  }

  function copyIfUnsaved<F extends UiField>(patch: UiFieldsPatch, field: F): void {
    const value = pending[field];
    if (value !== undefined && value !== stored[field]) put(patch, field, value);
  }

  function flush(): void {
    timer = undefined;
    const patch: UiFieldsPatch = {};
    for (const field of FIELD_NAMES) copyIfUnsaved(patch, field);
    pending = {};
    if (Object.keys(patch).length === 0) return;
    void write(patch).then(
      () => {
        stored = { ...stored, ...patch };
      },
      (error: unknown) => {
        // Wie beim Thema: kein Banner, die Einstellung gilt bis zum Neustart.
        console.warn(`[settings] ui_settings write failed: ${String(error)}`);
      },
    );
  }

  function acceptStored<F extends UiField>(
    field: F,
    dto: Partial<UiSettingsDto>,
    result: StoredUi,
  ): void {
    const spec: FieldSpec<F> = FIELDS[field];
    const value = spec.accept(dto[field]);
    if (value === undefined) return;
    put(result.fields, field, value);
    if (spec.pref) Object.assign(result.prefs, spec.pref.write(value));
  }

  function diffPref<F extends UiField>(
    field: F,
    previous: Readonly<TerminalPrefs>,
    next: Readonly<TerminalPrefs>,
    patch: UiFieldsPatch,
  ): void {
    const pref = FIELDS[field].pref;
    if (!pref) return;
    const value = pref.read(next);
    if (value !== pref.read(previous)) put(patch, field, value);
  }

  return {
    applyStored(dto) {
      const result: StoredUi = { fields: {}, prefs: {} };
      for (const field of FIELD_NAMES) acceptStored(field, dto, result);
      stored = { ...stored, ...result.fields };
      return result;
    },
    prefsChanged(previous, next) {
      const patch: UiFieldsPatch = {};
      for (const field of FIELD_NAMES) diffPref(field, previous, next, patch);
      queue(patch);
    },
    schedule(field, value) {
      const accepted = FIELDS[field].accept(value);
      if (accepted === undefined) return;
      const patch: UiFieldsPatch = {};
      put(patch, field, accepted);
      queue(patch);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      pending = {};
    },
  };
}
