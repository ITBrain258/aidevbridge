// Die Beispieldaten der Bilder: Hosts, Sessions und Terminalinhalte. Alles hier ist
// erfunden; die Adressen stammen aus dem Dokumentationsbereich 192.0.2.0/24 (RFC 5737).

const esc = "\u001b[";
const dim = (text) => `${esc}90m${text}${esc}0m`;
const bold = (text) => `${esc}1m${text}${esc}0m`;
const red = (text) => `${esc}31m${text}${esc}0m`;
const green = (text) => `${esc}32m${text}${esc}0m`;
const yellow = (text) => `${esc}33m${text}${esc}0m`;
const cyan = (text) => `${esc}36m${text}${esc}0m`;
const magenta = (text) => `${esc}35m${text}${esc}0m`;
/** Cursor ausblenden: Ein Agent zeichnet seine Oberflaeche ohne blinkenden Block. */
const hideCursor = `${esc}?25l`;

const done = green("●");
const pending = yellow("●");

const apiRefactor = [
  `${dim("~/src/shop-api")} on ${magenta("main")}`,
  bold("> Move the order routes into their own module"),
  "",
  `${done} Read src/routes.ts (412 lines)`,
  `${done} Created src/routes/orders.ts`,
  `${pending} Edit src/routes.ts`,
  `  ${red('- import { orderRoutes } from "./orders-old";')}`,
  `  ${green('+ import { orderRoutes } from "./routes/orders";')}`,
  "",
  "Do you want to make this edit to routes.ts?",
  ` ${cyan("❯ 1. Yes")}`,
  "   2. Yes, and don't ask again this session",
  "   3. No, and tell the agent what to do differently",
].join("\n");

const checkoutTests = [
  `${dim("~/src/shop-web")} on ${magenta("fix/flaky-checkout")}`,
  bold("> Find out why the checkout tests flake on CI"),
  "",
  `${done} Ran npm test -- checkout --repeat 20`,
  `  ${dim("17 passed, 3 failed: applies coupon twice")}`,
  `${done} Read src/checkout/coupon.ts (186 lines)`,
  `${done} Two requests race on the same cart row.`,
  `  ${dim("Taking a row lock and running the suite again.")}`,
  "",
  `${green("●")} Ran npm test -- checkout --repeat 50`,
  `  ${dim("31/50 …")}`,
  "",
  `${yellow("✶")} Working… ${dim("(2m 14s)")}`,
].join("\n");

const trainEval = [
  `${dim("~/ml/ranker")} on ${magenta("eval-v3")}`,
  bold("> Compare the new ranker against last week's model"),
  "",
  `${done} Ran python eval.py --model v3 --baseline v2`,
  "",
  "  model   ndcg@10   recall@50   p95 latency",
  `  v2      0.712     0.884       41 ms`,
  `  v3      ${green("0.748")}     ${green("0.901")}       ${red("58 ms")}`,
  "",
  "v3 ranks better but is 41% slower. How should I go on?",
  ` ${cyan("❯ 1. Keep v3 and profile the latency")}`,
  "   2. Prune the model and evaluate again",
  "   3. Stop here",
].join("\n");

const docsSite = [
  `${dim("~/src/docs")} on ${magenta("main")}`,
  bold("> Update the install guide for the new CLI flags"),
  "",
  `${done} Updated docs/install.md (3 sections)`,
  `${done} Ran npm run build:docs, no broken links`,
  `${done} Committed 4f2a91c docs: new CLI flags`,
  "",
  "Done. The guide now covers --profile and --offline.",
  "",
  `${dim("›")} ${dim("Ready for the next task")}`,
].join("\n");

const dataImport = [
  `${dim("~/etl")} on ${magenta("main")}`,
  bold("> Backfill the import for October"),
  "",
  `${green("●")} Ran ./import.sh --month 2026-10`,
  `  ${dim("day 19 of 31 …")}`,
].join("\n");

const hostBase = { port: 22, tmux_socket: "agentbridge", history_limit: 10000, auth_kind: "key", show_default_socket: false, key_path: "~/.ssh/id_ed25519", user: "dev" };

export const hosts = [
  {
    ...hostBase,
    id: "host-build",
    label: "build-box",
    hostname: "192.0.2.10",
    sessions: [
      { id: 1, name: "api-refactor", status: "busy", reason: "agent is busy", screen: hideCursor + apiRefactor },
      { id: 2, name: "checkout-tests", status: "busy", reason: "agent is busy", screen: hideCursor + checkoutTests },
      { id: 3, name: "docs-site", status: "idle", reason: "agent is idle", screen: hideCursor + docsSite },
    ],
  },
  {
    ...hostBase,
    id: "host-gpu",
    label: "gpu-lab",
    hostname: "192.0.2.20",
    sessions: [
      { id: 11, name: "train-eval", status: "busy", reason: "agent is busy", screen: hideCursor + trainEval },
      { id: 12, name: "data-import", status: "busy", reason: "agent is busy", screen: hideCursor + dataImport },
    ],
  },
  { ...hostBase, id: "host-nas", label: "home-nas", hostname: "192.0.2.30", sessions: [] },
];

function settings(tiles, overrides = {}) {
  return {
    theme: "turquoise",
    terminal_font_size: 13,
    copy_on_select: false,
    ctrl_cv_clipboard: true,
    right_click: "menu",
    restore_workspace: true,
    sidebar_width: 280,
    settings_path: "settings.toml",
    workspace: {
      layout: 4,
      tiles_version: 2,
      sidebar_collapsed: false,
      expanded: ["host-build", "host-gpu"],
      connected: ["host-build", "host-gpu"],
      tiles: tiles.map(([host_id, session], slot) => ({ slot, host_id, session })),
      dirs: {},
    },
    ...overrides,
  };
}

const fourTiles = [
  ["host-build", "api-refactor"],
  ["host-build", "checkout-tests"],
  ["host-gpu", "train-eval"],
  ["host-build", "docs-site"],
];

export const desktopScene = { hosts, settings: settings(fourTiles) };
export const phoneScene = {
  hosts,
  settings: settings([["host-build", "api-refactor"]], { sidebar_width: 280 }),
  sshKeys: [],
  generatedKey: {
    key: { path: "aidevbridge_ed25519", file_name: "aidevbridge_ed25519", key_type: "ed25519", comment: "aidevbridge@android" },
    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK7v3mQ2xWc9Jt0pLr8sYfNa4hE1uZbD6gTqV5oXyM2c aidevbridge@android",
  },
};

/** Wer in der Spur wartet und seit wann (Minuten vor dem Bild), die aelteste zuerst. */
export const waitingSteps = [
  { id: 11, reason: "input needed", minutesAgo: 14 },
  { id: 1, reason: "permission prompt", minutesAgo: 3 },
];
