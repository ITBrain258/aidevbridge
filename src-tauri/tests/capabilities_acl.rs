//! Die Command-Liste existiert fuenfmal, und die ersten drei sind
//! unvermeidbar: `generate_handler!` braucht Identifier, `build.rs` braucht
//! Strings, `capabilities/default.json` braucht kebab-case-Permission-Namen.
//! Die vierte ist das Fenster-Label in `tauri.conf.json`, die fuenfte die
//! `COMMANDS`-Liste in `acl_runtime.rs`. Dieser Test haelt sie zusammen.
//!
//! Er ist die maschinelle Fassung einer "Checkliste, die nicht veralten
//! darf": als Kommentar ist eine solche Liste bereits einmal lautlos
//! veraltet (eine dort notierte feste Zahl stimmte laengst nicht mehr).
//!
//! Braucht KEINE VM und keine Umgebungsvariable.

use std::collections::{BTreeMap, BTreeSet};

const LIB_RS: &str = include_str!("../src/lib.rs");
const BUILD_RS: &str = include_str!("../build.rs");
const CAPABILITY_JSON: &str = include_str!("../capabilities/default.json");
/// FUENFTE Liste: `acl_runtime.rs` fuehrt die Commands ein weiteres Mal, um
/// jeden einzeln durch den echten IPC-Pfad zu schicken.
///
/// Warum sie hier hereingezogen wird, statt sich auf ihren eigenen Test zu
/// verlassen: der dort iteriert ueber genau diese Liste. Ein Command, den
/// man dort VERGISST, wird also nie geprueft -- und der Test bleibt gruen.
/// Die Luecke ist unsichtbar, weil sie aus einer Abwesenheit besteht. Erst
/// dieser Gleichheitsvergleich macht das Vergessen rot.
const ACL_RUNTIME_RS: &str = include_str!("acl_runtime.rs");
/// Vierte Liste, die zur ACL gehoert, ohne dass man ihr das ansieht: das
/// Fenster-Label. Siehe `every_configured_window_is_covered_by_the_capability`.
/// Dieselbe Datei traegt die Content-Security-Policy, siehe
/// `both_content_security_policies_allow_only_what_the_frontend_loads`.
const TAURI_CONF_JSON: &str = include_str!("../tauri.conf.json");

/// Als Zahl im Test, nicht abgeleitet: ein neuer Command macht diesen Test
/// bewusst rot. Das ist der Zweck -- er soll jemanden zwingen, alle fuenf
/// Listen anzufassen, nicht sich stillschweigend anpassen.
const EXPECTED_COMMAND_COUNT: usize = 26;

/// Extrahiert die Commands aus `generate_handler![...]`.
///
/// Auf den Block BEGRENZT, nicht ueber die ganze Datei: `lib.rs` enthaelt
/// `commands::AppState::from_env()` in der `.manage(..)`-Zeile. Ein naiver
/// `commands::(\w+)`-Scan wuerde `AppState` als Command extrahieren und
/// `allow-app-state` fordern -- ein gruener, blinder Test waere die Folge
/// (siehe `extraction_is_limited_to_the_handler_block` unten).
fn handler_commands() -> BTreeSet<String> {
    let start = LIB_RS
        .find("generate_handler![")
        .expect("generate_handler! nicht in lib.rs gefunden -- Extraktion kaputt");
    let block = &LIB_RS[start..];
    let end = block
        .find("])")
        .expect("Ende des generate_handler!-Blocks nicht gefunden");
    block[..end]
        .lines()
        // Kommentarzeilen ausfiltern: der Block enthaelt einen Kommentar, der
        // selbst "capabilities/default.json" und "allow-" erwaehnt.
        .filter(|line| !line.trim_start().starts_with("//"))
        .filter_map(|line| line.trim().strip_prefix("commands::"))
        .map(|rest| rest.trim_end_matches(',').trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

/// Extrahiert die Strings aus `.commands(&[ ... ])` in `build.rs`.
fn build_rs_commands() -> BTreeSet<String> {
    let start = BUILD_RS
        .find(".commands(&[")
        .expect(".commands(&[ nicht in build.rs gefunden -- Extraktion kaputt");
    let block = &BUILD_RS[start..];
    let end = block
        .find("])")
        .expect("Ende der .commands-Liste nicht gefunden");
    block[..end]
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .flat_map(|line| {
            line.split('"')
                .enumerate()
                .filter(|(index, _)| index % 2 == 1)
                .map(|(_, value)| value.to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Extrahiert die `allow-`Permissions aus `default.json` und macht sie
/// wieder zu snake_case-Command-Namen.
///
/// `strip_prefix` statt `contains`: `core:event:allow-listen` ENTHAELT
/// "allow-", beginnt aber nicht damit -- ein `contains` wuerde diesen
/// Core-Eintrag faelschlich als eigenen Command lesen.
fn capability_allowed_commands() -> BTreeSet<String> {
    let value: serde_json::Value =
        serde_json::from_str(CAPABILITY_JSON).expect("default.json ist kein gueltiges JSON");
    value["permissions"]
        .as_array()
        .expect("permissions-Array fehlt in default.json")
        .iter()
        .filter_map(|entry| entry.as_str())
        .filter_map(|entry| entry.strip_prefix("allow-"))
        .map(|kebab| kebab.replace('-', "_"))
        .collect()
}

/// Die `permissions`-Eintraege aus `default.json` ROH, ohne Filter und ohne
/// Umschreibung.
///
/// Bewusst neben `capability_allowed_commands()` statt darin: jene Funktion
/// beantwortet "welche Commands sind erlaubt?" und muss dafuer alles
/// wegwerfen, was kein `allow-<command>` ist. Genau dieses Wegwerfen macht
/// sie fuer die beiden Zusicherungen unten blind (ein `deny-`Eintrag, ein
/// fehlender Core-Eintrag), deshalb lesen die die Liste selbst.
fn capability_permission_entries() -> Vec<String> {
    let value: serde_json::Value =
        serde_json::from_str(CAPABILITY_JSON).expect("default.json ist kein gueltiges JSON");
    value["permissions"]
        .as_array()
        .expect("permissions-Array fehlt in default.json")
        .iter()
        .filter_map(|entry| entry.as_str())
        .map(|entry| entry.to_string())
        .collect()
}

/// Ob `entry` eine Sperre ist -- `deny-connect-host` ebenso wie
/// `core:event:deny-listen`. Der Praefix steht jeweils am LETZTEN
/// `:`-Segment, ein blosses `starts_with("deny-")` uebersaehe die
/// Core-Variante.
fn is_deny_entry(entry: &str) -> bool {
    entry
        .rsplit(':')
        .next()
        .is_some_and(|last| last.starts_with("deny-"))
}

/// Extrahiert die Strings aus `const COMMANDS: &[&str] = &[ ... ]` in
/// `acl_runtime.rs` -- der fuenften Liste.
fn acl_runtime_commands() -> BTreeSet<String> {
    let start = ACL_RUNTIME_RS
        .find("const COMMANDS: &[&str] = &[")
        .expect("COMMANDS-Liste nicht in acl_runtime.rs gefunden -- Extraktion kaputt");
    let block = &ACL_RUNTIME_RS[start..];
    let end = block
        .find("];")
        .expect("Ende der COMMANDS-Liste nicht gefunden");
    block[..end]
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .flat_map(|line| {
            line.split('"')
                .enumerate()
                .filter(|(index, _)| index % 2 == 1)
                .map(|(_, value)| value.to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn all_five_command_lists_agree() {
    let handler = handler_commands();
    let build = build_rs_commands();
    let capability = capability_allowed_commands();
    let acl_runtime = acl_runtime_commands();

    // Leere Mengen sind gleich -- ohne diese drei Zusicherungen waere der
    // Test gruen, sobald eine Extraktion nichts mehr findet (umbenannte
    // Tauri-API, geaenderte Formatierung).
    assert!(
        !handler.is_empty(),
        "Extraktion aus lib.rs lieferte nichts -- Blockgrenze oder Praefix kaputt"
    );
    assert!(
        !build.is_empty(),
        "Extraktion aus build.rs lieferte nichts -- Blockgrenze kaputt"
    );
    assert!(
        !capability.is_empty(),
        "Extraktion aus default.json lieferte nichts -- fehlen die allow-Eintraege?"
    );
    assert!(
        !acl_runtime.is_empty(),
        "Extraktion aus acl_runtime.rs lieferte nichts -- COMMANDS-Liste umbenannt?"
    );

    assert_eq!(
        handler.len(),
        EXPECTED_COMMAND_COUNT,
        "generate_handler! listet {} Commands, erwartet {EXPECTED_COMMAND_COUNT}. Kommt ein \
         Command hinzu, sind ALLE FUENF Listen zu ergaenzen -- und diese Zahl.",
        handler.len()
    );
    assert_eq!(
        handler, build,
        "generate_handler! (lib.rs) und .commands(&[..]) (build.rs) laufen auseinander. \
         build.rs bestimmt, was ins ACL-Manifest kommt -- eine Abweichung hier heisst, dass \
         ein registrierter Command zur Laufzeit abgelehnt wird."
    );
    assert_eq!(
        handler, capability,
        "generate_handler! (lib.rs) und die allow-Eintraege (default.json) laufen auseinander. \
         Ein fehlender Eintrag ist die EINE Richtung, die der Build nicht selbst faengt."
    );
    assert_eq!(
        handler, acl_runtime,
        "generate_handler! (lib.rs) und die COMMANDS-Liste in acl_runtime.rs laufen \
         auseinander. Das ist die stillste der fuenf Abweichungen: acl_runtime.rs iteriert \
         ueber SEINE Liste -- ein dort vergessener Command wird nie durch den echten \
         IPC-Pfad geschickt, und sein Test bleibt trotzdem gruen. Die Luecke besteht aus \
         einer Abwesenheit; nur dieser Vergleich macht sie sichtbar."
    );
}

/// Kein `deny-`Eintrag in `default.json`.
///
/// `all_three_command_lists_agree` kann das NICHT sehen: es liest die
/// Berechtigungen ueber `strip_prefix("allow-")`, ein `deny-connect-host`
/// faellt dort durchs Raster. Alle fuenf Listen blieben deckungsgleich, der
/// Build bliebe gruen -- und `connect_host` waere zur Laufzeit gesperrt.
/// Genau die stille Laufzeit-Ablehnung, gegen die diese Datei existiert,
/// reproduziert innerhalb ihres eigenen Netzes.
///
/// `deny-<command>` ist dabei kein Tippfehler, sondern ein GUELTIGER
/// Bezeichner: `autogenerate_command_permissions` erzeugt zu jedem Command
/// beide Haelften. Nachgesehen in `gen/schemas/acl-manifests.json`, Knoten
/// `__app-acl__.permissions` -- dort steht neben `allow-connect-host` auch
/// `deny-connect-host` mit `commands.deny = ["connect_host"]`.
/// `validate_capabilities` nimmt ihn folglich an -- in der Gegenprobe zu
/// diesem Test nachgestellt: mit `deny-connect-host` in `default.json` lief
/// der Build durch und NUR dieser Test wurde rot.
///
/// Eigener Test statt einer weiteren Zusicherung in
/// `all_three_command_lists_agree`: "ein Eintrag SPERRT einen Command" ist
/// eine andere Diagnose als "die fuenf Listen laufen auseinander" -- unter
/// jenem Namen gemeldet wuerde die Diagnose in die falsche Richtung schicken.
#[test]
fn no_deny_entry_shadows_a_command() {
    let entries = capability_permission_entries();
    // Ohne diese Zusicherung waere der Test gruen, sobald die Extraktion
    // nichts mehr liefert (umbenanntes Feld, kaputtes JSON-Layout) -- die
    // Suche unten liefe dann ueber eine leere Liste.
    assert!(
        !entries.is_empty(),
        "Extraktion der permissions aus default.json lieferte nichts -- Feldname geaendert?"
    );
    let denies: Vec<&String> = entries
        .iter()
        .filter(|entry| is_deny_entry(entry))
        .collect();
    assert!(
        denies.is_empty(),
        "deny-Eintraege in capabilities/default.json: {denies:?}. Ein deny sperrt den Command \
         zur Laufzeit, ohne dass eine der fuenf Listen abweicht -- der Build bleibt gruen, der \
         WebView bekommt nur eine abgelehnte Promise."
    );
}

/// Die Eintraege, die keine App-Commands sind, sind GENAU die Core- und
/// Plugin-Rechte, die das Frontend aufruft -- nicht mehr und nicht weniger.
///
/// `all_five_command_lists_agree` sieht diese Eintraege nicht: sein
/// `strip_prefix("allow-")` wirft alles weg, was nicht mit `allow-` beginnt.
///
/// Weniger waere still kaputt: ohne `core:event:allow-listen` kommen
/// `terminal://output` und `terminal://connection-lost` nie im Frontend an
/// (`src/terminal.ts`), das Terminal rendert nichts -- ohne Build- und ohne
/// Testfehler. Dasselbe gilt fuer `unlisten`, Fenstertitel,
/// Taskleisten-Hinweis und Dateiauswahl (`src/main.ts`,
/// `src/views/host-form.ts`).
///
/// Mehr waere still zu viel: ein Sammelrecht wie `core:default` oder
/// `dialog:default` gibt dem WebView Befehle, die er nie aufruft (`emit`,
/// Menue, Tray, Pfadaufloesung, Nachrichten- und Speicherdialog). Deshalb
/// wird die Menge woertlich verglichen; jede Erweiterung macht diesen Test
/// rot und ist damit eine Entscheidung statt eines Nebeneffekts. Dass die
/// Laufzeit genau diese Rechte durchlaesst und den Rest von `core:default`
/// ablehnt, belegt `tests/acl_runtime.rs`.
///
/// `core:webview:allow-internal-toggle-devtools` gehoert dazu, weil Tauri im
/// Debug-Bau ein Skript einspielt, das Ctrl+Shift+I ueber
/// `plugin:webview|internal_toggle_devtools` aufruft. Den Command
/// registriert Tauri nur unter `cfg(any(debug_assertions, feature =
/// "devtools"))` (tauri-2.11.5/src/webview/plugin.rs), und `Cargo.toml`
/// schaltet `devtools` nicht ein: im Release-Bau erlaubt der Eintrag einen
/// Command, den es dort nicht gibt.
///
/// Ein Eintrag als Objekt (`{"identifier": ..., "allow": [...]}`) ist
/// ebenfalls eine Erweiterung, sogar mit eigenem Scope.
/// `capability_permission_entries()` ueberspringt solche Eintraege, deshalb
/// prueft dieser Test sie selbst.
#[test]
fn the_core_permissions_the_webview_needs_are_present() {
    let value: serde_json::Value =
        serde_json::from_str(CAPABILITY_JSON).expect("default.json ist kein gueltiges JSON");
    let not_plain: Vec<&serde_json::Value> = value["permissions"]
        .as_array()
        .expect("permissions-Array fehlt in default.json")
        .iter()
        .filter(|entry| !entry.is_string())
        .collect();
    assert!(
        not_plain.is_empty(),
        "Eintraege als Objekt in capabilities/default.json: {not_plain:?}. Sie erweitern die \
         Rechte des WebViews (mit Scope) an dieser Liste vorbei."
    );

    let entries = capability_permission_entries();
    assert!(
        !entries.is_empty(),
        "Extraktion der permissions aus default.json lieferte nichts -- Feldname geaendert?"
    );
    let actual: BTreeSet<&str> = entries
        .iter()
        .map(String::as_str)
        .filter(|entry| !entry.starts_with("allow-"))
        .collect();
    let expected: BTreeSet<&str> = [
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-set-title",
        "core:window:allow-request-user-attention",
        "core:webview:allow-internal-toggle-devtools",
        "dialog:allow-open",
    ]
    .into_iter()
    .collect();

    let missing: Vec<&&str> = expected.difference(&actual).collect();
    let extra: Vec<&&str> = actual.difference(&expected).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "Die Core- und Plugin-Rechte in capabilities/default.json weichen ab.\n\
         Fehlt (das Frontend ruft es auf, im Fenster waere es eine abgelehnte Promise): \
         {missing:?}\n\
         Zu viel (das Frontend ruft es nie auf): {extra:?}"
    );
}

/// Die Fenster-Labels aus `tauri.conf.json`, mit Tauris Vorgabe fuer den
/// fehlenden Schluessel.
///
/// `"main"` ist nicht geraten: `WindowConfig::label` traegt
/// `#[serde(default = "default_window_label")]`, und `default_window_label()`
/// liefert `"main"` (tauri-utils-2.9.3/src/config.rs:1919 bzw. 2362-2364).
/// Ein Fenster ohne `label`-Schluessel heisst zur Laufzeit also `main`.
fn configured_window_labels() -> Vec<String> {
    let value: serde_json::Value =
        serde_json::from_str(TAURI_CONF_JSON).expect("tauri.conf.json ist kein gueltiges JSON");
    value["app"]["windows"]
        .as_array()
        .expect("app.windows fehlt in tauri.conf.json")
        .iter()
        .map(|window| window["label"].as_str().unwrap_or("main").to_string())
        .collect()
}

/// Jedes konfigurierte Fenster steht im `windows`-Feld der Capability.
///
/// Das Label ist die VIERTE Liste, die zur ACL gehoert, und die einzige, die
/// nicht nach einer Liste aussieht. Heute passt sie: `tauri.conf.json` hat
/// ein Fenster ohne `label`-Schluessel (also `main`), die Capability nennt
/// `["main"]`.
///
/// Solange die ACL nicht scharf war, kostete eine Abweichung nichts. Jetzt
/// ist sie tragend: Die Capability gilt nur fuer Fenster, deren Label eines
/// ihrer Muster trifft (`tauri-2.11.5/src/ipc/authority.rs:460`) -- bekommt
/// das Fenster ein ausdrueckliches, abweichendes `label`, sind ALLE neunzehn
/// Commands dort abgelehnt, sichtbar nur als unerklaerte Promise-Rejections
/// im WebView. Ein ausdrueckliches Label schreibt man genau dann hin, wenn
/// ein ZWEITES Fenster dazukommt -- also bei Seitenleiste und mehreren
/// gleichzeitigen Sessions, dem naechsten Plan.
///
/// Verglichen wird woertlich, obwohl die Capability Glob-Muster erlaubt
/// (`windows: Vec<String>`, "Can be a glob pattern",
/// tauri-utils-2.9.3/src/acl/capability.rs:150-163). Ein bewusst gesetztes
/// `"main-*"` macht diesen Test also rot, obwohl es zur Laufzeit passen
/// wuerde. Das ist gewollt: dann ist hier eine Entscheidung zu treffen
/// (Muster ausdruecklich zulassen), statt dass die Deckung stillschweigend
/// unschaerfer wird.
#[test]
fn every_configured_window_is_covered_by_the_capability() {
    let labels = configured_window_labels();
    let capability: serde_json::Value =
        serde_json::from_str(CAPABILITY_JSON).expect("default.json ist kein gueltiges JSON");
    let covered: Vec<String> = capability["windows"]
        .as_array()
        .expect("windows-Array fehlt in default.json -- ohne es gilt die Capability fuer KEIN Fenster mit Label-Filter")
        .iter()
        .filter_map(|entry| entry.as_str())
        .map(|entry| entry.to_string())
        .collect();

    // Beide Listen ausdruecklich nicht leer: "jedes Fenster ist gedeckt"
    // waere sonst wahr, sobald eine der beiden Extraktionen nichts findet.
    assert!(
        !labels.is_empty(),
        "keine Fenster in tauri.conf.json gefunden -- app.windows leer oder Layout geaendert"
    );
    assert!(
        !covered.is_empty(),
        "windows-Liste der Capability ist leer -- dann deckt sie kein Fenster ausdruecklich ab"
    );

    for label in &labels {
        assert!(
            covered.contains(label),
            "Fenster {label:?} aus tauri.conf.json fehlt in der windows-Liste von \
             capabilities/default.json ({covered:?}). Dort sind alle registrierten Commands \
             abgelehnt -- im WebView nur als abgelehnte Promise sichtbar, ohne Build- und \
             ohne Testfehler."
        );
    }
}

/// Gegenprobe zur Extraktionsfalle, als Test statt als Kommentar: die
/// `.manage(commands::AppState::from_env())`-Zeile darf nicht als Command
/// gelesen werden. (Bis zur UX-Ueberarbeitung stand dort
/// `AppState::default()`; `from_env` liest im Debug-Bau den Testsocket,
/// Spec §9.3. Die Falle ist dieselbe.)
#[test]
fn extraction_is_limited_to_the_handler_block() {
    assert!(
        LIB_RS.contains("commands::AppState::from_env()"),
        "Voraussetzung dieses Tests ist entfallen -- lib.rs enthaelt die manage-Zeile nicht \
         mehr. Dann ist die Blockbegrenzung in handler_commands() ggf. nicht mehr noetig, \
         aber pruefe das bewusst, statt diesen Test zu loeschen."
    );
    assert!(
        !handler_commands()
            .iter()
            .any(|name| name.contains("AppState")),
        "AppState ist kein Command -- die Extraktion greift ausserhalb des \
         generate_handler!-Blocks"
    );
}

/// Zerlegt eine Content-Security-Policy in Direktive -> Quellen.
///
/// Doppelte Direktiven sind ein Fehler, keine Kleinigkeit: der Browser
/// wertet nur die ERSTE aus, eine Map behielte die letzte -- der Test
/// pruefte dann eine andere Policy als die, die gilt.
fn csp_directives(policy: &str) -> BTreeMap<String, Vec<String>> {
    let mut directives = BTreeMap::new();
    for directive in policy.split(';').map(str::trim).filter(|d| !d.is_empty()) {
        let mut parts = directive.split_whitespace();
        let name = parts
            .next()
            .expect("nicht leere Direktive ohne Namen")
            .to_string();
        let sources: Vec<String> = parts.map(str::to_string).collect();
        assert!(
            directives.insert(name.clone(), sources).is_none(),
            "Direktive {name} steht doppelt in der CSP {policy:?}; der Browser wertet nur die \
             erste aus."
        );
    }
    directives
}

/// `csp` und `devCsp` erlauben nur, was das Frontend wirklich laedt, und
/// sperren die Ziele, die es nie braucht.
///
/// - `base-uri 'none'`: kein `<base>` kann relative URLs (Skripte,
///   Stylesheets) auf eine fremde Herkunft umlenken. `default-src` deckt
///   `base-uri` NICHT ab.
/// - `form-action 'none'`: beide Formulare (`src/views/host-form.ts`,
///   `src/views/session-dialog.ts`) rufen beim Absenden `preventDefault()`
///   auf, keines schickt je etwas ab. Auch `form-action` erbt nicht von
///   `default-src`.
/// - `object-src 'none'`: kein `<object>`/`<embed>` im Frontend.
/// - kein `blob:`: das Frontend und die xterm-Addons starten keinen Worker
///   und erzeugen keine Objekt-URLs; ohne `worker-src` gilt fuer Worker
///   `script-src 'self'`.
/// - `font-src` ohne `data:`: keine `@font-face` im Frontend und in xterm.
/// - `img-src` BEHAELT `data:`: `src/styles.css` zeichnet ein Warnsymbol als
///   `mask: url("data:image/svg+xml,...")`; ohne `data:` verschwindet es
///   lautlos.
/// - `connect-src` bleibt woertlich, was der IPC-Kanal (und im Dev-Modus
///   der Vite-Server samt HMR-Websocket) braucht: ohne `ipc:` und
///   `http://ipc.localhost` scheitert jeder `invoke`.
///
/// `style-src 'unsafe-inline'` bleibt bewusst stehen, xterm setzt Styles
/// inline; dieser Test sagt dazu nichts.
#[test]
fn both_content_security_policies_allow_only_what_the_frontend_loads() {
    let config: serde_json::Value =
        serde_json::from_str(TAURI_CONF_JSON).expect("tauri.conf.json ist kein gueltiges JSON");
    let security = &config["app"]["security"];
    for (key, expected_connect_src) in [
        ("csp", "ipc: http://ipc.localhost"),
        (
            "devCsp",
            "ipc: http://ipc.localhost http://localhost:1420 ws://localhost:1420 \
             ws://localhost:1421",
        ),
    ] {
        let policy = security[key]
            .as_str()
            .unwrap_or_else(|| panic!("app.security.{key} fehlt in tauri.conf.json"));
        let directives = csp_directives(policy);
        let sources = |name: &str| -> Vec<&str> {
            directives
                .get(name)
                .unwrap_or_else(|| panic!("{key}: Direktive {name} fehlt in {policy:?}"))
                .iter()
                .map(String::as_str)
                .collect()
        };

        for closed in ["base-uri", "form-action", "object-src"] {
            assert_eq!(
                sources(closed),
                ["'none'"],
                "{key}: {closed} muss 'none' sein -- default-src deckt base-uri und \
                 form-action nicht ab."
            );
        }
        assert!(
            !policy.contains("blob:"),
            "{key}: blob: erlaubt Worker und Objekt-URLs, die das Frontend nicht braucht: \
             {policy:?}"
        );
        assert!(
            !sources("font-src").contains(&"data:"),
            "{key}: font-src erlaubt data:, obwohl das Frontend keine eingebetteten Schriften \
             laedt: {policy:?}"
        );
        assert!(
            sources("img-src").contains(&"data:"),
            "{key}: img-src braucht data: fuer die Maske in src/styles.css: {policy:?}"
        );
        assert_eq!(
            sources("connect-src").join(" "),
            expected_connect_src,
            "{key}: connect-src weicht ab -- ohne ipc: und http://ipc.localhost scheitert jeder \
             invoke."
        );
    }
}
