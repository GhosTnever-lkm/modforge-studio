import { analyzeMod, buildReport, compareMods, dependencyPlan, normalizePath, stripCommonWrapper, uniqueModFolderNames } from '../core/modforge.js';
import { readZip, writeZip } from '../core/zip.js';
import { clearAll, deleteOne, getAll, put } from '../storage/db.js';

const $ = (q) => document.querySelector(q), $$ = (q) => [...document.querySelectorAll(q)];
const state = { mods: [], profiles: [], profile: { id: 'default', name: 'Основной профиль', enabled: [] }, view: 'overview', filter: '', game: '', sort: 'name' };
const severityOrder = { error: 0, warning: 1, notice: 2 };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(message, type = '') { const el = $('#toast'); el.textContent = message; el.className = `toast show ${type}`; clearTimeout(el._timer); el._timer = setTimeout(() => { el.className = 'toast'; }, 3400); }
function selectedMods() { const active = new Set(state.profile.enabled); return state.mods.filter((m) => active.has(m.id)); }
function humanSize(n) { if (n < 1024) return `${n} Б`; if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`; if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`; return `${(n / 1024 ** 3).toFixed(2)} ГБ`; }
function findingCount(mod) { return mod.findings.length; }
function badgeType(mod) { return mod.findings.some((f) => f.severity === 'error') ? 'error' : mod.findings.some((f) => f.severity === 'warning') ? 'warning' : 'ok'; }

function activateView(view) {
  state.view = view; $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  const names = { overview: 'Обзор', library: 'Библиотека', profiles: 'Профили', release: 'Сборка релиза' }; $('#page-name').textContent = names[view] || 'Обзор';
  render();
}

function render() {
  $('#nav-count').textContent = state.mods.length;
  $('#stat-mods').textContent = state.mods.length;
  const conflicts = compareMods(state.mods); const plan = dependencyPlan(state.mods);
  const findingTotal = state.mods.reduce((n, m) => n + m.findings.length, 0) + conflicts.length + plan.missing.length + (plan.cycles.length ? 1 : 0);
  $('#stat-findings').textContent = findingTotal;
  $('#stat-conflicts').textContent = conflicts.length;
  $('#stat-games').textContent = new Set(state.mods.map((m) => m.ecosystem).filter((g) => g !== 'Не определена')).size;
  renderRecent(); renderLibrary(); renderProfiles(); renderRelease();
}

function renderRecent() {
  const host = $('#recent-list'); const recent = [...state.mods].sort((a, b) => b.importedAt.localeCompare(a.importedAt)).slice(0, 3);
  host.className = recent.length ? 'recent-list' : 'empty-state compact';
  host.innerHTML = recent.length ? recent.map((m) => `<button class="recent-row" data-mod="${esc(m.id)}"><span class="game-mark">${esc(m.ecosystem.slice(0, 1))}</span><span><b>${esc(m.name)}</b><small>${esc(m.ecosystem)} · ${m.files.length} файлов</small></span><em class="severity-chip ${badgeType(m)}">${findingCount(m)} проверок</em></button>`).join('') : `<span class="empty-icon">⌁</span><strong>Библиотека пока пуста</strong><small>Добавь папку или архив, чтобы начать анализ.</small>`;
}

function renderLibrary() {
  const host = $('#library-list'); if (!host) return;
  const games = [...new Set(state.mods.map((m) => m.ecosystem))].sort(); const select = $('#filter-game'); const current = state.game;
  select.innerHTML = `<option value="">Все экосистемы</option>${games.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}`; select.value = current;
  const query = state.filter.toLowerCase(); let mods = state.mods.filter((m) => (!state.game || m.ecosystem === state.game) && (!query || `${m.name} ${m.author} ${m.ecosystem} ${m.description}`.toLowerCase().includes(query)));
  if (state.sort === 'severity') mods.sort((a, b) => Math.min(...a.findings.map((f) => severityOrder[f.severity] ?? 3), 3) - Math.min(...b.findings.map((f) => severityOrder[f.severity] ?? 3), 3));
  else if (state.sort === 'date') mods.sort((a, b) => b.importedAt.localeCompare(a.importedAt)); else mods.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (!mods.length) { host.innerHTML = `<div class="empty-state panel"><span class="empty-icon">▦</span><strong>${state.mods.length ? 'Ничего не найдено' : 'Библиотека пока пуста'}</strong><small>${state.mods.length ? 'Измени запрос или фильтр.' : 'Импортируй папку мода или ZIP-архив.'}</small>${state.mods.length ? '' : '<button class="primary" data-import>Добавить моды</button>'}</div>`; return; }
  host.innerHTML = mods.map((m) => `<article class="mod-card"><div class="mod-icon">${esc(m.ecosystem.split(/[ ·/]/)[0].slice(0, 2).toUpperCase())}</div><div class="mod-main"><div class="mod-title"><h3>${esc(m.name)}</h3><span class="severity-chip ${badgeType(m)}">${findingCount(m)} проверок</span></div><p>${esc(m.description || 'Описание отсутствует.')} </p><div class="mod-meta"><span>${esc(m.ecosystem)}</span>${m.version ? `<span>v${esc(m.version)}</span>` : ''}${m.author ? `<span>Автор: ${esc(m.author)}</span>` : ''}<span>${m.files.length} файлов · ${humanSize(m.totalBytes)}</span></div>${m.findings.length ? `<div class="finding-list">${m.findings.slice(0, 4).map((f) => `<div class="finding ${f.severity}"><b>${esc(f.title)}</b><small>${esc(f.detail)}</small></div>`).join('')}</div>` : '<div class="clean-note">✓ Локальные проверки не нашли замечаний</div>'}</div><div class="mod-actions"><label title="Включить в профиль"><input type="checkbox" data-enable="${esc(m.id)}" ${state.profile.enabled.includes(m.id) ? 'checked' : ''}> Профиль</label><button class="icon-button danger-text" data-delete="${esc(m.id)}" title="Удалить из библиотеки">×</button></div></article>`).join('');
}

function renderProfiles() {
  if (!$('#profile-list')) return;
  $('#profile-select').innerHTML = state.profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name)}</option>`).join('');
  $('#profile-select').value = state.profile.id;
  const title = $('#profile-title'); if (document.activeElement !== title) title.value = state.profile.name;
  $('#profile-name').textContent = state.profile.name;
  const active = selectedMods(), plan = dependencyPlan(active), conflicts = compareMods(active);
  const profileFindings = [];
  for (const m of plan.missing) profileFindings.push(`<div class="finding warning"><b>Не найдена зависимость: ${esc(m.dependency)}</b><small>Нужна для «${esc(m.modName)}»</small></div>`);
  if (plan.cycles.length) profileFindings.push(`<div class="finding error"><b>Цикл зависимостей</b><small>${esc(plan.cycles.map((id) => state.mods.find((m) => m.id === id)?.name || id).join(' → '))}</small></div>`);
  for (const c of conflicts.slice(0, 6)) profileFindings.push(`<div class="finding warning"><b>${c.identical ? 'Одинаковый файл' : 'Конфликт файла'}: ${esc(c.path)}</b><small>${esc(c.files.map((f) => f.modName).join(' ↔ '))}</small></div>`);
  $('#profile-findings').innerHTML = profileFindings.length ? profileFindings.join('') : active.length ? '<div class="clean-note">✓ У выбранной коллекции нет выявленных проблем зависимостей</div>' : '<p class="muted">Включи моды в список, чтобы увидеть связи и проверки.</p>';
  $('#profile-list').innerHTML = state.mods.length ? state.mods.map((m) => `<label class="profile-mod"><input type="checkbox" data-enable="${esc(m.id)}" ${state.profile.enabled.includes(m.id) ? 'checked' : ''}><span class="profile-toggle"></span><span class="profile-mod-icon">${esc(m.ecosystem.slice(0, 1))}</span><span class="profile-mod-text"><b>${esc(m.name)}</b><small>${esc(m.ecosystem)}${m.dependencies.length ? ` · ${m.dependencies.length} зависимостей` : ''}</small></span><span class="severity-chip ${badgeType(m)}">${findingCount(m)} проверок</span></label>`).join('') : '<div class="empty-state"><strong>Добавь моды в библиотеку</strong></div>';
  const order = plan.order.map((id) => state.mods.find((m) => m.id === id)).filter(Boolean);
  $('#graph-view').innerHTML = order.length ? `<div class="graph-stack">${order.map((m, i) => `<div class="graph-node ${plan.cycles.includes(m.id) ? 'broken' : ''}"><span>${String(i + 1).padStart(2, '0')}</span><b>${esc(m.name)}</b><small>${esc(m.ecosystem)}</small></div>${i < order.length - 1 ? '<div class="graph-link">↓</div>' : ''}`).join('')}</div>` : '<div class="empty-state"><span class="empty-icon">⌘</span><strong>Граф появится после импорта</strong></div>';
}

function renderRelease() {
  const mods = selectedMods(), report = buildReport(mods, state.profile.name), preflight = [];
  if (!state.mods.length) preflight.push(['warning', 'Библиотека пуста', 'Добавь моды для начала сборки.']);
  else if (!mods.length) preflight.push(['warning', 'Нет включённых модов', 'В профиле пока нет выбранных элементов.']);
  else preflight.push(['ok', `${mods.length} модов включено`, `${report.summary.files} файлов · ${humanSize(report.summary.totalBytes)}`]);
  if (report.summary.errors) preflight.push(['error', `${report.summary.errors} ошибок`, 'Просмотри отчёт перед публикацией.']);
  if (report.summary.warnings) preflight.push(['warning', `${report.summary.warnings} предупреждений`, 'Часть проверок требует ручного решения.']);
  if (!report.summary.errors && !report.summary.warnings && mods.length) preflight.push(['ok', 'Критичных замечаний нет', 'Это не гарантирует работоспособность в игре.']);
  $('#preflight-list').innerHTML = preflight.map(([type, title, detail]) => `<div class="preflight-row ${type}"><span>${type === 'ok' ? '✓' : type === 'error' ? '!' : '·'}</span><div><b>${esc(title)}</b><small>${esc(detail)}</small></div></div>`).join('');
  if ($('#build-status').dataset.manual !== '1') $('#build-status').textContent = mods.length ? `Готово к локальной сборке · ${report.summary.errors ? 'есть ошибки, ZIP будет помечен отчётом' : 'проверь предупреждения перед публикацией'}` : 'Добавь моды и активируй их в профиле, чтобы собрать пакет.';
}

function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
function downloadReport() { const report = buildReport(selectedMods(), state.profile.name); downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `${slug(state.profile.name)}-report.json`); }
function slug(text) { return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '') || 'modforge'; }

function buildReleaseFiles(mods) {
  const roots = uniqueModFolderNames(mods);
  return mods.flatMap((mod, index) => mod.files.map((file) => ({ path: `${roots[index]}/${file.path}`, bytes: file.bytes })));
}

async function importFiles(fileList, folderMode = false) {
  const files = [...fileList]; if (!files.length) return;
  const progress = $('#import-progress'); progress.textContent = `Читаю ${files.length} файлов…`;
  const groups = new Map(); const rejected = [];
  try {
    const folderPaths = new Map();
    if (folderMode) {
      const entries = files.map((file) => { const parts = normalizePath(file.webkitRelativePath || file.name).split('/'); return { file, root: parts[0], path: parts.slice(1).join('/') || file.name }; });
      const manifests = new Set();
      for (const item of entries) {
        const p = item.path.toLowerCase(); let prefix = null;
        if (p.endsWith('/about/about.xml')) prefix = item.path.split('/').slice(0, -2).join('/');
        else if (/(^|\/)(descriptor\.mod|info\.json|fabric\.mod\.json|manifest\.json|mods\.toml)$/.test(p)) prefix = item.path.split('/').slice(0, -1).join('/');
        else if (p.endsWith('.mod')) prefix = item.path.split('/').slice(0, -1).join('/');
        if (prefix !== null) manifests.add(prefix);
      }
      const roots = [...manifests].sort((a, b) => a.length - b.length);
      for (const item of entries) {
        let group;
        if (roots.length) group = roots.find((root) => !root || item.path === root || item.path.startsWith(`${root}/`));
        else group = '';
        const filePath = group ? item.path.slice(group.length).replace(/^\//, '') : item.path;
        folderPaths.set(item.file, { group: group || item.root, path: filePath || item.file.name });
      }
    }
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        const zip = await readZip(file); rejected.push(...zip.rejected.map((r) => `${r.path}: ${r.reason}`));
        const wrapped = stripCommonWrapper(zip.entries);
        const analyzed = await analyzeMod({ name: file.name.replace(/\.zip$/i, ''), files: wrapped });
        groups.set(analyzed.id, analyzed);
      } else {
        const rel = normalizePath(file.webkitRelativePath || file.name);
        const folderInfo = folderPaths.get(file);
        const dir = folderMode && folderInfo ? folderInfo.group : 'Выбранные файлы';
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push({ path: folderMode && folderInfo ? folderInfo.path : file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
    }
    for (const [key, value] of [...groups]) if (Array.isArray(value)) {
      const analyzed = await analyzeMod({ name: key === 'Выбранные файлы' ? value[0]?.path.split('/')[0] || key : key, files: value }); groups.delete(key); groups.set(analyzed.id, analyzed);
    }
    for (const mod of groups.values()) { const old = state.mods.findIndex((m) => m.id === mod.id); if (old >= 0) state.mods.splice(old, 1); state.mods.unshift(mod); await put('mods', mod); if (!state.profile.enabled.includes(mod.id)) state.profile.enabled.push(mod.id); }
    state.profile.name = $('#profile-title').value || state.profile.name; await saveProfile();
    progress.textContent = `${groups.size} модов добавлено${rejected.length ? ` · ${rejected.length} записей ZIP пропущено` : ''}`;
    $('#import-modal').hidden = true; toast(`${groups.size} модов добавлено в библиотеку`, 'success'); activateView('library');
    if (rejected.length) toast(`Некоторые записи ZIP пропущены: ${rejected[0]}`, 'warning');
  } catch (error) { progress.textContent = error.message; toast(error.message, 'error'); }
}

async function init() {
  try { state.mods = await getAll('mods'); state.profiles = await getAll('profiles'); if (state.profiles.length) state.profile = state.profiles.find((p) => p.id === 'default') || state.profiles[0]; else { state.profiles.push(state.profile); await put('profiles', state.profile); } }
  catch (error) { toast(`Не удалось открыть локальную базу: ${error.message}`, 'error'); }
  render();
  document.addEventListener('click', async (event) => {
    const view = event.target.closest('[data-view]')?.dataset.view; if (view) { activateView(view); return; }
    if (event.target.closest('[data-import]')) { $('#import-modal').hidden = false; return; }
    if (event.target.closest('#close-import')) { $('#import-modal').hidden = true; return; }
    if (event.target.closest('#pick-folder')) { $('#folder-input').click(); return; }
    if (event.target.closest('#pick-files')) { $('#files-input').click(); return; }
    const del = event.target.closest('[data-delete]')?.dataset.delete; if (del) { state.mods = state.mods.filter((m) => m.id !== del); for (const profile of state.profiles) { profile.enabled = profile.enabled.filter((id) => id !== del); await put('profiles', profile); } state.profile = state.profiles.find((p) => p.id === state.profile.id) || state.profile; await deleteOne('mods', del); render(); toast('Мод удалён из локальной библиотеки'); return; }
    if (event.target.closest('#export-report') || event.target.closest('#download-report')) { downloadReport(); return; }
    if (event.target.closest('#export-profile')) { const payload = { schemaVersion: 1, name: state.profile.name, createdAt: new Date().toISOString(), mods: selectedMods().map((m) => ({ id: m.id, name: m.name, ecosystem: m.ecosystem, version: m.version, dependencies: m.dependencies })) }; downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${slug(state.profile.name)}.json`); return; }
    if (event.target.closest('#new-profile')) { const name = `Профиль ${state.profiles.length + 1}`; state.profile = { id: `profile-${crypto.randomUUID()}`, name, enabled: [] }; state.profiles.push(state.profile); await saveProfile(); render(); toast('Создан отдельный пустой профиль'); return; }
    if (event.target.closest('#help-button')) { toast('Добавь папки модов или ZIP. Результаты хранятся локально в текущем браузере.'); return; }
    if (event.target.closest('#build-release')) {
      const mods = selectedMods(); if (!mods.length) { toast('Сначала выбери моды в профиле', 'warning'); return; }
      const name = slug($('#release-name').value || 'modforge-collection'), report = buildReport(mods, state.profile.name), allFiles = buildReleaseFiles(mods);
      if ($('#include-report').checked) { allFiles.push({ path: 'MODFORGE-REPORT.json', bytes: new TextEncoder().encode(JSON.stringify(report, null, 2)) }); const notes = $('#release-notes').value.trim(); if (notes) allFiles.push({ path: 'RELEASE-NOTES.txt', bytes: new TextEncoder().encode(notes) }); }
      try { const blob = writeZip(allFiles); const digest = await (await import('../core/modforge.js')).sha256(new Uint8Array(await blob.arrayBuffer())); downloadBlob(blob, `${name}.zip`); downloadBlob(new Blob([`${digest}  ${name}.zip\n`], { type: 'text/plain' }), `${name}.zip.sha256`); const status = $('#build-status'); status.dataset.manual = '1'; status.textContent = `ZIP собран: ${name}.zip · ${humanSize(blob.size)} · SHA-256: ${digest}`; toast('ZIP и файл SHA-256 скачаны', 'success'); }
      catch (error) { toast(`Сборка не удалась: ${error.message}`, 'error'); }
    }
  });
  document.addEventListener('change', async (event) => {
    if (event.target.id === 'folder-input') importFiles(event.target.files, true);
    if (event.target.id === 'files-input') importFiles(event.target.files, false);
    if (event.target.matches('[data-enable]')) { const id = event.target.dataset.enable; const set = new Set(state.profile.enabled); event.target.checked ? set.add(id) : set.delete(id); state.profile.enabled = [...set]; await saveProfile(); render(); }
    if (event.target.id === 'filter-game') { state.game = event.target.value; renderLibrary(); }
    if (event.target.id === 'sort-mods') { state.sort = event.target.value; renderLibrary(); }
    if (event.target.id === 'profile-select') { state.profile = state.profiles.find((profile) => profile.id === event.target.value) || state.profile; render(); }
  });
  $('#search-mods').addEventListener('input', (e) => { state.filter = e.target.value; renderLibrary(); });
  $('#profile-title').addEventListener('input', async (e) => { state.profile.name = e.target.value || 'Основной профиль'; $('#profile-name').textContent = state.profile.name; await saveProfile(); const option = $('#profile-select').selectedOptions[0]; if (option) option.textContent = state.profile.name; });
  $('#dropzone').addEventListener('dragover', (e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); });
  $('#dropzone').addEventListener('dragleave', (e) => e.currentTarget.classList.remove('dragover'));
  $('#dropzone').addEventListener('drop', async (e) => { e.preventDefault(); e.currentTarget.classList.remove('dragover'); await importFiles(e.dataTransfer.files, false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#import-modal').hidden = true; });
  $('#profile-title').value = state.profile.name;
}

async function saveProfile() {
  const index = state.profiles.findIndex((profile) => profile.id === state.profile.id);
  if (index === -1) state.profiles.push(state.profile); else state.profiles[index] = state.profile;
  await put('profiles', state.profile);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('./sw.js').catch(() => {});

init();
