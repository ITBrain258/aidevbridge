// Die Buchfuehrung des Verzeichnisbaums (Spec §4.1): welcher Knoten ist
// aufgeklappt, welcher geladen, was sind seine Kinder, woran scheiterte das
// Laden. Bewusst OHNE `document` und ohne Backend-Aufruf -- nach dem Muster
// von `tile-assignment.ts`. Jede Ebene dieses Baums kostet eine SSH-Runde;
// die Entscheidung, ob eine noetig ist, faellt hier und muss deshalb ohne
// Fenster und ohne VM pruefbar sein.

export interface DirNode {
  path: string;
  /** Der letzte Pfadabschnitt. Die Wurzel hat keinen und traegt ihren Pfad. */
  name: string;
  depth: number;
  expanded: boolean;
  loaded: boolean;
  error: "notfound" | "notdir" | "denied" | "failed" | null;
  /** VOLLE Pfade -- nicht die blossen Namen, die `setChildren` entgegennimmt.
   * `nodes` ist nach Pfad geschluesselt, und `visible()` steigt ueber genau
   * dieses Feld in die Karte ab; die Namen ein zweites Mal zusammenzusetzen
   * hiesse, den Schluessel an zwei Stellen zu bilden. */
  children: string[];
}

/** Uebersetzt die rohe `Err(String)` von `list_directories` in eine Fehlerart.
 *
 * Durch diesen EINEN Rueckgabewert kommen ZWEI Kanaele: `remote::dirs::parse`
 * liefert die maschinenlesbaren Kuerzel `notfound`/`notdir`/`denied`, und
 * derselbe `Err` traegt daneben Prosa -- `"host not connected"`, beliebige
 * Transportfehler. Nur die drei Kuerzel sind ein bekannter Grund.
 *
 * Alles andere wird `"failed"`. Das ist KEIN vierter Grund, sondern das
 * Eingestaendnis, keinen zu kennen. Der Zweig darf nicht raten: ein
 * Vorgabezweig auf `"denied"` wuerde jeder kuenftigen Antwort "kein
 * Leserecht" unterstellen -- die harmloseste der Diagnosen und damit die
 * irrefuehrendste. Genau dieser Defekt wurde im Rust-Gegenstueck bereits
 * dreimal entfernt; er soll hier nicht spiegelverkehrt wieder entstehen.
 *
 * Verglichen wird auf Gleichheit, nicht auf Enthaltensein: `"Permission
 * denied (publickey)."` ist Prosa des Transports und traegt `denied` nur
 * zufaellig in sich. */
export function errorKind(raw: string): NonNullable<DirNode["error"]> {
  switch (raw) {
    case "notfound":
    case "notdir":
    case "denied":
      return raw;
    default:
      return "failed";
  }
}

export function joinPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** Die Kette von der Wurzel bis zum Pfad, beide eingeschlossen. Spec §5
 * klappt den Baum beim Oeffnen darauf auf -- ein Aufruf je Glied. */
export function ancestry(path: string): string[] {
  const chain = ["/"];
  let current = "/";
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    current = joinPath(current, segment);
    chain.push(current);
  }
  return chain;
}

function blankNode(path: string, depth: number): DirNode {
  const cut = path.lastIndexOf("/");
  const tail = cut < 0 ? path : path.slice(cut + 1);
  return {
    path,
    name: tail === "" ? path : tail,
    depth,
    expanded: false,
    loaded: false,
    error: null,
    children: [],
  };
}

export class DirTree {
  nodes: Map<string, DirNode> = new Map();
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.nodes.set(rootPath, blankNode(rootPath, 0));
  }

  /** Die sichtbare Reihenfolge, wie sie gezeichnet wird: rekursiv von der
   * Wurzel, und NUR in aufgeklappte Knoten hinein. Ein flacher Lauf ueber
   * alle geladenen Knoten der Karte wuerde Enkel zeigen, deren Elternteil
   * zugeklappt ist -- die Karte behaelt zugeklappte Ebenen absichtlich
   * (Spec §4.2, der Zwischenspeicher), sie sind nur nicht sichtbar. */
  visible(): DirNode[] {
    const out: DirNode[] = [];
    this.collect(this.rootPath, out);
    return out;
  }

  private collect(path: string, out: DirNode[]): void {
    const node = this.nodes.get(path);
    if (node === undefined) return;
    out.push(node);
    if (!node.expanded) return;
    for (const child of node.children) this.collect(child, out);
  }

  setChildren(path: string, names: string[]): void {
    const node = this.nodes.get(path);
    // Ein Pfad, den `nodes` noch nicht kennt, wird WORTLOS verworfen: Knoten
    // entstehen ausschliesslich als Kinder ihres Elternteils (weiter unten),
    // die Schnittstelle kennt kein Anlegen fuer sich.
    //
    // AUFLAGE AN DEN AUFRUFER: Spec §5 holt die Ahnenkette nebenlaeufig. Die
    // Aufrufe duerfen nebenlaeufig LAUFEN, ihre Ergebnisse muessen aber
    // WURZELABWAERTS angewandt werden. Trifft die Antwort fuer
    // `/home/u` vor der fuer `/home` ein und wird sofort angewandt, ist
    // sie verloren -- ohne Meldung, und der Baum oeffnet nicht auf dem
    // Feldwert. Niemand saehe, warum.
    if (node === undefined) return;
    node.loaded = true;
    // Ein geglueckter Versuch loescht den Hinweis des vorigen -- sonst stuende
    // "kein Leserecht" neben den Kindern, die gerade angekommen sind. Der
    // Fall ist erreichbar: Spec §4.2 laedt offene Ebenen beim Umlegen des
    // Versteckt-Schalters neu, und ein erneutes Aufklappen wiederholt den
    // Aufruf.
    node.error = null;
    node.children = names.map((name) => joinPath(path, name));
    for (const childPath of node.children) {
      // Bestehende Kindknoten bleiben stehen: beim Neuladen einer Ebene soll
      // ein bereits aufgeklapptes Kind aufgeklappt bleiben.
      if (!this.nodes.has(childPath)) {
        this.nodes.set(childPath, blankNode(childPath, node.depth + 1));
      }
    }
  }

  setError(path: string, error: NonNullable<DirNode["error"]>): void {
    const node = this.nodes.get(path);
    // Dieselbe stille Verwerfung wie bei `setChildren` -- und dieselbe
    // AUFLAGE AN DEN AUFRUFER. Sie stand hier bis zum Abschlussreview nicht,
    // obwohl der Fall erreichbar ist: scheitert in der Ahnenkette ein Glied,
    // das sein Elternteil gar nicht aufgelistet hat (weil der Filter es
    // ausnahm oder es fort ist), gibt es keinen Knoten, an dem der Hinweis
    // haengen koennte -- er verpufft, und keine Zeile sagt etwas. Wer hier
    // einen Fehler meldet, muss also vorher wissen, dass der Pfad in `nodes`
    // steht, sonst braucht er einen eigenen Kanal fuer die Meldung.
    if (node === undefined) return;
    // Auch hier durch `errorKind`, obwohl die Signatur bereits eng ist: die
    // Union existiert zur Laufzeit nicht. Eine rohe Zeichenkette aus dem
    // Backend, per Zusicherung durchgereicht, landete sonst ungeprueft im
    // Knoten und der Baum zeigte eine Rust-Meldung als Fehlerart an.
    node.error = errorKind(error);
    // Ein Knoten, den man nicht lesen darf, soll nicht aufgeklappt und leer
    // dastehen (Spec §6): zugeklappt mit Hinweis, der uebrige Baum bleibt
    // bedienbar. `loaded` bleibt unberuehrt -- ein gescheiterter Versuch
    // macht den Knoten nicht geladen, sonst waere er nie wieder anzufordern.
    node.expanded = false;
  }

  /** `true` = der Aufrufer muss die Ebene holen.
   *
   * Der Zwischenspeicher-Vertrag aus Spec §4.2 haengt allein an diesem
   * Rueckgabewert: einmal geholte Kinder bleiben, solange der Dialog offen
   * ist, also kostet Zuklappen und erneutes Aufklappen keinen Aufruf. Ein
   * faelschliches `true` waere eine SSH-Runde je Klick. */
  expand(path: string): boolean {
    const node = this.nodes.get(path);
    // Ein unbekannter Pfad meldet "kein Ladebedarf". Das ist FORMGLEICH mit
    // dem `_ => PermissionDenied`, das im Rust-Gegenstueck dreimal entfernt
    // wurde: ein nicht darstellbarer Zustand faellt still auf die
    // beruhigende Antwort. Es bleibt stehen, weil die Schnittstelle kein
    // Anlegen vorsieht und ein hier erfundener Knoten weder Tiefe noch
    // Elternteil kennte -- aber der Aufrufer muss wissen, dass `false` an
    // dieser Stelle ZWEI Dinge heissen kann: "schon geladen" und "diesen
    // Pfad gibt es im Baum gar nicht".
    if (node === undefined) return false;
    node.expanded = true;
    // `error` wird NICHT geloescht: bis die Antwort da ist, hat sich nichts
    // Neues ergeben. Jeder Schreibzugriff auf `error` entspricht einer
    // tatsaechlichen Nachricht vom Backend.
    return !node.loaded;
  }

  collapse(path: string): void {
    const node = this.nodes.get(path);
    if (node !== undefined) node.expanded = false;
  }

  /** Verwirft die geholte Ebene, sodass `expand()` wieder Ladebedarf meldet.
   *
   * Ohne das kennt `loaded` nur den Weg auf `true`, und der
   * Versteckt-Schalter reisst eine Luecke: Schalter AN, `/a` aufklappen,
   * `/a` zuklappen, Schalter AUS. Spec §4.2 laedt nur die OFFENEN Ebenen
   * neu, `/a` also nicht -- beim naechsten Aufklappen meldete `expand()`
   * `false`, es wuerde nichts geholt, und `.x` stuende wieder da, obwohl der
   * Schalter aus ist. Nach dem Buchstaben von §4.2 zulaessig, in der Wirkung
   * ein Bruch von Abnahmekriterium 3.
   *
   * Gehoert hierher und nicht in den Aufrufer: sonst muesste die Ansicht in
   * die oeffentliche `nodes`-Karte hineingreifen, um `loaded` zurueckzu-
   * setzen. `expanded` bleibt unberuehrt -- eine offene Ebene soll waehrend
   * des Nachladens offen bleiben. */
  invalidate(path: string): void {
    const node = this.nodes.get(path);
    if (node === undefined) return;
    node.loaded = false;
    node.children = [];
  }

  isLoaded(path: string): boolean {
    return this.nodes.get(path)?.loaded ?? false;
  }
}
