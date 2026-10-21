import { configDefaults, defineConfig } from "vitest/config";

// Separate von `vite.config.ts`: dessen `server.port`/`strictPort` sind fuer
// `cargo tauri dev` gedacht (fester Port 1420) und fuer Tests weder noetig
// noch gewuenscht. `environment: "jsdom"` gibt `terminal.test.ts` ein
// `document`/`window`, ohne dass `cargo tauri dev` je laufen muss -- die
// beiden hier geprueften Eigenschaften (Byte-Behandlung, Ack-Reihenfolge)
// haengen nicht von einem echten Renderer ab, siehe die Mocks dort.
export default defineConfig({
  // Auf oberster Ebene, nicht unter `test`: `define` ist eine Vite-Option
  // (vitest reicht seine Konfiguration an Vite durch), nicht eine von
  // vitest selbst gelesene. Feste Werte statt `vite.config.ts`s `git
  // rev-parse` -- Tests brauchen kein echtes Repo-HEAD, siehe
  // `src/version.test.ts`.
  define: {
    __APP_VERSION__: '"0.0.0-test"',
    __APP_COMMIT__: '"test"',
  },
  test: {
    environment: "jsdom",
    // Node 25+ (hier 26) exponiert standardmaessig ein globales
    // `localStorage` (Flag `--experimental-webstorage`, seit Node 25 an; ohne
    // `--localstorage-file` aktiv aber funktionsunfaehig: jeder Zugriff
    // wirft). Dieser Deskriptor liegt schon auf `globalThis`, BEVOR vitest
    // jsdoms `window`-Eigenschaften hinueberkopiert, und ueberdeckt damit
    // jsdoms echte `Storage`-Instanz -- `localStorage` in einem Test traf
    // dann Nodes kaputten Stub statt jsdoms Implementierung. `test.env`
    // setzt `NODE_OPTIONS` als Prozessumgebung der Worker, bevor der
    // Worker-Prozess selbst startet und die Variable auswertet; ein
    // `execArgv` unter `poolOptions` griff dagegen nicht (verifiziert).
    //
    // ANGEHAENGT statt gesetzt: ein `NODE_OPTIONS` aus der Umgebung (CI,
    // `--max-old-space-size`, ein Debugger) ging sonst still verloren.
    // Die Flagge gibt es erst ab Node 22.4 -- eine aeltere Laufzeit kennt sie
    // nicht und bricht den Worker beim Start ab. `package.json` verlangt
    // ohnehin Node 24 oder neuer (`engines.node`, wie README und
    // `scripts/release-windows-artifacts.mjs`); unter Node 24 ist Web Storage
    // noch aus, dort aendert die Flagge nichts.
    env: {
      NODE_OPTIONS: [
        // @ts-expect-error process is a nodejs global
        process.env.NODE_OPTIONS,
        "--no-experimental-webstorage",
      ]
        .filter(Boolean)
        .join(" "),
    },
    // `.claude/worktrees/` liegt INNERHALB des Projektverzeichnisses (so legt
    // die Worktree-Hilfe sie an, und `.gitignore` deckt sie ab). Vitests
    // Standardsuche findet die Testdateien eines Worktrees deshalb mit: nach
    // dem Bau von Paket 2 meldete `npm test` auf `main` 712 statt 356 Tests --
    // exakt das Doppelte, jede Datei zweimal.
    //
    // Harmlos, solange beide Seiten gruen sind, aber irrefuehrend: die Zahl
    // im Tor gehoert dann nicht mehr zu dem Baum, in dem man steht, und ein
    // Fehlschlag im Worktree faerbt das Tor von `main` rot. Ausserdem doppelte
    // Laufzeit.
    //
    // `configDefaults.exclude` wird mitgenommen, weil eine eigene
    // `exclude`-Liste die Vorgaben ERSETZT statt sie zu ergaenzen --
    // `node_modules/` und `dist/` fielen sonst wieder in die Suche.
    //
    // `scripts/*.test.mjs` benutzen `node:test`, nicht vitest; vitest meldete
    // sie als "No test suite found" und `npm test` endete rot. Sie laufen
    // ueber `npm run test:scripts`.
    exclude: [...configDefaults.exclude, "**/.claude/**", "scripts/**"],
    // vitests eingebautes `CSSEnablerPlugin` blendet JEDEN Import, dessen id
    // auf `.css` (gefolgt von Ende oder `?`) passt, standardmaessig zu
    // `export default ""` aus -- auch `?raw`-Importe, denn die Pruefung
    // gilt der Dateiendung, nicht der Query. `styles.test.ts`s
    // `import css from "./styles.css?raw"` bekam so leeren String
    // (`css.length === 0`), waehrend Vites eigene Pipeline (ausserhalb von
    // vitest, per `ssrLoadModule` nachgestellt) den echten Inhalt liefert.
    // `include` schaltet nur `?raw`-Importe frei, nicht pauschal alle
    // CSS-Importe: `main.test.ts` haengt ueber `./main` an `./terminal`,
    // das `@xterm/xterm/css/xterm.css` importiert -- dort mockt nur
    // `terminal.test.ts` diesen Import weg, ein globales `css: true`
    // liesse ihn in den anderen Dateien durch die echte Pipeline laufen.
    css: { include: [/\?raw\b/] },
  },
});
