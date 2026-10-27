// scripts/bump-version.mjs  -- Aufruf: node scripts/bump-version.mjs 0.1.1
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Fuenf Dateien tragen die Version. npm schreibt die ersten beiden selbst,
// cargo die letzte; die beiden in der Mitte ersetzt dieses Skript per Regex.
const PACKAGE_JSON = "package.json";
const PACKAGE_LOCK = "package-lock.json";
const TAURI_CONF = "src-tauri/tauri.conf.json";
const CARGO_TOML = "src-tauri/Cargo.toml";
const CARGO_LOCK = "Cargo.lock";
const FILES = [PACKAGE_JSON, PACKAGE_LOCK, TAURI_CONF, CARGO_TOML, CARGO_LOCK];

const CONF_VERSION = /"version": "[^"]+"/;
const CARGO_VERSION = /^version = "[^"]+"/m;

/** Anzahl Treffer von `pattern` in `text`, unabhaengig vom g-Flag. */
function countMatches(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return (text.match(new RegExp(pattern.source, flags)) ?? []).length;
}

/** `text` als woertlicher Teil eines regulaeren Ausdrucks. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Traegt `lockText` (eine Cargo.lock) fuer das Paket `crateName` genau die
 * Version `version`? Name und Version gehen maskiert in den Ausdruck ein: ein
 * Punkt der Version passt nur auf einen Punkt, nicht auf jedes Zeichen.
 */
export function cargoLockHasVersion(lockText, crateName, version) {
  const entry = new RegExp(
    `^name = "${escapeRegExp(crateName)}"\\r?\\nversion = "${escapeRegExp(version)}"`,
    "m",
  );
  return entry.test(lockText);
}

function main() {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("Aufruf: node scripts/bump-version.mjs <major.minor.patch>");
    process.exit(1);
  }

  // Schnappschuss ALLER fuenf Dateien vor dem ersten Schreibzugriff. Scheitert
  // unten irgendein Schritt, kommt jede Datei auf diesen Stand zurueck; ein
  // halb gebumpter Baum entsteht so nicht, egal welcher Schritt bricht.
  const before = new Map(FILES.map((file) => [file, readFileSync(file, "utf8")]));
  function restoreAll() {
    for (const [file, text] of before) writeFileSync(file, text);
  }

  // 1. Erst pruefen, nichts schreiben. Kein Treffer waere ein still
  //    uebersprungenes Feld (etwa nach einer Umbenennung des Schluessels), mehr
  //    als einer eine Ersetzung an unbekannter Stelle -- beides bricht hier ab.
  for (const [file, pattern] of [
    [TAURI_CONF, CONF_VERSION],
    [CARGO_TOML, CARGO_VERSION],
  ]) {
    const count = countMatches(before.get(file), pattern);
    if (count !== 1) {
      console.error(
        `${file}: erwartet genau einen Treffer fuer ${pattern}, gefunden: ${count}. Abgebrochen, nichts geschrieben.`,
      );
      process.exit(1);
    }
  }

  // Der Paketname aus Cargo.toml, damit die Cargo.lock-Gegenprobe unten eine
  // Umbenennung des Crates ueberlebt.
  const crateName = /^name = "([^"]+)"/m.exec(before.get(CARGO_TOML))?.[1];
  if (!crateName) {
    console.error(`${CARGO_TOML}: kein Paketname gefunden. Abgebrochen, nichts geschrieben.`);
    process.exit(1);
  }

  // 2. Dann schreiben, in Abhaengigkeitsreihenfolge: `cargo update` liest die
  //    Version aus Cargo.toml und traegt sie in Cargo.lock ein. Es muss also
  //    NACH der Ersetzung in Cargo.toml laufen, sonst bleibt Cargo.lock auf
  //    der alten Version und `cargo test --locked` bricht ab.
  try {
    execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, { stdio: "inherit" });
    writeFileSync(TAURI_CONF, before.get(TAURI_CONF).replace(CONF_VERSION, `"version": "${version}"`));
    writeFileSync(CARGO_TOML, before.get(CARGO_TOML).replace(CARGO_VERSION, `version = "${version}"`));
    execSync("cargo update --workspace --offline", { stdio: "inherit", cwd: "src-tauri" });

    // 3. Gegenprobe: steht die neue Version wirklich in Cargo.lock?
    if (!cargoLockHasVersion(readFileSync(CARGO_LOCK, "utf8"), crateName, version)) {
      throw new Error(`${CARGO_LOCK} traegt fuer ${crateName} nicht die Version ${version}`);
    }
  } catch (err) {
    restoreAll();
    console.error(`Bump abgebrochen, alle fuenf Dateien zurueckgesetzt: ${err.message}`);
    process.exit(1);
  }

  console.log(`Version ${version} in fuenf Dateien gesetzt. Jetzt CHANGELOG.md ergaenzen und committen.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
