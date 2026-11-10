#!/usr/bin/env node
// Steht der Commit, aus dem ein Release gebaut wird, auf main? packages.yml
// und android.yml bauen und veroeffentlichen, was ein Tag v* nennt, und ein
// Tag kann auf jeden Commit zeigen, auch auf den Kopf eines Branches, der nie
// gemergt wurde. main dagegen nimmt nur Pull Requests mit gruenen Pruefungen
// an (Ruleset). Dieses Skript laesst darum nur Commits durch, die auf main
// liegen: den Kopf von main oder einen seiner Vorfahren.
//
// Es prueft den ausgecheckten Commit (HEAD), also genau das, was der Job baut,
// mit Git selbst: main des Repositorys holen, dann
// `git merge-base --is-ancestor HEAD <main>`. Das Repository ist oeffentlich,
// der Abruf braucht kein Token; actions/checkout legt mit
// persist-credentials: false auch keines ab. Der Checkout der Workflows ist
// flach (ein Commit). Das stoert nicht: Ein Abruf ohne --depth holt die
// Geschichte von main bis zu dem, was schon da ist, und die flache Grenze
// liegt nur am ausgecheckten Commit selbst. Liegt er auf main, erreicht main
// ihn im geholten Graphen; liegt er nicht dort, kommt er in der vollstaendigen
// Geschichte von main nicht vor. Der Test spielt beides an flachen Klonen durch.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  // Nie auf eine Eingabe warten: Verlangt der Server doch Zugangsdaten,
  // scheitert der Abruf, statt bis zum Zeitlimit des Jobs zu haengen.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // Nicht gestartet (kein Git) oder nach drei Minuten abgebrochen.
  if (result.error) throw new Error(`git ${args.find(arg => /^[a-z][a-z-]*$/.test(arg)) ?? ''} failed: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// Ob HEAD des Checkouts `cwd` auf dem Branch `branch` von `remote` liegt.
// `remote` ist eine URL oder der Name eines Remotes. Wirft, wenn sich das nicht
// feststellen laesst (kein Commit, Abruf gescheitert); dann darf nichts
// veroeffentlicht werden.
/**
 * @param {{ cwd: string, remote: string, branch?: string }} options
 * @returns {{ onMain: boolean, head: string, main: string }}
 */
export function commitOnMain({ cwd, remote, branch = 'main' }) {
  const head = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status !== 0 || !/^[0-9a-f]{40,64}$/.test(head.stdout)) throw new Error(`No checked-out commit in ${cwd}`);
  // Ohne gespeicherte Zugangsdaten und ohne Tags; nur der eine Branch, nach FETCH_HEAD.
  const fetch = git(cwd, ['-c', 'credential.helper=', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', remote, `refs/heads/${branch}`]);
  if (fetch.status !== 0) throw new Error(`Could not fetch ${branch} from ${remote}: ${fetch.stderr || `git fetch exited with ${fetch.status}`}`);
  const main = git(cwd, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}']);
  if (main.status !== 0 || !/^[0-9a-f]{40,64}$/.test(main.stdout)) throw new Error(`The fetch from ${remote} left no commit of ${branch}`);
  // Exit 0: HEAD ist main oder ein Vorfahr; 1: nicht; alles andere ist ein Fehler.
  const ancestor = git(cwd, ['merge-base', '--is-ancestor', head.stdout, main.stdout]);
  if (ancestor.status !== 0 && ancestor.status !== 1) throw new Error(`git merge-base failed: ${ancestor.stderr || `exit ${ancestor.status}`}`);
  return { onMain: ancestor.status === 0, head: head.stdout, main: main.stdout };
}

// Das Repository, von dem main geholt wird: im Workflow das des Laufs, ueber
// die Variablen, die jeder Runner setzt; sonst das Remote origin.
/** @param {NodeJS.ProcessEnv} env */
export function defaultRemote(env) {
  return env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}.git` : 'origin';
}

// Als Programm gestartet? Verglichen werden die echten Pfade: Ueber einen Pfad
// mit Symlink oder Junction gestartet, nennt import.meta.url den echten Pfad
// und process.argv[1] den angegebenen. Ein Vergleich der beiden Texte
// uebersprange dann die Pruefung ohne Ausgabe und mit Exit 0, und der Workflow
// hielte sie fuer bestanden.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const usage = 'Usage: node scripts/release-on-main.mjs [--remote <URL or remote name>] [--branch <name>]';
    const args = process.argv.slice(2);
    /** @type {Record<string, string>} */
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--remote', '--branch'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error(usage);
      options[args[i]] = args[i + 1];
    }
    const remote = options['--remote'] ?? defaultRemote(process.env), branch = options['--branch'] ?? 'main';
    const { onMain, head, main } = commitOnMain({ cwd: ROOT, remote, branch });
    const what = process.env.PUBLISH_TAG ? `${process.env.PUBLISH_TAG} (commit ${head})` : `Commit ${head}`;
    if (onMain) {
      console.log(`${what} is on ${branch} (${branch} is at ${main}).`);
    } else {
      console.log(`::error::${what} is not on ${branch} (${branch} is at ${main}). A release is built and published only from a commit of ${branch}: put the tag on the merge commit of the release pull request.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.log(`::error::Could not check whether the commit to publish is on main: ${/** @type {Error} */ (error).message}`);
    process.exitCode = 1;
  }
}
