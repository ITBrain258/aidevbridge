import { describe, expect, it } from "vitest";
import { buildCredentialField } from "./credential-field";

describe("credential-field (Spec 9.3, 11.3)", () => {
  it("baut ein Passwortfeld ohne Autofill mit Beschriftung und Fokusschluessel", () => {
    const field = buildCredentialField({ kind: "password", focusKey: "host:h1:password" });
    expect(field.kind).toBe("password");
    expect(field.root.tagName).toBe("LABEL");
    expect(field.root.classList.contains("host-notice-passphrase")).toBe(true);
    expect(field.root.textContent).toBe("Password");
    expect(field.input.type).toBe("password");
    expect(field.input.name).toBe("password");
    expect(field.input.autocomplete).toBe("off");
    expect(field.input.dataset.focusKey).toBe("host:h1:password");
    expect(field.root.contains(field.input)).toBe(true);
  });

  it("Passphrase: eigene Beschriftung und Name; ohne focusKey kein data-Attribut", () => {
    const field = buildCredentialField({ kind: "passphrase" });
    expect(field.root.textContent).toBe("Key passphrase (only needed if the stored key has one)");
    expect(field.input.name).toBe("passphrase");
    expect(field.input.dataset.focusKey).toBeUndefined();
  });

  // Spec 2026-11-15 §3.3: wer das Feld an einer Stelle zeigt, an der die
  // Standardbeschriftung der Meldung darueber widerspricht, gibt seine eigene mit.
  it("eine mitgegebene Beschriftung ersetzt die der Art; Name und Typ des Felds bleiben", () => {
    const field = buildCredentialField({ kind: "passphrase", label: "Passphrase for this key" });
    expect(field.root.textContent).toBe("Passphrase for this key");
    expect(field.input.name).toBe("passphrase");
    expect(field.input.type).toBe("password");
  });

  it("value() ist undefined bei leerem Feld und der Text sonst", () => {
    const field = buildCredentialField({ kind: "password" });
    expect(field.value()).toBeUndefined();
    field.input.value = "s3cret";
    expect(field.value()).toBe("s3cret");
  });
});
