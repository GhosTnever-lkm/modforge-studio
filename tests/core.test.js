import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMod, buildReport, compareMods, dependencyPlan, normalizePath, stripCommonWrapper } from '../src/core/modforge.js';
import { readZip, writeZip } from '../src/core/zip.js';

const bytes = (text) => new TextEncoder().encode(text);

test('normalizes separators and rejects traversal when preserved paths are compared', () => {
  assert.equal(normalizePath('MyMod\\common\\ideas\\x.txt'), 'MyMod/common/ideas/x.txt');
  assert.equal(normalizePath('../outside.txt'), 'outside.txt');
});

test('strips only a shared single wrapper directory', () => {
  const paths = [{ path: 'ModA/common/x.txt' }, { path: 'ModA/descriptor.mod' }];
  assert.deepEqual(stripCommonWrapper(paths).map((x) => x.path), ['common/x.txt', 'descriptor.mod']);
  const mixed = [{ path: 'ModA/common/x.txt' }, { path: 'ModB/common/x.txt' }];
  assert.deepEqual(stripCommonWrapper(mixed).map((x) => x.path), ['ModA/common/x.txt', 'ModB/common/x.txt']);
});

test('recognizes Paradox descriptor and dependency blocks', async () => {
  const mod = await analyzeMod({ files: [{ path: 'descriptor.mod', bytes: bytes('name="A Mod"\nsupported_version="1.15.*"\ndependencies={\n "Base Mod"\n}') }] });
  assert.equal(mod.ecosystem, 'Paradox / Clausewitz');
  assert.equal(mod.name, 'A Mod');
  assert.deepEqual(mod.dependencies, ['Base Mod']);
});

test('recognizes nested Factorio info.json and removes base from dependencies', async () => {
  const mod = await analyzeMod({ files: [{ path: 'FactorioMod/info.json', bytes: bytes(JSON.stringify({ name: 'factorio_mod', title: 'Factorio Mod', version: '1.2.3', dependencies: ['base >= 1.1', 'other >= 2.0'] })) }] });
  assert.equal(mod.ecosystem, 'Factorio');
  assert.equal(mod.name, 'Factorio Mod');
  assert.deepEqual(mod.dependencies, ['other']);
});

test('reports case collisions, executable payloads, and likely secrets once each', async () => {
  const mod = await analyzeMod({ files: [
    { path: 'descriptor.mod', bytes: bytes('name="Safe"') },
    { path: 'Common/X.txt', bytes: bytes('normal') }, { path: 'common/x.TXT', bytes: bytes('normal') },
    { path: 'bin/helper.exe', bytes: bytes('binary') }, { path: 'config/settings.json', bytes: bytes('{"token":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}') },
  ] });
  const codes = mod.findings.map((f) => f.code);
  assert.equal(codes.filter((c) => c === 'CASE_COLLISION').length, 1);
  assert.equal(codes.filter((c) => c === 'EXECUTABLE_FILE').length, 1);
  assert.equal(codes.filter((c) => c === 'POSSIBLE_SECRET').length, 1);
});

test('compares file paths case-insensitively and identifies content equality', async () => {
  const a = await analyzeMod({ id: 'a', stripWrapper: true, files: [{ path: 'ModA/common/x.txt', bytes: bytes('same') }] });
  const b = await analyzeMod({ id: 'b', stripWrapper: true, files: [{ path: 'ModB/common/x.txt', bytes: bytes('same') }] });
  const conflicts = compareMods([a, b]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].identical, true);
});

test('dependency plan orders prerequisites and reports missing links and cycles', async () => {
  const base = await analyzeMod({ id: 'base', files: [{ path: 'descriptor.mod', bytes: bytes('name="base"') }] });
  base.dependencies = [];
  const addon = await analyzeMod({ id: 'addon', files: [{ path: 'descriptor.mod', bytes: bytes('name="addon"') }] }); addon.dependencies = ['base', 'not-installed'];
  const plan = dependencyPlan([addon, base]);
  assert.deepEqual(plan.order, ['base', 'addon']);
  assert.equal(plan.missing[0].dependency, 'not-installed');
  addon.dependencies = ['base']; base.dependencies = ['addon'];
  assert.equal(dependencyPlan([addon, base]).cycles.length, 2);
});

test('report contains file fingerprints but never raw file bytes', async () => {
  const mod = await analyzeMod({ files: [{ path: 'descriptor.mod', bytes: bytes('name="Report test"') }, { path: 'common/x.txt', bytes: bytes('payload') }] });
  const json = JSON.stringify(buildReport([mod], 'QA'));
  assert.match(json, /sha256/);
  assert.doesNotMatch(json, /payload/);
});

test('writes and reads a valid store-only ZIP archive', async () => {
  const blob = writeZip([{ path: 'A/common/x.txt', bytes: bytes('hello') }, { path: 'A/descriptor.mod', bytes: bytes('name="A"') }]);
  const archive = await readZip(blob);
  assert.equal(archive.entries.length, 2);
  assert.equal(new TextDecoder().decode(archive.entries.find((f) => f.path.endsWith('x.txt')).bytes), 'hello');
});

test('writer refuses traversal entries', () => {
  assert.throws(() => writeZip([{ path: '../secret.txt', bytes: bytes('x') }]), /Недопустимый путь/);
});
