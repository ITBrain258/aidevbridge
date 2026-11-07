// Zufallskennungen im Format einer UUID v4 (RFC 9562 §5.4).

/** Eine neue UUID v4 in Kleinbuchstaben. `crypto.randomUUID` gibt es erst
 * ab Safari 15.4 und Chrome 92 und nur in einem sicheren Kontext; die App
 * unterstuetzt macOS 11, dessen WKWebView noch Safari 14 sein kann
 * (`vite.config.ts`). Fehlt es, entsteht dieselbe Form aus
 * `crypto.getRandomValues`, das es ueberall gibt. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4 im oberen Halbbyte von Byte 6, Variante 10xx in Byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
