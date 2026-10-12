// Picks the version CI publishes when something lands on main, so every change
// reaches installed copies of Quill through the in-app updater without anyone
// having to bump the version or push a tag.
//
//   node scripts/release-version.mjs
//
// - If package.json is ahead of the newest release (someone bumped it by hand,
//   e.g. for a minor version), that version is released as is.
// - Otherwise the newest release's patch number goes up by one.
// - If nothing that ships in the app changed since the newest release (docs,
//   CI, tests only), nothing is released.
//
// It rewrites package.json's version in the CI checkout only (never committed),
// writes release notes from the commit subjects unless resources/release-notes.md
// was written for this version, and reports `publish` and `version` to
// $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Paths whose changes alter what users install. */
const SHIPPED = /^(src\/|native\/|resources\/|scripts\/build-|package\.json$|package-lock\.json$|electron-builder\.yml$|vite\.config\.ts$|tsconfig\.json$)/;
const NOT_SHIPPED = /^resources\/release-notes\.md$/;

export function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The newest `vX.Y.Z` tag, without its `v`, or null. */
export function newest(tags) {
  const versions = tags.map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1));
  return versions.sort(compare).at(-1) ?? null;
}

/** The version to release, given package.json's version and the newest released one. */
export function nextVersion(pkg, latest) {
  if (!latest || compare(pkg, latest) > 0) return pkg;
  const [major, minor, patch] = parse(latest);
  return `${major}.${minor}.${patch + 1}`;
}

export function shipsChanges(files) {
  return files.some((f) => SHIPPED.test(f) && !NOT_SHIPPED.test(f));
}

export function notesFor(version, subjects) {
  const lines = subjects.map((s) => s.trim()).filter(Boolean);
  const body = lines.length ? lines.map((s) => `- ${s}`).join('\n') : '- Small fixes and improvements.';
  return `**Quill ${version}**\n\n${body}\n`;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function output(key, value) {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function main() {
  const pkgPath = 'package.json';
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const latest = newest(git('tag', '--list', 'v*').split('\n'));
  if (latest) {
    const changed = git('diff', '--name-only', `v${latest}`, 'HEAD').split('\n').filter(Boolean);
    if (!shipsChanges(changed)) {
      console.log(`Nothing that ships in the app changed since v${latest}; not releasing.`);
      output('publish', 'false');
      return;
    }
  }
  const version = nextVersion(pkg.version, latest);
  if (pkg.version !== version) {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const lockPath = 'package-lock.json';
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
  // Hand-written notes win when they were written for this version.
  const notesPath = 'resources/release-notes.md';
  const current = readFileSync(notesPath, 'utf8');
  if (!current.startsWith(`**Quill ${version}**`)) {
    const range = latest ? [`v${latest}..HEAD`] : ['HEAD'];
    const subjects = git('log', '--no-merges', '--format=%s', ...range).split('\n');
    writeFileSync(notesPath, notesFor(version, subjects));
  }
  console.log(readFileSync(notesPath, 'utf8'));
  output('publish', 'true');
  output('version', version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
