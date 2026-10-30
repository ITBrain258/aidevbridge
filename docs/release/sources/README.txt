aidevbridge - offline installer source companions

The two ZIPs in this folder are unchanged official upstream commit archives.
They provide corresponding source, original notices and build context for the
installer components mapped below. They are complete upstream source trees;
including them does not mean every upstream component is in aidevbridge.
The adjacent ../manifest.json maps source ZIPs and full license texts to the
selected components. Original binary-distribution license texts remain under
../texts/. Some upstream source-archive texts use different line endings;
both original versions are retained without conversion.

Read the sources by opening or extracting a ZIP with a standard ZIP reader.
No installation, network access or build is needed to read the contents.
Paths below are relative to each archive's single top-level directory.
Read the upstream instructions before attempting a build. These archives
contain the upstream source/build files, not an offline compiler toolchain.
No claim is made that the distributed upstream binaries were rebuilt or
that a byte-identical rebuild was achieved from these archives.

1. WiX UI custom action, UI tables and six graphics (installer:wix-ui)

File: wix-3.14.1-source.zip
Upstream version/tag: WiX 3.14.1 / wix3141rtm
Commit: b40e9a32c24033e11b77baf2c91a704382f898ed
Root directory: wix3-b40e9a32c24033e11b77baf2c91a704382f898ed
Bytes: 13859146
SHA-256: 3cc4bdaca8070042a182675b047882211d042f35139efcb0eeac35eeb81bf9d3
Official source:
https://github.com/wixtoolset/wix3/archive/b40e9a32c24033e11b77baf2c91a704382f898ed.zip
Original download resolved to:
https://codeload.github.com/wixtoolset/wix3/zip/b40e9a32c24033e11b77baf2c91a704382f898ed

Start with LICENSE.TXT, Readme.md and src/ext/UIExtension/ca/:
DriveCheck.cpp, PrintEula.cpp, dllmain.cpp, precomp.h, cost.h, uica.def,
uica.rc and uica.vcxproj. Supporting code and build context are retained in
src/libs/dutil/, src/libs/wcautil/, tools/WixBuild.props and
tools/WixBuild.targets. UI tables and graphics are in
src/ext/UIExtension/wixlib/, including Common.wxs, WixUI_InstallDir.wxs,
UIExtension.wixproj and Bitmaps/. The icon filenames include New.ico and
Up.ico with that exact capitalization.

2. NSIS LZMA decoder (installer:nsis-lzma-decoder)

File: nsis-3.13-source.zip
Upstream version/tag: NSIS 3.13 / v313
Commit: a4ba28e60bd9e7c271cd2bfc1558889ce3355653
Root directory: nsis-a4ba28e60bd9e7c271cd2bfc1558889ce3355653
Bytes: 2337690
SHA-256: 649b8c2a9c856fa8116cf0e2d6d91492acf3922d7dde10736e5742a178c8b22d
Official source:
https://github.com/nsis-dev/nsis/archive/a4ba28e60bd9e7c271cd2bfc1558889ce3355653.zip
Original download resolved to:
https://codeload.github.com/nsis-dev/nsis/zip/a4ba28e60bd9e7c271cd2bfc1558889ce3355653

Start with COPYING (including the CPL and NSIS linking exception), INSTALL,
Source/7zip/LZMADecode.c, Source/7zip/LZMADecode.h and Source/Platform.h.
The stub build is described by Source/exehead/SConscript. The complete
SConstruct and SCons/ build context is included, together with the rest
of the original source tree.

These retained ZIP bytes were checked against their complete upstream Git
trees. A later server-generated archive of the same commit may have different
compressed bytes. Preserve these copies and their hashes; a changed download
requires a new provenance/content check, not an automatic hash replacement.
