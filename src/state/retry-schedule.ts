// Wartezeiten fuer Wiederholungsreihen (UX-Spec §5.3, §5.4): hoechstens fuenf
// Versuche je Ausfall, nach 2, 5, 15, 30 und 60 s, je mit +-20 % Streuung.
// Die Streuung verhindert, dass mehrere Hosts nach demselben Netzabriss im
// Gleichschritt auf VM und ssh-agent einschlagen.

export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 15000, 30000, 60000];
export const RETRY_JITTER = 0.2;

/** Wartezeit vor Versuch `attempt` (0-basiert) oder null nach dem letzten. */
export function retryDelay(attempt: number, random: () => number = Math.random): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= RETRY_DELAYS_MS.length) return null;
  // Ganze Millisekunden: 2000 * 1.2 ist in Gleitkomma nicht genau 2400.
  return Math.round(RETRY_DELAYS_MS[attempt] * (1 + RETRY_JITTER * (2 * random() - 1)));
}
