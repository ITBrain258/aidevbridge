// Schnelloeffnen (UX-Spec §7.5, A-04): der Dialog "Quick open" mit Feld und
// Ergebnisliste -- Sessions, Hosts und Aktionen an einer Stelle, ganz ueber die
// Tastatur erreichbar. Diese Datei baut die Eintraege aus `AppState`, filtert
// sie und zeigt sie in der Dialoghuelle. Die Huelle legt `main()` je Lauf an,
// darum kommt `openDialog` herein (kein Modulzustand, siehe `views/dialog.ts`).
// Was ein Eintrag bewirkt, entscheidet `main.ts` ueber `onRun`: dieselben Wege
// wie Seitenleiste und Tastatur, kein zweiter.
import type { AppState } from "../state/app-state";
import { DEFAULT_KEYMAP, type KeymapAction } from "../keymap";
import type { DialogShell } from "./dialog";
import { agentStatusView, buildStatusPill, type AgentStatusView } from "./status-pill";
import en from "../i18n/en.json";

type TranslationKey = keyof typeof en;

function t(key: TranslationKey, params?: Record<string, string>): string {
  const template = en[key];
  if (!params) return template;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.split(`{${name}}`).join(value),
    template,
  );
}

/** Die Aktionen am Ende der Liste (UX-Spec §7.5, Punkt 3). */
export type QuickOpenActionId = "settings" | "toggleSidebar";

/** In dieser Reihenfolge stehen die Aktionen in der Liste. */
const ACTION_IDS: readonly QuickOpenActionId[] = ["settings", "toggleSidebar"];

/** Hoechstens so viele Eintraege zeigt die Liste (UX-Spec §7.5). */
const QUICK_OPEN_LIMIT = 50;

/** Ein Eintrag der Liste. `hostname` tragen alle hostgebundenen Eintraege,
 * weil der Filter ihn prueft (Text UND Hostname, nicht nur
 * das Label). `pill` ist die Statuspille nach derselben Regel wie in
 * Seitenleiste und Kachel (`agentStatusView`): ein festgehaltener Wert zeigt
 * "As of …" statt "Waiting". `status` bleibt der Rohwert der Session. */
export type QuickOpenItem =
  | {
      kind: "session";
      hostId: string;
      name: string;
      hostLabel: string;
      hostname: string;
      status: string | null;
      pill: AgentStatusView | null;
    }
  | { kind: "connect"; hostId: string; hostLabel: string; hostname: string }
  | { kind: "newSession"; hostId: string; hostLabel: string; hostname: string }
  | { kind: "action"; id: QuickOpenActionId; label: string; shortcut?: string };

/** Beschriftung je Aktion und, wo eine Aktion eines hat, ihr Kuerzel. */
export interface QuickOpenLabels {
  actions: Readonly<Record<QuickOpenActionId, string>>;
  shortcuts: Readonly<Partial<Record<QuickOpenActionId, string>>>;
}

/** Die Beschriftungen aus en.json, die Kuerzel aus `keymap`, nie als Literal
 * (UX-Spec §8.4) -- dasselbe Muster wie `titleWithShortcut`: ein spaeterer
 * Editor fuer eigene Kuerzel reicht hier nur seine Tabelle herein. Kuerzel
 * nennen "Settings" und "Toggle sidebar" (§7.5). */
export function quickOpenLabels(keymap: Readonly<Record<KeymapAction, string>> = DEFAULT_KEYMAP): QuickOpenLabels {
  return {
    actions: {
      settings: t("quickOpen.action.settings"),
      toggleSidebar: t("quickOpen.action.toggleSidebar"),
    },
    shortcuts: { settings: keymap["settings.open"], toggleSidebar: keymap["sidebar.toggle"] },
  };
}

/** Die Eintraege in der Reihenfolge aus UX-Spec §7.5:
 *  1. wartende Sessions, dann die uebrigen -- nur verbundener Hosts, je in der
 *     Reihenfolge der Seitenleiste (Hosts, darin ihre Sessions). "Wartend" nach
 *     derselben Regel wie Fenstertitel und Strg+Umschalt+A
 *     (`isSessionStatusCurrent`): ein festgehaltener Wert ist Geschichte.
 *  2. je Host ein Eintrag: verbunden "New session on {host}", getrennt oder
 *     fehlgeschlagen "Connect {host}". Ein Host, der gerade verbindet, bekommt
 *     keinen -- die Seitenleiste bietet dort ebenfalls kein "Connect" an, und
 *     ein Klick darauf beendete nur eine laufende Reihe des Neuverbindens.
 *  3. die Aktionen. */
export function quickOpenItems(state: AppState, labels: QuickOpenLabels): QuickOpenItem[] {
  const waiting: QuickOpenItem[] = [];
  const others: QuickOpenItem[] = [];
  const hosts: QuickOpenItem[] = [];
  for (const host of state.hosts) {
    const base = { hostId: host.id, hostLabel: host.label, hostname: host.hostname };
    if (host.state === "connected") {
      for (const session of host.sessions) {
        const current = state.isSessionStatusCurrent(host.id, session.name);
        const status = session.status ?? null;
        const pill = agentStatusView(status, session.statusReason, current, state.sessionStatusObservedAt(host.id, session.name));
        (status === "waiting" && current ? waiting : others).push({ kind: "session", ...base, name: session.name, status, pill });
      }
      hosts.push({ kind: "newSession", ...base });
    } else if (host.state !== "connecting") {
      hosts.push({ kind: "connect", ...base });
    }
  }
  const actions = ACTION_IDS.map((id): QuickOpenItem => {
    const shortcut = labels.shortcuts[id];
    const action = { kind: "action" as const, id, label: labels.actions[id] };
    return shortcut === undefined ? action : { ...action, shortcut };
  });
  return [...waiting, ...others, ...hosts, ...actions];
}

/** Der Text eines Eintrags, wie die Liste ihn zeigt -- bei einer Session der
 * Name mit dem Host daneben. Genau diesen Text prueft der Filter. */
function itemText(item: QuickOpenItem): string {
  switch (item.kind) {
    case "session":
      return `${item.name} ${item.hostLabel}`;
    case "connect":
      return t("quickOpen.connect", { host: item.hostLabel });
    case "newSession":
      return t("quickOpen.newSession", { host: item.hostLabel });
    case "action":
      return item.label;
  }
}

/** UX-Spec §7.5: Gross/Klein egal, jeder durch Leerraum getrennte Begriff muss
 * als Teilstring im Text oder im Hostnamen vorkommen. Ein Begriff enthaelt nie
 * Leerraum, kann also nicht ueber die Grenze zwischen beiden reichen. Eine leere
 * Anfrage laesst alles durch. Hoechstens `limit` Eintraege, in ihrer
 * Reihenfolge. */
export function filterQuickOpen(items: readonly QuickOpenItem[], query: string, limit = QUICK_OPEN_LIMIT): QuickOpenItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const matches: QuickOpenItem[] = [];
  for (const item of items) {
    if (matches.length >= limit) break;
    const text = itemText(item).toLowerCase();
    const hostname = item.kind === "action" ? "" : item.hostname.toLowerCase();
    if (terms.every((term) => text.includes(term) || hostname.includes(term))) matches.push(item);
  }
  return matches;
}

export interface QuickOpenOptions {
  /** Die Dialoghuelle des laufenden `main()` (`mountDialogShell(...).openDialog`). */
  openDialog: DialogShell["openDialog"];
  /** Ein Schnappschuss vom Oeffnen: die Liste ordnet sich nicht unter dem
   * Zeiger um, wenn im Hintergrund die Statusabfrage eintrifft. */
  items: readonly QuickOpenItem[];
  /** Vorgabe im Feld, etwa "New session" (UX-Spec §7.9, Schritt 5). */
  initialQuery?: string;
  /** Fuehrt einen Eintrag aus. Der Dialog ist dann schon geschlossen. Mit Strg
   * (Strg+Enter, Strg+Klick) ersetzt eine Session die fokussierte Kachel
   * (Spec 2026-10-19 §5.2). */
  onRun(item: QuickOpenItem, options: { replace: boolean }): void;
}

/** Zaehler fuer eindeutige IDs: `aria-controls` und `aria-activedescendant`
 * verweisen per ID, und `main.test.ts` legt viele Laeufe auf demselben Dokument
 * an. */
let instances = 0;

/** Eine Zeile der Liste: keine Schaltflaeche und kein Tab-Halt -- der Fokus
 * bleibt im Feld, das per `aria-activedescendant` auf die gewaehlte Zeile
 * zeigt (UX-Spec §11). */
function buildOption(item: QuickOpenItem, id: string, index: number): HTMLLIElement {
  const option = document.createElement("li");
  option.id = id;
  option.className = "quick-open-option";
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", "false");
  option.dataset.index = String(index);
  const label = document.createElement("span");
  label.className = "quick-open-label";
  option.appendChild(label);
  switch (item.kind) {
    case "session": {
      label.textContent = item.name;
      const host = document.createElement("span");
      host.className = "quick-open-host";
      host.textContent = item.hostLabel;
      option.appendChild(host);
      if (item.pill) option.appendChild(buildStatusPill(item.pill));
      break;
    }
    case "action":
      label.textContent = item.label;
      if (item.shortcut !== undefined) {
        const kbd = document.createElement("kbd");
        kbd.textContent = item.shortcut;
        option.appendChild(kbd);
      }
      break;
    default:
      label.textContent = itemText(item);
  }
  return option;
}

/** Zeigt "Quick open". Bedienung (UX-Spec §7.5): Tippen filtert, Pfeil runter
 * und hoch waehlen mit Umlauf, Enter oder ein Klick fuehrt aus (mit Strg
 * ersetzt eine Session die fokussierte Kachel, Spec 2026-10-19 §5.2), Escape
 * schliesst (das erledigt die Huelle, wie bei jedem Dialog). */
export function openQuickOpen(opts: QuickOpenOptions): void {
  const listId = `quick-open-${++instances}`;
  let field: HTMLInputElement | undefined;
  const dialog = opts.openDialog({ title: t("quickOpen.title") }, (container) => {
    const root = document.createElement("div");
    root.className = "quick-open";

    // Muster "Combobox mit Listbox" (WAI-ARIA): das Feld besitzt die Liste
    // (`aria-controls`) und nennt den gewaehlten Eintrag.
    const input = document.createElement("input");
    input.type = "text";
    input.className = "quick-open-input";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-label", t("quickOpen.inputLabel"));
    input.placeholder = t("quickOpen.inputLabel");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = opts.initialQuery ?? "";

    const list = document.createElement("ul");
    list.id = listId;
    list.className = "quick-open-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", t("quickOpen.title"));

    // Eine Statusregion (UX-Spec §11), die den ganzen Dialog ueber im Baum
    // bleibt und nur ihren Text wechselt: eine mitsamt ihrem Inhalt eingefuegte
    // Live-Region sagen Screenreader oft nicht an. Leer nimmt sie keinen Platz
    // ein (styles.css, `:empty`).
    const empty = document.createElement("p");
    empty.className = "quick-open-empty";
    empty.setAttribute("role", "status");

    root.append(input, list, empty);
    container.appendChild(root);

    let shown: QuickOpenItem[] = [];
    let selected = 0;

    function select(index: number): void {
      selected = index;
      Array.from(list.children).forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
      const option = list.children[index];
      if (option) {
        input.setAttribute("aria-activedescendant", option.id);
        // jsdom kennt `scrollIntoView` nicht (wie in `directory-tree.ts`).
        option.scrollIntoView?.({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    /** Jede Eingabe filtert neu und faengt wieder beim ersten Treffer an. */
    function render(): void {
      shown = filterQuickOpen(opts.items, input.value);
      list.replaceChildren(...shown.map((item, index) => buildOption(item, `${listId}-${index}`, index)));
      list.hidden = shown.length === 0;
      empty.textContent = shown.length === 0 ? t("quickOpen.noMatches") : "";
      input.setAttribute("aria-expanded", String(shown.length > 0));
      select(0);
    }

    /** Erst schliessen, dann ausfuehren: die Aktion laeuft wie aus der App
     * heraus, nicht hinter dem Scrim (`#app` ist dann nicht mehr `inert`), und
     * die Huelle hat den Fokus schon dorthin zurueckgegeben, woher der Dialog
     * kam. Sonst holte ihr Schliessen den Fokus spaeter wieder dorthin -- etwa
     * aus dem Terminal, das die Sessionwahl gerade fokussiert hat. */
    function run(index: number, replace: boolean): void {
      const item = shown[index];
      if (!item) return;
      dialog.close();
      opts.onRun(item, { replace });
    }

    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
      // Waehrend einer IME-Eingabe gehoeren Enter und die Pfeile ihr.
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // Ohne `preventDefault` sprange die Schreibmarke an den Anfang oder das
        // Ende des Feldes.
        event.preventDefault();
        if (shown.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        select((selected + step + shown.length) % shown.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        run(selected, event.ctrlKey);
      }
    });
    // Der Fokus bleibt im Feld: ein Druck auf eine Zeile, auf "No matches" oder
    // in das Polster des Dialogs legte ihn sonst auf <body>, und Tippen und
    // Pfeiltasten liefen ins Leere. Darum am Koerper des Dialogs, der `root`
    // samt Polster umfasst. Ausgenommen: das Feld selbst (Schreibmarke setzen,
    // Text markieren) und die Liste selbst -- ein Druck auf ihren Scrollbalken
    // trifft sie, und Blink reicht ihn nur bei unverhindertem `mousedown` an den
    // Scrollbalken weiter.
    container.addEventListener("mousedown", (event) => {
      if (event.target === input || event.target === list) return;
      event.preventDefault();
    });
    list.addEventListener("click", (event) => {
      const option = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="option"]') : null;
      if (option?.dataset.index !== undefined) run(Number(option.dataset.index), event.ctrlKey);
    });

    render();
    field = input;
    return {
      dispose() {
        root.remove();
      },
    };
  });
  // Erst jetzt: `openDialog` legt den Fokus NACH `build` auf das
  // Schliessen-Kreuz (WAI-ARIA-Dialogmuster, `views/dialog.ts`). Ein
  // `focus()` im Aufbau ginge dabei verloren.
  field?.focus();
}
