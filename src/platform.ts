// Laeuft die Oberflaeche auf Android (Spec 2026-10-27 §5)? Dort kommen die
// kompakte Ansicht, die Touch-Leiste und die Schluessel auf dem Geraet dazu,
// und es gibt keinen ssh-agent. Der Desktop sieht von alledem nichts.
//
// Erkannt am User-Agent des WebViews: Androids System-WebView traegt immer
// "Android", WebView2 unter Windows und WKWebView unter macOS nie. Eine
// Abfrage an das Backend braeuchte ein weiteres Recht und kaeme erst nach dem
// ersten Bild.

export function isAndroid(userAgent: string = navigator.userAgent): boolean {
  return /\bAndroid\b/.test(userAgent);
}
