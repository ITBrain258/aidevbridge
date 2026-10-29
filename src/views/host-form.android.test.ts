// Das Anmeldungsmenue auf Android (Spec 2026-10-27 §5.3): kein ssh-agent,
// "Choose file..." uebernimmt die gewaehlte Datei in die App, und "Generate
// new key..." erzeugt einen Schluessel samt Zeile fuer `authorized_keys`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountHostForm } from "./host-form";

const invokeMock = vi.fn();
const openMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openMock(...a) }));

const APP_KEY = {
  path: "/data/user/0/io.github.itbrain258.aidevbridge/.ssh/aidevbridge_ed25519",
  file_name: "aidevbridge_ed25519",
  key_type: "ed25519",
  comment: "aidevbridge@android",
};
const IMPORTED = {
  path: "/data/user/0/io.github.itbrain258.aidevbridge/.ssh/imported_ed25519",
  file_name: "imported_ed25519",
  key_type: "ed25519",
  comment: "u@pc",
};

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => (cmd === "list_ssh_keys" ? Promise.resolve([]) : Promise.resolve(null)));
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function mount(android = true) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  mountHostForm(el, { existing: [], onSubmit: vi.fn(), android });
  await flush();
  const auth = el.querySelector("select[name=auth]") as HTMLSelectElement;
  return { el, auth };
}

function choose(auth: HTMLSelectElement, value: string): void {
  auth.value = value;
  auth.dispatchEvent(new Event("change"));
}

describe("Anmeldungsmenue auf Android", () => {
  it("bietet keinen ssh-agent, dafuer einen neuen Schluessel", async () => {
    const { el, auth } = await mount();
    const values = Array.from(auth.options).map((option) => option.value);
    expect(values).not.toContain("agent");
    expect(values).toContain("generate-key");
    expect(values).toContain("choose-file");
    expect(el.querySelector(".host-form-hint")?.textContent).toContain("authorized_keys");
  });

  it("der Desktop behaelt sein Menue", async () => {
    const { auth } = await mount(false);
    const values = Array.from(auth.options).map((option) => option.value);
    expect(values).toContain("agent");
    expect(values).not.toContain("generate-key");
  });

  it("uebernimmt eine gewaehlte Datei in die App und waehlt den neuen Pfad", async () => {
    openMock.mockResolvedValue("content://com.android.providers.downloads.documents/document/42");
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "import_ssh_key" ? Promise.resolve(IMPORTED) : Promise.resolve([]),
    );
    const { auth } = await mount();
    choose(auth, "choose-file");
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("import_ssh_key", {
      source: "content://com.android.providers.downloads.documents/document/42",
    });
    expect(auth.value).toBe(`key:${IMPORTED.path}`);
  });

  it("meldet einen gescheiterten Import und kehrt zur vorigen Wahl zurueck", async () => {
    openMock.mockResolvedValue("content://x/1");
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "import_ssh_key" ? Promise.reject("The file is not a private key") : Promise.resolve([]),
    );
    const { el, auth } = await mount();
    choose(auth, "password");
    choose(auth, "choose-file");
    await flush();
    expect(auth.value).toBe("password");
    expect(el.querySelector("[role=alert]")?.textContent).toBe(
      "Could not import the key: The file is not a private key",
    );
  });

  it("erzeugt einen Schluessel, waehlt ihn und zeigt die Zeile fuer authorized_keys", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "generate_ssh_key"
        ? Promise.resolve({ key: APP_KEY, public_key: "ssh-ed25519 AAAAC3Nz aidevbridge@android" })
        : Promise.resolve([]),
    );
    const { el, auth } = await mount();
    const box = el.querySelector(".host-form-public-key") as HTMLElement;
    expect(box.hidden).toBe(true);
    choose(auth, "generate-key");
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("generate_ssh_key", { comment: "aidevbridge@android" });
    expect(auth.value).toBe(`key:${APP_KEY.path}`);
    expect(box.hidden).toBe(false);
    expect((box.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "ssh-ed25519 AAAAC3Nz aidevbridge@android",
    );
  });

  it("der Desktop hat das Feld fuer den oeffentlichen Schluessel nicht im DOM", async () => {
    const { el } = await mount(false);
    expect(el.querySelector(".host-form-public-key")).toBeNull();
  });

  // Befunde der Durchsicht vom 29.10.
  it("nimmt die Meldung eines gescheiterten Imports weg, sobald ein Schluessel gewaehlt ist", async () => {
    openMock.mockResolvedValue("content://x/1");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "import_ssh_key") return Promise.reject("The file is not a private key");
      if (cmd === "generate_ssh_key") return Promise.resolve({ key: APP_KEY, public_key: "ssh-ed25519 AAAA x" });
      return Promise.resolve([]);
    });
    const { el, auth } = await mount();
    choose(auth, "choose-file");
    await flush();
    expect(el.querySelector("[role=alert]")?.textContent).not.toBe("");

    choose(auth, "generate-key");
    await flush();

    expect(auth.value).toBe(`key:${APP_KEY.path}`);
    expect(el.querySelector("[role=alert]")?.textContent).toBe("");
  });

  it("behaelt einen Schluessel, der vor der Schluesselliste erzeugt wurde, und fuehrt ihn nur einmal", async () => {
    let answerList: (keys: unknown[]) => void = () => undefined;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_ssh_keys") return new Promise((resolve) => (answerList = resolve));
      if (cmd === "generate_ssh_key") return Promise.resolve({ key: APP_KEY, public_key: "ssh-ed25519 AAAA x" });
      return Promise.resolve(null);
    });
    const { auth } = await mount();
    choose(auth, "generate-key");
    await flush();
    expect(auth.value).toBe(`key:${APP_KEY.path}`);

    answerList([IMPORTED, APP_KEY]);
    await flush();

    expect(auth.value).toBe(`key:${APP_KEY.path}`);
    expect(Array.from(auth.options).filter((option) => option.value === `key:${APP_KEY.path}`)).toHaveLength(1);
  });

  it("faellt nach einem gescheiterten Erzeugen vor der Schluesselliste auf Password zurueck", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_ssh_keys") return new Promise(() => undefined);
      if (cmd === "generate_ssh_key") return Promise.reject("disk full");
      return Promise.resolve(null);
    });
    const { auth } = await mount();
    choose(auth, "generate-key");
    await flush();
    expect(auth.value).toBe("password");
  });
});
