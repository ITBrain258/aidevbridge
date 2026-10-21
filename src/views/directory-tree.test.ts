// Gegenprobe fuer `directory-tree.ts` (Verzeichnisauswahl-Task 3). Neben acht
// Grundfaellen prueft sie drei verbindliche Auflagen eigens
// (Versteckt-Schalter, `errorKind` statt eigenem `switch`,
// Nebenlaeufigkeit) -- denn dieses Repository hat mehrfach protokolliert,
// dass eine richtig umgesetzte Anforderung ohne Zusicherung genauso
// verschwindet wie eine gar nicht umgesetzte.
//
// Die Attrappe fuer `@tauri-apps/api/core` folgt `host-form.test.ts`; sie
// loest allerdings NICHT von selbst auf, sondern reiht jede Anfrage in
// `pending` ein. Nur so lassen sich zwei Dinge pruefen, die eine sofort
// aufloesende Attrappe verdeckt: dass alle vier Ahnenanfragen abgesetzt
// sind, BEVOR die erste beantwortet ist, und dass die Antworten auch dann
// wurzelabwaerts angewandt werden, wenn sie verdreht eintreffen.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountDirectoryTree, type DirectoryTreeHandle } from "./directory-tree";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

/** Das Dateisystem der Attrappe. `.cache` liegt bewusst unter
 * `/home/u`: der Versteckt-Schalter braucht einen Punkt-Eintrag auf
 * einer Ebene, die der Baum von sich aus aufklappt. */
const FS: Record<string, string[]> = {
  "/": ["home", "root", "tmp"],
  "/home": ["u"],
  "/home/u": [".cache", "repo"],
  "/home/u/repo": ["src"],
  "/home/u/repo/src": [],
  "/home/u/.cache": [],
  "/root": ["secret"],
  "/root/secret": [],
  "/tmp": [],
};

/** Das Heimatverzeichnis des Anmeldebenutzers, das `list_directories` bei
 * leerem `path` aufloest (Spec §3.3). Bewusst NICHT `/`: der Baum wurzelt
 * immer bei `/` (die Ahnenkette beginnt dort, und `setChildren` verwirft
 * jeden Pfad, der kein Kind eines bekannten Knotens ist), und die
 * Zusicherung `row(el, "/")` im Rueckfall-Test unterscheidet nur dann etwas,
 * wenn das Heimatverzeichnis eben nicht selbst die Wurzel ist. */
const HOME = "/home/u";

interface Call {
  hostId: string;
  path: string;
  includeHidden: boolean;
}

interface Pending {
  path: string;
  settle: () => void;
}

let calls: Call[] = [];
let pending: Pending[] = [];
let order: "as-called" | "deepest-first" = "as-called";
/** Pfade der Zeilen, auf denen `scrollIntoView` gerufen wurde. jsdom kennt
 * die Methode NICHT (nachgemessen: `typeof … === "undefined"`), sie muss
 * hier also erst entstehen -- ohne diese Attrappe liefe die Zusicherung ins
 * Leere, weil der optionale Aufruf in `applyRoving` einfach nichts taete. */
let scrolled: string[] = [];

/** Eine Makrotask: leert die gesamte Mikrotask-Schlange, ohne dass sie
 * abgezaehlt werden muss (`await Promise.resolve()` je Kettenglied waere bei
 * vier nacheinander abgewarteten Antworten eine Rechnung, die bei jeder
 * Codeaenderung neu aufgeht). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Beantwortet, was gerade offen ist -- und dann, was daraus neu entstand
 * (eine aufgeklappte Ebene kann die naechste ausloesen).
 *
 * Es wird bewusst nicht ueber eine KOPIE der Schlange gelaufen: eine
 * Umsetzung, die ihre Anfragen nacheinander absetzt, haette sonst nach dem
 * ersten Durchlauf niemanden mehr, der ihre zweite Anfrage beantwortet --
 * der Test liefe in den Zeitablauf statt in eine lesbare Zusicherung. */
async function flush(): Promise<void> {
  await tick();
  for (let guard = 0; guard < 50 && pending.length > 0; guard += 1) {
    const batch = pending;
    pending = [];
    if (order === "deepest-first") batch.sort((a, b) => b.path.length - a.path.length);
    for (const entry of batch) {
      entry.settle();
      await tick();
    }
  }
}

interface MountArgs {
  initialPath: string;
  onSelect?: (path: string) => void;
  denyFor?: string;
  notFoundFor?: string;
  /** Pfad -> rohe `Err(String)`, die NICHT eines der drei Kuerzel ist. */
  failFor?: { path: string; raw: string };
  resolveOrder?: "as-called" | "deepest-first";
}

interface Parts {
  el: HTMLElement;
  calls: Call[];
  onSelect: (path: string) => void;
  handle: DirectoryTreeHandle;
}

beforeEach(() => {
  calls = [];
  pending = [];
  scrolled = [];
  order = "as-called";
  document.body.replaceChildren();
  invokeMock.mockReset();
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push((this as HTMLElement).dataset.path ?? "");
  };
});

/** Mountet, ohne zu warten -- fuer die Zusicherung ueber die
 * Nebenlaeufigkeit, die genau den Zustand VOR der ersten Antwort braucht. */
function open(args: MountArgs): Parts {
  order = args.resolveOrder ?? "as-called";
  const errors = new Map<string, string>();
  if (args.denyFor !== undefined) errors.set(args.denyFor, "denied");
  if (args.notFoundFor !== undefined) errors.set(args.notFoundFor, "notfound");
  if (args.failFor !== undefined) errors.set(args.failFor.path, args.failFor.raw);

  invokeMock.mockImplementation((cmd: string, params: Record<string, unknown>) => {
    if (cmd !== "list_directories") return Promise.resolve(null);
    const path = params.path as string;
    const includeHidden = params.includeHidden as boolean;
    calls.push({ hostId: params.hostId as string, path, includeHidden });
    return new Promise((resolve, reject) => {
      pending.push({
        path,
        settle: () => {
          const raw = errors.get(path);
          if (raw !== undefined) {
            reject(raw);
            return;
          }
          // Spec §3.3: der leere Pfad loest das Heimatverzeichnis auf, und
          // der Rueckgabewert sagt, welches es war.
          const resolved = path === "" ? HOME : path;
          const entries = FS[resolved] ?? [];
          resolve({
            path: resolved,
            entries: includeHidden ? entries : entries.filter((n) => !n.startsWith(".")),
          });
        },
      });
    });
  });

  const el = document.createElement("div");
  document.body.appendChild(el);
  const onSelect = args.onSelect ?? vi.fn();
  const handle = mountDirectoryTree(el, { hostId: "h1", initialPath: args.initialPath, onSelect });
  return { el, calls, onSelect, handle };
}

async function mount(args: MountArgs): Promise<Parts> {
  const parts = open(args);
  await flush();
  return parts;
}

/** Ueber die Eigenschaft verglichen statt per Attributselektor -- ein
 * Verzeichnisname darf jedes Zeichen tragen, ein Selektorstring muesste
 * dafuer maskiert werden (dasselbe Vorgehen wie in `sidebar.ts`). */
function row(el: HTMLElement, path: string): HTMLElement | null {
  return (
    Array.from(el.querySelectorAll<HTMLElement>("[data-path]")).find(
      (node) => node.dataset.path === path,
    ) ?? null
  );
}

function toggle(el: HTMLElement, path: string): void {
  row(el, path)!.click();
}

function press(el: HTMLElement, key: string): void {
  const active = document.activeElement;
  const target =
    active instanceof HTMLElement && el.contains(active)
      ? active
      : (el.querySelector('[tabindex="0"]') as HTMLElement);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/** Liest den ECHTEN Fokus, nicht die rollende Tabulatorstation: dass beide
 * zusammenlaufen, ist die eigentliche Behauptung. Die Zusicherung ueber
 * `tabindex` steht getrennt im Test "ist EINE Tabulatorstation". */
function focusedPath(el: HTMLElement): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement && el.contains(active) ? active.dataset.path : undefined;
}

function hiddenBox(el: HTMLElement): HTMLInputElement {
  return el.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

function setHidden(el: HTMLElement, on: boolean): void {
  const box = hiddenBox(el);
  box.checked = on;
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("mountDirectoryTree", () => {
  it("holt die Ahnenkette des Startpfads nebenlaeufig", async () => {
    // Spec §5: vier Ebenen, vier Aufrufe, eine Rundrufdauer.
    const { calls } = await mount({ initialPath: "/home/u/repo" });
    expect(calls.map((c) => c.path)).toEqual([
      "/", "/home", "/home/u", "/home/u/repo",
    ]);
  });

  it("setzt alle vier Anfragen ab, bevor die erste beantwortet ist", async () => {
    // Der Test darueber prueft die REIHENFOLGE der Aufrufe -- eine
    // Umsetzung, die jede Ebene erst nach der Antwort der vorigen anfordert,
    // besteht ihn. Spec §5 verlangt aber ausdruecklich EINE Rundrufdauer
    // statt vier; das ist hier die Zusicherung: nichts ist beantwortet, und
    // trotzdem stehen schon alle vier Anfragen an.
    open({ initialPath: "/home/u/repo" });
    await tick();
    expect(calls.map((c) => c.path)).toEqual([
      "/", "/home", "/home/u", "/home/u/repo",
    ]);
  });

  it("ruft beim zweiten Aufklappen NICHT erneut", async () => {
    const { el, calls } = await mount({ initialPath: "/" });
    const before = calls.length;
    toggle(el, "/home");          // aufklappen
    await flush();
    toggle(el, "/home");          // zuklappen
    toggle(el, "/home");          // wieder auf
    await flush();
    expect(calls.length).toBe(before + 1);
  });

  it("laesst den Baum bedienbar, wenn ein Knoten kein Leserecht hat", async () => {
    // Auf einer fremden VM ist das der Normalfall (Spec §6).
    const { el } = await mount({ initialPath: "/", denyFor: "/root" });
    toggle(el, "/root");
    await flush();
    expect(row(el, "/root")!.textContent).toContain("Permission denied");
    expect(row(el, "/home")).not.toBeNull();
  });

  it("ist EINE Tabulatorstation", async () => {
    const { el } = await mount({ initialPath: "/" });
    const tabbable = el.querySelectorAll('[tabindex="0"]');
    expect(tabbable).toHaveLength(1);
  });

  it("bewegt den Fokus mit den Pfeiltasten statt mit Tabulator", async () => {
    const { el } = await mount({ initialPath: "/" });
    press(el, "ArrowDown");
    expect(focusedPath(el)).toBe("/home");
    press(el, "ArrowRight");      // aufklappen
    await flush();
    press(el, "ArrowLeft");       // zuklappen
    press(el, "ArrowLeft");       // zum Elternknoten
    expect(focusedPath(el)).toBe("/");
  });

  it("waehlt mit Enter und meldet den Pfad", async () => {
    const onSelect = vi.fn();
    const { el } = await mount({ initialPath: "/", onSelect });
    press(el, "ArrowDown");
    press(el, "Enter");
    expect(onSelect).toHaveBeenCalledWith("/home");
  });

  it("faellt aufs Heimatverzeichnis zurueck, wenn der Startpfad fort ist", async () => {
    // Spec §5: ein Arbeitsverzeichnis, das zwischen zwei Sitzungen
    // verschwindet, ist kein Fehler des Nutzers -- der Baum darf deshalb
    // nicht leer dastehen, muss den Wechsel aber SAGEN.
    const { el } = await mount({ initialPath: "/weg", notFoundFor: "/weg" });
    expect(el.textContent).toContain("home directory");
    expect(row(el, "/")).not.toBeNull();
  });

  it("wendet die Ahnenkette wurzelabwaerts an, auch wenn die Antworten verdreht eintreffen", async () => {
    // Der Test oben prueft die REIHENFOLGE DER AUFRUFE. Diese hier prueft die
    // Reihenfolge der ANWENDUNG -- ein `Promise.all`, das jede Antwort beim
    // Eintreffen einspielt, besteht jenen und faellt durch diesen.
    //
    // Warum das zaehlt: `new DirTree("/")` kennt anfangs nur `/`. Knoten
    // entstehen ausschliesslich als Kinder ihres Elternteils, und
    // `setChildren` verwirft einen unbekannten Pfad WORTLOS (siehe den
    // Kommentar an `setChildren`). Trifft die Antwort fuer `/home/u`
    // vor der fuer `/home` ein und wird sofort angewandt, ist sie verloren,
    // der Baum oeffnet nicht auf dem Feldwert, und nichts meldet es.
    const { el } = await mount({
      initialPath: "/home/u/repo",
      resolveOrder: "deepest-first",
    });
    expect(row(el, "/home/u/repo")).not.toBeNull();
  });

  it("UI v2: Chevron als Icon im 16er-Kasten, wechselt mit dem Aufklappzustand", async () => {
    const { el } = await mount({ initialPath: "/home" });
    const before = row(el, "/home")!.querySelector<HTMLElement>(".chev")!;
    expect(before.classList.contains("icon-box")).toBe(true);
    expect(before.getAttribute("aria-hidden")).toBe("true");
    expect(before.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    const wasExpanded = row(el, "/home")!.getAttribute("aria-expanded") === "true";
    expect(before.dataset.icon).toBe(wasExpanded ? "chevron-down" : "chevron-right");
    toggle(el, "/home");
    await flush();
    expect(row(el, "/home")!.querySelector<HTMLElement>(".chev")!.dataset.icon).toBe(
      wasExpanded ? "chevron-right" : "chevron-down",
    );
  });
});

// Ab hier: die verbindlichen Auflagen. Punkt 1-3 sind Auflagen aus Task 3,
// Punkt 4-6 stehen in Spec §7 bzw. §4.
describe("mountDirectoryTree und der Versteckt-Schalter", () => {
  it("blendet die Punkt-Eintraege auf den offenen Ebenen ein und wieder aus", async () => {
    // Abnahmekriterium 3, unmittelbar. Nebenbei die Auflage aus Task 2:
    // `invalidate` darf die offenen Ebenen nicht zuklappen -- taete es das,
    // waere `.cache` nach dem Umschalten selbst dann nicht sichtbar, wenn es
    // korrekt nachgeladen wurde.
    const { el } = await mount({ initialPath: "/home/u" });
    expect(row(el, "/home/u/.cache")).toBeNull();

    setHidden(el, true);
    await flush();
    expect(row(el, "/home/u/.cache")).not.toBeNull();

    setHidden(el, false);
    await flush();
    expect(row(el, "/home/u/.cache")).toBeNull();
  });

  it("laedt beim Umschalten NUR die offenen Ebenen nach", async () => {
    // Alle entwerteten Ebenen sofort nachzuholen waere eine SSH-Runde je
    // zugeklappter Ebene -- gegen den Sinn des Zwischenspeichers (§4.2).
    const { el, calls } = await mount({ initialPath: "/" });
    toggle(el, "/home");
    await flush();
    toggle(el, "/home");          // geladen, aber wieder zugeklappt
    const before = calls.length;

    setHidden(el, true);
    await flush();

    expect(calls.slice(before).map((c) => c.path)).toEqual(["/"]);
  });

  it("holt eine zugeklappte Ebene nach dem Umschalten frisch statt aus dem Speicher", async () => {
    // Die andere Haelfte derselben Auflage: entwertet wird JEDER geladene
    // Knoten, auch der zugeklappte. Ohne das meldete `expand()` fuer ihn
    // `false`, es wuerde nichts geholt, und er zeigte weiter den alten
    // Schalterstand (Abnahmekriterium 3).
    const { el, calls } = await mount({ initialPath: "/" });
    toggle(el, "/home");
    await flush();
    toggle(el, "/home");
    setHidden(el, true);
    await flush();
    const before = calls.length;

    toggle(el, "/home");
    await flush();

    expect(calls.slice(before).map((c) => c.path)).toEqual(["/home"]);
    expect(calls[calls.length - 1].includeHidden).toBe(true);
  });
});

// Abschlussreview: der Baum fuehrt nirgends Buch darueber, WELCHER
// Filterstand die Kinder einer Ebene erzeugt hat. `request()` schliesst den
// aktuellen Wert beim Absetzen ein, danach weiss es niemand mehr. Befund 1
// ist das Lesen dieser fehlenden Invariante, Befund 2 der Wettlauf darauf.
describe("mountDirectoryTree und der Filterstand einer Ebene", () => {
  it("oeffnet auf einem Pfad mit Punkt-Glied und legt den Schalter sichtbar um", async () => {
    // Abschlussreview, Important 1. Der Entwurf nennt `.git` selbst als
    // Motiv fuer den Schalter -- ein gespeicherter Arbeitspfad mit einem
    // Punkt-Glied ist also kein Kuriosum. Mit `includeHidden: false` filtert
    // das Backend `.cache` aus der Liste von `/home/u`, der Knoten
    // entsteht nie, `setChildren` verwirft das gueltige Listing der naechsten
    // Ebene WORTLOS, und `openOn` meldet keinen Fehler -- die Anfrage ist ja
    // geglueckt. Vier SSH-Runden, und der Feldwert kommt im Baum nicht vor.
    const { el, calls } = await mount({ initialPath: "/home/u/.cache" });

    expect(row(el, "/home/u/.cache")).not.toBeNull();
    // Sichtbar umgelegt: der Nutzer hat den Pfad selbst gespeichert, dass er
    // ihn sehen will, ist keine Vermutung -- aber der Schalter muss es dann
    // auch sagen, sonst steht er auf "aus" und zeigt Verstecktes.
    expect(hiddenBox(el).checked).toBe(true);
    expect(calls.every((c) => c.includeHidden)).toBe(true);
  });

  it("sagt es, wenn der Baum auf dem Feldwert NICHT oeffnen kann", async () => {
    // Die Auffanglinie zu Important 1: gibt der Host ein Glied der Kette
    // nicht in der Liste seines Elternteils zurueck, entsteht der Knoten
    // nicht, und jedes `setChildren`/`setError` darauf verpufft. Wortlos
    // danebenstehen ist die eine Moeglichkeit, die ausscheidet.
    const { el } = await mount({ initialPath: "/home/ghost" });
    expect(el.textContent).toContain("/home/ghost");
    expect(row(el, "/home")).not.toBeNull();
  });

  it("laesst die AHNENKETTE nicht im alten Filterstand haengen, wenn waehrend ihrer Anfrage umgelegt wird", async () => {
    // Nachpruefung: dieselbe Luecke wie beim Nachladen einer Ebene, nur ueber
    // den Ahnenketten-Pfad. `openOn` setzt seine vier Anfragen direkt ueber
    // `request()` ab; ein Kettenglied ist waehrend seines Fluges nicht
    // `loaded` und wird von `setIncludeHidden` genau deshalb uebersprungen.
    // Ohne eigene Buchfuehrung landen die vier Antworten mit dem ALTEN Stand
    // und `expand()` meldet fuer sie ab da ewig `false`.
    const { el } = open({ initialPath: "/home/u/repo" });
    setHidden(el, true);          // umlegen, BEVOR eine Kettenantwort da ist
    await flush();

    expect(row(el, "/home/u/.cache")).not.toBeNull();

    // Auch hier raeumt der Zwischenspeicher es nicht auf.
    toggle(el, "/home/u");
    toggle(el, "/home/u");
    await flush();
    expect(row(el, "/home/u/.cache")).not.toBeNull();
  });

  it("sagt es auch, wenn das fehlende Kettenglied mit einem FEHLER antwortet", async () => {
    // Die Knotenpruefung stand hinter dem Fehlerzweig -- also unerreichbar
    // fuer genau den Fall, den sie abfangen soll: `setError` verwirft einen
    // Pfad ohne Knoten ebenso wortlos wie `setChildren`, und der Baum stand
    // stumm eine Ebene zu hoch.
    const { el } = await mount({ initialPath: "/home/ghost", denyFor: "/home/ghost" });
    expect(el.textContent).toContain("/home/ghost");
    expect(row(el, "/home")).not.toBeNull();
  });

  it("raeumt den Hinweis wieder weg, sobald eine Navigation glueckt", async () => {
    // Einmal gesetzt, ueberlebte er jede spaetere erfolgreiche Navigation:
    // der Nutzer haengelt sich von Hand zum richtigen Ordner, und darunter
    // steht weiter, der Baum habe es nicht gekonnt.
    const { el } = await mount({ initialPath: "/home/ghost" });
    expect(el.textContent).toContain("/home/ghost");

    toggle(el, "/home/u");
    await flush();

    expect(el.textContent).not.toContain("/home/ghost");
  });

  it("laesst eine Ebene nicht im alten Filterstand haengen, wenn waehrend ihrer Anfrage umgelegt wird", async () => {
    // Abschlussreview, Important 2. `onHiddenToggle` ueberspringt per
    // `!node.loaded` jeden Knoten mit offener Anfrage: weder entwertet noch
    // nachgeladen. Landet die Antwort, setzt `setChildren` `loaded = true`
    // mit den Kindern des ALTEN Filterstands.
    const { el } = await mount({ initialPath: "/home" });
    toggle(el, "/home/u");   // Anfrage laeuft mit includeHidden=false
    setHidden(el, true);          // umlegen, BEVOR sie beantwortet ist
    await flush();

    expect(row(el, "/home/u/.cache")).not.toBeNull();

    // Und der Zwischenspeicher raeumt es NICHT auf: `expand()` meldet fuer
    // die Ebene ab jetzt ewig `false`, zuklappen und wieder aufklappen holt
    // sie also nicht zurueck. Nur ein zweites Umlegen taete es.
    toggle(el, "/home/u");
    toggle(el, "/home/u");
    await flush();
    expect(row(el, "/home/u/.cache")).not.toBeNull();
  });
});

describe("mountDirectoryTree und der Fehlerkanal", () => {
  it("behauptet bei Prosa aus dem Transportkanal kein fehlendes Leserecht", async () => {
    // Verbindlich fuer diese Aufgabe: uebersetzt wird ausschliesslich
    // mit `errorKind`. Die Nadel ist mit Bedacht gewaehlt -- sie TRAEGT
    // "denied" in sich und ueberfuehrt jeden Vergleich per `includes`.
    const { el } = await mount({
      initialPath: "/",
      failFor: { path: "/tmp", raw: "Permission denied (publickey)." },
    });
    toggle(el, "/tmp");
    await flush();

    expect(row(el, "/tmp")!.textContent).toContain("Could not be read");
    expect(row(el, "/tmp")!.textContent).not.toContain("Permission denied");
  });
});

describe("mountDirectoryTree, Bedienung und Lebenszyklus", () => {
  it("waehlt auch per Mausklick und meldet den Pfad", async () => {
    // Abnahmekriterium 6 hat zwei Haelften; `Enter` deckt nur die eine ab.
    const onSelect = vi.fn();
    const { el } = await mount({ initialPath: "/", onSelect });
    toggle(el, "/home");
    expect(onSelect).toHaveBeenCalledWith("/home");
  });

  it("meldet Aufklappbarkeit nur, wo es etwas aufzuklappen gibt", async () => {
    // Review Runde 2, Minor: `/tmp` ist geladen und leer -- ein Blatt.
    // `aria-expanded="false"` daran schickte Hilfsmittel nach Kindern, die
    // es nicht gibt. `/home` ist noch ungeladen, dort ist das Gegenteil
    // unbekannt und das Merkmal bleibt.
    const { el } = await mount({ initialPath: "/" });
    expect(row(el, "/home")!.hasAttribute("aria-expanded")).toBe(true);

    toggle(el, "/tmp");
    await flush();

    expect(row(el, "/tmp")!.hasAttribute("aria-expanded")).toBe(false);
  });

  it("springt mit Home und End an die Enden der sichtbaren Liste", async () => {
    const { el } = await mount({ initialPath: "/" });
    press(el, "End");
    expect(focusedPath(el)).toBe("/tmp");
    press(el, "Home");
    expect(focusedPath(el)).toBe("/");
  });

  it("oeffnet bei leerem Startpfad auf dem Heimatverzeichnis", async () => {
    // Spec §3.3/§4: der leere Pfad ist der EINZIGE Weg dorthin -- dieses
    // Projekt loest Tilden nirgends auf.
    const { el, calls } = await mount({ initialPath: "" });
    expect(calls[0].path).toBe("");
    expect(row(el, HOME)).not.toBeNull();
    expect(row(el, "/")).not.toBeNull();
  });

  it("raeumt beim Entsorgen alles aus dem Behaelter", async () => {
    const { el, handle } = await mount({ initialPath: "/" });
    handle.dispose();
    expect(el.textContent).toBe("");
  });

  it("setzt nach dem Entsorgen keine einzige weitere Anfrage mehr ab", async () => {
    // Review Runde 2, Important 1. "Dialog auf, sofort Esc" ist kein
    // Randfall -- und der leere Startpfad ist der laengste Weg: die Antwort
    // auf `list_directories("")` steht noch aus, und aus ihr entsteht erst
    // die ganze Ahnenkette. Ohne Wache sind das drei SSH-Runden fuer einen
    // Dialog, den niemand mehr sieht.
    const { calls, handle } = open({ initialPath: "" });
    handle.dispose();
    const before = calls.length;

    await flush();

    expect(calls.slice(before).map((c) => c.path)).toEqual([]);
  });

  it("laesst eine Ebene verfallen, deren Antwort erst nach dem Entsorgen eintrifft", async () => {
    // Review Runde 3: der EIGENE Bedienweg von `load()` -- Ordner
    // aufklappen, dann den Dialog schliessen, bevor die Antwort da ist.
    // Derselbe Normalfall wie "Dialog auf, sofort Esc", nur einen Klick
    // spaeter, und bis hierher von keinem Test beruehrt.
    //
    // WAS DIESER TEST NICHT LEISTET -- nachgemessen, nicht vermutet: er wird
    // NICHT rot, wenn man die beiden `disposed`-Wachen in `load()` entfernt
    // (Mutation per `git diff --stat` belegt, 22 gruen). Er haelt den
    // Bedienweg als GANZES fest -- eine Runde je Aufklappen, danach nichts
    // mehr, und der Behaelter ist leer --, nicht jene Wachen. Warum die
    // nicht pinnbar sind, steht am Aufruf von `load()` selbst.
    const { el, calls, handle } = await mount({ initialPath: "/" });
    toggle(el, "/home");
    const before = calls.length;

    handle.dispose();
    await flush();

    expect(calls.slice(before).map((c) => c.path)).toEqual([]);
    expect(el.textContent).toBe("");
  });

  it("haelt den Tastaturfokus ueber das Umlegen des Versteckt-Schalters", async () => {
    // Review Runde 2, Important 2. Der Schalter laesst `visible()`
    // voruebergehend auf die Wurzel schrumpfen; wird die Erinnerung dabei
    // ueberschrieben, verliert ein Tastaturnutzer bei JEDEM Umlegen seine
    // Stelle (Abnahmekriterium 5).
    //
    // Die Ursache ist NICHT `invalidate`: jedes voruebergehende Schrumpfen
    // von `visible()` trifft dieselbe Zeile -- auch ein Knoten, der wirklich
    // vom entfernten Rechner verschwindet.
    const { el } = await mount({ initialPath: "/home/u/repo" });
    press(el, "Home");
    press(el, "ArrowDown");
    press(el, "ArrowDown");
    press(el, "ArrowDown");
    expect(focusedPath(el)).toBe("/home/u/repo");

    setHidden(el, true);
    await flush();

    expect(focusedPath(el)).toBe("/home/u/repo");
  });

  it("holt die aufgeklappte Zeile ins Bild, ohne den Fokus an sich zu reissen", async () => {
    // Review Runde 2: Abnahmekriterium 2 waere sonst erfuellt UND unsichtbar
    // -- `.dir-tree-rows` fasst rund acht Zeilen, das Ziel steht bei
    // realistischem `/`-Inhalt darunter. Der Erstlauf nimmt bewusst keinen
    // Fokus (er wuerde ihn dem Textfeld daneben entreissen), scrollen muss
    // er trotzdem.
    const { el } = await mount({ initialPath: "/home/u/repo" });
    expect(scrolled[scrolled.length - 1]).toBe("/home/u/repo");
    expect(focusedPath(el)).toBeUndefined();
  });
});

// UX-Spec §7.6, Aufgabe 17: ein Klick in der Liste
// "Recent" waehlt wie ein Klick im Baum, und der Baum oeffnet dort.
describe("mountDirectoryTree: von aussen gewaehlt (reveal)", () => {
  it("klappt auf dem gewaehlten Pfad auf, ohne ihn zu melden und ohne den Fokus zu nehmen", async () => {
    const onSelect = vi.fn();
    const { el, calls, handle } = await mount({ initialPath: "/", onSelect });
    const before = calls.length;

    handle.reveal("/home/u/repo");
    await flush();

    expect(calls.slice(before).map((c) => c.path)).toEqual(["/", "/home", "/home/u", "/home/u/repo"]);
    expect(row(el, "/home/u/repo")).not.toBeNull();
    expect(el.querySelector<HTMLElement>('[tabindex="0"]')?.dataset.path).toBe("/home/u/repo");
    expect(scrolled[scrolled.length - 1]).toBe("/home/u/repo");
    // Wer von aussen waehlt, hat schon gewaehlt: keine zweite Meldung.
    expect(onSelect).not.toHaveBeenCalled();
    expect(focusedPath(el)).toBeUndefined();
  });

  it("gewinnt gegen ein Aufklappen, das noch unterwegs ist", async () => {
    const { el, handle } = open({ initialPath: "/home/u/repo" });
    handle.reveal("/tmp");
    await flush();

    // Die Antworten des Starts kommen nach der Wahl an und wirken nicht mehr.
    expect(row(el, "/home/u")).toBeNull();
    expect(el.querySelector<HTMLElement>('[tabindex="0"]')?.dataset.path).toBe("/tmp");
    expect(el.querySelector(".dir-row-note")).toBeNull();
  });

  it("legt bei einem Punkt-Glied den Versteckt-Schalter um", async () => {
    const { el, handle } = await mount({ initialPath: "/" });
    handle.reveal("/home/u/.cache");
    await flush();
    expect(hiddenBox(el).checked).toBe(true);
    expect(row(el, "/home/u/.cache")).not.toBeNull();
  });

  it("faellt aufs Heimatverzeichnis zurueck, wenn der Pfad fort ist", async () => {
    const { el, handle } = await mount({ initialPath: "/", notFoundFor: "/weg" });
    handle.reveal("/weg");
    await flush();
    expect(el.textContent).toContain("'/weg' no longer exists");
    expect(el.querySelector<HTMLElement>('[tabindex="0"]')?.dataset.path).toBe(HOME);
  });

  it("nimmt die Hinweise des vorigen Aufklappens weg", async () => {
    const gone = await mount({ initialPath: "/weg", notFoundFor: "/weg" });
    expect(gone.el.textContent).toContain("home directory");
    gone.handle.reveal("/tmp");
    await flush();
    expect(gone.el.querySelector<HTMLElement>(".dir-tree-notice")?.hidden).toBe(true);

    document.body.replaceChildren();
    const ghost = await mount({ initialPath: "/home/ghost" });
    expect(ghost.el.textContent).toContain("/home/ghost");
    ghost.handle.reveal("/tmp");
    await flush();
    expect(ghost.el.querySelector<HTMLElement>(".dir-tree-notice")?.hidden).toBe(true);
  });

  it("setzt nach dem Entsorgen keine Anfrage mehr ab", async () => {
    const { calls, handle } = await mount({ initialPath: "/" });
    handle.dispose();
    const before = calls.length;
    handle.reveal("/home/u/repo");
    await flush();
    expect(calls.slice(before)).toEqual([]);
  });
});
