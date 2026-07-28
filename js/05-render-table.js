/* =====================================================================
   LOOKUPS (BOM Master -> Part Master / Action Plan)
   ===================================================================== */
const HOURS_PER_DAY = 7; // your real working day length, used for all lead-time conversions
function applyLookup(sheetKey, row){
  const cfg = sheetCfg(sheetKey);
  if(!cfg.lookups) return row;
  cfg.lookups.forEach(lk => {
    const src = state.sheets[lk.from] || [];
    const code = row[lk.key];
    if(!code) return;
    const match = src.find(r => (r.erpCode||'').toLowerCase() === String(code).toLowerCase());
    if(match){
      Object.entries(lk.map).forEach(([destKey, srcKey]) => {
        row[destKey] = match[srcKey] !== undefined ? match[srcKey] : row[destKey];
      });
      // BOM Master captures lead time in hours PER UNIT; Part Master's Lead Time (days)
      // is the TOTAL for the required quantity, converted at 7 working hours per day.
      if(sheetKey === 'partMaster' && lk.from === 'bomMaster'){
        row.leadTimePerItemDays = Math.round((num(match.leadTimeHours) * num(row.totalRequiredQuantity) / HOURS_PER_DAY) * 100) / 100;
      }
    }
  });
  return row;
}

/* =====================================================================
   FORMULAS
   ===================================================================== */
// Egypt work week: Friday & Saturday are weekend.
function addWorkingDays(startDate, days){
  if(!startDate || isNaN(days)) return null;
  let d = new Date(startDate);
  let remaining = Math.round(days);
  const step = remaining >= 0 ? 1 : -1;
  remaining = Math.abs(remaining);
  while(remaining > 0){
    d.setDate(d.getDate() + step);
    const dow = d.getDay();
    if(dow !== 5 && dow !== 6) remaining--;
  }
  return d;
}
function fmtDate(d){ return d ? d.toISOString().slice(0,10) : ''; }

function computeGapStatus(req, stock, floor, mo, po){
  if(req === 0) return 'NOT REQUIRED';
  if(floor+mo+po >= req) return 'ON FLOOR';
  if(stock >= req) return 'IN WAREHOUSE';
  if(stock+floor === 0) return po>0 ? 'ON ORDER' : 'SHORTAGE';
  return 'PARTIAL';
}
function computeGapRow(row){
  const req = num(row.totalRequiredQuantity), stock = num(row.onHandStock), floor = num(row.onHandInternalLocation);
  const mo = num(row.moIssuedQuantity), po = num(row.poOrderQuantity);
  const covered = stock + floor + mo + po;
  row.netGap = Math.round((covered - req)*100)/100;
  row.coverage = req===0 ? 1 : Math.round((covered/req)*10000)/10000;
  row.totalCost = Math.round((num(row.unitCost) * req)*100)/100;
  row.status = !row.erpCode ? '' : computeGapStatus(req, stock, floor, mo, po);
}
function computeInternalRow(row){
  row.requstedQty = Math.max(0, Math.round((num(row.totalRequiredQuantity) - num(row.onHandInternalLocation))*100)/100);
  if(row.requestDate && row.receiptDate){
    row.delayDays = Math.round((new Date(row.receiptDate) - new Date(row.requestDate)) / 86400000);
  } else if(row.requestDate){
    const d = Math.round((new Date() - new Date(row.requestDate)) / 86400000);
    row.delayDays = d>0 ? d : 0;
  } else row.delayDays = '';
}
function computePurchasingRow(row){
  row.qtyToOrder = Math.max(0, Math.round((num(row.totalRequiredQuantity) - num(row.onHandStock))*100)/100);
  if(row.promisedDate && row.actualReceiptDate){
    row.delayDays = Math.round((new Date(row.actualReceiptDate) - new Date(row.promisedDate)) / 86400000);
  } else if(row.promisedDate){
    const d = Math.round((new Date() - new Date(row.promisedDate)) / 86400000);
    row.delayDays = d>0 ? d : 0;
  } else row.delayDays = '';
}
// Finds the direct material/child component of a manufactured part: the very
// next row in BOM Master's order whose level is exactly one deeper. This assumes
// your BOM Master is organized so a part's material immediately follows it.
function findDirectMaterial(erpCode){
  const bom = (state.sheets.bomMaster||[]).slice().sort((a,b) => (Number(a.orderIndex)||0) - (Number(b.orderIndex)||0));
  const idx = bom.findIndex(b => b.erpCode === erpCode);
  if(idx === -1) return null;
  const parentLvl = Number(bom[idx].lvl)||0;
  const next = bom[idx+1];
  if(next && Number(next.lvl) === parentLvl+1) return next;
  return null;
}

function computeProductionRow(row){
  const qty = num(row.prodOrderNo), leadEa = num(row.leadTimeEaDays);
  row.totalLeadTimeHours = Math.round(qty * leadEa * HOURS_PER_DAY * 100)/100;
  if(row.startDatePlan && row.totalLeadTimeHours){
    row.endDatePlan = fmtDate(addWorkingDays(row.startDatePlan, row.totalLeadTimeHours/HOURS_PER_DAY));
  } else row.endDatePlan = '';
  if(row.endDatePlan && row.endDateActual){
    const d = Math.round((new Date(row.endDateActual) - new Date(row.endDatePlan)) / 86400000);
    row.varianceDays = d>0 ? ('+'+d+' days') : (d<0 ? (d+' days') : 'On Time');
  } else row.varianceDays = '';

  const material = findDirectMaterial(row.erpCode);
  if(material){
    row.materialErpCode = material.erpCode || '';
    row.materialDescription = material.description || '';
    row.materialUom = material.uom || '';
    const neededQty = num(material.qtyPerEach) * (num(row.prodOrderNo) || num(row.totalRequiredQuantity));
    row.materialQty = Math.round(neededQty*100)/100;
    const matPart = (state.sheets.partMaster||[]).find(x => x.erpCode === material.erpCode);
    const matStock = matPart ? (num(matPart.onHandStock)+num(matPart.onHandInternalLocation)) : 0;
    row.materialReadiness = neededQty<=0 ? '' : (matStock >= neededQty ? 'READY' : (matStock>0 ? 'PARTIAL' : 'NOT READY'));
  } else {
    row.materialErpCode = ''; row.materialDescription = ''; row.materialUom = ''; row.materialQty = ''; row.materialReadiness = '';
  }
}

/* =====================================================================
   DERIVE ROWS FOR AUTO-GENERATED SHEETS
   ===================================================================== */
function deriveRows(sheetKey){
  const cfg = DERIVED_SHEETS[sheetKey];
  const pm = state.sheets.partMaster || [];
  const bomByCode = {};
  (state.sheets.bomMaster||[]).forEach(b => { if(b.erpCode) bomByCode[b.erpCode] = b; });
  const extras = state.extras[sheetKey] || {};
  const rows = pm.filter(p => p.erpCode && cfg.filter(p)).map(p => {
    const b = bomByCode[p.erpCode] || {};
    const row = {
      erpCode: p.erpCode,
      description: b.description || p.description || '',
      partNo: b.partNumber || p.partNo || '',
      level: b.lvl !== undefined ? b.lvl : '',
      makebuy: p.makebuy || '',
      preferredSupplier: p.preferredSupplier || '',
      totalRequiredQuantity: p.totalRequiredQuantity || 0,
      onHandStock: p.onHandStock || 0,
      onHandInternalLocation: p.onHandInternalLocation || 0,
      uom: p.uom || '',
      leadTimeDays: p.leadTimePerItemDays || 0,
      leadTimeEaDays: p.leadTimePerItemDays || 0,
      unitCost: p.unitCost || 0,
      preferedMethodOfManufacturing: p.preferedMethodOfManufacturing || '',
      imageBase64: b.picture || p.imageBase64 || '',
      orderIndex: p.orderIndex !== undefined ? p.orderIndex : 999999,
      ...(extras[p.erpCode] || {}),
    };
    if(sheetKey === 'gapAnalysis') computeGapRow(row);
    if(sheetKey === 'internalRequests') computeInternalRow(row);
    if(sheetKey === 'purchasingTracker') computePurchasingRow(row);
    if(sheetKey === 'productionSchedule') computeProductionRow(row);
    return row;
  });
  return rows;
}

/* =====================================================================
   ACTION PLAN — STANDARD STEP TEMPLATES, following your real workflow:
   1) Every item's first stage is getting it coded (Item Data Folder + Coding Request).
   2) Already on the floor (fully available): nothing further, unless it still needs
      external processing — then just request that.
   3) Already in warehouse stock: just request it to the floor (+ ext. process if needed).
   4) Shortage/partial + Make: Material Request → MO → Job Order → manufacture →
      close MO/Job Order → then external process request if needed.
   5) Shortage/partial + Buy (or on order): raise the request and follow up the PO
      → then external process request if needed.
   ===================================================================== */
function standardStepsFor(p, gapStatus){
  const steps = [];
  steps.push({executionType:'Production Control', action:'Item Data Folder'});
  steps.push({executionType:'Production Control', action:'Coding Request'});

  const needsExt = p.isThisItemNeedExternalOperations === 'Yes';
  // Pre-assembly routing: a machined/manufactured part that still needs an
  // external process (coating, anodizing, etc.) must first pass through its
  // in-house post-machining prep (surface finish / sand blasting) before it
  // is sent out. Skipping this step was the routing bug — parts jumped
  // straight from "Internal Manufacturing" to the external Coating request.
  const extSteps = () => {
    steps.push({executionType:'Internal Manufacturing', action:'Surface Finish (Sand Blasting)'});
    steps.push({executionType:'Production Control', action:'Service Request (Coating)'});
    steps.push({executionType:'Subcontracted Operations', action:'Coating'});
  };

  if(gapStatus === 'ON FLOOR' || gapStatus === 'NOT REQUIRED'){
    // already fully available — only an external process request, if flagged
    if(needsExt) extSteps();
  } else if(gapStatus === 'IN WAREHOUSE'){
    // already in stock — just needs to be requested to the floor
    steps.push({executionType:'Production Control', action:'Material Request'});
    if(needsExt) extSteps();
  } else if(p.makebuy === 'Make'){
    // shortage/partial, manufactured internally
    steps.push({executionType:'Production Control', action:'Material Request'});
    steps.push({executionType:'Production Control', action:'MO Issue'});
    steps.push({executionType:'Production Control', action:'Job Order Issue'});
    const method = p.preferedMethodOfManufacturing;
    if(method && method !== 'N/A' && method !== 'Assembling'){
      steps.push({executionType:'Internal Manufacturing', action: method});
    }
    if(method === 'Assembling'){
      steps.push({executionType:'Assembly Operations', action:'Assembling'});
    }
    steps.push({executionType:'Production Control', action:'MO Close'});
    steps.push({executionType:'Production Control', action:'Job Order Close'});
    if(needsExt) extSteps();
  } else {
    // shortage/partial/on order, bought or sourced externally — request + follow the PO
    steps.push({executionType:'Production Control', action:'Request Issuing'});
    steps.push({executionType:'Production Control', action:'PO Follow-up'});
    if(needsExt) extSteps();
  }
  return steps;
}

async function generateActionPlanSteps(){
  const pm = state.sheets.partMaster || [];
  const bomByCode = {};
  (state.sheets.bomMaster||[]).forEach(b => { if(b.erpCode) bomByCode[b.erpCode] = b; });
  const gapExtras = state.extras.gapAnalysis || {};
  const existing = new Set((state.sheets.actionPlan||[]).map(r => (r.erpCode||'') + '|' + (r.action||'')));
  const needing = pm.filter(p => p.erpCode && num(p.totalRequiredQuantity) > 0);
  const ops = [];
  needing.forEach(p => {
    const b = bomByCode[p.erpCode] || {};
    const ex = gapExtras[p.erpCode] || {};
    const gapStatus = computeGapStatus(num(p.totalRequiredQuantity), num(p.onHandStock), num(p.onHandInternalLocation), num(ex.moIssuedQuantity), num(ex.poOrderQuantity));
    standardStepsFor(p, gapStatus).forEach(s => {
      const k = p.erpCode + '|' + s.action;
      if(existing.has(k)) return;
      existing.add(k);
      addToGlobalList('actions', s.action);
      addToGlobalList('executionTypes', s.executionType);
      ops.push({ref: colRef('actionPlan').doc(), type:'set', data:{
        erpCode: p.erpCode, partName: b.description||p.description||'', partNumber: b.partNumber||p.partNo||'',
        category: b.category||p.category||'', material: b.material||p.material||'',
        executionType: s.executionType, action: s.action, currentStatus:'Not Started',
        axis:'', itemNo:'', qty:'', supplierSubcon:'', refNoMopo:'', waitingFor:'', responsible:'',
        targetDate:'', actualDate:'', sentDate:'', expReturn:'', received:'', remarks:''
      }});
    });
  });
  if(!ops.length){ showToast('No new steps to generate — everything up to date.'); return; }
  showToast('Generating ' + ops.length + ' step(s)…');
  await commitInChunks(ops);
  const snap = await colRef('actionPlan').get();
  state.sheets.actionPlan = snap.docs.map(d => ({id:d.id, ...d.data()}));
  render();
  showToast(ops.length + ' action step(s) generated.');
}

/* =====================================================================
   IMAGE HELPERS
   ===================================================================== */
function resizeImageFile(file, maxDim, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > h){ if(w > maxDim){ h = Math.round(h * maxDim / w); w = maxDim; } }
        else { if(h > maxDim){ w = Math.round(w * maxDim / h); h = maxDim; } }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
document.getElementById('imgLightbox').onclick = () => document.getElementById('imgLightbox').classList.remove('open');
