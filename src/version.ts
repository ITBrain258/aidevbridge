// Version und Commit stammen aus Vites `define` (`vite.config.ts`), damit
// weder die Seitenleiste noch der Diagnosetext `package.json` oder `git`
// selbst anfassen muessen -- beides ist zur Laufzeit im WebView ohnehin
// nicht erreichbar. `vitest.config.ts` setzt dieselben Namen auf feste
// Testwerte, siehe `version.test.ts`.
export function appVersion(): string {
  return __APP_VERSION__;
}

export function appCommit(): string {
  return __APP_COMMIT__;
}

export function appVersionLine(): string {
  return `aidevbridge ${appVersion()} (${appCommit()})`;
}
