import { describe, expect, it } from "vitest";
import { DirTree, ancestry, errorKind, joinPath } from "./dir-tree";

describe("joinPath", () => {
  it("verdoppelt den Schraegstrich an der Wurzel nicht", () => {
    expect(joinPath("/", "home")).toBe("/home");
    expect(joinPath("/home", "u")).toBe("/home/u");
  });
});

describe("ancestry", () => {
  it("liefert die Kette von der Wurzel bis zum Pfad", () => {
    expect(ancestry("/home/u/repo")).toEqual([
      "/", "/home", "/home/u", "/home/u/repo",
    ]);
  });

  it("liefert fuer die Wurzel nur die Wurzel", () => {
    expect(ancestry("/")).toEqual(["/"]);
  });
});

describe("DirTree", () => {
  it("zeigt anfangs nur die Wurzel", () => {
    const t = new DirTree("/");
    expect(t.visible().map((n) => n.path)).toEqual(["/"]);
  });

  it("expand meldet Ladebedarf nur beim ersten Mal", () => {
    const t = new DirTree("/");
    expect(t.expand("/")).toBe(true);
    t.setChildren("/", ["home", "tmp"]);
    t.collapse("/");
    // Der Kern des Zwischenspeichers (Spec §4.2): erneutes Aufklappen
    // darf KEINEN zweiten Aufruf ausloesen.
    expect(t.expand("/")).toBe(false);
  });

  it("zeigt Kinder erst nach dem Aufklappen und wieder nicht danach", () => {
    const t = new DirTree("/");
    t.expand("/");
    t.setChildren("/", ["home", "tmp"]);
    expect(t.visible().map((n) => n.name)).toEqual(["/", "home", "tmp"]);
    t.collapse("/");
    expect(t.visible().map((n) => n.name)).toEqual(["/"]);
  });

  it("haelt Enkel verborgen, solange das Kind zugeklappt ist", () => {
    const t = new DirTree("/");
    t.expand("/");
    t.setChildren("/", ["home"]);
    t.expand("/home");
    t.setChildren("/home", ["u"]);
    t.collapse("/");
    // Ohne diese Zusicherung wuerde ein Baum, der `visible()` flach ueber
    // alle geladenen Knoten baut, denselben Test bestehen.
    expect(t.visible().map((n) => n.path)).toEqual(["/"]);
  });

  it("merkt sich einen Fehler am Knoten und klappt ihn nicht auf", () => {
    const t = new DirTree("/");
    t.expand("/");
    t.setChildren("/", ["root"]);
    t.expand("/root");
    t.setError("/root", "denied");
    const node = t.nodes.get("/root")!;
    expect(node.error).toBe("denied");
    expect(node.expanded).toBe(false);
    // Der uebrige Baum bleibt bedienbar (Spec §6).
    expect(t.visible().map((n) => n.path)).toEqual(["/", "/root"]);
  });
});

// `errorKind` bekommt einen eigenen Block, denn die acht Tests darueber
// pruefen es nicht. Verbindlich ist ein Vorgabezweig auf "failed", und ein
// Zweig ohne Test ist eine Behauptung.
describe("errorKind", () => {
  it("reicht die drei bekannten Kuerzel durch", () => {
    expect(errorKind("notfound")).toBe("notfound");
    expect(errorKind("notdir")).toBe("notdir");
    expect(errorKind("denied")).toBe("denied");
  });

  it("behauptet bei Prosa aus dem anderen Kanal keinen Grund", () => {
    // Derselbe `Err(String)` traegt Kuerzel UND Prosa. Der letzte Fall ist
    // der gefaehrliche: er enthaelt "denied" als Teilzeichenkette und wuerde
    // einen Vergleich per `includes` ueberfuehren.
    expect(errorKind("host not connected")).toBe("failed");
    expect(errorKind("")).toBe("failed");
    expect(errorKind("Permission denied (publickey).")).toBe("failed");
  });
});

describe("DirTree und der Versteckt-Schalter", () => {
  it("meldet nach invalidate wieder Ladebedarf", () => {
    const t = new DirTree("/");
    t.expand("/");
    t.setChildren("/", ["a", ".x"]);
    // Der Zwischenspeicher greift -- das ist der Normalfall aus Spec §4.2.
    expect(t.expand("/")).toBe(false);
    // Spec §4.2 laedt beim Umlegen des Schalters nur die OFFENEN Ebenen neu.
    // Eine zugeklappte behielte ihre Eintraege aus dem alten Schalterstand
    // und zeigte `.x` wieder, obwohl der Schalter aus ist
    // (Abnahmekriterium 3). `invalidate` ist der Weg zurueck.
    t.invalidate("/");
    expect(t.isLoaded("/")).toBe(false);
    expect(t.nodes.get("/")!.children).toEqual([]);
    expect(t.expand("/")).toBe(true);
  });

  it("laesst eine offene Ebene beim Entwerten offen", () => {
    const t = new DirTree("/");
    t.expand("/");
    t.setChildren("/", ["a"]);
    t.invalidate("/");
    // Der Schalter entwertet JEDEN geladenen Knoten, auch die offenen. Klappte
    // `invalidate` sie dabei zu, fiele der Baum bei jedem Umschalten vor den
    // Augen des Nutzers zusammen.
    //
    // Direkt auf `expanded` geschaut, nicht ueber `visible()`: `invalidate`
    // leert `children`, also liefert `visible()` danach ohnehin nur die
    // Wurzel -- aufgeklappt wie zugeklappt. Ueber `visible()` liefe diese
    // Zusicherung bloss mit, ohne etwas zu behaupten.
    expect(t.nodes.get("/")!.expanded).toBe(true);
  });
});

describe("DirTree und der Fehlerkanal", () => {
  it("loescht den Hinweis, sobald der naechste Versuch gelingt", () => {
    const t = new DirTree("/");
    t.expand("/");
    t.setChildren("/", ["root"]);
    t.expand("/root");
    t.setError("/root", "denied");
    // Ein gescheiterter Versuch macht den Knoten nicht "geladen" -- sonst
    // koennte der Nutzer ihn nie erneut anfordern (Spec §6: der uebrige Baum
    // bleibt bedienbar, dieser Knoten also auch).
    expect(t.isLoaded("/root")).toBe(false);
    expect(t.expand("/root")).toBe(true);
    t.setChildren("/root", ["bin"]);
    // Sonst stuende "kein Leserecht" neben den Kindern, die gerade
    // angekommen sind.
    expect(t.nodes.get("/root")!.error).toBeNull();
  });
});
