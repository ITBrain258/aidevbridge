// Der versionCode der Android-App, wie Tauri ihn aus der Version ableitet
// (tauri.properties, von dort in build.gradle.kts):
// major * 1000000 + minor * 1000 + patch, also 0.3.1 -> 3001. Dieselbe Formel
// rechnet android.yml fuer die Store-Texte in bash. Hier steht sie einmal fuer
// alle Skripte: die Pruefung der gebauten APK (android-apk-identity.mjs), den
// Releasetext (release-notes.mjs) und den Test der Store-Texte
// (store-changelog.test.mjs).

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
