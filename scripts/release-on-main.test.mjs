import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitOnMain, defaultRemote } from './release-on-main.mjs';

const SCRIPT = fileURLToPath(new URL('./release-on-main.mjs', import.meta.url));

// Die Pruefung laeuft im Workflow in einem flachen Checkout (ein Commit, wie
// actions/checkout ihn holt) gegen das Repository auf GitHub. Hier steht an
// dessen Stelle ein Repository in einem temporaeren Ordner, erreichbar ueber
// eine file://-URL, und der Checkout entsteht auf dieselbe Weise: git init,
// ein Abruf mit --depth=1, dann der Commit ohne Branch. Dieses Repository
// hier wird dabei nicht angefasst.
//
//   A - B - C - M - D        main (M fuehrt den Branch side zusammen)
//        \   \ /
//         \   S              side
//          X                 feature, nie gemergt

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync('git', [
  '-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', `core.hooksPath=${path.join(cwd, '.no-hooks')}`, '-c', 'advice.detachedHead=false', ...args,
], { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Das Repository an der Stelle von GitHub und, je Aufruf von checkout, ein
// Checkout daneben. `remove` raeumt den ganzen Ordner wieder weg.
function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'release-on-main-'));
  const remove = () => fs.rmSync(base, { recursive: true, force: true });
  const origin = path.join(base, 'origin');
  fs.mkdirSync(origin);
  git(origin, ['init', '--quiet', '--initial-branch=main']);
  /** @param {string} name */
  const commit = name => {
    fs.writeFileSync(path.join(origin, `${name}.txt`), `${name}\n`);
    git(origin, ['add', '.']);
    git(origin, ['commit', '--quiet', '-m', name]);
    // Ein Branch je Commit, damit der flache Abruf ihn beim Namen nennen kann.
    git(origin, ['branch', `at-${name}`]);
    return git(origin, ['rev-parse', 'HEAD']);
  };
  /** @type {Record<string, string>} */
  const sha = {};
  sha.A = commit('A');
  sha.B = commit('B');
  git(origin, ['checkout', '--quiet', '-b', 'feature']);
  sha.X = commit('X');
  git(origin, ['checkout', '--quiet', 'main']);
  sha.C = commit('C');
  git(origin, ['checkout', '--quiet', '-b', 'side']);
  sha.S = commit('S');
  git(origin, ['checkout', '--quiet', 'main']);
  git(origin, ['merge', '--quiet', '--no-ff', '-m', 'M', 'side']);
  git(origin, ['branch', 'at-M']);
  sha.M = git(origin, ['rev-parse', 'HEAD']);
  sha.D = commit('D');
  const remote = pathToFileURL(origin).href;
  let count = 0;
  // Ein Checkout des Commits `name`, flach wie im Workflow oder vollstaendig.
  /** @param {string} name @param {{ shallow?: boolean }} [options] */
  const checkout = (name, { shallow = true } = {}) => {
    const dir = path.join(base, `checkout-${++count}`);
    fs.mkdirSync(dir);
    git(dir, ['init', '--quiet', '--initial-branch=unused']);
    git(dir, ['fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth=1'] : []), remote, `refs/heads/at-${name}`]);
    git(dir, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), sha[name]);
    assert.equal(git(dir, ['rev-parse', '--is-shallow-repository']), String(shallow));
    return dir;
  };
  return { base, origin, remote, sha, checkout, remove };
}

// Ein Repository fuer alle Tests, die es nur lesen; wer es veraendert, baut
// sich ein eigenes.
/** @type {ReturnType<typeof fixture>} */
let shared;
before(() => { shared = fixture(); });
after(() => shared?.remove());

test('a commit on main passes in a shallow checkout: the head, an ancestor and a merged branch', () => {
  const { remote, sha, checkout } = shared;
  // Der Kopf von main, wie bei einem Tag direkt nach dem Merge.
  assert.deepEqual(commitOnMain({ cwd: checkout('D'), remote }), { onMain: true, head: sha.D, main: sha.D });
  // main ist seit dem Tag weitergelaufen.
  assert.deepEqual(commitOnMain({ cwd: checkout('B'), remote }), { onMain: true, head: sha.B, main: sha.D });
  assert.deepEqual(commitOnMain({ cwd: checkout('M'), remote }), { onMain: true, head: sha.M, main: sha.D });
  // Nur ueber den zweiten Elternteil des Merge-Commits erreichbar.
  assert.deepEqual(commitOnMain({ cwd: checkout('S'), remote }), { onMain: true, head: sha.S, main: sha.D });
});

test('a commit that never reached main is refused in a shallow checkout', t => {
  const { remote, origin, sha, checkout, remove } = fixture();
  t.after(remove);
  assert.deepEqual(commitOnMain({ cwd: checkout('X'), remote }), { onMain: false, head: sha.X, main: sha.D });
  // Der Kopf eines Branches, dessen Aenderung als ein neuer Commit auf main
  // kam (Squash): gleicher Inhalt, aber nicht dieser Commit.
  git(origin, ['merge', '--quiet', '--squash', 'feature']);
  git(origin, ['commit', '--quiet', '-m', 'X (squashed)']);
  const squashed = git(origin, ['rev-parse', 'HEAD']);
  assert.deepEqual(commitOnMain({ cwd: checkout('X'), remote }), { onMain: false, head: sha.X, main: squashed });
  // Ein Commit, der main voraus ist.
  git(origin, ['checkout', '--quiet', '-b', 'ahead']);
  fs.writeFileSync(path.join(origin, 'ahead.txt'), 'ahead\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '--quiet', '-m', 'ahead']);
  git(origin, ['branch', 'at-ahead']);
  sha.ahead = git(origin, ['rev-parse', 'HEAD']);
  assert.deepEqual(commitOnMain({ cwd: checkout('ahead'), remote }), { onMain: false, head: sha.ahead, main: squashed });
});

test('a complete checkout gives the same answers', () => {
  const { remote, sha, checkout } = shared;
  assert.equal(commitOnMain({ cwd: checkout('B', { shallow: false }), remote }).onMain, true);
  assert.equal(commitOnMain({ cwd: checkout('S', { shallow: false }), remote }).onMain, true);
  assert.deepEqual(commitOnMain({ cwd: checkout('X', { shallow: false }), remote }), { onMain: false, head: sha.X, main: sha.D });
  // Der Branch laesst sich waehlen; feature enthaelt B und X, aber nicht C.
  assert.equal(commitOnMain({ cwd: checkout('X'), remote, branch: 'feature' }).onMain, true);
  assert.equal(commitOnMain({ cwd: checkout('C'), remote, branch: 'feature' }).onMain, false);
});

test('the check leaves the checkout as it was: same commit, no branch, clean, still shallow', () => {
  const { remote, sha, checkout } = shared;
  const dir = checkout('B');
  commitOnMain({ cwd: dir, remote });
  assert.equal(git(dir, ['rev-parse', 'HEAD']), sha.B);
  assert.equal(git(dir, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.equal(git(dir, ['rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(git(dir, ['for-each-ref', '--format=%(refname)']), '');
});

test('a failed fetch is an error, not an answer', () => {
  const { base, remote, checkout } = shared;
  const dir = checkout('D');
  assert.throws(() => commitOnMain({ cwd: dir, remote: pathToFileURL(path.join(base, 'no-such-repository')).href }), /Could not fetch main from file:.*no-such-repository/);
  assert.throws(() => commitOnMain({ cwd: dir, remote, branch: 'no-such-branch' }), /Could not fetch no-such-branch from /);
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty);
  git(empty, ['init', '--quiet', '--initial-branch=main']);
  assert.throws(() => commitOnMain({ cwd: empty, remote }), /No checked-out commit/);
});

test('in a workflow main is fetched from the repository of the run, elsewhere from origin', () => {
  assert.equal(defaultRemote({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'ITBrain258/aidevbridge' }), 'https://github.com/ITBrain258/aidevbridge.git');
  assert.equal(defaultRemote({}), 'origin');
  assert.equal(defaultRemote({ GITHUB_REPOSITORY: 'ITBrain258/aidevbridge' }), 'origin');
});

// Das Programm, wie die Workflows es starten: `node scripts/release-on-main.mjs`
// in dem Checkout, den es prueft. Hier liegt eine Kopie des Skripts in einem
// Checkout der Fixture; `through` startet sie ueber diesen anderen Pfad zum
// selben Ordner. Ohne PUBLISH_TAG, damit die Meldung den Commit nennt.
/** @param {string} dir @param {string} remote @param {string} [through] */
function program(dir, remote, through = dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'release-on-main.mjs'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PUBLISH_TAG'));
  return spawnSync(process.execPath, [path.join(through, 'scripts', 'release-on-main.mjs'), '--remote', remote], { env, encoding: 'utf8', windowsHide: true });
}

test('the program passes a commit on main and fails for one that is not', () => {
  const { remote, sha, checkout } = shared;
  const passed = program(checkout('B'), remote);
  assert.equal(passed.stderr, '');
  assert.equal(passed.stdout, `Commit ${sha.B} is on main (main is at ${sha.D}).\n`);
  assert.equal(passed.status, 0);
  const refused = program(checkout('X'), remote);
  assert.match(refused.stdout, new RegExp(`^::error::Commit ${sha.X} is not on main \\(main is at ${sha.D}\\)\\. `));
  assert.equal(refused.status, 1);
  const unknown = program(checkout('D'), pathToFileURL(path.join(shared.base, 'no-such-repository')).href);
  assert.match(unknown.stdout, /^::error::Could not check whether the commit to publish is on main: Could not fetch main from /);
  assert.equal(unknown.status, 1);
});

// Ueber einen Pfad mit einem Verweis gestartet (unter Windows eine Junction,
// sonst ein Symlink), nennt import.meta.url den echten Pfad und
// process.argv[1] den angegebenen. Erkennt sich das Skript daran nicht als das
// gestartete Programm, tut es nichts und endet mit 0, und der Workflow hielte
// die Pruefung fuer bestanden. Der Verweis zeigt auf einen Checkout der
// Fixture, nie auf dieses Repository.
test('the program also checks when it is started through a linked directory', t => {
  const { base, remote, sha, checkout } = shared;
  const outside = checkout('X'), inside = checkout('B');
  const links = [outside, inside].map(dir => path.join(base, `link-to-${path.basename(dir)}`));
  try {
    fs.symlinkSync(outside, links[0], 'junction');
    fs.symlinkSync(inside, links[1], 'junction');
  } catch (error) {
    t.skip(`could not create a directory link under ${base}: ${/** @type {Error} */ (error).message}`);
    return;
  }
  const refused = program(outside, remote, links[0]);
  assert.match(refused.stdout, new RegExp(`^::error::Commit ${sha.X} is not on main \\(main is at ${sha.D}\\)\\. `));
  assert.equal(refused.status, 1);
  const passed = program(inside, remote, links[1]);
  assert.equal(passed.stdout, `Commit ${sha.B} is on main (main is at ${sha.D}).\n`);
  assert.equal(passed.status, 0);
});
