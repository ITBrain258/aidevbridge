// Gegenprobe fuer `src/keymap.ts`: reine Logik, kein Mock noetig -- jsdom
// liefert ein echtes `KeyboardEvent`. Spiegelt (und erweitert um TS-
// spezifische Faelle) die Rust-Tests in `src-tauri/src/keymap.rs`.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYMAP,
  PLAIN_CTRL_KEYS,
  eventBinding,
  fontSizeKeyChange,
  isAppChord,
  isPlainCtrlAppKey,
  isReservedForApp,
  matchAction,
  validate,
} from "./keymap";

function key(
  init: Partial<KeyboardEventInit> & { key: string },
  type: "keydown" | "keyup" = "keydown",
): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
}

describe("validate", () => {
  // UX-Spec §8.3, deckungsgleich mit `plain_ctrl_bindings_are_rejected` in
  // keymap.rs: Strg+Buchstabe gehoert dem Terminal (Strg+C ist ^C, Strg+V ein
  // Steuerzeichen fuer die Shell). Frei sind nur die vier Tasten der
  // Ausnahmeliste (Test darunter).
  it.each(["Ctrl+N", "Ctrl+A", "Ctrl+C", "Ctrl+V"])("lehnt %s ab: Strg ausserhalb der Ausnahmeliste", (binding) => {
    const problems = validate({ "session.next": binding });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain(binding);
    expect(problems[0]).toContain("would take a key away from the terminal");
  });

  // xterm.js 6 erzeugt fuer diese vier Tasten keine Terminaleingabe
  // (`Keyboard.ts`), also nimmt die App sie (Strg+, und die Schriftgroesse).
  it.each(["Ctrl+,", "Ctrl+=", "Ctrl+-", "Ctrl+0"])("akzeptiert %s: Strg ohne Umschalt auf einer Taste der Ausnahmeliste", (binding) => {
    expect(validate({ "settings.open": binding })).toEqual([]);
  });

  // Strg+Alt ist AltGr auf deutscher Tastatur (`Ctrl+Alt+0` liefe auf `}`), und
  // Alt+... bleibt dem Terminal (Meta-Praefix). Wie in keymap.rs.
  it.each([
    "Ctrl+Alt+0",
    "Ctrl+Alt+,",
    "Ctrl+Alt+=",
    "Ctrl+Alt+-",
    "Alt+,",
    "Alt+0",
    "Alt+-",
    "Shift+,",
    "Ctrl+Alt+Shift+0",
  ])("lehnt %s ab: die Ausnahme gilt nur fuer Strg allein", (binding) => {
    const problems = validate({ "settings.open": binding });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain(binding);
    expect(problems[0]).toContain("would take a key away from the terminal");
  });

  it("Strg++ ist nicht parsbar, wie in keymap.rs: der Plus traegt die Zerlegung", () => {
    const problems = validate({ "settings.open": "Ctrl++" });
    expect(problems).toEqual([
      "Ctrl++ is not a usable key combination (action settings.open); needs exactly one non-modifier key",
    ]);
  });

  it("die Tasten der Ausnahmeliste nehmen an der Duplikatpruefung teil", () => {
    expect(validate({ "settings.open": "Ctrl+,", other: "ctrl+," }).some((p) => p.includes("assigned twice"))).toBe(true);
    // Dieselbe Taste mit Umschalt ist eine andere Belegung.
    expect(validate({ "settings.open": "Ctrl+,", other: "Ctrl+Shift+," })).toEqual([]);
  });

  it("Tasten der Ausnahmeliste und Strg+Umschalt-Akkorde gelten zusammen", () => {
    expect(
      validate({ "settings.open": "Ctrl+,", quickOpen: "Ctrl+Shift+P", "session.next": "Ctrl+Shift+Down" }),
    ).toEqual([]);
  });

  it("lehnt eine reine Alt-Belegung ab", () => {
    const problems = validate({ "session.next": "Alt+F" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("Alt+F");
  });

  it("lehnt Ctrl+Alt+Shift ab -- die Grenze verlangt EXAKT Ctrl+Shift, nicht 'enthaelt beide'", () => {
    // Review-Befund (Task 12): die alte Pruefung fragte nur "enthaelt Ctrl
    // UND Shift" -- "Ctrl+Alt+Shift+F" enthaelt beides und wurde deshalb
    // faelschlich akzeptiert, obwohl ein zusaetzlicher Modifikator (Alt)
    // im Spiel ist.
    const problems = validate({ "session.next": "Ctrl+Alt+Shift+F" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("Ctrl+Alt+Shift+F");
  });

  it("akzeptiert eine Ctrl+Shift-Belegung", () => {
    expect(validate({ "session.next": "Ctrl+Shift+Down" })).toEqual([]);
  });

  it("meldet doppelt vergebene Belegungen (exakt gleicher String)", () => {
    const problems = validate({ a: "Ctrl+Shift+F", b: "Ctrl+Shift+F" });
    expect(problems.some((p) => p.includes("assigned twice"))).toBe(true);
  });

  it("erkennt ein Duplikat auch bei vertauschter Modifikator-Reihenfolge", () => {
    const problems = validate({ a: "Ctrl+Shift+F", b: "Shift+Ctrl+F" });
    expect(problems.some((p) => p.includes("assigned twice"))).toBe(true);
  });

  it("erkennt ein Duplikat auch bei abweichender Gross-/Kleinschreibung", () => {
    const problems = validate({ a: "Ctrl+Shift+F", b: "ctrl+shift+f" });
    expect(problems.some((p) => p.includes("assigned twice"))).toBe(true);
  });

  it("erkennt 'ArrowUp' (DOM-Schreibweise) als Duplikat von 'Up' (Spec-Schreibweise)", () => {
    // Review-Befund (Task 12): `eventBinding`/`normalizeKeyName` uebersetzen
    // ein echtes `KeyboardEvent` mit `event.key === "ArrowUp"` IMMER zu
    // `"Up"` -- ein Nutzer, der in `settings.toml` (Task 13) versehentlich
    // die DOM-Schreibweise "ArrowUp" statt "Up" eintraegt, wuerde ohne diesen
    // Alias zwei scheinbar verschiedene, tatsaechlich aber identische
    // Belegungen anlegen (nur eine davon je auszuloesen).
    const problems = validate({
      "session.prev": "Ctrl+Shift+Up",
      "session.next": "Ctrl+Shift+ArrowUp",
    });
    expect(problems.some((p) => p.includes("assigned twice"))).toBe(true);
  });

  it("lehnt eine reine Modifikator-Belegung ohne Taste ab", () => {
    const problems = validate({ "session.next": "Ctrl+Shift" });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("akzeptiert mehrere verschiedene Ctrl+Shift-Belegungen zusammen", () => {
    expect(
      validate({
        "clipboard.copy": "Ctrl+Shift+C",
        "clipboard.paste": "Ctrl+Shift+V",
        "search.local": "Ctrl+Shift+F",
      }),
    ).toEqual([]);
  });

  it("die Vorgabebelegung aus Spec §7.4 ist insgesamt gueltig", () => {
    expect(validate(DEFAULT_KEYMAP)).toEqual([]);
  });

  it("vergibt keine Belegung doppelt", () => {
    // Die Task-12-Aktionen
    // (tile.maximize/sidebar.toggle/sidebar.focus) duerfen mit KEINER
    // bestehenden Belegung kollidieren -- Designsystem §7.5 waehlte B/E/M
    // bewusst unter den freien Buchstaben. `Set` statt
    // paarweisem Vergleich: dieselbe Kollisionspruefung, die `validate`
    // selbst intern per `comparisonKey`/`seen` durchfuehrt, hier aber ohne
    // Normalisierung -- ein exakter String-Vergleich reicht, weil
    // `DEFAULT_KEYMAP`s eigene Werte bereits in kanonischer Schreibweise
    // stehen (kein "shift+ctrl+f" o. ae.).
    const werte = Object.values(DEFAULT_KEYMAP);
    expect(new Set(werte).size).toBe(werte.length);
  });
});

describe("isReservedForApp", () => {
  it("ist wahr fuer Ctrl+Shift, unabhaengig von Reihenfolge und Gross-/Kleinschreibung", () => {
    expect(isReservedForApp("Ctrl+Shift+Down")).toBe(true);
    expect(isReservedForApp("Shift+Ctrl+F")).toBe(true);
    expect(isReservedForApp("ctrl+shift+f")).toBe(true);
  });

  it("ist falsch fuer Strg ausserhalb der Ausnahmeliste und fuer jede Alt-Kombination", () => {
    expect(isReservedForApp("Ctrl+N")).toBe(false);
    expect(isReservedForApp("Ctrl+A")).toBe(false);
    expect(isReservedForApp("Ctrl+V")).toBe(false);
    expect(isReservedForApp("Alt+B")).toBe(false);
    expect(isReservedForApp("Ctrl+Alt+F")).toBe(false);
  });

  it("ist wahr fuer Strg ohne Umschalt auf , = - und 0 (UX-Spec §8.3)", () => {
    expect(isReservedForApp("Ctrl+,")).toBe(true);
    expect(isReservedForApp("Ctrl+=")).toBe(true);
    expect(isReservedForApp("Ctrl+-")).toBe(true);
    expect(isReservedForApp("Ctrl+0")).toBe(true);
  });

  // Die Liste ist bewusst eng; die Nachbarn (`Ctrl+1`, `Ctrl+.`, `Ctrl+9`,
  // `Ctrl+/` ...) brauchen jeweils einen eigenen Beleg. Wie
  // `the_plain_ctrl_exception_covers_exactly_four_keys` in keymap.rs.
  it("die Ausnahme umfasst genau vier Tasten", () => {
    expect(PLAIN_CTRL_KEYS).toEqual([",", "=", "-", "0"]);
    for (let code = "!".charCodeAt(0); code <= "~".charCodeAt(0); code++) {
      const key = String.fromCharCode(code);
      expect(isReservedForApp(`Ctrl+${key}`), `Ctrl+${key}`).toBe([",", "=", "-", "0"].includes(key));
    }
  });

  it("erkennt die Tasten der Ausnahmeliste unabhaengig von Schreibweise und Leerraum", () => {
    expect(isReservedForApp("ctrl+,")).toBe(true);
    expect(isReservedForApp("CTRL+0")).toBe(true);
    expect(isReservedForApp(" Ctrl + - ")).toBe(true);
  });

  it("ist falsch fuer Strg+Alt, Alt oder Umschalt mit einer Taste der Ausnahmeliste", () => {
    for (const binding of ["Ctrl+Alt+0", "Ctrl+Alt+,", "Alt+0", "Shift+,", "Ctrl+Alt+Shift+0", "Ctrl++"]) {
      expect(isReservedForApp(binding), binding).toBe(false);
    }
  });

  it("ist falsch fuer eine reine Modifikator-Belegung oder einen leeren String", () => {
    expect(isReservedForApp("Ctrl+Shift")).toBe(false);
    expect(isReservedForApp("")).toBe(false);
  });

  it("ist falsch fuer Ctrl+Alt+Shift -- ein dritter Modifikator macht den Akkord NICHT zum App-Akkord", () => {
    // Die Grenze verlangt EXAKT {ctrl, shift}, nicht "mindestens ctrl und
    // shift". Siehe Kommentar in `keymap.ts::isReservedForApp`.
    expect(isReservedForApp("Ctrl+Alt+Shift+F")).toBe(false);
  });

  it("ignoriert die genaue Tastenbenennung -- 'ArrowUp' zaehlt wie jede andere Nicht-Modifikator-Taste", () => {
    // WICHTIG, was dieser Test NICHT prueft: `isReservedForApp` inspiziert
    // nur `mods`, nie `key` -- diese Assertion waere auch ohne den
    // Alias-Fix (Befund 3) wahr (per Gegenprobe bestaetigt: Mutation der
    // Alias-Aufloesung in `canonicalize` liess genau DIESEN Test gruen).
    // Die tatsaechliche Absicherung fuer den Alias ist die
    // Duplikaterkennung unten (`validate` mit "Up" UND "ArrowUp"
    // gleichzeitig) -- dieser Test dokumentiert nur, dass "ArrowUp" als
    // Tastenname keine Sonderbehandlung in dieser Funktion ausloest.
    expect(isReservedForApp("Ctrl+Shift+ArrowUp")).toBe(true);
  });
});

describe("eventBinding", () => {
  it("wandelt ein Ctrl+Umschalt+N-KeyboardEvent in 'Ctrl+Shift+N'", () => {
    expect(eventBinding(key({ key: "n", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+N");
  });

  it("wandelt Pfeiltasten in 'Up'/'Down' (Spec-Schreibweise)", () => {
    expect(eventBinding(key({ key: "ArrowUp", ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+Up",
    );
    expect(eventBinding(key({ key: "ArrowDown", ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+Down",
    );
  });
});

describe("isAppChord: die Grenze, die der Terminal-KeyEventHandler durchsetzt", () => {
  it("ist falsch fuer die klassischen Terminal-Belegungen -- die gehen roh ans Terminal", () => {
    expect(isAppChord(key({ key: "c", ctrlKey: true }))).toBe(false); // Ctrl+C: Interrupt
    expect(isAppChord(key({ key: "v", ctrlKey: true }))).toBe(false); // Ctrl+V: im Terminal oft Paste
    expect(isAppChord(key({ key: "a", ctrlKey: true }))).toBe(false); // Ctrl+A: Zeilenanfang (readline)
    expect(isAppChord(key({ key: "b", altKey: true }))).toBe(false); // Alt+B: Wort zurueck (readline)
  });

  it("ist wahr fuer JEDEN Ctrl+Shift-Akkord, auch einen (noch) unbelegten", () => {
    expect(isAppChord(key({ key: "f", ctrlKey: true, shiftKey: true }))).toBe(true);
    // "Z" ist in DEFAULT_KEYMAP an keine Aktion gebunden -- trotzdem gehoert
    // der Akkord der App, nicht dem Terminal (siehe Kommentar in keymap.ts).
    expect(isAppChord(key({ key: "z", ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("ist falsch, wenn zusaetzlich Alt oder Meta gedrueckt ist -- die Grenze verlangt EXAKT Ctrl+Shift", () => {
    // Review-Befund (Task 12): die alte Fassung pruefte nur
    // `ctrlKey && shiftKey` -- ein physischer Ctrl+Alt+Shift+F-Tastendruck
    // (drei Tasten gleichzeitig, kein AltGr noetig) haette `true` geliefert,
    // `preventDefault()` haette gefeuert, `matchAction` haette aber `null`
    // geliefert ("Ctrl+Alt+Shift+F" ist an keine Aktion gebunden) -- das
    // Zeichen waere ersatzlos verschwunden (siehe terminal.test.ts fuer die
    // Ende-zu-Ende-Version ueber `attachCustomKeyEventHandler`).
    expect(isAppChord(key({ key: "f", ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isAppChord(key({ key: "f", ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false);
  });

  describe("AltGr (Windows): getModifierState('AltGraph')", () => {
    // Recherche: AltGr wird unter Windows vom
    // Tastaturtreiber seit jeher als Left-Ctrl+Right-Alt synthetisiert.
    // Chromium spiegelte das bis ~2018 unveraendert in ctrlKey/altKey; ein
    // Intent-to-Ship-Fix stellt seither auf die UI-Events-Spec-Empfehlung
    // um: ctrlKey/altKey werden fuer AltGr-erzeugte druckbare Zeichen
    // GELOESCHT, nur `getModifierState("AltGraph")` bleibt wahr. WebView2
    // ist Chromium-basiert, daher ist das ALTE Verhalten (Fall unten) auf
    // dem Zielsystem vermutlich nicht mehr beobachtbar -- aber nicht von
    // hier aus geprueft (kein echtes WebView2 verfuegbar).

    it("altes Chromium-Verhalten (<2018): ctrlKey=true, altKey=true, shiftKey=true, AltGraph=true -> kein App-Akkord", () => {
      const event = key({
        key: "†",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        // jsdom unterstuetzt `modifierAltGraph` in `KeyboardEventInit`
        // (Teil der Standard-`EventModifierInit`-Dictionary) und spiegelt es
        // korrekt in `getModifierState("AltGraph")` -- empirisch mit jsdom
        // 29.1.1 geprueft.
        modifierAltGraph: true,
      });
      expect(isAppChord(event)).toBe(false);
    });

    it("aktuelles Chromium-Verhalten: ctrlKey=false, altKey=false, shiftKey=true, AltGraph=true -> kein App-Akkord", () => {
      // Bereits durch die fehlende ctrlKey=true ausgeschlossen -- dieser
      // Test dokumentiert lediglich, dass das AKTUELLE, dokumentierte
      // Verhalten keine Regression ist, nicht dass die
      // AltGraph-Pruefung hier greifen MUSSTE.
      const event = key({
        key: "†",
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        modifierAltGraph: true,
      });
      expect(isAppChord(event)).toBe(false);
    });

    it("undokumentierter Grenzfall: ctrlKey=true, altKey=false, shiftKey=true, AltGraph=true -> kein App-Akkord", () => {
      // Weder das alte noch das aktuelle dokumentierte Chromium-Verhalten
      // erzeugt diese exakte Kombination -- kein
      // beobachteter Fall, nur ein zusaetzlicher Haertungs-Test fuer den
      // expliziten `getModifierState("AltGraph")`-Zweig in `isAppChord`:
      // OHNE ihn wuerde die reine Modifikator-Pruefung (ctrl && shift &&
      // !alt && !meta) diese Kombination faelschlich als App-Akkord
      // durchlassen, weil `altKey` hier bereits `false` ist.
      const event = key({
        key: "f",
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        modifierAltGraph: true,
      });
      expect(isAppChord(event)).toBe(false);
    });

    it("AltGr ohne Umschalt (kein Shift) -- war nie ein Kandidat fuer einen App-Akkord", () => {
      const event = key({
        key: "e",
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        modifierAltGraph: true,
      });
      expect(isAppChord(event)).toBe(false);
    });
  });
});

describe("matchAction", () => {
  it("findet die Aktion fuer einen konfigurierten Akkord", () => {
    expect(matchAction(key({ key: "f", ctrlKey: true, shiftKey: true }))).toBe("search.local");
    expect(matchAction(key({ key: "n", ctrlKey: true, shiftKey: true }))).toBe("session.new");
    expect(matchAction(key({ key: "ArrowDown", ctrlKey: true, shiftKey: true }))).toBe(
      "session.next",
    );
  });

  it("liefert null fuer einen Akkord ohne Bindung", () => {
    expect(matchAction(key({ key: "z", ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("findet session.nextWaiting auf Ctrl+Shift+A", () => {
    expect(matchAction(key({ key: "a", ctrlKey: true, shiftKey: true }))).toBe("session.nextWaiting");
  });

  it("findet die Task-12-Aktionen; Strg+Umschalt+G ist seit Spec 2026-10-19 §4.7 unbelegt", () => {
    expect(matchAction(key({ key: "m", ctrlKey: true, shiftKey: true }))).toBe("tile.maximize");
    expect(matchAction(key({ key: "g", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchAction(key({ key: "b", ctrlKey: true, shiftKey: true }))).toBe("sidebar.toggle");
    expect(matchAction(key({ key: "e", ctrlKey: true, shiftKey: true }))).toBe("sidebar.focus");
  });

  it("Strg+Umschalt+Bild auf/ab schieben die Kachel (Spec 2026-10-19 §5.4)", () => {
    expect(matchAction(key({ key: "PageUp", ctrlKey: true, shiftKey: true }))).toBe("tile.moveEarlier");
    expect(matchAction(key({ key: "PageDown", ctrlKey: true, shiftKey: true }))).toBe("tile.moveLater");
  });

  it("findet die vorhandenen, jetzt verdrahteten session.select.N-Akkorde", () => {
    expect(matchAction(key({ key: "3", ctrlKey: true, shiftKey: true }))).toBe("session.select.3");
    expect(matchAction(key({ key: "9", ctrlKey: true, shiftKey: true }))).toBe("session.select.9");
  });

  it.each([
    ["DE", "!\"§$%&/()"],
    ["US", "!@#$%^&*("],
  ])("waehlt Sessions 1..9 mit den echten Shift-Zeichen des %s-Layouts", (_layout, shifted) => {
    for (let index = 0; index < shifted.length; index++) {
      expect(matchAction(key({
        key: shifted[index],
        code: `Digit${index + 1}`,
        ctrlKey: true,
        shiftKey: true,
      }))).toBe(`session.select.${index + 1}`);
    }
  });

  it("laesst Shift-Zeichen ohne App-Akkord und AltGr dem Terminal", () => {
    const shifted = key({ key: "!", code: "Digit1", shiftKey: true });
    const altGr = key({
      key: "{", code: "Digit7", ctrlKey: true, altKey: true,
      shiftKey: true, modifierAltGraph: true,
    });
    expect(eventBinding(shifted)).toBe("Shift+!");
    expect(matchAction(shifted)).toBeNull();
    expect(isAppChord(shifted)).toBe(false);
    expect(matchAction(altGr)).toBeNull();
    expect(isAppChord(altGr)).toBe(false);
  });

  it("behaelt Buchstaben aus dem Layout bei und deutet Numpad-Navigation nicht als Sessionwahl", () => {
    expect(matchAction(key({
      key: "n", code: "KeyB", ctrlKey: true, shiftKey: true,
    }))).toBe("session.new");
    expect(matchAction(key({
      key: "End", code: "Numpad1", ctrlKey: true, shiftKey: true,
    }))).toBeNull();
  });

  it("liefert null fuer ein reines Terminal-Kuerzel", () => {
    expect(matchAction(key({ key: "c", ctrlKey: true }))).toBeNull();
  });

  // AltGr schliesst `isPlainCtrlAppKey` aus, bevor `matchAction` gefragt wird
  // (wie `isAppChord` bei den Strg+Umschalt-Akkorden).
  it("findet settings.open auf Strg+, (UX-Spec §8.3), nicht mit Umschalt oder Alt", () => {
    expect(DEFAULT_KEYMAP["settings.open"]).toBe("Ctrl+,");
    expect(matchAction(key({ key: ",", code: "Comma", ctrlKey: true }))).toBe("settings.open");
    expect(matchAction(key({ key: ",", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchAction(key({ key: ",", ctrlKey: true, altKey: true }))).toBeNull();
  });

  // UX-Spec §7.5, §8.3: Schnelloeffnen ist ein gewoehnlicher Strg+Umschalt-
  // Akkord und braucht keine Ausnahme -- Strg+P allein bleibt beim Terminal.
  it("findet quickOpen auf Strg+Umschalt+P, nicht auf Strg+P", () => {
    expect(DEFAULT_KEYMAP.quickOpen).toBe("Ctrl+Shift+P");
    expect(isReservedForApp(DEFAULT_KEYMAP.quickOpen)).toBe(true);
    expect(matchAction(key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe("quickOpen");
    expect(matchAction(key({ key: "p", code: "KeyP", ctrlKey: true }))).toBeNull();
  });

  it("die Schriftgroesse steht nicht in der Tabelle: Strg+= hat keine Aktion", () => {
    expect(matchAction(key({ key: "=", ctrlKey: true }))).toBeNull();
    expect(matchAction(key({ key: "0", code: "Digit0", ctrlKey: true }))).toBeNull();
  });

  it("liefert null, wenn eine benutzerdefinierte Belegungstabelle einen unbekannten Aktionsnamen traegt (Tippfehler)", () => {
    // Review-Befund (Task 12): `matchAction` erlaubt weiterhin eine
    // beliebige `Record<string, string>` (Task 13 laedt `settings.toml`
    // ohne feste Aktionsnamen-Menge) -- ein Tippfehler im Aktionsnamen
    // selbst ("sesion.new" statt "session.new") ist damit kein Typfehler,
    // sondern liefert zur Laufzeit `null`, statt eine unbekannte Zeichenkette
    // als gueltige `KeymapAction` auszugeben. Die eigentliche Absicherung
    // gegen Tippfehler ist der ENGERE Rueckgabetyp (`KeymapAction | null`
    // statt `string | null`): ein `case "sesion.new":` in `terminal.ts`s
    // `switch` waere damit ein Compile-Fehler (TS2678), nicht bloss ein
    // nie erreichter Zweig.
    expect(
      matchAction(key({ key: "n", ctrlKey: true, shiftKey: true }), {
        "sesion.new": "Ctrl+Shift+N",
      }),
    ).toBeNull();
  });
});

// UX-Spec §8.3: dieselbe Ausnahmeliste wie `isReservedForApp`, auf ein echtes
// Ereignis angewandt. Damit erkennen `keyboard.ts` und `terminal.ts` Strg+, als
// Taste der App; AltGr und Strg+Alt fallen heraus (Review Focus 1).
describe("isPlainCtrlAppKey", () => {
  it.each([",", "=", "-", "0"])("ist wahr fuer Strg+%s", (k) => {
    expect(isPlainCtrlAppKey(key({ key: k, ctrlKey: true }))).toBe(true);
  });

  it("ist falsch mit Umschalt, Alt, Meta oder AltGr", () => {
    expect(isPlainCtrlAppKey(key({ key: ",", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPlainCtrlAppKey(key({ key: "0", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPlainCtrlAppKey(key({ key: "0", ctrlKey: true, metaKey: true }))).toBe(false);
    expect(isPlainCtrlAppKey(key({ key: "0", ctrlKey: true, modifierAltGraph: true }))).toBe(false);
  });

  it("ist falsch fuer andere Tasten und ohne Strg", () => {
    expect(isPlainCtrlAppKey(key({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isPlainCtrlAppKey(key({ key: "+", ctrlKey: true }))).toBe(false);
    expect(isPlainCtrlAppKey(key({ key: "1", ctrlKey: true }))).toBe(false);
    expect(isPlainCtrlAppKey(key({ key: "," }))).toBe(false);
  });
});

// UX-Spec §6.7: die Tasten der Schriftgroesse stehen ausserhalb der Tabelle,
// weil sie Aliasse brauchen. Massgeblich ist `event.key`, damit US- und
// DE-Layout gehen; Umschalt zaehlt nicht (US: `+` ist Umschalt+=).
describe("fontSizeKeyChange", () => {
  it.each([
    ["Strg+=", { key: "=", code: "Equal", ctrlKey: true }, "larger"],
    ["Strg++ (DE)", { key: "+", code: "BracketRight", ctrlKey: true }, "larger"],
    ["Strg++ (US, mit Umschalt)", { key: "+", code: "Equal", ctrlKey: true, shiftKey: true }, "larger"],
    ["Strg+Num+", { key: "+", code: "NumpadAdd", ctrlKey: true }, "larger"],
    ["Strg+-", { key: "-", code: "Minus", ctrlKey: true }, "smaller"],
    ["Strg+Num-", { key: "-", code: "NumpadSubtract", ctrlKey: true }, "smaller"],
    ["Strg+0", { key: "0", code: "Digit0", ctrlKey: true }, "reset"],
    ["Strg+Num0", { key: "0", code: "Numpad0", ctrlKey: true }, "reset"],
  ] as const)("%s -> %s", (_name, init, change) => {
    expect(fontSizeKeyChange(key(init))).toBe(change);
  });

  // AltGr+0 ist auf deutscher Tastatur `}`, Strg+Alt ist dort AltGr.
  it.each([
    ["Strg+Alt+0", { key: "0", code: "Digit0", ctrlKey: true, altKey: true }],
    ["AltGr+0 (Strg+Alt mit AltGraph)", { key: "}", code: "Digit0", ctrlKey: true, altKey: true, modifierAltGraph: true }],
    ["Strg mit AltGraph", { key: "0", code: "Digit0", ctrlKey: true, modifierAltGraph: true }],
    ["Strg+Meta+0", { key: "0", code: "Digit0", ctrlKey: true, metaKey: true }],
    ["0 ohne Strg", { key: "0", code: "Digit0" }],
    ["= ohne Strg", { key: "=", code: "Equal" }],
    // Ohne NumLock meldet Num0 `Insert`: Strg+Einfg kopiert (Spec §6.1).
    ["Strg+Num0 ohne NumLock", { key: "Insert", code: "Numpad0", ctrlKey: true }],
    ["Strg+1", { key: "1", code: "Digit1", ctrlKey: true }],
  ] as const)("%s ist keine Taste der Schriftgroesse", (_name, init) => {
    expect(fontSizeKeyChange(key(init))).toBeNull();
  });
});
