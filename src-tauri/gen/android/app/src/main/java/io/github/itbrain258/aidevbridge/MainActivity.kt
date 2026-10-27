package io.github.itbrain258.aidevbridge

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

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
  }
}
