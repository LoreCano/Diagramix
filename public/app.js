'use strict';

const API = 'http://localhost:5050';

let file = null;
let repoUrl = '';
let projectLabel = '';
let result = null;

let currentTab = 'diagram';
let lastTabBeforeDetail = 'diagram';
let groupMode = 'file'; // file | package | dir

// Preview/runtime caches
let previewItems = []; // [{ key, kind, title, tag, puml }]
const pumlByKey = new Map(); // key -> puml
const imgUrlByKey = new Map(); // key -> objectUrl

/* ---------------------------- GitHub Repo Input -------------------------- */
const repoInput = document.getElementById('repoUrl');
const analyzeBtn = document.getElementById('analyzeBtn');
const zipSection = document.getElementById('zipSection');
const gitSection = document.getElementById('gitSection');
const srcZipBtn = document.getElementById('srcZip');
const srcGitBtn = document.getElementById('srcGit');

let sourceMode = localStorage.getItem('diagramix.sourceMode') || 'zip'; // zip | github
setSourceMode(sourceMode);

srcZipBtn.addEventListener('click', () => setSourceMode('zip'));
srcGitBtn.addEventListener('click', () => setSourceMode('github'));

function setSourceMode(mode) {
  sourceMode = (mode === 'github') ? 'github' : 'zip';
  localStorage.setItem('diagramix.sourceMode', sourceMode);

  if (zipSection) zipSection.style.display = sourceMode === 'zip' ? 'block' : 'none';
  if (gitSection) gitSection.style.display = sourceMode === 'github' ? 'block' : 'none';

  if (srcZipBtn) {
    srcZipBtn.classList.toggle('active', sourceMode === 'zip');
    srcZipBtn.setAttribute('aria-pressed', sourceMode === 'zip' ? 'true' : 'false');
  }
  if (srcGitBtn) {
    srcGitBtn.classList.toggle('active', sourceMode === 'github');
    srcGitBtn.setAttribute('aria-pressed', sourceMode === 'github' ? 'true' : 'false');
  }

  updateAnalyzeDisabled();
}

function updateAnalyzeDisabled() {
  if (sourceMode === 'zip') {
    analyzeBtn.disabled = !file;
    return;
  }
  const info = parseGithubRepoUrl(String(repoInput.value || '').trim());
  analyzeBtn.disabled = !info;
}

repoInput.addEventListener('input', () => {
  repoUrl = String(repoInput.value || '').trim();
  const info = parseGithubRepoUrl(repoUrl);

  if (!info) {
    document.getElementById('repoChip').classList.remove('show');
  } else {
    projectLabel = info.display;
    document.getElementById('repoChip').classList.add('show');
    document.getElementById('repoName').textContent = info.display;
    document.getElementById('repoHost').textContent = info.host;
    clearErr();
  }

  updateAnalyzeDisabled();
});

repoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});

/* ----------------------------- File Pick/Drop ---------------------------- */
const fi = document.getElementById('fileInput');
const uz = document.getElementById('uploadZone');

fi.addEventListener('change', (e) => e.target.files[0] && pick(e.target.files[0]));

uz.addEventListener('dragover', (e) => {
  e.preventDefault();
  uz.classList.add('over');
});
uz.addEventListener('dragleave', () => uz.classList.remove('over'));
uz.addEventListener('drop', (e) => {
  e.preventDefault();
  uz.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (!String(f.name || '').toLowerCase().endsWith('.zip')) return err('Only .zip files are supported.');
  pick(f);
});

function pick(f) {
  file = f;
  projectLabel = '';
  document.getElementById('fileChip').classList.add('show');
  document.getElementById('fileName').textContent = f.name;
  document.getElementById('fileSize').textContent = `${(f.size / 1024).toFixed(0)} KB`;
  updateAnalyzeDisabled();
  clearErr();
}

/* -------------------------------- Wiring -------------------------------- */
analyzeBtn.addEventListener('click', analyze);
document.getElementById('detailClose').addEventListener('click', closeDetail);

const grpPackageEl = document.getElementById('grpPackage');
const grpDirEl = document.getElementById('grpDir');

groupMode = localStorage.getItem('diagramix.groupMode') || 'file';
applyGroupUi(groupMode);

grpPackageEl.addEventListener('change', () => {
  if (grpPackageEl.checked) grpDirEl.checked = false;
  setGroupMode(grpPackageEl.checked ? 'package' : (grpDirEl.checked ? 'dir' : 'file'));
});
grpDirEl.addEventListener('change', () => {
  if (grpDirEl.checked) grpPackageEl.checked = false;
  setGroupMode(grpDirEl.checked ? 'dir' : (grpPackageEl.checked ? 'package' : 'file'));
});

document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tb');
  if (!btn) return;
  const tab = btn.dataset.tab;
  if (!tab) return;
  switchTab(tab);
});

document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (!action) return;
  handleAction(action, btn).catch((ex) => err(ex && ex.message ? ex.message : String(ex)));
});

document.body.addEventListener('click', (e) => {
  // Prevent toggling when clicking action buttons inside headers.
  if (e.target.closest('[data-action]')) return;

  const pkgHdr = e.target.closest('.pkg-hdr');
  if (pkgHdr) return togglePkg(pkgHdr);

  const pbHdr = e.target.closest('.pb-hdr');
  if (pbHdr) return togglePb(pbHdr);
});

function setGroupMode(mode) {
  groupMode = mode || 'file';
  localStorage.setItem('diagramix.groupMode', groupMode);
  applyGroupUi(groupMode);
  if (result) repaintAll();
}

function applyGroupUi(mode) {
  grpPackageEl.checked = mode === 'package';
  grpDirEl.checked = mode === 'dir';
}

/* -------------------------------- Analyze -------------------------------- */
async function analyze() {
  const rawUrl = String(repoInput.value || '').trim();
  const repoInfo = rawUrl ? parseGithubRepoUrl(rawUrl) : null;

  if (sourceMode === 'zip') {
    if (!file) return err('Upload a .zip first.');
  } else {
    if (!repoInfo) return err('Insert a valid public GitHub repository URL (https://github.com/<owner>/<repo>).');
  }

  repoUrl = rawUrl;
  if (repoInfo) projectLabel = repoInfo.display;
  setLoad(true);
  clearErr();
  analyzeBtn.disabled = true;

  try {
    await tick(1, 220);

    let res;
    if (sourceMode === 'zip') {
      const fd = new FormData();
      fd.append('project', file);
      await tick(2, 180);
      res = await fetch(`${API}/api/analyze`, { method: 'POST', body: fd });
    } else {
      await tick(2, 180);
      res = await fetch(`${API}/api/analyze-git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl })
      });
    }

    await tick(3, 260);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        msg = data && (data.error || data.message) ? (data.error || data.message) : msg;
      } catch {}
      throw new Error(msg);
    }

    result = await res.json();
    if (result && result.error) throw new Error(String(result.error));
    if (result && result.project) {
      if (result.project.kind === 'github' && result.project.repo) {
        projectLabel = String(result.project.repo || projectLabel);
        if (repoInfo) {
          document.getElementById('repoChip').classList.add('show');
          document.getElementById('repoName').textContent = projectLabel;
          document.getElementById('repoHost').textContent = repoInfo.host;
        }
      }
      if (result.project.kind === 'zip' && result.project.name) {
        document.getElementById('fileChip').classList.add('show');
        document.getElementById('fileName').textContent = String(result.project.name);
      }
    }
    await tick(4, 180);
    await tick(5, 140);

    setLoad(false);
    paint(result);
  } catch (e) {
    setLoad(false);
    analyzeBtn.disabled = false;
    const msg = (e && e.message) ? e.message : String(e);
    err(msg.includes('fetch') || msg.includes('Failed')
      ? 'Backend unreachable.\n\nRun:\nnpm install\nnode server.js'
      : msg);
  }
}

/* --------------------------------- Paint --------------------------------- */
function paint(d) {
  document.getElementById('statsStrip').classList.add('show');
  paintStats(d);

  const classes = Array.isArray(d.classes) ? d.classes : [];
  const puml = String(d.plantUml || '');

  paintBlocks(classes);
  paintPreviewTab(classes, puml);
  paintPumlTab(puml, classes);

  document.getElementById('tc0').textContent = classes.length;
  analyzeBtn.disabled = false;
}

function repaintAll() {
  if (!result) return;
  paintBlocks(result.classes || []);
  paintPreviewTab(result.classes || [], String(result.plantUml || ''));
  paintPumlTab(String(result.plantUml || ''), result.classes || []);
}

function paintStats(d) {
  const classes = Array.isArray(d.classes) ? d.classes : (Array.isArray(result && result.classes) ? result.classes : []);

  const filesAnalyzed = Number((d.stats && d.stats.filesAnalyzed) || 0);
  const classCount = classes.filter((c) => c.type === 'class').length;
  const ifaceCount = classes.filter((c) => c.type === 'interface').length;
  const structCount = classes.filter((c) => c.type === 'struct').length;
  const enumCount = classes.filter((c) => c.type === 'enum').length;

  const methodCount = classes.reduce((acc, c) => acc + (c.methods ? c.methods.length : 0), 0);
  const relCount = classes.reduce((acc, c) => acc + (c.relations ? c.relations.length : 0), 0);

  const pkgSet = new Set(classes.map((c) => String(c.package || '')).filter(Boolean));
  const dirSet = new Set(classes.map((c) => dirOf(c.file || '')).filter(Boolean));

  setText('sv0', filesAnalyzed);
  setText('sv1', classCount);
  setText('sv4', ifaceCount);
  setText('sv5', structCount);
  setText('sv6', enumCount);
  setText('sv7', pkgSet.size);
  setText('sv8', dirSet.size);
  setText('sv2', methodCount);
  setText('sv3', relCount);
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(v);
}

/* ------------------------------ UML Blocks Tab ---------------------------- */
function paintBlocks(classes) {
  const empty = document.getElementById('emptyD');
  const wrap = document.getElementById('blocks');

  if (!classes.length) {
    empty.style.display = 'flex';
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = 'flex';
  wrap.innerHTML = '';

  const groups = {};
  classes.forEach((c, i) => {
    const key = groupKey(c);
    if (!groups[key]) groups[key] = [];
    groups[key].push({ c, i });
  });

  Object.keys(groups).sort((a, b) => a.localeCompare(b)).forEach((key) => {
    const items = groups[key];
    const grp = document.createElement('div');
    grp.className = 'pkg';

    grp.innerHTML = `
      <div class="pkg-hdr">
        <div class="pkg-tog"><span class="pb-chev o">></span></div>
        <div class="pkg-nm"><strong>${escHtml(groupTitle(key))}</strong></div>
        <span class="pkg-cnt">${items.length} ${items.length === 1 ? 'class' : 'classes'}</span>
      </div>
      <div class="pkg-body"></div>
    `;

    const body = grp.querySelector('.pkg-body');
    items.forEach(({ c, i }) => body.appendChild(makeClassCard(c, i)));
    wrap.appendChild(grp);
  });
}

function groupKey(c) {
  if (groupMode === 'package') return String(c.package || '(no package)');
  if (groupMode === 'dir') return dirOf(c.file || '');
  return String(c.file || 'unknown');
}

function groupTitle(key) {
  if (groupMode === 'package') return `Package: ${key}`;
  if (groupMode === 'dir') return `Directory: ${key}`;
  const p = normPath(key);
  return p.split('/').pop();
}

function togglePkg(hdr) {
  const body = hdr.nextElementSibling;
  const closing = !body.classList.contains('closed');
  body.classList.toggle('closed', closing);
  const chev = hdr.querySelector('.pb-chev');
  if (chev) chev.classList.toggle('o', !closing);
}

function makeClassCard(c, idx) {
  const card = document.createElement('div');
  card.className = 'uml-card';
  card.dataset.idx = String(idx);

  let h = `<div class="uc-head"><span class="ut ut-${c.type}">${escHtml(c.type)}</span><span class="uc-name">${escHtml(c.name)}</span></div>`;

  if (c.fields && c.fields.length) {
    h += `<div class="uc-sec"><div class="uc-sec-lbl">Fields<span class="uc-sec-cnt">${c.fields.length}</span></div>`;
    c.fields.forEach((f) => {
      h += `<div class="uc-mem"><span class="uv ${vc(f.visibility)}">${escHtml(f.visibility)}</span><span class="um-name">${escHtml(f.name)}</span><span class="um-type">${escHtml(f.type)}</span></div>`;
    });
    h += `</div>`;
  }

  if (c.methods && c.methods.length) {
    h += `<div class="uc-sec"><div class="uc-sec-lbl">Methods<span class="uc-sec-cnt">${c.methods.length}</span></div>`;
    c.methods.forEach((m) => {
      const params = m.params ? m.params : '';
      const st = m.isStatic ? `<span class="mchip">static</span>` : '';
      h += `<div class="uc-mem"><span class="uv ${vc(m.visibility)}">${escHtml(m.visibility)}</span>${st}<span class="um-name">${escHtml(m.name)}(${escHtml(params)})</span><span class="um-type">${escHtml(m.returnType || '')}</span></div>`;
    });
    h += `</div>`;
  }

  if (c.relations && c.relations.length) {
    h += `<div class="uc-rels">`;
    c.relations.forEach((r) => {
      h += `<span class="rchip rc-${escHtml(r.kind)}">${escHtml(relIcon(r.kind))} ${escHtml(r.target)}</span>`;
    });
    h += `</div>`;
  }

  card.innerHTML = h;
  card.addEventListener('click', () => showDetail(idx));
  return card;
}

/* -------------------------------- Preview Tab ---------------------------- */
function paintPreviewTab(classes, puml) {
  const empty = document.getElementById('emptyV');
  const panel = document.getElementById('prevPanel');
  const wrap = document.getElementById('prevWrap');

  // Cleanup old object URLs
  for (const url of imgUrlByKey.values()) URL.revokeObjectURL(url);
  imgUrlByKey.clear();
  pumlByKey.clear();

  previewItems = buildPreviewItems(classes, puml);

  if (!previewItems.length) {
    empty.style.display = 'flex';
    panel.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  panel.style.display = 'block';
  wrap.innerHTML = '';

  previewItems.forEach((it) => {
    pumlByKey.set(it.key, it.puml);

    const card = document.createElement('div');
    card.className = 'uml-card prev-card';
    card.dataset.key = it.key;

    const tagClass = it.kind === 'package' ? 'ut-package' : it.kind === 'dir' ? 'ut-dir' : `ut-${it.tag}`;
    const tagText = it.kind === 'package' ? 'package' : it.kind === 'dir' ? 'dir' : it.tag;

    card.innerHTML = `
      <div class="uc-head">
        <span class="ut ${tagClass}">${escHtml(tagText)}</span>
        <span class="uc-name">${escHtml(it.title)}</span>
        <div class="prev-actions">
          <button class="btn-sm" data-action="prev-render" data-key="${escHtml(it.key)}" type="button">Render</button>
          <button class="btn-sm" data-action="prev-dl-svg" data-key="${escHtml(it.key)}" type="button">SVG</button>
          <button class="btn-sm" data-action="prev-dl-png" data-key="${escHtml(it.key)}" type="button">PNG</button>
          <button class="btn-sm" data-action="prev-dl-plantuml" data-key="${escHtml(it.key)}" type="button">.plantuml</button>
        </div>
      </div>
      <div class="prev-body">
        <div class="prev-frame is-empty">
          <div class="prev-empty">Click Render to generate the preview</div>
          <img alt="UML preview" loading="lazy" style="display:none" />
        </div>
      </div>
    `;

    wrap.appendChild(card);
  });
}

function buildPreviewItems(classes, fullPuml) {
  if (!classes.length || !String(fullPuml || '').trim()) return [];

  if (groupMode === 'package' || groupMode === 'dir') {
    const grouped = {};
    classes.forEach((c) => {
      const k = groupKey(c);
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(c);
    });

    return Object.keys(grouped).sort((a, b) => a.localeCompare(b)).map((k) => {
      const cs = grouped[k];
      const isPkg = groupMode === 'package';
      const kind = isPkg ? 'package' : 'dir';
      return {
        key: `${kind}:${k}`,
        kind,
        title: groupTitle(k),
        tag: 'class',
        puml: buildScopedPlantUml(fullPuml, cs, { includeRelations: 'internal' })
      };
    });
  }

  // Default: one preview per class
  return classes
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((c) => ({
      key: `class:${c.name}`,
      kind: 'class',
      title: `${typeIcon(c.type)} ${c.name}`,
      tag: c.type || 'class',
      puml: buildScopedPlantUml(fullPuml, [c], { includeRelations: 'touching' })
    }));
}

async function renderOnePreview(key) {
  const card = document.querySelector(`.prev-card[data-key="${cssEsc(key)}"]`);
  if (!card) return;
  const img = card.querySelector('img');
  const frame = card.querySelector('.prev-frame');
  const empty = card.querySelector('.prev-empty');
  const src = pumlByKey.get(key);
  if (!img || !src) return;

  if (empty) empty.textContent = 'Rendering...';

  const blob = await krokiRender('svg', pumlForPreview(src));
  const prevUrl = imgUrlByKey.get(key);
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  const url = URL.createObjectURL(blob);
  imgUrlByKey.set(key, url);
  img.src = url;
  img.style.display = 'block';
  if (empty) empty.remove();
  if (frame) frame.classList.remove('is-empty');
}

async function renderAllPreviews() {
  const keys = previewItems.map((it) => it.key);
  await asyncPool(3, keys, renderOnePreview);
}

/* ---------------------------- PlantUML Source Tab ------------------------- */
function paintPumlTab(puml, classes) {
  const empty = document.getElementById('emptyP');
  const panel = document.getElementById('pumlPanel');
  const wrap = document.getElementById('pumlBlocks');

  if (!puml.trim() || !classes.length) {
    empty.style.display = 'flex';
    panel.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  panel.style.display = 'block';
  wrap.innerHTML = '';

  const lines = puml.split('\n');
  const cfgLines = lines.filter((l) => l.startsWith('@startuml') || l.startsWith('skinparam'));
  if (cfgLines.length) wrap.appendChild(mkPumlBlock('Configuration', cfgLines.join('\n'), false, '', null));

  if (groupMode === 'package' || groupMode === 'dir') {
    const grouped = {};
    classes.forEach((c) => {
      const k = groupKey(c);
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(c);
    });

    Object.keys(grouped).sort((a, b) => a.localeCompare(b)).forEach((k) => {
      const cs = grouped[k];
      const key = `${groupMode}:${k}`;
      const scoped = buildScopedPlantUml(puml, cs, { includeRelations: 'internal' });
      wrap.appendChild(mkPumlBlock(groupTitle(k), scoped, false, `${cs.length}`, key));
    });
  } else {
    classes
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .forEach((c) => {
        const key = `class:${c.name}`;
        const scoped = buildScopedPlantUml(puml, [c], { includeRelations: 'touching' });
        wrap.appendChild(mkPumlBlock(`${typeIcon(c.type)} ${c.name}`, scoped, false, `${(c.fields || []).length}f · ${(c.methods || []).length}m`, key));
      });
  }

  const relLines = lines.filter((l) => relLine(l));
  if (relLines.length) wrap.appendChild(mkPumlBlock('Relations (all)', relLines.join('\n'), false, `${relLines.length}`, null));

  wrap.appendChild(mkPumlBlock('End', '@enduml', false, '', null));
}

function mkPumlBlock(label, code, open, meta, dlKey) {
  const el = document.createElement('div');
  el.className = 'pb';
  el.innerHTML = `
    <div class="pb-hdr">
      <span class="pb-chev ${open ? 'o' : ''}">></span>
      <span class="pb-name">${escHtml(label)}</span>
      ${meta ? `<span class="pb-meta">${escHtml(meta)}</span>` : ''}
      ${dlKey ? `<button class="btn-sm" data-action="puml-dl" data-key="${escHtml(dlKey)}" type="button">Download</button>` : ''}
    </div>
    <div class="pb-body ${open ? 'o' : ''}">
      <pre>${hl(code)}</pre>
    </div>`;
  if (dlKey) pumlByKey.set(dlKey, code);
  return el;
}

function togglePb(hdr) {
  const body = hdr.nextElementSibling;
  const chev = hdr.querySelector('.pb-chev');
  const open = body.classList.toggle('o');
  chev.classList.toggle('o', open);
}

/* --------------------------------- Detail -------------------------------- */
function showDetail(idx) {
  if (!result || !Array.isArray(result.classes)) return;
  const c = result.classes[idx];
  if (!c) return;

  document.querySelectorAll('.uml-card').forEach((card) => card.classList.toggle('sel', +card.dataset.idx === idx));

  document.getElementById('detailBtn').style.display = 'flex';
  document.getElementById('detailTop').style.display = 'flex';
  lastTabBeforeDetail = currentTab !== 'detail' ? currentTab : lastTabBeforeDetail;
  switchTab('detail');

  document.getElementById('emptyDet').style.display = 'none';
  const dc = document.getElementById('detContent');
  dc.style.display = 'block';

  const icons = { class: 'C', interface: 'I', struct: 'S', enum: 'E' };

  const mkList = (items, mapFn, emptyMsg) =>
    items.length ? `<ul class="ds-ul">${items.map(mapFn).join('')}</ul>`
      : `<div class="ds-empty">${escHtml(emptyMsg)}</div>`;

  const fields = Array.isArray(c.fields) ? c.fields : [];
  const methods = Array.isArray(c.methods) ? c.methods : [];
  const rels = Array.isArray(c.relations) ? c.relations : [];

  const fieldsHtml = mkList(fields, (f) =>
    `<li class="ds-li"><span class="ds-vis ${vc(f.visibility)}">${escHtml(f.visibility)}</span><span class="ds-n">${escHtml(f.name)}</span><span class="ds-tp">${escHtml(f.type)}</span></li>`,
    'No fields found');

  const methodsHtml = mkList(methods, (m) =>
    `<li class="ds-li"><span class="ds-vis ${vc(m.visibility)}">${escHtml(m.visibility)}</span>${m.isStatic ? `<span class="mchip">static</span>` : ''}<span class="ds-n">${escHtml(m.name)}(${escHtml(m.params || '')})</span><span class="ds-tp">${escHtml(m.returnType || 'void')}</span></li>`,
    'No methods found');

  const relsHtml = mkList(rels, (r) =>
    `<li class="ds-li"><span class="rchip rc-${escHtml(r.kind)}" style="font-size:.67rem">${escHtml(relIcon(r.kind))} ${escHtml(r.kind)}</span><span style="font-family:'IBM Plex Mono',monospace;font-size:.73rem;color:var(--code);margin-left:.5rem">${escHtml(r.target)}</span></li>`,
    'No relations');

  dc.innerHTML = `
    <div class="det-hdr">
      <div class="det-ico di-${escHtml(c.type)}">${escHtml(icons[c.type] || 'C')}</div>
      <div>
        <div class="det-name">${escHtml(c.name)}</div>
        <div class="det-meta">${escHtml(c.type)} · ${escHtml(c.file || '')}</div>
      </div>
    </div>
    <div class="det-grid">
      <div class="det-sec">
        <div class="ds-t">Fields <span class="ds-c">${fields.length}</span></div>
        ${fieldsHtml}
      </div>
      <div class="det-sec">
        <div class="ds-t">Methods <span class="ds-c">${methods.length}</span></div>
        ${methodsHtml}
      </div>
      <div class="det-sec full">
        <div class="ds-t">Relations <span class="ds-c">${rels.length}</span></div>
        ${relsHtml}
      </div>
    </div>`;
}

/* ---------------------------------- Tabs --------------------------------- */
function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.tb').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('show'));
  const tabBtn = document.querySelector(`.tb[data-tab="${cssEsc(name)}"]`);
  if (tabBtn) tabBtn.classList.add('active');
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('show');
}

function closeDetail() {
  document.getElementById('detailBtn').style.display = 'none';
  document.getElementById('detailTop').style.display = 'none';
  document.querySelectorAll('.uml-card').forEach((card) => card.classList.remove('sel'));
  document.getElementById('detContent').style.display = 'none';
  document.getElementById('emptyDet').style.display = 'flex';
  switchTab(lastTabBeforeDetail || 'diagram');
}

/* --------------------------------- Loading -------------------------------- */
function setLoad(v) {
  const ld = document.getElementById('loading');
  const ps = document.getElementById('panels');
  ld.classList.toggle('show', v);
  ps.style.display = v ? 'none' : 'block';
  if (v) {
    for (let i = 1; i <= 5; i++) {
      const e = document.getElementById('ls' + i);
      if (!e) continue;
      e.classList.remove('active', 'done');
      const dot = e.querySelector('.ls-i');
      if (dot) dot.textContent = 'o';
    }
  }
}

async function tick(n, d) {
  const prev = document.getElementById('ls' + (n - 1));
  if (prev) {
    prev.classList.remove('active');
    prev.classList.add('done');
    const dot = prev.querySelector('.ls-i');
    if (dot) dot.textContent = '+';
  }
  const cur = document.getElementById('ls' + n);
  if (cur) {
    cur.classList.add('active');
    const dot = cur.querySelector('.ls-i');
    if (dot) dot.textContent = '*';
  }
  await new Promise((r) => setTimeout(r, d));
}

/* --------------------------------- Actions -------------------------------- */
async function handleAction(action, btn) {
  if (!result) {
    if (action === 'render-all') return;
    if (action.startsWith('prev-')) return;
    if (action.startsWith('puml-')) return;
  }

  if (action === 'render-all') return renderAllPreviews();

  if (action === 'copy-all') return copyAll();
  if (action === 'dl-plantuml') return dlPlantUML();

  if (action === 'prev-render') {
    const key = btn.dataset.key;
    if (key) return renderOnePreview(key);
  }

  if (action === 'prev-dl-svg' || action === 'prev-dl-png') {
    const key = btn.dataset.key;
    const src = key ? pumlByKey.get(key) : null;
    if (!src) return;
    const format = action.endsWith('svg') ? 'svg' : 'png';
    const blob = await krokiRender(format, pumlForPreview(src));
    dlBlob(`${safeBaseName()}-${safeKey(key)}.${format}`, blob);
    return;
  }

  if (action === 'prev-dl-plantuml') {
    const key = btn.dataset.key;
    const src = key ? pumlByKey.get(key) : null;
    if (!src) return;
    dlText(`${safeBaseName()}-${safeKey(key)}.plantuml`, src, 'text/plain;charset=utf-8');
    return;
  }

  if (action === 'puml-dl') {
    const key = btn.dataset.key;
    const src = key ? pumlByKey.get(key) : null;
    if (!src) return;
    dlText(`${safeBaseName()}-${safeKey(key)}.plantuml`, src, 'text/plain;charset=utf-8');
    return;
  }
}

/* --------------------------------- Export -------------------------------- */
function safeBaseName() {
  if (sourceMode === 'zip' && file && file.name) {
    const raw = String(file.name);
    const noExt = raw.replace(/\.[^.]+$/, '');
    return noExt.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'diagramix-uml';
  }

  const raw = projectLabel || repoUrl || 'diagramix-uml';
  return String(raw)
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/+$/g, '')
    .replace(/[^\w\-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'diagramix-uml';
}

function safeKey(k) {
  return String(k || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'item';
}

function dlText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  dlBlob(filename, blob);
}

function dlBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function dlPlantUML() {
  if (!result) return;
  dlText(`${safeBaseName()}.plantuml`, String(result.plantUml || ''), 'text/plain;charset=utf-8');
}

async function krokiRender(format, puml) {
  const url = `${API}/api/render/${format}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: puml
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Render HTTP ${res.status}`);
  }
  return res.blob();
}

function copyAll() {
  if (!result) return;
  const txt = String(result.plantUml || '');
  return navigator.clipboard.writeText(txt).then(() => {
    const btn = document.querySelector('[data-action="copy-all"]');
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  });
}

/* --------------------------------- PlantUML ------------------------------- */
function pumlForPreview(puml) {
  // Preview style: white background (does not change the downloadable source).
  const src = String(puml || '');
  const lines = src.split('\n');
  const out = [];
  let injected = false;

  for (const line of lines) {
    if (line.startsWith('skinparam')) continue;
    if (!injected && line.startsWith('@startuml')) {
      injected = true;
      out.push('@startuml');
      out.push('skinparam backgroundColor white');
      out.push('skinparam classBackgroundColor white');
      out.push('skinparam classBorderColor #111111');
      out.push('skinparam classFontColor #111111');
      out.push('skinparam classArrowColor #111111');
      out.push('skinparam shadowing false');
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

function buildScopedPlantUml(fullPuml, classes, opts) {
  const includeRelations = (opts && opts.includeRelations) ? opts.includeRelations : 'internal'; // internal | touching
  const all = String(fullPuml || '');
  const classList = Array.isArray(classes) ? classes : [];
  const names = new Set(classList.map((c) => String(c.name || '')).filter(Boolean));

  const out = [];
  out.push('@startuml');
  extractSkinparams(all).forEach((l) => out.push(l));
  out.push('');

  classList.forEach((c) => {
    const kw = c.type === 'interface' ? 'interface' : c.type === 'enum' ? 'enum' : 'class';
    const block = extractClassBlock(all, kw, c.name);
    if (block) out.push(block, '');
  });

  const rels = all.split('\n').filter(relLine);
  const scopedRels = rels.filter((l) => {
    const pr = parseRelLine(l);
    if (!pr) return false;
    if (includeRelations === 'touching') return names.has(pr.a) || names.has(pr.b);
    return names.has(pr.a) && names.has(pr.b);
  });
  if (scopedRels.length) out.push(...scopedRels, '');

  out.push('@enduml');
  return out.join('\n').trim() + '\n';
}

function extractSkinparams(puml) {
  return String(puml || '').split('\n').filter((l) => l.startsWith('skinparam'));
}

function extractClassBlock(puml, kw, name) {
  const safeName = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`${kw}\\s+${safeName}\\s*\\{`);
  const m = startRe.exec(puml);
  if (!m) return null;

  let depth = 0;
  let i = m.index;
  while (i < puml.length) {
    const ch = puml[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return puml.slice(m.index, i + 1);
    }
    i++;
  }
  return null;
}

function relLine(l) {
  return String(l || '').includes('<|--') || String(l || '').includes('<|..') || String(l || '').includes('..>');
}

function parseRelLine(line) {
  const m = String(line || '').trim().match(/^([A-Za-z_][\w$]*)\s+(<\|--|<\|\.\.|\.\.>)\s+([A-Za-z_][\w$]*)\s*$/);
  if (!m) return null;
  return { a: m[1], op: m[2], b: m[3] };
}

/* --------------------------------- Helpers -------------------------------- */
function asyncPool(limit, items, iterFn) {
  const q = items.slice();
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (q.length) {
      const it = q.shift();
      try { await iterFn(it); } catch {}
    }
  });
  return Promise.all(workers);
}

function hl(code) {
  return String(code || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@(startuml|enduml)/g, '<span class="kw">@$1</span>')
    .replace(/\b(class|interface|enum|abstract|extends|implements|skinparam|package)\b/g, '<span class="kw">$1</span>')
    .replace(/(<\|--|<\|\.\.|\.\.|\.\.>|--)/g, '<span class="rl">$1</span>')
    .replace(/'[^\n]*/g, '<span class="cm">$&</span>');
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssEsc(s) {
  // Minimal CSS esc for attribute selectors.
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function dirOf(p) {
  const path = normPath(p);
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : '.';
}

function parseGithubRepoUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return null;
  }

  const host = String(u.hostname || '').toLowerCase();
  if (u.protocol !== 'https:') return null;
  if (host !== 'github.com' && host !== 'www.github.com') return null;

  const parts = String(u.pathname || '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = String(parts[1]).replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;

  return { host: 'github.com', display: `${owner}/${repo}` };
}

function vc(v) {
  return v === '+' ? 'vp' : v === '#' ? 'vo' : v === '-' ? 'vi' : 'vk';
}

function relIcon(k) {
  return k === 'extends' ? '^' : k === 'implements' ? '=>' : '->';
}

function typeIcon(t) {
  return { class: 'C', interface: 'I', struct: 'S', enum: 'E' }[t] || 'C';
}

function err(m) {
  const b = document.getElementById('errBox');
  b.textContent = String(m || '');
  b.classList.add('show');
}

function clearErr() {
  document.getElementById('errBox').classList.remove('show');
}
