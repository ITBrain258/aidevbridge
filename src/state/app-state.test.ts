import { describe, expect, it, vi } from "vitest";
import { AppState, sessionKey, type Host } from "./app-state";
import { MAX_TILES, MAX_TILES_PER_HOST } from "./tile-assignment";

function host(id: string, sessions: string[] = []): Host {
  return {
    id, runtimeId: `r-${id}`, label: id, hostname: "10.0.0.1", user: "u", port: 22, keyPath: null,
    authKind: "agent",
    state: "connected", error: null, expanded: true, lastCwd: "/tmp",
    sessions: sessions.map((name) => ({ name, hostId: id, open: false, inputLocked: false })),
  };
}

/** `n` Sessionnamen, `s1` bis `sn`: Zahlen, die aus den Grenzen folgen
 * (`MAX_TILES_PER_HOST`), statt sie hier noch einmal zu nennen. */
function sessionNames(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `s${i + 1}`);
}

/** Die Eintraege fuer `restoreTiles`: diese Sessions eines Hosts. */
function on(hostId: string, names: readonly string[]): Array<{ hostId: string; name: string }> {
  return names.map((name) => ({ hostId, name }));
}

describe("AppState", () => {
  it("qualifiziert Sessionschluessel mit dem Host", () => {
    expect(sessionKey("h1", "ab_x")).toBe("h1/ab_x");
    expect(sessionKey("h1", "ab_x")).not.toBe(sessionKey("h2", "ab_x"));
  });

  // Abschlussreview (Important 2): dieser Test war VAKUUM. Er setzte kein
  // Layout, die Vorgabe ist 1, also landeten `h1/a` und `h2/b` beide in
  // Kachel 0 und verdraengten einander -- `not.toContain("h1/a")` traf aus
  // dem falschen Grund zu (Verdraengung durch `assignTile`, nicht das
  // Aufraeumen in `removeHost`). Nachgewiesen per Mutation: das Loeschen der
  // drei Zeilen in `removeHost` liess alle 183 Tests gruen.
  //
  // Die Schleife ist nicht Hygiene, sondern tragend: `submitEdit`
  // (`main.ts`) ruft `state.removeHost` DIREKT, und nur sie loescht dabei
  // den veralteten `sessionKey`. Ohne sie greift in `grid.ts`s `reconcile()`
  // der `mountedKeys[i] === wantKey`-Kurzschluss, der `TerminalHandle` des
  // getrennten Hosts bleibt gemountet, und die Kachel zeigt ein
  // eingefrorenes Terminal unter einem leeren Kopf.
  it("raeumt beim Entfernen eines Hosts dessen Kacheln -- und laesst die der anderen stehen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.upsertHost(host("h2", ["b"]));
    s.openSession("h1", "a");
    s.openSession("h2", "b");
    expect(s.tiles.map((t) => t.sessionKey)).toEqual(["h1/a", "h2/b"]);

    s.removeHost("h1");

    expect(s.tiles.map((t) => t.sessionKey)).toEqual(["h2/b"]);
  });

  it("sperrt die Eingabe NUR in der Kachel des betroffenen Hosts", () => {
    const s = new AppState();
    // Bewusst gleichnamige Sessions auf zwei Hosts -- genau der Fall, in dem
    // ein nicht host-qualifizierter Vergleich falsch waere (Spec §11.1).
    s.upsertHost(host("h1", ["gleich"]));
    s.upsertHost(host("h2", ["gleich"]));
    s.openSession("h1", "gleich");
    s.openSession("h2", "gleich");
    // Bewusst h2 und nicht h1: `this.hosts` traegt Einfuegereihenfolge, und
    // bei h1 fielen "erster Treffer nach Name" und "der wirklich gemeinte
    // Host" zusammen -- eine Verwechslung der beiden waere unsichtbar. Mit
    // h2 muss die Aufloesung den Host tatsaechlich beachten.
    s.lockInput("h2", "gleich");
    const h1 = s.hosts.find((h) => h.id === "h1")!.sessions[0];
    const h2 = s.hosts.find((h) => h.id === "h2")!.sessions[0];
    expect(h2.inputLocked).toBe(true);
    expect(h1.inputLocked).toBe(false);
  });

  // B1: `lockInput` benachrichtigte bisher bedingungslos. Beide Aufrufer in
  // `main.ts` koennen mehrfach fuer dieselbe, bereits gesperrte Session
  // feuern (ein Transportabriss meldet jeden Kanal einzeln; ein erneutes
  // Oeffnen derselben toten Session scheitert erneut) -- jedes Mal ein
  // vollstaendiges Neuzeichnen fuer nichts.
  it("benachrichtigt bei lockInput nur, wenn die Sperre noch nicht steht", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const seen = vi.fn();
    s.subscribe(seen);

    s.lockInput("h1", "a");
    expect(seen).toHaveBeenCalledTimes(1);

    s.lockInput("h1", "a");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(s.hosts[0].sessions[0].inputLocked).toBe(true);
  });

  // B1: der EINE Abgleich, den `grid.ts::render` als allerletzte Anweisung
  // faehrt. Er steht IN einem Neuzeichnen -- eine Benachrichtigung ohne
  // tatsaechliche Aenderung waere deshalb keine Verschwendung, sondern eine
  // Endlosrekursion.
  it("gleicht Sperren in beide Richtungen ab und benachrichtigt nur bei Aenderung", () => {
    const s = new AppState();
    // Zwei Hosts mit GLEICHNAMIGEN Sessions: `sessionKey` existiert genau
    // dafuer (Spec §4.3). Bei ungleichen Namen fielen "erster Treffer nach
    // Name" und "die wirklich gemeinte Session" zusammen, eine Verwechslung
    // waere unsichtbar.
    s.upsertHost(host("h1", ["gleich"]));
    s.upsertHost(host("h2", ["gleich"]));
    s.lockInput("h1", "gleich");
    s.lockInput("h2", "gleich");

    const seen = vi.fn();
    s.subscribe(seen);

    s.applyInputLocks([], [sessionKey("h1", "gleich")]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(s.hosts[0].sessions[0].inputLocked).toBe(false);
    // Der andere Host hat seine eigene Verbindung und bleibt unberuehrt.
    expect(s.hosts[1].sessions[0].inputLocked).toBe(true);

    // Dieselbe Anforderung noch einmal aendert nichts -- also auch keine
    // Benachrichtigung.
    s.applyInputLocks([], [sessionKey("h1", "gleich")]);
    expect(seen).toHaveBeenCalledTimes(1);

    // Und die Gegenrichtung im selben Aufruf: h1 sperren, h2 loesen.
    s.applyInputLocks([sessionKey("h1", "gleich")], [sessionKey("h2", "gleich")]);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(s.hosts[0].sessions[0].inputLocked).toBe(true);
    expect(s.hosts[1].sessions[0].inputLocked).toBe(false);
  });

  it("setzt Hostzustand und Fehler, loescht einen alten Fehler ohne Angabe", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setHostState("h1", "failed", "timeout");
    expect(s.hosts[0].state).toBe("failed");
    expect(s.hosts[0].error).toBe("timeout");
    // Kein error-Argument -> alter Fehler darf einen Zustandswechsel weg von
    // "failed" nicht ueberleben, sonst zeigt die UI einen laengst
    // ungueltigen Fehler weiter an.
    s.setHostState("h1", "connecting");
    expect(s.hosts[0].state).toBe("connecting");
    expect(s.hosts[0].error).toBeNull();
  });

  // Der Code entscheidet, ob die Hinweisleiste nach einem Geheimnis fragt; ein
  // Anmeldecode darf deshalb keinen spaeteren Netzfehler ueberleben.
  it("haelt den Fehlercode neben dem Fehler und setzt ihn mit ihm zurueck", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setHostState("h1", "failed", "The key needs its passphrase.", "passphrase_required");
    expect(s.hosts[0].errorCode).toBe("passphrase_required");
    s.setHostState("h1", "connecting");
    expect(s.hosts[0].errorCode).toBeNull();
    s.setHostState("h1", "failed", "SSH connection timed out.");
    expect(s.hosts[0].error).toBe("SSH connection timed out.");
    expect(s.hosts[0].errorCode).toBeNull();
  });

  it("legt die Laufzeit-ID neben die settings.toml-ID, ohne sie anzutasten, und benachrichtigt", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const fn = vi.fn();
    s.subscribe(fn);

    s.setRuntimeId("h1", "h7");

    // Der Kern von Paket 2.5: `id` ist der Bezeichner, an dem saemtliche
    // Kachel- und Fokusschluessel haengen -- er darf sich nie aendern.
    expect(s.hosts[0].id).toBe("h1");
    expect(s.hosts[0].runtimeId).toBe("h7");
    // Ohne Benachrichtigung montierte `grid.ts::reconcile` die Kacheln der
    // neuen Verbindung erst beim naechsten beliebigen Ereignis neu.
    expect(fn).toHaveBeenCalledTimes(1);
    // Und die Sessionliste ueberlebt (der Grund fuer einen eigenen Mutator
    // statt `upsertHost`, das das ganze Host-Objekt ersetzt).
    expect(s.hosts[0].sessions.map((x) => x.name)).toEqual(["a"]);

    s.setRuntimeId("h1", null);
    expect(s.hosts[0].runtimeId).toBeNull();
    expect(s.hosts[0].id).toBe("h1");
  });

  it("hebt mit einer FRISCHEN Laufzeit-ID die Eingabesperren dieses Hosts auf", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.upsertHost(host("h2", ["c"]));
    s.lockInput("h1", "a");
    s.lockInput("h2", "c");
    // Vorbedingung: die Sperren stehen wirklich -- sonst pruefte der Test
    // unten ein Nichtstun.
    expect(s.hosts[0].sessions[0].inputLocked).toBe(true);

    s.setRuntimeId("h1", "h9");

    // Die Sperre gehoert zum Kanal, und der ist mit dem alten Transport
    // gestorben. `grid.ts::reconcile` montiert daraufhin ein frisches,
    // funktionierendes Terminal -- bliebe `inputLocked` stehen, behaupteten
    // Chip, Streifen und "Reconnect" darueber das Gegenteil.
    expect(s.hosts[0].sessions[0].inputLocked).toBe(false);
    // NUR dieser Host: ein anderer hat seine eigene Verbindung.
    expect(s.hosts[1].sessions[0].inputLocked).toBe(true);

    // Und derselbe Wert noch einmal ist keine neue Verbindung.
    s.lockInput("h1", "a");
    s.setRuntimeId("h1", "h9");
    expect(s.hosts[0].sessions[0].inputLocked).toBe(true);
  });

  it("gleicht Sessions ab: bestehende behalten ihre Flags, neue kommen frisch, verschwundene fallen raus", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.openSession("h1", "a");
    s.lockInput("h1", "a");
    s.setSessions("h1", ["a", "c"]); // b verschwindet, c ist neu, a bleibt bestehen
    const sessions = s.hosts[0].sessions;
    expect(sessions.map((x) => x.name)).toEqual(["a", "c"]);
    const a = sessions.find((x) => x.name === "a")!;
    expect(a.open).toBe(true);
    expect(a.inputLocked).toBe(true);
    const c = sessions.find((x) => x.name === "c")!;
    expect(c.open).toBe(false);
    expect(c.inputLocked).toBe(false);
  });

  it("schliesst eine Kachel: leert ihren Schluessel und markiert die Session als geschlossen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const opened = s.openSession("h1", "a");
    if (opened.kind !== "added") throw new Error("Vorbedingung");
    s.closeTile(opened.tileId);
    expect(s.tiles).toEqual([]);
    expect(s.hosts[0].sessions[0].open).toBe(false);
  });

  // Nachtrag C (Befund 3): `closeTile` loeschte nur `open`. `inputLocked`
  // blieb stehen, `setSessions` trug es durch jeden tmux-Poll weiter, und
  // `sidebar.ts::sessionIndicator` prueft `inputLocked` VOR `open` -- die
  // geschlossene Session zeigte dauerhaft Dreieck + "Input locked" statt des
  // hohlen Quadrats + "Closed" aus Designsystem §8.4.
  it("loescht beim Schliessen auch inputLocked -- eine geschlossene Session ist keine gesperrte", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const opened = s.openSession("h1", "a");
    if (opened.kind !== "added") throw new Error("Vorbedingung");
    s.lockInput("h1", "a");
    // Vorbedingung ausdruecklich geprueft: ohne sie pruefte die Zusicherung
    // unten nur, dass ein nie gesetztes Flag noch immer false ist.
    expect(s.hosts[0].sessions[0].inputLocked).toBe(true);

    s.closeTile(opened.tileId);

    expect(s.hosts[0].sessions[0].inputLocked).toBe(false);
    // Und der naechste Poll bringt sie nicht zurueck: `setSessions` traegt
    // bestehende Flags durch, sie muessen also schon hier richtig stehen.
    s.setSessions("h1", ["a"]);
    expect(s.hosts[0].sessions[0].inputLocked).toBe(false);
    expect(s.hosts[0].sessions[0].open).toBe(false);
  });

  // Nachtrag C (Befund 6): `removeHost` leerte die Kacheln des Hosts, liess
  // `maximizedTile`/`focusedTile` aber auf ihnen stehen -- `grid.ts`
  // behandelte bislang nur das sichtbare Symptom (Toolbar behauptet
  // "Maximized" neben der Leerzustandskarte).
  it("raeumt maximizedTile/focusedTile, wenn removeHost ausgerechnet deren Kachel leert", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const opened = s.openSession("h1", "a"); // openSession fokussiert die Kachel
    if (opened.kind !== "added") throw new Error("Vorbedingung");
    s.toggleMaximize(opened.tileId);
    expect(s.maximizedTile).toBe(opened.tileId);
    expect(s.focusedTile).toBe(opened.tileId);

    s.removeHost("h1");

    expect(s.maximizedTile).toBeNull();
    expect(s.focusedTile).toBeNull();
  });

  it("raeumt maximizedTile, wenn ausgerechnet die maximierte Kachel geschlossen wird", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const opened = s.openSession("h1", "a");
    if (opened.kind !== "added") throw new Error("Vorbedingung");
    s.toggleMaximize(opened.tileId);
    expect(s.maximizedTile).toBe(opened.tileId);
    s.closeTile(opened.tileId);
    expect(s.maximizedTile).toBeNull();
  });

  it("raeumt focusedTile, wenn ausgerechnet die fokussierte Kachel geschlossen wird", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const opened = s.openSession("h1", "a"); // openSession fokussiert die neue Kachel
    if (opened.kind !== "added") throw new Error("Vorbedingung");
    expect(s.focusedTile).toBe(opened.tileId);
    s.closeTile(opened.tileId);
    expect(s.focusedTile).toBeNull();
  });

  it("fokussiert eine Kachel und vergibt ihr den naechsten Zeitstempel", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    s.focusTile(s.tiles[0].id);
    expect(s.focusedTile).toBe(s.tiles[0].id);
    expect(s.tiles[0].lastFocusedAt).toBe(3);
  });

  it("maximiert eine Kachel und hebt es beim erneuten Aufruf wieder auf, ohne die Kachelzuordnung zu aendern", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    const vorher = s.tiles.map((t) => t.sessionKey);
    s.toggleMaximize(s.tiles[0].id);
    expect(s.maximizedTile).toBe(s.tiles[0].id);
    expect(s.tiles.map((t) => t.sessionKey)).toEqual(vorher);
    s.toggleMaximize(s.tiles[0].id);
    expect(s.maximizedTile).toBeNull();
    expect(s.tiles.map((t) => t.sessionKey)).toEqual(vorher);
  });

  it("benachrichtigt Abonnenten bei jeder Aenderung", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.openSession("h1", "a");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.focusTileAt(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("AppState: Kachelliste (Spec 2026-10-19 §4.1, §5.1, §5.5, §5.7)", () => {
  function keys(s: AppState): string[] {
    return s.tiles.map((tile) => tile.sessionKey);
  }

  function threeTiles(): { s: AppState; ids: number[] } {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c"]));
    for (const name of ["a", "b", "c"]) s.openSession("h1", name);
    return { s, ids: s.tiles.map((tile) => tile.id) };
  }

  it("fuegt jede neue Session als Kachel am Ende hinzu und fokussiert sie", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c"]));
    expect(s.openSession("h1", "a").kind).toBe("added");
    expect(s.openSession("h1", "b").kind).toBe("added");
    expect(keys(s)).toEqual(["h1/a", "h1/b"]);
    expect(s.focusedTile).toBe(s.tiles[1].id);
    expect(s.hosts[0].sessions.map((row) => row.open)).toEqual([true, true, false]);
  });

  it("fokussiert eine schon offene Session, statt eine zweite Kachel anzulegen", () => {
    const { s, ids } = threeTiles();
    expect(s.openSession("h1", "a")).toEqual({ kind: "focused", tileId: ids[0] });
    expect(keys(s)).toEqual(["h1/a", "h1/b", "h1/c"]);
    expect(s.focusedTile).toBe(ids[0]);
  });

  it("vergibt jede id nur einmal, auch nach dem Schliessen", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    const first = s.openSession("h1", "a");
    if (first.kind !== "added") throw new Error("Vorbedingung");
    s.closeTile(first.tileId);
    const second = s.openSession("h1", "b");
    expect(second.kind).toBe("added");
    expect(second.kind === "added" ? second.tileId : null).not.toBe(first.tileId);
  });

  it("meldet die Grenze je Host und aendert nichts (Spec §5.3)", () => {
    const s = new AppState();
    const fill = sessionNames(MAX_TILES_PER_HOST);
    s.upsertHost(host("h1", [...fill, "over"]));
    for (const name of fill) s.openSession("h1", name);
    const focused = s.focusedTile;
    expect(s.openSession("h1", "over")).toEqual({ kind: "limit", scope: "host", hostId: "h1" });
    expect(keys(s)).toEqual(fill.map((name) => `h1/${name}`));
    expect(s.focusedTile).toBe(focused);
    expect(s.hosts[0].sessions.find((row) => row.name === "over")?.open).toBe(false);
  });

  it("meldet die Gesamtgrenze bei neun Kacheln", () => {
    const s = new AppState();
    for (const id of ["h1", "h2", "h3"]) s.upsertHost(host(id, ["a", "b", "c", "d"]));
    for (const id of ["h1", "h2", "h3"]) for (const name of ["a", "b", "c"]) s.openSession(id, name);
    expect(s.tiles).toHaveLength(9);
    expect(s.openSession("h1", "d")).toEqual({ kind: "limit", scope: "total", hostId: "h1" });
  });

  it("schliesst eine Kachel: die folgenden ruecken auf, den Fokus bekommt die Kachel an ihrer Position, sonst die vorige (§5.5)", () => {
    const { s, ids } = threeTiles();
    const [a, b, c] = ids;
    s.focusTile(b);
    s.closeTile(b);
    expect(keys(s)).toEqual(["h1/a", "h1/c"]);
    expect(s.focusedTile).toBe(c);
    s.closeTile(c);
    expect(s.focusedTile).toBe(a);
    s.closeTile(a);
    expect(s.focusedTile).toBeNull();
  });

  it("schliesst eine nicht fokussierte Kachel, ohne den Fokus zu bewegen", () => {
    const { s, ids } = threeTiles();
    s.closeTile(ids[0]);
    expect(s.focusedTile).toBe(ids[2]);
  });

  it("Schliessen der maximierten Kachel beendet das Maximieren, die uebrigen sind wieder sichtbar (Review Focus 1)", () => {
    const { s, ids } = threeTiles();
    const [a, b, c] = ids;
    s.focusTile(b);
    s.toggleMaximize(b);
    expect(s.visibleTileIds()).toEqual([b]);
    s.closeTile(b);
    expect(s.maximizedTile).toBeNull();
    expect(s.visibleTileIds()).toEqual([a, c]);
    expect(s.focusedTile).toBe(c);
  });

  it("removeHost nimmt nur dessen Kacheln; kein Verweis zeigt danach auf eine geloeschte id (Review Focus 2)", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.upsertHost(host("h2", ["x"]));
    s.openSession("h1", "a");
    s.openSession("h2", "x");
    s.openSession("h1", "b");
    const [, x, b] = s.tiles.map((tile) => tile.id);
    s.toggleMaximize(b);
    s.removeHost("h1");
    expect(keys(s)).toEqual(["h2/x"]);
    expect(s.maximizedTile).toBeNull();
    expect(s.focusedTile).toBe(x);
    expect(s.lastFocusedOccupiedTile()).toBe(x);
  });

  it("eine verschwundene Session schliesst nur ihre Kachel (Review Focus 2)", () => {
    const { s, ids } = threeTiles();
    s.setSessions("h1", ["a", "c"]);
    expect(s.tiles.map((tile) => tile.id)).toEqual([ids[0], ids[2]]);
    expect(s.focusedTile).toBe(ids[2]);
  });

  it("Strg+Umschalt+1-9 fokussiert nach Position und beendet ein Maximieren einer anderen Kachel", () => {
    const { s, ids } = threeTiles();
    s.toggleMaximize(ids[1]);
    expect(s.focusTileAt(0)).toBe(true);
    expect(s.focusedTile).toBe(ids[0]);
    expect(s.maximizedTile).toBeNull();
    expect(s.focusTileAt(5)).toBe(false);
  });

  it("Strg+Umschalt+Hoch/Runter wechselt den Fokus der Reihe nach, mit Umlauf", () => {
    const { s, ids } = threeTiles();
    const [a, b, c] = ids;
    expect(s.focusedTile).toBe(c);
    s.focusAdjacentTile(1);
    expect(s.focusedTile).toBe(a);
    s.focusAdjacentTile(-1);
    expect(s.focusedTile).toBe(c);
    s.focusAdjacentTile(-1);
    expect(s.focusedTile).toBe(b);
    expect(new AppState().focusAdjacentTile(1)).toBe(false);
  });

  it("tauscht zwei Kacheln: ids, Fokus und Maximieren bleiben", () => {
    const { s, ids } = threeTiles();
    s.toggleMaximize(ids[2]);
    s.swapTiles(ids[0], ids[2]);
    expect(s.tiles.map((tile) => tile.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(s.focusedTile).toBe(ids[2]);
    expect(s.maximizedTile).toBe(ids[2]);
  });

  it("verschiebt eine Kachel um eine Position; am Rand geschieht nichts", () => {
    const { s, ids } = threeTiles();
    expect(s.moveTile(ids[2], -1)).toBe(1);
    expect(s.tiles.map((tile) => tile.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(s.moveTile(ids[0], -1)).toBeNull();
    expect(s.moveTile(ids[1], 1)).toBeNull();
  });

  it("eine Kachel an sich selbst oder eine unbekannte id zu tauschen aendert nichts und benachrichtigt nicht", () => {
    const { s, ids } = threeTiles();
    const notified = vi.fn();
    s.subscribe(notified);
    s.swapTiles(ids[0], ids[0]);
    s.swapTiles(ids[0], 999);
    s.swapTiles(999, ids[0]);
    expect(s.moveTile(999, 1)).toBeNull();
    expect(s.tiles.map((tile) => tile.id)).toEqual(ids);
    expect(notified).not.toHaveBeenCalled();
  });

  it("eine Randkachel zu verschieben benachrichtigt nicht, ein Tausch genau einmal", () => {
    const { s, ids } = threeTiles();
    const notified = vi.fn();
    s.subscribe(notified);
    s.moveTile(ids[0], -1);
    s.moveTile(ids[2], 1);
    expect(notified).not.toHaveBeenCalled();
    s.moveTile(ids[1], 1);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("eine Wahl beendet das Maximieren einer anderen Kachel: offene Session und neue Kachel (§5.1)", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c"]));
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    const [a, b] = s.tiles.map((tile) => tile.id);
    s.toggleMaximize(b);
    s.openSession("h1", "a");
    expect(s.maximizedTile).toBeNull();
    expect(s.focusedTile).toBe(a);
    s.toggleMaximize(a);
    s.openSession("h1", "c");
    expect(s.maximizedTile).toBeNull();
    expect(s.visibleTileIds()).toHaveLength(3);
  });

  it("die Session der maximierten Kachel zu waehlen, laesst sie maximiert", () => {
    const { s, ids } = threeTiles();
    s.toggleMaximize(ids[1]);
    s.openSession("h1", "b");
    expect(s.maximizedTile).toBe(ids[1]);
  });

  it("eine schon gezeigte, gesperrte Session bleibt gesperrt: es wird kein Kanal ersetzt", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    s.lockInput("h1", "a");
    s.openSession("h1", "a");
    expect(s.hosts[0].sessions[0].inputLocked).toBe(true);
  });

  it("restoreTiles legt die Kacheln an ihre Positionen, hoechstens ans Ende, ohne Fokus (§4.6)", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    const positions = new Map([["b", 5], ["a", 0]]);
    const asked: Array<{ name: string; id: number; before: string[] }> = [];
    s.restoreTiles(on("h1", ["b", "a"]), ({ name }, id) => {
      asked.push({ name, id, before: keys(s) });
      return positions.get(name)!;
    });
    expect(keys(s)).toEqual(["h1/a", "h1/b"]);
    // Gefragt wird unmittelbar vor dem Einfuegen, mit der `id` der neuen
    // Kachel und den schon eingefuegten in `tiles`.
    expect(asked.map(({ name, before }) => [name, before])).toEqual([["b", []], ["a", ["h1/b"]]]);
    expect(s.tiles.map((tile) => tile.id)).toEqual([asked[1].id, asked[0].id]);
    expect(s.focusedTile).toBeNull();
    expect(s.hosts[0].sessions.map((row) => row.open)).toEqual([true, true]);
  });

  it("restoreTiles benachrichtigt fuer alle Kacheln eines Hosts einmal, ohne neue Kachel gar nicht (Spec §4.5)", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c", "d"]));
    const notified = vi.fn();
    s.subscribe(notified);
    s.restoreTiles(on("h1", ["a", "b", "c", "d"]), () => Number.MAX_SAFE_INTEGER);
    expect(keys(s)).toEqual(["h1/a", "h1/b", "h1/c", "h1/d"]);
    expect(notified).toHaveBeenCalledTimes(1);
    s.restoreTiles(on("h1", ["a", "missing"]), () => 0);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("restoreTiles legt acht Kacheln eines Hosts und eine eines anderen an, keine entfaellt (Spec §8.1, Review Focus 1)", () => {
    const s = new AppState();
    const fill = sessionNames(MAX_TILES_PER_HOST);
    s.upsertHost(host("h1", fill));
    s.upsertHost(host("h2", ["x"]));
    const notified = vi.fn();
    s.subscribe(notified);
    s.restoreTiles([...on("h1", fill), ...on("h2", ["x"])], () => Number.MAX_SAFE_INTEGER);
    expect(keys(s)).toEqual([...fill.map((name) => `h1/${name}`), "h2/x"]);
    expect(s.tiles).toHaveLength(MAX_TILES);
    // Eine Benachrichtigung fuer beide Hosts: alle Kacheln montieren in einem
    // Zug mit ihrer Endgeometrie (Spec §4.5, §4.6).
    expect(notified).toHaveBeenCalledTimes(1);
    expect(s.focusedTile).toBeNull();
  });

  it("restoreTiles laesst eine fehlende und eine schon gezeigte Session aus und haelt die Grenzen auch innerhalb des Zugs", () => {
    const s = new AppState();
    const fill = sessionNames(MAX_TILES_PER_HOST);
    s.upsertHost(host("h1", [...fill, "over"]));
    s.openSession("h1", fill[0]);
    const focused = s.focusedTile;
    const place = vi.fn<(entry: { hostId: string; name: string }, id: number) => number>(() => Number.MAX_SAFE_INTEGER);
    s.restoreTiles(on("h1", ["missing", ...fill, "over"]), place);
    // fill[0] steht schon in einer Kachel; mit dem Rest von `fill` ist die
    // Grenze je Host erreicht, "over" entfaellt.
    expect(keys(s)).toEqual(fill.map((name) => `h1/${name}`));
    expect(place.mock.calls.map(([entry]) => entry.name)).toEqual(fill.slice(1));
    expect(s.focusedTile).toBe(focused);
  });
});

describe("AppState: Ersetzen (Spec 2026-10-19 §5.2, Review Focus 5)", () => {
  function twoHosts(): AppState {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b", "c", "d", "e"]));
    s.upsertHost(host("h2", ["x", "y"]));
    return s;
  }

  /** Fuer die Grenztests: h1 mit so vielen Sessions, wie ein Host Kacheln
   * haben darf (`fill`), und einer mehr ("over"); h2 mit Platz. Eigene
   * Vorrichtung, weil ein Test unten die fuenf Zeilen von `twoHosts` prueft. */
  function limitHosts(): { s: AppState; fill: string[] } {
    const s = new AppState();
    const fill = sessionNames(MAX_TILES_PER_HOST);
    s.upsertHost(host("h1", [...fill, "over"]));
    s.upsertHost(host("h2", ["x", "y"]));
    return { s, fill };
  }

  it("setzt die Session in die fokussierte Kachel; die alte ist danach nicht mehr offen", () => {
    const s = twoHosts();
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    const [, b] = s.tiles.map((tile) => tile.id);
    s.lockInput("h1", "b");
    expect(s.replaceFocusedTile("h1", "c")).toEqual({ kind: "replaced", tileId: b, previousKey: "h1/b" });
    expect(s.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/a", "h1/c"]);
    const rows = s.hosts[0].sessions;
    expect(rows.find((row) => row.name === "b")).toMatchObject({ open: false, inputLocked: false });
    expect(rows.find((row) => row.name === "c")?.open).toBe(true);
    expect(s.focusedTile).toBe(b);
  });

  it("ohne fokussierte Kachel fuegt es hinzu", () => {
    const s = twoHosts();
    expect(s.replaceFocusedTile("h1", "a").kind).toBe("added");
    expect(s.tiles).toHaveLength(1);
  });

  it("eine schon offene Session wird nur fokussiert", () => {
    const s = twoHosts();
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    const [a] = s.tiles.map((tile) => tile.id);
    expect(s.replaceFocusedTile("h1", "a")).toEqual({ kind: "focused", tileId: a });
    expect(s.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/a", "h1/b"]);
  });

  it("auf demselben Host ersetzt es auch an der Grenze", () => {
    const { s, fill } = limitHosts();
    for (const name of fill) s.openSession("h1", name);
    expect(s.openLimit("h1", "over")).toEqual({ kind: "limit", scope: "host", hostId: "h1" });
    expect(s.replaceFocusedTile("h1", "over").kind).toBe("replaced");
    expect(s.tiles.map((tile) => tile.sessionKey)).toEqual([...fill.slice(0, -1), "over"].map((name) => `h1/${name}`));
  });

  it("liegt die fokussierte Kachel auf einem anderen Host und ist die Grenze erreicht, aendert sich nichts", () => {
    const { s, fill } = limitHosts();
    for (const name of fill) s.openSession("h1", name);
    s.openSession("h2", "x");
    expect(s.replaceFocusedTile("h1", "over")).toEqual({ kind: "limit", scope: "host", hostId: "h1" });
    expect(s.tiles.map((tile) => tile.sessionKey)).toEqual([...fill.map((name) => `h1/${name}`), "h2/x"]);
  });

  it("die ersetzte Kachel behaelt Position und Maximieren", () => {
    const s = twoHosts();
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    const [, b] = s.tiles.map((tile) => tile.id);
    s.toggleMaximize(b);
    s.replaceFocusedTile("h2", "x");
    expect(s.tiles[1].id).toBe(b);
    expect(s.maximizedTile).toBe(b);
  });

  // Nach einem Schliessen ist die id nicht mehr Position + 1: wer die Kachel
  // ueber ihre Position statt ueber die id suchte, ersetzte die falsche.
  it("ersetzt die Kachel mit der fokussierten id an ihrer Position, auch wenn davor eine geschlossen wurde und dahinter eine steht", () => {
    const s = twoHosts();
    for (const name of ["a", "b", "c"]) s.openSession("h1", name);
    const [a, b, c] = s.tiles.map((tile) => tile.id);
    s.closeTile(a);
    s.focusTile(b);
    expect(s.tiles.map((tile) => tile.id)).toEqual([b, c]);
    expect(s.replaceFocusedTile("h1", "d")).toEqual({ kind: "replaced", tileId: b, previousKey: "h1/b" });
    expect(s.tiles.map((tile) => tile.id)).toEqual([b, c]);
    expect(s.tiles.map((tile) => tile.sessionKey)).toEqual(["h1/d", "h1/c"]);
    expect(s.focusedTile).toBe(b);
    const rows = s.hosts[0].sessions;
    expect(rows.map((row) => [row.name, row.open])).toEqual([
      ["a", false], ["b", false], ["c", true], ["d", true], ["e", false],
    ]);
  });

  it("auf einem anderen Host mit Platz ersetzt es: Ergebnis und Session der Kachel stimmen", () => {
    const s = twoHosts();
    s.openSession("h1", "a");
    s.openSession("h1", "b");
    const [a, b] = s.tiles.map((tile) => tile.id);
    expect(s.replaceFocusedTile("h2", "x")).toEqual({ kind: "replaced", tileId: b, previousKey: "h1/b" });
    expect(s.tiles.map((tile) => tile.id)).toEqual([a, b]);
    expect(s.tiles[1].sessionKey).toBe("h2/x");
    expect(s.tiles[0].sessionKey).toBe("h1/a");
    expect(s.hosts[0].sessions.find((row) => row.name === "b")?.open).toBe(false);
    expect(s.hosts[1].sessions.find((row) => row.name === "x")?.open).toBe(true);
    expect(s.lastFocusedOccupiedTile()).toBe(b);
  });

  it("openLimit nennt die Grenze, an der openSession scheitern wuerde, und aendert nichts (Spec §5.1 Nr. 3)", () => {
    const { s, fill } = limitHosts();
    for (const name of fill) s.openSession("h1", name);
    const focused = s.focusedTile;
    expect(s.openLimit("h1", "over")).toEqual({ kind: "limit", scope: "host", hostId: "h1" });
    // Offen: nur fokussieren; anderer Host: Platz frei.
    expect(s.openLimit("h1", fill[0])).toBeNull();
    expect(s.openLimit("h2", "x")).toBeNull();
    expect(s.tiles.map((tile) => tile.sessionKey)).toEqual(fill.map((name) => `h1/${name}`));
    expect(s.focusedTile).toBe(focused);
  });

  it("newSessionLimit nennt die Grenze, an der eine neue Session scheitern wuerde, und aendert nichts (Spec §5.1 Nr. 3)", () => {
    const { s, fill } = limitHosts();
    expect(s.newSessionLimit("h1")).toBeNull();
    for (const name of fill) s.openSession("h1", name);
    const notified = vi.fn();
    s.subscribe(notified);
    expect(s.newSessionLimit("h1")).toEqual({ kind: "limit", scope: "host", hostId: "h1" });
    expect(s.newSessionLimit("h2")).toBeNull();
    expect(s.tiles).toHaveLength(MAX_TILES_PER_HOST);
    expect(notified).not.toHaveBeenCalled();
  });
});

// UX-Spec §7.7: ein bearbeiteter Host bekommt seine gespeicherten Felder an
// Ort und Stelle -- anders als `upsertHost`, das den ganzen Host ersetzt.
describe("AppState: updateHostSettings (UX-Spec §7.7)", () => {
  it("uebernimmt die gespeicherten Felder im selben Objekt; Verbindung, Sessions, Kacheln und Aufklappen bleiben", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    const before = s.hosts[0];
    const listener = vi.fn();
    s.subscribe(listener);

    s.updateHostSettings("h1", {
      label: "Build VM", hostname: "10.0.0.9", user: "m", port: 2222,
      keyPath: "C:/keys/k", authKind: "key", tmuxSocket: "agentbridge", historyLimit: 10000,
    });

    expect(s.hosts[0]).toBe(before);
    expect(before).toMatchObject({
      label: "Build VM", hostname: "10.0.0.9", user: "m", port: 2222, keyPath: "C:/keys/k", authKind: "key",
      state: "connected", runtimeId: "r-h1", expanded: true,
    });
    expect(before.sessions.map((session) => session.name)).toEqual(["a"]);
    expect(s.tiles[0].sessionKey).toBe(sessionKey("h1", "a"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tut nichts fuer einen unbekannten Host", () => {
    const s = new AppState();
    const listener = vi.fn();
    s.subscribe(listener);
    s.updateHostSettings("nope", {
      label: "x", hostname: "x", user: "u", port: 22, keyPath: null, authKind: "agent",
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

// UX-Spec §7.9, Schritt 2 der Zielhost-Kette von Strg+Umschalt+N: "Host der
// zuletzt fokussierten belegten Kachel". Eine Merkstelle, keine Suche ueber alle
// Kacheln: schliesst diese Kachel, faellt die Kette auf den naechsten Schritt,
// nicht auf irgendeine andere belegte Kachel.
describe("AppState: zuletzt fokussierte belegte Kachel (UX-Spec §7.9)", () => {
  it("merkt sich die zuletzt fokussierte Kachel", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    expect(s.lastFocusedOccupiedTile()).toBeNull();

    s.openSession("h1", "a");
    s.openSession("h1", "b");
    expect(s.lastFocusedOccupiedTile()).toBe(s.tiles[1].id);

    s.focusTile(s.tiles[0].id);
    expect(s.lastFocusedOccupiedTile()).toBe(s.tiles[0].id);
  });

  it("schliesst die letzte Kachel, gilt keine mehr", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.openSession("h1", "a");
    s.openSession("h1", "b");

    for (const tile of [...s.tiles]) s.closeTile(tile.id);

    expect(s.lastFocusedOccupiedTile()).toBeNull();
  });

  it("verschwindet der Host, gilt die Merkstelle ebenfalls nicht mehr", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");

    s.removeHost("h1");

    expect(s.lastFocusedOccupiedTile()).toBeNull();
  });
});

describe("AppState und eine Session, die vom Host verschwindet", () => {
  it("schliesst die Kachel einer Session, die aus setSessions herausfaellt", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.openSession("h1", "a"); // Kachel 0
    s.openSession("h1", "b"); // Kachel 1
    // "a" wurde auf dem Host beendet; der naechste Poll meldet nur noch "b".
    s.setSessions("h1", ["b"]);
    // Bliebe der Schluessel stehen, waere die Kachel eine Sackgasse:
    // `resolveSession` liefert `null`, der Titel ist leer, und
    // `requestClose`/`requestReconnect` steigen beide vorher aus.
    expect(s.tiles.map((t) => t.sessionKey)).toEqual([sessionKey("h1", "b")]);
  });

  it("hebt eine Maximierung auf, wenn die maximierte Kachel die verschwundene Session trug", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a"]));
    s.openSession("h1", "a");
    s.toggleMaximize(s.tiles[0].id);
    expect(s.maximizedTile).toBe(s.tiles[0].id);
    s.setSessions("h1", []);
    // Sonst zeigt das Raster genau eine Kachel, und die ist leer -- dieselbe
    // Sackgasse ohne sichtbaren Rueckweg, die `closeTile` fuer den
    // Schliessen-Weg schon einmal geschlossen hat.
    expect(s.maximizedTile).toBeNull();
    expect(s.focusedTile).toBeNull();
  });

  it("laesst eine bleibende Session samt Flags und Kachel unberuehrt", () => {
    const s = new AppState();
    s.upsertHost(host("h1", ["a", "b"]));
    s.openSession("h1", "a");
    s.lockInput("h1", "a");
    s.setSessions("h1", ["a", "b"]);
    const a = s.hosts[0].sessions.find((x) => x.name === "a")!;
    // Die bestehende Zusicherung von `setSessions` (Kommentar Zeile 189-192:
    // "bestehende Sessions behalten ihre Flags") darf beim Aufraeumen nicht
    // verlorengehen -- ein Aufraeumen, das zu viel trifft, waere schlimmer
    // als keins.
    expect(a.open).toBe(true);
    expect(a.inputLocked).toBe(true);
    expect(s.tiles[0].sessionKey).toBe(sessionKey("h1", "a"));
  });
});


describe("AppState: session inventory observations", () => {
  it("distinguishes an unknown inventory from an accepted empty list", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    expect(state.sessionListForHost("a")).toEqual({ status: "never_loaded", lastSuccessAt: null, error: null });
    state.setSessionListError("a", { message: "Permission denied" });
    expect(state.sessionListForHost("a").status).toBe("never_loaded");
    state.setSessions("a", []);
    expect(state.sessionListForHost("a").status).toBe("current");
    expect(state.sessionListForHost("a").lastSuccessAt).toEqual(expect.any(Number));
    expect(state.sessionListForHost("a").error).toBeNull();
  });

  it("retains accepted names, tile ownership, and input locks on a later list failure", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setSessions("a", ["one", "two"]);
    state.openSession("a", "one");
    state.openSession("a", "two");
    state.lockInput("a", "one");
    const sessions = state.hosts[0].sessions;
    const tiles = state.tiles.map((tile) => tile.sessionKey);
    const lastSuccessAt = state.sessionListForHost("a").lastSuccessAt;
    state.setSessionListError("a", { code: "control_unavailable", message: "Control transport unavailable", controlGeneration: 4 });
    expect(state.sessionListForHost("a")).toEqual({ status: "stale", lastSuccessAt, error: { code: "control_unavailable", message: "Control transport unavailable", controlGeneration: 4 } });
    expect(state.hosts[0].sessions).toBe(sessions);
    expect(state.tiles.map((tile) => tile.sessionKey)).toEqual(tiles);
    expect(state.hosts[0].state).toBe("connected");
    state.setSessions("a", ["one", "two"]);
    expect(state.sessionListForHost("a").status).toBe("current");
    expect(state.sessionListForHost("a").error).toBeNull();
    expect(sessions[0].inputLocked).toBe(true);
    expect(sessions[1].inputLocked).toBe(false);
  });

  it("invalidates freshness on connection replacement and forgets removed host observations", () => {
    const state = new AppState();
    state.upsertHost(host("a"));
    state.setSessions("a", ["one"]);
    state.setRuntimeId("a", "new-runtime");
    expect(state.sessionListForHost("a").status).toBe("stale");
    expect(state.hosts[0].sessions.map((session) => session.name)).toEqual(["one"]);
    state.removeHost("a");
    state.upsertHost(host("a"));
    expect(state.sessionListForHost("a").status).toBe("never_loaded");
    expect(state.sessionListForHost("a").lastSuccessAt).toBeNull();
  });
});

describe("AppState.patchSessionStatus", () => {
  function bound(state: AppState, name: string, sessionId: number): void {
    const session = state.hosts[0].sessions.find((row) => row.name === name)!;
    session.sessionId = sessionId;
    session.serverPid = 50;
    session.serverStartTime = 1000;
    session.status = "unknown";
    session.statusReason = "no agent source is attached yet";
  }

  const server = { serverPid: 50, serverStartTime: 1000 };
  const replacement = { serverPid: 77, serverStartTime: 2000 };

  it("does not revive an ended session when a new tmux server reuses its id", () => {
    const state = new AppState();
    state.upsertHost(host("h1", ["a"]));
    state.setSessions("h1", ["a"]);
    bound(state, "a", 0);
    state.hosts[0].sessions[0].status = "ended";
    state.patchSessionStatus("h1", [
      { name: "foreign", sessionId: 0, ...replacement, status: "busy", statusReason: "agent is busy" },
    ]);
    expect(state.hosts[0].sessions[0].status).toBe("ended");
  });

  it("ends a session whose tmux server was replaced, even if the new server reuses its id", () => {
    const state = new AppState();
    state.upsertHost(host("h1", ["a"]));
    state.setSessions("h1", ["a"]);
    bound(state, "a", 0);
    state.hosts[0].sessions[0].status = "idle";
    state.patchSessionStatus("h1", [
      { name: "foreign", sessionId: 0, ...replacement, status: "busy", statusReason: "agent is busy" },
    ]);
    expect(state.hosts[0].sessions[0].status).toBe("ended");
  });

  it("leaves bound sessions untouched when the list carries no numeric ids", () => {
    const state = new AppState();
    state.upsertHost(host("h1", ["a"]));
    state.setSessions("h1", ["a"]);
    bound(state, "a", 1);
    state.hosts[0].sessions[0].status = "idle";
    state.hosts[0].sessions[0].statusReason = "agent is idle";
    state.patchSessionStatus("h1", [
      {
        name: "a",
        sessionId: null,
        serverPid: null,
        serverStartTime: null,
        status: "unknown",
        statusReason: "tmux version is not a measured 3.0/3.3a/3.4 inventory",
      },
    ]);
    expect(state.hosts[0].sessions[0]).toMatchObject({ status: "idle", statusReason: "agent is idle" });
  });

  it("updates status without adding, removing, or renaming sessions", () => {
    const state = new AppState();
    state.upsertHost(host("h1", ["a", "b"]));
    state.setSessions("h1", ["a", "b"]);
    bound(state, "a", 1);
    bound(state, "b", 2);
    state.patchSessionStatus("h1", [
      { name: "renamed", sessionId: 1, ...server, status: "busy", statusReason: "agent is busy" },
      { name: "b", sessionId: 2, ...server, status: "idle", statusReason: "agent is idle" },
      { name: "c", sessionId: 3, ...server, status: "waiting", statusReason: "permission prompt" },
    ]);
    expect(state.hosts[0].sessions.map((session) => session.name)).toEqual(["a", "b"]);
    expect(state.hosts[0].sessions[0]).toMatchObject({
      name: "a",
      sessionId: 1,
      status: "busy",
      statusReason: "agent is busy",
    });
    expect(state.hosts[0].sessions[1]).toMatchObject({
      name: "b",
      sessionId: 2,
      status: "idle",
      statusReason: "agent is idle",
    });
  });

  it("marks a missing bound id ended without closing its tile", () => {
    const state = new AppState();
    state.upsertHost(host("h1", ["a", "b"]));
    state.setSessions("h1", ["a", "b"]);
    bound(state, "a", 1);
    bound(state, "b", 2);
    state.openSession("h1", "b");
    state.patchSessionStatus("h1", [
      { name: "a", sessionId: 1, ...server, status: "unknown", statusReason: "no agent source is attached yet" },
    ]);
    expect(state.hosts[0].sessions.map((session) => session.name)).toEqual(["a", "b"]);
    expect(state.hosts[0].sessions[1]).toMatchObject({
      name: "b",
      sessionId: 2,
      open: true,
      status: "ended",
      statusReason: "bound session is absent from a complete inventory",
    });
    expect(state.tiles[0].sessionKey).toBe(sessionKey("h1", "b"));
  });

  it("does not invent ended for a name-only unverified session", () => {
    const state = new AppState();
    state.upsertHost(host("h1", ["a"]));
    state.setSessions("h1", ["a"]);
    state.hosts[0].sessions[0].sessionId = null;
    state.hosts[0].sessions[0].status = "unknown";
    state.patchSessionStatus("h1", []);
    expect(state.hosts[0].sessions[0].name).toBe("a");
    expect(state.hosts[0].sessions[0].sessionId).toBeNull();
    expect(state.hosts[0].sessions[0].status).toBe("unknown");
  });

  it("does not notify when status is unchanged", () => {
    const state = new AppState();
    state.upsertHost(host("h1", ["a"]));
    state.setSessions("h1", ["a"]);
    bound(state, "a", 1);
    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });
    state.patchSessionStatus("h1", [
      { name: "a", sessionId: 1, ...server, status: "unknown", statusReason: "no agent source is attached yet" },
    ]);
    expect(notified).toBe(0);
  });
});

describe("AppState.setSessionRecords", () => {
  it("applies ids and status before its single notification", () => {
    const state = new AppState();
    state.upsertHost(host("h1", []));
    const seen: Array<string | null | undefined> = [];
    state.subscribe(() => seen.push(state.hosts[0].sessions[0]?.status));
    state.setSessionRecords("h1", [
      {
        name: "a",
        sessionId: 3,
        serverPid: 50,
        serverStartTime: 1000,
        windowId: 0,
        paneId: 0,
        panePid: 10,
        status: "waiting",
        statusReason: "permission prompt",
      },
    ]);
    expect(seen).toEqual(["waiting"]);
    expect(state.hosts[0].sessions[0]).toMatchObject({
      name: "a",
      sessionId: 3,
      serverPid: 50,
      serverStartTime: 1000,
      panePid: 10,
      status: "waiting",
      statusReason: "permission prompt",
    });
  });
});

describe("AppState status freshness", () => {
  function observed(): AppState {
    const state = new AppState();
    state.upsertHost(host("h1", ["a"]));
    state.setHostState("h1", "connected");
    state.setSessionRecords("h1", [{ name: "a", status: "busy", statusReason: "agent is busy" }], 1000);
    return state;
  }

  it("a failed status query makes the status stale until the next observation", () => {
    const state = observed();
    expect(state.isStatusCurrent("h1")).toBe(true);
    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });
    state.markStatusStale("h1");
    state.markStatusStale("h1");
    expect(notified).toBe(1);
    expect(state.isStatusCurrent("h1")).toBe(false);
    expect(state.statusFreshnessForHost("h1")).toEqual({ stale: true, observedAt: 1000 });
    state.patchSessionStatus("h1", [], 2000);
    expect(notified).toBe(2);
    expect(state.statusFreshnessForHost("h1")).toEqual({ stale: false, observedAt: 2000 });
    expect(state.isStatusCurrent("h1")).toBe(true);
  });

  it("a broken control connection makes the status stale; recovery waits for an observation", () => {
    const state = observed();
    state.setControlState("h1", { generation: 1, state: "degraded", message: null });
    expect(state.isStatusCurrent("h1")).toBe(false);
    state.setControlState("h1", { generation: 1, state: "ready", message: null });
    expect(state.isStatusCurrent("h1")).toBe(false);
    state.patchSessionStatus("h1", [], 3000);
    expect(state.isStatusCurrent("h1")).toBe(true);
  });

  it("a new connection is stale until its first session list", () => {
    const state = observed();
    state.setRuntimeId("h1", "r-new");
    expect(state.isStatusCurrent("h1")).toBe(false);
    state.setSessionRecords("h1", [{ name: "a", status: "idle", statusReason: "agent is idle" }], 4000);
    expect(state.isStatusCurrent("h1")).toBe(true);
  });

  it("a host that is not connected has no current status", () => {
    const state = observed();
    state.setHostState("h1", "failed");
    expect(state.isStatusCurrent("h1")).toBe(false);
  });
});

describe("AppState: Status je Session veraltet (UX-Spec §5.2)", () => {
  const server = { serverPid: 50, serverStartTime: 1000 };

  /** Drei gebundene Sessions mit Status aus einer Liste um 1000. */
  function polled(): AppState {
    const state = new AppState();
    state.upsertHost(host("h1"));
    state.setSessionRecords("h1", [
      { name: "a", sessionId: 1, ...server, status: "waiting", statusReason: "permission prompt" },
      { name: "b", sessionId: 2, ...server, status: "busy", statusReason: "agent is busy" },
      { name: "c", sessionId: 3, ...server, status: "unknown", statusReason: "no agent source is attached yet" },
    ], 1000);
    return state;
  }

  function row(sessionId: number, status: string, statusReason = "") {
    return { name: "", sessionId, ...server, status, statusReason };
  }

  function session(state: AppState, name: string) {
    return state.hosts[0].sessions.find((candidate) => candidate.name === name)!;
  }

  it("keepStatusStale behaelt den Wert, markiert nur diese Session veraltet und merkt sich die Zeit der Beobachtung", () => {
    const state = polled();
    let notified = 0;
    state.subscribe(() => { notified += 1; });
    state.keepStatusStale("h1", ["a"]);
    expect(notified).toBe(1);
    expect(session(state, "a")).toMatchObject({ status: "waiting", statusReason: "permission prompt" });
    expect(state.isSessionStatusCurrent("h1", "a")).toBe(false);
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(1000);
    // Die Nachbarn desselben Hosts bleiben aktuell, ebenso der Host selbst.
    expect(state.isSessionStatusCurrent("h1", "b")).toBe(true);
    expect(state.isStatusCurrent("h1")).toBe(true);
  });

  it("keepStatusStale haelt nur Wartend, Beschaeftigt und Leerlauf fest und behaelt die erste Zeit", () => {
    const state = polled();
    state.keepStatusStale("h1", ["c", "missing"]);
    expect(state.isSessionStatusCurrent("h1", "c")).toBe(true);
    state.keepStatusStale("h1", ["a"]);
    // Die Abfrage selbst gelingt um 2000; a bleibt aus ausgefallener Quelle festgehalten.
    state.patchSessionStatus("h1", [row(1, "unknown"), row(2, "busy"), row(3, "unknown")], 2000, { keepUnknown: true });
    state.keepStatusStale("h1", ["a"]);
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(1000);
  });

  it("eine festgehaltene Session, die in der vollstaendigen Inventur fehlt, endet", () => {
    const state = polled();
    state.keepStatusStale("h1", ["b"]);
    state.patchSessionStatus("h1", [row(1, "waiting", "permission prompt"), row(3, "unknown")], 2000, { keepUnknown: true });
    expect(session(state, "b").status).toBe("ended");
    expect(state.isSessionStatusCurrent("h1", "b")).toBe(true);
  });

  it("eine unknown-Zeile aus ausgefallener Quelle ueberschreibt einen Live-Wert nicht und beendet ihn nicht", () => {
    const state = polled();
    state.patchSessionStatus("h1", [row(1, "unknown"), row(2, "unknown"), row(3, "unknown")], 2000, { keepUnknown: true });
    expect(session(state, "a")).toMatchObject({ status: "waiting", statusReason: "permission prompt" });
    expect(session(state, "b")).toMatchObject({ status: "busy", statusReason: "agent is busy" });
    expect(state.isSessionStatusCurrent("h1", "a")).toBe(false);
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(1000);
    // Die Abfrage selbst ist gelungen; nur die festgehaltenen Werte sind Geschichte.
    expect(state.isStatusCurrent("h1")).toBe(true);
    expect(state.isSessionStatusCurrent("h1", "c")).toBe(true);
    expect(state.sessionStatusObservedAt("h1", "c")).toBe(2000);
    // Eine weitere gestoerte Abfrage verschiebt die Zeit nicht.
    state.patchSessionStatus("h1", [row(1, "unknown"), row(2, "unknown"), row(3, "unknown")], 3000, { keepUnknown: true });
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(1000);
  });

  it("der naechste aktuelle Wert beendet die Veraltung, auch wenn er gleich bleibt", () => {
    const state = polled();
    state.patchSessionStatus("h1", [row(1, "unknown"), row(2, "unknown"), row(3, "unknown")], 2000, { keepUnknown: true });
    let notified = 0;
    state.subscribe(() => { notified += 1; });
    state.patchSessionStatus("h1", [row(1, "waiting", "permission prompt"), row(2, "busy", "agent is busy"), row(3, "unknown", "no agent source is attached yet")], 3000);
    expect(notified).toBe(1);
    expect(state.isSessionStatusCurrent("h1", "a")).toBe(true);
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(3000);
  });

  it("mit intakten Quellen gilt unknown als Beobachtung und ersetzt den alten Wert", () => {
    const state = polled();
    state.patchSessionStatus("h1", [row(1, "unknown"), row(2, "busy"), row(3, "unknown")], 2000, { keepUnknown: true });
    state.patchSessionStatus("h1", [row(1, "unknown", "no agent source is attached yet"), row(2, "busy"), row(3, "unknown")], 3000);
    expect(session(state, "a").status).toBe("unknown");
    expect(state.isSessionStatusCurrent("h1", "a")).toBe(true);
  });

  it("ein Live-Wert aus der intakten Quelle gilt trotz Ausfall der anderen", () => {
    const state = polled();
    state.patchSessionStatus("h1", [row(1, "idle", "agent is idle"), row(2, "unknown"), row(3, "unknown")], 2000, { keepUnknown: true });
    expect(session(state, "a").status).toBe("idle");
    expect(state.isSessionStatusCurrent("h1", "a")).toBe(true);
    expect(state.isSessionStatusCurrent("h1", "b")).toBe(false);
  });

  /** a ist seit 1000 festgehalten, der Host selbst zuletzt um 2000 beobachtet. */
  function keptSince1000(): AppState {
    const state = polled();
    state.patchSessionStatus("h1", [row(1, "unknown"), row(2, "busy"), row(3, "unknown")], 2000, { keepUnknown: true });
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(1000);
    return state;
  }

  it("eine neue Liste beendet die Veraltung", () => {
    const state = keptSince1000();
    state.setSessionRecords("h1", [
      { name: "a", status: "waiting", statusReason: "permission prompt" },
      { name: "b" },
      { name: "c" },
    ], 3000);
    expect(state.isSessionStatusCurrent("h1", "a")).toBe(true);
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(3000);
  });

  it("eine neue Verbindung vergisst die festgehaltenen Werte", () => {
    const state = keptSince1000();
    state.setRuntimeId("h1", "r-new");
    // Der Host ist bis zur ersten Liste veraltet; seine Zeit gilt jetzt fuer alle.
    expect(state.isSessionStatusCurrent("h1", "a")).toBe(false);
    expect(state.sessionStatusObservedAt("h1", "a")).toBe(2000);
  });

  it("das Entfernen vergisst die festgehaltenen Werte", () => {
    const state = keptSince1000();
    state.removeHost("h1");
    state.upsertHost(host("h1", ["a"]));
    expect(state.sessionStatusObservedAt("h1", "a")).toBeNull();
  });

  it("ein veralteter Host macht auch seine Sessions veraltet", () => {
    const state = polled();
    state.markStatusStale("h1");
    expect(state.isSessionStatusCurrent("h1", "b")).toBe(false);
    expect(state.sessionStatusObservedAt("h1", "b")).toBe(1000);
  });
});

describe("AppState: Sessionliste und Steuerzustand (UX-Spec §5.2)", () => {
  it("veraltet die Liste nur bei degraded, reconnecting und authentication_required", () => {
    const state = new AppState();
    state.upsertHost(host("h1"));
    state.setSessions("h1", ["a"]);
    state.setControlState("h1", { generation: 1, state: "ready", message: null });
    expect(state.sessionListForHost("h1").status).toBe("current");
    for (const control of ["degraded", "reconnecting", "authentication_required"] as const) {
      state.setSessions("h1", ["a"]);
      state.setControlState("h1", { generation: 1, state: control, message: null });
      expect(state.sessionListForHost("h1").status, control).toBe("stale");
    }
  });
});

describe("AppState: Selbstreparatur der Steuerung (UX-Spec §5.3)", () => {
  it("fuehrt die laufende Reihe je Host und benachrichtigt bei jedem Wechsel", () => {
    const state = new AppState();
    state.upsertHost(host("h1"));
    state.upsertHost(host("h2"));
    let notified = 0;
    state.subscribe(() => { notified += 1; });
    expect(state.isControlSelfRepairing("h1")).toBe(false);
    state.setControlSelfRepairing("h1", true);
    state.setControlSelfRepairing("h1", true);
    expect(notified).toBe(1);
    expect(state.isControlSelfRepairing("h1")).toBe(true);
    expect(state.isControlSelfRepairing("h2")).toBe(false);
    state.setControlSelfRepairing("h1", false);
    expect(notified).toBe(2);
    expect(state.isControlSelfRepairing("h1")).toBe(false);
  });

  it.each(["runtime", "failed", "remove"] as const)("vergisst die Reihe bei %s", (change) => {
    const state = new AppState();
    state.upsertHost(host("h1"));
    state.setControlSelfRepairing("h1", true);
    if (change === "runtime") state.setRuntimeId("h1", "r-other");
    else if (change === "failed") state.setHostState("h1", "failed", "lost");
    else state.removeHost("h1");
    expect(state.isControlSelfRepairing("h1")).toBe(false);
  });

  it("nimmt keine Reihe fuer einen unbekannten Host an", () => {
    const state = new AppState();
    state.setControlSelfRepairing("ghost", true);
    expect(state.isControlSelfRepairing("ghost")).toBe(false);
  });
});

describe("AppState: Neuverbinden eines Hosts (UX-Spec §5.4)", () => {
  function lostHost(id: string): Host {
    return { ...host(id), state: "failed", error: "The terminal connection was lost." };
  }

  it("fuehrt die laufende Reihe je Host und benachrichtigt nur bei einem Wechsel", () => {
    const state = new AppState();
    state.upsertHost(lostHost("h1"));
    state.upsertHost(lostHost("h2"));
    let notified = 0;
    state.subscribe(() => { notified += 1; });
    expect(state.isHostReconnecting("h1")).toBe(false);
    state.setHostReconnecting("h1", true);
    state.setHostReconnecting("h1", true);
    expect(notified).toBe(1);
    expect(state.isHostReconnecting("h1")).toBe(true);
    expect(state.isHostReconnecting("h2")).toBe(false);
    state.setHostReconnecting("h1", false);
    state.setHostReconnecting("h1", false);
    expect(notified).toBe(2);
    expect(state.isHostReconnecting("h1")).toBe(false);
  });

  it("uebersteht die Zwischenzustaende eines Versuchs", () => {
    const state = new AppState();
    state.upsertHost(lostHost("h1"));
    state.setHostReconnecting("h1", true);
    // Ein Versuch geht ueber "connecting" und, scheitert er, zurueck auf "failed".
    state.setHostState("h1", "connecting");
    state.setHostState("h1", "failed", "unreachable");
    expect(state.isHostReconnecting("h1")).toBe(true);
  });

  it.each(["connected", "remove"] as const)("vergisst die Reihe bei %s", (change) => {
    const state = new AppState();
    state.upsertHost(lostHost("h1"));
    state.setHostReconnecting("h1", true);
    if (change === "connected") state.setHostState("h1", "connected");
    else state.removeHost("h1");
    expect(state.isHostReconnecting("h1")).toBe(false);
  });

  it("nimmt keine Reihe fuer einen unbekannten oder verbundenen Host an", () => {
    const state = new AppState();
    state.upsertHost(host("live"));
    state.setHostReconnecting("ghost", true);
    state.setHostReconnecting("live", true);
    expect(state.isHostReconnecting("ghost")).toBe(false);
    expect(state.isHostReconnecting("live")).toBe(false);
  });
});

describe("AppState: Arbeitsplatz (UX-Spec §7.1, §7.2)", () => {
  it("klappt einen Host auf und zu und benachrichtigt nur bei einer Aenderung", () => {
    const s = new AppState();
    s.upsertHost({ ...host("h1"), expanded: false });
    const fn = vi.fn();
    s.subscribe(fn);

    s.setHostExpanded("h1", true);
    expect(s.hosts[0].expanded).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);

    s.setHostExpanded("h1", true);
    s.setHostExpanded("ghost", true);
    expect(fn).toHaveBeenCalledTimes(1);

    s.setHostExpanded("h1", false);
    expect(s.hosts[0].expanded).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("AppState: Sessions des Standard-Sockets (Spec 2026-10-25 §5, §6.3, §7)", () => {
  const binding = { sessionId: 1, serverPid: 10, serverStartTime: 20, windowId: 1, paneId: 1, panePid: 100 };
  const bound = (name: string, sessionId: number) => ({
    name,
    sessionId,
    serverPid: 10,
    serverStartTime: 20,
    status: "idle",
    statusReason: null,
  });

  it("trennt gleichnamige Sessions beider Sockets im Schluessel", () => {
    expect(sessionKey("h1", "main", "default")).toBe("h1/default:main");
    expect(sessionKey("h1", "main", "default")).not.toBe(sessionKey("h1", "main"));
    expect(sessionKey("h1", "main", "app")).toBe(sessionKey("h1", "main"));
  });

  it("ersetzt mit der Liste eines Sockets nur dessen Sessions und schliesst nur dessen Kacheln", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setSessionRecords("h1", [{ name: "main" }], 1);
    s.setSessionRecords("h1", [{ name: "main" }, { name: "other" }], 1, "default");
    expect(s.hosts[0].sessions.map((x) => [x.name, x.socket ?? "app"])).toEqual([
      ["main", "app"],
      ["main", "default"],
      ["other", "default"],
    ]);
    s.openSession("h1", "main");
    s.openSession("h1", "main", "default");
    expect(s.tiles.map((t) => t.sessionKey)).toEqual(["h1/main", "h1/default:main"]);

    s.setSessionRecords("h1", [{ name: "other" }], 2, "default");
    expect(s.tiles.map((t) => t.sessionKey)).toEqual(["h1/main"]);
    expect(s.hosts[0].sessions.map((x) => [x.name, x.socket ?? "app"])).toEqual([
      ["main", "app"],
      ["other", "default"],
    ]);
    s.setSessionRecords("h1", [], 3);
    expect(s.tiles).toEqual([]);
    expect(s.hosts[0].sessions.map((x) => x.name)).toEqual(["other"]);
  });

  it("fuehrt Listenzustand und Frische je Socket", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setSessionRecords("h1", [{ name: "main" }], 1);
    s.setSessionListError("h1", { message: "default failed" }, "default");
    expect(s.sessionListForHost("h1").status).toBe("current");
    expect(s.sessionListForHost("h1", "default").error?.message).toBe("default failed");

    s.markStatusStale("h1", "default");
    expect(s.isStatusCurrent("h1")).toBe(true);
    expect(s.isStatusCurrent("h1", "default")).toBe(false);

    s.setControlState("h1", { generation: 1, state: "degraded", message: null });
    expect(s.isStatusCurrent("h1")).toBe(false);
    expect(s.sessionListForHost("h1").status).toBe("stale");
  });

  it("laesst eine Abfrage des Standard-Sockets keine eigene Session beenden", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setSessionRecords("h1", [bound("main", 1)], 1);
    s.setSessionRecords("h1", [bound("main", 1)], 1, "default");
    // Eine vollstaendige Abfrage des Standard-Sockets ohne Session 1 beendet
    // nur dessen "main".
    s.patchSessionStatus("h1", [], 2, { socket: "default" });
    const [own, foreign] = s.hosts[0].sessions;
    expect(own.status).toBe("idle");
    expect(foreign.status).toBe("ended");
    s.patchSessionStatus("h1", [{ ...bound("", 1), status: "waiting" }], 3);
    expect(own.status).toBe("waiting");
    expect(foreign.status).toBe("ended");
  });

  it("sperrt und stellt Kacheln her je Socket", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setSessionRecords("h1", [{ name: "main" }], 1);
    s.setSessionRecords("h1", [{ name: "main", ...binding }], 1, "default");
    s.restoreTiles([{ hostId: "h1", name: "main", socket: "default" as const }], () => 0);
    expect(s.tiles.map((t) => t.sessionKey)).toEqual(["h1/default:main"]);
    s.lockInput("h1", "main", "default");
    const [own, foreign] = s.hosts[0].sessions;
    expect([own.inputLocked, foreign.inputLocked]).toEqual([false, true]);
    expect([own.open, foreign.open]).toEqual([false, true]);
  });
});

describe("AppState: ungebundene Sessions und der Schalter (Review von PR #5)", () => {
  it("stellt eine fremde Kachel ohne Bindung nicht her", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setSessionRecords("h1", [{ name: "grouped", sessionId: 3 }], 1, "default");
    s.restoreTiles([{ hostId: "h1", name: "grouped", socket: "default" as const }], () => 0);
    expect(s.tiles).toEqual([]);
  });

  it("nimmt mit dem Schalter aus die Sessions des Standard-Sockets weg, ohne seine Liste als geladen zu zaehlen", () => {
    const s = new AppState();
    s.upsertHost(host("h1"));
    s.setSessionRecords("h1", [{ name: "own" }], 1);
    s.setSessionRecords(
      "h1",
      [{ name: "main", sessionId: 1, serverPid: 2, serverStartTime: 3, windowId: 4, paneId: 5, panePid: 6 }],
      1,
      "default",
    );
    s.openSession("h1", "main", "default");
    const notified = vi.fn();
    s.subscribe(notified);
    s.clearSocket("h1", "default");
    expect(s.hosts[0].sessions.map((x) => x.name)).toEqual(["own"]);
    expect(s.tiles).toEqual([]);
    expect(s.sessionListForHost("h1", "default").status).toBe("never_loaded");
    expect(s.sessionListForHost("h1").status).toBe("current");
    notified.mockClear();
    s.clearSocket("h1", "default");
    expect(notified).not.toHaveBeenCalled();
  });
});
