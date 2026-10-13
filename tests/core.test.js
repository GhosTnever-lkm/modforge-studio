import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { analyzeMod, buildReport, compareMods, dependencyPlan, normalizePath, stripCommonWrapper, uniqueModFolderNames } from '../src/core/modforge.js';
import { readZip, writeZip } from '../src/core/zip.js';

const bytes = (text) => new TextEncoder().encode(text);

test('normalizes separators but rejects unsafe paths instead of rewriting them', () => {
  assert.equal(normalizePath('MyMod\\common\\ideas\\x.txt'), 'MyMod/common/ideas/x.txt');
  assert.equal(normalizePath('../outside.txt'), '');
  assert.equal(normalizePath('folder/../outside.txt'), '');
  assert.equal(normalizePath('C:\\outside.txt'), '');
  assert.equal(normalizePath('/outside.txt'), '');
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

test('gives same-named mods unique stable output folders', () => {
  const mods = [{ id: 'copy-a', name: 'My Mod' }, { id: 'copy-b', name: 'my-mod' }, { id: 'copy-c', name: 'MY MOD' }];
  const names = uniqueModFolderNames(mods);
  assert.equal(names.length, 3);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 3);
  assert.equal(names[0], 'my-mod');
  assert.deepEqual(names, uniqueModFolderNames(mods));
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

test('writer refuses duplicate paths even when only case differs', () => {
  assert.throws(() => writeZip([{ path: 'Mods/a.txt', bytes: bytes('first') }, { path: 'mods/A.txt', bytes: bytes('second') }]), /Повторяющийся путь/);
});

test('ZIP inflate stops when actual output exceeds the declared file size', async () => {
  const blob = await makeDeflatedZip('small.txt', new Uint8Array(1024 * 1024).fill(65), 8);
  await assert.rejects(() => readZip(blob), /Фактический распакованный размер ZIP/);
});

test('ZIP reader accepts valid deflated entries within the declared size', async () => {
  const payload = bytes('normal deflated package contents');
  const archive = await readZip(await makeDeflatedZip('normal.txt', payload));
  assert.equal(archive.totalBytes, payload.length);
  assert.deepEqual(archive.entries[0].bytes, payload);
});

test('ZIP reader rejects traversal paths and local name mismatches', async () => {
  const traversal = await makeDeflatedZip('../outside.txt', bytes('x'));
  await assert.rejects(() => readZip(traversal), /В ZIP не осталось безопасных поддерживаемых файлов/);
  const mismatch = await makeDeflatedZip('safe.txt', bytes('x'));
  const raw = new Uint8Array(await mismatch.arrayBuffer());
  const view = new DataView(raw.buffer);
  raw[30] = 'x'.charCodeAt(0);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  await assert.rejects(() => readZip(new Blob([raw])), /В ZIP не осталось безопасных поддерживаемых файлов/);
});

async function makeDeflatedZip(name, data, declaredSize = data.length) {
  const encoder = new TextEncoder(), nameBytes = encoder.encode(name);
  const compressed = new Uint8Array(deflateRawSync(data));
  const crc = crc32(data), local = new Uint8Array(30 + nameBytes.length + compressed.length), localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true); localView.setUint16(8, 8, true); localView.setUint32(14, crc, true); localView.setUint32(18, compressed.length, true); localView.setUint32(22, declaredSize, true); localView.setUint16(26, nameBytes.length, true); local.set(nameBytes, 30); local.set(compressed, 30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length), centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true); centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 8, true); centralView.setUint32(16, crc, true); centralView.setUint32(20, compressed.length, true); centralView.setUint32(24, declaredSize, true); centralView.setUint16(28, nameBytes.length, true); central.set(nameBytes, 46);
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, 1, true); endView.setUint16(10, 1, true); endView.setUint32(12, central.length, true); endView.setUint32(16, local.length, true);
  return new Blob([local, central, end]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
