import { defineConfig } from "vite";
import { execSync } from "node:child_process";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // `__APP_VERSION__`/`__APP_COMMIT__`: globale Konstanten fuer
  // `src/version.ts` (Deklaration in `src/globals.d.ts`). `vitest.config.ts`
  // setzt dieselben Namen auf feste Testwerte -- diese Datei laeuft in
  // Tests nicht, `git rev-parse` waere dort nur unnoetige Umgebungslast.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
    __APP_COMMIT__: JSON.stringify(
      (() => {
        try {
          return execSync("git rev-parse --short HEAD").toString().trim();
        } catch {
          return "unknown";
        }
      })(),
    ),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // Ebenso ignoriert: `docs/` und `.superpowers/`. Beide enthalten
      // keinerlei Quelltext des Frontends, aber sehr wohl `.html`-Dateien
      // (Entwuerfe, Mockups). Eine Aenderung dort loeste bisher ein
      // vollstaendiges `page reload` des WebViews aus -- waehrend einer
      // laufenden Sitzung wirft das den gesamten Frontend-Zustand weg
      // (`AppState` aus `src/state/app-state.ts` samt Kacheln und Terminals),
      // WAEHREND das Rust-Backend seine Hosts und offenen PTY-Kanaele
      // behaelt. Frontend und Backend laufen danach auseinander, und die
      // Oberflaeche zeigt einen Zustand, den kein Bedienweg erzeugen kann.
      // Genau das ist am 2026-07-27 waehrend des Rauchgas-Tors passiert
      // und hat einen Befund vorgetaeuscht.
      //
      // `target/` ebenfalls: `cargo` legt sein Build-Verzeichnis im
      // Wurzelverzeichnis an, NICHT nur unter `src-tauri/` -- der
      // `src-tauri/**`-Ausschluss greift dafuer also nicht. Vite versuchte
      // dort `aidevbridge_lib.dll` zu ueberwachen, die waehrend eines
      // laufenden Baus vom Linker gehalten wird, und starb mit
      // `EBUSY: resource busy or locked`. Der Dev-Server kam damit gar
      // nicht erst hoch.
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/docs/**",
        "**/.superpowers/**",
      ],
    },
  },
}));
