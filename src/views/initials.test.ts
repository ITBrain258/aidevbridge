import { describe, expect, it } from "vitest";
import { hostInitials } from "./initials";

describe("hostInitials (Spec 7.3)", () => {
  it("(a) Wortteile und letzter Teil Ziffern: Anfangsbuchstabe des letzten Wortteils plus letzte Ziffer", () => {
    expect(hostInitials("vm-build-01", "192.0.2.20")).toBe("B1");
    expect(hostInitials("vm-agents-02", "192.0.2.21")).toBe("A2");
  });
  it("(b) zwei oder mehr Wortteile: Anfangsbuchstaben der ersten zwei", () => {
    expect(hostInitials("dev-box", "x")).toBe("DB");
    expect(hostInitials("my_dev box.local", "x")).toBe("MD");
  });
  it("(c) genau ein Wortteil: dessen erste zwei Zeichen", () => {
    expect(hostInitials("dev", "x")).toBe("DE");
    expect(hostInitials("a", "x")).toBe("A");
  });
  // Task 16, Punkt C: zwei Hosts im selben Netz unterscheiden sich nur
  // hinten -- "192.0.2.20" und "192.0.2.21" trugen beide das Kuerzel "19".
  it("IPv4-Adresse: das letzte Oktett", () => {
    expect(hostInitials("192.0.2.20", "192.0.2.20")).toBe("20");
    expect(hostInitials("192.0.2.254", "x")).toBe("254");
  });
  it("(d) keine Wortteile und keine IPv4-Adresse: erste zwei Zeichen des Alias", () => {
    expect(hostInitials("2024", "x")).toBe("20");
  });
  it("ohne Alias: erste zwei Zeichen des Hostnamens", () => {
    expect(hostInitials("", "build.example.org")).toBe("BU");
    expect(hostInitials("   ", "192.0.2.20")).toBe("19");
  });
  // Nur Buchstaben und Ziffern tragen ein Kuerzel; Klammern, Striche und
  // Satzzeichen werden uebergangen.
  it("uebergeht Zeichen, die weder Buchstabe noch Ziffer sind", () => {
    expect(hostInitials("VM 20 (accept)", "192.0.2.20")).toBe("VA");
    expect(hostInitials("'staging' box", "x")).toBe("SB");
    expect(hostInitials("x'y", "x")).toBe("XY");
    expect(hostInitials("Büro (Ost)", "x")).toBe("BO");
  });
  it("ein Teil ohne Buchstaben und Ziffern zaehlt nicht als Wortteil", () => {
    expect(hostInitials("dev — box", "x")).toBe("DB");
    expect(hostInitials("vm (20)", "x")).toBe("V0");
    expect(hostInitials("(2024)", "x")).toBe("20");
  });
  it("ein Alias ganz ohne Buchstaben und Ziffern gilt wie kein Alias", () => {
    expect(hostInitials("—", "build.example.org")).toBe("BU");
    expect(hostInitials("", "a.example.org")).toBe("AE");
  });
});
