# Third-party licenses

Notices and license texts for the third-party code in the frontend bundle and for copied assets. The Windows packages from `npm run build:windows` (MSI, NSIS and ZIP) carry the complete selected set in their `licenses/` folder (open `licenses/index.html`): this file, the Rust crates and the Rust standard library, the Microsoft and installer components, and the MIT text for the esbuild runtime helpers in the bundle ([esbuild-0.25.12-LICENSE-MIT.txt](docs/release/licenses/esbuild-0.25.12-LICENSE-MIT.txt)). The selection is [license-selection.windows-x64.json](docs/release/license-selection.windows-x64.json); the [Rust license inventory](docs/release/license-inventory-2026-09-12-rust.json) records declared licenses, source paths and available texts. The macOS app from `npm run build:macos` carries the set selected for macOS in `aidevbridge.app/Contents/Resources/licenses/`: this file, the Rust crates of the macOS build and the Rust standard library of both Apple targets; Apple's system libraries are part of macOS and not included. That selection is [license-selection.macos-universal.json](docs/release/license-selection.macos-universal.json). The Android app (APK and App Bundle from the release runs of `.github/workflows/android.yml`) carries the set selected for Android in its `assets/licenses/` folder: this file, the Rust crates and the Rust standard library of the three Android targets, the linked parts of the Android NDK (libunwind, compiler-rt, Bionic start objects), and every Java and Kotlin library in the Gradle lock file together with the NOTICE files of Kotlin, kotlinx and Jackson; Android's system libraries are part of the device and not included. cssparser, selectors and dtoa-short are licensed under MPL-2.0 and are part of the Android app; their entries name the unmodified source. That selection is [license-selection.android-universal.json](docs/release/license-selection.android-universal.json), with the [Android license inventory](docs/release/license-inventory-2026-10-28-android.json). The vendored russh source and its local changes are described in [AGENTBRIDGE-PATCH.md](vendor/russh/AGENTBRIDGE-PATCH.md). A bare `aidevbridge.exe` from `npm run build:app` carries none of these notices: pass on only the ZIP or an installer.

## Lucide (icons embedded in `src/icons.ts` and `src/styles.css`)

Source: https://lucide.dev, package `lucide-static` 1.41.0. `scripts/gen-icons.mjs` copies the icon geometries into `src/icons.ts`; `src/styles.css` inlines the `triangle-alert` geometry (Feather's `alert-triangle`, listed below) as a CSS mask. The full license text of the package follows verbatim (ISC for Lucide, MIT for the icons inherited from Feather).

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## xterm.js (`@xterm/xterm` and the addons `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `@xterm/addon-webgl`)

Source: https://xtermjs.org. Versions: `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-search` 0.16.0, `@xterm/addon-unicode11` 0.9.0, `@xterm/addon-web-links` 0.12.0 and `@xterm/addon-webgl` 0.19.0. The full license text of `node_modules/@xterm/xterm/LICENSE` follows verbatim (MIT). Each addon ships the same MIT text under the same copyright holder, The xterm.js authors, differing only in the year of its own copyright line (2017 for addon-search and addon-web-links, 2018 for addon-webgl, 2019 for addon-fit and addon-unicode11) and in not carrying the SourceLair and Christopher Jeffrey lines.

Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

The addons' own copyright lines, verbatim from their `LICENSE` files:

```text
Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2018, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
```

---

### Additional notices in the xterm JavaScript modules

The six packages above carry the following additional headers in their `lib/*.mjs` entry modules. These headers are retained verbatim here alongside the complete MIT permission and warranty terms above.

```text
/**
 * Copyright (c) 2014-2024 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * @license MIT
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 */

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
```

---

## Tauri (@tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/plugin-opener)

Versions: `@tauri-apps/api` 2.12.4, `@tauri-apps/plugin-dialog` 2.8.4 and `@tauri-apps/plugin-opener` 2.7.2. Their package manifests declare MIT and Apache-2.0 as alternatives; we choose the MIT alternative for these frontend packages. The full text below is copied from `node_modules/@tauri-apps/api/LICENSE-MIT`. The plugins' `LICENSE.spdx` files contain license declarations and copyright metadata, not the full permission text. Their notices and the API source notices follow the full MIT text.

MIT License

Copyright (c) 2017 - Present Tauri Apps Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Additional Tauri copyright notices

The API modules `core.js`, `event.js`, `window.js`, `dpi.js`, `image.js` and `app.js` carry:

```text
Copyright 2019-2024 Tauri Programme within The Commons Conservancy
```

Both plugins' `dist-js/index.js` files carry:

```text
Copyright 2019-2023 Tauri Programme within The Commons Conservancy
```

Both plugins' `LICENSE.spdx` files record:

```text
PackageCopyrightText: 2019-2022, The Tauri Programme in the Commons Conservancy
```

These source and package notices are retained together with the complete MIT permission and warranty terms above. The declared `plugin-opener` frontend package is included in this notice set; the inventoried frontend does not import it.

### tslib helpers in the Tauri API

`@tauri-apps/api` vendors two tslib helpers, `__classPrivateFieldGet` and `__classPrivateFieldSet`, in `external/tslib/tslib.es6.js`. They reach the frontend bundle because `window.js` uses `image.js`, whose `Image` class builds on `Resource` from `core.js`. The file's notice follows verbatim:

```text
/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
```

---

## Vite (generated modulepreload polyfill)

Source: package `vite` 6.4.5. The frontend contains Vite's generated modulepreload polyfill. The Vite core MIT text from `node_modules/vite/LICENSE.md` follows verbatim.

MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
