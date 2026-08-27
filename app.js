/* Tilly's Panel & Cut List Calculator
   Real 2D guillotine bin-packing optimizer (multi stock-size aware for particleboard),
   pooled cutting-labor cost with flat-fee floor, per-finished-size cost rollup,
   and a separate purchaser-facing order summary.
*/

// ---------- Data model ----------

// Stock sheets are sold 1" oversize vs. their nominal call-out (e.g. "4x8" ships as a true 49"x97"
// raw panel). rawW/rawH are the true purchased dimensions; w/h stay the nominal name used for
// pricing labels and the cutting-cost sq-ft basis.
// NOTE: defaultCost is intentionally 0 for every stock — real costs never ship in this public
// source file. They live only in Cloudflare KV (via the pricing sync Worker) and are pulled in
// after login, then cached in this browser via loadPricingFromCloud().
// Every catalog entry carries a stable `id` — that's the real key used everywhere internally
// (quantities, product codes, sample-load lookups). `name`/`w`/`h` are just the current display
// values and are fully editable in the UI without breaking anything else, since nothing else is
// keyed off them.
const MATERIALS = {
  pb: {
    key: 'pb', name: 'Particleboard 3/4"',
    stocks: [
      { key: '4x8',  label: '4x8 (48"x96")',   w: 48, h: 96,  rawW: 49, rawH: 97,  defaultCost: 0 },
      { key: '5x12', label: '5x12 (60"x144")', w: 60, h: 144, rawW: 61, rawH: 145, defaultCost: 0 },
    ],
    catalog: [
      { id: 'pb_0', name: '12" x 48"', w: 12, h: 48 },
      { id: 'pb_1', name: '12" x 72"', w: 12, h: 72 },
      { id: 'pb_2', name: '15" x 48"', w: 15, h: 48 },
      { id: 'pb_3', name: '15" x 72"', w: 15, h: 72 },
      { id: 'pb_4', name: '24" x 48"', w: 24, h: 48 },
      { id: 'pb_5', name: '24" x 72"', w: 24, h: 72 },
      { id: 'pb_6', name: '30" x 72"', w: 30, h: 72 },
    ],
    sample: { pb_2: 12, pb_3: 84, pb_4: 24, pb_5: 90, pb_6: 24 },
  },
  whiteMel: {
    key: 'whiteMel', name: 'White Melamine 3/4"',
    stocks: [ { key: '4x8', label: '4x8 (48"x96")', w: 48, h: 96, rawW: 49, rawH: 97, defaultCost: 0 } ],
    catalog: [ { id: 'whiteMel_0', name: '24" x 72"', w: 24, h: 72 } ],
    sample: { whiteMel_0: 8 },
  },
  blackMel: {
    key: 'blackMel', name: 'Black Melamine 3/4"',
    stocks: [ { key: '5x8', label: '5x8 (60"x96")', w: 60, h: 96, rawW: 61, rawH: 97, defaultCost: 0 } ],
    catalog: [ { id: 'blackMel_0', name: '28" x 96"', w: 28, h: 96 } ],
    sample: { blackMel_0: 0 },
  },
};

// ---------- Guillotine packer ----------

function tryPlaceOnSheet(sheet, piece, kerf, allowRotate) {
  let best = null;
  for (let i = 0; i < sheet.freeRects.length; i++) {
    const r = sheet.freeRects[i];
    const opts = [{ w: piece.w + kerf, h: piece.h + kerf, rot: false }];
    if (allowRotate) opts.push({ w: piece.h + kerf, h: piece.w + kerf, rot: true });
    for (const opt of opts) {
      if (opt.w <= r.w + 1e-9 && opt.h <= r.h + 1e-9) {
        const waste = r.w * r.h - opt.w * opt.h;
        if (!best || waste < best.waste) {
          best = { rectIndex: i, w: opt.w, h: opt.h, rot: opt.rot, waste, x: r.x, y: r.y };
        }
      }
    }
  }
  if (!best) return false;
  const r = sheet.freeRects[best.rectIndex];
  sheet.placements.push({ x: r.x, y: r.y, w: best.w - kerf, h: best.h - kerf, rot: best.rot, label: piece.label, catKey: piece.catKey });
  const usedW = best.w, usedH = best.h;
  const leftoverW = r.w - usedW, leftoverH = r.h - usedH;
  sheet.freeRects.splice(best.rectIndex, 1);
  if (leftoverW < leftoverH) {
    if (leftoverH > 1e-6) sheet.freeRects.push({ x: r.x, y: r.y + usedH, w: r.w, h: leftoverH });
    if (leftoverW > 1e-6) sheet.freeRects.push({ x: r.x + usedW, y: r.y, w: leftoverW, h: usedH });
  } else {
    if (leftoverW > 1e-6) sheet.freeRects.push({ x: r.x + usedW, y: r.y, w: leftoverW, h: r.h });
    if (leftoverH > 1e-6) sheet.freeRects.push({ x: r.x, y: r.y + usedH, w: r.w, h: leftoverH });
  }
  return true;
}

// Greedily fill a fresh, empty sheet of the given stock type with as many of the supplied
// pieces as fit (in order). Used both to actually open sheets and to "test drive" a stock
// type before committing to it.
function simulateFillSheet(remainingPieces, stockType, kerf, allowRotate) {
  const sheet = { netW: stockType.netW, netH: stockType.netH, freeRects: [{ x: 0, y: 0, w: stockType.netW, h: stockType.netH }], placements: [] };
  const consumed = [];
  for (const piece of remainingPieces) {
    if (tryPlaceOnSheet(sheet, piece, kerf, allowRotate)) consumed.push(piece);
  }
  return { sheet, consumed };
}

// stockTypes: array of {key,label,netW,netH,nominalW,nominalH,costPerSheet}. When more than one
// stock type is available (particleboard), every time a new sheet is needed we simulate filling
// a fresh sheet of EACH candidate type with the actual remaining piece queue and open whichever
// one yields the lowest cost per sq ft actually used — so the job can genuinely mix sheet sizes
// (e.g. mostly 5x12 with a 4x8 for the small leftover tail) instead of committing to one size
// for the whole job.
function packAllSheets(pieces, stockTypes, kerf, allowRotate) {
  const sorted = pieces.slice().sort((a, b) => {
    const minA = Math.min(a.w, a.h), minB = Math.min(b.w, b.h);
    if (minB !== minA) return minB - minA;
    return Math.max(b.w, b.h) - Math.max(a.w, a.h);
  });
  const sheets = [];
  const unplaced = [];
  const placedSet = new Set();

  for (let idx = 0; idx < sorted.length; idx++) {
    const piece = sorted[idx];
    if (placedSet.has(piece)) continue;

    let placed = false;
    for (const sheet of sheets) {
      if (tryPlaceOnSheet(sheet, piece, kerf, allowRotate)) { placed = true; placedSet.add(piece); break; }
    }
    if (placed) continue;

    const remainingBatch = [];
    for (let j = idx; j < sorted.length; j++) if (!placedSet.has(sorted[j])) remainingBatch.push(sorted[j]);

    let best = null;
    for (const st of stockTypes) {
      const fitsNormal = piece.w <= st.netW + 1e-9 && piece.h <= st.netH + 1e-9;
      const fitsRot = allowRotate && piece.h <= st.netW + 1e-9 && piece.w <= st.netH + 1e-9;
      if (!fitsNormal && !fitsRot) continue;
      const { sheet: sim, consumed } = simulateFillSheet(remainingBatch, st, kerf, allowRotate);
      const filledArea = sim.placements.reduce((s, p) => s + p.w * p.h, 0);
      const costPerFilledSqft = filledArea > 0 ? st.costPerSheet / filledArea : Infinity;
      if (!best || costPerFilledSqft < best.costPerFilledSqft) {
        best = { st, sim, consumed, costPerFilledSqft };
      }
    }
    if (!best) { unplaced.push(piece); continue; }

    sheets.push({
      stockKey: best.st.key, stockLabel: best.st.label,
      netW: best.st.netW, netH: best.st.netH,
      nominalW: best.st.nominalW, nominalH: best.st.nominalH,
      costPerSheet: best.st.costPerSheet,
      freeRects: best.sim.freeRects, placements: best.sim.placements,
    });
    for (const p of best.consumed) placedSet.add(p);
  }
  return { sheets, unplaced };
}

function totalCost(sheets) { return sheets.reduce((s, sh) => s + sh.costPerSheet, 0); }

// ---------- App state ----------

const state = {
  qty: {},         // catKey(matKey,id) -> quantity
  stockCost: {},   // stockCostKey (e.g. 'pb:4x8') -> $ per sheet
  stockCode: {},   // stockCostKey -> product/SKU code for that stock sheet
  catalogItems: { pb: [], whiteMel: [], blackMel: [] }, // matKey -> [{id,name,w,h,code,builtin}]
};

function catKey(matKey, id) { return matKey + '::' + id; }
function stockCostKey(matKey, stockKey) { return matKey + ':' + stockKey; }

function makeCustomId(matKey) {
  return matKey + '_c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Names/codes here routinely contain a literal " (inches), which breaks a value="..." HTML
// attribute built via template string — escape before interpolating into any innerHTML.
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function initState() {
  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    for (const st of mat.stocks) {
      state.stockCost[stockCostKey(matKey, st.key)] = st.defaultCost;
      state.stockCode[stockCostKey(matKey, st.key)] = '';
    }
    state.catalogItems[matKey] = mat.catalog.map((c) => ({
      id: c.id, name: c.name, w: c.w, h: c.h, code: '', builtin: true,
    }));
    for (const c of mat.catalog) {
      state.qty[catKey(matKey, c.id)] = 0;
    }
  }
}

// ---------- UI: Pricing panel ----------

// Auto-save pricing (stock costs + settings) to the cloud shortly after the user stops
// editing — fixes costs silently reverting because nobody remembered to click the manual
// save button. Debounced so we don't fire a save on every keystroke.
let autoSaveTimer = null;
function scheduleAutoSave() {
  if (!getAuthKey()) return; // not logged in yet (e.g. still on the lock screen) — nothing to save to
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => { savePricingToCloud(); }, 900);
}

function renderStockCostGrid() {
  const host = document.getElementById('stockCostGrid');
  host.innerHTML = '';
  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    for (const st of mat.stocks) {
      const sck = stockCostKey(matKey, st.key);
      const div = document.createElement('div');
      div.className = 'field';
      div.innerHTML = `
        <label>${mat.name} — ${st.label}</label>
        <input type="number" step="0.01" placeholder="Cost / sheet" id="stockcost_${sck}" value="${state.stockCost[sck]}">
        <input type="text" placeholder="Product code" id="stockcode_${sck}" value="${escapeAttr(state.stockCode[sck])}" style="margin-top:6px;font-family:var(--font-mono)">`;
      host.appendChild(div);
      div.querySelector('#stockcost_' + CSS.escape(sck)).addEventListener('input', (e) => {
        state.stockCost[sck] = parseFloat(e.target.value) || 0;
        scheduleAutoSave();
      });
      div.querySelector('#stockcode_' + CSS.escape(sck)).addEventListener('input', (e) => {
        state.stockCode[sck] = e.target.value;
        scheduleAutoSave();
      });
    }
  }
}

function wireSettingsAutoSave() {
  const ids = ['squaring', 'kerf', 'allowRotate', 'cutPerSqft', 'cutFlat', 'cutThreshold', 'bumpMult', 'sellDivisor'];
  for (const id of ids) {
    const el = document.getElementById(id);
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, scheduleAutoSave);
  }
}

document.getElementById('pricingToggle').addEventListener('click', () => {
  const body = document.getElementById('pricingBody');
  const toggle = document.getElementById('pricingToggle');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  toggle.classList.toggle('open', !open);
});

// ---------- UI: Catalog / job input ----------

function renderCatalog() {
  const host = document.getElementById('catalogHost');
  host.innerHTML = '';
  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    const block = document.createElement('div');
    block.className = 'material-block';
    const allowedStocks = mat.stocks.map(s => s.label).join(' or ');
    block.innerHTML = `<h3>${mat.name}</h3><div class="meta">Cut from: ${allowedStocks}</div>`;
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
      <th>Name</th><th style="width:70px">W (in)</th><th style="width:70px">L (in)</th>
      <th style="width:110px">Product code</th><th style="width:90px">Qty needed</th><th style="width:36px"></th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    block.appendChild(table);

    for (const entry of state.catalogItems[matKey]) {
      const k = catKey(matKey, entry.id);
      if (!(k in state.qty)) state.qty[k] = 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="text" value="${escapeAttr(entry.name)}"></td>
        <td><input type="number" class="dim-input" step="0.0625" min="0.1" value="${entry.w}"></td>
        <td><input type="number" class="dim-input" step="0.0625" min="0.1" value="${entry.h}"></td>
        <td><input type="text" style="font-family:var(--font-mono)" value="${escapeAttr(entry.code)}"></td>
        <td><input type="number" class="qty-input" min="0" step="1" value="${state.qty[k]}"></td>
        <td>${!entry.builtin ? '<button class="btn-ghost" title="Remove">&times;</button>' : ''}</td>`;
      const [nameInput, wInput, hInput, codeInput, qtyInput] = tr.querySelectorAll('input');
      nameInput.addEventListener('input', (e) => { entry.name = e.target.value; scheduleAutoSave(); });
      wInput.addEventListener('input', (e) => { entry.w = parseFloat(e.target.value) || 0; scheduleAutoSave(); });
      hInput.addEventListener('input', (e) => { entry.h = parseFloat(e.target.value) || 0; scheduleAutoSave(); });
      codeInput.addEventListener('input', (e) => { entry.code = e.target.value; scheduleAutoSave(); });
      qtyInput.addEventListener('input', (e) => { state.qty[k] = parseInt(e.target.value) || 0; });
      if (!entry.builtin) {
        tr.querySelector('button').addEventListener('click', () => {
          state.catalogItems[matKey] = state.catalogItems[matKey].filter(c => c !== entry);
          delete state.qty[k];
          scheduleAutoSave();
          renderCatalog();
        });
      }
      tbody.appendChild(tr);
    }

    const addRowDiv = document.createElement('div');
    addRowDiv.style.cssText = 'display:flex;gap:8px;margin-top:10px;align-items:flex-end';
    addRowDiv.innerHTML = `
      <div class="field" style="flex:0 0 90px;margin-bottom:0"><label>Width (in)</label><input type="number" class="dim-input" step="0.0625" min="0.1">
      </div>
      <div class="field" style="flex:0 0 90px;margin-bottom:0"><label>Length (in)</label><input type="number" class="dim-input" step="0.0625" min="0.1"></div>
      <button class="btn-secondary">+ Add size</button>`;
    const [wInput, hInput] = addRowDiv.querySelectorAll('input');
    addRowDiv.querySelector('button').addEventListener('click', () => {
      const w = parseFloat(wInput.value), h = parseFloat(hInput.value);
      if (!w || !h) return;
      const id = makeCustomId(matKey);
      state.catalogItems[matKey].push({ id, name: `${w}" x ${h}"`, w, h, code: '', builtin: false });
      state.qty[catKey(matKey, id)] = 0;
      scheduleAutoSave();
      renderCatalog();
    });
    block.appendChild(addRowDiv);

    host.appendChild(block);
  }
}

// ---------- Saved requests (cloud-synced, same KV store as pricing) ----------
// Used to live in localStorage only, which meant a request saved on one device never showed up
// on another. Now mirrors the pricing sync pattern: an in-memory cache populated from the cloud
// at boot, and every save/delete pushes the whole list back up so every device sees it.

let savedRequestsCache = [];

function getSavedRequests() {
  return savedRequestsCache;
}
function setSavedRequests(list) {
  savedRequestsCache = list;
  pushSavedRequestsToCloud(list);
}

function renderSavedRequests() {
  const host = document.getElementById('savedRequestsList');
  const saved = getSavedRequests();
  if (!saved.length) { host.innerHTML = '<div class="small">No saved requests yet.</div>'; return; }
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr><th>Name</th><th>Saved</th><th style="width:170px"></th></tr></thead>`;
  const tbody = document.createElement('tbody');
  saved.slice().reverse().forEach((req) => {
    const tr = document.createElement('tr');
    const dateStr = new Date(req.savedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    tr.innerHTML = `<td>${req.name}</td><td class="small">${dateStr}</td><td></td>`;
    const actionsTd = tr.querySelector('td:last-child');
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn-secondary';
    loadBtn.textContent = 'Load';
    loadBtn.style.marginRight = '6px';
    loadBtn.addEventListener('click', () => {
      state.qty = Object.assign({}, req.qty);
      if (req.catalogItems) state.catalogItems = JSON.parse(JSON.stringify(req.catalogItems));
      renderCatalog();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-ghost';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      const remaining = getSavedRequests().filter(r => r.id !== req.id);
      setSavedRequests(remaining);
      renderSavedRequests();
    });
    actionsTd.appendChild(loadBtn);
    actionsTd.appendChild(delBtn);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.innerHTML = '';
  host.appendChild(table);
}

document.getElementById('saveRequestBtn').addEventListener('click', () => {
  const nameInput = document.getElementById('saveNameInput');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  const saved = getSavedRequests();
  saved.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name,
    savedAt: Date.now(),
    qty: Object.assign({}, state.qty),
    catalogItems: JSON.parse(JSON.stringify(state.catalogItems)),
  });
  setSavedRequests(saved);
  nameInput.value = '';
  renderSavedRequests();
});

document.getElementById('loadSampleBtn').addEventListener('click', () => {
  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    for (const id in mat.sample) state.qty[catKey(matKey, id)] = mat.sample[id];
  }
  renderCatalog();
});
document.getElementById('clearQtyBtn').addEventListener('click', () => {
  for (const k in state.qty) state.qty[k] = 0;
  renderCatalog();
});

// ---------- Optimize & cost engine ----------

function getSettings() {
  return {
    squaring: parseFloat(document.getElementById('squaring').value) || 0,
    kerf: parseFloat(document.getElementById('kerf').value) || 0,
    allowRotate: document.getElementById('allowRotate').value === '1',
    cutPerSqft: parseFloat(document.getElementById('cutPerSqft').value) || 0,
    cutFlat: parseFloat(document.getElementById('cutFlat').value) || 0,
    cutThreshold: parseFloat(document.getElementById('cutThreshold').value) || 0,
    bumpMult: parseFloat(document.getElementById('bumpMult').value) || 1,
    sellDivisor: parseFloat(document.getElementById('sellDivisor').value) || 1,
  };
}

function runOptimization() {
  const settings = getSettings();
  const results = {}; // matKey -> { sheets, unplaced, totalMaterialCost, totalGoodSqFt, sheetSqFtUsed, perSize: {id: {name,code,qty,sqftEach,goodSqft}} }

  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    const stockTypes = mat.stocks.map(st => ({
      key: st.key, label: st.label, code: state.stockCode[stockCostKey(matKey, st.key)] || '',
      netW: st.rawW - settings.squaring * 2, netH: st.rawH - settings.squaring * 2,
      nominalW: st.w, nominalH: st.h,
      costPerSheet: state.stockCost[stockCostKey(matKey, st.key)] || 0,
    }));

    const pieces = [];
    const perSize = {};
    for (const entry of state.catalogItems[matKey]) {
      const qty = state.qty[catKey(matKey, entry.id)] || 0;
      const sqftEach = (entry.w * entry.h) / 144;
      perSize[entry.id] = { name: entry.name, code: entry.code, qty, sqftEach, w: entry.w, h: entry.h, goodSqft: qty * sqftEach };
      for (let i = 0; i < qty; i++) pieces.push({ w: entry.w, h: entry.h, label: entry.name, catKey: entry.id });
    }

    const { sheets, unplaced } = packAllSheets(pieces, stockTypes, settings.kerf, settings.allowRotate);
    const totalMaterialCost = totalCost(sheets);
    const totalGoodSqFt = pieces.reduce((s, p) => s + (p.w * p.h) / 144, 0);
    const sheetSqFtUsed = sheets.reduce((s, sh) => s + (sh.nominalW * sh.nominalH) / 144, 0);

    const sheetCounts = {};
    for (const sh of sheets) sheetCounts[sh.stockKey] = (sheetCounts[sh.stockKey] || 0) + 1;

    results[matKey] = { sheets, unplaced, totalMaterialCost, totalGoodSqFt, sheetSqFtUsed, perSize, sheetCounts, stockTypes };
  }

  const totalSheetSqFtAll = Object.values(results).reduce((s, r) => s + r.sheetSqFtUsed, 0);
  const cuttingCostTotal = totalSheetSqFtAll <= settings.cutThreshold
    ? (totalSheetSqFtAll > 0 ? settings.cutFlat : 0)
    : totalSheetSqFtAll * settings.cutPerSqft;

  for (const matKey in results) {
    const r = results[matKey];
    r.cuttingCostShare = totalSheetSqFtAll > 0 ? cuttingCostTotal * (r.sheetSqFtUsed / totalSheetSqFtAll) : 0;
    r.materialCostPerSqFt = r.totalGoodSqFt > 0 ? r.totalMaterialCost / r.totalGoodSqFt : 0;
    r.cuttingCostPerSqFt = r.totalGoodSqFt > 0 ? r.cuttingCostShare / r.totalGoodSqFt : 0;
    r.combinedCostPerSqFt = r.materialCostPerSqFt + r.cuttingCostPerSqFt;
  }

  return { results, settings, totalSheetSqFtAll, cuttingCostTotal };
}

// ---------- Rendering: results ----------

function fmt$(n) { return '$' + (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtNum(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }

function drawSheet(canvas, sheet) {
  const pad = 4;
  const maxDim = 150;
  const scale = Math.min((maxDim - pad * 2) / sheet.netW, (maxDim - pad * 2) / sheet.netH);
  canvas.width = sheet.netW * scale + pad * 2;
  canvas.height = sheet.netH * scale + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0c0d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#2a2d2f';
  ctx.strokeRect(pad, pad, sheet.netW * scale, sheet.netH * scale);
  const colors = ['#00e5b8', '#d4a800', '#5da8ff', '#ff8fa3', '#b48cff', '#7fe08a', '#ffb877'];
  const labelColorIdx = {};
  let ci = 0;
  for (const p of sheet.placements) {
    if (!(p.label in labelColorIdx)) labelColorIdx[p.label] = ci++ % colors.length;
    ctx.fillStyle = colors[labelColorIdx[p.label]];
    ctx.globalAlpha = 0.85;
    ctx.fillRect(pad + p.x * scale, pad + p.y * scale, p.w * scale, p.h * scale);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f1112';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + p.x * scale, pad + p.y * scale, p.w * scale, p.h * scale);
  }
}

function renderResults(opt) {
  const host = document.getElementById('resultsHost');
  host.innerHTML = '';
  const { results, settings, totalSheetSqFtAll, cuttingCostTotal } = opt;

  // Overview card
  const overview = document.createElement('div');
  overview.className = 'card';
  overview.innerHTML = `<h2>Cutting Labor (Pooled)</h2><div class="sub">Billed on full sheets used across particleboard + white melamine + black melamine combined.</div>`;
  const cuttingTierNote = totalSheetSqFtAll <= settings.cutThreshold
    ? `At or under ${fmtNum(settings.cutThreshold,0)} sq ft &rarr; flat charge applies`
    : `Over ${fmtNum(settings.cutThreshold,0)} sq ft &rarr; ${fmtNum(settings.cutPerSqft,3)}/sq ft applies`;
  overview.innerHTML += `
    <div class="stat-row">
      <div class="stat"><div class="v">${fmtNum(totalSheetSqFtAll,0)}</div><div class="l">Total Sheet Sq Ft</div></div>
      <div class="stat"><div class="v">${fmt$(cuttingCostTotal)}</div><div class="l">Total Cutting Cost</div></div>
    </div>
    <div class="small">${cuttingTierNote}</div>`;
  host.appendChild(overview);

  let unplacedWarnings = [];

  for (const matKey in results) {
    const r = results[matKey];
    const mat = MATERIALS[matKey];
    if (r.unplaced.length) unplacedWarnings.push(`${mat.name}: ${r.unplaced.length} piece(s) too large for any available stock sheet.`);

    const card = document.createElement('div');
    card.className = 'card';
    let sheetCountStr = Object.entries(r.sheetCounts).map(([k, c]) => `${c} x ${k}`).join(', ') || 'none needed';
    card.innerHTML = `
      <h2>${mat.name}</h2>
      <div class="stat-row">
        <div class="stat"><div class="v">${r.sheets.length}</div><div class="l">Sheets Used</div></div>
        <div class="stat"><div class="v">${fmtNum(r.totalGoodSqFt,1)}</div><div class="l">Good Sq Ft</div></div>
        <div class="stat"><div class="v">${fmt$(r.totalMaterialCost)}</div><div class="l">Material Cost</div></div>
        <div class="stat"><div class="v">${fmt$(r.cuttingCostShare)}</div><div class="l">Cutting Cost Share</div></div>
      </div>
      <div class="small">Sheets: ${sheetCountStr}</div>
    `;

    if (r.sheets.length) {
      const canvasRow = document.createElement('div');
      canvasRow.className = 'sheet-canvas-row';
      r.sheets.forEach((sh, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'sheet-canvas-wrap';
        const canvas = document.createElement('canvas');
        wrap.appendChild(canvas);
        const cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = `#${i + 1} ${sh.stockKey}`;
        wrap.appendChild(cap);
        canvasRow.appendChild(wrap);
        drawSheet(canvas, sh);
      });
      card.appendChild(canvasRow);
    }

    // Per-size cost table
    const table = document.createElement('table');
    table.style.marginTop = '14px';
    table.innerHTML = `<thead><tr>
      <th>Finished Size</th><th>Code</th><th class="right">Qty</th><th class="right">Actual Cost / Panel</th>
      <th class="right">Cost With Bump</th><th class="right">Ideal Sell</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const id in r.perSize) {
      const p = r.perSize[id];
      const actualCost = p.qty > 0 ? r.combinedCostPerSqFt * p.sqftEach : 0;
      const bump = actualCost * settings.bumpMult;
      const sell = bump / settings.sellDivisor;
      const tr = document.createElement('tr');
      if (p.qty === 0) tr.style.opacity = '0.5';
      tr.innerHTML = `<td>${p.name}</td><td class="tag">${p.code || '—'}</td><td class="right">${p.qty}</td>
        <td class="right money">${fmt$(actualCost)}</td>
        <td class="right money">${fmt$(bump)}</td>
        <td class="right money">${fmt$(sell)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    card.appendChild(table);

    host.appendChild(card);
  }

  if (unplacedWarnings.length) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.innerHTML = unplacedWarnings.join('<br>');
    host.insertBefore(warn, host.firstChild);
  }
}

// ---------- Rendering: purchaser order + internal reference ----------

function buildSheetLines(results) {
  const lines = [];
  let grandMaterial = 0;
  for (const matKey in results) {
    const r = results[matKey];
    const mat = MATERIALS[matKey];
    for (const st of r.stockTypes) {
      const count = r.sheetCounts[st.key] || 0;
      if (count === 0) continue;
      const lineTotal = count * st.costPerSheet;
      grandMaterial += lineTotal;
      lines.push({ matKey, stockKey: st.key, matName: mat.name, stockLabel: st.label, code: st.code || '', count, costPerSheet: st.costPerSheet, lineTotal });
    }
  }
  return { lines, grandMaterial };
}

function renderPurchaser(opt) {
  const host = document.getElementById('purchaserHost');
  host.innerHTML = '';
  const { results, settings, cuttingCostTotal } = opt;
  const { lines, grandMaterial } = buildSheetLines(results);

  // Consolidated finished-size line items (across all materials).
  const itemLines = [];
  for (const matKey in results) {
    const r = results[matKey];
    const mat = MATERIALS[matKey];
    for (const id in r.perSize) {
      const p = r.perSize[id];
      if (p.qty <= 0) continue;
      const actualCost = r.combinedCostPerSqFt * p.sqftEach;
      const bump = actualCost * settings.bumpMult;
      itemLines.push({ matName: mat.name, size: p.name, code: p.code || '', qty: p.qty, actualCost, bump });
    }
  }
  const totalActualExt = itemLines.reduce((s, l) => s + l.actualCost * l.qty, 0);
  const totalBumpExt = itemLines.reduce((s, l) => s + l.bump * l.qty, 0);
  const grandTotal = grandMaterial + cuttingCostTotal;

  // One combined card — finished parts, then the stock sheets to order, then totals.
  // Everything here is meant to go to the purchaser (send via Copy for Email / Print / Export to Excel).
  const purchaserCard = document.createElement('div');
  purchaserCard.className = 'purchaser-card';
  purchaserCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
      <div><h2>Purchaser Order</h2><div class="sub">Send this to your purchaser.</div></div>
      <div class="po-actions">
        <button class="btn-secondary" id="copyPurchaserBtn">Copy for Email</button>
        <button class="btn-secondary" id="exportExcelBtn">Export to Excel</button>
        <button class="btn-secondary" id="printPurchaserBtn">Print</button>
        <span class="copy-flash" id="copyFlash"></span>
      </div>
    </div>`;

  const pTable = document.createElement('table');
  pTable.style.marginTop = '14px';
  pTable.innerHTML = `<thead><tr><th>Material</th><th>Finished Size</th><th>Code</th><th class="right">Qty</th><th class="right">Actual Cost</th><th class="right">Cost With Bump</th></tr></thead>`;
  const pTbody = document.createElement('tbody');
  for (const l of itemLines) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.matName}</td><td>${l.size}</td><td class="code-cell">${l.code || '—'}</td><td class="right">${l.qty}</td><td class="right money">${fmt$(l.actualCost)}</td><td class="right money">${fmt$(l.bump)}</td>`;
    pTbody.appendChild(tr);
  }
  pTable.appendChild(pTbody);
  purchaserCard.appendChild(pTable);

  const pTotals = document.createElement('div');
  pTotals.className = 'stat-row';
  pTotals.style.marginTop = '14px';
  pTotals.innerHTML = `
    <div class="stat"><div class="v">${fmt$(totalActualExt)}</div><div class="l">Total Actual Cost</div></div>
    <div class="stat"><div class="v">${fmt$(totalBumpExt)}</div><div class="l">Total Cost With Bump</div></div>
  `;
  purchaserCard.appendChild(pTotals);

  const iLabel = document.createElement('h3');
  iLabel.className = 'section-label';
  iLabel.style.marginTop = '22px';
  iLabel.textContent = 'Stock Sheets To Order';
  purchaserCard.appendChild(iLabel);

  const iTable = document.createElement('table');
  iTable.innerHTML = `<thead><tr><th>Material</th><th>Stock Sheet</th><th>Code</th><th class="right">Qty</th><th class="right">Cost / Sheet</th><th class="right">Line Total</th></tr></thead>`;
  const iTbody = document.createElement('tbody');
  for (const l of lines) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.matName}</td><td>${l.stockLabel}</td><td class="code-cell">${l.code || '—'}</td><td class="right">${l.count}</td><td class="right money">${fmt$(l.costPerSheet)}</td><td class="right money">${fmt$(l.lineTotal)}</td>`;
    iTbody.appendChild(tr);
  }
  iTable.appendChild(iTbody);
  purchaserCard.appendChild(iTable);

  const iTotals = document.createElement('div');
  iTotals.className = 'stat-row';
  iTotals.style.marginTop = '14px';
  iTotals.innerHTML = `
    <div class="stat"><div class="v">${fmt$(grandMaterial)}</div><div class="l">Total Material Cost</div></div>
    <div class="stat"><div class="v">${fmt$(cuttingCostTotal)}</div><div class="l">Total Cutting Cost</div></div>
    <div class="stat"><div class="v">${fmt$(grandTotal)}</div><div class="l">Grand Total</div></div>
  `;
  purchaserCard.appendChild(iTotals);

  host.appendChild(purchaserCard);

  document.getElementById('printPurchaserBtn').addEventListener('click', () => window.print());
  document.getElementById('copyPurchaserBtn').addEventListener('click', () => {
    copyPurchaserScreenshot();
  });
  document.getElementById('exportExcelBtn').addEventListener('click', () => {
    exportPurchaseOrderExcel(itemLines, lines);
  });
}

// Takes an actual screenshot of the rendered Purchaser Order card (via html2canvas) and puts the
// PNG on the clipboard — pasting into an email shows a real picture of the app, not reformatted text.
function copyPurchaserScreenshot() {
  const flash = document.getElementById('copyFlash');
  const showFlash = (msg) => { flash.textContent = msg; setTimeout(() => { flash.textContent = ''; }, 2000); };

  if (typeof html2canvas === 'undefined') {
    showFlash('Screenshot library did not load');
    return;
  }
  const card = document.querySelector('.purchaser-card');
  if (!card) return;

  // Hide the button row itself so the screenshot is just the data, not the buttons that made it.
  const actions = card.querySelector('.po-actions');
  const prevVisibility = actions ? actions.style.visibility : null;
  if (actions) actions.style.visibility = 'hidden';

  const bg = getComputedStyle(card).backgroundColor || '#1a1d21';

  html2canvas(card, { backgroundColor: bg, scale: 2 }).then((canvas) => {
    if (actions) actions.style.visibility = prevVisibility || '';
    canvas.toBlob((blob) => {
      if (!blob) { showFlash('Screenshot failed'); return; }
      if (window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          .then(() => showFlash('Copied!'))
          .catch(() => {
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            showFlash('Opened image — save it manually');
          });
      } else {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        showFlash('Opened image — save it manually');
      }
    }, 'image/png');
  }).catch(() => {
    if (actions) actions.style.visibility = prevVisibility || '';
    showFlash('Screenshot failed');
  });
}

// Generates a .xlsx matching Tilly's own "IN PROCESS MATERIAL" PO form (same header fields,
// same SOURCE MATERIAL / FINISHED PRODUCTS layout and column order) filled in from the current
// job, ready to send straight to the purchaser. Vendor/Salesman/Customer stay fixed per Heath —
// only the date and the two part tables change per job.
const MATERIAL_LOWER_NAME = { pb: 'particle board', whiteMel: 'white melamine', blackMel: 'black melamine' };

function stockItemDescription(matKey, stockKey) {
  const mat = MATERIALS[matKey];
  const thicknessMatch = mat.name.match(/[\d/]+"/);
  const thickness = thicknessMatch ? thicknessMatch[0].replace('"', '') : '';
  const lowerName = MATERIAL_LOWER_NAME[matKey] || mat.name.toLowerCase();
  return `${thickness} ${stockKey} ${lowerName}`.trim();
}

// Recreates Tilly's actual paper PO form (Tillys 08-2026.xls) cell-for-cell: same header block,
// same two bordered tables (SOURCE MATERIAL / FINISHED PRODUCTS) in the same columns, same
// Arial 9/10pt fonts. Row numbers below match the real form's row numbers 1:1 when there are 9 or
// fewer line items per table (the form's own layout) and grow gracefully past that.
async function exportPurchaseOrderExcel(itemLines, sheetLines) {
  if (typeof ExcelJS === 'undefined') { alert('Excel export library did not load — check your connection and try again.'); return; }
  const dateStr = new Date().toLocaleDateString('en-US');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PO');
  ws.columns = [
    { width: 4.4 }, { width: 37.7 }, { width: 4.4 }, { width: 9 }, { width: 5.1 },
    { width: 16.6 }, { width: 12.7 }, { width: 11.1 },
  ];

  const fontLabel = { name: 'Arial', size: 10 };
  const fontHeader = { name: 'Arial', size: 9 };
  const thin = { style: 'thin' };
  const underline = { bottom: thin };
  const center = { horizontal: 'center', vertical: 'middle' };
  const centerWrap = { horizontal: 'center', vertical: 'middle', wrapText: true };

  const set = (addr, value, opts = {}) => {
    const cell = ws.getCell(addr);
    cell.value = value;
    cell.font = opts.font || fontLabel;
    if (opts.border) cell.border = opts.border;
    if (opts.align) cell.alignment = opts.align;
    return cell;
  };
  // Full thin-line grid over a rectangular region — reproduces the form's bordered table look.
  const gridBorder = (rowStart, rowEnd, colStart, colEnd) => {
    for (let r = rowStart; r <= rowEnd; r++) {
      for (let c = colStart; c <= colEnd; c++) {
        ws.getCell(r, c).border = { top: thin, bottom: thin, left: thin, right: thin };
      }
    }
  };

  set('B1', 'IN PROCESS MATERIAL');

  set('B3', ' VENDOR   Chapman', { border: underline });
  set('F3', 'WORK ORDER NO.', { border: underline });

  set('B5', 'NEXT P.O. # /ORDER #   ', { border: underline });
  set('F5', 'P.O. NO.    ', { border: underline });

  set('B7', 'TRANSFER # ', { border: underline });
  set('F7', 'SALESMAN ', { border: underline });
  set('G7', 'Heath', { border: underline });

  set('B9', "CUSTOMER #  TIL005 (our stock)  Tilly's", { border: underline });
  set('F9', 'DATE          ', { border: underline });
  set('G9', dateStr, { border: underline });

  set('B11', 'SOURCE MATERIAL');
  set('F11', 'CUSTOMER P.O.', { border: underline });

  // ---- Source Material table (rows 13+) ----
  let r = 13;
  const srcHeaderRow = r;
  ws.mergeCells(`C${r}:E${r}`);
  set(`B${r}`, 'ITEM DESCRIPTION', { font: fontHeader, align: centerWrap });
  set(`C${r}`, "TAG #'S /SKUS STOCK/BUYOUT P.O.", { font: fontHeader, align: centerWrap });
  set(`F${r}`, 'QTY SHPD TO VENDOR', { font: fontHeader, align: centerWrap });
  set(`G${r}`, 'DATE SHIPPED', { font: fontHeader, align: centerWrap });
  set(`H${r}`, 'BALANCE', { font: fontHeader, align: centerWrap });
  ws.getRow(r).height = 28;
  r++;
  const srcRowCount = Math.max(sheetLines.length, 9);
  for (let i = 0; i < srcRowCount; i++) {
    const l = sheetLines[i];
    ws.mergeCells(`C${r}:E${r}`);
    set(`B${r}`, l ? stockItemDescription(l.matKey, l.stockKey) : '', { align: center });
    set(`C${r}`, l ? (l.code || '') : '', { align: center });
    set(`F${r}`, l ? l.count : '', { align: center });
    r++;
  }
  gridBorder(srcHeaderRow, r - 1, 2, 8);

  r += 2;
  set(`B${r}`, 'FINISHED PRODUCTS');
  r += 2;

  // ---- Finished Products table ----
  const finHeaderRow = r;
  ws.mergeCells(`B${r}:C${r}`);
  ws.mergeCells(`D${r}:E${r}`);
  set(`B${r}`, 'NEW ITEM DESCRIPTION', { font: fontHeader, align: centerWrap });
  set(`D${r}`, "QTY OF NEW ITEM REC'D", { font: fontHeader, align: centerWrap });
  set(`F${r}`, "DATE REC'D", { font: fontHeader, align: centerWrap });
  set(`G${r}`, 'ADD ON COSTS', { font: fontHeader, align: centerWrap });
  set(`H${r}`, 'BALANCE', { font: fontHeader, align: centerWrap });
  ws.getRow(r).height = 28;
  r++;
  const finRowCount = Math.max(itemLines.length, 9);
  for (let i = 0; i < finRowCount; i++) {
    const l = itemLines[i];
    ws.mergeCells(`B${r}:C${r}`);
    ws.mergeCells(`D${r}:E${r}`);
    set(`B${r}`, l ? (l.code || l.size) : '', { align: center });
    set(`D${r}`, l ? l.qty : '', { align: center });
    r++;
  }
  gridBorder(finHeaderRow, r - 1, 2, 8);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Tillys_PO_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Wire up ----------

document.getElementById('optimizeBtn').addEventListener('click', () => {
  const status = document.getElementById('optimizeStatus');
  status.textContent = 'Optimizing...';
  setTimeout(() => {
    const opt = runOptimization();
    renderResults(opt);
    renderPurchaser(opt);
    status.textContent = 'Done.';
    setTimeout(() => { status.textContent = ''; }, 1500);
  }, 10);
});

// ---------- Auth + cloud pricing sync ----------

// Custom domain (not the shared *.workers.dev one) — some corporate networks blanket-block
// Cloudflare's shared workers.dev wildcard as generic/uncategorized cloud infra.
const WORKER_BASE = 'https://tillys.cutlistiq.pro';
const AUTH_STORAGE_KEY = 'tillys_auth_key';

function getAuthKey() { try { return localStorage.getItem(AUTH_STORAGE_KEY); } catch (e) { return null; } }
function setAuthKey(k) { try { localStorage.setItem(AUTH_STORAGE_KEY, k); } catch (e) {} }
function clearAuthKey() { try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {} }

function showLockScreen() {
  document.getElementById('lockScreen').style.display = 'flex';
  document.getElementById('appRoot').style.display = 'none';
}
function hideLockScreen() {
  document.getElementById('lockScreen').style.display = 'none';
  document.getElementById('appRoot').style.display = 'block';
}

async function attemptLogin(password) {
  const errEl = document.getElementById('lockError');
  errEl.textContent = '';
  try {
    const res = await fetch(WORKER_BASE + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (data.ok) { setAuthKey(data.key); return true; }
    errEl.textContent = 'Incorrect password.';
    return false;
  } catch (e) {
    errEl.textContent = 'Could not reach server — check your connection.';
    return false;
  }
}

async function fetchPricingFromCloud() {
  const key = getAuthKey();
  if (!key) return null;
  try {
    const res = await fetch(WORKER_BASE + '/pricing', { headers: { 'X-Tillys-Key': key } });
    if (res.status === 401) { clearAuthKey(); showLockScreen(); return null; }
    return await res.json();
  } catch (e) { return null; }
}

async function savePricingToCloud() {
  const key = getAuthKey();
  if (!key) return;
  const statusEl = document.getElementById('pricingSyncStatus');
  statusEl.textContent = 'Saving...';
  try {
    const payload = { stockCost: state.stockCost, stockCode: state.stockCode, catalogItems: state.catalogItems, settings: getSettings() };
    const res = await fetch(WORKER_BASE + '/pricing', {
      method: 'PUT', headers: { 'X-Tillys-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) { clearAuthKey(); showLockScreen(); return; }
    statusEl.textContent = 'Saved — synced to all your devices.';
  } catch (e) {
    statusEl.textContent = 'Save failed — check your connection.';
  }
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

async function fetchSavedRequestsFromCloud() {
  const key = getAuthKey();
  if (!key) return [];
  try {
    const res = await fetch(WORKER_BASE + '/requests', { headers: { 'X-Tillys-Key': key } });
    if (res.status === 401) { clearAuthKey(); showLockScreen(); return []; }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

async function pushSavedRequestsToCloud(list) {
  const key = getAuthKey();
  if (!key) return;
  const statusEl = document.getElementById('requestSyncStatus');
  if (statusEl) statusEl.textContent = 'Saving...';
  try {
    const res = await fetch(WORKER_BASE + '/requests', {
      method: 'PUT', headers: { 'X-Tillys-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(list),
    });
    if (res.status === 401) { clearAuthKey(); showLockScreen(); return; }
    if (statusEl) statusEl.textContent = 'Synced to all your devices.';
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Saved on this device only — sync failed, check your connection.';
  }
  if (statusEl) setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

function applyPricingToUI(pricing) {
  if (!pricing) return;
  if (pricing.stockCost) {
    for (const k in pricing.stockCost) state.stockCost[k] = pricing.stockCost[k];
  }
  if (pricing.stockCode) {
    for (const k in pricing.stockCode) state.stockCode[k] = pricing.stockCode[k];
  }
  if (pricing.catalogItems) {
    for (const matKey in pricing.catalogItems) {
      if (!state.catalogItems[matKey]) continue;
      state.catalogItems[matKey] = pricing.catalogItems[matKey];
      // qty is job-specific and not synced — make sure every restored item still has a qty slot
      for (const entry of state.catalogItems[matKey]) {
        const k = catKey(matKey, entry.id);
        if (!(k in state.qty)) state.qty[k] = 0;
      }
    }
  }
  if (pricing.settings) {
    const s = pricing.settings;
    const setVal = (id, v) => { if (v !== undefined && v !== null) document.getElementById(id).value = v; };
    setVal('squaring', s.squaring);
    setVal('kerf', s.kerf);
    if (s.allowRotate !== undefined) document.getElementById('allowRotate').value = s.allowRotate ? '1' : '0';
    setVal('cutPerSqft', s.cutPerSqft);
    setVal('cutFlat', s.cutFlat);
    setVal('cutThreshold', s.cutThreshold);
    setVal('bumpMult', s.bumpMult);
    setVal('sellDivisor', s.sellDivisor);
  }
}

async function bootApp() {
  initState();
  renderStockCostGrid();
  renderCatalog();
  document.getElementById('savedRequestsList').innerHTML = '<div class="small">Loading...</div>';
  const [pricing, requests] = await Promise.all([fetchPricingFromCloud(), fetchSavedRequestsFromCloud()]);
  if (pricing) {
    applyPricingToUI(pricing);
    renderStockCostGrid();
    renderCatalog();
  }
  savedRequestsCache = requests;
  renderSavedRequests();
}

document.getElementById('lockSubmit').addEventListener('click', async () => {
  const pwInput = document.getElementById('lockPw');
  const pw = pwInput.value;
  if (!pw) return;
  const ok = await attemptLogin(pw);
  if (ok) { pwInput.value = ''; hideLockScreen(); bootApp(); }
});
document.getElementById('lockPw').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('lockSubmit').click();
});
document.getElementById('savePricingBtn').addEventListener('click', savePricingToCloud);

document.getElementById('pwToggle').addEventListener('click', () => {
  const body = document.getElementById('pwBody');
  const toggle = document.getElementById('pwToggle');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  toggle.classList.toggle('open', !open);
});

document.getElementById('pwSubmitBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('pwStatus');
  const currentInput = document.getElementById('pwCurrent');
  const newInput = document.getElementById('pwNew');
  const confirmInput = document.getElementById('pwConfirm');
  const current = currentInput.value, next = newInput.value, confirmVal = confirmInput.value;

  const fail = (msg) => { statusEl.textContent = msg; statusEl.style.color = 'var(--danger)'; };
  if (!current || !next || !confirmVal) return fail('Fill in all three fields.');
  if (next !== confirmVal) return fail('New passwords do not match.');
  if (next.length < 6) return fail('New password must be at least 6 characters.');

  statusEl.style.color = 'var(--mid)';
  statusEl.textContent = 'Verifying current password...';
  const currentOk = await attemptLogin(current);
  if (!currentOk) return fail('Current password is incorrect.');

  statusEl.textContent = 'Updating...';
  try {
    const res = await fetch(WORKER_BASE + '/change-password', {
      method: 'POST',
      headers: { 'X-Tillys-Key': getAuthKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: next }),
    });
    const data = await res.json();
    if (data.ok) {
      setAuthKey(data.key);
      statusEl.style.color = 'var(--teal)';
      statusEl.textContent = 'Password updated. Use the new one next time you log in on another device.';
      currentInput.value = ''; newInput.value = ''; confirmInput.value = '';
    } else {
      fail(data.error || 'Could not update password.');
    }
  } catch (e) {
    fail('Network error — try again.');
  }
});

wireSettingsAutoSave();

(async function boot() {
  if (getAuthKey()) { hideLockScreen(); await bootApp(); }
  else { showLockScreen(); }
})();
