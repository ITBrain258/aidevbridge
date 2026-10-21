// Read-only, offline inventory. Emits JSON to stdout; never builds or downloads.
// Run from any cwd: node scripts/release-license-inventory-frontend.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p));
const json = (p) => JSON.parse(read(p));
const exists = (p) => fs.existsSync(path.join(root, p));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const normalized = (text) => text.replace(/\s+/g, " ").trim();
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const file = (p) => {
  const bytes = read(p);
  return { path: p, bytes: bytes.length, sha256: sha(bytes) };
};
function walk(p) {
  if (!exists(p)) return [];
  return fs.readdirSync(path.join(root, p), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git") return [];
    const child = `${p}/${entry.name}`;
    return entry.isDirectory() ? walk(child) : [child];
  }).sort();
}
function imports(p) {
  const source = ts.createSourceFile(p, read(p).toString(), ts.ScriptTarget.Latest, true);
  const results = [];
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier)) results.push({
      path: p, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      specifier: specifier.text, kind: ts.isCallExpression(node) ? "dynamic" : "static",
      type_only: ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : false,
    });
    ts.forEachChild(node, visit);
  }
  visit(source);
  return results;
}
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const manifest = json("package.json");
const lock = json("package-lock.json");
const centralText = read("THIRD_PARTY_LICENSES.md").toString();
const tracked = git("ls-files", "src").split("\n");
const sourceFiles = tracked.filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
const productionImports = sourceFiles.flatMap(imports).filter((i) => !i.specifier.startsWith(".") && !i.type_only);
const imported = new Set(productionImports.map((i) => packageName(i.specifier)));
const licensesIn = (p) => walk(p).filter((f) => /(?:^|\/)(?:licen[cs]e[^/]*|notice[^/]*|copying[^/]*|copyright[^/]*|thirdpartynoticetext[^/]*)(?:\/|$)/i.test(f));
const packages = Object.entries(lock.packages).filter(([p]) => p).map(([p, item]) => {
  const name = p.split("node_modules/").at(-1);
  const installed = exists(`${p}/package.json`) ? json(`${p}/package.json`) : null;
  let role = item.dev ? "development_or_build_dependency" : "declared_runtime_not_imported";
  if (imported.has(name)) role = "production_source_import";
  if (name === "lucide-static") role = "development_dependency_with_icon_geometry_comparison";
  if (name === "vite") role = "build_tool_runtime_inclusion_requires_release_check";
  return {
    name, package_path: p, lock_version: item.version, installed_version: installed?.version ?? null,
    installed_matches_lock: installed ? installed.version === item.version : null,
    declared_spdx: item.license ?? null, installed_declared_spdx: installed?.license ?? null,
    integrity: item.integrity ?? null, resolved: item.resolved ?? null,
    lock_dev: item.dev === true, optional: item.optional === true, role,
    direct_dependency: Object.hasOwn(manifest.dependencies ?? {}, name),
    direct_dev_dependency: Object.hasOwn(manifest.devDependencies ?? {}, name),
    dependencies: item.dependencies ?? {},
    package_manifest: installed ? file(`${p}/package.json`) : null,
    license_and_notice_files: installed ? licensesIn(p).map((f) => {
      const text = read(f).toString();
      return { ...file(f), format: f.endsWith(".spdx") ? "spdx_metadata_not_full_license_text" : "text",
        full_file_found_in_central_after_whitespace_normalization: normalized(centralText).includes(normalized(text)),
        copyright_lines: text.split(/\r?\n/).filter((line) => /copyright|PackageCopyrightText/i.test(line)).map((line) => line.trim()),
      };
    }) : [],
  };
});

const iconSource = read("src/icons.ts").toString();
const iconNames = JSON.parse(iconSource.match(/ICON_NAMES = (\[[^\n]+\])/)[1]);
const iconAst = ts.createSourceFile("src/icons.ts", iconSource, ts.ScriptTarget.Latest, true);
const generatedPaths = {};
function visitIcons(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(iconAst) === "PATHS" && ts.isObjectLiteralExpression(node.initializer)) {
    for (const property of node.initializer.properties) generatedPaths[property.name.text] = property.initializer.text;
  }
  ts.forEachChild(node, visitIcons);
}
visitIcons(iconAst);
const innerMarkup = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
  .replace(/<!--[\s\S]*?-->/g, "").replace(/\s*\n\s*/g, "").trim();
const lucideLicense = read("node_modules/lucide-static/LICENSE").toString();
const featherNames = lucideLicense.split("The following Lucide icons are derived from the Feather project:")[1]
  .split("The MIT License")[0].trim().split(/,\s*/);
const inheritedGeometry = featherNames.filter((name) => exists(`node_modules/lucide-static/icons/${name}.svg`))
  .map((name) => [name, innerMarkup(read(`node_modules/lucide-static/icons/${name}.svg`).toString())]);
const icons = iconNames.map((name) => {
  const p = `node_modules/lucide-static/icons/${name}.svg`;
  const inner = innerMarkup(read(p).toString());
  return { name, source: file(p), generated_markup_sha256: sha(generatedPaths[name]),
    normalized_source_matches_generated: inner === generatedPaths[name],
    explicitly_feather_listed: featherNames.includes(name),
    feather_listed_names_with_identical_normalized_geometry: inheritedGeometry.filter(([, value]) => value === inner).map(([name]) => name),
  };
});

// Die Laufzeitmodule folgen aus den Produktionsimporten, aufgeloest wie im
// Bundler (Vite bevorzugt ESM): Bedingung "import" in "exports" (auch Muster
// "./*"), sonst "module", sonst "main". Relative Importe innerhalb von
// node_modules werden verfolgt; ein neuer Import oder ein neu erreichtes Modul
// erscheint hier ohne Aenderung an dieser Datei.
const exportTarget = (value) => typeof value === "string" ? value : value?.import ?? value?.module ?? value?.default ?? null;
function resolvePackageImport(specifier) {
  const name = packageName(specifier);
  const base = `node_modules/${name}`;
  if (!exists(`${base}/package.json`)) throw new Error(`Production import without an installed package: ${specifier}`);
  const manifestJson = json(`${base}/package.json`);
  const wanted = `.${specifier.slice(name.length)}`;
  let target = null;
  if (manifestJson.exports && typeof manifestJson.exports === "object") {
    const map = Object.keys(manifestJson.exports).some((key) => key.startsWith(".")) ? manifestJson.exports : { ".": manifestJson.exports };
    if (Object.hasOwn(map, wanted)) target = exportTarget(map[wanted]);
    else for (const [key, value] of Object.entries(map)) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const prefix = key.slice(0, star), suffix = key.slice(star + 1);
      if (!wanted.startsWith(prefix) || !wanted.endsWith(suffix) || wanted.length < prefix.length + suffix.length) continue;
      target = exportTarget(value)?.replace("*", wanted.slice(prefix.length, wanted.length - suffix.length)) ?? null;
      break;
    }
  } else target = wanted === "." ? manifestJson.module ?? manifestJson.main ?? "index.js" : wanted;
  if (!target) throw new Error(`Unresolved production import: ${specifier}`);
  return path.posix.join(base, target);
}
function runtimeModules(specifiers) {
  const reached = new Map();
  const queue = specifiers.map((specifier) => [resolvePackageImport(specifier), specifier]);
  while (queue.length > 0) {
    const [p, via] = queue.shift();
    const vias = reached.get(p) ?? new Set();
    if (vias.has(via)) continue;
    vias.add(via);
    reached.set(p, vias);
    if (!/\.m?js$/.test(p)) continue;
    for (const item of imports(p)) {
      if (item.type_only) continue;
      queue.push([item.specifier.startsWith(".") ? path.posix.join(path.posix.dirname(p), item.specifier) : resolvePackageImport(item.specifier), via]);
    }
  }
  return [...reached].sort(([a], [b]) => a.localeCompare(b)).map(([p, vias]) => ({ path: p, reached_from: [...vias].sort() }));
}
const runtimeEntries = runtimeModules([...new Set(productionImports.map((item) => item.specifier))].sort());
const entryHeaders = runtimeEntries.map(({ path: p, reached_from }) => {
  const text = read(p).toString();
  const blocks = [...(text.match(/\/\*[\s\S]*?\*\//g) ?? [])]
    .filter((block) => /copyright|@license/i.test(block) && !block.includes("@example"));
  const lineHeaders = text.split(/\r?\n/).filter((line) => /^\/\/.*(?:Copyright|SPDX-License-Identifier)/.test(line));
  return { ...file(p), reached_from, header_blocks: [...new Set(blocks)], line_headers: lineHeaders };
});
// Als data-URI in getracktes CSS eingebettete Icons sind ebenfalls kopierte
// Geometrie. Ihre Pfaddaten werden mit allen Icons aus icon-nodes.json von
// lucide-static und mit den Feather-Namen verglichen; eine nicht lesbare
// data-URI erscheint mit svg_sha256 null, statt zu fehlen.
const svgPathData = (svg) => [...svg.matchAll(/\bd=(["'])(.*?)\1/g)].map((match) => match[2]);
const lucideGeometry = Object.entries(json("node_modules/lucide-static/icon-nodes.json"))
  .map(([name, nodes]) => [name, JSON.stringify(nodes.filter(([, attributes]) => typeof attributes?.d === "string").map(([, attributes]) => attributes.d))]);
const featherGeometry = inheritedGeometry.map(([name, inner]) => [name, JSON.stringify(svgPathData(inner))]);
function decodeSvgUri(uri) {
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const data = uri.slice(comma + 1);
  try { return uri.slice(0, comma).includes(";base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data); } catch { return null; }
}
const cssEmbeddedSvgs = tracked.filter((p) => p.endsWith(".css")).flatMap((p) => read(p).toString().split(/\r?\n/).flatMap((text, index) => {
  const found = [...text.matchAll(/url\(\s*(?:"(data:image\/svg[^"]*)"|'(data:image\/svg[^']*)'|(data:image\/svg[^)\s]*))\s*\)/g)]
    .map((match) => decodeSvgUri(match[1] ?? match[2] ?? match[3]));
  const total = (text.match(/data:image\/svg/g) ?? []).length;
  return [...found, ...Array(Math.max(0, total - found.length)).fill(null)].map((svg) => {
    const geometry = svg === null ? [] : svgPathData(svg);
    const same = (candidates) => geometry.length === 0 ? [] : candidates.filter(([, value]) => value === JSON.stringify(geometry)).map(([name]) => name);
    return { path: p, line: index + 1, svg_sha256: svg === null ? null : sha(svg), path_data: geometry,
      matching_lucide_icons: same(lucideGeometry), feather_listed_names_with_identical_geometry: same(featherGeometry) };
  });
}));
const tslibImporter = runtimeEntries.map((entry) => entry.path)
  .find((p) => /\.m?js$/.test(p) && imports(p).some((item) => item.specifier.includes("tslib"))) ?? null;
const distFiles = walk("dist");
const dist = distFiles.map((p) => {
  const text = read(p).toString();
  return { ...file(p), mtime_utc: fs.statSync(path.join(root, p)).mtime.toISOString(),
    embedded_app_versions: [...new Set(text.match(/aidevbridge \d+\.\d+\.\d+ \([a-z0-9]+\)/g) ?? [])],
    license_comments: (text.match(/\/\*[\s\S]*?\*\//g) ?? []).filter((block) => /copyright|license|permission/i.test(block)),
    markers: Object.fromEntries(["modulepreload", "plugin:dialog|open", "plugin:opener|open_url", "Microsoft", "VoidZero", "Lucide", "Cole Bemis", "SourceLair", "SuppressedError", "Cannot read private member from an object whose class did not declare it"].map((marker) => [marker, text.includes(marker)])),
  };
});
const viteChunk = walk("node_modules/vite/dist/node/chunks").find((p) => p.endsWith(".js") && read(p).toString().includes("function polyfill()"));
const viteText = read(viteChunk).toString();
const polyfillStart = viteText.indexOf("function polyfill()");
const polyfillEnd = viteText.indexOf("\n}\n", polyfillStart) + 2;
const polyfill = viteText.slice(polyfillStart, polyfillEnd);
const bundledTslib = "node_modules/@tauri-apps/api/external/tslib/tslib.es6.js";
const tslibText = read(bundledTslib).toString();

// Manual assessment of the original 2026-09-12 snapshot, never a fresh verdict.
// The current file evidence is compared below; changing an input requires review.
const historicalFindings = [
  { id: "F1", scope: "central_documentation", finding: "Cargo.lock does not contain Rust license fields/texts; opening statement remains incorrect.", action: "Replace the statement and link the separately scoped Rust inventory." },
  { id: "F2", scope: "copied_assets", finding: "lucide-static is dev-only in npm metadata but 16 SVG geometries are copied into tracked src/icons.ts. All 16 match installed 1.41.0. Full Lucide ISC/Feather MIT text is already present centrally.", action: "Retain both texts with generated assets in source and release distributions; retain version/generator provenance." },
  { id: "F3", scope: "build_generated_runtime", finding: "Existing dist contains the modulepreload polyfill matching the Vite generator structure; Vite core copyright and MIT text are absent from the central document.", action: "Include the relevant Vite core MIT text in the release notices. Do not infer that all Vite build-time bundled dependencies enter the app." },
  { id: "F4", scope: "embedded_package_notices", finding: "All five installed xterm ESM entries carry an additional Microsoft MIT header. It is absent from the central document and the existing dist comments. Package-level SPDX alone misses these notices.", action: "Preserve relevant Microsoft notice with MIT text in the final shipped notice set; verify any claimed tree-shaking exclusion against the exact release bundle." },
  { id: "F5", scope: "tauri_notice_provenance", finding: "plugin-dialog ships SPDX metadata with 2019-2022 Commons Conservancy copyright, and its JS header names 2019-2023. API core/event headers name 2019-2024. Central MIT text names 2017-Present Tauri Apps Contributors but omits these exact versioned copyright lines.", action: "Retain the package/source copyright notices alongside the chosen MIT text. LICENSE.spdx is metadata, not the complete permission text." },
  { id: "F6", scope: "artifact_delivery", finding: "Existing dist has HTML/CSS/JS only. CSS retains a full historical xterm MIT notice; JS retains five xterm MIT headers. Lucide/Feather, Vite and Tauri full notice delivery is not demonstrated by this dist.", action: "Generate and inspect release-matched offline notice delivery in the actual installer/portable package; this inventory does not perform packaging." },
  { id: "F7", scope: "embedded_helpers", finding: "Tauri API includes an external tslib file with a separate Microsoft permissive license header; core.js imports it. Existing dist lacks its characteristic helper strings, consistent with tree shaking of unused Channel/Resource code. Exact tslib version is not independently pinned by this app's lock.", action: "Record the vendored file hash/version uncertainty and recheck inclusion for each release; do not label all API vendored source as automatically bundled." },
  { id: "F8", scope: "generated_glue", finding: "Existing dist begins with generated private-field/property helpers. Build tooling includes esbuild under MIT. This offline inspection does not decide licensing applicability to generic compiler-generated glue.", action: "Keep build/helper provenance visible in the final bundle review; do not equate all devDependency code with either included runtime or complete absence." },
];

const frontendPaths = ["src", "package.json", "package-lock.json", "vite.config.ts", "scripts/gen-icons.mjs", "src-tauri/icons"];
const embeddedVersions = [...new Set(dist.flatMap((item) => item.embedded_app_versions))].sort();
const embeddedCommits = [...new Set(embeddedVersions.map((version) => /\(([a-f0-9]{7,40})\)$/.exec(version)?.[1]).filter(Boolean))].sort();
const embeddedCommit = embeddedCommits.length === 1 && embeddedVersions.every((version) => /\(([a-f0-9]{7,40})\)$/.test(version)) ? embeddedCommits[0] : null;
let resolvedEmbeddedCommit = null;
let committedDiff = null;
let commitResolution = embeddedCommit ? "commit_not_resolved_locally" : "no_unique_valid_commit_stamp";
let committedDiffStatus = "not_compared_without_resolved_commit";
if (embeddedCommit) {
  try {
    resolvedEmbeddedCommit = git("rev-parse", "--verify", `${embeddedCommit}^{commit}`);
    commitResolution = "resolved_local_commit";
  } catch { /* A missing/ambiguous local commit is not an empty successful diff. */ }
}
if (resolvedEmbeddedCommit) {
  try {
    committedDiff = git("diff", "--name-only", resolvedEmbeddedCommit, "HEAD", "--", ...frontendPaths).split("\n").filter(Boolean);
    committedDiffStatus = "observed";
  } catch { committedDiffStatus = "git_diff_failed"; }
}

const result = {
  schema: "aidevbridge_frontend_asset_license_inventory_v2", generated_utc: new Date().toISOString(),
  source_commit: git("rev-parse", "HEAD"), project_version: manifest.version,
  scope: "Offline local manifests, installed text files, production source imports, copied SVG geometries and existing dist; no legal opinion, build, network access or binary extraction.",
  limits: ["Package declaration/installed presence is not proof every byte ships.", "Existing dist has no source map/metafile or build attestation; source imports and observed markers are separately identified.", "Absent optional platform packages have lock metadata only.", "Rust/native/Tauri binary licenses are inventoried separately.", "Artifact mtimes are observations, not provenance attestation."],
  inputs: ["package.json", "package-lock.json", "THIRD_PARTY_LICENSES.md", "vite.config.ts", "scripts/gen-icons.mjs", "src/icons.ts", "scripts/release-license-inventory-frontend.mjs"].map(file),
  source_files: sourceFiles.map(file), production_imports: productionImports,
  counts: { locked_packages: packages.length, installed_packages: packages.filter((p) => p.installed_version).length,
    lock_runtime_packages: packages.filter((p) => !p.lock_dev).length, source_imported_packages: imported.size,
    generated_icons: icons.length, imported_package_names: [...imported].sort(),
    runtime_modules: runtimeEntries.length, css_embedded_svgs: cssEmbeddedSvgs.length },
  packages,
  copied_assets: { generator: file("scripts/gen-icons.mjs"), output: file("src/icons.ts"), package: "lucide-static", version: packages.find((p) => p.name === "lucide-static").installed_version,
    package_declared_spdx: packages.find((p) => p.name === "lucide-static").installed_declared_spdx, icons, css_embedded_svgs: cssEmbeddedSvgs,
    note: "Identical geometry aliases establish an additional provenance link (triangle-alert/alert-triangle). Absence from the inherited-name list is not a legal finding that an icon has no earlier provenance." },
  application_brand_assets: { source: file("src-tauri/icons/source.svg"), files: walk("src-tauri/icons").map(file),
    provenance_assessment: "Current files are hashed, not rerendered or manually reassessed. See the historical manual assessment for the original SVG provenance reading." },
  runtime_entry_headers: entryHeaders,
  embedded_helpers: {
    vite_modulepreload: { package: "vite", version: packages.find((p) => p.name === "vite").installed_version,
      source: file(viteChunk), function_sha256: sha(polyfill), function_line: viteText.slice(0, polyfillStart).split("\n").length,
      source_function: polyfill, dist_files_with_modulepreload_marker: dist.filter((item) => item.markers.modulepreload).map((item) => item.path),
      inclusion_assessment: "Markers alone do not prove a matching emitted polyfill; current inclusion is not manually reassessed." },
    tauri_vendored_tslib: { ...file(bundledTslib), inspected_entry: tslibImporter,
      entry_imports: tslibImporter ? imports(tslibImporter).filter((item) => item.specifier.includes("tslib")) : [],
      reached_from: runtimeEntries.find((entry) => entry.path === bundledTslib)?.reached_from ?? [],
      declared_upstream_range: json("node_modules/@tauri-apps/api/package.json").devDependencies?.tslib,
      exact_version: null, license_header: tslibText.match(/\/\*[\s\S]*?\*\//)?.[0],
      license_assessment: "No SPDX identifier is assigned automatically; the current header is recorded verbatim.", inclusion: "Not automatically decided; current imports and dist markers are recorded separately from the historical assessment." },
  },
  existing_dist: dist,
  dist_provenance: { observed_app_version_stamps: embeddedVersions, observed_embedded_commits: embeddedCommits,
    embedded_commit: embeddedCommit, resolved_embedded_commit: resolvedEmbeddedCommit, commit_resolution: commitResolution,
    inspected_frontend_paths: frontendPaths,
    committed_frontend_diff_from_embedded_commit_to_head: committedDiff, committed_diff_status: committedDiffStatus,
    tracked_worktree_diff_from_head: git("diff", "--name-only", "HEAD", "--", ...frontendPaths).split("\n").filter(Boolean),
    untracked_frontend_paths: git("ls-files", "--others", "--exclude-standard", "--", ...frontendPaths).split("\n").filter(Boolean),
    caveat: "Commit stamps come from current dist bytes. A null committed diff means it was not established. These scoped Git observations are not a clean-tree/build attestation or an EXE provenance link." },
  existing_exe: exists("target/release/aidevbridge.exe") ? { ...file("target/release/aidevbridge.exe"), mtime_utc: fs.statSync(path.join(root, "target/release/aidevbridge.exe")).mtime.toISOString(), contents_inspected: false } : null,
};

// Compare actual referenced files, excluding this evolving generator itself.
// mtimes/HEAD do not identify file contents and are intentionally not hashed here.
const evidenceFiles = new Map();
function collectEvidence(value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.path === "string" && typeof value.sha256 === "string" && value.path !== "scripts/release-license-inventory-frontend.mjs") {
    const previous = evidenceFiles.get(value.path);
    if (previous && previous !== value.sha256) throw new Error(`Input changed during inventory: ${value.path}`);
    evidenceFiles.set(value.path, value.sha256);
  }
  for (const child of Object.values(value)) collectEvidence(child);
}
collectEvidence(result);
const evidenceEntries = [...evidenceFiles.entries()].sort(([a], [b]) => a.localeCompare(b));
const currentEvidenceSha = sha(JSON.stringify(evidenceEntries));
const baselineEvidenceSha = "cc23f2bb4c788982fced19978a828d7eb43b576a2a5e6adb1d3c6013ab0494b4";
result.historical_manual_assessment = {
  assessed_date: "2026-09-12", source_commit: "1422020f1de3b45a81ea236f59626467a088c80f",
  baseline_evidence_file_count: 260, baseline_evidence_sha256: baselineEvidenceSha,
  current_evidence_file_count: evidenceEntries.length, current_evidence_sha256: currentEvidenceSha,
  current_files_match_baseline: currentEvidenceSha === baselineEvidenceSha,
  current_assessment_status: currentEvidenceSha === baselineEvidenceSha ? "same_recorded_file_evidence_manual_assessment_not_rerun" : "inputs_differ_historical_findings_not_reassessed",
  contract: "F1-F8 describe only the pinned historical snapshot. A rerun collects observations, not a new compliance or remediation verdict. Changed files invalidate carry-forward of those findings.",
  additional_historical_readings: {
    lucide_license_text_included: ["ISC", "MIT (Feather-derived icons)"],
    application_brand_svg: "Tracked geometric, font-free app-logo SVG described itself as source for tauri icon; no external logo/font source was identified in that snapshot.",
  },
  findings: historicalFindings,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
