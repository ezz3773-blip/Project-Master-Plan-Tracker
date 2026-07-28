/* =====================================================================
   ROW ACCESS HELPERS
   ===================================================================== */
function getRows(sheetKey){
  if(isManual(sheetKey)){
    const rows = state.sheets[sheetKey] || [];
    const cfg = sheetCfg(sheetKey);
    if(cfg.lookups) return rows.map(r => applyLookup(sheetKey, {...r}));
    return rows;
  }
  return deriveRows(sheetKey);
}
function rowIdentity(sheetKey, row){ return isManual(sheetKey) ? row.id : row.erpCode; }

function distinctValues(sheetKey, colKey){
  const set = new Set();
  getRows(sheetKey).forEach(r => { if(r[colKey] !== undefined && r[colKey] !== null && r[colKey] !== '') set.add(r[colKey]); });
  return Array.from(set).sort();
}

/* =====================================================================
   NAV
   ===================================================================== */
function buildNav(){
  const nav = document.getElementById('navContainer');
  let html = `<div class="nav-group"><div class="nav-item" data-nav="dashboard"><span class="dot"></span>Dashboard</div></div>`;
  GROUPS.forEach(g => {
    const keys = SHEET_ORDER.filter(k => sheetCfg(k).group === g);
    if(!keys.length) return;
    html += `<div class="nav-group"><div class="nav-group-label">${g}</div>`;
    keys.forEach(k => {
      html += `<div class="nav-item" data-nav="${k}"><span class="dot"></span>${sheetCfg(k).label}<span class="count">${getRows(k).length}</span></div>`;
    });
    html += `</div>`;
  });
  nav.innerHTML = html;
  nav.querySelectorAll('.nav-item').forEach(el => { el.onclick = () => navigateTo(el.getAttribute('data-nav')); });
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.getAttribute('data-nav') === state.current));
}

function navigateTo(key){
  state.current = key; state.search = ''; state.statusFilter = null; state.sortKey = null; state.columnFilters = {};
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
  render();
}

/* =====================================================================
   RENDER DISPATCH
   ===================================================================== */
function render(){
  const titleEl = document.getElementById('pageTitle');
  const descEl = document.getElementById('pageDesc');
  const actionsEl = document.getElementById('topbarActions');
  if(state.current === 'dashboard'){
    titleEl.textContent = state.projectName || 'Dashboard';
    descEl.textContent = 'Live overview across all sheets';
    actionsEl.innerHTML = '';
    renderDashboard();
  } else {
    const cfg = sheetCfg(state.current);
    titleEl.textContent = cfg.label;
    descEl.textContent = cfg.desc || '';
    const manual = isManual(state.current);
    actionsEl.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="exportBtn">Export CSV</button>
      ${manual ? `<button class="btn btn-ghost btn-sm" id="importBtn">Import CSV</button><input type="file" accept=".csv,text/csv" id="importFileInput" style="display:none;">` : ''}
      ${state.current==='partMaster' ? `<button class="btn btn-ghost btn-sm" id="syncBomBtn">Sync from BOM Master</button><button class="btn btn-ghost btn-sm" id="dedupeBtn">Remove Duplicates</button><button class="btn btn-ghost btn-sm" id="checkSyncBtn">Check Sync</button>` : ''}
      ${state.current==='actionPlan' ? `<button class="btn btn-ghost btn-sm" id="genStepsBtn">Generate Steps</button><button class="btn btn-ghost btn-sm" id="apViewToggleBtn">${state.actionPlanGrouped?'Flat Table':'Group by Part'}</button>` : ''}
      ${state.current==='bomMaster' ? renderBomLockButtonHtml() : ''}
      ${manual ? `<button class="btn btn-primary btn-sm" id="addRowBtn">+ Add Row</button>` : ''}
    `;
    document.getElementById('exportBtn').onclick = () => exportCSV(state.current);
    if(manual) document.getElementById('addRowBtn').onclick = () => openRowModal(state.current);
    if(manual){
      document.getElementById('importBtn').onclick = () => document.getElementById('importFileInput').click();
      document.getElementById('importFileInput').onchange = async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if(file) await importCSVFile(state.current, file);
      };
    }
    if(state.current==='partMaster'){
      document.getElementById('syncBomBtn').onclick = syncPartMasterFromBom;
      document.getElementById('dedupeBtn').onclick = dedupePartMaster;
      document.getElementById('checkSyncBtn').onclick = checkSyncReport;
    }
    if(state.current==='actionPlan'){
      document.getElementById('genStepsBtn').onclick = generateActionPlanSteps;
      document.getElementById('apViewToggleBtn').onclick = () => { state.actionPlanGrouped = !state.actionPlanGrouped; render(); };
    }
    if(state.current==='bomMaster'){
      const btn = document.getElementById('bomLockBtn');
      if(btn) btn.onclick = state.bomLocked ? unlockBomPrompt : lockBomPrompt;
    }
    renderTable(state.current);
  }
  buildNav();
}

/* =====================================================================
   BADGE COLOR
   ===================================================================== */
function badgeClass(val){
  if(val === null || val === undefined || val === '') return 'b-gray';
  const v = String(val).toLowerCase();
  if(/(shortage|open|not started|blocked|delay|fail|high|obsolete|cancelled|not ready)/.test(v)) return 'b-red';
  if(/(progress|partial|warehouse|medium|pending|waiting|mo issued|released|pr raised)/.test(v)) return 'b-amber';
  if(/(complete|done|closed|floor|active|low$|received|covered|pass|ready)/.test(v)) return 'b-green';
  if(/(order|sent|inactive)/.test(v)) return 'b-blue';
  if(/(hold|critical|discontinued|not required)/.test(v)) return 'b-purple';
  return 'b-gray';
}

/* =====================================================================
   TABLE ENGINE
   ===================================================================== */
function renderTable(sheetKey){
  if(sheetKey === 'actionPlan' && state.actionPlanGrouped){ renderActionPlanGrouped(); return; }
  const cfg = sheetCfg(sheetKey);
  const manual = isManual(sheetKey);
  const content = document.getElementById('content');
  let rows = getRows(sheetKey).slice();

  if(state.search){
    const q = state.search.toLowerCase();
    rows = rows.filter(r => cfg.columns.some(c => String(r[c.key]||'').toLowerCase().includes(q)));
  }
  if(state.statusFilter && cfg.statusField){
    rows = rows.filter(r => String(r[cfg.statusField]||'') === state.statusFilter);
  }
  const activeColFilters = state.columnFilters[sheetKey] || {};
  const hasColFilters = Object.values(activeColFilters).some(set => set && set.size);
  Object.entries(activeColFilters).forEach(([colKey, set]) => {
    if(set && set.size) rows = rows.filter(r => set.has(String(r[colKey] ?? '')));
  });
  const dragEnabled = !!(cfg.reorderable && !state.search && !state.statusFilter && !state.sortKey && !hasColFilters);
  if(cfg.reorderable && !state.sortKey){
    rows.sort((a,b) => (Number(a.orderIndex)||0) - (Number(b.orderIndex)||0));
  } else if(cfg.followOrderOf && !state.sortKey){
    const refRows = state.sheets[cfg.followOrderOf] || [];
    const orderMap = {};
    refRows.forEach(r => { if(r.erpCode) orderMap[r.erpCode] = Number(r.orderIndex)||0; });
    rows.sort((a,b) => (orderMap[a.erpCode] ?? 999999) - (orderMap[b.erpCode] ?? 999999));
  } else if(state.sortKey){
    rows.sort((a,b) => {
      const av = a[state.sortKey], bv = b[state.sortKey];
      if(av === undefined || av === null || av==='') return 1;
      if(bv === undefined || bv === null || bv==='') return -1;
      if(!isNaN(av) && !isNaN(bv)) return (Number(av)-Number(bv)) * state.sortDir;
      return String(av).localeCompare(String(bv)) * state.sortDir;
    });
  }

  const totalCount = getRows(sheetKey).length;
  const statusChips = cfg.statusField ? distinctValues(sheetKey, cfg.statusField) : [];

  let html = '';
  if(sheetKey === 'partMaster') html += renderMainProductsPanel();
  if(sheetKey === 'gapAnalysis') html += renderNotCodedBanner();
  html += `<div class="search-row">
    <div class="search-box">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="searchInput" placeholder="Search ${cfg.label.toLowerCase()}…" value="${escapeHtml(state.search)}">
    </div>`;
  if(statusChips.length){
    html += `<span class="chip ${!state.statusFilter?'active':''}" data-chip="">All (${totalCount})</span>`;
    statusChips.forEach(s => {
      const count = getRows(sheetKey).filter(r => String(r[cfg.statusField]) === String(s)).length;
      html += `<span class="chip ${state.statusFilter===s?'active':''}" data-chip="${escapeHtml(s)}">${escapeHtml(s)} (${count})</span>`;
    });
  }
  html += `</div>`;

  if(!manual){
    html += `<div class="readonly-hint">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      Rows here are generated automatically from Part Master. To add or remove a part from this list, update its quantities in Part Master — only the highlighted fields below are yours to fill in.${cfg.reorderable?' Drag ⠿ to arrange the order.':''}
    </div>`;
  }
  if(cfg.reorderable && !dragEnabled){
    html += `<div class="readonly-hint">Clear search/filter/sort to drag-reorder rows.</div>`;
  }

  if(!rows.length){
    html += `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
      <div>${totalCount===0 ? (manual?'No rows yet. Add one to get started.':'Nothing here yet — it will appear automatically once Part Master has matching parts.') : 'No rows match your search/filter.'}</div>
    </div>`;
    content.innerHTML = html;
    wireSearchAndChips(sheetKey);
    if(sheetKey === 'partMaster') wireMainProductsPanel();
    if(sheetKey === 'gapAnalysis') wireNotCodedBanner();
    return;
  }

  html += `<div class="table-wrap"><table><thead><tr>`;
  if(dragEnabled) html += `<th style="width:28px"></th>`;
  html += `<th class="rownum">#</th>`;
  const colWidths = getColWidths(sheetKey);
  cfg.columns.forEach(c => {
    const arrow = state.sortKey === c.key ? (state.sortDir===1?'▲':'▼') : '';
    const w = colWidths[c.key] || c.w;
    const isFiltered = activeColFilters[c.key] && activeColFilters[c.key].size;
    html += `<th class="${c.colorClass||''}" style="width:${w}px" data-sort="${c.key}">${c.label} <span class="arrow">${arrow}</span><button class="col-filter-btn ${isFiltered?'active':''}" data-filter-col="${c.key}" title="Filter"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg></button><span class="col-resizer" data-colkey="${c.key}"></span></th>`;
  });
  if(manual) html += `<th style="width:40px"></th>`;
  html += `</tr></thead><tbody>`;

  rows.forEach((row, i) => {
    const rid = rowIdentity(sheetKey, row);
    html += `<tr data-rowid="${escapeHtml(rid)}" ${dragEnabled?'draggable="true"':''}>`;
    if(dragEnabled){
      html += `<td class="drag-handle" title="Drag to reorder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="6" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="16" cy="18" r="1.6"/></svg>
      </td>`;
    }
    html += `<td class="rownum">${i+1}</td>`;
    cfg.columns.forEach(c => { html += `<td class="${c.colorClass||''}">${renderCell(sheetKey, row, c, manual?'manual':'derived')}</td>`; });
    if(manual){
      html += `<td class="row-actions"><button class="icon-btn" data-del="${escapeHtml(rid)}" title="Delete row">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button></td>`;
    }
    html += `</tr>`;
  });
  html += `</tbody></table></div>`;
  html += cfg.columns.filter(c => c.kind==='select' && (c.opts==='suggest' || c.opts==='mainProducts' || (c.opts && c.opts.global))).map(c => {
    const opts = optionsForColumn(sheetKey, c);
    return `<datalist id="dl_${sheetKey}_${c.key}">${opts.map(o=>`<option value="${escapeHtml(o)}">`).join('')}</datalist>`;
  }).join('');
  html += `<div class="hint">${rows.length} of ${totalCount} row${totalCount===1?'':'s'} shown · shaded fields are read-only (auto-filled) · click a column header to sort${dragEnabled?' · drag ⠿ to reorder':''}</div>`;

  content.innerHTML = html;
  wireSearchAndChips(sheetKey);
  if(sheetKey === 'partMaster') wireMainProductsPanel();
  if(sheetKey === 'gapAnalysis') wireNotCodedBanner();
  if(dragEnabled) wireDragReorder(sheetKey);

  content.querySelectorAll('th[data-sort]').forEach(el => {
    el.onclick = () => {
      if(el.dataset.justResized){ delete el.dataset.justResized; return; }
      const k = el.getAttribute('data-sort');
      if(state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = 1; }
      renderTable(sheetKey);
    };
  });
  wireColumnResize(sheetKey);
  wireColumnFilters(sheetKey);
  if(manual){
    content.querySelectorAll('[data-del]').forEach(el => {
      el.onclick = async () => {
        const rid = el.getAttribute('data-del');
        const isBom = sheetKey === 'bomMaster';
        const row = isBom ? (state.sheets.bomMaster||[]).find(r => r.id === rid) : null;
        const msg = isBom
          ? 'Delete this part from BOM Master? Its matching Part Master row (and any gap analysis / purchasing / production data for it) will be deleted too.'
          : 'Delete this row?';
        if(confirm(msg)){
          await deleteManualRow(sheetKey, rid);
          if(isBom && row && row.erpCode) await cascadeDeleteByErpCode(row.erpCode);
          renderTable(sheetKey); buildNav();
        }
      };
    });
  }
  wireCellInputs();
  wireImageInputs();
}

let dragState = { fromId: null };

function wireDragReorder(sheetKey){
  const trs = document.querySelectorAll('#content tbody tr[draggable="true"]');
  const clearIndicators = () => document.querySelectorAll('.drag-over-top,.drag-over-bottom').forEach(el => el.classList.remove('drag-over-top','drag-over-bottom'));
  trs.forEach(tr => {
    tr.addEventListener('dragstart', () => {
      dragState.fromId = tr.getAttribute('data-rowid');
      tr.classList.add('dragging');
    });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); clearIndicators(); dragState.fromId = null; });
    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height/2;
      clearIndicators();
      tr.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
    });
    tr.addEventListener('drop', async (e) => {
      e.preventDefault();
      const toId = tr.getAttribute('data-rowid');
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height/2;
      clearIndicators();
      const fromId = dragState.fromId;
      dragState.fromId = null;
      if(!fromId || fromId === toId) return;
      await reorderRows(sheetKey, fromId, toId, before);
    });
  });
}

async function reorderRows(sheetKey, fromId, toId, before){
  const manual = isManual(sheetKey);
  const rows = (manual ? (state.sheets[sheetKey]||[]) : deriveRows(sheetKey)).slice()
    .sort((a,b) => (Number(a.orderIndex)||0) - (Number(b.orderIndex)||0));
  const idOf = r => manual ? r.id : r.erpCode;
  const fromIdx = rows.findIndex(r => idOf(r) === fromId);
  if(fromIdx === -1) return;
  const [moved] = rows.splice(fromIdx, 1);
  let toIdx = rows.findIndex(r => idOf(r) === toId);
  if(toIdx === -1) toIdx = rows.length; else if(!before) toIdx += 1;
  rows.splice(toIdx, 0, moved);
  const ops = [];
  state.extras[sheetKey] = state.extras[sheetKey] || {};
  rows.forEach((r,i) => {
    const newIdx = i*10;
    if(Number(r.orderIndex) !== newIdx){
      r.orderIndex = newIdx;
      if(manual){
        ops.push({ref: colRef(sheetKey).doc(r.id), type:'set', data:{orderIndex:newIdx}});
      } else {
        state.extras[sheetKey][r.erpCode] = state.extras[sheetKey][r.erpCode] || {};
        state.extras[sheetKey][r.erpCode].orderIndex = newIdx;
        ops.push({ref: extrasRef(sheetKey).doc(sanitizeId(r.erpCode)), type:'set', data:{orderIndex:newIdx}});
      }
    }
  });
  if(manual) state.sheets[sheetKey] = rows;
  renderTable(sheetKey);
  if(ops.length) await commitInChunks(ops);
}

function getColWidths(sheetKey){
  try{ return JSON.parse(localStorage.getItem('colw_'+sheetKey) || '{}'); }catch(e){ return {}; }
}
function setColWidth(sheetKey, key, px){
  const w = getColWidths(sheetKey);
  w[key] = px;
  try{ localStorage.setItem('colw_'+sheetKey, JSON.stringify(w)); }catch(e){}
}
function wireColumnResize(sheetKey){
  document.querySelectorAll('.col-resizer').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const th = handle.closest('th');
      const startX = e.clientX;
      const startWidth = th.getBoundingClientRect().width;
      let moved = false;
      try{ handle.setPointerCapture(e.pointerId); }catch(err){}
      function onMove(e2){
        const delta = e2.clientX - startX;
        if(Math.abs(delta) > 3) moved = true;
        th.style.width = Math.max(40, Math.round(startWidth + delta)) + 'px';
      }
      function onUp(e2){
        try{ handle.releasePointerCapture(e2.pointerId); }catch(err){}
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        if(moved){
          setColWidth(sheetKey, handle.getAttribute('data-colkey'), Math.round(th.getBoundingClientRect().width));
          th.dataset.justResized = '1';
        }
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
}

let syncInFlight = false;
async function syncPartMasterFromBom(){
  if(syncInFlight){ showToast('Sync already in progress…'); return; }
  syncInFlight = true;
  try{
    const bom = state.sheets.bomMaster || [];
    const existingCodes = new Set((state.sheets.partMaster||[]).map(r => (r.erpCode||'').trim().toLowerCase()));
    const missing = bom.filter(b => b.erpCode && !existingCodes.has(b.erpCode.trim().toLowerCase()));
    if(!missing.length){ showToast('Part Master is already in sync — nothing to add.'); return; }
    showToast('Syncing ' + missing.length + ' missing part(s)…');
    const seen = new Set();
    for(const b of missing){
      const code = b.erpCode.trim().toLowerCase();
      if(seen.has(code)) continue;
      seen.add(code);
      await ensurePartMasterRow(b.erpCode);
    }
    renderTable('partMaster'); buildNav();
    showToast(missing.length + ' part(s) added to Part Master.');
  } finally { syncInFlight = false; }
}

// Cleans up duplicate Part Master rows that may have accumulated before the
// upsert fix — keeps one row per ERP code, merging in any filled-in fields
// from the duplicates before deleting them (so no data is lost).
async function dedupePartMaster(){
  const rows = state.sheets.partMaster || [];
  const groups = {};
  rows.forEach(r => {
    const code = (r.erpCode||'').trim().toLowerCase();
    if(!code) return;
    groups[code] = groups[code] || [];
    groups[code].push(r);
  });
  const dupGroups = Object.values(groups).filter(g => g.length > 1);
  if(!dupGroups.length){ showToast('No duplicates found.'); return; }
  const dupCount = dupGroups.reduce((s,g)=>s+g.length-1, 0);
  if(!confirm(`Found ${dupGroups.length} part(s) with duplicate rows (${dupCount} extra row(s) total). Merge and remove the duplicates? Any filled-in data on the extra rows will be kept on the row that stays.`)) return;
  const ops = [];
  const removedIds = new Set();
  const filledCount = (r) => Object.values(r).filter(v => v!==undefined && v!==null && v!=='').length;
  for(const group of dupGroups){
    const keeper = group.reduce((best, r) => filledCount(r) > filledCount(best) ? r : best, group[0]);
    const others = group.filter(r => r.id !== keeper.id);
    const merged = {};
    others.forEach(r => {
      Object.keys(r).forEach(k => {
        if(k==='id') return;
        if((keeper[k]===undefined||keeper[k]===null||keeper[k]==='') && r[k]!==undefined && r[k]!==null && r[k]!==''){
          merged[k] = r[k]; keeper[k] = r[k];
        }
      });
    });
    if(Object.keys(merged).length) ops.push({ref: colRef('partMaster').doc(keeper.id), type:'set', data: merged});
    others.forEach(r => { ops.push({ref: colRef('partMaster').doc(r.id), type:'delete'}); removedIds.add(r.id); });
  }
  await commitInChunks(ops);
  state.sheets.partMaster = state.sheets.partMaster.filter(r => !removedIds.has(r.id));
  renderTable('partMaster'); buildNav();
  showToast(`Merged and removed ${dupCount} duplicate row(s).`);
}

let activeFilterPopup = null;
function closeColumnFilterPopup(){
  if(activeFilterPopup){ activeFilterPopup.remove(); activeFilterPopup = null; }
  document.removeEventListener('mousedown', onDocClickForFilterPopup, true);
}
function onDocClickForFilterPopup(e){
  if(activeFilterPopup && !activeFilterPopup.contains(e.target) && !e.target.closest('[data-filter-col]')) closeColumnFilterPopup();
}
function wireColumnFilters(sheetKey){
  document.querySelectorAll('[data-filter-col]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const colKey = btn.getAttribute('data-filter-col');
      if(activeFilterPopup && activeFilterPopup.dataset.colKey === colKey){ closeColumnFilterPopup(); return; }
      openColumnFilterPopup(sheetKey, colKey, btn);
    });
  });
}
function openColumnFilterPopup(sheetKey, colKey, btnEl){
  closeColumnFilterPopup();
  const cfg = sheetCfg(sheetKey);
  const allRows = getRows(sheetKey);
  const values = Array.from(new Set(allRows.map(r => String(r[colKey] ?? '')))).sort((a,b)=>a.localeCompare(b));
  state.columnFilters[sheetKey] = state.columnFilters[sheetKey] || {};
  const selected = state.columnFilters[sheetKey][colKey]; // Set or undefined (undefined = all shown)

  const popup = document.createElement('div');
  popup.className = 'col-filter-popup';
  popup.dataset.colKey = colKey;
  const rect = btnEl.getBoundingClientRect();
  popup.style.top = Math.min(rect.bottom + 4, window.innerHeight - 340) + 'px';
  popup.style.left = Math.min(rect.left - 150, window.innerWidth - 236) + 'px';

  function isChecked(v){ return !selected || selected.has(v); }
  function itemsHtml(filterText){
    return values.filter(v => !filterText || v.toLowerCase().includes(filterText)).map(v => `
      <label><input type="checkbox" data-val="${escapeHtml(v)}" ${isChecked(v)?'checked':''}> ${escapeHtml(v)||'(blank)'}</label>
    `).join('') || `<div class="hint" style="padding:8px;">No values.</div>`;
  }

  popup.innerHTML = `
    <div class="cf-search"><input type="text" placeholder="Search values…" id="cfSearchInput"></div>
    <div class="cf-actions"><a id="cfSelectAll">Select all</a><a id="cfClearAll">Clear</a></div>
    <div class="cf-list" id="cfList">${itemsHtml('')}</div>
    <div class="cf-foot"><button class="btn btn-primary btn-sm" id="cfClose">Done</button></div>
  `;
  document.body.appendChild(popup);
  activeFilterPopup = popup;

  function applyFromCheckboxes(){
    const checked = Array.from(popup.querySelectorAll('#cfList input:checked')).map(el => el.getAttribute('data-val'));
    const searchVal = document.getElementById('cfSearchInput').value.trim().toLowerCase();
    const visibleValues = values.filter(v => !searchVal || v.toLowerCase().includes(searchVal));
    const uncheckedVisible = visibleValues.filter(v => !checked.includes(v));
    if(uncheckedVisible.length === 0 && searchVal === ''){
      // everything checked with no active search -> no filter
      delete state.columnFilters[sheetKey][colKey];
    } else {
      // build full selected set: checked-visible plus any values not currently visible that were already selected
      const prevSelected = selected;
      const newSet = new Set(checked);
      if(prevSelected){
        values.forEach(v => { if(!visibleValues.includes(v) && prevSelected.has(v)) newSet.add(v); });
      } else if(searchVal !== ''){
        values.forEach(v => { if(!visibleValues.includes(v)) newSet.add(v); });
      }
      state.columnFilters[sheetKey][colKey] = newSet;
    }
    renderTable(sheetKey);
  }

  popup.querySelector('#cfSearchInput').addEventListener('input', (e) => {
    document.getElementById('cfList').innerHTML = itemsHtml(e.target.value.trim().toLowerCase());
    wireCheckboxes();
  });
  function wireCheckboxes(){
    popup.querySelectorAll('#cfList input[type="checkbox"]').forEach(cb => { cb.onchange = applyFromCheckboxes; });
  }
  wireCheckboxes();
  document.getElementById('cfSelectAll').onclick = () => {
    popup.querySelectorAll('#cfList input[type="checkbox"]').forEach(cb => cb.checked = true);
    applyFromCheckboxes();
  };
  document.getElementById('cfClearAll').onclick = () => {
    popup.querySelectorAll('#cfList input[type="checkbox"]').forEach(cb => cb.checked = false);
    applyFromCheckboxes();
  };
  document.getElementById('cfClose').onclick = closeColumnFilterPopup;
  setTimeout(() => document.addEventListener('mousedown', onDocClickForFilterPopup, true), 0);
}

function renderNotCodedBanner(){
  const bom = state.sheets.bomMaster || [];
  const notCoded = bom.filter(b => !b.erpCode || !String(b.erpCode).trim());
  if(!notCoded.length) return '';
  return `<div class="panel" style="margin-bottom:14px; padding:14px 18px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; border-color:var(--red);">
    <div style="display:flex; align-items:center; gap:14px;">
      <div style="font-family:var(--serif); font-size:30px; font-weight:600; color:var(--red);">${notCoded.length}</div>
      <div style="font-size:12.5px; color:var(--ink-soft); max-width:340px;">item${notCoded.length===1?'':'s'} in BOM Master still ${notCoded.length===1?'has':'have'} no ERP Code — they're stuck at "Coding Request" and won't show up in Gap Analysis or anywhere else until coded.</div>
    </div>
    <button class="btn btn-ghost btn-sm" id="viewNotCodedBtn">View in BOM Master</button>
  </div>`;
}
function wireNotCodedBanner(){
  const btn = document.getElementById('viewNotCodedBtn');
  if(!btn) return;
  btn.onclick = () => {
    navigateTo('bomMaster');
    state.columnFilters.bomMaster = { erpCode: new Set(['']) };
    renderTable('bomMaster');
    buildNav();
  };
}

function renderMainProductsPanel(){
  const products = state.mainProducts || [];
  const rows = products.map((p,i) => `
    <tr>
      <td style="padding:4px 6px;"><input class="cell-input" data-mp-field="name" data-mp-idx="${i}" value="${escapeHtml(p.name)}" placeholder="Product name"></td>
      <td style="padding:4px 6px; width:120px;"><input type="number" step="any" class="cell-input" data-mp-field="quantity" data-mp-idx="${i}" value="${escapeHtml(p.quantity)}" placeholder="Qty"></td>
      <td style="padding:4px 6px; width:34px; text-align:center;"><button class="icon-btn" data-mp-remove="${i}" title="Remove">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button></td>
    </tr>`).join('');
  return `<div class="panel" style="margin-bottom:14px; padding:16px 18px;">
    <h3 style="font-size:16px; margin:0 0 10px;">Main Products — what this project is building</h3>
    ${products.length ? `<table style="width:100%; max-width:480px; border-collapse:collapse; font-size:12.8px; margin-bottom:10px;">
      <thead><tr><th style="text-align:left; padding:4px 6px; font-size:11px; color:var(--ink-soft); text-transform:uppercase;">Product</th><th style="text-align:left; padding:4px 6px; font-size:11px; color:var(--ink-soft); text-transform:uppercase; width:120px;">Qty Building</th><th style="width:34px;"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<div class="hint" style="margin-bottom:10px;">No products defined yet — add one below (e.g. "MAFI LR-340", quantity 4) to enable automatic Required Qty calculation.</div>`}
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      <button class="btn btn-ghost btn-sm" id="addProductBtn">+ Add Product</button>
      <button class="btn btn-primary btn-sm" id="recalcQtyBtn">Recalculate Required Qty from BOM</button>
    </div>
    <div class="hint" style="margin-top:8px;">Required Qty = BOM Master's Qty/Each × the quantity you're building here. With one product, every BOM Master row counts automatically — tag a row's "Product" field only if this project builds more than one distinct product.</div>
  </div>`;
}

function wireMainProductsPanel(){
  document.querySelectorAll('[data-mp-field]').forEach(el => {
    el.addEventListener('change', () => {
      const idx = Number(el.getAttribute('data-mp-idx'));
      const field = el.getAttribute('data-mp-field');
      state.mainProducts[idx][field] = field === 'quantity' ? el.value : el.value;
      saveMainProducts();
      refreshErpDatalist();
    });
  });
  document.querySelectorAll('[data-mp-remove]').forEach(el => {
    el.onclick = () => {
      const idx = Number(el.getAttribute('data-mp-remove'));
      state.mainProducts.splice(idx, 1);
      saveMainProducts();
      renderTable('partMaster');
    };
  });
  const addBtn = document.getElementById('addProductBtn');
  if(addBtn) addBtn.onclick = () => {
    state.mainProducts.push({name:'', quantity:1});
    saveMainProducts();
    renderTable('partMaster');
  };
  const recalcBtn = document.getElementById('recalcQtyBtn');
  if(recalcBtn) recalcBtn.onclick = recalculateQtyFromBom;
}

async function recalculateQtyFromBom(){
  const products = (state.mainProducts||[]).filter(p => p.name && p.name.trim());
  if(!products.length){ showToast('Add at least one main product with a name first.'); return; }
  if(!confirm('This overwrites "Required Qty" in Part Master for every part, based on BOM Master Qty/Each × your main product quantities. Continue?')) return;
  const bom = state.sheets.bomMaster || [];
  const singleProduct = products.length === 1 ? products[0] : null;
  const totals = {};
  bom.forEach(b => {
    if(!b.erpCode) return;
    let qty = 0;
    if(singleProduct){
      qty = (Number(b.qtyPerEach)||0) * (Number(singleProduct.quantity)||0);
    } else {
      const prod = products.find(p => p.name === b.product);
      if(prod) qty = (Number(b.qtyPerEach)||0) * (Number(prod.quantity)||0);
    }
    totals[b.erpCode] = Math.round(((totals[b.erpCode]||0) + qty) * 100) / 100;
  });
  let updated = 0;
  (state.sheets.partMaster||[]).forEach(p => {
    if(!p.erpCode) return;
    const newQty = totals[p.erpCode] || 0;
    if(Number(p.totalRequiredQuantity||0) !== newQty){
      updateRowField('partMaster', p.id, 'totalRequiredQuantity', newQty);
      updated++;
    }
  });
  renderTable('partMaster'); buildNav();
  showToast('Recalculated Required Qty for ' + updated + ' part(s).');
}

function checkSyncReport(){
  const bom = state.sheets.bomMaster || [];
  const pm = state.sheets.partMaster || [];
  const bomCodes = bom.map(b => (b.erpCode||'').trim()).filter(Boolean);
  const bomCodeCounts = {};
  bomCodes.forEach(c => { bomCodeCounts[c.toLowerCase()] = (bomCodeCounts[c.toLowerCase()]||0) + 1; });
  const bomDuplicates = Object.entries(bomCodeCounts).filter(([,n]) => n > 1);
  const bomUnique = new Set(Object.keys(bomCodeCounts));

  const pmCodes = pm.map(p => (p.erpCode||'').trim()).filter(Boolean);
  const pmCodeCounts = {};
  pmCodes.forEach(c => { pmCodeCounts[c.toLowerCase()] = (pmCodeCounts[c.toLowerCase()]||0) + 1; });
  const pmDuplicates = Object.entries(pmCodeCounts).filter(([,n]) => n > 1);

  const missingInPartMaster = Array.from(bomUnique).filter(c => !pmCodeCounts[c]);
  const orphansInPartMaster = Object.keys(pmCodeCounts).filter(c => !bomUnique.has(c));
  const noErpInBom = bom.length - bomCodes.length;
  const noErpInPm = pm.length - pmCodes.length;

  let html = `
    <div class="grid-cards" style="margin-bottom:16px;">
      <div class="card"><div class="label">BOM Master rows</div><div class="value">${bom.length}</div><div class="sub">${bomUnique.size} unique ERP codes</div></div>
      <div class="card"><div class="label">Part Master rows</div><div class="value">${pm.length}</div><div class="sub">${Object.keys(pmCodeCounts).length} unique ERP codes</div></div>
    </div>`;
  const issues = [];
  if(missingInPartMaster.length) issues.push(`<b>${missingInPartMaster.length} ERP code(s) in BOM Master have no Part Master row:</b> ${missingInPartMaster.map(escapeHtml).join(', ')}`);
  if(bomDuplicates.length) issues.push(`<b>${bomDuplicates.length} ERP code(s) appear more than once in BOM Master itself</b> (so only one Part Master row is created for each — this is expected, not an error): ${bomDuplicates.map(([c,n])=>escapeHtml(c)+' ×'+n).join(', ')}`);
  if(pmDuplicates.length) issues.push(`<b>${pmDuplicates.length} ERP code(s) have duplicate rows in Part Master</b> — use "Remove Duplicates" to fix: ${pmDuplicates.map(([c,n])=>escapeHtml(c)+' ×'+n).join(', ')}`);
  if(orphansInPartMaster.length) issues.push(`<b>${orphansInPartMaster.length} Part Master row(s) have an ERP code not found in BOM Master</b> (e.g. deleted from BOM Master, or typo'd): ${orphansInPartMaster.map(escapeHtml).join(', ')}`);
  if(noErpInBom) issues.push(`<b>${noErpInBom} BOM Master row(s) have no ERP Code entered</b> — they can't sync to Part Master until you fill that in.`);
  if(noErpInPm) issues.push(`<b>${noErpInPm} Part Master row(s) have no ERP Code.</b>`);

  html += issues.length
    ? `<div class="panel" style="grid-column:1/-1;"><h3 style="font-size:15px;">Found ${issues.length} issue(s)</h3><ul style="padding-left:18px; font-size:12.8px; line-height:1.9; margin:0;">${issues.map(i=>`<li>${i}</li>`).join('')}</ul></div>`
    : `<div class="empty-state" style="grid-column:1/-1;">Everything is in sync — no issues found.</div>`;
  if(missingInPartMaster.length){
    html += `<button class="btn btn-primary btn-sm" id="fixMissingBtn" style="grid-column:1/-1; justify-self:start;">Add ${missingInPartMaster.length} missing part(s) to Part Master</button>`;
  }

  document.getElementById('modalTitle').textContent = 'BOM Master ↔ Part Master Sync Check';
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalSave').style.display = 'none';
  document.getElementById('modalCancel').textContent = 'Close';
  document.getElementById('modalOverlay').classList.add('open');
  const fixBtn = document.getElementById('fixMissingBtn');
  if(fixBtn) fixBtn.onclick = async () => { closeModal(); await syncPartMasterFromBom(); };
}

function renderActionPlanGrouped(){
  const content = document.getElementById('content');
  const cfg = MANUAL_SHEETS.actionPlan;
  let rows = getRows('actionPlan');
  state.apCollapsed = state.apCollapsed || {};

  const statusChips = distinctValues('actionPlan', 'currentStatus');
  const totalCount = rows.length;

  let visible = rows;
  if(state.search){
    const q = state.search.toLowerCase();
    visible = visible.filter(r => cfg.columns.some(c => String(r[c.key]||'').toLowerCase().includes(q)));
  }
  if(state.statusFilter){
    visible = visible.filter(r => String(r.currentStatus||'') === state.statusFilter);
  }

  const groups = {}; const order = [];
  visible.forEach(r => {
    const key = r.erpCode || '__none__';
    if(!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(r);
  });
  // sort groups by BOM Master order when available, general items last
  const bomOrder = {}; (state.sheets.bomMaster||[]).forEach(b => { if(b.erpCode) bomOrder[b.erpCode] = Number(b.orderIndex)||0; });
  order.sort((a,b) => (bomOrder[a] ?? 999999) - (bomOrder[b] ?? 999999));

  let html = `<div class="search-row">
    <div class="search-box">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="searchInput" placeholder="Search action plan…" value="${escapeHtml(state.search)}">
    </div>
    <span class="chip ${!state.statusFilter?'active':''}" data-chip="">All (${totalCount})</span>
    ${statusChips.map(s => `<span class="chip ${state.statusFilter===s?'active':''}" data-chip="${escapeHtml(s)}">${escapeHtml(s)} (${rows.filter(r=>String(r.currentStatus)===String(s)).length})</span>`).join('')}
  </div>`;

  if(!order.length){
    html += `<div class="empty-state">${totalCount===0 ? 'No action steps yet — click "Generate Steps" to create the standard workflow for every part that needs one.' : 'No steps match your search/filter.'}</div>`;
    content.innerHTML = html;
    wireSearchAndChips('actionPlan');
    return;
  }

  html += `<div id="apGroupList">`;
  order.forEach(key => {
    const items = groups[key].slice().sort((a,b) => (a.id||'').localeCompare(b.id||''));
    const doneCount = items.filter(r => /done|closed|cancelled/i.test(r.currentStatus||'')).length;
    const total = items.length;
    const allDone = doneCount === total;
    const collapsed = state.apCollapsed[key] !== undefined ? state.apCollapsed[key] : allDone;
    const partName = key === '__none__' ? 'General / no ERP code' : (items[0].partName || items[0].description || key);
    html += `<div class="ap-group ${collapsed?'':'open'}" data-group="${escapeHtml(key)}">
      <div class="ap-group-header" data-toggle-group="${escapeHtml(key)}">
        <div class="ap-group-title">
          <svg class="ap-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          <span class="ap-group-name">${escapeHtml(partName)}</span>
          ${key!=='__none__' ? `<span class="ap-group-code">${escapeHtml(key)}</span>` : ''}
        </div>
        <div class="ap-progress">
          <div class="ap-progress-track"><div class="ap-progress-fill" style="width:${total?(doneCount/total*100):0}%"></div></div>
          <span class="ap-progress-label">${doneCount}/${total}</span>
        </div>
      </div>
      <div class="ap-group-body" style="display:${collapsed?'none':'block'}">
        ${items.map(r => renderApStepRow(r)).join('')}
      </div>
    </div>`;
  });
  html += `</div>`;
  html += `<div class="hint">${order.length} part(s) · ${visible.length} of ${totalCount} step(s) shown</div>`;

  content.innerHTML = html;
  wireSearchAndChips('actionPlan');
  wireApGroupedView();
}

function renderApStepRow(r){
  const statusOpts = STATUS_OPTS.actionStatus;
  let statusOptHtml = statusOpts.map(o => `<option ${String(o)===String(r.currentStatus)?'selected':''}>${escapeHtml(o)}</option>`).join('');
  return `<div class="ap-step-row" data-step-id="${escapeHtml(r.id)}">
    <div class="ap-step-main">
      <div class="ap-step-action">${escapeHtml(r.action||'(no action)')}</div>
      <div class="ap-step-type">${escapeHtml(r.executionType||'')}</div>
    </div>
    <select class="cell-input ap-step-field narrow" data-ap-field="currentStatus" data-ap-id="${escapeHtml(r.id)}">${statusOptHtml}</select>
    <input class="cell-input ap-step-field" list="dl_actionPlan_responsible" placeholder="Responsible" data-ap-field="responsible" data-ap-id="${escapeHtml(r.id)}" value="${escapeHtml(r.responsible||'')}">
    <input type="date" class="cell-input ap-step-field narrow" data-ap-field="targetDate" data-ap-id="${escapeHtml(r.id)}" value="${escapeHtml(r.targetDate||'')}">
    <button class="icon-btn ap-step-del" data-ap-del="${escapeHtml(r.id)}" title="Delete step">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>`;
}

function wireApGroupedView(){
  document.querySelectorAll('[data-toggle-group]').forEach(el => {
    el.onclick = () => {
      const key = el.getAttribute('data-toggle-group');
      const groupEl = el.closest('.ap-group');
      const body = groupEl.querySelector('.ap-group-body');
      const nowOpen = body.style.display === 'none';
      body.style.display = nowOpen ? 'block' : 'none';
      groupEl.classList.toggle('open', nowOpen);
      state.apCollapsed[key] = !nowOpen;
    };
  });
  document.querySelectorAll('[data-ap-field]').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.getAttribute('data-ap-id');
      const field = el.getAttribute('data-ap-field');
      updateRowField('actionPlan', id, field, el.value);
      if(field === 'currentStatus') renderActionPlanGrouped();
      if(field === 'responsible' && el.value) addToGlobalList('people', el.value);
    });
  });
  document.querySelectorAll('[data-ap-del]').forEach(el => {
    el.onclick = async () => {
      if(confirm('Delete this step?')){
        await deleteManualRow('actionPlan', el.getAttribute('data-ap-del'));
        renderActionPlanGrouped(); buildNav();
      }
    };
  });
  const dl = document.getElementById('erpCodeDatalist');
  if(dl && !document.getElementById('dl_actionPlan_responsible')){
    const respList = document.createElement('datalist');
    respList.id = 'dl_actionPlan_responsible';
    respList.innerHTML = optionsForColumn('actionPlan', {opts:{global:'people'}}).map(o=>`<option value="${escapeHtml(o)}">`).join('');
    document.body.appendChild(respList);
  }
}

function wireSearchAndChips(sheetKey){
  document.getElementById('searchInput').oninput = (e) => { state.search = e.target.value; renderTable(sheetKey); };
  document.querySelectorAll('[data-chip]').forEach(el => {
    el.onclick = () => { state.statusFilter = el.getAttribute('data-chip') || null; renderTable(sheetKey); };
  });
}

function renderCell(sheetKey, row, col, mode){
  const key = col.key;
  const val = row[key] === undefined || row[key] === null ? '' : row[key];
  const rid = mode === 'manual' ? row.id : row.erpCode;

  if(col.kind === 'computed'){
    if(key === (sheetCfg(sheetKey).statusField||'') && val){
      return `<span class="badge ${badgeClass(val)}">${escapeHtml(val)}</span>`;
    }
    return `<div class="cell-input" style="background:#EEF2F8; color:var(--ink-soft); padding:5px 7px; border-radius:6px;">${escapeHtml(val)}</div>`;
  }
  if(col.kind === 'image'){ return renderImageCell(sheetKey, row, mode, col.editable); }
  if(!col.editable){
    return `<div class="cell-input" style="background:#EEF2F8; color:var(--ink-soft); padding:5px 7px; border-radius:6px; ${col.wrap?'':'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'}">${escapeHtml(val)}</div>`;
  }
  const attrs = `data-sheet="${sheetKey}" data-mode="${mode}" data-rowid="${escapeHtml(rid)}" data-key="${key}"`;
  if(col.kind === 'lookup'){
    return `<input class="cell-input" list="erpCodeDatalist" ${attrs} value="${escapeHtml(val)}">`;
  }
  if(col.kind === 'select'){
    if(col.opts === 'suggest' || col.opts === 'mainProducts' || (col.opts && col.opts.global)){
      // Free-typing combo box: works even with zero prior data (unlike a native <select>
      // with no options), and still suggests values — from the standard list and/or this project.
      return `<input class="cell-input" list="dl_${sheetKey}_${key}" ${attrs} value="${escapeHtml(val)}">`;
    }
    const opts = col.opts;
    let optHtml = `<option value=""></option>`, hasVal = false;
    opts.forEach(o => { if(String(o)===String(val)) hasVal=true; optHtml += `<option ${String(o)===String(val)?'selected':''}>${escapeHtml(o)}</option>`; });
    if(val && !hasVal) optHtml += `<option selected>${escapeHtml(val)}</option>`;
    return `<select class="cell-input" ${attrs}>${optHtml}</select>`;
  }
  if(col.kind === 'date'){ return `<input type="date" class="cell-input" ${attrs} value="${escapeHtml(val)}">`; }
  if(col.kind === 'number'){ return `<input type="number" step="any" class="cell-input" ${attrs} value="${escapeHtml(val)}">`; }
  if(col.wrap){ return `<textarea class="cell-input" rows="1" ${attrs}>${escapeHtml(val)}</textarea>`; }
  return `<input class="cell-input" ${attrs} value="${escapeHtml(val)}">`;
}

function renderImageCell(sheetKey, row, mode, editable){
  const rid = mode === 'manual' ? row.id : row.erpCode;
  const val = row.imageBase64;
  if(editable === false){
    return val
      ? `<img class="img-thumb" src="${val}" data-view-img="1" title="Click to enlarge">`
      : `<div class="img-placeholder" style="cursor:default;" title="No picture (set in BOM Master)">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
         </div>`;
  }
  const safeId = 'imgin_' + sheetKey + '_' + String(rid).replace(/[^a-zA-Z0-9]/g,'');
  return `<div class="img-cell">
    ${val
      ? `<img class="img-thumb" src="${val}" data-view-img="1">
         <button class="icon-btn" data-remove-img="${escapeHtml(rid)}" data-sheet="${sheetKey}" title="Remove photo" style="padding:3px;">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
         </button>`
      : `<div class="img-placeholder" data-upload-trigger="${safeId}">
           <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
         </div>`}
    <input type="file" accept="image/*" class="img-upload-input" id="${safeId}" data-sheet="${sheetKey}" data-mode="${mode}" data-rowid="${escapeHtml(rid)}">
  </div>`;
}

function wireImageInputs(){
  document.querySelectorAll('.img-placeholder[data-upload-trigger]').forEach(el => {
    el.onclick = () => document.getElementById(el.getAttribute('data-upload-trigger')).click();
  });
  document.querySelectorAll('.img-thumb[data-view-img]').forEach(el => {
    el.onclick = () => { document.getElementById('imgLightboxImg').src = el.src; document.getElementById('imgLightbox').classList.add('open'); };
  });
  document.querySelectorAll('[data-remove-img]').forEach(el => {
    el.onclick = () => {
      const sheetKey = el.getAttribute('data-sheet'), rid = el.getAttribute('data-remove-img');
      if(bomLockGuard(sheetKey)) return;
      updateRowField(sheetKey, rid, 'imageBase64', '');
      renderTable(sheetKey);
    };
  });
  document.querySelectorAll('.img-upload-input').forEach(el => {
    el.onchange = async () => {
      const file = el.files[0]; if(!file) return;
      const sheetKey = el.getAttribute('data-sheet'), rid = el.getAttribute('data-rowid');
      if(bomLockGuard(sheetKey)){ el.value=''; return; }
      showToast('Uploading photo…');
      try{
        const dataUrl = await resizeImageFile(file, 320, 0.65);
        updateRowField(sheetKey, rid, 'imageBase64', dataUrl);
        renderTable(sheetKey);
        showToast('Photo saved.');
      }catch(err){ showToast('Photo upload failed.'); }
    };
  });
}

function wireCellInputs(){
  document.querySelectorAll('#content [data-sheet][data-key]').forEach(el => {
    if(el.tagName === 'TEXTAREA'){
      el.style.height = 'auto'; el.style.height = (el.scrollHeight) + 'px';
      el.addEventListener('input', () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; });
    }
    el.addEventListener('change', () => commitCell(el));
  });
}

function commitCell(el){
  const sheetKey = el.getAttribute('data-sheet');
  const mode = el.getAttribute('data-mode');
  const rid = el.getAttribute('data-rowid');
  const key = el.getAttribute('data-key');
  const value = el.value;
  if(bomLockGuard(sheetKey)){ renderTable(sheetKey); return; }
  const cfg = sheetCfg(sheetKey);
  const col = cfg.columns.find(c => c.key === key);
  if(col && col.opts && col.opts.global && value) addToGlobalList(col.opts.global, value);
  if(mode === 'manual'){
    updateRowField(sheetKey, rid, key, value);
    if(cfg.lookups && cfg.lookups.some(lk => lk.key === key)){
      const row = (state.sheets[sheetKey]||[]).find(r => r.id === rid);
      if(row){
        applyLookup(sheetKey, row);
        cfg.lookups.forEach(lk => { if(lk.key===key) Object.keys(lk.map).forEach(dk => updateRowField(sheetKey, rid, dk, row[dk])); });
        renderTable(sheetKey);
      }
    }
  } else {
    updateExtraField(sheetKey, rid, key, value);
    refreshRowComputedCells(sheetKey, rid);
    buildNav();
  }
}

function recomputeDerivedRow(sheetKey, erpCode){
  const p = (state.sheets.partMaster||[]).find(x => x.erpCode === erpCode);
  if(!p) return null;
  const bomByCode = {}; (state.sheets.bomMaster||[]).forEach(b => { if(b.erpCode) bomByCode[b.erpCode] = b; });
  const b = bomByCode[erpCode] || {};
  const extras = (state.extras[sheetKey]||{})[erpCode] || {};
  const row = {
    erpCode, description:b.description||p.description||'', partNo:b.partNumber||p.partNo||'',
    level: b.lvl!==undefined?b.lvl:'', makebuy:p.makebuy||'', preferredSupplier:p.preferredSupplier||'',
    totalRequiredQuantity:p.totalRequiredQuantity||0, onHandStock:p.onHandStock||0, onHandInternalLocation:p.onHandInternalLocation||0,
    uom:p.uom||'', leadTimeDays:p.leadTimePerItemDays||0, leadTimeEaDays:p.leadTimePerItemDays||0, unitCost:p.unitCost||0,
    preferedMethodOfManufacturing:p.preferedMethodOfManufacturing||'', ...extras
  };
  if(sheetKey==='gapAnalysis') computeGapRow(row);
  if(sheetKey==='internalRequests') computeInternalRow(row);
  if(sheetKey==='purchasingTracker') computePurchasingRow(row);
  if(sheetKey==='productionSchedule') computeProductionRow(row);
  return row;
}
function refreshRowComputedCells(sheetKey, erpCode){
  const row = recomputeDerivedRow(sheetKey, erpCode);
  if(!row) return;
  const tr = document.querySelector(`tr[data-rowid="${CSS.escape(erpCode)}"]`);
  if(!tr) return;
  const cfg = DERIVED_SHEETS[sheetKey];
  cfg.columns.forEach((col, idx) => {
    if(col.kind !== 'computed') return;
    const td = tr.children[idx+1];
    if(td) td.innerHTML = renderCell(sheetKey, row, col, 'derived');
  });
}

/* =====================================================================
   ADD ROW MODAL (manual sheets only)
   ===================================================================== */
function openRowModal(sheetKey){
  const cfg = MANUAL_SHEETS[sheetKey];
  document.getElementById('modalTitle').textContent = 'Add Row · ' + cfg.label;
  document.getElementById('modalSave').style.display = '';
  document.getElementById('modalCancel').textContent = 'Cancel';
  const body = document.getElementById('modalBody');
  let html = '';
  cfg.columns.forEach(c => {
    if(c.kind === 'computed' || c.kind === 'image' || !c.editable) return;
    const full = (c.wrap || (c.kind==='text' && c.w>160)) ? 'full' : '';
    if(c.kind === 'select'){
      if(c.opts === 'suggest' || c.opts === 'mainProducts' || (c.opts && c.opts.global)){
        const opts = optionsForColumn(sheetKey, c);
        html += `<div class="field ${full}"><label>${c.label}</label><input list="mdl_${sheetKey}_${c.key}" id="mf_${c.key}"><datalist id="mdl_${sheetKey}_${c.key}">${opts.map(o=>`<option value="${escapeHtml(o)}">`).join('')}</datalist></div>`;
      } else {
        html += `<div class="field ${full}"><label>${c.label}</label><select id="mf_${c.key}"><option value=""></option>${c.opts.map(o=>`<option>${escapeHtml(o)}</option>`).join('')}</select></div>`;
      }
    } else if(c.kind === 'date'){
      html += `<div class="field ${full}"><label>${c.label}</label><input type="date" id="mf_${c.key}"></div>`;
    } else if(c.kind === 'number'){
      html += `<div class="field ${full}"><label>${c.label}</label><input type="number" step="any" id="mf_${c.key}"></div>`;
    } else if(c.kind === 'lookup'){
      html += `<div class="field ${full}"><label>${c.label}</label><input list="erpCodeDatalist" id="mf_${c.key}"></div>`;
    } else {
      html += `<div class="field ${full}"><label>${c.label}</label><input id="mf_${c.key}"></div>`;
    }
  });
  body.innerHTML = html;
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modalSave').onclick = async () => {
    const data = {};
    cfg.columns.forEach(c => {
      if(c.kind === 'computed' || c.kind === 'image') { data[c.key] = c.kind==='image' ? '' : (data[c.key]||''); return; }
      const el = document.getElementById('mf_' + c.key);
      data[c.key] = el ? el.value : (data[c.key] || '');
    });
    if(cfg.lookups) applyLookup(sheetKey, data);
    cfg.columns.forEach(c => { if(c.opts && c.opts.global && data[c.key]) addToGlobalList(c.opts.global, data[c.key]); });
    closeModal();
    await addManualRow(sheetKey, data);
    renderTable(sheetKey); buildNav();
    showToast('Row added.');
  };
}
function closeModal(){ document.getElementById('modalOverlay').classList.remove('open'); }
document.getElementById('modalClose').onclick = closeModal;
document.getElementById('modalCancel').onclick = closeModal;
document.getElementById('modalOverlay').onclick = (e) => { if(e.target.id === 'modalOverlay') closeModal(); };

/* =====================================================================
   ERP DATALIST (shared, from BOM Master)
   ===================================================================== */
function refreshErpDatalist(){
  const bom = state.sheets['bomMaster'] || [];
  const dl = document.getElementById('erpCodeDatalist');
  if(!dl) return;
  dl.innerHTML = bom.map(p => `<option value="${escapeHtml(p.erpCode||'')}">${escapeHtml(p.description||'')}</option>`).join('');
}

/* =====================================================================
   CSV EXPORT
   ===================================================================== */
function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0; i<text.length; i++){
    const c = text[i], next = text[i+1];
    if(inQuotes){
      if(c === '"' && next === '"'){ field += '"'; i++; }
      else if(c === '"'){ inQuotes = false; }
      else field += c;
    } else {
      if(c === '"'){ inQuotes = true; }
      else if(c === ','){ row.push(field); field = ''; }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else if(c === '\r'){ /* skip */ }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length===1 && r[0]===''));
}

async function importCSVFile(sheetKey, file){
  let text;
  try{ text = await file.text(); }catch(e){ showToast('Could not read file.'); return; }
  const rows = parseCSV(text);
  if(rows.length < 2){ showToast('CSV has no data rows.'); return; }
  const cfg = MANUAL_SHEETS[sheetKey];
  const labelToKey = {};
  cfg.columns.forEach(c => { if(c.kind !== 'image') labelToKey[c.label.trim()] = c.key; });
  const header = rows[0].map(h => h.trim());
  const keyForCol = header.map(h => labelToKey[h] || null);
  if(!keyForCol.some(k => k)){ showToast('No matching columns found — export a CSV from this sheet first to see the expected headers.'); return; }
  const dataRows = rows.slice(1);
  showToast('Importing ' + dataRows.length + ' row(s)…');
  let imported = 0, updated = 0;
  for(const r of dataRows){
    if(r.every(v => v === '')) continue;
    const data = {};
    keyForCol.forEach((k, idx) => { if(k) data[k] = r[idx] !== undefined ? r[idx] : ''; });
    if(cfg.lookups) applyLookup(sheetKey, data);
    cfg.columns.forEach(c => { if(c.opts && c.opts.global && data[c.key]) addToGlobalList(c.opts.global, data[c.key]); });
    const before = (state.sheets[sheetKey]||[]).length;
    await upsertManualRow(sheetKey, data);
    if((state.sheets[sheetKey]||[]).length > before) imported++; else updated++;
  }
  renderTable(sheetKey); buildNav();
  showToast(imported + ' row(s) added, ' + updated + ' updated.');
}

function exportCSV(sheetKey){
  const cfg = sheetCfg(sheetKey);
  const rows = getRows(sheetKey);
  const headers = cfg.columns.filter(c=>c.kind!=='image').map(c => c.label);
  const lines = [headers.join(',')];
  rows.forEach(r => {
    const line = cfg.columns.filter(c=>c.kind!=='image').map(c => {
      let v = r[c.key] === undefined || r[c.key] === null ? '' : String(r[c.key]);
      if(v.includes(',') || v.includes('"')) v = '"' + v.replace(/"/g,'""') + '"';
      return v;
    }).join(',');
    lines.push(line);
  });
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = sheetKey + '.csv'; a.click();
  URL.revokeObjectURL(url);
}
