// Der Verzeichnisbaum der Sitzungsanlage (Entwurf 2026-07-29). Er kennt den
// Host und einen Pfad, sonst nichts -- keine Sessions, kein `AppState`.
//
// Die Buchfuehrung (welcher Knoten ist offen, geladen, fehlerhaft) liegt
// DOM-frei in `../state/dir-tree`; diese Datei ist die Ansicht darauf und
// der einzige Ort, der `list_directories` ruft. Drei Auflagen, die die
// Zustandsschicht zu Recht dem Aufrufer ueberlaesst und die hier eingeloest
// werden -- alle drei sind an ihrer Stelle im Code benannt:
//
//  1. Die Ahnenkette laeuft nebenlaeufig, wird aber WURZELABWAERTS
//     angewandt (`openOn`). `setChildren` verwirft einen noch unbekannten
//     Pfad wortlos.
//  2. Der Versteckt-Schalter entwertet JEDEN geladenen Knoten, laedt aber
//     nur die offenen nach (`onHiddenToggle`).
//  3. Eine rohe `Err(String)` wird ausschliesslich mit `errorKind`
//     uebersetzt, nie mit einem eigenen `switch` (`request`).
//
// Die rollende Tabulatorstation (Designsystem §5.2, Spec §7) entstand hier
// zum ERSTEN Mal in dieser Anwendung. Die Seitenleiste, fuer die sie
// vorgeschrieben ist, hat inzwischen drei eigene (Liste, Knopfleiste und
// Hostmenue, Entwurf 2026-07-31 §1.5 und §3) -- sie hat diesen Block aber
// nicht uebernommen, sondern seine Form nachgebaut: je ein `apply…` als
// einziger Schreiber der `0`, ein `move…To`, ein Tastaturhorcher. Damit gibt
// es die vierte Abschrift derselben Regel. Ein gemeinsames Modul dafuer
// entsteht ausdruecklich NICHT hier -- die Zusammenfuehrung aller vier ist
// eine eigene Aufgabe des naechsten Pakets.
//
// FUER DEN EINBAUENDEN DIALOG: der BAUM ist eine Tabulatorstation, der
// Versteckt-Schalter ueber ihm eine zweite -- dieses Modul belegt also zwei
// Stellen der Tabulatorreihenfolge, nicht eine.

import { invoke } from "@tauri-apps/api/core";
import { DirTree, ancestry, errorKind, type DirNode } from "../state/dir-tree";
import { icon } from "../icons";
import { t } from "../i18n/t";

export interface DirectoryTreeOptions {
  hostId: string;
  /** Pfad, auf dessen Ahnenkette der Baum aufgeklappt startet. Leer =
   *  Heimatverzeichnis.
   *
   *  Ein Pfad, den es auf dem Host nicht mehr gibt, ist KEIN Fehlerfall fuer
   *  den Aufrufer: der Baum faellt selbst aufs Heimatverzeichnis zurueck und
   *  sagt es in einer Zeile ueber sich (Entwurf §5). */
  initialPath: string;
  /** Feuert GENAU EINMAL und NUR, wenn `initialPath` leer war: mit dem
   * Heimatverzeichnis, das der Baum daraufhin aufgeloest hat.
   *
   * Getrennt von `onSelect`, obwohl beide einen Pfad melden, weil sie
   * verschiedene Dinge bedeuten: `onSelect` heisst "der Nutzer hat gewaehlt",
   * dies hier heisst "so lautet der Startpfad, den du mir nicht nennen
   * konntest". Der Unterschied ist nicht kosmetisch -- der Aufrufer darf auf
   * eine Wahl bedingungslos reagieren, auf diese Meldung nicht: sie trifft
   * erst nach zwei SSH-Runden ein, und in der Zwischenzeit kann der Nutzer
   * laengst selbst etwas eingetragen haben. Wer beides ueber denselben
   * Rueckruf fuehrt, kann die zwei Faelle am Empfangsende nicht mehr
   * auseinanderhalten und wischt die Eingabe weg. */
  onInitialPath?: (path: string) => void;
  /** Feuert bei JEDEM Klick auf eine Zeile und bei `Enter` -- also auch beim
   * blossen Durchblaettern, nicht erst bei einer abschliessenden Wahl.
   *
   * Absicht: eine Zeile ist EIN `<button>` (ein `<button>` im `<button>`
   * waere ungueltig), es gibt also kein eigenes Dreieck zum Anklicken --
   * derselbe Klick muss aufklappen UND waehlen, sonst bliebe eines von
   * beiden der Tastatur allein vorbehalten. Ein angeschlossenes Textfeld
   * folgt damit der Navigation; wer das nicht will, braucht einen eigenen
   * Uebernehmen-Schritt. */
  onSelect: (path: string) => void;
}

export interface DirectoryTreeHandle {
  /** Klappt den Baum auf `path` auf, wie beim Start auf einem Startpfad -- fuer
   * eine Wahl ausserhalb des Baums (die Liste "Recent" im Sitzungsdialog,
   * UX-Spec §7.6). Ein noch laufendes Aufklappen wendet danach nichts mehr
   * an. Meldet nichts an `onSelect`: wer aufruft, hat schon gewaehlt. */
  reveal(path: string): void;
  /** MUSS beim Schliessen des Dialogs laufen. Raeumt den Behaelter, haengt
   * die Tastatur- und Schalter-Behandler ab und setzt die Sperre, hinter der
   * eine spaet eintreffende Antwort keine Arbeit mehr verrichtet.
   *
   * Ohne diesen Aufruf bleiben die Behandler an den (dann verwaisten)
   * Elementen haengen und jede noch offene `list_directories`-Antwort baut
   * den Baum nochmals auf, obwohl ihn niemand mehr sieht. Nichts ueberlebt
   * `dispose()` -- ein erneut geoeffneter Dialog holt frisch (Entwurf §4.2,
   * Gesamtentwurf §5.3). */
  dispose(): void;
}

interface DirectoryListingDto {
  path: string;
  entries: string[];
}

type Reply =
  | { ok: true; path: string; entries: string[] }
  | { ok: false; kind: NonNullable<DirNode["error"]> };

/** Der Baum wurzelt IMMER hier, auch beim Rueckfall aufs Heimatverzeichnis:
 * `ancestry()` beginnt seine Kette ausnahmslos bei `/`, und `setChildren`
 * verwirft jeden Pfad, der kein Kind eines bekannten Knotens ist -- ein Baum
 * mit der Wurzel `/home/u` bekaeme sein erstes `setChildren("/")`
 * wortlos verworfen. Das Heimatverzeichnis bestimmt also, worauf
 * AUFGEKLAPPT wird, nicht, wo gewurzelt wird. */
const ROOT = "/";

export function mountDirectoryTree(
  el: HTMLElement,
  opts: DirectoryTreeOptions,
): DirectoryTreeHandle {
  let disposed = false;
  let includeHidden = false;
  /** Die Zeile, die gerade die einzige Tabulatorstation traegt. */
  let focusPath = ROOT;
  /** Pfade mit offener Anfrage -- traegt den Ladehinweis an der Zeile. */
  const loading = new Set<string>();
  let fallback: { path: string; home: string } | null = null;
  let unreachable: { path: string; name: string; parent: string } | null = null;
  /** Zaehlt die Aufklapp-Laeufe: der Start ist Lauf 0, jedes `reveal` beginnt
   * einen neuen. Ein aelterer Lauf wendet ab dann keine Antwort mehr an --
   * sonst klappte ein spaet eintreffender Start den Baum ueber der Wahl des
   * Nutzers wieder auf seinem eigenen Pfad auf. */
  let navigation = 0;

  const tree = new DirTree(ROOT);

  el.replaceChildren();

  const root = document.createElement("div");
  root.className = "dir-tree";

  const hiddenLabel = document.createElement("label");
  hiddenLabel.className = "dir-tree-hidden";
  const hiddenBox = document.createElement("input");
  hiddenBox.type = "checkbox";
  hiddenBox.name = "includeHidden";
  hiddenLabel.appendChild(hiddenBox);
  hiddenLabel.appendChild(document.createTextNode(t("dirTree.hidden.label")));
  root.appendChild(hiddenLabel);

  // `role="status"`, weil der Wechsel aufs Heimatverzeichnis nichts ist, was
  // der Nutzer ausgeloest hat: er muss angesagt werden, ohne die Arbeit zu
  // unterbrechen (kein `alert` -- es ist kein Fehler, Entwurf §5).
  const notice = document.createElement("p");
  notice.className = "dir-tree-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  root.appendChild(notice);

  const rows = document.createElement("div");
  rows.className = "dir-tree-rows";
  root.appendChild(rows);

  el.appendChild(root);

  /** EINE Uebersetzungsstelle fuer die rohe `Err(String)`, und zwar
   * `errorKind` -- derselbe Rueckgabewert traegt die maschinenlesbaren
   * Kuerzel des Fernskripts UND Prosa des Transports. Ein eigener `switch`
   * hier waere genau die Defektklasse, die im Rust-Gegenstueck dreimal
   * entfernt wurde.
   *
   * Der Fehlerzweig haengt SYNCHRON beim Absetzen an der Zusage, nicht erst
   * beim Abwarten: `openOn` setzt vier Anfragen ab und wartet sie
   * nacheinander ab, eine abgelehnte Zusage haette bis dahin sonst keinen
   * Behandler und schluege als unbehandelte Ablehnung durch. */
  function request(path: string): Promise<Reply> {
    return invoke<DirectoryListingDto>("list_directories", {
      hostId: opts.hostId,
      path,
      includeHidden,
    }).then(
      (dto) => ({ ok: true, path: dto.path, entries: dto.entries }) as Reply,
      (err: unknown) => ({ ok: false, kind: errorKind(String(err)) }) as Reply,
    );
  }

  function errorText(kind: NonNullable<DirNode["error"]>): string {
    switch (kind) {
      case "denied":
        return t("dirTree.error.denied");
      case "notfound":
        return t("dirTree.error.notfound");
      case "notdir":
        return t("dirTree.error.notdir");
      case "failed":
        return t("dirTree.error.failed");
    }
  }

  /** Ladezustand und Fehler tragen TEXT, nicht nur Farbe (Entwurf §6,
   * Gesamtentwurf §7.7). Die Klasse faerbt zusaetzlich; sie ist nie der
   * einzige Kanal. */
  function noteFor(node: DirNode): { cls: string; text: string } | null {
    if (loading.has(node.path)) return { cls: "dir-row-note", text: t("dirTree.loading") };
    if (node.error !== null) {
      return { cls: "dir-row-note dir-row-error", text: errorText(node.error) };
    }
    return null;
  }

  function buildRow(node: DirNode): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ab-row dir-row";
    button.dataset.path = node.path;
    // Die Einrueckung als ZAEHLUNG an die Zeile, die Schrittweite bleibt im
    // Stylesheet -- sonst stuende ein Pixelwert im TypeScript.
    button.style.setProperty("--dir-depth", String(node.depth));
    // Nur an Knoten, die ueberhaupt aufklappbar SIND. Ein geladenes, leeres
    // Verzeichnis ist ein Blatt -- `aria-expanded="false"` daran meldete
    // Hilfsmitteln eine Aufklappbarkeit, die es nicht gibt, und der Nutzer
    // suchte nach Kindern, die nie kommen. Solange nicht geladen ist, ist
    // das Gegenteil unbekannt, also bleibt das Merkmal stehen.
    if (!node.loaded || node.children.length > 0) {
      button.setAttribute("aria-expanded", String(node.expanded));
    }
    button.tabIndex = -1;

    // Icon statt der Zeichen "▾"/"▸" (Spec 11.5, 13): der Kasten haelt die
    // 16 Pixel unabhaengig von der Schrift, und `data-icon` macht den
    // Zustand pruefbar, ohne den SVG-Inhalt vergleichen zu muessen.
    const chev = document.createElement("span");
    chev.className = "chev icon-box";
    chev.setAttribute("aria-hidden", "true");
    const chevName = node.expanded ? "chevron-down" : "chevron-right";
    chev.dataset.icon = chevName;
    chev.appendChild(icon(chevName));
    button.appendChild(chev);

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = node.name;
    button.appendChild(label);

    const note = noteFor(node);
    if (note !== null) {
      const span = document.createElement("span");
      span.className = note.cls;
      span.textContent = note.text;
      button.appendChild(span);
    }

    button.addEventListener("click", () => {
      if (!disposed) activate(node.path);
    });
    return button;
  }

  function parentPath(path: string): string | null {
    if (path === ROOT) return null;
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? ROOT : path.slice(0, cut);
  }

  function nameOf(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut < 0 ? path : path.slice(cut + 1);
  }

  /** Traegt der Pfad ein Glied, das mit einem Punkt beginnt?
   *
   * Dann filtert das Backend genau dieses Glied aus der Liste seines
   * Elternteils, solange `include_hidden` falsch ist -- der Knoten entstuende
   * nie, und der Baum oeffnete wortlos eine Ebene zu hoch. Der Entwurf nennt
   * `.git` selbst als Motiv fuer den Schalter; ein gespeicherter Arbeitspfad
   * mit Punkt-Glied ist also ausdruecklich vorgesehen, nicht exotisch. */
  function hasHiddenSegment(path: string): boolean {
    return path.split("/").some((segment) => segment.startsWith("."));
  }

  /** Welche Zeile die Tabulatorstation gerade TRAEGT.
   *
   * Getrennt von `focusPath`, und das ist der Kern (Review Runde 2,
   * Important 2): `focusPath` ist der gemerkte WUNSCH und wird hier NIE
   * ueberschrieben. Frueher tat diese Stelle genau das, und jedes
   * voruebergehende Schrumpfen von `visible()` zerstoerte die Erinnerung
   * dauerhaft -- beim Versteckt-Schalter (`invalidate` leert `children`, bis
   * die neue Liste da ist), aber genauso, wenn ein Knoten zwischen zwei
   * Auflistungen wirklich vom entfernten Rechner verschwindet. Ein
   * Tastaturnutzer verlor dabei jedes Mal seine Stelle.
   *
   * Nicht ueberschrieben zu werden ist strikt mehr, als "behalten, solange
   * der Knoten in `nodes` steht" verlangt -- und es muss mehr sein: `nodes`
   * kennt kein Loeschen (`dir-tree.ts` fuegt nur hinzu), dafuer setzt
   * `start()` den Wunsch auf das Rueckfallziel, BEVOR dessen Knoten
   * ueberhaupt entsteht. Eine Regel, die an `nodes.has()` haengt, haette
   * genau dort zugeschlagen.
   *
   * Ist der Wunsch gerade nicht sichtbar, wandert die Station auf den
   * naechsten sichtbaren Vorfahren -- die Kette endet immer bei `/`, das
   * `visible()` ausnahmslos enthaelt. Damit traegt IMMER genau eine Zeile
   * `tabindex="0"`; ohne diesen Rueckfall haette der Baum waehrend des
   * Nachladens gar keine Tabulatorstation. */
  function effectiveFocus(list: DirNode[]): string {
    if (list.some((node) => node.path === focusPath)) return focusPath;
    for (let p = parentPath(focusPath); p !== null; p = parentPath(p)) {
      if (list.some((node) => node.path === p)) return p;
    }
    return list[0]?.path ?? ROOT;
  }

  /** GENAU eine Zeile traegt `tabindex="0"`, alle anderen `-1`. */
  function applyRoving(takeFocus: boolean): void {
    const current = effectiveFocus(tree.visible());
    let target: HTMLElement | null = null;
    for (const button of rows.querySelectorAll<HTMLElement>("[data-path]")) {
      const isFocus = button.dataset.path === current;
      button.tabIndex = isFocus ? 0 : -1;
      if (isFocus) target = button;
    }
    if (target === null) return;
    if (takeFocus) target.focus();
    // AUCH ohne Fokusnahme (Review Runde 2): der Erstlauf ruft
    // `applyRoving(false)` -- er darf dem Textfeld daneben den Fokus nicht
    // entreissen, muss die aufgeklappte Zeile aber ins Bild holen.
    // `.dir-tree-rows` fasst rund acht Zeilen; ohne das waere
    // Abnahmekriterium 2 erfuellt und zugleich unsichtbar. `block: "nearest"`
    // scrollt nur, wenn die Zeile wirklich ausserhalb steht.
    //
    // Optional gerufen, weil jsdom die Methode nicht kennt (nachgemessen) --
    // dieselbe Vorsichtsform wie bei `navigator.clipboard` in `sidebar.ts`.
    target.scrollIntoView?.({ block: "nearest" });
  }

  function render(): void {
    if (disposed) return;

    // Nur wenn der Fokus VORHER hier drin stand: `render()` laeuft auch,
    // waehrend der Nutzer im Textfeld daneben tippt (eine Antwort trifft
    // ein) -- der Baum darf ihm den Fokus dann nicht entreissen.
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && rows.contains(active);

    if (unreachable !== null) {
      notice.hidden = false;
      notice.textContent = t("dirTree.unreachable", unreachable);
    } else if (fallback !== null) {
      notice.hidden = false;
      notice.textContent = t("dirTree.fallbackToHome", fallback);
    } else {
      notice.hidden = true;
      notice.textContent = "";
    }

    rows.replaceChildren();
    for (const node of tree.visible()) rows.appendChild(buildRow(node));
    applyRoving(hadFocus);
  }

  /** Holt EINE Ebene nach.
   *
   * Die beiden `disposed`-Wachen hier sind Verteidigung in der Tiefe und
   * durch KEINEN Test zu pinnen -- nachgemessen (Review Runde 3), nicht
   * vermutet: beide entfernt, alle 22 Tests bleiben gruen. Zwei Gruende,
   * die zusammenwirken:
   *
   *  - Die obere ist heute unerreichbar. Alle drei Aufrufer wachen bereits
   *    selbst (`activate` ueber den Klickbehandler, `onKeyDown` und
   *    `onHiddenToggle` am Kopf), und keiner hat zwischen seiner Wache und
   *    dem Aufruf ein `await`.
   *  - Die untere spart `setChildren`/`setError`/`render()` -- aber
   *    `render()` wacht selbst, und `dispose()` haengt den Teilbaum per
   *    `el.replaceChildren()` ohnehin ab. Nach dem Entsorgen ist auf keinem
   *    Kanal etwas zu sehen.
   *
   * Sie bleiben trotzdem stehen: `load` ist der Weg, auf dem kuenftig ein
   * Aufrufer OHNE eigene Wache dazukommen kann, und der Preis ist zwei
   * Zeilen. Aber sie stehen hier als das, was sie sind -- ungedeckt. */
  async function load(path: string): Promise<void> {
    if (disposed) return;
    // Synchron vor dem ersten Abwarten gesetzt, damit das `render()` des
    // Aufrufers den Ladehinweis schon sieht.
    loading.add(path);
    // WELCHER Filterstand diese Anfrage erzeugt hat. `request()` schliesst
    // ihn beim Absetzen ein; ohne diese Notiz weiss danach niemand mehr,
    // welcher es war -- genau die fehlende Invariante aus dem
    // Abschlussreview.
    const askedWith = includeHidden;
    const reply = await request(path);
    if (disposed) return;

    if (askedWith !== includeHidden) {
      // Der Schalter wurde umgelegt, WAEHREND diese Anfrage lief. Die
      // Antwort traegt den alten Stand; sie jetzt einzuspielen setzte
      // `loaded = true` mit den falschen Kindern, und `expand()` meldete
      // fuer die Ebene ab da ewig `false` -- auch Zuklappen und erneutes
      // Aufklappen holte sie nicht zurueck, nur ein zweites Umlegen.
      // `onHiddenToggle` kann sie nicht auffangen: dort ist sie noch nicht
      // `loaded` und wird uebersprungen. Also verwerfen und mit dem
      // aktuellen Stand neu holen. `loading` bleibt gesetzt -- die Zeile
      // laedt aus Sicht des Nutzers ununterbrochen weiter.
      void load(path);
      return;
    }

    loading.delete(path);
    if (reply.ok) {
      // Eine geglueckte Navigation loest den Hinweis ab. Ohne das ueberlebte
      // er jedes spaetere Aufklappen: der Nutzer haengelt sich von Hand zum
      // richtigen Ordner, und darunter steht weiter, der Baum habe es nicht
      // gekonnt.
      unreachable = null;
      tree.setChildren(path, reply.entries);
    } else {
      tree.setError(path, reply.kind);
    }
    render();
  }

  /** Ein Klick tut BEIDES: umschalten und waehlen.
   *
   * Eine Zeile ist EIN `<button>` -- ein `<button>` im `<button>` waere
   * ungueltiges HTML, es gibt hier also kein eigenes Dreieck zum Anklicken
   * (dieselbe Ueberlegung wie in `sidebar.ts`). Nur umzuschalten liesse
   * Abnahmekriterium 6 der Tastatur allein; nur zu waehlen liesse
   * Abnahmekriterium 1 der Tastatur allein. Beides an einem Klick ist
   * ausserdem das Verhalten, das ein Ordnerwaehler gewohnheitsmaessig
   * zeigt. */
  function activate(path: string): void {
    const node = tree.nodes.get(path);
    if (node === undefined) return;
    focusPath = path;
    if (node.expanded) {
      tree.collapse(path);
    } else if (tree.expand(path)) {
      // `expand()` meldet den Ladebedarf -- DER Zwischenspeicher-Vertrag aus
      // §4.2. Zuklappen und erneutes Aufklappen kostet deshalb keinen
      // Aufruf.
      void load(path);
    }
    render();
    opts.onSelect(path);
  }

  function moveTo(node: DirNode | undefined): void {
    if (node === undefined) return;
    focusPath = node.path;
    applyRoving(true);
  }

  /** Der naechste sichtbare Knoten OBERHALB mit geringerer Tiefe. Ueber die
   * sichtbare Liste statt per Zeichenkettenzerlegung des Pfads: der
   * Elternknoten ist genau der, unter dem die Zeile gezeichnet steht. */
  function parentOf(list: DirNode[], index: number): DirNode | undefined {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (list[i].depth < list[index].depth) return list[i];
    }
    return undefined;
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (disposed) return;
    const list = tree.visible();
    // Von der Zeile aus, die die Station TRAEGT -- nicht vom gemerkten
    // Wunsch: waehrend eine Ebene nachlaedt, ist der Wunsch unsichtbar, und
    // ein `findIndex` darauf lieferte `-1`, also eine tote Tastatur.
    const index = list.findIndex((node) => node.path === effectiveFocus(list));
    if (index < 0) return;
    const node = list[index];

    switch (ev.key) {
      case "ArrowDown":
        moveTo(list[index + 1]);
        break;
      case "ArrowUp":
        moveTo(list[index - 1]);
        break;
      case "Home":
        moveTo(list[0]);
        break;
      case "End":
        moveTo(list[list.length - 1]);
        break;
      case "ArrowRight":
        if (!node.expanded) {
          if (tree.expand(node.path)) void load(node.path);
          render();
        } else {
          const next = list[index + 1];
          if (next !== undefined && next.depth > node.depth) moveTo(next);
        }
        break;
      case "ArrowLeft":
        if (node.expanded) {
          tree.collapse(node.path);
          render();
        } else {
          moveTo(parentOf(list, index));
        }
        break;
      case "Enter":
        opts.onSelect(node.path);
        break;
      default:
        return;
    }
    // Muss auch fuer `Enter` laufen: ein echter Browser erzeugt aus `Enter`
    // auf einem `<button>` zusaetzlich einen Klick, und der wuerde hier
    // umschalten UND ein zweites Mal waehlen. jsdom tut das nicht -- der
    // Doppelschlag waere also in keinem Test dieser Datei zu sehen.
    ev.preventDefault();
  }

  rows.addEventListener("keydown", onKeyDown);

  /** Entwertet JEDEN geladenen Knoten, laedt aber nur die OFFENEN nach.
   *
   * Beides ist noetig, keins genuegt allein. Nur die offenen neu zu laden
   * -- der Buchstabe von §4.2 -- liesse eine Ebene stehen, die aufgeklappt,
   * wieder zugeklappt und danach nicht mehr angefasst wurde: sie truege noch
   * den alten Filterstand, `expand()` meldete fuer sie `false`, und beim
   * naechsten Aufklappen stuenden die Punkt-Eintraege wieder da (Bruch von
   * Abnahmekriterium 3). Alle entwerteten sofort nachzuladen waere der
   * umgekehrte Fehler: eine SSH-Runde je zugeklappter Ebene.
   *
   * Entwerten ist kostenlos; die zugeklappten holen sich beim naechsten
   * Aufklappen selbst, weil `expand()` dann wieder Ladebedarf meldet. */
  function setIncludeHidden(next: boolean): void {
    if (next === includeHidden) return;
    includeHidden = next;
    // Der Schalter zeigt IMMER den geltenden Stand -- auch wenn nicht der
    // Nutzer ihn umgelegt hat, sondern `start()` wegen eines Punkt-Glieds im
    // Feldwert. Ein Schalter auf "aus", waehrend der Baum Verstecktes zeigt,
    // waere eine Anzeige, die luegt.
    hiddenBox.checked = next;
    const open: string[] = [];
    for (const node of tree.nodes.values()) {
      // Ebenen mit OFFENER Anfrage sind hier absichtlich nicht dabei: sie
      // sind noch nicht `loaded`, es gibt nichts zu entwerten, und ihre
      // Antwort faengt sich in `load()` selbst ab (siehe dort).
      if (!node.loaded) continue;
      // `invalidate` laesst `expanded` unberuehrt -- sonst fiele der Baum
      // bei jedem Umschalten vor den Augen des Nutzers zusammen.
      if (node.expanded) open.push(node.path);
      tree.invalidate(node.path);
    }
    for (const path of open) void load(path);
    render();
  }

  function onHiddenToggle(): void {
    if (disposed) return;
    setIncludeHidden(hiddenBox.checked);
  }

  hiddenBox.addEventListener("change", onHiddenToggle);

  /** Haelt `Enter` auf dem Schalter an.
   *
   * Nicht Kosmetik: seit Task 4 haengt dieser Baum IM `<form>` des
   * Sitzungsdialogs, und ein echter Browser macht aus `Enter` auf einem
   * Formularelement die implizite Absendung. Ein Tastaturnutzer tabbt auf
   * "Show hidden entries", drueckt `Enter`, um umzuschalten -- und legt
   * stattdessen die Session an, mit dem Pfad, der gerade im Feld steht.
   *
   * Umgeschaltet wird hier bewusst NICHT: eine Checkbox reagiert auch sonst
   * nirgends auf `Enter`, dafuer ist die Leertaste da (die weiterhin
   * unberuehrt durchlaeuft). Angehalten wird nur das, was nicht passieren
   * darf.
   *
   * jsdom bildet die implizite Absendung nicht ab -- ein Test auf "der
   * Dialog sendet nicht ab" waere hier leer. Zugesichert ist deshalb die
   * ABWEHR (`defaultPrevented`), und zwar dort, wo die Gefahr entsteht:
   * `session-dialog.test.ts`. */
  function onHiddenKeyDown(ev: KeyboardEvent): void {
    if (disposed || ev.key !== "Enter") return;
    ev.preventDefault();
  }

  hiddenBox.addEventListener("keydown", onHiddenKeyDown);

  /** Klappt den Baum auf der Ahnenkette von `target` auf.
   *
   * Die Aufrufe laufen NEBENLAEUFIG (Spec §5: vier Ebenen, eine
   * Rundrufdauer, nicht vier) -- `chain.map` setzt alle ab, bevor die erste
   * beantwortet ist. Angewandt werden sie aber streng WURZELABWAERTS, und
   * genau dafuer steht die Schleife statt eines `Promise.all(...).then`:
   * `new DirTree("/")` kennt anfangs nur `/`, Knoten entstehen
   * ausschliesslich als Kinder ihres Elternteils, und `setChildren` verwirft
   * einen unbekannten Pfad WORTLOS. Traefe die Antwort fuer `/home/u`
   * vor der fuer `/home` ein und wuerde sofort eingespielt, waere sie
   * verloren -- der Baum oeffnete nicht auf dem Feldwert, und nichts meldete
   * es.
   *
   * Meldet `true`, wenn genau der ZIELPFAD nicht mehr existiert; nur das
   * loest den Rueckfall aufs Heimatverzeichnis aus.
   *
   * `run` ist der Aufklapp-Lauf (siehe `navigation`): hat inzwischen ein
   * neuer begonnen, bricht dieser ab, ohne weitere Antworten anzuwenden. */
  async function openOn(target: string, run: number): Promise<boolean> {
    // VOR `chain.map` (Review Runde 2, Important 1): danach waeren die
    // Aufrufe abgesetzt, und eine Wache hinter dem ersten `await` kaeme zu
    // spaet -- die SSH-Runden liefen bereits.
    if (disposed || run !== navigation) return false;

    // Ein neuer Oeffnungsversuch loest den Hinweis des vorigen ab. Seit
    // `reveal` erreichbar: der Start kann den Hinweis gesetzt haben, und die
    // Wahl aus der Liste "Recent" oeffnet danach anderswo.
    unreachable = null;

    const chain = ancestry(target);
    for (const path of chain) loading.add(path);
    render();

    // Dieselbe Buchfuehrung wie in `load()`, und aus demselben Grund: ein
    // Kettenglied ist waehrend seines Fluges nicht `loaded`, wird von
    // `setIncludeHidden` also uebersprungen -- weder entwertet noch
    // nachgeladen. Ohne diese Notiz landen die Antworten mit dem alten Stand,
    // `setChildren` setzt `loaded = true`, und `expand()` meldete fuer die
    // Ebene ab da ewig `false`. Die Aussage "`setIncludeHidden` darf
    // `!loaded` ueberspringen" gilt nur, wenn JEDE offene Anfrage sich selbst
    // abfaengt; `openOn` ist der zweite Ort, an dem eine entsteht.
    const askedWith = includeHidden;
    const replies = chain.map((path) => request(path));

    for (let i = 0; i < chain.length; i += 1) {
      const path = chain[i];
      const reply = await replies[i];
      loading.delete(path);
      if (disposed) return false;

      if (run !== navigation) {
        // Ein neuer Lauf hat uebernommen: er holt seine Kette selbst. Die
        // Ladehinweise dieser Kette verschwinden mit ihr.
        for (const rest of chain.slice(i)) loading.delete(rest);
        render();
        return false;
      }

      if (askedWith !== includeHidden) {
        // Ueberholt. Die Kette von vorn holen, statt die uebrigen Antworten
        // einzuspielen -- die bereits angewandten Glieder hat
        // `setIncludeHidden` beim Umlegen entwertet, der neue Durchlauf
        // ueberschreibt sie ohnehin.
        //
        // WAS DAS KOSTET, damit es nicht spaeter jemand als Defekt findet:
        // `setIncludeHidden` schiebt jeden geladenen UND offenen Knoten per
        // `void load()` nach, und ein bereits angewandtes Kettenglied ist
        // beides -- es wird also einmal von dort und einmal von diesem
        // Neustart geholt. Gemessen bei einem Umlegen mitten in der Kette:
        // neun Aufrufe, `/` dreimal, Ergebnisbaum korrekt. Der Preis ist
        // hier gerechtfertigt (der Fall ist echt und die Alternative waere
        // ein Baum im falschen Filterstand); mit demselben Argument wurde
        // das Umlegen im Rueckfallzweig von `start()` gestrichen, wo der
        // Fall konstruiert ist.
        for (const rest of chain.slice(i)) loading.delete(rest);
        return openOn(target, run);
      }

      // Der Rueckfall aufs Heimatverzeichnis geht VOR: dass der Zielpfad fort
      // ist, ist die genauere Auskunft als "im Elternteil nicht gelistet",
      // und nur sie darf den Rueckfall ausloesen (Entwurf §5).
      if (!reply.ok && path === target && reply.kind === "notfound") {
        for (const rest of chain.slice(i)) loading.delete(rest);
        return true;
      }

      // Die Auffanglinie fuer die stille Verwerfung -- VOR dem Fehlerzweig,
      // nicht dahinter: `setChildren` UND `setError` verwerfen einen Pfad
      // wortlos, den `nodes` nicht kennt. Stand die Pruefung hinter dem
      // Fehlerzweig, war sie fuer genau den Fall unerreichbar, den sie
      // abfangen soll -- ein `denied` auf ein Glied ohne Knoten verpuffte,
      // und der Baum stand stumm eine Ebene zu hoch. `expand()`s `false`
      // heisst "kein Ladebedarf", nicht "gibt es nicht". Kriterium 2
      // verlangt: der Baum steht auf dem Feldwert ODER sagt, dass er es
      // nicht kann.
      if (tree.nodes.get(path) === undefined) {
        unreachable = { path: target, name: nameOf(path), parent: parentPath(path) ?? ROOT };
        for (const rest of chain.slice(i)) loading.delete(rest);
        render();
        return false;
      }

      if (!reply.ok) {
        for (const rest of chain.slice(i)) loading.delete(rest);
        tree.setError(path, reply.kind);
        render();
        // Die tieferen Glieder koennen ohne dieses hier ohnehin nicht
        // ankommen -- ihre Knoten entstehen nie.
        return false;
      }

      tree.expand(path);
      tree.setChildren(path, reply.entries);
      // Die Station wandert auf das zuletzt aufgeklappte Glied mit, endet
      // also auf dem Zielpfad. Damit landet ein Tabulator dort, wo der Baum
      // sich geoeffnet hat, und `applyRoving` holt genau diese Zeile ins
      // Bild (Abnahmekriterium 2). Ohne das staende die Station auf `/` und
      // das Ziel bliebe unter der Falte.
      focusPath = path;
      render();
    }
    return false;
  }

  /** Der EINZIGE Weg zum Heimatverzeichnis: `list_directories` mit leerem
   * Pfad loest es auf und sagt im Rueckgabewert, welches es war (Spec §3.3).
   * Dieses Projekt loest Tilden nirgends auf, und `build_in_dir` besteht mit
   * einem `assert!` auf einem absoluten Pfad.
   *
   * Die anschliessende Kette listet das Heimatverzeichnis ein zweites Mal.
   * Bewusst hingenommen: eine Abkuerzung, die die erste Antwort in die Kette
   * einspeist, waere ein zweiter Zweig fuer eine einzelne gesparte
   * SSH-Runde in einem seltenen Fall. */
  async function requestHome(): Promise<string | null> {
    const reply = await request("");
    // VOR der Auswertung (Review Runde 2, Important 1): stand die Wache
    // hinter `if (reply.ok)`, gab ein entsorgter Baum den Heimatpfad
    // trotzdem zurueck -- und `start()` legte darauf die ganze Ahnenkette
    // los, drei SSH-Runden fuer einen geschlossenen Dialog.
    if (disposed) return null;
    if (reply.ok) return reply.path;
    // Der Wurzelknoten ist die einzige Zeile, die es zu diesem Zeitpunkt
    // sicher gibt -- ohne diesen Hinweis stuende der Baum stumm da.
    tree.setError(ROOT, reply.kind);
    render();
    return null;
  }

  async function start(): Promise<void> {
    // Jedes `await` hier ist eine Stelle, an der der Dialog geschlossen
    // werden kann; jede wird einzeln bewacht. Die Wachen in `requestHome`
    // und `openOn` decken dasselbe ab -- doppelt, weil ein Vergessen hier
    // eine SSH-Runde kostet und nicht bloss eine ueberfluessige Zuweisung.
    const run = navigation;
    let target = opts.initialPath;
    if (target === "") {
      const home = await requestHome();
      // Auch eine Wahl von aussen (`reveal`) beendet den Start: der
      // aufgeloeste Startpfad gehoert dann weder ins Feld noch in den Baum.
      if (home === null || disposed || run !== navigation) return;
      target = home;
      // NUR in diesem Zweig: bei vorgegebenem Pfad kennt der Aufrufer ihn
      // bereits, und eine Meldung waere ein zweiter Schreiber auf demselben
      // Feld. Hier dagegen ist es die einzige Stelle, an der der aufgeloeste
      // Startpfad ueberhaupt bekannt wird -- ohne sie stuende der Baum
      // richtig, waehrend ein angeschlossenes Textfeld leer bliebe.
      opts.onInitialPath?.(target);
    }
    await openTarget(target, run);
  }

  /** Klappt auf `target` auf; gibt es den Pfad auf dem Host nicht mehr, faellt
   * der Baum aufs Heimatverzeichnis zurueck und sagt es (Entwurf §5). Der Weg
   * des Starts und der von `reveal`. */
  async function openTarget(target: string, run: number): Promise<void> {
    // VOR der ersten Ahnen-Anfrage: `request()` schliesst `includeHidden`
    // beim Absetzen ein, ein spaeteres Umlegen kaeme fuer die Kette zu spaet.
    // Der Nutzer hat diesen Pfad selbst gespeichert (oder dort eine Session
    // angelegt) -- dass er ihn sehen will, ist keine Vermutung.
    if (hasHiddenSegment(target)) setIncludeHidden(true);

    const gone = await openOn(target, run);
    if (!gone || disposed || run !== navigation) return;

    const home = await requestHome();
    if (home === null || disposed || run !== navigation) return;
    fallback = { path: target, home };
    focusPath = home;
    // Hier BEWUSST kein `hasHiddenSegment`-Umlegen (Nachpruefung, Punkt 4):
    // an dieser Stelle ist `/` bereits geladen, das Umlegen entwertete und
    // laedt es nach, und `openOn(home)` holte es unmittelbar danach als
    // Kettenglied erneut -- gemessen EIN Aufruf mehr, nicht mehrere, fuer ein
    // Heimatverzeichnis mit Punkt-Glied, das es praktisch nicht gibt.
    //
    // Traegt es wider Erwarten eines, meldet die Auffanglinie in `openOn`,
    // dass der Baum dort nicht oeffnen kann -- aber ueber das FALSCHE
    // SUBJEKT: `render()` gibt `unreachable` den Vorrang vor `fallback`, der
    // Nutzer erfaehrt also, dass `/home/.u` nicht gelistet ist, und NICHT
    // mehr, dass sein gespeicherter Pfad ueberhaupt verschwunden war. Beides
    // gleichzeitig zu sagen waere eine zweite Hinweiszeile fuer einen Fall,
    // den niemand je erreicht; das Verschlucken ist der guenstigere Handel,
    // aber es ist eins.
    render();
    await openOn(home, run);
  }

  void start();
  render();

  return {
    reveal(path) {
      if (disposed) return;
      navigation += 1;
      // Ein Rueckfall-Hinweis des vorigen Laufs gilt nicht fuer diesen Pfad;
      // den des Auffangens raeumt `openOn` selbst.
      fallback = null;
      void openTarget(path, navigation);
    },
    dispose() {
      disposed = true;
      rows.removeEventListener("keydown", onKeyDown);
      hiddenBox.removeEventListener("change", onHiddenToggle);
      hiddenBox.removeEventListener("keydown", onHiddenKeyDown);
      el.replaceChildren();
    },
  };
}
