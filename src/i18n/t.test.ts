import { describe, expect, it, vi } from "vitest";
import en from "./en.json";
import { t, type TranslationKey } from "./t";

// en.json hat keinen Text mit `{constructor}` oder `{toString}`; dieser
// Testschluessel ergaenzt die echten Texte um einen, ohne en.json zu aendern.
const PROTOTYPE_KEY = "test.prototypePlaceholders" as TranslationKey;
vi.mock("./en.json", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, string> }>();
  return {
    default: { ...actual.default, "test.prototypePlaceholders": "{constructor} {toString} {hasOwnProperty} {label}" },
  };
});

describe("t", () => {
  it("liefert ohne params den Text unveraendert, auch mit Platzhaltern", () => {
    expect(t("connect.error")).toBe(en["connect.error"]);
    expect(t("connect.error")).toBe("Couldn't connect to {host}: {message}");
  });

  it("setzt die Werte ein", () => {
    expect(t("connect.error", { host: "lab", message: "timed out" })).toBe("Couldn't connect to lab: timed out");
  });

  // Ein Durchgang: ein eingesetzter Wert wird nicht noch einmal ersetzt.
  it("laesst einen Wert mit '{message}' woertlich stehen", () => {
    expect(t("connect.error", { host: "{message}", message: "timed out" })).toBe(
      "Couldn't connect to {message}: timed out",
    );
    expect(t("connect.error", { host: "lab{message}", message: "timed out" })).toBe(
      "Couldn't connect to lab{message}: timed out",
    );
  });

  it("setzt '$&' und '$1' woertlich ein", () => {
    expect(t("connect.error", { host: "$&", message: "$1 $$ $'" })).toBe("Couldn't connect to $&: $1 $$ $'");
  });

  it("laesst einen Platzhalter ohne Wert stehen", () => {
    expect(t("connect.error", { host: "lab" })).toBe("Couldn't connect to lab: {message}");
    expect(t("connect.error", { other: "x" })).toBe("Couldn't connect to {host}: {message}");
  });

  // Nur eigene Eintraege zaehlen: `constructor` oder `toString` gibt es auf
  // jedem Objekt ueber den Prototyp, ein solcher Platzhalter bleibt trotzdem
  // stehen, solange `params` ihn nicht selbst nennt.
  it("ersetzt Platzhalter wie '{constructor}' nicht aus dem Prototyp", () => {
    expect(t(PROTOTYPE_KEY, { label: "x" })).toBe("{constructor} {toString} {hasOwnProperty} x");
    expect(t(PROTOTYPE_KEY, { constructor: "c", label: "x" })).toBe("c {toString} {hasOwnProperty} x");
  });
});
