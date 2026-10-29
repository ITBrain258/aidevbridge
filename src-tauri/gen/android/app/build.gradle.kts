import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Signatur des Release-Baus mit dem Upload-Schluessel (Spec 2026-10-27 §6.2).
// Lokal aus `keystore.properties` neben settings.gradle (nicht im Repository,
// siehe .gitignore), in der CI aus den Umgebungsvariablen. Fehlt beides,
// bleibt der Release-Bau unsigniert; die Vorschau-Builds der CI brauchen
// keinen Schluessel.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

fun signingValue(property: String, env: String): String? =
    System.getenv(env)?.takeIf { it.isNotEmpty() } ?: keystoreProperties.getProperty(property)

android {
    compileSdk = 36
    // Dasselbe NDK wie fuer die Rust-Bibliothek (android.yml, NDK_VERSION);
    // es zieht auch die Symboltabelle fuer Play heraus (release unten).
    ndkVersion = "29.0.14206865"
    signingConfigs {
        val storePath = signingValue("storeFile", "ANDROID_KEYSTORE_PATH")
        if (storePath != null) {
            create("release") {
                storeFile = rootProject.file(storePath)
                storePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
            }
        }
    }
    namespace = "io.github.itbrain258.aidevbridge"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "io.github.itbrain258.aidevbridge"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            // Hier stand aus der Tauri-Vorlage `packaging { jniLibs
            // .keepDebugSymbols... }`. `packaging` gilt aber fuer alle
            // Build-Typen, nicht nur fuer diesen: Auch die Release-App behielt
            // die Symboltabelle, und fuer Play wurde nichts herausgezogen.
        }
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            // Die Symboltabelle der Rust-Bibliothek geht ins App Bundle, nicht
            // in die App: Play zeigt Abstuerze im nativen Teil dann mit
            // Funktionsnamen statt nur mit Adressen.
            ndk.debugSymbolLevel = "SYMBOL_TABLE"
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// Jede Java- und Kotlin-Bibliothek der App steht mit Version in
// `gradle.lockfile`; weicht die Aufloesung davon ab, bricht der Bau ab. Die
// Android-Lizenzauswahl bindet diese Datei (Spec 2026-10-27 §8): Eine neue
// oder geaenderte Bibliothek braucht eine neue Lizenzentscheidung.
// Neu schreiben: `gradlew :app:dependencies --write-locks`.
dependencyLocking {
    lockAllConfigurations()
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")