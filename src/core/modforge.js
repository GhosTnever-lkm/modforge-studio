export const VERSION = '0.1.3';
export const MAX_FILES = 20_000;
export const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;

const textDecoder = new TextDecoder('utf-8', { fatal: false });
const clean = (v, fallback = '') => String(v ?? fallback).replace(/[\u0000-\u001f]/g, ' ').trim();

export function normalizePath(path) {
  const normalized = String(path ?? '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.includes('\0')) return '';
  const parts = normalized.split('/');
  if (parts.some((part) => part === '.' || part === '..')) return '';
  return parts.filter(Boolean).join('/');
}

export function stripCommonWrapper(files) {
  const paths = files.map((f) => normalizePath(f.path)).filter(Boolean);
  if (!paths.length) return files;
  const first = paths[0].split('/')[0];
  if (paths.some((p) => !p.includes('/') || p.split('/')[0] !== first)) return files;
  return files.map((f) => ({ ...f, path: normalizePath(f.path).split('/').slice(1).join('/') })).filter((f) => f.path);
}

function parseKvp(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/);
    if (m) result[m[1].toLowerCase()] = clean(m[2] ?? m[3] ?? m[4]);
  }
  return result;
}

function parseXmlTags(xml) {
  const get = (tag) => clean(xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]?.replace(/<[^>]+>/g, ''));
  const versions = [...xml.matchAll(/<li>\s*([^<]+)\s*<\/li>/gi)].map((m) => clean(m[1])).filter(Boolean);
  const dependencies = [...xml.matchAll(/<(?:li|packageId)>\s*([^<]+)\s*<\/(?:li|packageId)>/gi)].map((m) => clean(m[1])).filter(Boolean);
  return { name: get('name'), id: get('packageId'), author: get('author'), version: get('modVersion'), description: get('description'), supportedVersions: versions, dependencies };
}

function parseManifest(fileMap) {
  const readText = (name) => {
    const hit = [...fileMap.entries()].find(([p]) => p.toLowerCase() === name.toLowerCase() || p.toLowerCase().endsWith(`/${name.toLowerCase()}`));
    return hit ? textDecoder.decode(hit[1]) : null;
  };
  for (const [path, bytes] of fileMap) {
    const low = path.toLowerCase();
    if (low === 'descriptor.mod' || low.endsWith('.mod')) {
      const meta = parseKvp(textDecoder.decode(bytes));
      if (meta.name || meta.path || meta.supported_version) {
        const block = textDecoder.decode(bytes).match(/\bdependencies\s*=\s*\{([\s\S]*?)\}/i)?.[1] || '';
        const dependencies = [...block.matchAll(/(?:\b(?:modId|id)\s*=\s*)?"([^"]+)"/gi)].map((m) => m[1]);
        return { ecosystem: 'Paradox / Clausewitz', id: meta.remote_file_id || meta.name, name: meta.name, version: meta.version || meta.supported_version, author: meta.author, description: meta.description, dependencies, source: path };
      }
    }
  }
  const factorio = readText('info.json');
  if (factorio) {
    try {
      const m = JSON.parse(factorio);
      if (m.name && m.version) return { ecosystem: 'Factorio', id: m.name, name: m.title || m.name, version: m.version, author: m.author, description: m.description, dependencies: (m.dependencies || []).map((d) => typeof d === 'string' ? d.replace(/^[?!~]+/, '').split(/\s+/)[0] : d.name).filter((d) => d && d !== 'base'), source: 'info.json' };
    } catch {}
  }
  for (const [p, bytes] of fileMap) {
    if (p.toLowerCase().endsWith('/about/about.xml') || p.toLowerCase() === 'about/about.xml') {
      const m = parseXmlTags(textDecoder.decode(bytes));
      if (m.name || m.id) return { ecosystem: 'RimWorld', id: m.id, name: m.name, version: m.version, author: m.author, description: m.description, dependencies: m.dependencies, supportedVersions: m.supportedVersions, source: p };
    }
  }
  const fabric = readText('fabric.mod.json');
  if (fabric) {
    try { const m = JSON.parse(fabric); return { ecosystem: 'Minecraft · Fabric', id: m.id, name: m.name || m.id, version: m.version, author: Array.isArray(m.authors) ? m.authors.join(', ') : m.authors, description: m.description, dependencies: Object.keys(m.depends || {}).filter((d) => !['minecraft', 'java'].includes(d)), source: 'fabric.mod.json' }; } catch {}
  }
  for (const [p, bytes] of fileMap) {
    if (p.toLowerCase().endsWith('mods.toml')) {
      const toml = textDecoder.decode(bytes); const modId = toml.match(/\bmodId\s*=\s*["']([^"']+)/i)?.[1];
      if (modId) { const version = toml.match(/\bversion\s*=\s*["']([^"']+)/i)?.[1]; return { ecosystem: 'Minecraft · Forge', id: modId, name: toml.match(/\bdisplayName\s*=\s*["']([^"']+)/i)?.[1] || modId, version, dependencies: [...toml.matchAll(/\[\[dependencies\.[^\]]+\]\][\s\S]*?modId\s*=\s*["']([^"']+)/gi)].map((m) => m[1]).filter((d) => d !== modId), source: p }; }
    }
  }
  const smapi = readText('manifest.json');
  if (smapi) {
    try { const m = JSON.parse(smapi); if (m.UniqueID) return { ecosystem: 'Stardew Valley · SMAPI', id: m.UniqueID, name: m.Name || m.UniqueID, version: m.Version, author: m.Author, description: m.Description, dependencies: Object.keys(m.Dependencies || {}), source: 'manifest.json' }; } catch {}
  }
  return null;
}

function finding(severity, code, title, detail, path = '') { return { severity, code, title, detail, path }; }

export async function sha256(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Node's test runner fallback; browser builds use WebCrypto.
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}

export async function analyzeMod(input) {
  const files = (input.files || []).map((file) => ({ path: normalizePath(file.path || file.name), bytes: file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || 0) })).filter((f) => f.path);
  const normalized = input.stripWrapper ? stripCommonWrapper(files) : files;
  const fileMap = new Map(normalized.map((f) => [f.path, f.bytes]));
  const manifest = parseManifest(fileMap);
  const findings = [];
  if (!normalized.length) findings.push(finding('error', 'EMPTY_PACKAGE', 'Пакет пуст', 'После фильтрации не осталось безопасных файлов.'));
  if (!manifest) findings.push(finding('warning', 'MANIFEST_NOT_FOUND', 'Манифест не распознан', 'Добавьте файл метаданных поддерживаемого формата или заполните название вручную.'));
  const seen = new Map();
  for (const file of normalized) {
    const low = file.path.toLowerCase();
    if (seen.has(low)) findings.push(finding('warning', 'CASE_COLLISION', 'Пути различаются только регистром', `${seen.get(low)} и ${file.path} могут конфликтовать на другой файловой системе.`, file.path));
    else seen.set(low, file.path);
    if (/\.(exe|msi|bat|cmd|ps1|scr)$/i.test(file.path)) findings.push(finding('warning', 'EXECUTABLE_FILE', 'Исполняемый файл в пакете', 'Проверьте происхождение и назначение файла перед распространением.', file.path));
    if (/\.(zip|7z|rar)$/i.test(file.path)) findings.push(finding('notice', 'NESTED_ARCHIVE', 'Вложенный архив', 'Убедитесь, что это ожидаемая часть структуры мода.', file.path));
    if (/^(readme|license|changelog|лицензия|описание)(\.|$)/i.test(file.path.split('/').at(-1))) continue;
    if (file.bytes.length <= 2 * 1024 * 1024 && /\.(txt|json|xml|toml|ini|cfg|conf|ya?ml|mod|lua|js|ts|py|cs|md|properties|csv)$/i.test(file.path) && /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|discord(?:app)?\.com\/api\/webhooks\//i.test(textDecoder.decode(file.bytes))) {
      findings.push(finding('error', 'POSSIBLE_SECRET', 'Похоже на секрет или ключ', 'Совпадение эвристическое: проверьте файл и удалите реальный секрет до публикации.', file.path));
    }
  }
  if (!normalized.some((f) => /(^|\/)(readme|about|description|changelog|лицензия)/i.test(f.path))) findings.push(finding('notice', 'DOCS_MISSING', 'Нет заметного файла с описанием', 'Рассмотрите README, About.xml или описание на странице публикации.'));
  const totalBytes = normalized.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (totalBytes > MAX_UNPACKED_BYTES) findings.push(finding('error', 'SIZE_LIMIT', 'Превышен лимит размера', 'Суммарный размер файлов больше 500 МиБ.'));
  const filesWithHash = await Promise.all(normalized.map(async (f) => ({ path: f.path, size: f.bytes.byteLength, sha256: await sha256(f.bytes), bytes: f.bytes })));
  const id = clean(input.id || manifest?.id || `${manifest?.name || input.name || 'mod'}-${filesWithHash[0]?.sha256?.slice(0, 8) || Math.random().toString(36).slice(2, 10)}`);
  return { id, name: clean(input.name || manifest?.name || filesWithHash[0]?.path?.split('/')[0] || 'Без названия'), ecosystem: manifest?.ecosystem || clean(input.ecosystem || 'Не определена'), version: clean(manifest?.version), author: clean(manifest?.author), description: clean(manifest?.description), dependencies: [...new Set((manifest?.dependencies || []).map(clean).filter(Boolean))], manifest: manifest ? { ...manifest, name: clean(manifest.name), id: clean(manifest.id) } : null, files: filesWithHash, totalBytes, findings, importedAt: input.importedAt || new Date().toISOString(), enabled: input.enabled !== false };
}

export function compareMods(mods) {
  const byPath = new Map();
  for (const mod of mods) for (const file of mod.files || []) {
    const key = normalizePath(file.path).toLowerCase();
    if (!key) continue;
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push({ modId: mod.id, modName: mod.name, path: file.path, sha256: file.sha256 });
  }
  return [...byPath.values()].filter((items) => new Set(items.map((x) => x.modId)).size > 1).map((items) => ({ path: items[0].path, files: items, identical: new Set(items.map((x) => x.sha256)).size === 1 }));
}

export function uniqueModFolderNames(mods) {
  const used = new Set();
  return mods.map((mod) => {
    const base = clean(mod.name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '') || 'modforge';
    let name = base;
    if (used.has(name.toLowerCase())) {
      const suffix = clean(mod.id).toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 12) || 'mod';
      name = `${base}-${suffix}`;
      let index = 2;
      while (used.has(name.toLowerCase())) name = `${base}-${suffix}-${index++}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

export function dependencyPlan(mods) {
  const byId = new Map();
  for (const mod of mods) for (const id of [mod.id, mod.manifest?.id, mod.name]) if (id) byId.set(String(id).toLowerCase(), mod);
  const missing = [], edges = [], cycles = [];
  for (const mod of mods) for (const dep of mod.dependencies || []) {
    const target = byId.get(String(dep).toLowerCase());
    if (!target) missing.push({ modId: mod.id, modName: mod.name, dependency: dep });
    else if (target.id !== mod.id) edges.push({ from: target.id, to: mod.id, dependency: dep });
  }
  const indegree = new Map(mods.map((m) => [m.id, 0]));
  for (const edge of edges) indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  const queue = mods.filter((m) => indegree.get(m.id) === 0).map((m) => m.id), order = [];
  while (queue.length) { const id = queue.shift(); order.push(id); for (const e of edges.filter((x) => x.from === id)) { indegree.set(e.to, indegree.get(e.to) - 1); if (indegree.get(e.to) === 0) queue.push(e.to); } }
  if (order.length !== mods.length) cycles.push(...[...indegree].filter(([, n]) => n > 0).map(([id]) => id));
  return { missing, edges, order, cycles };
}

export function buildReport(mods, profileName = 'Основной профиль') {
  const conflicts = compareMods(mods);
  const dependencies = dependencyPlan(mods);
  const findings = mods.flatMap((mod) => mod.findings.map((f) => ({ ...f, modId: mod.id, modName: mod.name })));
  for (const conflict of conflicts) findings.push(finding(conflict.identical ? 'notice' : 'warning', 'PATH_CONFLICT', conflict.identical ? 'Совпадающий файл' : 'Файловое пересечение', `${conflict.files.map((x) => x.modName).join(' ↔ ')}${conflict.identical ? ': одинаковое содержимое.' : ': содержимое различается.'}`, conflict.path));
  for (const m of dependencies.missing) findings.push(finding('warning', 'DEPENDENCY_MISSING', `Не найдена зависимость: ${m.dependency}`, `Мод «${m.modName}» ссылается на отсутствующий мод.`));
  if (dependencies.cycles.length) findings.push(finding('error', 'DEPENDENCY_CYCLE', 'Цикл зависимостей', `Участники цикла: ${dependencies.cycles.join(', ')}`));
  return { schemaVersion: 1, app: 'ModForge Studio', version: VERSION, generatedAt: new Date().toISOString(), profile: profileName, summary: { mods: mods.length, files: mods.reduce((n, m) => n + m.files.length, 0), totalBytes: mods.reduce((n, m) => n + m.totalBytes, 0), conflicts: conflicts.length, errors: findings.filter((x) => x.severity === 'error').length, warnings: findings.filter((x) => x.severity === 'warning').length, notices: findings.filter((x) => x.severity === 'notice').length }, mods: mods.map(({ files, ...m }) => ({ ...m, files: files.map(({ bytes, ...f }) => f) })), findings, conflicts, dependencies };
}
