// ─── Config ─────────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const DPR = Math.min(window.devicePixelRatio || 1, 2);

// ─── State ───────────────────────────────────────────────────────────────────
let PDF       = null;   // pdfjsLib document
let curPage   = 1;
let scale     = 1.2;
let rot       = 0;
let fileBytes = null;   // Uint8Array kept in memory for saving

// Per-page metadata: pageNum → { wrap, canvas, textDiv, rendered }
const pages   = new Map();
// Active render tasks: pageNum → RenderTask
const tasks   = new Map();
let iObs      = null;   // Page rendering observer
let activeObs = null;   // Active page tracking observer

// Search
let matches   = [];
let matchIdx  = -1;
let searchQ   = '';
let searchTimer = null;

// ─── Button enable/disable ───────────────────────────────────────────────────
const BTN_IDS = ['first','prev','next','last','zout','zin','fit','rot'];
function setEnabled(on) {
  BTN_IDS.forEach(k => {
    ['d-'+k,'m-'+k].forEach(id => { const b=document.getElementById(id); if(b) b.disabled=!on; });
  });
  ['d-pg','m-pg'].forEach(id => { const b=document.getElementById(id); if(b) b.disabled=!on; });
}

// ─── File input / drag-drop ──────────────────────────────────────────────────
document.getElementById('file-in').addEventListener('change', e => {
  if (e.target.files[0]) loadPDF(e.target.files[0]);
  e.target.value = '';
});

const uploadZone = document.getElementById('upload-zone');
const stage      = document.querySelector('.stage');

[uploadZone, stage].forEach(el => {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', e => {
    e.preventDefault(); el.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f && f.type === 'application/pdf') { loadPDF(f); closeSidebar(); }
    else showToast('Please drop a PDF file');
  });
});

// ─── Save file (no navigation — pure JS blob) ────────────────────────────────
function saveFile() {
  if (!fileBytes) return;
  const blob = new Blob([fileBytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (document.getElementById('f-name').textContent || 'document') + '.pdf';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a brief delay
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Load PDF ────────────────────────────────────────────────────────────────
function loadPDF(file) {
  setProgress(0);
  showLoading(true);

  document.getElementById('upload-zone').style.display = 'none';
  document.getElementById('file-info').style.display   = 'flex';
  document.getElementById('f-name').textContent = file.name;
  document.getElementById('f-meta').textContent = (file.size / 1048576).toFixed(2) + ' MB';
  document.getElementById('h-file').textContent = file.name.replace(/\.pdf$/i, '');

  setProgress(20);

  const reader = new FileReader();
  reader.onload = ev => {
    fileBytes = new Uint8Array(ev.target.result);

    // Show save button now that we have the bytes
    document.getElementById('dl-btn').style.display = 'block';

    setProgress(45);

    pdfjsLib.getDocument({ data: fileBytes }).promise.then(async doc => {
      PDF     = doc;
      curPage = 1;
      rot     = 0;

      // Fit-width scale based on first page
      const p1 = await doc.getPage(1);
      const v1 = p1.getViewport({ scale: 1, rotation: 0 });
      const availW = document.getElementById('scroll-area').clientWidth - 40;
      scale = Math.min(1.6, Math.max(0.5, availW / v1.width));

      setProgress(65);

      // Update UI counters
      const tot = doc.numPages;
      ['d-tot','m-tot'].forEach(id => document.getElementById(id).textContent = '/ ' + tot);
      ['d-pg','m-pg'].forEach(id => { const e=document.getElementById(id); e.max=tot; e.value=1; });
      document.getElementById('i-pages').textContent = tot;
      document.getElementById('doc-info').style.display  = 'block';
      document.getElementById('thumbs-card').style.display = 'flex';
      document.getElementById('empty').style.display    = 'none';

      updateZoom();
      setEnabled(true);

      setProgress(80);

      // Build page placeholders then render
      await buildPlaceholders();
      setupObservers();
      generateThumbs();

      setProgress(100);
      showLoading(false);
      setTimeout(() => setProgress(0), 600);

    }).catch(err => {
      showLoading(false);
      showToast('Could not open PDF — is it password-protected?');
      console.error(err);
    });
  };
  reader.readAsArrayBuffer(file);
}

// ─── Build empty page wrappers ────────────────────────────────────────────────
async function buildPlaceholders() {
  // Tear down previous state
  tasks.forEach(t => { try { t.cancel(); } catch(_){} });
  tasks.clear();
  pages.clear();
  if (iObs) { iObs.disconnect(); iObs = null; }
  if (activeObs) { activeObs.disconnect(); activeObs = null; }

  const container = document.getElementById('pages');
  container.innerHTML = '';

  for (let i = 1; i <= PDF.numPages; i++) {
    const page = await PDF.getPage(i);
    const vp   = page.getViewport({ scale, rotation: rot });
    const W    = Math.ceil(vp.width);
    const H    = Math.ceil(vp.height);

    const wrap = document.createElement('div');
    wrap.className = 'pw';
    wrap.dataset.page = i;
    wrap.style.width  = W + 'px';
    wrap.style.height = H + 'px';

    const canvas = document.createElement('canvas');
    canvas.width  = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    wrap.appendChild(canvas);

    // Text layer (makes text selectable)
    const textDiv = document.createElement('div');
    textDiv.className = 'tl';
    textDiv.style.cssText = `width:${W}px;height:${H}px`;
    wrap.appendChild(textDiv);

    // Page number badge
    const badge = document.createElement('div');
    badge.className = 'pg-badge';
    badge.textContent = i + ' / ' + PDF.numPages;
    wrap.appendChild(badge);

    container.appendChild(wrap);
    pages.set(i, { wrap, canvas, textDiv, page, rendered: false });
  }
}

// ─── Render a single page onto its canvas ────────────────────────────────────
async function renderPage(num) {
  const entry = pages.get(num);
  if (!entry) return;

  // Cancel any in-flight render for this page
  if (tasks.has(num)) { try { tasks.get(num).cancel(); } catch(_){} tasks.delete(num); }

  const { wrap, canvas, textDiv, page } = entry;
  const vp  = page.getViewport({ scale, rotation: rot });
  const W   = Math.ceil(vp.width);
  const H   = Math.ceil(vp.height);

  // Resize canvas for current scale
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  wrap.style.width  = W + 'px';
  wrap.style.height = H + 'px';
  textDiv.style.width  = W + 'px';
  textDiv.style.height = H + 'px';

  // PDF.js renders at scale*DPR for crispness on retina displays
  const hiVp = page.getViewport({ scale: scale * DPR, rotation: rot });
  const ctx  = canvas.getContext('2d');

  const task = page.render({ canvasContext: ctx, viewport: hiVp });
  tasks.set(num, task);

  try {
    await task.promise;
    tasks.delete(num);
    entry.rendered = true;

    // ── Render selectable text layer ─────────────────────────────────────────
    textDiv.innerHTML = '';
    const textContent = await page.getTextContent();
    // renderTextLayer uses the CSS-scale viewport so text positions match the canvas
    const textTask = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textDiv,
      viewport: vp,
      textDivs: [],
    });
    await textTask.promise;

    // Re-apply any active search highlights
    if (searchQ) highlightPage(num, searchQ);

  } catch(err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('Render error p'+num, err);
  }
}

// ─── Observers — lazy-render and active page tracking ────────────────────────
function setupObservers() {
  const root = document.getElementById('scroll-area');
  
  // 1. Rendering Observer (Lazy-load pages)
  iObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const num = parseInt(entry.target.dataset.page);
      if (!pages.get(num)?.rendered) renderPage(num);
      // Pre-render immediate neighbours
      [num - 1, num + 1].forEach(n => {
        if (n >= 1 && n <= PDF.numPages && !pages.get(n)?.rendered)
          setTimeout(() => renderPage(n), 100);
      });
    });
  }, { root, rootMargin: '400px 0px', threshold: 0 });

  // 2. Active Page Observer (Track scroll position efficiently)
  activeObs = new IntersectionObserver(entries => {
    let bestEntry = null;
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio) {
          bestEntry = entry;
        }
      }
    });
    if (bestEntry) {
      const num = parseInt(bestEntry.target.dataset.page);
      if (num !== curPage) {
        curPage = num;
        syncPageUI();
      }
    }
  }, { root, threshold: [0, 0.2, 0.5, 0.8, 1.0] });

  pages.forEach(({ wrap }) => {
    iObs.observe(wrap);
    activeObs.observe(wrap);
  });
}

// ─── Re-render everything after zoom / rotate ─────────────────────────────────
async function rerenderAll() {
  tasks.forEach(t => { try { t.cancel(); } catch(_){} });
  tasks.clear();

  // Invalidate rendered state and resize placeholders immediately
  for (const [num, entry] of pages) {
    entry.rendered = false;
    entry.textDiv.innerHTML = '';
    const vp = entry.page.getViewport({ scale, rotation: rot });
    const W  = Math.ceil(vp.width), H = Math.ceil(vp.height);
    entry.wrap.style.width  = W + 'px';
    entry.wrap.style.height = H + 'px';
    entry.canvas.style.width  = W + 'px';
    entry.canvas.style.height = H + 'px';
    entry.textDiv.style.width  = W + 'px';
    entry.textDiv.style.height = H + 'px';
  }

  updateZoom();

  // Re-observe so the observer fires again for now-visible pages
  if (iObs) {
    iObs.disconnect();
    activeObs.disconnect();
    pages.forEach(({ wrap }) => {
      iObs.observe(wrap);
      activeObs.observe(wrap);
    });
  }
}

// ─── Thumbnails ───────────────────────────────────────────────────────────────
function generateThumbs() {
  const container = document.getElementById('thumbs');
  container.innerHTML = '';
  const TSCALE = 0.22;

  // Use IntersectionObserver to lazy-render thumbnails
  const tObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const num = parseInt(entry.target.dataset.page);
      const canvas = entry.target.querySelector('canvas');
      if (canvas.dataset.rendered) return;

      PDF.getPage(num).then(page => {
        const vp = page.getViewport({ scale: TSCALE * DPR });
        canvas.width  = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        canvas.style.width  = Math.ceil(vp.width  / DPR) + 'px';
        canvas.style.height = Math.ceil(vp.height / DPR) + 'px';
        page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(() => {
          canvas.dataset.rendered = 'true';
        });
      });
    });
  }, { root: container, rootMargin: '100px 0px' });

  for (let i = 1; i <= PDF.numPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb' + (i === 1 ? ' active' : '');
    item.dataset.page = i;
    item.onclick = () => { scrollToPage(i); closeSidebar(); };

    const imgWrap = document.createElement('div'); imgWrap.className = 'thumb-img';
    const tc = document.createElement('canvas'); imgWrap.appendChild(tc);
    const lbl = document.createElement('div');
    lbl.className = 'thumb-lbl'; lbl.textContent = 'p.' + i;

    item.appendChild(imgWrap); item.appendChild(lbl);
    container.appendChild(item);
    tObs.observe(item);
  }
}

function refreshThumbs() {
  document.querySelectorAll('.thumb').forEach(el =>
    el.classList.toggle('active', parseInt(el.dataset.page) === curPage));
  const active = document.querySelector('.thumb.active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function scrollToPage(num) {
  const entry = pages.get(num);
  if (!entry) return;
  entry.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  curPage = num;
  syncPageUI();
}

// Touch swipe
const scrollArea = document.getElementById('scroll-area');
let swipeX = 0;
scrollArea.addEventListener('touchstart', e => { swipeX = e.touches[0].clientX; }, { passive: true });
scrollArea.addEventListener('touchend', e => {
  if (!PDF) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  if (Math.abs(dx) > 70 && scrollArea.scrollLeft === 0)
    scrollToPage(Math.max(1, Math.min(PDF.numPages, curPage + (dx < 0 ? 1 : -1))));
}, { passive: true });

function syncPageUI() {
  ['d-pg','m-pg'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = curPage;
  });
  document.getElementById('i-cur').textContent = curPage;
  refreshThumbs();
}


// Page input boxes
['d-pg','m-pg'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && PDF) {
      const v = parseInt(el.value);
      if (v >= 1 && v <= PDF.numPages) scrollToPage(v);
      else el.value = curPage;
    }
  });
  el.addEventListener('blur', () => { if (PDF) el.value = curPage; });
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (!PDF || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowDown'  || e.key === 'PageDown') scrollToPage(Math.min(PDF.numPages, curPage + 1));
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') scrollToPage(Math.max(1, curPage - 1));
  else if (e.key === '+' || e.key === '=') zoom(0.15);
  else if (e.key === '-')                 zoom(-0.15);
  else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('d-s').focus();
    document.getElementById('d-s').select();
  }
});

function turn(d)    { if (PDF) scrollToPage(Math.max(1, Math.min(PDF.numPages, curPage + d))); }
function goTo(n)    { if (PDF) scrollToPage(n); }
function goToLast() { if (PDF) scrollToPage(PDF.numPages); }

function zoom(d) {
  if (!PDF) return;
  scale = Math.max(0.3, Math.min(4.5, scale + d));
  rerenderAll();
}

function fitW() {
  if (!PDF) return;
  const entry = pages.get(curPage);
  if (!entry) return;
  const base = entry.page.getViewport({ scale: 1, rotation: rot });
  scale = Math.max(0.3, (scrollArea.clientWidth - 40) / base.width);
  rerenderAll();
}

function rotatePdf() {
  if (!PDF) return;
  rot = (rot + 90) % 360;
  rerenderAll();
}

function updateZoom() {
  const pct = Math.round(scale * 100) + '%';
  ['d-zm','m-zm'].forEach(id => document.getElementById(id).textContent = pct);
  document.getElementById('i-zoom').textContent = pct;
}

// ─── Search ───────────────────────────────────────────────────────────────────
// Wire both desktop and mobile search inputs together
function wireSearch(inId, cntId, prevId, nextId, clrId) {
  const inp = document.getElementById(inId);
  const cnt = document.getElementById(cntId);
  inp.addEventListener('input', () => {
    // Keep both inputs in sync
    const mirror = inId === 'd-s' ? 'm-s' : 'd-s';
    document.getElementById(mirror).value = inp.value;
    scheduleSearch(inp.value.trim());
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.shiftKey ? prevMatch() : nextMatch(); }
    if (e.key === 'Escape') { clearSearch(); inp.value = ''; document.getElementById(inId==='d-s'?'m-s':'d-s').value=''; inp.blur(); }
  });
  document.getElementById(prevId).addEventListener('click', prevMatch);
  document.getElementById(nextId).addEventListener('click', nextMatch);
  document.getElementById(clrId).addEventListener('click', () => {
    clearSearch();
    ['d-s','m-s'].forEach(id => document.getElementById(id).value = '');
  });
}
wireSearch('d-s','d-cnt','d-sp','d-sn','d-sx');
wireSearch('m-s','m-cnt','m-sp','m-sn','m-sx');

async function scheduleSearch(q) {
  clearTimeout(searchTimer);
  clearHighlights();
  matches = []; matchIdx = -1; searchQ = '';
  updateSearchCount();
  if (!q || q.length < 2 || !PDF) return;
  searchTimer = setTimeout(() => runSearch(q), 280);
}

async function runSearch(q) {
  searchQ = q;
  const lq = q.toLowerCase();
  const found = [];

  for (let i = 1; i <= PDF.numPages; i++) {
    const page  = await PDF.getPage(i);
    const tc    = await page.getTextContent();
    const text  = tc.items.map(it => it.str).join('');
    const lower = text.toLowerCase();
    let idx = 0;
    while ((idx = lower.indexOf(lq, idx)) !== -1) {
      found.push({ pageNum: i, idx, len: lq.length });
      idx += lq.length;
    }
  }

  matches  = found;
  matchIdx = found.length ? 0 : -1;
  updateSearchCount();

  if (found.length) {
    // Highlight all pages that have a match, but only rendered ones immediately
    pages.forEach((_, num) => highlightPage(num, q));
    jumpToMatch(0);
  }
}

// Apply highlight spans inside the text layer of a given page
function highlightPage(num, q) {
  const entry = pages.get(num);
  if (!entry || !entry.rendered) return;
  const { textDiv } = entry;
  const lq = q.toLowerCase();

  // Clear old highlights
  textDiv.querySelectorAll('.hl').forEach(el => el.classList.remove('hl','cur'));

  const spans = Array.from(textDiv.querySelectorAll('span'));
  let flat = '', map = [];
  spans.forEach(s => {
    map.push({ s, start: flat.length });
    flat += s.textContent;
  });

  const lflat = flat.toLowerCase();
  // Find all match positions within this page's flat text
  const pageMatches = matches
    .filter(m => m.pageNum === num)
    .map(m => {
      // re-search locally to get char position within page text
      return { idx: lflat.indexOf(lq), len: lq.length };
    })
    .filter(m => m.idx !== -1);

  // Mark all matching spans
  let localIdx = lflat.indexOf(lq);
  while (localIdx !== -1) {
    const end = localIdx + lq.length;
    map.forEach(({ s, start }) => {
      const spanEnd = start + s.textContent.length;
      if (start < end && spanEnd > localIdx) s.classList.add('hl');
    });
    localIdx = lflat.indexOf(lq, localIdx + 1);
  }
}

function clearHighlights() {
  pages.forEach(({ textDiv }) =>
    textDiv.querySelectorAll('.hl').forEach(el => el.classList.remove('hl','cur')));
}

function jumpToMatch(idx) {
  if (!matches.length) return;
  matchIdx = ((idx % matches.length) + matches.length) % matches.length;
  const m  = matches[matchIdx];

  // Scroll to the page
  const entry = pages.get(m.pageNum);
  if (entry) entry.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Mark current highlight
  pages.forEach(({ textDiv }, num) => {
    textDiv.querySelectorAll('.hl').forEach((el, i) => {
      el.classList.toggle('cur', num === m.pageNum && i === 0);
    });
  });

  updateSearchCount();
}

function nextMatch() { if (matches.length) jumpToMatch(matchIdx + 1); }
function prevMatch() { if (matches.length) jumpToMatch(matchIdx - 1); }
function clearSearch() {
  clearHighlights();
  matches = []; matchIdx = -1; searchQ = '';
  updateSearchCount();
}
function updateSearchCount() {
  const txt = matches.length
    ? (matchIdx + 1) + ' / ' + matches.length
    : (document.getElementById('d-s').value.length > 1 ? '0 results' : '');
  ['d-cnt','m-cnt'].forEach(id => document.getElementById(id).textContent = txt);
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('backdrop').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('backdrop').classList.remove('open');
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
function setProgress(pct) { document.getElementById('prog').style.width = pct + '%'; }
function showLoading(on)  { document.getElementById('loading').style.display = on ? 'flex' : 'none'; }

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
