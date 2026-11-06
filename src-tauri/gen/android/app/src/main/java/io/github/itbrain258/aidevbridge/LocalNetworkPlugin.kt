package io.github.itbrain258.aidevbridge

import android.app.Activity
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// Spec 2026-10-27 §7.3: Ab Android 17 sperrt das System fuer Apps mit
// targetSdk 37 jede Verbindung ins lokale Netz, bis der Nutzer diese
// Berechtigung erlaubt (Gruppe "Geraete in der Naehe"). Die Sperre gilt auch
// fuer die Sockets der Rust-Bibliothek. `src-tauri/src/local_network.rs` ruft
// die beiden Befehle vor dem Verbindungsaufbau auf.
private const val ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
private const val ALIAS = "localNetwork"

// Android 17 ist API 37. Davor gibt es die Berechtigung nicht, und INTERNET
// genuegt; eine Abfrage meldete dort fuer die unbekannte Berechtigung immer
// "abgelehnt".
private const val ANDROID_17 = 37

@TauriPlugin(permissions = [Permission(strings = [ACCESS_LOCAL_NETWORK], alias = ALIAS)])
class LocalNetworkPlugin(activity: Activity) : Plugin(activity) {
  private fun granted(): Boolean =
    Build.VERSION.SDK_INT < ANDROID_17 || getPermissionState(ALIAS) == PermissionState.GRANTED

  private fun answer(invoke: Invoke) {
    val result = JSObject()
    result.put("granted", granted())
    invoke.resolve(result)
  }

  /** Nur der Stand, ohne Dialog. */
  @Command
  fun checkLocalNetwork(invoke: Invoke) {
    answer(invoke)
  }

  /** Zeigt den Systemdialog, solange die Berechtigung fehlt. Hat der Nutzer
   * zweimal abgelehnt, antwortet Android ohne Dialog mit "abgelehnt"; dann
   * hilft nur noch die Einstellung der App. */
  @Command
  fun requestLocalNetwork(invoke: Invoke) {
    if (granted()) {
      answer(invoke)
    } else {
      requestPermissionForAlias(ALIAS, invoke, "localNetworkAnswered")
    }
  }

  @PermissionCallback
  private fun localNetworkAnswered(invoke: Invoke) {
    answer(invoke)
  }
}
