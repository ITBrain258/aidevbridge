import { defineConfig, type Plugin } from "vite";
import { execSync } from "node:child_process";

const host = process.env.TAURI_DEV_HOST;

// The browsers Vite 6 built for by default ("modules"). Vite 7 and 8 default
// to "baseline-widely-available" (Safari 16 and newer), but the app still
// supports macOS 11, whose WKWebView may be Safari 14 (macOS spec).
const TARGET = ["es2020", "edge88", "firefox78", "chrome87", "safari14"];

// Vite 8 drops every comment when it minifies, license notices included. The
// JS keeps its legal comments through rolldown (`comments.legal`). For CSS,
// lightningcss keeps only a `/*!` comment at the very start of a file, so
// this plugin collects the CSS comments that name a copyright (xterm.css) and
// puts them at the start of each CSS file after minification, as `/*!`.
function keepCssLicenseComments(): Plugin {
  const notices = new Set<string>();
  return {
    name: "aidevbridge:keep-css-license-comments",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null;
      for (const comment of code.match(/\/\*[\s\S]*?\*\//g) ?? []) {
        if (/copyright/i.test(comment)) notices.add(comment.replace(/^\/\*\*?/, "/*!"));
      }
      return null;
    },
    generateBundle(_options, bundle) {
      if (notices.size === 0) return;
      const header = `${[...notices].join("\n")}\n`;
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const source = typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
        file.source = header + source;
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [keepCssLicenseComments()],
  build: {
    target: TARGET,
    rolldownOptions: { output: { comments: { legal: true } } },
  },
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
