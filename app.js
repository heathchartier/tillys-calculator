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
const MATERIALS = {
  pb: {
    key: 'pb', name: 'Particleboard 3/4"',
    stocks: [
      { key: '4x8',  label: '4x8 (48"x96")',   w: 48, h: 96,  rawW: 49, rawH: 97,  defaultCost: 0 },
      { key: '5x12', label: '5x12 (60"x144")', w: 60, h: 144, rawW: 61, rawH: 145, defaultCost: 0 },
    ],
    catalog: [
      { name: '12" x 48"', w: 12, h: 48 },
      { name: '12" x 72"', w: 12, h: 72 },
      { name: '15" x 48"', w: 15, h: 48 },
      { name: '15" x 72"', w: 15, h: 72 },
      { name: '24" x 48"', w: 24, h: 48 },
      { name: '24" x 72"', w: 24, h: 72 },
      { name: '30" x 72"', w: 30, h: 72 },
    ],
    sample: { '12" x 48"': 0, '12" x 72"': 0, '15" x 48"': 12, '15" x 72"': 84, '24" x 48"': 24, '24" x 72"': 90, '30" x 72"': 24 },
  },
  whiteMel: {
    key: 'whiteMel', name: 'White Melamine 3/4"',
    stocks: [ { key: '4x8', label: '4x8 (48"x96")', w: 48, h: 96, rawW: 49, rawH: 97, defaultCost: 0 } ],
    catalog: [ { name: '24" x 72"', w: 24, h: 72 } ],
    sample: { '24" x 72"': 8 },
  },
  blackMel: {
    key: 'blackMel', name: 'Black Melamine 3/4"',
    stocks: [ { key: '5x8', label: '5x8 (60"x96")', w: 60, h: 96, rawW: 61, rawH: 97, defaultCost: 0 } ],
    catalog: [ { name: '28" x 96"', w: 28, h: 96 } ],
    sample: { '28" x 96"': 0 },
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
  qty: {},       // catKey -> quantity
  stockCost: {}, // stockKey (e.g. 'pb:4x8') -> $ per sheet
  customSizes: { pb: [], whiteMel: [], blackMel: [] },
};

function catKey(matKey, name) { return matKey + '::' + name; }
function stockCostKey(matKey, stockKey) { return matKey + ':' + stockKey; }

function initState() {
  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    for (const st of mat.stocks) {
      state.stockCost[stockCostKey(matKey, st.key)] = st.defaultCost;
    }
    for (const c of mat.catalog) {
      state.qty[catKey(matKey, c.name)] = 0;
    }
  }
}

function allCatalogEntries(matKey) {
  return MATERIALS[matKey].catalog.concat(state.customSizes[matKey]);
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
      const div = document.createElement('div');
      div.className = 'field';
      const id = 'stockcost_' + stockCostKey(matKey, st.key);
      div.innerHTML = `<label>${mat.name} — ${st.label}</label><input type="number" step="0.01" id="${id}" value="${state.stockCost[stockCostKey(matKey, st.key)]}">`;
      host.appendChild(div);
      div.querySelector('input').addEventListener('input', (e) => {
        state.stockCost[stockCostKey(matKey, st.key)] = parseFloat(e.target.value) || 0;
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
    table.innerHTML = `<thead><tr><th>Finished size</th><th style="width:110px">Qty needed</th><th style="width:40px"></th></tr></thead>`;
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    block.appendChild(table);

    function addRow(entry, removable) {
      const tr = document.createElement('tr');
      const k = catKey(matKey, entry.name);
      if (!(k in state.qty)) state.qty[k] = 0;
      tr.innerHTML = `
        <td>${entry.name} <span class="tag">(${entry.w}" x ${entry.h}")</span></td>
        <td><input type="number" class="qty-input" min="0" step="1" value="${state.qty[k]}"></td>
        <td>${removable ? '<button class="btn-ghost" title="Remove">&times;</button>' : ''}</td>`;
      const qtyInput = tr.querySelector('input');
      qtyInput.addEventListener('input', (e) => { state.qty[k] = parseInt(e.target.value) || 0; });
      if (removable) {
        tr.querySelector('button').addEventListener('click', () => {
          state.customSizes[matKey] = state.customSizes[matKey].filter(c => c !== entry);
          delete state.qty[k];
          renderCatalog();
        });
      }
      tbody.appendChild(tr);
    }

    for (const entry of mat.catalog) addRow(entry, false);
    for (const entry of state.customSizes[matKey]) addRow(entry, true);

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
      const name = `${w}" x ${h}" (custom)`;
      state.customSizes[matKey].push({ name, w, h });
      renderCatalog();
    });
    block.appendChild(addRowDiv);

    host.appendChild(block);
  }
}

// ---------- Saved requests (localStorage) ----------

const SAVED_REQUESTS_KEY = 'tillys_saved_requests';

function getSavedRequests() {
  try { return JSON.parse(localStorage.getItem(SAVED_REQUESTS_KEY)) || []; }
  catch (e) { return []; }
}
function setSavedRequests(list) {
  try { localStorage.setItem(SAVED_REQUESTS_KEY, JSON.stringify(list)); } catch (e) {}
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
      state.customSizes = JSON.parse(JSON.stringify(req.customSizes || { pb: [], whiteMel: [], blackMel: [] }));
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
    customSizes: JSON.parse(JSON.stringify(state.customSizes)),
  });
  setSavedRequests(saved);
  nameInput.value = '';
  renderSavedRequests();
});

document.getElementById('loadSampleBtn').addEventListener('click', () => {
  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    for (const name in mat.sample) state.qty[catKey(matKey, name)] = mat.sample[name];
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
  const results = {}; // matKey -> { sheets, unplaced, totalMaterialCost, totalGoodSqFt, sheetSqFtUsed, perSize: {name: {qty,sqftEach,goodSqft}} }

  for (const matKey in MATERIALS) {
    const mat = MATERIALS[matKey];
    const stockTypes = mat.stocks.map(st => ({
      key: st.key, label: st.label,
      netW: st.rawW - settings.squaring * 2, netH: st.rawH - settings.squaring * 2,
      nominalW: st.w, nominalH: st.h,
      costPerSheet: state.stockCost[stockCostKey(matKey, st.key)] || 0,
    }));

    const pieces = [];
    const perSize = {};
    for (const entry of allCatalogEntries(matKey)) {
      const qty = state.qty[catKey(matKey, entry.name)] || 0;
      const sqftEach = (entry.w * entry.h) / 144;
      perSize[entry.name] = { qty, sqftEach, w: entry.w, h: entry.h, goodSqft: qty * sqftEach };
      for (let i = 0; i < qty; i++) pieces.push({ w: entry.w, h: entry.h, label: entry.name, catKey: entry.name });
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
      <th>Finished Size</th><th class="right">Qty</th><th class="right">Actual Cost / Panel</th>
      <th class="right">Cost With Bump</th><th class="right">Ideal Sell</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const name in r.perSize) {
      const p = r.perSize[name];
      const actualCost = p.qty > 0 ? r.combinedCostPerSqFt * p.sqftEach : 0;
      const bump = actualCost * settings.bumpMult;
      const sell = bump / settings.sellDivisor;
      const tr = document.createElement('tr');
      if (p.qty === 0) tr.style.opacity = '0.5';
      tr.innerHTML = `<td>${name}</td><td class="right">${p.qty}</td>
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
      lines.push({ matName: mat.name, stockLabel: st.label, count, costPerSheet: st.costPerSheet, lineTotal });
    }
  }
  return { lines, grandMaterial };
}

function renderPurchaser(opt) {
  const host = document.getElementById('purchaserHost');
  host.innerHTML = '';
  const { results, settings, cuttingCostTotal } = opt;
  const { lines, grandMaterial } = buildSheetLines(results);

  // Consolidated finished-size line items (across all materials) — this is what the purchaser sees:
  // what's being ordered, qty, and cost, no sheet/stock nesting detail and no Ideal Sell.
  const itemLines = [];
  for (const matKey in results) {
    const r = results[matKey];
    const mat = MATERIALS[matKey];
    for (const name in r.perSize) {
      const p = r.perSize[name];
      if (p.qty <= 0) continue;
      const actualCost = r.combinedCostPerSqFt * p.sqftEach;
      const bump = actualCost * settings.bumpMult;
      itemLines.push({ matName: mat.name, size: name, qty: p.qty, actualCost, bump });
    }
  }
  const totalActualExt = itemLines.reduce((s, l) => s + l.actualCost * l.qty, 0);
  const totalBumpExt = itemLines.reduce((s, l) => s + l.bump * l.qty, 0);

  // --- Purchaser Order: finished size / qty / actual cost / cost with bump. This is what gets emailed out. ---
  const purchaserCard = document.createElement('div');
  purchaserCard.className = 'purchaser-card';
  purchaserCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
      <div><h2>Purchaser Order</h2><div class="sub">Finished sizes, qty &amp; cost — send this to your purchaser.</div></div>
      <div>
        <button class="btn-secondary" id="copyPurchaserBtn">Copy for Email</button>
        <button class="btn-secondary" id="printPurchaserBtn">Print</button>
        <span class="copy-flash" id="copyFlash"></span>
      </div>
    </div>`;
  const pTable = document.createElement('table');
  pTable.innerHTML = `<thead><tr><th>Material</th><th>Finished Size</th><th class="right">Qty</th><th class="right">Actual Cost</th><th class="right">Cost With Bump</th></tr></thead>`;
  const pTbody = document.createElement('tbody');
  for (const l of itemLines) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.matName}</td><td>${l.size}</td><td class="right">${l.qty}</td><td class="right money">${fmt$(l.actualCost)}</td><td class="right money">${fmt$(l.bump)}</td>`;
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
  host.appendChild(purchaserCard);

  document.getElementById('printPurchaserBtn').addEventListener('click', () => window.print());
  document.getElementById('copyPurchaserBtn').addEventListener('click', () => {
    const textLines = itemLines.map(l => `${l.matName} — ${l.size}: qty ${l.qty}  |  Actual Cost ${fmt$(l.actualCost)}  |  Cost With Bump ${fmt$(l.bump)}`);
    const text = `Tilly's Purchaser Order\n\n${textLines.join('\n')}\n\nTotal Actual Cost: ${fmt$(totalActualExt)}\nTotal Cost With Bump: ${fmt$(totalBumpExt)}`;
    navigator.clipboard.writeText(text).then(() => {
      const flash = document.getElementById('copyFlash');
      flash.textContent = 'Copied!';
      setTimeout(() => { flash.textContent = ''; }, 2000);
    });
  });

  // --- Internal Reference: same sheet breakdown, plus cutting cost + grand total. Personal use only. ---
  const internalCard = document.createElement('div');
  internalCard.className = 'card';
  internalCard.innerHTML = `<h2>Internal Reference <span class="tag" style="font-size:12px">(personal — not for the purchaser)</span></h2><div class="sub">Full job cost including pooled cutting labor.</div>`;
  const iTable = document.createElement('table');
  iTable.style.marginTop = '10px';
  iTable.innerHTML = `<thead><tr><th>Material</th><th>Stock Sheet</th><th class="right">Qty</th><th class="right">Cost / Sheet</th><th class="right">Line Total</th></tr></thead>`;
  const iTbody = document.createElement('tbody');
  for (const l of lines) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.matName}</td><td>${l.stockLabel}</td><td class="right">${l.count}</td><td class="right money">${fmt$(l.costPerSheet)}</td><td class="right money">${fmt$(l.lineTotal)}</td>`;
    iTbody.appendChild(tr);
  }
  iTable.appendChild(iTbody);
  internalCard.appendChild(iTable);
  const iTotals = document.createElement('div');
  iTotals.className = 'stat-row';
  iTotals.style.marginTop = '14px';
  iTotals.innerHTML = `
    <div class="stat"><div class="v">${fmt$(grandMaterial)}</div><div class="l">Total Material Cost</div></div>
    <div class="stat"><div class="v">${fmt$(cuttingCostTotal)}</div><div class="l">Total Cutting Cost</div></div>
    <div class="stat"><div class="v">${fmt$(grandMaterial + cuttingCostTotal)}</div><div class="l">Grand Total</div></div>
  `;
  internalCard.appendChild(iTotals);
  host.appendChild(internalCard);
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
    const payload = { stockCost: state.stockCost, settings: getSettings() };
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

function applyPricingToUI(pricing) {
  if (!pricing) return;
  if (pricing.stockCost) {
    for (const k in pricing.stockCost) state.stockCost[k] = pricing.stockCost[k];
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
  renderSavedRequests();
  const pricing = await fetchPricingFromCloud();
  if (pricing) {
    applyPricingToUI(pricing);
    renderStockCostGrid();
  }
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
