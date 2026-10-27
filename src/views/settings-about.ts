// Einstellungen, Bereich "About" (Einstellungs-Spec §7): Produktname,
// Version, Commit, Lizenz und der Pfad von settings.toml (UX-Spec §9.1) in
// einer Karte. "Copy version info" legt dieselbe Zeile in die Zwischenablage,
// mit der auch "Copy diagnostics" beginnt (`appVersionLine`). Keine Liste der
// Fremdlizenzen -- die waere nur vollstaendig, wenn sie erzeugt wird (Spec §12).
import { t } from "../i18n/t";
import type { TranslationKey } from "../i18n/t";
import { icon } from "../icons";
import { appCommit, appVersion, appVersionLine } from "../version";

const COPIED_MS = 2000;

function row(labelKey: TranslationKey, value: string, modifiers: readonly string[] = []): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "settings-row";
  const label = document.createElement("dt");
  label.textContent = t(labelKey);
  const text = document.createElement("dd");
  text.className = ["settings-value", ...modifiers].join(" ");
  text.textContent = value;
  item.append(label, text);
  return item;
}

export interface AboutOptions {
  /** Pfad von settings.toml aus der ersten Antwort von `ui_settings`; `null`,
   * solange er unbekannt ist -- dann fehlt die Zeile, statt leer dazustehen. */
  settingsPath: string | null;
}

export function mountAboutSection(container: HTMLElement, opts: AboutOptions): { dispose(): void } {
  const card = document.createElement("div");
  card.className = "settings-card";

  const title = document.createElement("h3");
  title.className = "settings-card-title settings-card-title--rows";
  title.textContent = t("app.title");

  const rows = document.createElement("dl");
  rows.className = "settings-rows";
  rows.append(
    row("settings.about.version", appVersion()),
    row("settings.about.commit", appCommit(), ["settings-value--mono"]),
    row("settings.about.license", t("settings.about.licenseValue")),
  );
  // UX-Spec §9.1: markierbar und in Monospace -- wer die Datei sucht oder
  // sichert, kopiert den Pfad von hier.
  if (opts.settingsPath !== null) {
    rows.append(row("settings.about.settingsFile", opts.settingsPath, ["settings-value--mono", "settings-value--path"]));
  }

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn--secondary settings-copy";
  const copyIcon = document.createElement("span");
  copyIcon.className = "icon-box";
  copyIcon.appendChild(icon("copy"));
  const copyLabel = document.createElement("span");
  copyLabel.textContent = t("settings.about.copy");
  copy.append(copyIcon, copyLabel);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  copy.addEventListener("click", () => {
    // Ein Fehler bleibt still wie bei "Copy diagnostics" (sidebar.ts).
    void navigator.clipboard.writeText(appVersionLine()).then(
      () => {
        if (disposed) return;
        copyLabel.textContent = t("settings.about.copied");
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          copyLabel.textContent = t("settings.about.copy");
        }, COPIED_MS);
      },
      () => {},
    );
  });

  card.append(title, rows, copy);
  container.appendChild(card);

  return {
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      card.remove();
    },
  };
}
