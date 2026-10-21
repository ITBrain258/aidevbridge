import { describe, expect, it, vi } from "vitest";
import { MAX_OPENS_PER_HOST, createOpenQueue, type OpenTicket } from "./terminal-open-queue";

describe("createOpenQueue (Spec 2026-10-19 §8.1, Schritt 3)", () => {
  it("haelt ohne Angabe hoechstens vier Oeffnungen je Schluessel zugleich", () => {
    expect(MAX_OPENS_PER_HOST).toBe(4);
    const queue = createOpenQueue();
    const tickets = [1, 2, 3, 4, 5].map(() => queue.enter("h", vi.fn()));
    expect(tickets.map((ticket) => ticket.granted)).toEqual([true, true, true, true, false]);
    expect(queue.inFlight("h")).toBe(4);
    expect(queue.waiting("h")).toBe(1);
    // Ein Schluessel, den niemand benutzt hat, zaehlt nichts.
    expect(queue.inFlight("unbekannt")).toBe(0);
    expect(queue.waiting("unbekannt")).toBe(0);
  });

  it("teilt sofort zu, solange ein Platz frei ist, und ruft onGrant dafuer nie", () => {
    const queue = createOpenQueue(2);
    const onA = vi.fn();
    const onB = vi.fn();
    const onC = vi.fn();
    const a = queue.enter("h", onA);
    const b = queue.enter("h", onB);
    const c = queue.enter("h", onC);
    expect([a.granted, b.granted, c.granted]).toEqual([true, true, false]);
    a.release();
    b.release();
    c.release();
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
    expect(onC).toHaveBeenCalledTimes(1);
    expect(queue.inFlight("h")).toBe(0);
  });

  it("reiht ab der Grenze ein und teilt je Schluessel in der Reihenfolge des Eintritts zu", () => {
    const queue = createOpenQueue(1);
    const order: string[] = [];
    const a = queue.enter("h", () => order.push("a"));
    const b = queue.enter("h", () => order.push("b"));
    const c = queue.enter("h", () => order.push("c"));
    const d = queue.enter("h", () => order.push("d"));
    expect(queue.waiting("h")).toBe(3);
    a.release();
    expect(order).toEqual(["b"]);
    expect([b.granted, c.granted, d.granted]).toEqual([true, false, false]);
    b.release();
    c.release();
    expect(order).toEqual(["b", "c", "d"]);
    expect(d.granted).toBe(true);
    expect(queue.inFlight("h")).toBe(1);
    expect(queue.waiting("h")).toBe(0);
  });

  it("haelt Schluessel auseinander: ein voller Host haelt keinen anderen auf", () => {
    const queue = createOpenQueue(1);
    const a = queue.enter("h1", vi.fn());
    const onB = vi.fn();
    queue.enter("h1", onB);
    const c = queue.enter("h2", vi.fn());
    expect(c.granted).toBe(true);
    expect(queue.inFlight("h1")).toBe(1);
    expect(queue.inFlight("h2")).toBe(1);
    // Ein frei werdender Platz des einen Hosts geht nie an den anderen.
    c.release();
    expect(onB).not.toHaveBeenCalled();
    expect(queue.inFlight("h2")).toBe(0);
    a.release();
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("ein wartendes Ticket verlaesst beim Freigeben die Schlange und bekommt nie einen Platz", () => {
    const queue = createOpenQueue(1);
    const a = queue.enter("h", vi.fn());
    const onB = vi.fn();
    const b = queue.enter("h", onB);
    const onC = vi.fn();
    const c = queue.enter("h", onC);
    b.release();
    expect(queue.waiting("h")).toBe(1);
    expect(queue.inFlight("h")).toBe(1);
    a.release();
    expect(onB).not.toHaveBeenCalled();
    expect(b.granted).toBe(false);
    expect(onC).toHaveBeenCalledTimes(1);
    expect(c.granted).toBe(true);
    expect(queue.inFlight("h")).toBe(1);
    expect(queue.waiting("h")).toBe(0);
  });

  it("gibt ein zugeteiltes Ticket frei, geht der Platz noch innerhalb von release() an den naechsten", () => {
    const queue = createOpenQueue(1);
    const seen: string[] = [];
    const a = queue.enter("h", vi.fn());
    const b: OpenTicket = queue.enter("h", () => {
      // Der Rueckruf sieht schon den neuen Stand.
      seen.push(`zugeteilt=${b.granted} inFlight=${queue.inFlight("h")} waiting=${queue.waiting("h")}`);
    });
    a.release();
    seen.push("nach release");
    expect(seen).toEqual(["zugeteilt=true inFlight=1 waiting=0", "nach release"]);
    // Nach dem Freigeben bleibt `granted` stehen.
    expect(a.granted).toBe(true);
  });

  it("ein zweites release ist wirkungslos, fuer zugeteilte wie fuer wartende Tickets", () => {
    const queue = createOpenQueue(1);
    const a = queue.enter("h", vi.fn());
    const onB = vi.fn();
    const b = queue.enter("h", onB);
    const onC = vi.fn();
    const c = queue.enter("h", onC);
    const onD = vi.fn();
    const d = queue.enter("h", onD);
    a.release();
    a.release();
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onC).not.toHaveBeenCalled();
    expect(queue.inFlight("h")).toBe(1);
    expect(queue.waiting("h")).toBe(2);
    d.release();
    d.release();
    expect(queue.waiting("h")).toBe(1);
    b.release();
    b.release();
    expect(onC).toHaveBeenCalledTimes(1);
    expect(queue.inFlight("h")).toBe(1);
    c.release();
    expect(onD).not.toHaveBeenCalled();
    expect(queue.inFlight("h")).toBe(0);
    expect(queue.waiting("h")).toBe(0);
  });

  it("ein Rueckruf, der selbst eintritt und einen anderen Platz freigibt, verdirbt die Zaehler nicht", () => {
    const queue = createOpenQueue(2);
    const a = queue.enter("h", vi.fn());
    const b = queue.enter("h", vi.fn());
    const entered: OpenTicket[] = [];
    const onE = vi.fn();
    // Wartend: c, dann d. Bekommt c seinen Platz, reiht es e ein und gibt b frei.
    const c = queue.enter("h", () => {
      entered.push(queue.enter("h", onE));
      b.release();
    });
    const onD = vi.fn();
    const d = queue.enter("h", onD);
    a.release();
    expect([c.granted, d.granted, entered[0].granted]).toEqual([true, true, false]);
    expect(onD).toHaveBeenCalledTimes(1);
    expect(onE).not.toHaveBeenCalled();
    expect(queue.inFlight("h")).toBe(2);
    expect(queue.waiting("h")).toBe(1);
    c.release();
    expect(onE).toHaveBeenCalledTimes(1);
    expect(queue.inFlight("h")).toBe(2);
    expect(queue.waiting("h")).toBe(0);
    d.release();
    entered[0].release();
    expect(queue.inFlight("h")).toBe(0);
    expect(queue.waiting("h")).toBe(0);
  });

  it("gibt ein Rueckruf seinen eigenen Platz gleich zurueck, geht er an den naechsten Wartenden", () => {
    // So entsorgt der Aufrufer eine Ansicht, deren Platz gerade zugeteilt wurde.
    const queue = createOpenQueue(1);
    const a = queue.enter("h", vi.fn());
    const b: OpenTicket = queue.enter("h", () => b.release());
    const onC = vi.fn();
    queue.enter("h", onC);
    a.release();
    expect(b.granted).toBe(true);
    expect(onC).toHaveBeenCalledTimes(1);
    expect(queue.inFlight("h")).toBe(1);
    expect(queue.waiting("h")).toBe(0);
  });
});
