package io.github.itbrain258.aidevbridge

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Helle Symbole in Status- und Navigationsleiste: die App ist dunkel.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    // Spec 2026-10-27 §4.6: Ab targetSdk 35 zeichnet jede App unter Status-
    // und Navigationsleiste, und die Bildschirmtastatur verkleinert das Fenster
    // nicht mehr von selbst. Der WebView bekommt deshalb genau die freie
    // Flaeche: Leisten, Kamera-Aussparung und Tastatur werden zum Innenabstand
    // seines Elternelements. Oeffnet sich die Tastatur, wird er niedriger, das
    // Terminal passt Zeilen an, und die Touch-Leiste steht direkt darueber.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    if (savedInstanceState == null) warnAboutOldWebView()
  }

  // Die Oberflaeche braucht Android System WebView 105 oder neuer
  // (CSS :has() und :focus-visible, das Attribut inert). Unter Android 7 bis 9
  // kann eine aeltere bleiben, weil Google sie dort nicht mehr aktualisiert
  // oder das Geraet keinen Play Store hat. Dann sagt ein Dialog, was fehlt,
  // statt einer Oberflaeche ohne Fokusringe und mit durchlaessigen Dialogen.
  // Die App laeuft trotzdem weiter.
  private fun warnAboutOldWebView() {
    val webView = WebViewCompat.getCurrentWebViewPackage(this) ?: return
    val version = webView.versionName ?: return
    val major = version.substringBefore('.').toIntOrNull() ?: return
    if (major >= MIN_WEBVIEW_MAJOR) return
    AlertDialog.Builder(this)
      .setTitle(R.string.webview_outdated_title)
      .setMessage(getString(R.string.webview_outdated_message, version, MIN_WEBVIEW_MAJOR))
      .setPositiveButton(R.string.webview_outdated_update) { _, _ -> openStore(webView.packageName) }
      .setNegativeButton(android.R.string.cancel, null)
      .show()
  }

  private fun openStore(packageName: String) {
    for (uri in listOf("market://details?id=$packageName", "https://play.google.com/store/apps/details?id=$packageName")) {
      try {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
        return
      } catch (ignored: ActivityNotFoundException) {
        // Kein Play Store: dann die Seite im Browser, sonst nichts.
      }
    }
  }

  private companion object {
    const val MIN_WEBVIEW_MAJOR = 105
  }
}
