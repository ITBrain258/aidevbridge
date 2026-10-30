import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, inRange, normalize, affecting, vendoredVersion, VENDORED } from './check-vendored-advisories.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('versions compare like semver, pre-releases before their release', () => {
  assert.equal(compareVersions('0.65.0', '0.65'), 0);
  assert.equal(compareVersions('0.63.2', '0.65'), -1);
  assert.equal(compareVersions('0.64.1', '0.64.0'), 1);
  assert.equal(compareVersions('0.34.0-beta.1', '0.34.0'), -1);
  assert.equal(compareVersions('0.34.0-beta.2', '0.34.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('GitHub vulnerable ranges are read with every comparator', () => {
  assert.equal(inRange('0.63.2', '<0.65'), true);
  assert.equal(inRange('0.65.0', '<0.65'), false);
  assert.equal(inRange('0.64.1', '>= 0.60.0, <= 0.64.1'), true);
  assert.equal(inRange('0.59.9', '>= 0.60.0, <= 0.64.1'), false);
  assert.equal(inRange('0.63.2', '>0.34.0-beta.1,<0.64.0'), true);
  assert.equal(inRange('0.2.4', '= 0.2.4'), true);
  assert.equal(inRange('0.2.4', '0.2.4'), true);
});

test('an unreadable range fails the check instead of passing the version', () => {
  assert.throws(() => inRange('0.60.5', '>= 0.34.0-beta.1,0.61.0'), /Unreadable vulnerable range/);
  assert.throws(() => inRange('0.35.0', '0.34.0,0.36.1'), /Unreadable vulnerable range/);
  assert.throws(() => inRange('0.65.0', null), /Unreadable vulnerable range/);
  assert.throws(() => affecting('0.65.0', [{ id: 'GHSA-x', ranges: ['< 0.65, 0.66'] }]), /GHSA-x: Unreadable/);
});

test('the reviewed database range wins over a hand-typed repository range', () => {
  const globalList = [{ ghsa_id: 'GHSA-76r6', severity: 'medium', summary: 'db', vulnerabilities: [{ package: { ecosystem: 'rust', name: 'russh' }, vulnerable_version_range: '>= 0.34.0-beta.1, < 0.61.0' }] }];
  const repositoryList = [{ ghsa_id: 'GHSA-76r6', severity: 'medium', summary: 'repo', state: 'published', vulnerabilities: [{ package: { ecosystem: 'rust', name: 'russh' }, vulnerable_version_range: '>= 0.34.0-beta.1,0.61.0' }] }];
  const advisories = normalize('russh', globalList, repositoryList);
  assert.deepEqual(advisories.map(a => a.ranges), [['>= 0.34.0-beta.1, < 0.61.0']]);
  assert.deepEqual(affecting('0.60.5', advisories).map(a => a.id), ['GHSA-76r6']);
});

test('both sources merge per advisory and only ranges of the crate count', () => {
  const globalList = [{ ghsa_id: 'GHSA-old', severity: 'medium', summary: 'old', vulnerabilities: [{ package: { ecosystem: 'rust', name: 'russh' }, vulnerable_version_range: '<= 0.64.0' }] }];
  const repositoryList = [
    { ghsa_id: 'GHSA-new', severity: 'high', summary: 'new', state: 'published', vulnerabilities: [{ package: { ecosystem: 'rust', name: 'russh' }, vulnerable_version_range: '<0.65' }] },
    { ghsa_id: 'GHSA-old', severity: 'medium', summary: 'old', state: 'published', vulnerabilities: [{ package: { ecosystem: 'rust', name: 'russh' }, vulnerable_version_range: '<= 0.64.0' }] },
    { ghsa_id: 'GHSA-other', severity: 'low', summary: 'agent', state: 'published', vulnerabilities: [{ package: { ecosystem: 'rust', name: 'pageant' }, vulnerable_version_range: '<= 0.2.4' }] },
  ];
  const advisories = normalize('russh', globalList, repositoryList);
  assert.deepEqual(advisories.map(a => [a.id, a.ranges]), [['GHSA-old', ['<= 0.64.0']], ['GHSA-new', ['<0.65']]]);
  assert.equal(advisories[0].summary, 'old');
  assert.deepEqual(affecting('0.63.2', advisories).map(a => a.id), ['GHSA-old', 'GHSA-new']);
  assert.deepEqual(affecting('0.65.0', advisories), []);
});

test('the vendored version is read from the package section of its manifest', () => {
  for (const { manifest } of VENDORED) assert.match(vendoredVersion(repository, manifest), /^\d+\.\d+\.\d+/);
});
