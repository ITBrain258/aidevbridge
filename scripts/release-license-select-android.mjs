#!/usr/bin/env node
// Derive the Android license selection (one APK for arm64, armv7 and x86_64)
// from the reviewed Windows x64 selection, as release-license-select-macos.mjs
// does for macOS. Packages shared with Windows keep their decision and texts,
// Windows-only families are dropped, and every Android-only crate, the parts
// of the Android NDK that the linker copies into libaidevbridge_lib.so and
// every Java/Kotlin library of the release runtime classpath
// (src-tauri/gen/android/app/gradle.lockfile) has an explicit entry below.
// Nothing is inferred from SPDX expressions and nothing is fetched: cargo runs
// --offline, crate texts come from the registry cache, library texts from the
// Gradle cache (after one Android build), NDK evidence from NDK_HOME, the rest
// from docs/release/licenses. Without --write it only prints a summary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOLCHAIN = '1.97.1';
export const TARGETS = ['aarch64-linux-android', 'armv7-linux-androideabi', 'x86_64-linux-android'];
// The release build runs on an x86_64 Linux runner (.github/workflows/android.yml);
// build scripts and proc macros are resolved for it.
export const BUILD_HOST = 'x86_64-unknown-linux-gnu';
export const NDK_VERSION = '29.0.14206865';
const DATE = '2026-10-28';
const WINDOWS = 'docs/release/license-selection.windows-x64.json';
const WINDOWS_INVENTORY = 'docs/release/license-inventory-2026-09-12-rust.json';
const SELECTION = 'docs/release/license-selection.android-universal.json';
const INVENTORY = 'docs/release/license-inventory-2026-10-28-android.json';
const REPORT = 'docs/release/license-android-universal-2026-10-28.json';
const LICENSES = 'docs/release/licenses';
const LOCKFILE = 'src-tauri/gen/android/app/gradle.lockfile';
const RUNTIME_CLASSPATH = 'universalReleaseRuntimeClasspath';
const RUST_COMMIT = '8bab26f4f68e0e26f0bb7960be334d5b520ea452';
const SPDX = { tag: 'v3.29.0', commit: '31ba1a50e5397e00a304dbadc76531740e89ee48' };
const SPDX_MIT = { path: `${LICENSES}/spdx-license-list-3.29.0-MIT.txt`, url: `https://github.com/spdx/license-list-data/blob/${SPDX.commit}/text/MIT.txt` };
const SPDX_APACHE = { path: `${LICENSES}/spdx-license-list-3.29.0-Apache-2.0.txt`, url: `https://github.com/spdx/license-list-data/blob/${SPDX.commit}/text/Apache-2.0.txt` };
const NDK_NOTICE = { path: `${LICENSES}/android-ndk-${NDK_VERSION}-NOTICE.txt`, ndk: 'NOTICE' };
const NDK_LLVM_NOTICE = { path: `${LICENSES}/android-ndk-${NDK_VERSION}-llvm-NOTICE.txt`, ndk: 'toolchains/llvm/prebuilt/<host>/NOTICE' };
const KOTLIN = { tag: 'v2.0.21', commit: '284e9b4041bd815b5b1b489070bbb1f1db6de35c', files: ['LICENSE.txt', 'NOTICE.txt', 'README.md', 'third_party/boost_LICENSE.txt'] };
const COROUTINES = { tag: '1.9.0', commit: 'd8d6f8f37978b8e202d93b34f23f101df9c5724d' };
const SERIALIZATION = { tag: 'v1.7.3', commit: 'd4d066d72a9f92f06c640be5a36a22f75d0d7659' };
const UPSTREAM_TEXTS = {
  'kotlin-license': { path: `${LICENSES}/kotlin-2.0.21-LICENSE.txt`, url: `https://github.com/JetBrains/kotlin/blob/${KOTLIN.commit}/license/LICENSE.txt` },
  'kotlin-notice': { path: `${LICENSES}/kotlin-2.0.21-NOTICE.txt`, url: `https://github.com/JetBrains/kotlin/blob/${KOTLIN.commit}/license/NOTICE.txt` },
  'kotlin-readme': { path: `${LICENSES}/kotlin-2.0.21-license-README.md`, url: `https://github.com/JetBrains/kotlin/blob/${KOTLIN.commit}/license/README.md` },
  'kotlin-boost': { path: `${LICENSES}/kotlin-2.0.21-third_party-boost_LICENSE.txt`, url: `https://github.com/JetBrains/kotlin/blob/${KOTLIN.commit}/license/third_party/boost_LICENSE.txt` },
  'coroutines-notice': { path: `${LICENSES}/kotlinx.coroutines-1.9.0-NOTICE.txt`, url: `https://github.com/Kotlin/kotlinx.coroutines/blob/${COROUTINES.commit}/license/NOTICE.txt` },
  'serialization-notice': { path: `${LICENSES}/kotlinx.serialization-1.7.3-NOTICE.txt`, url: `https://github.com/Kotlin/kotlinx.serialization/blob/${SERIALIZATION.commit}/license/NOTICE.txt` },
  'jni-sys-mit': { path: `${LICENSES}/jni-sys-64d77b7-LICENSE-MIT.txt`, url: 'https://github.com/jni-rs/jni-sys/blob/64d77b7a5f119d7b55b4e2c169a4668067ff59e6/LICENSE-MIT' },
  'ndk-mit': { path: `${LICENSES}/rust-mobile-ndk-49bbbba-LICENSE-MIT.txt`, url: 'https://github.com/rust-mobile/ndk/blob/49bbbba16c58ff63cb8a0ad0eca5a9fb7ecaec25/LICENSE-MIT' },
};

// Inputs of the Windows payload that the Android payload does not use (the
// same list as for macOS).
const WINDOWS_ONLY_FILES = [
  'docs/release/license-webview2-bindings-2026-09-12.json', 'docs/release/license-webview2-sdk-2026-09-12.json', 'docs/release/license-windows-runtime-2026-09-12.json',
  `${LICENSES}/microsoft-web-webview2-1.0.3650.58-LICENSE.txt`, `${LICENSES}/microsoft-web-webview2-1.0.3650.58-NOTICE.txt`, `${LICENSES}/microsoft-webview2-evergreen-2026-09-12-LICENSE.txt`, `${LICENSES}/microsoft-windows-runtime-NOTICE.txt`,
  `${LICENSES}/nsis-3.11-COPYING.txt`, `${LICENSES}/nsis-3.11-Modern-UI-2-LICENSE.txt`, `${LICENSES}/nsis-3.11-NSISdl-LICENSE.txt`, `${LICENSES}/nsis-tauri-utils-0.5.3-LICENSE-MIT.txt`,
  `${LICENSES}/webview2-rs-0.38.2-macros-0.8.1-LICENSE-MIT.txt`, `${LICENSES}/wix-3.14.1-LICENSE.txt`,
  'docs/release/sources/README.txt', 'docs/release/sources/nsis-3.11-source.zip', 'docs/release/sources/wix-3.14.1-source.zip',
  'docs/release/windows-installation-notice.txt', 'docs/release/windows-installer-attribution-2026-09-12.md', 'docs/release/windows-installer-source-archives-2026-09-12.md', 'docs/release/windows-zip-readme.txt',
  'scripts/release-windows-artifacts.mjs', 'scripts/release-windows.ps1', 'src-tauri/tauri.release.windows.json',
];
// Build configuration of the Android payload. INVENTORY and REPORT are written
// by this script before the selection binds them.
const ANDROID_FILES = [
  '.github/workflows/android.yml', 'scripts/release-license-select-android.mjs', LOCKFILE,
  'src-tauri/gen/android/app/build.gradle.kts', 'src-tauri/gen/android/app/proguard-rules.pro', 'src-tauri/gen/android/app/src/main/AndroidManifest.xml',
  'src-tauri/gen/android/build.gradle.kts', 'src-tauri/gen/android/buildSrc/build.gradle.kts', 'src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties', 'src-tauri/gen/android/settings.gradle',
  INVENTORY, REPORT, SPDX_MIT.path, SPDX_APACHE.path, NDK_NOTICE.path, NDK_LLVM_NOTICE.path, ...Object.values(UPSTREAM_TEXTS).map(t => t.path),
];
// Tauri merges tauri.android.conf.json into every Android build; its appearance would change the payload.
const ABSENT = ['.cargo/config', '.cargo/config.toml', 'src-tauri/.cargo/config', 'src-tauri/.cargo/config.toml', 'src-tauri/tauri.android.conf.json', 'public'];

// Every cargo package that exists only in the Android graph. `files` are the
// complete original texts selected from the package root. `repo` names a text
// of the package's repository at its publish commit, for crates that ship none.
export const NEW_CRATES = {
  'android_system_properties@0.1.5': { files: ['LICENSE-MIT'] },
  'atomic-waker@1.1.2': { files: ['LICENSE-MIT', 'LICENSE-THIRD-PARTY'], note: 'LICENSE-THIRD-PARTY retains the Apache-2.0 notice of the futures and Tokio code the crate derives from (Copyright 2016 Alex Crichton, 2017 The Tokio Authors).' },
  'cesu8@1.1.0': { files: ['COPYRIGHT-RUST.txt'], spdxMit: true, note: 'The crate ships only COPYRIGHT-RUST.txt, the Rust project copyright file for the code it derives from Rust std; it is retained verbatim with the canonical SPDX MIT text it names.' },
  'cfg_aliases@0.2.2': { files: ['LICENSE', 'NOTICES.md'], note: 'The original NOTICES.md for the tectonic_cfg_support code that cfg_aliases reuses is retained.' },
  'combine@4.6.7': { files: ['LICENSE'] },
  'http-body@1.1.0': { files: ['LICENSE'] },
  'http-body-util@0.1.4': { files: ['LICENSE'] },
  'httparse@1.10.1': { files: ['LICENSE-MIT'] },
  'hyper@1.11.0': { files: ['LICENSE'] },
  'hyper-util@0.1.20': { files: ['LICENSE'] },
  'iana-time-zone@0.1.65': { files: ['LICENSE-MIT'] },
  'ipnet@2.12.0': { files: ['LICENSE-MIT'] },
  'is-docker@0.2.0': { files: ['LICENSE'] },
  'is-wsl@0.4.0': { files: ['LICENSE'] },
  'jni@0.21.1': { files: ['LICENSE-MIT'] },
  'jni-sys@0.3.1': { files: ['LICENSE-MIT'] },
  'jni-sys@0.4.1': { files: ['LICENSE-MIT'] },
  'jni-sys-macros@0.4.1': { repo: 'jni-sys-mit', note: 'The crate ships no license file; the LICENSE-MIT of its repository at the publish commit 64d77b7 (.cargo_vcs_info.json) is selected.' },
  'ndk@0.9.0': { repo: 'ndk-mit', note: 'The crate ships no license file; the LICENSE-MIT of its repository at the publish commit 49bbbba (.cargo_vcs_info.json) is selected.' },
  'ndk-sys@0.6.0+11769913': { repo: 'ndk-mit', note: 'The crate ships no license file; the LICENSE-MIT of its repository at the publish commit 49bbbba (.cargo_vcs_info.json) is selected. The bindings are generated from the NDK headers, which the NDK NOTICE covers (native:android-ndk-crt).' },
  'nix@0.31.3': { files: ['LICENSE'] },
  'num_enum@0.7.6': { files: ['LICENSE-MIT'] },
  'num_enum_derive@0.7.6': { files: ['LICENSE-MIT'] },
  'proc-macro-crate@3.5.0': { files: ['LICENSE-MIT'] },
  'reqwest@0.13.4': { files: ['LICENSE-MIT'] },
  'sync_wrapper@1.0.2': { files: ['LICENSE'], license: 'Apache-2.0', note: 'Apache-2.0 is the only license offered; the crate ships the complete text and no NOTICE file.' },
  'tao-macros@0.1.3': { sameAs: 'tao@0.35.3', note: 'The crate ships no license file. The tao repository at tag tao-macros-v0.1.3 (340684d) carries LICENSE and LICENSE.spdx byte-identical to the texts selected for tao 0.35.3; the Apache-2.0 selection of tao is reused.' },
  'tokio-util@0.7.19': { files: ['LICENSE'] },
  'toml_edit@0.25.13+spec-1.1.0': { files: ['LICENSE-MIT'] },
  'tower@0.5.3': { files: ['LICENSE'] },
  'tower-http@0.6.11': { files: ['LICENSE'] },
  'tower-layer@0.3.3': { files: ['LICENSE'] },
  'tower-service@0.3.3': { files: ['LICENSE'] },
  'try-lock@0.2.5': { files: ['LICENSE'] },
  'want@0.3.1': { files: ['LICENSE'] },
};

// Every library of the release runtime classpath. `archive` names license or
// notice files inside the artifact; `texts` names upstream texts. Without
// either, the canonical SPDX Apache-2.0 text stands for the license the POM
// declares. `redirect` marks Gradle module metadata whose code is the named
// variant; `bom` a platform that pins versions and carries no code.
const ANDROIDX = 'https://github.com/androidx/androidx';
const apache = (repo, extra = {}) => ({ repo, ...extra });
export const MAVEN = {
  'androidx.activity:activity-ktx:1.10.1': apache(ANDROIDX, { archive: ['META-INF/androidx/activity/activity-ktx/LICENSE.txt'] }),
  'androidx.activity:activity:1.10.1': apache(ANDROIDX, { archive: ['META-INF/androidx/activity/activity/LICENSE.txt'] }),
  'androidx.annotation:annotation-experimental:1.4.1': apache(ANDROIDX),
  'androidx.annotation:annotation-jvm:1.9.1': apache(ANDROIDX, { archive: ['META-INF/androidx/annotation/annotation/LICENSE.txt'] }),
  'androidx.annotation:annotation:1.9.1': { redirect: 'androidx.annotation:annotation-jvm:1.9.1' },
  'androidx.appcompat:appcompat-resources:1.7.1': apache(ANDROIDX),
  'androidx.appcompat:appcompat:1.7.1': apache(ANDROIDX),
  'androidx.arch.core:core-common:2.2.0': apache(ANDROIDX),
  'androidx.arch.core:core-runtime:2.2.0': apache(ANDROIDX),
  'androidx.browser:browser:1.8.0': apache(ANDROIDX),
  'androidx.cardview:cardview:1.0.0': apache(ANDROIDX),
  'androidx.collection:collection-jvm:1.4.2': apache(ANDROIDX),
  'androidx.collection:collection:1.4.2': { redirect: 'androidx.collection:collection-jvm:1.4.2' },
  'androidx.concurrent:concurrent-futures:1.1.0': apache(ANDROIDX),
  'androidx.constraintlayout:constraintlayout-core:1.0.0': apache('https://github.com/androidx/constraintlayout'),
  'androidx.constraintlayout:constraintlayout:2.1.0': apache('https://github.com/androidx/constraintlayout'),
  'androidx.coordinatorlayout:coordinatorlayout:1.1.0': apache(ANDROIDX),
  'androidx.core:core-ktx:1.13.1': apache(ANDROIDX),
  'androidx.core:core-viewtree:1.0.0': apache(ANDROIDX, { archive: ['META-INF/androidx/core/core-viewtree/LICENSE.txt'] }),
  'androidx.core:core:1.13.1': apache(ANDROIDX),
  'androidx.cursoradapter:cursoradapter:1.0.0': apache(ANDROIDX),
  'androidx.customview:customview:1.1.0': apache(ANDROIDX),
  'androidx.drawerlayout:drawerlayout:1.1.1': apache(ANDROIDX),
  'androidx.dynamicanimation:dynamicanimation:1.1.0': apache(ANDROIDX, { archive: ['META-INF/androidx/dynamicanimation/dynamicanimation/LICENSE.txt'] }),
  'androidx.emoji2:emoji2-views-helper:1.3.0': apache(ANDROIDX),
  'androidx.emoji2:emoji2:1.3.0': apache(ANDROIDX),
  'androidx.fragment:fragment:1.5.4': apache(ANDROIDX),
  'androidx.graphics:graphics-shapes-android:1.0.1': apache(ANDROIDX, { archive: ['META-INF/androidx/graphics/graphics-shapes/LICENSE.txt'] }),
  'androidx.graphics:graphics-shapes:1.0.1': { redirect: 'androidx.graphics:graphics-shapes-android:1.0.1' },
  'androidx.interpolator:interpolator:1.0.0': apache(ANDROIDX),
  'androidx.lifecycle:lifecycle-common-jvm:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-common/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-common:2.10.0': { redirect: 'androidx.lifecycle:lifecycle-common-jvm:2.10.0' },
  'androidx.lifecycle:lifecycle-livedata-core-ktx:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-livedata-core-ktx/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-livedata-core:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-livedata-core/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-livedata:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-livedata/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-process:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-process/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-runtime-android:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-runtime/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-runtime-ktx-android:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-runtime-ktx/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-runtime-ktx:2.10.0': { redirect: 'androidx.lifecycle:lifecycle-runtime-ktx-android:2.10.0' },
  'androidx.lifecycle:lifecycle-runtime:2.10.0': { redirect: 'androidx.lifecycle:lifecycle-runtime-android:2.10.0' },
  'androidx.lifecycle:lifecycle-viewmodel-android:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-viewmodel/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-viewmodel-ktx:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-viewmodel-ktx/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-viewmodel-savedstate-android:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-viewmodel-savedstate/LICENSE.txt'] }),
  'androidx.lifecycle:lifecycle-viewmodel-savedstate:2.10.0': { redirect: 'androidx.lifecycle:lifecycle-viewmodel-savedstate-android:2.10.0' },
  'androidx.lifecycle:lifecycle-viewmodel:2.10.0': apache(ANDROIDX, { archive: ['META-INF/androidx/lifecycle/lifecycle-viewmodel/LICENSE.txt'] }),
  'androidx.loader:loader:1.0.0': apache(ANDROIDX),
  'androidx.profileinstaller:profileinstaller:1.4.0': apache(ANDROIDX, { archive: ['META-INF/androidx/profileinstaller/profileinstaller/LICENSE.txt'] }),
  'androidx.recyclerview:recyclerview:1.2.1': apache(ANDROIDX),
  'androidx.resourceinspection:resourceinspection-annotation:1.0.1': apache(ANDROIDX),
  'androidx.savedstate:savedstate-android:1.4.0': apache(ANDROIDX, { archive: ['META-INF/androidx/savedstate/savedstate/LICENSE.txt'] }),
  'androidx.savedstate:savedstate-ktx:1.4.0': apache(ANDROIDX, { archive: ['META-INF/androidx/savedstate/savedstate-ktx/LICENSE.txt'] }),
  'androidx.savedstate:savedstate:1.4.0': { redirect: 'androidx.savedstate:savedstate-android:1.4.0' },
  'androidx.startup:startup-runtime:1.1.1': apache(ANDROIDX),
  'androidx.tracing:tracing:1.0.0': apache(ANDROIDX),
  'androidx.transition:transition:1.5.0': apache(ANDROIDX),
  'androidx.vectordrawable:vectordrawable-animated:1.1.0': apache(ANDROIDX),
  'androidx.vectordrawable:vectordrawable:1.1.0': apache(ANDROIDX),
  'androidx.versionedparcelable:versionedparcelable:1.1.1': apache(ANDROIDX),
  'androidx.viewpager2:viewpager2:1.0.0': apache(ANDROIDX),
  'androidx.viewpager:viewpager:1.0.0': apache(ANDROIDX),
  'androidx.webkit:webkit:1.14.0': apache(ANDROIDX, { archive: ['META-INF/androidx/webkit/webkit/LICENSE.txt'] }),
  'com.fasterxml.jackson.core:jackson-annotations:2.15.3': apache('https://github.com/FasterXML/jackson-annotations', { archive: ['META-INF/LICENSE', 'META-INF/NOTICE'] }),
  'com.fasterxml.jackson.core:jackson-core:2.15.3': apache('https://github.com/FasterXML/jackson-core', { archive: ['META-INF/LICENSE', 'META-INF/NOTICE'] }),
  'com.fasterxml.jackson.core:jackson-databind:2.15.3': apache('https://github.com/FasterXML/jackson-databind', { archive: ['META-INF/LICENSE', 'META-INF/NOTICE'] }),
  'com.fasterxml.jackson:jackson-bom:2.15.3': { bom: true },
  'com.google.android.material:material:1.13.0': apache('https://github.com/material-components/material-components-android'),
  'com.google.errorprone:error_prone_annotations:2.15.0': apache('https://github.com/google/error-prone'),
  'com.google.guava:listenablefuture:1.0': apache('https://github.com/google/guava', { note: 'The POM names no license itself; its parent guava-parent declares Apache-2.0.' }),
  'org.jetbrains.kotlin:kotlin-bom:1.8.22': { bom: true },
  'org.jetbrains.kotlin:kotlin-stdlib:2.0.21': apache('https://github.com/JetBrains/kotlin', { texts: ['kotlin-license', 'kotlin-notice', 'kotlin-readme', 'kotlin-boost'], note: `The artifact ships no text. Kotlin's license/LICENSE.txt and its NOTICE (Apache-2.0 section 4 d) at tag ${KOTLIN.tag} are retained, with license/README.md, which names the standard-library code derived from GWT (Copyright 2007-08 Google Inc.) and Guava (Copyright 2011 The Guava Authors), both Apache-2.0 with the same text, and from Boost (MathJVM.kt, Copyright Eric Ford and Hubert Holin 2001), whose BSL-1.0 text is retained too.` }),
  'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0': apache('https://github.com/Kotlin/kotlinx.coroutines', { texts: ['coroutines-notice'], note: `The artifact ships no text; the NOTICE (Apache-2.0 section 4 d) of kotlinx.coroutines at tag ${COROUTINES.tag} is retained.` }),
  'org.jetbrains.kotlinx:kotlinx-coroutines-bom:1.9.0': { bom: true },
  'org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.9.0': apache('https://github.com/Kotlin/kotlinx.coroutines', { texts: ['coroutines-notice'], note: `The artifact ships no text; the NOTICE (Apache-2.0 section 4 d) of kotlinx.coroutines at tag ${COROUTINES.tag} is retained.` }),
  'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0': { redirect: 'org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.9.0' },
  'org.jetbrains.kotlinx:kotlinx-serialization-bom:1.7.3': { bom: true },
  'org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.7.3': apache('https://github.com/Kotlin/kotlinx.serialization', { texts: ['serialization-notice'], note: `The artifact ships no text; the NOTICE (Apache-2.0 section 4 d) of kotlinx.serialization at tag ${SERIALIZATION.tag} is retained.` }),
  'org.jetbrains.kotlinx:kotlinx-serialization-core:1.7.3': { redirect: 'org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.7.3' },
  'org.jetbrains:annotations:23.0.0': apache('https://github.com/JetBrains/java-annotations'),
  'org.jspecify:jspecify:1.0.0': apache('https://github.com/jspecify/jspecify'),
};

const RUNTIME = 'Android runtime candidate notice coverage; no claim every object survives linking or R8 shrinking.';
const BUILD = 'Conservative permissive build/source family disclosure; no claim that the tool program is delivered.';
const WINDOWS_OUTSIDE = 'Outside the locked Windows release normal/build graph (development or other target). No source/code from this package is selected for the application payload.';
const OUTSIDE = 'Outside the locked Android release normal/build graph (development or other target). No source/code from this package is selected for the application payload.';
const GENERIC = /^(Explicit \S+ selection using the complete original text\. )(?:Windows runtime candidate notice coverage; no claim every object survives linking\.|Conservative permissive build\/source family disclosure; no claim that the tool program is delivered\.)(.*)$/s;
const WINDOWS_WORDS = /Windows|WebView2|COFF|\bPE\b|\bEXE\b|\bPDB\b|MSVC/;
// Shared decisions whose Windows reason cites Windows build evidence. The
// decision stands for Android on the evidence given here.
const ANDROID_REASONS = {};

// Packages the Windows selection excludes that the Android library contains:
// on Android, wry depends on dom_query at run time
// ([target.'cfg(target_os = "android")'.dependencies.dom_query] in wry
// 0.55.1), and with it on its MPL-2.0 CSS parser and selector matcher.
const DOM_QUERY = 'On Android, wry 0.55.1 depends on dom_query at run time (a target_os = "android" dependency), so this package is compiled into libaidevbridge_lib.so.';
const ANDROID_INCLUDES = {
  'cssparser@0.36.0': { files: ['LICENSE'], reason: `${DOM_QUERY} dom_query uses it to tokenize and parse selectors, directly and through selectors.` },
  'selectors@0.36.1': { text: `${LICENSES}/selectors-0.36.1-LICENSE-MPL-2.0.txt`, reason: `${DOM_QUERY} dom_query matches selectors to DOM nodes with it. The crate ships no license file; the MPL-2.0 text already selected for it is retained.` },
  'dtoa-short@0.3.5': { files: ['LICENSE'], reason: `${DOM_QUERY} cssparser formats numbers with it.` },
  'cssparser-macros@0.6.1': { files: ['LICENSE'], reason: 'A proc macro that runs on the build host, but its expansions (MAX_LENGTH constants, byte dispatch tables and matches) are compiled into cssparser and selectors, which the Android library contains; included conservatively.' },
  'option-ext@0.2.0': { files: ['LICENSE.txt'], reason: 'dirs-sys compiles xdg_user_dirs.rs for Android (unix, not macOS or iOS), whose user_dir.contains instantiates OptionExt. The app calls no dirs function on Android (src-tauri/src/paths.rs), so the instantiation may not survive linking; included conservatively.' },
};

// The Rust 1.97.1 standard library as the installed Android rust-std
// components ship it. `lock` names entries of library/Cargo.lock.
const STDLIB = [
  { name: 'Rust std/core/alloc/panic_unwind/std_detect/unwind and in-tree support', version: TOOLCHAIN, declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-1.97.1-LICENSE-MIT.txt`, `${LICENSES}/rust-1.97.1-SOURCE-NOTICES.txt`], rlibs: ['std', 'core', 'alloc', 'panic_unwind', 'panic_abort', 'std_detect', 'unwind'], reason: 'Installed rust-std RLIBs for the three Android targets and the exact Rust source commit. On Android, library/unwind links the NDK libunwind (mapped as native:android-ndk-llvm-runtime); unwind itself contains only bindings. Additional library/backtrace and std/sync/mpmc attributions retained from the standard-library copyright notices.' },
  { name: 'core Unicode tables', version: 'Unicode 17.0.0 at Rust 1.97.1 commit', declared: 'Unicode-3.0', selected: 'Unicode-3.0', texts: [`${LICENSES}/rust-1.97.1-LICENSE-UNICODE.txt`], rlibs: ['core'], reason: 'library/core/src/unicode/unicode_data.rs at the exact Rust commit declares UNICODE_VERSION=(17,0,0); the release copyright index and LICENSES/Unicode-3.0.txt retain the 1991-2024 notice. Same source as the Windows selection.' },
  { name: 'cfg-if', version: '1.0.4', lock: 'cfg-if', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-cfg-if-1.0.4-LICENSE-MIT.txt`], rlibs: ['cfg_if'] },
  { name: 'rustc-demangle', version: '0.1.27', lock: 'rustc-demangle', declared: 'MIT/Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-cfg-if-1.0.4-LICENSE-MIT.txt`], rlibs: ['rustc_demangle'], note: 'Its upstream MIT bytes are identical to cfg-if 1.0.4 and reused without notice loss.' },
  { name: 'hashbrown', version: '0.17.1', lock: 'hashbrown', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-hashbrown-0.17.1-LICENSE-MIT.txt`], rlibs: ['hashbrown'], note: 'std uses default-features=false and rustc-dep-of-std; no foldhash RLIB is installed for any Android target.' },
  { name: 'compiler_builtins', version: '0.1.160 in the Rust commit, not app Cargo.lock', declared: 'MIT AND Apache-2.0 WITH LLVM-exception', selected: 'MIT AND Apache-2.0 WITH LLVM-exception', texts: [`${LICENSES}/compiler-builtins-0.1.160-LICENSE.txt`], rlibs: ['compiler_builtins'], reason: 'Installed compiler_builtins RLIBs for the three Android targets. The full upstream combined text includes the LLVM exception and historical attribution; it is retained instead of relying on embedding exceptions to remove a notice.' },
  { name: 'libm source embedded in compiler_builtins', version: 'libm manifest 0.2.16 in same Rust source tree; not separate app dependency', declared: 'MIT', selected: 'MIT', texts: [`${LICENSES}/compiler-builtins-0.1.160-libm-LICENSE.txt`], rlibs: ['compiler_builtins'], reason: 'The compiler_builtins math path imports libm source. Full upstream text retained including attributions; this does not assert every libm function is linked.' },
  { name: 'compiler-rt builtins family', version: 'Rust llvm-project submodule dcc3606807c989700e0ac1cac18c31741bcd40d9', declared: 'Apache-2.0 WITH LLVM-exception', selected: 'Apache-2.0 WITH LLVM-exception; MIT alternative for legacy dual-licensed material', texts: [`${LICENSES}/rust-1.97.1-compiler-rt-LICENSE.txt`, `${LICENSES}/rust-1.97.1-compiler-rt-CREDITS.txt`], rlibs: ['compiler_builtins'], nativeObjects: true, reason: 'The installed compiler_builtins RLIBs carry native-named builtins objects (counted per target in the report), built from the compiler-rt source of Rust\'s pinned llvm-project. Supplemental complete upstream file retained, including original legacy alternatives. No claim all objects or LLVM itself are in the binary.' },
  { name: 'libc', version: '0.2.185', lock: 'libc', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: ['sha256:123a331b5dbf04c30097fa43b8f858bc85df671fe776de498d01f3d6b7c1f69e'], rlibs: ['libc'], note: 'std depends on it for cfg(not(all(windows, target_env = "msvc"))); its MIT bytes equal those of the application\'s libc.' },
  { name: 'addr2line', version: '0.25.1', lock: 'addr2line', declared: 'Apache-2.0 OR MIT', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-addr2line-0.25.1-LICENSE-MIT.txt`], rlibs: ['addr2line'], note: 'Backtrace symbolization dependency of std outside windows-msvc.' },
  { name: 'gimli', version: '0.32.3', lock: 'gimli', declared: 'MIT OR Apache-2.0', selected: 'MIT', texts: ['sha256:7b63ecd5f1902af1b63729947373683c32745c16a10e8e6292e2e2dcd7e90ae0'], rlibs: ['gimli'], note: 'Backtrace symbolization dependency of std (through addr2line); its MIT bytes are shared with already selected texts.' },
  { name: 'object', version: '0.37.3', lock: 'object', declared: 'Apache-2.0 OR MIT', selected: 'MIT', texts: [`${LICENSES}/rust-stdlib-object-0.37.3-LICENSE-MIT.txt`], rlibs: ['object'], note: 'Backtrace symbolization dependency of std outside windows-msvc and AIX, with the elf reader feature.' },
  { name: 'miniz_oxide', version: '0.8.9', lock: 'miniz_oxide', declared: 'MIT OR Zlib OR Apache-2.0', selected: 'MIT', texts: ['sha256:799e9ca9d179295ef372f25d3769cdda7d25bb2668add6a6a1e22d1e4c678b8d'], rlibs: ['miniz_oxide'], note: 'Backtrace symbolization dependency of std outside windows-msvc; same version and text as the application\'s miniz_oxide.' },
  { name: 'adler2', version: '2.0.1', lock: 'adler2', declared: '0BSD OR MIT OR Apache-2.0', selected: 'MIT', texts: ['sha256:23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'], rlibs: ['adler2'], note: 'Dependency of std\'s miniz_oxide; same version and text as the application\'s adler2.' },
  { name: 'memchr', version: '2.7.6', lock: 'memchr', declared: 'Unlicense OR MIT', selected: 'MIT', texts: ['sha256:0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f', 'sha256:01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f'], rlibs: ['memchr'], note: 'Dependency of std\'s object reader; MIT text and COPYING are byte-identical to those selected for the application\'s memchr.' },
];
// Installed std libraries that are not linked into an application binary.
const STDLIB_NOT_LINKED = ['getopts', 'proc_macro', 'profiler_builtins', 'rustc_literal_escaper', 'rustc_std_workspace_alloc', 'rustc_std_workspace_core', 'rustc_std_workspace_std', 'sysroot', 'test'];
// NDK files the linker copies into libaidevbridge_lib.so, per target: the
// clang resource directory (libunwind, compiler-rt builtins) and the API 24
// sysroot (bionic's CRT objects for shared libraries).
const NDK_ARCH = { 'aarch64-linux-android': 'aarch64', 'armv7-linux-androideabi': 'arm', 'x86_64-linux-android': 'x86_64' };
const NDK_SYSROOT = { 'aarch64-linux-android': 'aarch64-linux-android', 'armv7-linux-androideabi': 'arm-linux-androideabi', 'x86_64-linux-android': 'x86_64-linux-android' };
const NDK_API = 24;

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = message => { throw new Error(message); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const licenseName = /^(?:licen[sc]e|licen[sc]ing|copying|copyright|notice|unlicense)(?:$|[._-])/i;
const exe = name => process.platform === 'win32' ? `${name}.exe` : name;

function readFile(root, relative) {
  const file = path.join(root, ...relative.split('/'));
  const info = fs.lstatSync(file);
  ensure(info.isFile() && !info.isSymbolicLink(), `Not a regular file: ${relative}`);
  return fs.readFileSync(file);
}
function run(root, program, args, env = process.env) {
  return execFileSync(program, args, { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}
const cargo = (root, args, env) => run(root, 'rustup', ['run', TOOLCHAIN, 'cargo', ...args], env);
const platformArgs = flag => TARGETS.flatMap(target => [flag, target]);

export function androidMetadata(root) {
  return JSON.parse(cargo(root, ['metadata', '--locked', '--offline', '--format-version', '1', ...platformArgs('--filter-platform'), '--features', 'tauri/custom-protocol']));
}

// cargo tree resolves build scripts and proc macros for the host. Off an x86_64
// Linux host, a small rustc wrapper reports BUILD_HOST and passes it as the
// default target, so host cfgs evaluate as on the release runner. The wrapper
// is a Rust program so that it runs on every host, Windows included.
function hostEnvironment(root) {
  if (process.platform === 'linux' && process.arch === 'x64') return { env: process.env, cleanup() {} };
  const rustc = run(root, 'rustup', ['which', '--toolchain', TOOLCHAIN, 'rustc']).trim();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aidevbridge-android-host-'));
  fs.writeFileSync(path.join(dir, 'wrapper.rs'), `use std::process::{exit, Command};
fn main() {
    let real = std::env::var("AIDEVBRIDGE_REAL_RUSTC").unwrap();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-vV") {
        let out = Command::new(&real).arg("-vV").output().unwrap();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if line.starts_with("host: ") { println!("host: ${BUILD_HOST}"); } else { println!("{line}"); }
        }
        exit(0);
    }
    let mut cmd = Command::new(&real);
    if !args.iter().any(|a| a == "--target" || a.starts_with("--target=")) { cmd.arg("--target").arg("${BUILD_HOST}"); }
    exit(cmd.args(&args).status().unwrap().code().unwrap_or(1));
}
`);
  const wrapper = path.join(dir, exe('rustc-host'));
  run(root, rustc, ['-O', '-o', wrapper, path.join(dir, 'wrapper.rs')]);
  return { env: { ...process.env, RUSTC: wrapper, AIDEVBRIDGE_REAL_RUSTC: rustc, CARGO_TARGET_DIR: path.join(dir, 'target') }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Same classification as release-license-inventory.mjs, for the three Android targets.
export function androidRoles(root, metadata) {
  const host = hostEnvironment(root);
  try {
    const tree = edges => {
      const raw = cargo(root, ['tree', '--locked', '--offline', ...platformArgs('--target'), '--features', 'tauri/custom-protocol', '--edges', edges, '--prefix', 'none', '--format', '{p}|{l}|{f}', '--charset', 'ascii'], host.env);
      const map = new Map();
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        const m = /^([^ ]+) v([^ ]+)(.*?)\|([^|]*)\|(.*?)(?: \(\*\))?$/.exec(line);
        ensure(m, `Unparsed cargo tree line: ${line}`);
        const key = `${m[1]}@${m[2]}`;
        const features = map.get(key) ?? new Set();
        m[5].split(',').filter(Boolean).forEach(f => features.add(f));
        map.set(key, features);
      }
      return map;
    };
    const release = tree('normal,build'), normal = tree('normal,no-proc-macro'), withDev = tree('normal,build,dev');
    const roles = new Map();
    for (const pkg of metadata.packages) {
      const key = `${pkg.name}@${pkg.version}`;
      const role = metadata.workspace_members.includes(pkg.id) ? 'workspace-product' : normal.has(key) ? 'normal-runtime-candidate'
        : release.has(key) ? 'build-or-proc-macro-only-in-this-tree' : withDev.has(key) ? 'dev-only-in-this-tree' : 'outside-selected-android-tree';
      roles.set(key, { role, features: release.has(key) ? [...release.get(key)].sort() : null });
    }
    for (const key of release.keys()) ensure(roles.has(key), `Tree package absent from metadata: ${key}`);
    return roles;
  } finally { host.cleanup(); }
}

function licenseCandidates(dir) {
  const found = [];
  const walk = (base, depth) => {
    ensure(depth <= 16, `License scan depth exceeded: ${base}`);
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(base, entry.name);
      if (entry.isDirectory() && !['target', '.git', 'node_modules'].includes(entry.name)) walk(p, depth + 1);
      else if (entry.isFile() && licenseName.test(entry.name)) found.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir, 0);
  return found.sort();
}
const boundFiles = (key, dir) => [...new Set([...licenseCandidates(dir), ...(NEW_CRATES[key].files ?? [])])].sort();

// A minimal ZIP reader for the license entries of JAR and AAR files: central
// directory, then stored or deflated local entries.
export function zipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  ensure(eocd >= 0, 'Not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    ensure(buffer.readUInt32LE(offset) === 0x02014b50, 'Damaged ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      ensure(buffer.readUInt32LE(local) === 0x04034b50, `Damaged ZIP entry: ${name}`);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      ensure(method === 0 || method === 8, `Unsupported ZIP method ${method}: ${name}`);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function gradleHome() {
  return process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), '.gradle');
}

// The release runtime classpath from the lockfile: group:artifact:version.
export function lockedLibraries(lockText) {
  const libraries = [];
  for (const line of lockText.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('empty=')) continue;
    const m = /^([^:=]+):([^:=]+):([^=]+)=(.*)$/.exec(line);
    ensure(m, `Unparsed lockfile line: ${line}`);
    if (m[4].split(',').includes(RUNTIME_CLASSPATH)) libraries.push(`${m[1]}:${m[2]}:${m[3]}`);
  }
  return libraries.sort();
}

function mavenArtifact(coordinate) {
  const [group, artifact, version] = coordinate.split(':');
  const dir = path.join(gradleHome(), 'caches/modules-2/files-2.1', group, artifact, version);
  ensure(fs.existsSync(dir), `${coordinate} is not in the Gradle cache; build the Android app once`);
  const files = fs.readdirSync(dir).flatMap(h => fs.readdirSync(path.join(dir, h)).map(f => path.join(dir, h, f)));
  const pom = files.find(f => f.endsWith('.pom'));
  ensure(pom, `${coordinate} has no POM in the Gradle cache`);
  const archive = files.find(f => /\.(?:aar|jar)$/.test(f) && !/-(?:sources|javadoc)\.jar$/.test(f));
  const pomText = fs.readFileSync(pom, 'utf8');
  const licenses = [...pomText.matchAll(/<license>[\s\S]*?<name>([^<]*)<\/name>(?:[\s\S]*?<url>([^<]*)<\/url>)?/g)].map(m => ({ name: m[1].trim(), url: m[2]?.trim() ?? null }));
  return { coordinate, group, artifact, version, pom: { file: path.basename(pom), ...record(fs.readFileSync(pom)) }, archive: archive ? { file: path.basename(archive), ...record(fs.readFileSync(archive)), path: archive } : null, licenses, parent: /<parent>[\s\S]*?<artifactId>([^<]*)<\/artifactId>/.exec(pomText)?.[1] ?? null };
}

// The bytes of one license entry of an artifact, looking into an AAR's classes.jar too.
function archiveText(artifact, entry) {
  const outer = zipEntries(fs.readFileSync(artifact.archive.path));
  if (outer.has(entry)) return outer.get(entry)();
  ensure(outer.has('classes.jar'), `${artifact.coordinate}: ${entry} is missing`);
  const inner = zipEntries(outer.get('classes.jar')());
  ensure(inner.has(entry), `${artifact.coordinate}: ${entry} is missing`);
  return inner.get(entry)();
}

function stdlibEvidence(root) {
  const sysroot = run(root, 'rustup', ['run', TOOLCHAIN, 'rustc', '--print', 'sysroot']).trim();
  const library = path.join(sysroot, 'lib/rustlib/src/rust/library');
  ensure(fs.existsSync(path.join(library, 'Cargo.lock')), `rust-src for ${TOOLCHAIN} is missing: rustup component add rust-src --toolchain ${TOOLCHAIN}`);
  const lock = new Map();
  for (const part of fs.readFileSync(path.join(library, 'Cargo.lock'), 'utf8').split('[[package]]').slice(1)) {
    const value = field => new RegExp(`^${field} = "([^"]*)"`, 'm').exec(part)?.[1] ?? null;
    lock.set(value('name'), { version: value('version'), source: value('source'), checksum: value('checksum') });
  }
  const unwind = fs.readFileSync(path.join(library, 'unwind/src/lib.rs'), 'utf8');
  ensure(/#\[cfg\(target_os = "android"\)\][\s\S]{0,400}#\[link\(name = "unwind", cfg\(not\(target_feature = "crt-static"\)\)\)\]/.test(unwind), 'library/unwind no longer links the NDK libunwind on Android');
  const ar = ndkTool('llvm-ar');
  const targets = {};
  for (const target of TARGETS) {
    const dir = path.join(sysroot, 'lib/rustlib', target, 'lib');
    ensure(fs.existsSync(dir), `rust-std for ${target} is missing: rustup target add --toolchain ${TOOLCHAIN} ${target}`);
    const rlibs = fs.readdirSync(dir).filter(n => n.endsWith('.rlib')).sort();
    const builtins = rlibs.find(n => /^libcompiler_builtins-[0-9a-f]+\.rlib$/.test(n));
    const members = run(root, ar, ['t', path.join(dir, builtins)]).split(/\r?\n/).filter(Boolean);
    targets[target] = { rlibs, compiler_builtins_native_objects: members.filter(m => m.endsWith('.o') && !m.startsWith('compiler_builtins-')).length };
  }
  return {
    rustc: run(root, 'rustup', ['run', TOOLCHAIN, 'rustc', '-vV']).trim(),
    library_cargo_lock: record(fs.readFileSync(path.join(library, 'Cargo.lock'))),
    std_cargo_toml: record(fs.readFileSync(path.join(library, 'std/Cargo.toml'))),
    unwind_lib_rs: record(Buffer.from(unwind)),
    lock, targets,
  };
}

function ndkRoot() {
  const ndk = process.env.NDK_HOME;
  ensure(ndk && fs.existsSync(path.join(ndk, 'source.properties')), 'NDK_HOME must name the Android NDK');
  const revision = /^Pkg\.Revision = (.+)$/m.exec(fs.readFileSync(path.join(ndk, 'source.properties'), 'utf8'))?.[1]?.trim();
  ensure(revision === NDK_VERSION, `NDK ${NDK_VERSION} expected, NDK_HOME is ${revision}`);
  return ndk;
}
function ndkPrebuilt() {
  const dir = path.join(ndkRoot(), 'toolchains/llvm/prebuilt');
  const hosts = fs.readdirSync(dir);
  ensure(hosts.length === 1, `Expected one NDK host toolchain, found ${hosts.join(', ')}`);
  return path.join(dir, hosts[0]);
}
const ndkTool = name => path.join(ndkPrebuilt(), 'bin', exe(name));

// The NDK pieces in each target's libaidevbridge_lib.so and the NDK's own texts.
function ndkEvidence(root) {
  const ndk = ndkRoot(), prebuilt = ndkPrebuilt();
  const notice = fs.readFileSync(path.join(ndk, 'NOTICE')), llvmNotice = fs.readFileSync(path.join(prebuilt, 'NOTICE'));
  ensure(notice.equals(readFile(root, NDK_NOTICE.path)), `${NDK_NOTICE.path} differs from the NDK's NOTICE`);
  ensure(llvmNotice.equals(readFile(root, NDK_LLVM_NOTICE.path)), `${NDK_LLVM_NOTICE.path} differs from the NDK's LLVM NOTICE`);
  const clangDir = path.join(prebuilt, 'lib/clang');
  const clang = fs.readdirSync(clangDir);
  ensure(clang.length === 1, 'Expected one clang resource directory in the NDK');
  const targets = {};
  for (const target of TARGETS) {
    const arch = NDK_ARCH[target];
    const runtime = path.join(clangDir, clang[0], 'lib/linux', arch);
    const crt = path.join(prebuilt, 'sysroot/usr/lib', NDK_SYSROOT[target], String(NDK_API));
    const file = p => ({ path: path.relative(prebuilt, p).split(path.sep).join('/'), ...record(fs.readFileSync(p)) });
    const builtins = path.join(clangDir, clang[0], 'lib/linux', `libclang_rt.builtins-${arch === 'arm' ? 'arm' : arch}-android.a`);
    targets[target] = {
      libunwind: file(path.join(runtime, 'libunwind.a')),
      compiler_rt_builtins: file(builtins),
      crtbegin_so: file(path.join(crt, 'crtbegin_so.o')),
      crtend_so: file(path.join(crt, 'crtend_so.o')),
      ...binaryEvidence(root, target),
    };
  }
  return { version: NDK_VERSION, notice: record(notice), llvm_notice: record(llvmNotice), clang: clang[0], targets };
}

// Read-only evidence from a built library, when one is present: the NEEDED
// entries must be Android system libraries, and libunwind must be linked in.
function binaryEvidence(root, target) {
  const so = path.join(root, 'target', target, 'release', 'libaidevbridge_lib.so');
  if (!fs.existsSync(so)) return { built_library: null };
  const needed = [...run(root, ndkTool('llvm-readelf'), ['-d', so]).matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map(m => m[1]).sort();
  for (const lib of needed) ensure(SYSTEM_LIBRARIES.includes(lib), `${target}: unexpected NEEDED ${lib}`);
  const symbols = run(root, ndkTool('llvm-nm'), [so]);
  return { built_library: { sha256: sha(fs.readFileSync(so)), needed, libunwind_linked: /\b__unw_init_local\b/.test(symbols), crt_linked: /\b__dso_handle\b/.test(symbols) } };
}
const SYSTEM_LIBRARIES = ['libandroid.so', 'libc.so', 'libdl.so', 'liblog.so', 'libm.so'];

export function deriveSelection(root, { metadata = androidMetadata(root), roles = androidRoles(root, metadata), stdlib = stdlibEvidence(root), ndk = ndkEvidence(root), libraries = lockedLibraries(readFile(root, LOCKFILE).toString('utf8')) } = {}) {
  const windows = JSON.parse(readFile(root, WINDOWS));
  const windowsInventoryTexts = JSON.parse(readFile(root, WINDOWS_INVENTORY)).candidate_texts_by_sha256;
  const pkgVersion = JSON.parse(readFile(root, 'package.json')).version;
  ensure(windows.scope.product_version === pkgVersion, 'Rebind the Windows selection for this version first');
  for (const file of ANDROID_FILES.filter(f => f !== INVENTORY && f !== REPORT)) {
    ensure(fs.existsSync(path.join(root, ...file.split('/'))), `Missing Android delivery input: ${file}`);
    // Git checks these files out with LF everywhere (.gitattributes); Gradle on
    // Windows writes CRLF. Bound CRLF bytes would fail every other checkout.
    ensure(!readFile(root, file).includes(13), `${file} has CRLF line endings; check it out again with LF before deriving`);
  }
  const packages = new Map(metadata.packages.map(p => [`${p.name}@${p.version}`, p]));
  ensure(packages.size === metadata.packages.length, 'Ambiguous package name/version');
  const lockChecksums = new Map();
  for (const part of readFile(root, 'Cargo.lock').toString('utf8').split('[[package]]').slice(1)) {
    const value = field => new RegExp(`^${field} = "([^"]*)"`, 'm').exec(part)?.[1] ?? null;
    lockChecksums.set(`${value('name')}@${value('version')}`, value('checksum'));
  }
  const windowsCargo = new Map(windows.components.filter(c => c.id.startsWith('cargo:')).map(c => [c.id.slice(6), c]));
  const windowsDocs = new Map(windows.documents.map(d => [d.id, d]));
  const docs = new Map(), newTexts = new Map(), components = [], changes = { role: [], reason: [] };

  // Documents: an id `sha256:<hex>` reuses a record, a path makes a file record.
  function useDocument(ref, urls = []) {
    if (ref.startsWith('sha256:')) {
      const doc = docs.get(ref) ?? windowsDocs.get(ref);
      ensure(doc, `Unknown document ${ref}`);
      if (!docs.has(ref)) docs.set(ref, structuredClone(doc));
      return ref;
    }
    const bytes = readFile(root, ref), id = `sha256:${sha(bytes)}`;
    if (!docs.has(id)) docs.set(id, windowsDocs.has(id) ? structuredClone(windowsDocs.get(id)) : { id, file_name: path.posix.basename(ref), ...record(bytes), sources: [{ kind: 'file', path: ref }], source_names: [ref], source_urls: [] });
    for (const url of urls) if (!docs.get(id).source_urls.includes(url)) docs.get(id).source_urls.push(url);
    return id;
  }
  // Bytes from a package or an artifact: already selected bytes are reused,
  // new ones go to the Android inventory.
  function blobText(bytes, name, sourceName, urls) {
    const hex = sha(bytes), id = `sha256:${hex}`;
    if (!docs.has(id) && windowsDocs.has(id)) docs.set(id, structuredClone(windowsDocs.get(id)));
    else if (!docs.has(id)) {
      const blob = windowsInventoryTexts[hex] ? WINDOWS_INVENTORY : INVENTORY;
      if (blob === INVENTORY) newTexts.set(hex, bytes);
      docs.set(id, { id, file_name: /\.(?:txt|md)$/.test(name) ? name : `${name}.txt`, ...record(bytes), sources: [{ kind: 'inventory_blob', path: blob, sha256: hex }], source_names: [], source_urls: [] });
    }
    const doc = docs.get(id);
    if (!doc.source_names.includes(sourceName)) doc.source_names.push(sourceName);
    for (const url of urls) if (!doc.source_urls.includes(url)) doc.source_urls.push(url);
    return id;
  }
  function crateText(key, file) {
    const pkg = packages.get(key), bytes = fs.readFileSync(path.join(path.dirname(pkg.manifest_path), ...file.split('/')));
    return blobText(bytes, `${pkg.name}-${pkg.version}-${file.replaceAll('/', '-')}`, `${key}/${file}`, [`https://crates.io/crates/${pkg.name}/${pkg.version}`, ...(pkg.repository ? [pkg.repository] : [])]);
  }
  const sourceUrls = pkg => [`https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`, `https://crates.io/crates/${pkg.name}/${pkg.version}`, ...(pkg.repository ? [pkg.repository] : [])];
  const sourceArchive = pkg => pkg.source ? { url: sourceUrls(pkg)[0], sha256: lockChecksums.get(`${pkg.name}@${pkg.version}`) } : undefined;
  const isRuntime = role => role === 'normal-runtime-candidate' || role === 'workspace-product';
  // Excluded on Windows as build-only, but compiled into the Android library.
  const becameRuntime = [...packages.keys()].filter(key => {
    const base = windowsCargo.get(key);
    return base && base.disposition === 'exclude' && base.reason !== WINDOWS_OUTSIDE && isRuntime(roles.get(key)?.role) && !ANDROID_REASONS[key] && !ANDROID_INCLUDES[key];
  });
  ensure(becameRuntime.length === 0, `Excluded packages became runtime on Android: ${becameRuntime.join(', ')}`);

  for (const [key, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const { role, features } = roles.get(key) ?? fail(`No role for ${key}`);
    const base = windowsCargo.get(key);
    const include = ANDROID_INCLUDES[key];
    if (base && include) {
      ensure(base.disposition === 'exclude' && pkg.license === 'MPL-2.0' && role !== 'outside-selected-android-tree', `${key}: the Android MPL decision no longer fits (${base.disposition}, ${pkg.license}, ${role})`);
      const component = structuredClone(base);
      if (role !== base.technical_role) changes.role.push({ id: base.id, windows: base.technical_role, android: role });
      component.technical_role = role;
      component.release_tree_features = features;
      component.disposition = 'include';
      component.selected_license = 'MPL-2.0';
      component.documents = include.files ? include.files.map(file => crateText(key, file)) : [useDocument(include.text)];
      component.reason = `Explicit MPL-2.0 selection using the complete original text. ${include.reason} MPL-2.0 section 3.2: the package is used unmodified, and its Source Code Form is available at ${sourceUrls(pkg)[0]} (SHA-256 ${lockChecksums.get(key)}, recorded in Cargo.lock).`;
      changes.reason.push({ id: base.id, windows: base.reason, android: component.reason });
      if (!component.decision_basis.includes(REPORT)) component.decision_basis.push(REPORT);
      components.push(component);
      continue;
    }
    if (base) {
      const component = structuredClone(base);
      if (role !== base.technical_role && !(base.technical_role === 'outside-selected-windows-tree' && role === 'outside-selected-android-tree')) changes.role.push({ id: base.id, windows: base.technical_role, android: role });
      component.technical_role = role;
      component.release_tree_features = features;
      let reason = base.reason;
      if (ANDROID_REASONS[key]) reason = ANDROID_REASONS[key];
      else if (base.reason === WINDOWS_OUTSIDE) { ensure(role === 'outside-selected-android-tree', `${key} is outside the Windows graph but ${role} on Android; it needs a decision`); reason = OUTSIDE; }
      else {
        ensure(role !== 'outside-selected-android-tree' || base.disposition === 'exclude', `${key} is outside the Android graph; review its inclusion`);
        const generic = GENERIC.exec(base.reason);
        if (generic) reason = `${generic[1]}${isRuntime(role) ? RUNTIME : BUILD}${generic[2]}`;
        ensure(!WINDOWS_WORDS.test(reason), `${key}: the Windows reason cites Windows evidence; add an Android reason`);
      }
      if (base.disposition === 'exclude' && base.reason !== WINDOWS_OUTSIDE) ensure(!isRuntime(role) || ANDROID_REASONS[key], `${key}: an excluded package became runtime on Android`);
      if (reason !== base.reason) { changes.reason.push({ id: base.id, windows: base.reason, android: reason }); component.reason = reason; if (!component.decision_basis.includes(REPORT)) component.decision_basis.push(REPORT); }
      component.documents = component.documents.map(id => useDocument(id));
      components.push(component);
      continue;
    }
    const decision = NEW_CRATES[key] ?? fail(`No Android decision for ${key}`);
    const outside = role === 'outside-selected-android-tree';
    const selected = decision.license ?? (decision.sameAs ? windowsCargo.get(decision.sameAs)?.selected_license : 'MIT');
    const component = { id: `cargo:${key}`, name: pkg.name, version: pkg.version, declared_license: pkg.license, selected_license: outside ? null : selected, disposition: outside ? 'exclude' : 'include', technical_role: role, release_tree_features: features, documents: [], reason: OUTSIDE, source_urls: sourceUrls(pkg), decision_basis: [`${INVENTORY}#packages/${key}`, REPORT], source_archive: sourceArchive(pkg) };
    if (!outside) {
      ensure(new RegExp(`\\b${selected.replace('.', '\\.')}\\b`).test(pkg.license), `${key}: ${selected} is not offered (${pkg.license})`);
      if (decision.sameAs) {
        const base2 = windowsCargo.get(decision.sameAs) ?? fail(`${key}: ${decision.sameAs} is not in the Windows selection`);
        component.documents = base2.documents.map(id => useDocument(id));
      } else if (decision.repo) {
        const text = UPSTREAM_TEXTS[decision.repo];
        component.documents = [useDocument(text.path, [text.url])];
        component.source_urls.push(text.url);
        const manifest = fs.readFileSync(pkg.manifest_path, 'utf8').split(/\r?\n/);
        const start = manifest.findIndex(l => l.startsWith('authors = '));
        if (start >= 0) component.copyright_notices = [{ text: manifest[start], path: 'Cargo.toml', line: start + 1 }];
      } else {
        component.documents = decision.files.map(file => crateText(key, file));
        if (decision.spdxMit) { component.documents.push(useDocument(SPDX_MIT.path, [SPDX_MIT.url])); component.source_urls.push(SPDX_MIT.url); }
      }
      component.reason = `Explicit ${selected} selection using the complete original text. ${isRuntime(role) ? RUNTIME : BUILD}${decision.note ? ` ${decision.note}` : ''}`;
    }
    components.push(component);
  }
  for (const key of Object.keys(NEW_CRATES)) ensure(packages.has(key) && !windowsCargo.has(key), `Stale Android decision: ${key}`);

  // Frontend and npm decisions are platform independent: the same dist is bundled.
  for (const component of windows.components.filter(c => /^(?:npm|frontend):/.test(c.id))) {
    ensure(!WINDOWS_WORDS.test(component.reason), `${component.id}: the reason cites Windows evidence`);
    components.push({ ...structuredClone(component), documents: component.documents.map(id => useDocument(id)) });
  }

  STDLIB.forEach((item, index) => {
    const locked = item.lock ? stdlib.lock.get(item.lock) : null;
    if (item.lock) ensure(locked?.version === item.version && /^[a-f0-9]{64}$/.test(locked.checksum ?? ''), `library/Cargo.lock no longer pins ${item.lock} ${item.version}`);
    for (const target of TARGETS) for (const rlib of item.rlibs) ensure(stdlib.targets[target].rlibs.some(n => n.startsWith(`lib${rlib}-`)), `No ${rlib} RLIB for ${target}`);
    const evidence = item.lock ? `Installed rust-std RLIB lib${item.rlibs[0]} for the three Android targets; library/Cargo.lock pins ${item.version} with crates.io checksum ${locked.checksum}, equal to the SHA-256 of the archive the text comes from.` : '';
    components.push({
      id: `rust-toolchain:${index}`, name: item.name, version: item.version, declared_license: item.declared, selected_license: item.selected, disposition: 'include',
      documents: item.texts.map(id => useDocument(id)), reason: [item.reason ?? evidence, item.note].filter(Boolean).join(' '), decision_basis: [REPORT],
      source_urls: item.lock ? [`https://static.crates.io/crates/${item.name}/${item.name}-${item.version}.crate`] : [`https://github.com/rust-lang/rust/tree/${RUST_COMMIT}/library`],
    });
  });

  // The NDK pieces the linker copies into the library, and the system around it.
  const ndkUrl = 'https://developer.android.com/ndk/downloads';
  components.push(
    { id: 'native:android-ndk-llvm-runtime', name: 'LLVM libunwind and compiler-rt builtins of the Android NDK', version: `NDK ${NDK_VERSION}, clang ${ndk.clang}`, declared_license: 'Apache-2.0 WITH LLVM-exception', selected_license: 'Apache-2.0 WITH LLVM-exception', disposition: 'include', documents: [useDocument(NDK_LLVM_NOTICE.path, [ndkUrl])], reason: 'std links the NDK\'s static libunwind on Android (library/unwind/src/lib.rs), and clang links libclang_rt.builtins into every shared library; the built libraries carry libunwind\'s symbols (report). The NDK\'s complete LLVM NOTICE is retained although the LLVM exception waives the notice for embedded object code.', decision_basis: [REPORT], source_urls: [ndkUrl, 'https://android.googlesource.com/toolchain/llvm-project'] },
    { id: 'native:android-ndk-crt', name: 'Bionic CRT objects of the Android NDK (crtbegin_so.o, crtend_so.o)', version: `NDK ${NDK_VERSION}, API ${NDK_API} sysroot`, declared_license: 'BSD-2-Clause and the other notices of the NDK NOTICE', selected_license: 'BSD-2-Clause', disposition: 'include', documents: [useDocument(NDK_NOTICE.path, [ndkUrl])], reason: 'The NDK linker adds bionic\'s crtbegin_so.o and crtend_so.o (Copyright The Android Open Source Project, BSD-2-Clause) to every shared library. The NDK\'s complete NOTICE, which carries bionic\'s notices, is retained instead of an extract. ndk-sys bindings generated from the NDK headers fall under the same NOTICE.', decision_basis: [REPORT], source_urls: [ndkUrl, 'https://android.googlesource.com/platform/bionic'] },
    { id: 'native:android-system-libraries', name: 'Android system libraries and Android System WebView', version: 'provided by Android 7.0 (API 24) or newer', declared_license: 'Android platform terms', selected_license: null, disposition: 'exclude', documents: [], reason: `libc.so, libm.so, libdl.so, liblog.so and libandroid.so (the NEEDED entries of the built libraries, report) and the WebView are part of the device and loaded from it at run time. No system library bytes are copied into the APK.`, decision_basis: [REPORT], source_urls: [] },
  );

  // Java and Kotlin libraries of the release runtime classpath.
  const artifacts = new Map();
  for (const coordinate of libraries) {
    const decision = MAVEN[coordinate] ?? fail(`No Android decision for the library ${coordinate}`);
    const artifact = mavenArtifact(coordinate);
    artifacts.set(coordinate, artifact);
    const [group, name, version] = coordinate.split(':');
    const central = `https://repo1.maven.org/maven2/${group.replaceAll('.', '/')}/${name}/${version}/`;
    const google = group.startsWith('androidx.') || group.startsWith('com.google.android.') ? `https://maven.google.com/web/index.html#${group}:${name}:${version}` : null;
    const repoUrl = google ?? central;
    const declared = artifact.licenses.map(l => l.name).join('; ') || null;
    const component = { id: `maven:${coordinate}`, name: `${group}:${name}`, version, declared_license: declared, selected_license: null, disposition: 'exclude', technical_role: 'release-runtime-classpath', documents: [], reason: '', source_urls: [repoUrl], decision_basis: [`${INVENTORY}#libraries/${coordinate}`, LOCKFILE] };
    if (decision.bom) {
      ensure(!artifact.archive, `${coordinate} is a platform but has an archive`);
      component.reason = 'A Gradle platform (BOM) that only pins versions; it carries no code or resources.';
    } else if (decision.redirect) {
      ensure(!artifact.archive && libraries.includes(decision.redirect), `${coordinate}: expected Gradle module metadata redirecting to ${decision.redirect}`);
      component.reason = `Gradle module metadata only; its code is ${decision.redirect}, listed separately.`;
    } else {
      ensure(artifact.archive, `${coordinate} has no archive in the Gradle cache`);
      ensure(/Apache/i.test(declared ?? '') || decision.note, `${coordinate}: the POM declares ${declared}`);
      component.selected_license = 'Apache-2.0';
      component.disposition = 'include';
      component.source_urls.push(decision.repo);
      const docsOf = [];
      for (const entry of decision.archive ?? []) docsOf.push(blobText(archiveText(artifact, entry), `${name}-${version}-${entry.replaceAll('/', '-')}`, `${coordinate}!${entry}`, [repoUrl]));
      for (const key of decision.texts ?? []) docsOf.push(useDocument(UPSTREAM_TEXTS[key].path, [UPSTREAM_TEXTS[key].url]));
      if (!(decision.archive ?? []).length && !(decision.texts ?? []).some(k => k.endsWith('license'))) docsOf.push(useDocument(SPDX_APACHE.path, [SPDX_APACHE.url]));
      component.documents = [...new Set(docsOf)];
      const shipped = (decision.archive ?? []).length ? `The artifact ships ${decision.archive.join(' and ')}, retained verbatim. ` : '';
      const canonical = component.documents.includes(useDocument(SPDX_APACHE.path)) ? 'The artifact ships no license text; the canonical SPDX Apache-2.0 text stands for the license its POM declares. ' : '';
      component.reason = `Explicit Apache-2.0 selection. ${shipped}${canonical}${decision.note ? `${decision.note} ` : ''}${RUNTIME} Android's packaging drops META-INF license files from the APK, so the texts are delivered in the APK's licenses folder.`.replace(/\s+/g, ' ').trim();
    }
    components.push(component);
  }
  for (const key of Object.keys(MAVEN)) ensure(libraries.includes(key), `Stale Android library decision: ${key}`);

  ensure(new Set(components.map(c => c.id)).size === components.length, 'Duplicate component');
  const ids = new Set(components.map(c => c.id)), windowsIds = new Set(windows.components.map(c => c.id));
  changes.dropped = [...windowsIds].filter(id => !ids.has(id));
  changes.added = [...ids].filter(id => !windowsIds.has(id));
  changes.replaced = [...ids].filter(id => id.startsWith('rust-toolchain:') && windowsIds.has(id));

  // Keep source names and URLs of dropped Windows packages out of shared records.
  const dropped = new Set(changes.dropped.filter(id => id.startsWith('cargo:')).map(id => id.slice(6)));
  const keptUrls = new Set(components.flatMap(c => c.source_urls));
  const droppedUrls = new Set(changes.dropped.flatMap(id => windows.components.find(c => c.id === id)?.source_urls ?? []).filter(u => !keptUrls.has(u)));
  const used = new Set(components.flatMap(c => c.documents));
  const documents = [...docs.values()].filter(doc => used.has(doc.id)).map(doc => ({
    ...doc, source_names: doc.source_names.filter(n => !dropped.has(n.split('/')[0])), source_urls: doc.source_urls.filter(u => !droppedUrls.has(u)),
  }));
  const decisionReports = [...new Set([...windows.decision_reports.filter(r => components.some(c => c.decision_basis.some(b => b.split('#')[0] === r))), REPORT])];
  return { windows, windowsInventoryTexts, components, documents, newTexts, changes, decisionReports, packages, roles, stdlib, ndk, artifacts, libraries, pkgVersion, lockChecksums };
}

function inventory(derived) {
  const packages = [...derived.packages].sort(([a], [b]) => a.localeCompare(b)).map(([key, pkg]) => {
    const { role, features } = derived.roles.get(key), dir = path.dirname(pkg.manifest_path);
    const decision = NEW_CRATES[key];
    const candidates = decision?.files ? boundFiles(key, dir).map(p => ({ path: p, ...record(fs.readFileSync(path.join(dir, ...p.split('/')))) })) : undefined;
    return { name: pkg.name, version: pkg.version, source: pkg.source, declared_spdx: pkg.license, technical_role: role, release_tree_features: features, lock_checksum: derived.lockChecksums.get(key) ?? null, ...(candidates ? { license_candidates: candidates } : {}) };
  });
  const libraries = derived.libraries.map(coordinate => {
    const a = derived.artifacts.get(coordinate);
    return { coordinate, pom: a.pom, archive: a.archive ? { file: a.archive.file, bytes: a.archive.bytes, sha256: a.archive.sha256 } : null, declared_licenses: a.licenses, pom_parent: a.parent };
  });
  const texts = {};
  for (const [hex, bytes] of [...derived.newTexts].sort(([a], [b]) => a.localeCompare(b))) {
    let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { text = null; }
    texts[hex] = text !== null && Buffer.from(text, 'utf8').equals(bytes) ? { bytes: bytes.length, encoding: 'utf8', content: text } : { bytes: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
  }
  return {
    schema_version: 1, generated: DATE, status: 'pending-not-an-approval', generator: 'scripts/release-license-select-android.mjs',
    configuration: { targets: TARGETS, build_host: BUILD_HOST, features_argument: 'tauri/custom-protocol', default_features_enabled: true, rust_toolchain: TOOLCHAIN, ndk: NDK_VERSION, gradle_lockfile: LOCKFILE, runtime_classpath: RUNTIME_CLASSPATH },
    methodology: [
      'Package set: cargo metadata --locked --offline with --filter-platform for the three Android targets (their union).',
      `Roles: cargo tree --locked --offline with --target for the three Android targets and the edges normal,build / normal,no-proc-macro / normal,build,dev, resolved with ${BUILD_HOST} as build host, the host of the release build.`,
      `Libraries: the ${RUNTIME_CLASSPATH} entries of ${LOCKFILE}; POM, archive digest and the selected license entries read from the Gradle cache.`,
      'License candidates and texts are recorded only for packages that the Windows inventory does not cover; shared packages keep the Windows inventory records.',
    ],
    packages, libraries, candidate_texts_by_sha256: texts,
  };
}

function report(derived, root) {
  const { stdlib, ndk } = derived;
  return {
    schema_version: 1, date: DATE, status: 'targeted_selection_complete_delivery_not_yet_verified',
    scope: { target: 'android-universal', cargo_targets: TARGETS, build_host: BUILD_HOST, rust_toolchain: TOOLCHAIN, rust_commit: RUST_COMMIT, ndk: NDK_VERSION, features: ['tauri/custom-protocol'], product_version: derived.pkgVersion },
    base_selection: { path: WINDOWS, selection_id: derived.windows.selection_id, ...record(readFile(root, WINDOWS)) },
    method: [
      'Start from the reviewed Windows x64 selection. Every cargo package of the Android graph that the Windows selection covers keeps its decision, selected license and texts; only role, features and platform-specific wording change.',
      'Windows-only packages, the WebView2, MSVC and Windows runtime families, the NSIS/WiX installer families and their source archives are dropped.',
      'Each Android-only package has an explicit decision in scripts/release-license-select-android.mjs; MIT is selected where offered, using the complete original text, or the repository text at the publish commit where the crate ships none.',
      'The standard-library mapping follows the installed Android rust-std RLIB names, std/Cargo.toml and library/Cargo.lock of the exact Rust commit; on Android std links the NDK libunwind.',
      'The NDK pieces the linker copies into each library (libunwind, compiler-rt builtins, bionic CRT objects) are mapped to the NDK\'s NOTICE files; the NDK revision is pinned in android.yml.',
      'Every Java/Kotlin library of the release runtime classpath (gradle.lockfile) has an explicit decision; texts the artifacts ship and upstream NOTICE files are retained because Android packaging drops META-INF license files.',
      'Frontend and npm decisions are reused unchanged: the same dist is bundled on every platform. The own source trees are listed afresh from the working tree.',
    ],
    evidence: {
      rustc: stdlib.rustc,
      library_cargo_lock: stdlib.library_cargo_lock, std_cargo_toml: stdlib.std_cargo_toml, unwind_lib_rs: stdlib.unwind_lib_rs,
      installed_rlibs: Object.fromEntries(TARGETS.map(t => [t, stdlib.targets[t].rlibs.map(n => n.replace(/-[0-9a-f]+\.rlib$/, '.rlib'))])),
      compiler_builtins_native_objects: Object.fromEntries(TARGETS.map(t => [t, stdlib.targets[t].compiler_builtins_native_objects])),
      stdlib_crates: STDLIB.filter(s => s.lock).map(s => ({ name: s.name, version: s.version, lock_checksum: stdlib.lock.get(s.lock).checksum, archive: `https://static.crates.io/crates/${s.name}/${s.name}-${s.version}.crate` })),
      ndk,
      upstream_texts: Object.fromEntries(Object.entries(UPSTREAM_TEXTS).map(([k, t]) => [k, { path: t.path, ...record(readFile(root, t.path)), url: t.url }])),
      spdx: { tag: SPDX.tag, commit: SPDX.commit, mit: { path: SPDX_MIT.path, ...record(readFile(root, SPDX_MIT.path)) }, apache: { path: SPDX_APACHE.path, ...record(readFile(root, SPDX_APACHE.path)) } },
      gradle_lockfile: { path: LOCKFILE, ...record(readFile(root, LOCKFILE)), runtime_classpath: RUNTIME_CLASSPATH, libraries: derived.libraries.length },
    },
    changes: derived.changes,
    exclusions: [
      { components: STDLIB_NOT_LINKED, reason: 'Installed with rust-std for test, proc-macro, profiling or workspace plumbing; not linked into an application binary built without tests or instrumentation.' },
      { components: ['foldhash'], reason: 'hashbrown default-hasher is disabled in std; no foldhash RLIB is installed for any Android target.' },
      { components: ['windows_link', 'windows-sys', 'windows-targets', 'webview2-com', 'pageant'], reason: 'Windows-only branches of std and of the application graph.' },
      { components: ['tauri-android, tauri-plugin-dialog, tauri-plugin-fs, tauri-plugin-opener (Gradle projects)'], reason: 'Kotlin sources inside the tauri, tauri-plugin-dialog, tauri-plugin-fs and tauri-plugin-opener crates, built as Gradle projects; their cargo components cover them.' },
    ],
    remaining: [
      'Bind the selection against the built APK: assets/licenses must equal the prepared folder, and every library\'s NEEDED entries must stay within the Android system libraries.',
      'Recheck the roles and the lockfile on the release runner; android.yml prepares the folder from this selection before it builds.',
      'Complete product, installation and run-time acceptance on a real device.',
    ],
  };
}

// The own source trees with the Windows definitions, listed afresh. The tree
// that cargo generates must exist: build the app once before deriving.
function trees(root, windows) {
  return windows.inputs.trees.map(tree => {
    ensure(fs.existsSync(path.join(root, ...tree.path.split('/'))), `${tree.path} is missing; build the app once`);
    const files = [];
    const walk = relative => {
      for (const entry of fs.readdirSync(path.join(root, ...relative.split('/')), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const rel = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (!(tree.exclude_suffixes ?? []).some(s => rel.endsWith(s))) files.push({ path: rel, ...record(readFile(root, rel)) });
      }
    };
    walk(tree.path);
    return { ...tree, files: files.sort(byPath) };
  });
}

function selection(derived, root, pending) {
  const { windows } = derived;
  const files = windows.inputs.files.filter(f => !WINDOWS_ONLY_FILES.includes(f.path)).map(f => f.path);
  for (const file of WINDOWS_ONLY_FILES) ensure(windows.inputs.files.some(f => f.path === file), `Not a Windows input: ${file}`);
  const allFiles = [...new Set([...files, ...ANDROID_FILES, ...derived.documents.flatMap(d => d.sources.filter(s => s.kind === 'file').map(s => s.path))])].sort();
  for (const doc of derived.documents) for (const s of doc.sources) if (s.kind === 'file') ensure(!WINDOWS_ONLY_FILES.includes(s.path), `Dropped file still used: ${s.path}`);
  const cargoFiles = windows.inputs.cargo_files.filter(f => derived.packages.has(f.package));
  const newPackages = Object.keys(NEW_CRATES);
  for (const [key, decision] of Object.entries(NEW_CRATES)) {
    if (!decision.files) continue;
    const dir = path.dirname(derived.packages.get(key).manifest_path);
    for (const p of boundFiles(key, dir)) cargoFiles.push({ package: key, path: p, ...record(fs.readFileSync(path.join(dir, ...p.split('/')))) });
  }
  return {
    schema_version: 1,
    selection_id: `aidevbridge-android-universal-${DATE}`,
    scope: {
      target: 'android-universal', cargo_targets: TARGETS, build_host: BUILD_HOST, default_features: true, cargo_features: ['tauri/custom-protocol'], rust_toolchain: TOOLCHAIN, product_version: derived.pkgVersion,
      android_ndk: NDK_VERSION, minimum_sdk: 24, target_sdk: 36, abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
      meaning: 'License text selection for the Android application (one APK and App Bundle for arm64, armv7 and x86_64) plus explicitly disclosed source/build families; not binary, APK or App Bundle acceptance.',
      historical_evidence: `Derived on ${DATE} from ${WINDOWS} (selection ${windows.selection_id}) by scripts/release-license-select-android.mjs; ${REPORT} records the Android evidence, every dropped and added component and every reworded reason. Shared decisions keep their Windows decision reports; their Windows binary evidence is not repeated for Android.`,
    },
    selection_policy: [
      'Each component below has an explicit decision. The helper does not derive permission from inventory status fields or parse SPDX expressions to choose licenses.',
      'Packages shared with the Windows x64 selection keep its decision and texts. For ordinary permissive OR alternatives of Android-only packages, choose a complete existing MIT text; where a crate ships none, use the license text of its repository at the publish commit.',
      'Java and Kotlin libraries are Apache-2.0; texts the artifact ships and upstream NOTICE files are retained, otherwise the canonical SPDX Apache-2.0 text stands for the license the POM declares.',
      'Disclose complete permissive build/source family notices conservatively without claiming that the whole build tool is linked. The MPL cases keep their individual output-boundary decisions.',
      'Full texts are deduplicated only by exact SHA-256 bytes. Every original component, filename, notice and source association is retained.',
      'Source repository test fixtures and other operating systems are outside this selected application payload. Android system libraries and the WebView are provided by the device and not delivered. Future payload changes require review of this explicit selection.',
      'Existing consolidated notice files retain their original historical progress notes. Their bytes are included for complete text/attribution, not used as current release status.',
    ],
    decision_reports: derived.decisionReports,
    inputs: {
      files: allFiles.map(p => ({ path: p, ...record(pending.get(p) ?? readFile(root, p)) })),
      trees: trees(root, windows),
      absent: ABSENT,
      // A registry manifest never changes; the own one is hashed afresh.
      cargo_packages: windows.inputs.cargo_packages.filter(p => derived.packages.has(p.package)).map(p => p.source ? p : { ...p, manifest: record(fs.readFileSync(derived.packages.get(p.package).manifest_path)) }).concat(newPackages.map(key => {
        const pkg = derived.packages.get(key);
        return { package: key, source: pkg.source, manifest: record(fs.readFileSync(pkg.manifest_path)), declared_license: pkg.license };
      })).sort((a, b) => a.package.localeCompare(b.package)),
      cargo_files: cargoFiles.sort((a, b) => a.package.localeCompare(b.package) || byPath(a, b)),
      cargo_trees: windows.inputs.cargo_trees.filter(t => derived.packages.has(t.package)),
    },
    components: derived.components,
    documents: derived.documents,
    pending_delivery: [
      'Copy this exact folder into the APK and App Bundle (assets/licenses), as android.yml does, then inspect the built packages.',
      'Rebuild the application with the selected frontend/configuration and bind the final APK, App Bundle and library hashes.',
      'Bind the standard-library, NDK and system-library mapping against the built libraries: NEEDED entries must stay within the Android system libraries.',
      'Complete the remaining product, Android installation/run-time and source-repository release acceptance; this helper makes no release-ready or legal-approval claim.',
    ],
  };
}

export function write(root, { dryRun = false } = {}) {
  const derived = deriveSelection(root);
  // The selection binds the bytes of INVENTORY and REPORT, so they are made first.
  const pending = new Map([[INVENTORY, encode(inventory(derived))], [REPORT, encode(report(derived, root))]]);
  pending.set(SELECTION, encode(selection(derived, root, pending)));
  const roles = {};
  for (const key of Object.keys(NEW_CRATES)) roles[key] = derived.roles.get(key)?.role;
  const summary = { components: derived.components.length, documents: derived.documents.length, libraries: derived.libraries.length, added: derived.changes.added.length, dropped: derived.changes.dropped.length, replaced: derived.changes.replaced.length, role_changes: derived.changes.role.length, reworded: derived.changes.reason.length, new_texts: derived.newTexts.size, new_crate_roles: roles, written: [] };
  for (const [relative, bytes] of pending) {
    if (dryRun) continue;
    fs.writeFileSync(path.join(root, ...relative.split('/')), bytes);
    summary.written.push(relative);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    ensure(args.every(a => a === '--write'), 'Usage: NDK_HOME=<ndk> node scripts/release-license-select-android.mjs [--write]');
    const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    console.log(JSON.stringify(write(root, { dryRun: !args.includes('--write') }), null, 2));
  } catch (error) { console.error(`release-license-select-android: ${error.message}`); process.exitCode = 1; }
}
