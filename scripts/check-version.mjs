import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [packageJson, version, html, changelog, sw] = await Promise.all([
  readFile(resolve(root, 'package.json'), 'utf8'), readFile(resolve(root, 'VERSION'), 'utf8'),
  readFile(resolve(root, 'index.html'), 'utf8'),
  readFile(resolve(root, 'CHANGELOG.md'), 'utf8'), readFile(resolve(root, 'sw.js'), 'utf8')
]);
const expected = JSON.parse(packageJson).version;
const found = { VERSION: version.trim(), sidebar: html.match(/v(\d+\.\d+\.\d+) · экспериментальная сборка/)?.[1], footer: html.match(/MODFORGE STUDIO <b>(\d+\.\d+\.\d+)<\/b>/)?.[1], changelog: changelog.match(/^## (\d+\.\d+\.\d+) —/m)?.[1], serviceWorkerCache: sw.match(/modforge-studio-v(\d+\.\d+\.\d+)/)?.[1] };
for (const [file, actual] of Object.entries(found)) if (actual !== expected) throw new Error(`${file} version mismatch: expected ${expected}, found ${actual ?? 'missing'}`);
console.log(`Version ${expected} is consistent across package, UI, changelog, and cache.`);
