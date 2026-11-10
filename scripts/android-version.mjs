// Der versionCode der Android-App, wie Tauri ihn aus der Version ableitet
// (tauri.properties, von dort in build.gradle.kts):
// major * 1000000 + minor * 1000 + patch, also 0.3.1 -> 3001. Hier steht die
// Formel einmal fuer die Skripte, die sie brauchen: die Pruefung der gebauten
// APK (android-apk-identity.mjs) und den Test der Store-Texte
// (store-changelog.test.mjs). android.yml rechnet sie fuer die Store-Texte
// noch einmal in bash (Job play); der Test der Store-Texte vergleicht jene
// Zeilen mit der Formel hier, damit die beiden Stellen gleich bleiben.

/**
 * @param {string} version
 * @returns {number}
 */
export function versionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unreadable version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return major * 1000000 + minor * 1000 + patch;
}
