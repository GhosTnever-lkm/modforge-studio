import { MAX_FILES, MAX_UNPACKED_BYTES, normalizePath } from './modforge.js';

const view = (buffer) => new DataView(buffer);

export async function readZip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dv = view(bytes.buffer);
  let eocd = -1;
  for (let i = Math.max(0, bytes.length - 65_557); i <= bytes.length - 22; i++) if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) === bytes.length) eocd = i;
  if (eocd < 0) throw new Error('Не найден каталог ZIP: архив повреждён или не поддерживается.');
  const disk = dv.getUint16(eocd + 4, true), centralDisk = dv.getUint16(eocd + 6, true), diskCount = dv.getUint16(eocd + 8, true), count = dv.getUint16(eocd + 10, true), size = dv.getUint32(eocd + 12, true), offset = dv.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count) throw new Error('Многотомные ZIP-архивы не поддерживаются.');
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 не поддерживается в этой версии.');
  if (count > MAX_FILES) throw new Error(`Слишком много записей: максимум ${MAX_FILES}.`);
  if (offset + size > eocd || offset + size < offset) throw new Error('Каталог ZIP выходит за допустимые границы.');
  let cursor = offset, total = 0; const entries = [], rejected = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > offset + size || dv.getUint32(cursor, true) !== 0x02014b50) throw new Error('Каталог ZIP содержит некорректную запись.');
    const flags = dv.getUint16(cursor + 8, true), method = dv.getUint16(cursor + 10, true), crc = dv.getUint32(cursor + 16, true), compressedSize = dv.getUint32(cursor + 20, true), uncompressedSize = dv.getUint32(cursor + 24, true), nameLength = dv.getUint16(cursor + 28, true), extraLength = dv.getUint16(cursor + 30, true), commentLength = dv.getUint16(cursor + 32, true), localOffset = dv.getUint32(cursor + 42, true);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > offset + size) throw new Error('Запись каталога ZIP выходит за допустимые границы.');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch { rejected.push({ path: '(имя в неверной кодировке)', reason: 'Имя файла не является корректным UTF-8.' }); cursor = recordEnd; continue; }
    cursor = recordEnd;
    if (name.endsWith('/')) continue;
    if (flags & 1) { rejected.push({ path: name, reason: 'Зашифрованная запись пропущена.' }); continue; }
    const safePath = normalizePath(name);
    if (!safePath || safePath !== name.replaceAll('\\', '/')) { rejected.push({ path: name, reason: 'Небезопасный или недопустимый путь пропущен.' }); continue; }
    if (uncompressedSize > MAX_UNPACKED_BYTES || total + uncompressedSize > MAX_UNPACKED_BYTES) throw new Error('Распакованный размер архива превышает лимит 500 МиБ.');
    if (localOffset + 30 > offset || dv.getUint32(localOffset, true) !== 0x04034b50) { rejected.push({ path: name, reason: 'Локальная запись повреждена.' }); continue; }
    const localFlags = dv.getUint16(localOffset + 6, true), localMethod = dv.getUint16(localOffset + 8, true), localCrc = dv.getUint32(localOffset + 14, true), localCompressedSize = dv.getUint32(localOffset + 18, true), localUncompressedSize = dv.getUint32(localOffset + 22, true), localNameLen = dv.getUint16(localOffset + 26, true), localExtraLen = dv.getUint16(localOffset + 28, true), localNameStart = localOffset + 30, dataStart = localNameStart + localNameLen + localExtraLen, dataEnd = dataStart + compressedSize;
    let localName;
    try { localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(localNameStart, localNameStart + localNameLen)); }
    catch { rejected.push({ path: name, reason: 'Имя локальной записи не является корректным UTF-8.' }); continue; }
    const localSizesMismatch = !(flags & 0x08) && (localCrc !== crc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize);
    if (localFlags !== flags || localMethod !== method || localName !== name || localNameStart + localNameLen > offset || dataStart > offset || dataEnd > offset || dataEnd < dataStart || localSizesMismatch) { rejected.push({ path: name, reason: 'Локальная запись не совпадает с каталогом ZIP или пересекает его.' }); continue; }
    const compressed = bytes.subarray(dataStart, dataEnd); let data;
    if (method === 0) data = compressed.slice();
    else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      data = await inflateBounded(compressed, Math.min(MAX_UNPACKED_BYTES - total, uncompressedSize));
    } else { rejected.push({ path: name, reason: `Метод сжатия ${method} не поддерживается.` }); continue; }
    if (data.length !== uncompressedSize || crc32(data) !== crc) { rejected.push({ path: name, reason: 'Размер или контрольная сумма файла не совпала.' }); continue; }
    total += data.length; entries.push({ path: safePath, bytes: data, crc32: crc });
  }
  if (cursor !== offset + size) throw new Error('Размер каталога ZIP не совпадает с числом записей.');
  if (!entries.length) throw new Error(rejected.length ? `В ZIP не осталось безопасных поддерживаемых файлов. ${rejected.length} запись(ей) пропущено.` : 'ZIP не содержит файлов.');
  return { entries, rejected, totalBytes: total };
}

async function inflateBounded(compressed, maxBytes) {
  let reader;
  try { reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(); }
  catch { throw new Error('Не удалось распаковать запись ZIP.'); }
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Фактический распакованный размер ZIP превышает заявленный размер или общий лимит 500 МиБ.'); }
      chunks.push(value);
    }
  } catch (error) {
    if (/Фактический распакованный размер/.test(error.message)) throw error;
    throw new Error('Не удалось распаковать запись ZIP.');
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.byteLength; }
  return output;
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function le16(n) { return [n & 255, (n >>> 8) & 255]; }
function le32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
const concat = (arrays) => { const length = arrays.reduce((n, a) => n + a.length, 0), out = new Uint8Array(length); let at = 0; for (const a of arrays) { out.set(a, at); at += a.length; } return out; };

export function writeZip(files) {
  if (files.length > MAX_FILES) throw new Error(`Слишком много файлов: максимум ${MAX_FILES}.`);
  const encoder = new TextEncoder(), locals = [], centrals = []; let offset = 0, total = 0;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const file of sorted) {
    const name = normalizePath(file.path); if (!name || name !== String(file.path).replaceAll('\\', '/')) throw new Error(`Недопустимый путь в архиве: ${file.path}`);
    const nameBytes = encoder.encode(name), bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes), crc = crc32(bytes); total += bytes.length;
    if (total > MAX_UNPACKED_BYTES) throw new Error('Общий размер пакета больше лимита 500 МиБ.');
    const local = new Uint8Array([0x50,0x4b,0x03,0x04,...le16(20),...le16(0x0800),...le16(0),...le16(0),...le16(0),...le32(crc),...le32(bytes.length),...le32(bytes.length),...le16(nameBytes.length),...le16(0),...nameBytes,...bytes]);
    locals.push(local);
    const central = new Uint8Array([0x50,0x4b,0x01,0x02,...le16(20),...le16(20),...le16(0x0800),...le16(0),...le16(0),...le16(0),...le32(crc),...le32(bytes.length),...le32(bytes.length),...le16(nameBytes.length),...le16(0),...le16(0),...le16(0),...le16(0),...le32(0),...le32(offset),...nameBytes]);
    centrals.push(central); offset += local.length;
  }
  const centralBytes = concat(centrals), end = new Uint8Array([0x50,0x4b,0x05,0x06,...le16(0),...le16(0),...le16(centrals.length),...le16(centrals.length),...le32(centralBytes.length),...le32(offset),...le16(0)]);
  return new Blob([...locals, centralBytes, end], { type: 'application/zip' });
}
