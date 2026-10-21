// Gegenprobe fuer `src/views/dialog.ts`: die Dialoghuelle allein, ohne
// `main()` -- Fokus-Falle, dokumentweites Escape und Fokusrueckgabe. Die
// Verdrahtung in main.ts (TOFU-Rueckfrage, die Formular-Ablaeufe) prueft
// weiter `main.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountDialogShell, type DialogShell } from "./dialog";

let app: HTMLElement;
let dialogRoot: HTMLElement;
let opener: HTMLButtonElement;
let shell: DialogShell;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="app"><button type="button" id="opener">Open</button></div>
    <div id="dialog-root"></div>
  `;
  app = document.getElementById("app")!;
  dialogRoot = document.getElementById("dialog-root")!;
  opener = document.getElementById("opener") as HTMLButtonElement;
  shell = mountDialogShell(dialogRoot, app);
});

afterEach(() => {
  // Eine offen gebliebene Ueberlagerung nimmt ihren Escape-Horcher sonst
  // nicht vom `document`, und der naechste Test erbte ihn.
  shell.closeDialog();
  document.body.replaceChildren();
});

function press(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

function closeButton(): HTMLButtonElement {
  const button = dialogRoot.querySelector<HTMLButtonElement>(".dialog-close-btn");
  if (!button) throw new Error("no open dialog");
  return button;
}

/** Ein Inhalt mit Feld und Knopf -- der Knopf ist das letzte Tab-Ziel. */
function formContent(dispose: () => void = () => {}) {
  const field = document.createElement("input");
  const submit = document.createElement("button");
  submit.type = "button";
  const build = (container: HTMLElement) => {
    container.append(field, submit);
    return { dispose };
  };
  return { field, submit, build };
}

describe("dialog: Huelle mit Fokus-Falle (Review-Nachtrag Important 3)", () => {
  it("setzt den Fokus auf das Schliessen-Kreuz, sperrt #app und wickelt Tab/Shift+Tab im Panel", () => {
    opener.focus();
    const { submit, build } = formContent();
    shell.openDialog({ title: "Edit host" }, build);

    expect(dialogRoot.querySelector(".dialog-head h2")?.textContent).toBe("Edit host");
    expect(document.activeElement).toBe(closeButton());
    expect(app.inert).toBe(true);
    expect(shell.isDialogOpen()).toBe(true);

    submit.focus();
    press("Tab");
    expect(document.activeElement).toBe(closeButton());

    press("Tab", true);
    expect(document.activeElement).toBe(submit);
  });

  // UX-Spec §11: jeder Dialog traegt seinen Namen ueber aria-labelledby auf
  // die Ueberschrift -- in der Huelle, damit kein Inhalt es vergessen kann.
  it("benennt das Panel ueber aria-labelledby nach seiner Ueberschrift, je Dialog mit eigener Kennung", () => {
    shell.openDialog({ title: "Edit host" }, formContent().build);
    const panel = () => dialogRoot.querySelector<HTMLElement>(".dialog-panel")!;
    const heading = () => dialogRoot.querySelector<HTMLElement>(".dialog-head h2")!;
    const firstId = panel().getAttribute("aria-labelledby");
    expect(firstId).toBeTruthy();
    expect(heading().id).toBe(firstId);
    expect(document.getElementById(firstId!)?.textContent).toBe("Edit host");

    shell.openDialog({ title: "Settings" }, formContent().build);
    const secondId = panel().getAttribute("aria-labelledby");
    expect(document.getElementById(secondId!)?.textContent).toBe("Settings");
    expect(secondId).not.toBe(firstId);
  });

  it("holt einen Fokus, der ausserhalb des Panels steht, mit Tab zurueck", () => {
    const { submit, build } = formContent();
    shell.openDialog({ title: "Add host" }, build);
    submit.focus();
    submit.blur();
    expect(document.activeElement).toBe(document.body);

    const event = press("Tab");

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton());
  });
});

describe("dialog: Escape und Fokusrueckgabe", () => {
  it("schliesst ueber ein Escape am document, raeumt den Inhalt ab und gibt Fokus und #app zurueck", () => {
    opener.focus();
    const dispose = vi.fn();
    const { field, build } = formContent(dispose);
    shell.openDialog({ title: "Add host" }, build);
    // Escape greift unabhaengig davon, wo der Fokus im Panel steht.
    field.focus();

    press("Escape");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dialogRoot.childElementCount).toBe(0);
    expect(shell.isDialogOpen()).toBe(false);
    expect(app.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("gibt den Fokus an fallbackFocus, wenn der Oeffner beim Schliessen nicht mehr im Dokument steht", () => {
    const row = document.createElement("button");
    row.type = "button";
    app.appendChild(row);
    opener.focus();
    shell.openDialog({ title: "Edit host", fallbackFocus: () => row }, formContent().build);
    // Die Seitenleiste zeichnet sich neu, waehrend der Dialog offen ist.
    opener.remove();

    closeButton().click();

    expect(document.activeElement).toBe(row);
  });

  it("DialogHandle.close schliesst nur die eigene Ueberlagerung, nicht ihre Nachfolgerin", () => {
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    const first = shell.openDialog({ title: "First" }, formContent(disposeFirst).build);
    const second = shell.openDialog({ title: "Second" }, formContent(disposeSecond).build);
    // Das zweite Oeffnen hat die erste Ueberlagerung bereits abgeraeumt.
    expect(disposeFirst).toHaveBeenCalledTimes(1);

    first.close();

    expect(shell.isDialogOpen()).toBe(true);
    expect(second.body.isConnected).toBe(true);
    expect(disposeSecond).not.toHaveBeenCalled();

    second.close();

    expect(shell.isDialogOpen()).toBe(false);
    expect(disposeSecond).toHaveBeenCalledTimes(1);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
  });
});
