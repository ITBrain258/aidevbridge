// Gegenprobe fuer `host-form.ts` (Shell-Task 8, Spec §9): ein Anmeldungsmenue
// ersetzt Schluesselpfad/Passphrase/Passwort.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountHostForm, type HostFormValue } from "./host-form";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const KEYS = [
  { path: "C:\\Users\\U\\.ssh\\id_ed25519", file_name: "id_ed25519", key_type: "ed25519", comment: "u@win" },
  { path: "C:\\Users\\U\\.ssh\\id_rsa", file_name: "id_rsa", key_type: "rsa", comment: "" },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "list_ssh_keys" ? Promise.resolve(KEYS) : Promise.resolve(null),
  );
});

interface Parts {
  el: HTMLElement;
  auth: HTMLSelectElement;
  form: HTMLFormElement;
  onSubmit: ReturnType<typeof vi.fn>;
}

async function mount(
  existing: { hostname: string; user: string; port: number }[] = [],
  initial?: Partial<HostFormValue>,
  mode?: "edit",
): Promise<Parts> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const onSubmit = vi.fn();
  mountHostForm(el, { existing, initial, onSubmit, mode });
  // `list_ssh_keys` wird beim Mounten geholt -- eine Mikrotask abwarten,
  // sonst ist das Menue beim Zugriff noch leer.
  await Promise.resolve();
  await Promise.resolve();
  return {
    el,
    auth: el.querySelector("select[name=auth]") as HTMLSelectElement,
    form: el.querySelector("form") as HTMLFormElement,
    onSubmit,
  };
}

function fill(el: HTMLElement, hostname: string, user: string, port: string) {
  (el.querySelector("input[name=hostname]") as HTMLInputElement).value = hostname;
  (el.querySelector("input[name=user]") as HTMLInputElement).value = user;
  (el.querySelector("input[name=port]") as HTMLInputElement).value = port;
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

describe("mountHostForm", () => {
  it("waehlt ed25519 vor rsa vor -- die Reihenfolge aus list_ssh_keys", async () => {
    const { auth } = await mount();
    expect(auth.value).toBe("key:C:\\Users\\U\\.ssh\\id_ed25519");
  });

  it("bevorzugt eine IdentityFile-Angabe vor der Erkennungsreihenfolge", async () => {
    const { auth } = await mount([], {
      auth: { kind: "key", path: "C:\\Users\\U\\.ssh\\id_rsa", passphrase: "" },
    });
    expect(auth.value).toBe("key:C:\\Users\\U\\.ssh\\id_rsa");
  });

  it("sendet bei Schluesselwahl kein Passwort mit", async () => {
    const { el, auth, form, onSubmit } = await mount();
    auth.value = "key:C:\\Users\\U\\.ssh\\id_ed25519";
    auth.dispatchEvent(new Event("change"));
    fill(el, "192.0.2.20", "u", "22");
    submit(form);

    const v = onSubmit.mock.calls[0][0] as HostFormValue;
    expect(v.auth.kind).toBe("key");
    expect(v.auth).not.toHaveProperty("password");
  });

  // Task 8 (Spec §4.8): der Rust-DTO mit auth_kind 'password' und ohne
  // key_path entsteht nicht hier, sondern in
  // `first-run.ts`/`session-dialog.ts` (siehe deren eigene Aenderungen);
  // diese Datei liefert nur `HostFormValue.auth`. Das AEQUIVALENT
  // an dieser Grenze: bei Passwortwahl traegt `auth.kind` genau `"password"`
  // (die Uebersetzungsstelle nach `auth_kind` in den beiden Aufrufern), und
  // `auth` traegt keinen Schluesselpfad -- symmetrisch zum Schluessel-Test
  // oben.
  it("sendet bei Passwortwahl keinen Schluesselpfad mit", async () => {
    const { el, auth, form, onSubmit } = await mount();
    auth.value = "password";
    auth.dispatchEvent(new Event("change"));
    (el.querySelector("input[name=password]") as HTMLInputElement).value = "geheim";
    fill(el, "192.0.2.20", "u", "22");
    submit(form);

    const v = onSubmit.mock.calls[0][0] as HostFormValue;
    expect(v.auth.kind).toBe("password");
    expect(v.auth).not.toHaveProperty("path");
    expect(v.auth).not.toHaveProperty("passphrase");
  });

  it("zeigt das Passphrasenfeld NUR bei Schluesselwahl", async () => {
    const { el, auth } = await mount();
    const sichtbar = () => el.querySelector("input[name=passphrase]") !== null;

    auth.value = "key:C:\\Users\\U\\.ssh\\id_ed25519";
    auth.dispatchEvent(new Event("change"));
    expect(sichtbar()).toBe(true);

    auth.value = "agent";
    auth.dispatchEvent(new Event("change"));
    expect(sichtbar()).toBe(false);

    auth.value = "password";
    auth.dispatchEvent(new Event("change"));
    expect(sichtbar()).toBe(false);
    expect(el.querySelector("input[name=password]")).not.toBeNull();
  });

  it("warnt bei gleichem (hostname, user, port), verbietet aber nicht", async () => {
    const { el, form, onSubmit } = await mount([
      { hostname: "192.0.2.10", user: "u", port: 22 },
    ]);
    fill(el, "192.0.2.10", "u", "22");

    submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(el.querySelector("[role=alert]")?.textContent ?? "").not.toBe("");

    // Zweites Absenden geht durch -- Warnung, kein Verbot (Spec §9.4).
    submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("warnt NICHT bei einem anderen Benutzer auf demselben Rechner", async () => {
    // Verglichen wird das Tripel, nicht nur der Hostname: zwei Benutzer auf
    // derselben Maschine sind legitim und haeufig (Spec §9.4).
    const { el, form, onSubmit } = await mount([
      { hostname: "192.0.2.10", user: "u", port: 22 },
    ]);
    fill(el, "192.0.2.10", "other", "22");
    submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(el.querySelector("[role=alert]")?.textContent ?? "").toBe("");
  });

  it("raeumt das Passphrasenfeld nach erfolgreichem Absenden", async () => {
    // Geheimnis-Disziplin (Spec §8.5): nach dem Absenden ist der Wert
    // bereits im uebergebenen `auth`-Objekt gesichert, das Feld selbst soll
    // ihn nicht laenger im DOM vorhalten als noetig.
    const { el, auth, form } = await mount();
    auth.value = "key:C:\\Users\\U\\.ssh\\id_ed25519";
    auth.dispatchEvent(new Event("change"));
    fill(el, "192.0.2.30", "u", "22");
    const passphraseInput = el.querySelector("input[name=passphrase]") as HTMLInputElement;
    passphraseInput.value = "geheim";

    submit(form);

    expect(passphraseInput.value).toBe("");
  });

  it("laesst das Menue auf einem Platzhalter, wenn weder identity_file noch ein Schluessel vorliegt", async () => {
    // Review-Befund (Important): ohne Schluessel und ohne identity_file gibt
    // es keine sinnvolle Vorauswahl -- `ssh-agent` still zu waehlen waere
    // genau die Sackgasse, gegen die dieser Task existiert (Spec §9.2).
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "list_ssh_keys" ? Promise.resolve([]) : Promise.resolve(null),
    );
    const { el, auth, form, onSubmit } = await mount();

    expect(auth.value).not.toBe("agent");

    submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(el.querySelector("[role=alert]")?.textContent ?? "").not.toBe("");
  });
});


// UX-Spec §7.7 (Aufgabe 18): ein optionales Feld "Name" oben im Formular,
// beim Anlegen wie beim Bearbeiten; im Bearbeiten-Modus heisst der Knopf "Save".
describe("mountHostForm: Feld 'Name' (UX-Spec §7.7)", () => {
  function nameInput(el: HTMLElement): HTMLInputElement {
    return el.querySelector("input[name=label]") as HTMLInputElement;
  }
  function typeHostname(el: HTMLElement, value: string): void {
    const input = el.querySelector("input[name=hostname]") as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function submitText(el: HTMLElement): string {
    return el.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent ?? "";
  }

  it("steht oben, ist optional und zeigt den Hostnamen als Platzhalter", async () => {
    const { el } = await mount();
    const first = el.querySelector("form input");
    expect(first).toBe(nameInput(el));
    expect(nameInput(el).required).toBe(false);
    expect(nameInput(el).closest("label")?.textContent).toBe("Name");
    typeHostname(el, "192.0.2.20");
    expect(nameInput(el).placeholder).toBe("192.0.2.20");
  });

  it("ein leeres Feld ergibt den Hostnamen als Label", async () => {
    const { el, form, onSubmit } = await mount();
    fill(el, "192.0.2.20", "u", "22");
    submit(form);
    expect((onSubmit.mock.calls[0][0] as HostFormValue).label).toBe("192.0.2.20");
  });

  it("ein eingetragener Name wird das Label, ohne Randleerzeichen", async () => {
    const { el, form, onSubmit } = await mount();
    nameInput(el).value = "  Build VM  ";
    fill(el, "192.0.2.20", "u", "22");
    submit(form);
    expect((onSubmit.mock.calls[0][0] as HostFormValue).label).toBe("Build VM");
  });

  it("traegt beim Bearbeiten das gespeicherte Label; ist es nur der Hostname, bleibt das Feld leer", async () => {
    const named = await mount([], { label: "Build VM", hostname: "192.0.2.20", user: "m", port: 22 }, "edit");
    expect(nameInput(named.el).value).toBe("Build VM");
    expect(nameInput(named.el).placeholder).toBe("192.0.2.20");

    // Sonst stuende der Hostname zweimal da, und ein spaeter geaenderter
    // Hostname liesse das alte als Namen stehen.
    const plain = await mount([], { label: "192.0.2.20", hostname: "192.0.2.20", user: "m", port: 22 }, "edit");
    expect(nameInput(plain.el).value).toBe("");
    typeHostname(plain.el, "192.0.2.21");
    submit(plain.form);
    expect((plain.onSubmit.mock.calls[0][0] as HostFormValue).label).toBe("192.0.2.21");
  });

  it("der Knopf heisst beim Bearbeiten 'Save', beim Anlegen weiter 'Connect'", async () => {
    const edit = await mount([], { label: "A", hostname: "a", user: "m", port: 22 }, "edit");
    expect(submitText(edit.el)).toBe("Save");
    const add = await mount();
    expect(submitText(add.el)).toBe("Connect");
  });
});

it("control-repair mode reuses authentication without accepting endpoint edits", async () => {
  const el = document.createElement("div");
  const onSubmit = vi.fn();
  const handle = mountHostForm(el, {
    mode: "control-repair", existing: [],
    initial: { hostname: "original-host", user: "original-user", port: 2222, auth: { kind: "password", password: "" } },
    onSubmit,
  });
  await Promise.resolve(); await Promise.resolve();
  fill(el, "different-host", "different-user", "99");
  const password = el.querySelector<HTMLInputElement>('input[name="password"]')!;
  password.value = "new-password";
  submit(el.querySelector("form")!);
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ hostname: "original-host", user: "original-user", port: 2222, auth: { kind: "password", password: "new-password" } }));
  expect(password.value).toBe("");
  handle.dispose();
});

it("control-repair mode hides the name field like the other endpoint fields", async () => {
  const el = document.createElement("div");
  const handle = mountHostForm(el, {
    mode: "control-repair", existing: [],
    initial: { label: "Build VM", hostname: "h", user: "u", port: 22, auth: { kind: "agent" } },
    onSubmit: vi.fn(),
  });
  const name = el.querySelector<HTMLInputElement>("input[name=label]")!;
  expect(name.disabled).toBe(true);
  expect(name.closest("label")!.hidden).toBe(true);
  handle.dispose();
});

// UX-Spec §11: ein Feldfehler markiert sein Feld fuer Hilfstechnik --
// `aria-invalid` und `aria-describedby` auf die Meldung. Die Duplikat-Warnung
// ist kein Feldfehler (ein zweites Absenden geht durch) und markiert nichts.
describe("mountHostForm: Feldfehler (UX-Spec §11)", () => {
  async function withoutKeys(): Promise<Parts> {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "list_ssh_keys" ? Promise.resolve([]) : Promise.resolve(null),
    );
    return mount();
  }

  it("eine fehlende Anmeldeart markiert das Menue und verweist auf die Meldung", async () => {
    const { el, auth, form } = await withoutKeys();
    fill(el, "192.0.2.30", "u", "22");
    expect(auth.hasAttribute("aria-invalid")).toBe(false);

    submit(form);

    expect(auth.getAttribute("aria-invalid")).toBe("true");
    const describedBy = auth.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "Choose an authentication method before connecting.",
    );
  });

  it("die Markierung faellt, sobald eine Anmeldeart gewaehlt ist", async () => {
    const { el, auth, form } = await withoutKeys();
    fill(el, "192.0.2.30", "u", "22");
    submit(form);
    expect(auth.getAttribute("aria-invalid")).toBe("true");

    auth.value = "agent";
    auth.dispatchEvent(new Event("change"));

    expect(auth.hasAttribute("aria-invalid")).toBe(false);
    expect(auth.hasAttribute("aria-describedby")).toBe(false);
    expect(el.querySelector("[role=alert]")?.textContent ?? "").toBe("");
  });

  it("die Duplikat-Warnung markiert kein Feld", async () => {
    const { el, form } = await mount([{ hostname: "192.0.2.10", user: "u", port: 22 }]);
    fill(el, "192.0.2.10", "u", "22");
    submit(form);
    expect(el.querySelector("[role=alert]")?.textContent ?? "").not.toBe("");
    expect(el.querySelector("[aria-invalid]")).toBeNull();
  });
});
