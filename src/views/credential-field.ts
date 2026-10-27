// Passwort-/Passphrasenfeld fuer Hinweisleiste (sidebar.ts) und Erststart
// (first-run.ts), UI-v2-Spec §9.3/§11.3. Ein Modul, damit beide Wege dasselbe
// Feld, dieselbe Beschriftung und dieselbe Leer-Regel teilen.
import { t } from "../i18n/t";
import type { TranslationKey } from "../i18n/t";

export type CredentialKind = "passphrase" | "password";

export interface CredentialFieldOptions {
  kind: CredentialKind;
  /** `data-focus-key` fuer die Fokusrettung der Seitenleiste; der Erststart laesst es weg. */
  focusKey?: string;
}

export interface CredentialField {
  readonly kind: CredentialKind;
  readonly root: HTMLLabelElement;
  readonly input: HTMLInputElement;
  /** Getippter Wert, oder `undefined` bei leerem Feld -- ein leerer String
   * waere auf der Rust-Seite ein ANGEGEBENES leeres Geheimnis, kein Weglassen. */
  value(): string | undefined;
}

const LABEL: Record<CredentialKind, TranslationKey> = {
  passphrase: "sidebar.notice.passphrase.label",
  password: "sidebar.notice.password.label",
};

export function buildCredentialField(opts: CredentialFieldOptions): CredentialField {
  const root = document.createElement("label");
  root.className = "host-notice-passphrase credential-field";
  root.textContent = t(LABEL[opts.kind]);

  const input = document.createElement("input");
  input.type = "password";
  input.name = opts.kind;
  // Kein Browser-Autofill fuer SSH-Geheimnisse -- der Passwortmanager des
  // WebView hat hier nichts zu tun.
  input.autocomplete = "off";
  if (opts.focusKey !== undefined) input.dataset.focusKey = opts.focusKey;
  root.appendChild(input);

  return {
    kind: opts.kind,
    root,
    input,
    value() {
      return input.value.length > 0 ? input.value : undefined;
    },
  };
}
