// Einstellungen, Bereich "General" (UX-Spec §9.1): eine Karte "Startup" mit dem
// Schalter "Restore hosts and terminals" (`ui.restore_workspace`, Standard an).
// Was der Schalter beim Start bewirkt, regelt UX-Spec §7.2; hier wird er nur
// angezeigt und gemeldet, main.ts schreibt ihn entprellt (§9.2).
import { t } from "../i18n/t";
import { settingsCard, switchRow } from "./settings-rows";

export interface GeneralOptions {
  /** "Restore hosts and terminals", wie in settings.toml gespeichert. */
  restoreWorkspace: boolean;
  /** Bei jedem Umschalten, mit dem neuen Wert. */
  onRestoreWorkspaceChange: (value: boolean) => void;
}

export function mountGeneralSection(container: HTMLElement, opts: GeneralOptions): { dispose(): void } {
  const root = document.createElement("div");
  root.className = "settings-general";

  const startup = settingsCard(t("settings.general.startup"));
  const restore = switchRow(
    t("settings.general.restore"),
    t("settings.general.restoreHint"),
    opts.restoreWorkspace,
    opts.onRestoreWorkspaceChange,
  );
  startup.rows.appendChild(restore.row);
  root.appendChild(startup.card);

  container.appendChild(root);
  return {
    dispose() {
      root.remove();
    },
  };
}
