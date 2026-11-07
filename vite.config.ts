import { defineConfig, type Plugin } from "vite";
import { execSync } from "node:child_process";

const host = process.env.TAURI_DEV_HOST;

// The browsers Vite 6 built for by default ("modules"). Vite 7 and 8 default
// to "baseline-widely-available" (Safari 16 and newer). The app needs macOS
// 12.4 (WebKit of Safari 15.5) and Android System WebView 105, so this target
// lies below what it supports; raising it changes the helpers in the bundle
// and with them the license evidence (THIRD_PARTY_LICENSES.md).
const TARGET = ["es2020", "edge88", "firefox78", "chrome87", "safari14"];

// Vite 8 drops every comment when it minifies, license notices included. The
// JS keeps its legal comments through rolldown (`comments.legal`). For CSS,
// lightningcss keeps only a `/*!` comment at the very start of a file, so
// this plugin collects the CSS comments that name a copyright (xterm.css) and
// puts them at the start of each CSS file after minification, as `/*!`.
// `scripts/check-dist-notices.mjs` checks the result after every build.
function keepCssLicenseComments(): Plugin {
  // Per module, so that a rebuild in watch mode forgets a removed comment.
  const notices = new Map<string, string[]>();
  return {
    name: "aidevbridge:keep-css-license-comments",
    apply: "build",
    transform(code, id) {
      const [file, query = ""] = id.split("?");
      // `?raw`, `?url` and `?inline` imports are already JS here.
      if (!file.endsWith(".css") || /(^|&)(raw|url|inline)(&|=|$)/.test(query)) return null;
      const found = (code.match(/\/\*[\s\S]*?\*\//g) ?? [])
        .filter((comment) => /copyright/i.test(comment))
        .map((comment) => comment.replace(/^\/\*[*!]?/, "/*!"));
      if (found.length > 0) notices.set(id, found);
      else notices.delete(id);
      return null;
    },
    // `post`: after Vite's own CSS plugin has written every CSS file, also
    // the single one of `build.cssCodeSplit: false`. Sorted by module, so the
    // order does not depend on the order of the transforms. The header is
    // not part of the hash in the file name: a change to a notice alone
    // keeps the name.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const ordered = [...notices].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const header = [...new Set(ordered.flatMap(([, found]) => found))].join("\n");
        if (header === "") return;
        for (const file of Object.values(bundle)) {
          if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
          const source = typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
          file.source = `${header}\n${source}`;
        }
      },
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
