// Gegenprobe fuer `host-key-prompt.ts` (TOFU-Nachtrag, Task 13, plus
// Review-Nachtrag): belegt, dass die Rueckfrage NUR den Fingerabdruck zeigt
// (nie den rohen Base64-Schluessel -- Eigenschaft 3), dass `respond_host_key`
// NIEMALS von selbst aufgerufen wird (Eigenschaft 5: kein automatisches
// Annehmen), dass ein Fehlschlag beim Antworten sichtbar bleibt (Review-
// Befund 1a) und dass eine abgelaufene Rueckfrage sich selbst schliesst
// (Review-Befund 1b) -- still, denn den einen Satz dazu zeigt der
// Verbindungsfehler (UX-Spec §10) --, inklusive der verschaerfenden
// Situation zweier gleichzeitiger Rueckfragen.

// `node:fs`/`node:path`/`process` sind Node-Globals ohne Typdeklaration in
// diesem browserorientierten Projekt (kein `@types/node` installiert, kein
// `"node"`-Lib in `tsconfig.json`) -- dasselbe Muster wie in
// `terminal.test.ts` (dort zuerst eingefuehrt, siehe dessen Kommentar).
// @ts-expect-error 'node:fs' ist ein Node-Global, siehe Kommentar oben
import { readFileSync } from "node:fs";
// @ts-expect-error 'node:path' ist ein Node-Global, siehe Kommentar oben
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mountHostKeyPrompt, type HostKeyPromptHandle } from "./host-key-prompt";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

interface Payload {
  request_id: number;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  expires_at_unix_ms: number;
  known_key_types: string[];
}

interface PersistFailurePayload {
  host: string;
  port: number;
  message: string;
}

const activeHandles: HostKeyPromptHandle[] = [];
function mount(root: HTMLElement): HostKeyPromptHandle {
  const handle = mountHostKeyPrompt(root);
  activeHandles.push(handle);
  return handle;
}

function samplePayload(overrides: Partial<Payload> = {}): Payload {
  return {
    request_id: 1,
    host: "192.0.2.10",
    port: 22,
    key_type: "ssh-ed25519",
    fingerprint: "SHA256:cd4xJCbJywoyJ+atpjT31411tIy9KUZajEpme8VfVOc",
    // Standardmaessig komfortabel weit in der Zukunft -- Tests, die den
    // Verfall pruefen wollen, ueberschreiben dieses Feld ausdruecklich.
    expires_at_unix_ms: Date.now() + 60_000,
    // Standardmaessig leer (echter Erstkontakt, kein anderer Typ bereits
    // bekannt) -- Tests fuer den Hinweis (H8-Nachtrag) ueberschreiben dies
    // ausdruecklich.
    known_key_types: [],
    ...overrides,
  };
}

// `mountHostKeyPrompt` registriert ZWEI `listen()`-Aufrufe
// ("hostkey://request" und "hostkey://persist-failed", siehe Review-Befund
// 3) -- eine einzelne "letzter Aufruf gewinnt"-Zuordnung wuerde den ersten
// Handler stillschweigend ueberschreiben. Route stattdessen ueber den
// Event-Namen, EINMAL zentral in `beforeEach`.
const listeners = new Map<string, (event: { payload: unknown }) => void>();

function emitRequest(payload: Payload): void {
  (listeners.get("hostkey://request") as ((event: { payload: Payload }) => void) | undefined)?.({
    payload,
  });
}

function emitPersistFailure(payload: PersistFailurePayload): void {
  (
    listeners.get("hostkey://persist-failed") as
      | ((event: { payload: PersistFailurePayload }) => void)
      | undefined
  )?.({ payload });
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockReset();
  listeners.clear();
  listenMock.mockImplementation((eventName, handler) => {
    listeners.set(eventName, handler as (event: { payload: unknown }) => void);
    return Promise.resolve(vi.fn());
  });
});

afterEach(() => {
  activeHandles.splice(0).forEach((handle) => handle.dispose());
  // Sicherheitsnetz: falls ein Test `vi.useFakeTimers()` aufgerufen und den
  // eigenen `finally`-Block uebersprungen haette (z. B. durch einen
  // fehlgeschlagenen `expect`), soll das keine nachfolgenden Tests in
  // dieser Datei mit gefaelschten Timern infizieren. No-op, falls echte
  // Timer bereits aktiv sind.
  vi.useRealTimers();
});

describe("mountHostKeyPrompt: zeigt den Fingerabdruck, niemals den rohen Schluessel", () => {
  it("rendert den SHA256-Fingerabdruck aus der Nutzlast", () => {
    const root = document.createElement("div");
    mount(root);

    emitRequest(samplePayload());

    expect(root.textContent).toContain("SHA256:cd4xJCbJywoyJ+atpjT31411tIy9KUZajEpme8VfVOc");
  });

  /// Strukturelle Garantie, nicht nur Disziplin: die Nutzlast
  /// (`HostKeyRequest` in `commands.rs`) traegt gar kein Feld fuer den
  /// rohen Base64-Schluessel -- dieser Test belegt trotzdem explizit, dass
  /// der gerenderte Text keine Base64-aehnliche lange Zeichenkette ausser
  /// dem Fingerabdruck selbst enthaelt (Gegenprobe: wuerde `render()`
  /// versehentlich ein zusaetzliches Feld wie `key_b64` aus der Nutzlast
  /// anzeigen, muesste dieser Test es erkennen -- deshalb eine involvierte
  /// Beispiel-Payload, die zur Probe ein `key_b64`-Feld TRAEGT, das
  /// `mountHostKeyPrompt` schlicht ignorieren muss, weil sein Typ es nicht
  /// kennt).
  it("zeigt niemals ein etwaiges rohes Schluesselfeld an, selbst wenn die Nutzlast eines mitbringt", () => {
    const root = document.createElement("div");
    mount(root);

    const rawKey = "AAAAC3NzaC1lZDI1NTE5AAAAIGnfcsdz52gqKOHZgB/zulihJmeJX1n9qFxHiNvGwoE4";
    emitRequest({ ...samplePayload(), key_b64: rawKey } as Payload & { key_b64: string });

    expect(root.textContent).not.toContain(rawKey);
  });
});

describe("mountHostKeyPrompt: kein automatisches Antworten (Eigenschaft 5)", () => {
  it("ruft respond_host_key NICHT auf, solange kein Button geklickt wurde", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload());

    expect(
      invokeMock.mock.calls.some(([command]) => command === "respond_host_key"),
    ).toBe(false);
  });

  it("ruft respond_host_key mit accept:true auf, wenn 'Trust and continue' geklickt wird", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ request_id: 42 }));

    const buttons = root.querySelectorAll("button");
    const acceptButton = Array.from(buttons).find((b) => b.textContent === "Trust and continue");
    acceptButton?.click();

    expect(invokeMock).toHaveBeenCalledWith("respond_host_key", {
      requestId: 42,
      accept: true,
    });
  });

  it("ruft respond_host_key mit accept:false auf, wenn 'Reject' geklickt wird", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ request_id: 7 }));

    const buttons = root.querySelectorAll("button");
    const rejectButton = Array.from(buttons).find((b) => b.textContent === "Reject");
    rejectButton?.click();

    expect(invokeMock).toHaveBeenCalledWith("respond_host_key", {
      requestId: 7,
      accept: false,
    });
  });

  it("leert die Ansicht nach einer Antwort und zeigt eine zweite, spaeter eingegangene Anfrage danach", async () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ request_id: 1, host: "host-a" }));
    emitRequest(samplePayload({ request_id: 2, host: "host-b" }));

    // Nur die ERSTE Anfrage darf sichtbar sein, solange sie unbeantwortet
    // ist -- eine zweite eintreffende Anfrage darf sie nicht verdraengen.
    expect(root.textContent).toContain("host-a");
    expect(root.textContent).not.toContain("host-b");

    const acceptButton = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Trust and continue",
    );
    acceptButton?.click();
    await flush();

    expect(root.textContent).toContain("host-b");
  });
});

describe("mountHostKeyPrompt: Hinweis auf einen bereits unter anderem Typ bekannten Host (H8-Nachtrag)", () => {
  it("zeigt den Hinweis, wenn known_key_types nicht leer ist", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ known_key_types: ["ecdsa-sha2-nistp256"] }));

    expect(root.textContent).toContain("already trusted with a ecdsa-sha2-nistp256 key");
  });

  it("zeigt den Hinweis NICHT, wenn known_key_types leer ist (echter Erstkontakt)", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ known_key_types: [] }));

    expect(root.textContent).not.toContain("already trusted with a");
  });
});

describe("mountHostKeyPrompt: modal fuer Tastatur und Hilfstechnik (H-Nachtrag)", () => {
  it("traegt aria-modal und aria-labelledby auf den Ueberschrift-Knoten", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload());

    const dialog = root.querySelector(".host-key-prompt")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = root.querySelector("h2")!;
    expect(heading.id).not.toBe("");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("UI v2: traegt die gemeinsame Dialoghuelle ohne Schliessen-Kreuz; Accept primaer, Reject gefaehrlich", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    mount(root);
    emitRequest(samplePayload());
    await flush();
    const dialog = root.querySelector<HTMLElement>(".host-key-prompt")!;
    expect(dialog.classList.contains("dialog-panel")).toBe(true);
    expect(dialog.querySelector(".dialog-head h2#host-key-prompt-title")).not.toBeNull();
    expect(dialog.querySelector(".dialog-body .host-key-prompt-fingerprint-value")).not.toBeNull();
    expect(dialog.querySelector(".dialog-close-btn")).toBeNull();
    const [reject, accept] = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".host-key-prompt-actions button"));
    expect(reject.className).toBe("btn btn--danger");
    expect(accept.className).toBe("btn btn--primary");
  });
});

describe("mountHostKeyPrompt: Restzeit-Anzeige (Review-Befund 1b)", () => {
  it("zeigt beim Rendern eine Restzeit-Angabe im Overlay -- eine sicherheitsrelevante Frist bleibt sichtbar, statt unsichtbar zu verstreichen", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ expires_at_unix_ms: Date.now() + 45_000 }));

    const countdown = root.querySelector(".host-key-prompt-countdown");
    expect(countdown).not.toBeNull();
    // Bewusst KEIN exakter Sekundenwert (das wuerde nur `Math.ceil`
    // pruefen, nicht das eigentliche Verhalten) -- nur, dass ueberhaupt
    // eine Restzeit in Sekundenform angezeigt wird.
    expect(countdown?.textContent).toMatch(/\d+s/);
  });
});

// UX-Spec §10: fuer eine abgelaufene Frage sieht der Nutzer genau EINEN Text,
// den des Backends ("The host key wasn't confirmed in time, so aidevbridge
// didn't connect."). Er steht dort, wo jeder Verbindungsfehler steht
// (Hinweis in der Seitenleiste, Zeile im Erststart). Die Rueckfrage schliesst
// sich deshalb still, statt einen zweiten, anderen Satz zu zeigen.
describe("mountHostKeyPrompt: Verfall (Review-Befund 1b, UX-Spec §10)", () => {
  it("schliesst eine noch offene Rueckfrage automatisch und still, wenn ihre Frist ablaeuft, und ruft respond_host_key dabei NIEMALS auf", async () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      mount(root);

      const now = Date.now();
      emitRequest(samplePayload({ request_id: 9, host: "host-timeout", expires_at_unix_ms: now + 5000 }));
      expect(root.querySelector(".host-key-prompt")).not.toBeNull();

      vi.advanceTimersByTime(5000);
      await flush();

      expect(root.querySelector(".host-key-prompt")).toBeNull();
      // Kein eigener Text: den einen Satz liefert der Verbindungsfehler.
      expect(root.childElementCount).toBe(0);
      expect(
        invokeMock.mock.calls.some(([command]) => command === "respond_host_key"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uebergeht eine bereits VOR dem Rendern abgelaufene, wartende Anfrage still, ohne je einen interaktiven Dialog aufzubauen", async () => {
    // Die verschaerfende Situation aus dem Befund: eine zweite Rueckfrage
    // trifft ein, waehrend die erste noch offen ist -- ihre EIGENE
    // 60-Sekunden-Frist im Backend lief aber unsichtbar weiter, waehrend sie
    // in der Frontend-Warteschlange wartete, und ist bereits abgelaufen, bis
    // sie an die Reihe kommt.
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      mount(root);

      const now = Date.now();
      emitRequest(
        samplePayload({ request_id: 1, host: "host-a", expires_at_unix_ms: now + 30_000 }),
      );
      emitRequest(
        samplePayload({ request_id: 2, host: "host-b", expires_at_unix_ms: now - 1000 }),
      );
      expect(root.textContent).toContain("host-a");

      const acceptButton = Array.from(root.querySelectorAll("button")).find(
        (b) => b.textContent === "Trust and continue",
      );
      acceptButton?.click();
      await flush();

      // Die zweite Anfrage darf NIE als interaktiver Dialog erscheinen --
      // sie ist beim Backend laengst vergessen (`forget_host_key_request`
      // lief dort schon durch `decide()`s eigenen Zeitablauf).
      expect(root.querySelector(".host-key-prompt")).toBeNull();
      expect(root.childElementCount).toBe(0);
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "respond_host_key" &&
            (args as { requestId: number }).requestId === 2,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mountHostKeyPrompt: Fehlerpfad beim Antworten wird sichtbar (Review-Befund 1a)", () => {
  it("zeigt die Fehlermeldung sichtbar an, statt sie im selben Durchlauf synchron wieder zu loeschen", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "respond_host_key") return Promise.reject(new Error("boom"));
      return Promise.resolve(undefined);
    });

    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ request_id: 5 }));

    const acceptButton = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Trust and continue",
    );
    acceptButton?.click();
    await flush();

    expect(root.textContent).toContain("Could not send the response");
    expect(root.textContent).toContain("boom");
    // Der interaktive Dialog ist weg (die Entscheidung wurde getroffen),
    // die Fehlermeldung bleibt aber stehen, bis der Nutzer sie wegklickt.
    expect(root.querySelector(".host-key-prompt")).toBeNull();
    expect(
      Array.from(root.querySelectorAll("button")).some((b) => b.textContent === "Dismiss"),
    ).toBe(true);
  });

  it("schaltet erst nach einem Klick auf Dismiss zur naechsten wartenden Anfrage weiter", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "respond_host_key") return Promise.reject(new Error("boom"));
      return Promise.resolve(undefined);
    });

    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ request_id: 5, host: "host-a" }));

    const acceptButton = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Trust and continue",
    );
    acceptButton?.click();
    await flush();

    // Eine zweite Anfrage trifft ein, waehrend die Fehlermeldung noch steht
    // -- sie darf die Meldung nicht verdraengen.
    emitRequest(samplePayload({ request_id: 6, host: "host-b" }));
    expect(root.textContent).not.toContain("host-b");
    expect(root.textContent).toContain("Could not send the response");

    const dismissButton = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Dismiss",
    );
    dismissButton?.click();

    expect(root.textContent).toContain("host-b");
  });
});

describe("mountHostKeyPrompt: Persistenzfehler-Hinweis (Review-Befund 3)", () => {
  it("zeigt einen Hinweis in document.body, wenn hostkey://persist-failed eintrifft, OHNE den TOFU-Dialog selbst zu beruehren", () => {
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ request_id: 3, host: "still-pending" }));

    emitPersistFailure({ host: "192.0.2.10", port: 22, message: "permission denied" });

    const banner = document.body.querySelector(".host-key-persist-failure-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("192.0.2.10:22");
    expect(banner?.textContent).toContain("permission denied");

    // Die noch offene, unabhaengige Rueckfrage bleibt unangetastet -- der
    // Hinweis haengt NICHT in `root`, sonst wuerde er die
    // "gerade nichts angezeigt"-Pruefung fuer neu eintreffende Anfragen
    // verfaelschen.
    expect(root.textContent).toContain("still-pending");
  });

  it("versteckt den Hinweis nach einem Klick auf seinen Dismiss-Button", () => {
    const root = document.createElement("div");
    mount(root);
    emitPersistFailure({ host: "192.0.2.10", port: 22, message: "permission denied" });

    const banner = document.body.querySelector(".host-key-persist-failure-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);

    const dismissButton = Array.from(banner.querySelectorAll("button")).find(
      (b) => b.textContent === "Dismiss",
    );
    dismissButton?.click();

    expect(banner.hidden).toBe(true);
  });

  it("entfernt den Hinweis-Banner aus document.body, wenn dispose() aufgerufen wird", () => {
    const root = document.createElement("div");
    const handle = mount(root);

    expect(document.body.querySelector(".host-key-persist-failure-banner")).not.toBeNull();

    handle.dispose();

    expect(document.body.querySelector(".host-key-persist-failure-banner")).toBeNull();
  });
});

describe("mountHostKeyPrompt: Persistenzfehler-Banner ist im Ausgangszustand nicht sichtbar (Nachtrag A)", () => {
  // Befund: `hidden` ist NUR eine User-Agent-Regel (`[hidden] { display: none }`)
  // -- eine Autoren-Regel mit `display` (frueher: ein INLINE `style.display =
  // "flex"`) gewinnt dagegen IMMER, unabhaengig von
  // Spezifitaet (Autoren-Herkunft schlaegt UA-Herkunft in der Kaskade, vor
  // jedem Spezifitaetsvergleich). Der Banner stand deshalb ab dem ersten
  // Programmstart sichtbar, leer und `position: fixed` ueber allem -- obwohl
  // `persistFailureBanner.hidden` bereits `true` war. Das Attribut allein
  // beweist deshalb nichts, nur die tatsaechliche Bildwirkung
  // (`getComputedStyle`) zaehlt als Zusicherung.
  //
  // Laedt deshalb, wie `terminal.test.ts` (dort zuerst eingefuehrt, siehe
  // dessen Kommentar), den ECHTEN Inhalt von `src/styles.css` -- keine
  // Abschrift der Regel, die unbemerkt von der ausgelieferten Datei
  // abdriften koennte.
  beforeAll(() => {
    // Pfad `cwd`-relativ, nicht `import.meta.url` -- dasselbe empirisch
    // gepruefte Vorgehen wie in `terminal.test.ts`.
    // @ts-expect-error 'process' ist ein Node-Global, siehe Kommentar oben
    const cssText = readFileSync(path.resolve(process.cwd(), "src/styles.css"), "utf-8");
    const styleEl = document.createElement("style");
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);
  });

  it("hat computed display:none direkt nach dem Mounten, bevor je eine Anfrage eintraf", () => {
    const root = document.createElement("div");
    mount(root);

    const banner = document.body.querySelector(".host-key-persist-failure-banner") as HTMLElement;
    // Vorbedingung: das Attribut war schon VOR diesem Nachtrag `true` --
    // genau das taeuschte vor, der Banner sei versteckt (siehe Befund oben).
    expect(banner.hidden).toBe(true);
    // Die eigentliche Zusicherung: die sichtbare Wirkung, nicht das Attribut.
    expect(getComputedStyle(banner).display).toBe("none");
  });

  // Review-Minor (Nachtrag A): die Basisregel traegt seit der
  // `:not([hidden])`-Umstellung flex-abhaengige Eigenschaften
  // (`align-items`, `justify-content`, `gap`), die stillschweigend
  // wirkungslos wuerden, sollte die `:not([hidden])`-Regel je verloren
  // gehen (z. B. durch einen versehentlich falsch geschriebenen Selektor
  // bei einer kuenftigen Aenderung) -- ohne diesen Test wuerde nur die
  // ANDERE Haelfte (versteckt bleibt versteckt) automatisiert bewacht, nicht
  // die hier eigentlich gewollte sichtbare Darstellung.
  it("hat computed display:flex, sobald hostkey://persist-failed eintrifft und der Banner eingeblendet wird", () => {
    const root = document.createElement("div");
    mount(root);

    emitPersistFailure({ host: "192.0.2.10", port: 22, message: "permission denied" });

    const banner = document.body.querySelector(".host-key-persist-failure-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(getComputedStyle(banner).display).toBe("flex");
  });
});


function emitClosed(req: Payload, reason: "cancelled" | "expired" | "answered" | "unavailable" = "cancelled"): void {
  listeners.get("hostkey://request-closed")?.({ payload: {
    request_id: req.request_id, expires_at_unix_ms: req.expires_at_unix_ms, reason,
  } });
}

function pendingResponse() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  invokeMock.mockReturnValue(promise);
  return { resolve, reject };
}

describe("mountHostKeyPrompt: backend closure and response ownership", () => {
  it("removes only a closed queued request and advances the active request independently", async () => {
    const root = document.createElement("div");
    mount(root);
    const a = samplePayload({ request_id: 10, host: "host-a" });
    const b = samplePayload({ request_id: 11, host: "host-b" });
    const c = samplePayload({ request_id: 12, host: "host-c" });
    emitRequest(a); emitRequest(b); emitRequest(c);
    emitClosed(b);
    expect(root.textContent).toContain("host-a");
    emitClosed(a);
    expect(root.textContent).toContain("host-c");
    emitClosed(c, "unavailable");
    expect(root.childElementCount).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not reopen a request when its close event arrived first", () => {
    const root = document.createElement("div");
    mount(root);
    const closed = samplePayload({ request_id: 20, host: "closed-host" });
    emitClosed(closed);
    emitRequest(closed);
    expect(root.childElementCount).toBe(0);
    emitRequest(samplePayload({ request_id: 21, host: "current-host" }));
    expect(root.textContent).toContain("current-host");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a late response %s after closure has shown another request", async (outcome) => {
    const pending = pendingResponse();
    const root = document.createElement("div");
    mount(root);
    const a = samplePayload({ request_id: 30, host: "host-a" });
    emitRequest(a);
    emitRequest(samplePayload({ request_id: 31, host: "host-b" }));
    root.querySelector<HTMLButtonElement>("button")!.click();
    emitClosed(a, "answered");
    const nextDialog = root.querySelector(".host-key-prompt");
    expect(root.textContent).toContain("host-b");
    if (outcome === "resolve") pending.resolve();
    else pending.reject(new Error("old response failed"));
    await flush();
    expect(root.querySelector(".host-key-prompt")).toBe(nextDialog);
    expect(root.textContent).toContain("host-b");
    expect(root.textContent).not.toContain("old response failed");
  });

  it("does not show a second text when an in-flight response fails after the expiry", async () => {
    vi.useFakeTimers();
    const pending = pendingResponse();
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload({ expires_at_unix_ms: Date.now() + 100 }));
    root.querySelector<HTMLButtonElement>("button")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(root.childElementCount).toBe(0);
    pending.reject(new Error("late response"));
    await flush();
    expect(root.childElementCount).toBe(0);
    expect(root.textContent).not.toContain("late response");
  });

  it("reports every expiry, shown or still queued, through onExpired with host and port -- and nothing else", async () => {
    vi.useFakeTimers();
    try {
      const onExpired = vi.fn();
      const root = document.createElement("div");
      activeHandles.push(mountHostKeyPrompt(root, { onExpired }));
      const shown = samplePayload({ request_id: 50, host: "shown.example", port: 22, expires_at_unix_ms: Date.now() + 100 });
      const queued = samplePayload({ request_id: 51, host: "queued.example", port: 2222 });
      const cancelled = samplePayload({ request_id: 52, host: "cancelled.example" });
      emitRequest(shown);
      emitRequest(queued);
      emitRequest(cancelled);

      // Die wartende Frage laeuft beim Backend ab, bevor sie je gezeigt wurde.
      emitClosed(queued, "expired");
      expect(onExpired).toHaveBeenCalledExactlyOnceWith({ host: "queued.example", port: 2222 });
      // Die gezeigte laeuft ueber die eigene Uhr ab.
      await vi.advanceTimersByTimeAsync(100);
      expect(onExpired).toHaveBeenLastCalledWith({ host: "shown.example", port: 22 });
      // Ein anderer Grund ist kein Ablauf.
      emitClosed(cancelled, "cancelled");
      expect(onExpired).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes silently when the backend reports the expiry, and shows the next waiting request", () => {
    const root = document.createElement("div");
    mount(root);
    const a = samplePayload({ request_id: 40, host: "host-a" });
    emitRequest(a);
    emitRequest(samplePayload({ request_id: 41, host: "host-b" }));
    emitClosed(a, "expired");
    expect(root.textContent).toContain("host-b");
    expect(root.textContent).not.toContain("host-a");
  });

  it("does not repopulate a disposed prompt after an in-flight response fails", async () => {
    const pending = pendingResponse();
    const root = document.createElement("div");
    const handle = mount(root);
    emitRequest(samplePayload());
    root.querySelector<HTMLButtonElement>("button")!.click();
    handle.dispose();
    pending.reject(new Error("late response"));
    await flush();
    expect(root.childElementCount).toBe(0);
  });

  it("submits one decision even if both detached button handlers are dispatched", () => {
    pendingResponse();
    const root = document.createElement("div");
    mount(root);
    emitRequest(samplePayload());
    const buttons = root.querySelectorAll("button");
    buttons[0].dispatchEvent(new Event("click"));
    buttons[1].dispatchEvent(new Event("click"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("waits for all listener registrations, including request-closed", async () => {
    let finish!: (unlisten: () => void) => void;
    const closedRegistration = new Promise<() => void>((resolve) => { finish = resolve; });
    listenMock.mockImplementation((name) => name === "hostkey://request-closed"
      ? closedRegistration : Promise.resolve(vi.fn()));
    const handle = mount(document.createElement("div"));
    const ready = vi.fn();
    void handle.ready.then(ready);
    await flush();
    expect(ready).not.toHaveBeenCalled();
    finish(vi.fn());
    await handle.ready;
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("reports failed listener readiness and still unlistens successful registrations on dispose", async () => {
    const unlisten = vi.fn();
    listenMock.mockImplementation((name) => name === "hostkey://request-closed"
      ? Promise.reject(new Error("listen failed")) : Promise.resolve(unlisten));
    const handle = mount(document.createElement("div"));
    await expect(handle.ready).rejects.toThrow("listen failed");
    handle.dispose();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
