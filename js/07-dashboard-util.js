/* =====================================================================
   DASHBOARD
   ===================================================================== */
function renderDashboard(){
  const content = document.getElementById('content');
  const bom = state.sheets.bomMaster || [];
  const pm = state.sheets.partMaster || [];
  const gap = deriveRows('gapAnalysis');
  const purch = deriveRows('purchasingTracker');
  const prod = deriveRows('productionSchedule');
  const asm = deriveRows('assemblyControl');
  const ext = deriveRows('externalOperations');
  const action = state.sheets.actionPlan || [];

  const notCoded = bom.filter(b => !b.erpCode || !String(b.erpCode).trim()).length;
  const shortage = gap.filter(r => String(r.status||'').toUpperCase()==='SHORTAGE').length;
  const inWarehouse = gap.filter(r => String(r.status||'').toUpperCase()==='IN WAREHOUSE').length;
  const onFloor = gap.filter(r => String(r.status||'').toUpperCase()==='ON FLOOR').length;
  const openPOs = purch.filter(r => !/closed|cancelled|received/i.test(r.status||'')).length;
  const overduePOs = purch.filter(r => r.promisedDate && !r.actualReceiptDate && new Date(r.promisedDate) < new Date()).length;
  const prodCompleted = prod.filter(r => /completed/i.test(r.status||'')).length;
  const asmDone = asm.filter(r => /completed/i.test(r.assemblyStatus||'')).length;
  const actionOpen = action.filter(r => !/done|closed|cancelled/i.test(r.currentStatus||'')).length;
  const totalCostAtRisk = gap.filter(r => String(r.status||'').toUpperCase()==='SHORTAGE').reduce((s,r)=> s + (Number(r.totalCost)||0), 0);

  let html = `<div class="grid-cards">
    <div class="card"><div class="label">Total Parts</div><div class="value">${pm.length}</div><div class="sub">in Part Master</div></div>
    <div class="card"><div class="label">Not Coded Yet</div><div class="value ${notCoded?'accent':''}">${notCoded}</div><div class="sub">in BOM Master, no ERP Code</div></div>
    <div class="card"><div class="label">Shortage</div><div class="value accent">${shortage}</div><div class="sub">of ${gap.length} tracked</div></div>
    <div class="card"><div class="label">In Warehouse</div><div class="value">${inWarehouse}</div><div class="sub">awaiting internal request</div></div>
    <div class="card"><div class="label">On Floor</div><div class="value">${onFloor}</div><div class="sub">ready to use</div></div>
    <div class="card"><div class="label">Open POs</div><div class="value">${openPOs}</div><div class="sub">${overduePOs} overdue</div></div>
    <div class="card"><div class="label">Production Orders</div><div class="value">${prodCompleted}/${prod.length}</div><div class="sub">completed</div></div>
    <div class="card"><div class="label">Assembly Complete</div><div class="value">${asmDone}/${asm.length}</div><div class="sub">assembly orders</div></div>
    <div class="card"><div class="label">Open Actions</div><div class="value">${actionOpen}</div><div class="sub">of ${action.length} in Action Plan</div></div>
  </div>`;

  html += `<div class="two-col">
    <div class="panel"><h3>Material Gap Status</h3>${barChart(gap, 'status')}</div>
    <div class="panel"><h3>Assembly Status</h3>${barChart(asm, 'assemblyStatus')}</div>
  </div>`;
  html += `<div class="two-col">
    <div class="panel"><h3>Purchasing Status</h3>${barChart(purch, 'status')}</div>
    <div class="panel"><h3>Action Plan Status</h3>${barChart(action, 'currentStatus')}</div>
  </div>`;
  if(ext.length){
    html += `<div class="panel"><h3>External Operations Status</h3>${barChart(ext, 'status')}</div>`;
  }
  if(totalCostAtRisk > 0){
    html += `<div class="panel"><h3>Cost at Risk (shortage items)</h3><div style="font-family:var(--serif); font-size:32px; font-weight:600; color:var(--red);">${totalCostAtRisk.toLocaleString(undefined,{maximumFractionDigits:0})} EGP</div><div class="sub" style="margin-top:4px;">Sum of Unit Cost × Required Qty for parts currently in SHORTAGE status</div></div>`;
  }
  html += renderKpiPanel(gap, purch);
  content.innerHTML = html;
}

function barChart(rows, field){
  const counts = {};
  rows.forEach(r => { const v = r[field] || 'Unspecified'; counts[v] = (counts[v]||0)+1; });
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  if(!entries.length) return `<div class="hint">No data yet.</div>`;
  const max = Math.max(...entries.map(e=>e[1]));
  const colorFor = (label) => ({'b-green':'var(--green)','b-amber':'var(--amber)','b-red':'var(--red)','b-blue':'var(--blue)','b-purple':'var(--purple)','b-gray':'var(--gray)'}[badgeClass(label)]);
  return entries.map(([label,count]) => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(count/max*100)}%; background:${colorFor(label)}"></div></div>
      <div class="bar-val">${count}</div>
    </div>`).join('');
}

function renderKpiPanel(gap, purch){
  const kpis = state.sheets.kpis || [];
  if(!kpis.length) return '';
  kpis.forEach(k => {
    const name = (k.kpi||'').toLowerCase();
    if(name.includes('shortage')) k.thisWeekActual = gap.filter(r => String(r.status||'').toUpperCase()==='SHORTAGE').length;
    if(name.includes('overdue') && name.includes('po')) k.thisWeekActual = purch.filter(r => r.promisedDate && !r.actualReceiptDate && new Date(r.promisedDate) < new Date()).length;
  });
  const rows = kpis.map(k => {
    const target = Number(k.target), actual = Number(k.thisWeekActual);
    const good = !isNaN(target) && !isNaN(actual) ? (actual <= target) : null;
    return `<tr>
      <td style="font-weight:600;">${escapeHtml(k.kpi||'')}</td>
      <td style="color:var(--ink-soft); font-size:12px;">${escapeHtml(k.description||'')}</td>
      <td>${escapeHtml(k.target ?? '')}</td>
      <td><span class="badge ${good===null?'b-gray':(good?'b-green':'b-red')}">${escapeHtml(k.thisWeekActual ?? '')} ${escapeHtml(k.unit||'')}</span></td>
      <td style="color:var(--ink-soft); font-size:12px;">${escapeHtml(k.sourceSheet||'')}</td>
    </tr>`;
  }).join('');
  return `<div class="panel"><h3>KPI Dashboard</h3>
    <div class="table-wrap"><table><thead><tr><th>KPI</th><th>Description</th><th>Target</th><th>This Week</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="hint" style="margin-top:10px;">Shortage and overdue-PO KPIs auto-refresh from live data.</div>
  </div>`;
}

/* =====================================================================
   UTIL
   ===================================================================== */
function escapeHtml(v){
  return String(v===undefined||v===null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}
