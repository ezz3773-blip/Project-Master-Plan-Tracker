/* =====================================================================
   FIRESTORE HELPERS
   ===================================================================== */
function colRef(sheetKey){ return db.collection('projects').doc(state.projectId).collection(sheetKey); }
function extrasRef(sheetKey){ return db.collection('projects').doc(state.projectId).collection(sheetKey + 'Extras'); }
function sanitizeId(v){
  return String(v==null?'':v).trim().replace(/[\/\.\#\$\[\]]/g,'_').slice(0,300) || ('row_' + Math.random().toString(36).slice(2));
}

async function commitInChunks(ops){ // ops: [{ref, data, type:'set'|'delete'}]
  for(let i=0; i<ops.length; i+=400){
    const chunk = ops.slice(i, i+400);
    const batch = db.batch();
    chunk.forEach(op => { if(op.type==='delete') batch.delete(op.ref); else batch.set(op.ref, op.data, {merge:true}); });
    await batch.commit();
  }
}

async function loadAllProjectData(){
  state.sheets = {}; state.extras = {}; state.mainProducts = [];
  for(const key of Object.keys(MANUAL_SHEETS)){
    const snap = await colRef(key).get();
    state.sheets[key] = snap.docs.map(d => ({id:d.id, ...d.data()}));
  }
  await ensureOrderIndexes('bomMaster');
  await ensurePartMasterOrderIndexes();
  for(const key of Object.keys(DERIVED_SHEETS)){
    const snap = await extrasRef(key).get();
    const map = {};
    snap.docs.forEach(d => { map[d.id] = d.data(); });
    state.extras[key] = map;
  }
  try{
    const mpSnap = await db.collection('projects').doc(state.projectId).collection('meta').doc('mainProducts').get();
    state.mainProducts = mpSnap.exists ? (mpSnap.data().products || []) : [];
  }catch(e){ state.mainProducts = []; }
  await migratePicturesToBomMasterIfNeeded();
  await loadBomLockState();
  refreshErpDatalist();
}

/* =====================================================================
   V17 ROLE SYSTEM — minimal role field per user, used to gate BOM unlock.
   Stored at users/{uid} = { email, role: 'admin'|'member' }.
   The documented admin account (Ezz3772@gmail.com) is auto-promoted to
   admin the first time it signs in; every other account defaults to
   'member' and must be promoted manually by an admin editing their
   users/{uid} doc in the Firebase console (or by a future admin-only UI).
   ===================================================================== */
async function loadUserRole(user){
  const ref = db.collection('users').doc(user.uid);
  const snap = await ref.get();
  if(!snap.exists){
    const role = (user.email || '').toLowerCase() === 'ezz3772@gmail.com' ? 'admin' : 'member';
    await ref.set({email: user.email, role});
    state.userRole = role;
  } else {
    state.userRole = snap.data().role || 'member';
  }
}

/* =====================================================================
   V17 BOM LOCK / UNLOCK — locks the entire BOM Master sheet against
   edits (add/remove components, change quantities/part numbers/
   descriptions/pictures, delete BOM rows). Enforced here in the client
   (commitCell/addManualRow/deleteManualRow all check state.bomLocked)
   AND must additionally be enforced via Firestore Security Rules on the
   bomMaster subcollection, since a client-side check alone can be
   bypassed by anyone calling the Firestore API directly.
   Audit trail: projects/{id}/auditLog, one entry per lock/unlock action.
   ===================================================================== */
async function loadBomLockState(){
  try{
    const snap = await db.collection('projects').doc(state.projectId).collection('meta').doc('bomLock').get();
    if(snap.exists){
      state.bomLocked = !!snap.data().locked;
      state.bomLockInfo = snap.data();
    } else {
      state.bomLocked = false; state.bomLockInfo = null;
    }
  }catch(e){ state.bomLocked = false; state.bomLockInfo = null; }
}

function renderBomLockButtonHtml(){
  if(state.bomLocked){
    const info = state.bomLockInfo || {};
    return `<span class="badge b-red" style="margin-right:6px;" title="Locked by ${escapeHtml(info.lockedBy||'')} on ${escapeHtml(info.lockedAt||'')}${info.reason?': '+escapeHtml(info.reason):''}">🔒 BOM Locked</span>
      <button class="btn btn-ghost btn-sm" id="bomLockBtn">Unlock BOM</button>`;
  }
  return `<button class="btn btn-ghost btn-sm" id="bomLockBtn">Lock BOM</button>`;
}

async function lockBomPrompt(){
  const reason = prompt('Reason for locking the BOM (required):', '');
  if(reason === null) return; // cancelled
  if(!reason.trim()){ showToast('A reason is required to lock the BOM.'); return; }
  await setBomLockState(true, reason.trim());
}

async function unlockBomPrompt(){
  if(state.userRole !== 'admin'){
    alert('Only an admin can unlock the BOM. Ask an admin, or have your account promoted in Firestore (users/{uid}.role = "admin").');
    return;
  }
  if(!confirm('Unlock the BOM Master? Anyone will then be able to edit BOM rows again. Continue?')) return;
  const reason = prompt('Reason for unlocking the BOM (required):', '');
  if(reason === null) return;
  if(!reason.trim()){ showToast('A reason is required to unlock the BOM.'); return; }
  await setBomLockState(false, reason.trim());
}

async function setBomLockState(locked, reason){
  const user = auth.currentUser;
  const prevStatus = state.bomLocked;
  const lockRef = db.collection('projects').doc(state.projectId).collection('meta').doc('bomLock');
  const now = new Date().toISOString();
  const data = locked
    ? {locked:true, reason, lockedBy: user?.email||'unknown', lockedAt: now}
    : {locked:false, unlockReason: reason, unlockedBy: user?.email||'unknown', unlockedAt: now};
  try{
    await lockRef.set(data, {merge:true});
    await db.collection('projects').doc(state.projectId).collection('auditLog').add({
      type: locked ? 'bom_lock' : 'bom_unlock',
      user: user?.email || 'unknown',
      timestamp: now,
      reason,
      previousStatus: prevStatus ? 'locked' : 'unlocked',
      newStatus: locked ? 'locked' : 'unlocked',
    });
    state.bomLocked = locked;
    state.bomLockInfo = data;
    showToast(locked ? 'BOM locked.' : 'BOM unlocked.');
    render();
  }catch(e){ showToast('Failed to update BOM lock: ' + e.message); }
}

/* =====================================================================
   V17 ONE-TIME MIGRATION — Part Master pictures (imageBase64) that were
   uploaded before V17 are copied to BOM Master's new `picture` field
   (the single source of truth for every part's image, keyed by erpCode).
   Runs once per project; guarded by projects/{id}/meta/v17Migration.
   Existing pictures are preserved — nothing is deleted, only copied.
   ===================================================================== */
async function migratePicturesToBomMasterIfNeeded(){
  try{
    const flagRef = db.collection('projects').doc(state.projectId).collection('meta').doc('v17Migration');
    const flagSnap = await flagRef.get();
    if(flagSnap.exists && flagSnap.data().picturesMigrated) return;

    const bomRows = state.sheets.bomMaster || [];
    const partRows = state.sheets.partMaster || [];
    const bomByCode = {};
    bomRows.forEach(b => { if(b.erpCode) bomByCode[b.erpCode] = b; });

    const ops = [];
    let migratedCount = 0;
    partRows.forEach(p => {
      if(!p.erpCode || !p.imageBase64) return;
      const bomRow = bomByCode[p.erpCode];
      if(bomRow && !bomRow.picture){
        ops.push({ref: colRef('bomMaster').doc(bomRow.id), type:'set', data:{picture: p.imageBase64}});
        bomRow.picture = p.imageBase64; // keep in-memory state consistent
        migratedCount++;
      }
    });
    if(ops.length) await commitInChunks(ops.map(o => ({ref:o.ref, data:o.data, type:'set'})));
    await flagRef.set({picturesMigrated:true, migratedAt: new Date().toISOString(), migratedCount}, {merge:true});
    if(migratedCount) showToast(`Migrated ${migratedCount} picture(s) from Part Master to BOM Master.`);
  }catch(e){
    console.error('Picture migration failed:', e);
  }
}

async function saveMainProducts(){
  await db.collection('projects').doc(state.projectId).collection('meta').doc('mainProducts').set({products: state.mainProducts});
}

async function ensureOrderIndexes(sheetKey){
  const rows = state.sheets[sheetKey] || [];
  const ops = [];
  rows.forEach((r,i) => {
    if(r.orderIndex === undefined || r.orderIndex === null || r.orderIndex === ''){
      r.orderIndex = i*10;
      ops.push({ref: colRef(sheetKey).doc(r.id), type:'set', data:{orderIndex: r.orderIndex}});
    }
  });
  if(ops.length) await commitInChunks(ops);
}

// Part Master defaults to BOM Master's row order (until you drag-reorder it
// yourself in Part Master, after which it stays independent).
async function ensurePartMasterOrderIndexes(){
  const rows = state.sheets.partMaster || [];
  const bomByCode = {};
  (state.sheets.bomMaster||[]).forEach(b => { if(b.erpCode) bomByCode[b.erpCode] = b; });
  const ops = [];
  rows.forEach((r,i) => {
    if(r.orderIndex === undefined || r.orderIndex === null || r.orderIndex === ''){
      const bomMatch = bomByCode[r.erpCode];
      r.orderIndex = bomMatch && bomMatch.orderIndex !== undefined ? bomMatch.orderIndex : i*10;
      ops.push({ref: colRef('partMaster').doc(r.id), type:'set', data:{orderIndex: r.orderIndex}});
    }
  });
  if(ops.length) await commitInChunks(ops);
}

async function seedProjectFromExcel(projectId){
  const savedPid = state.projectId;
  state.projectId = projectId; // temporarily point writes at the new project
  const ops = [];
  Object.keys(MANUAL_SHEETS).forEach(key => {
    const rows = (SEED_DATA.manual && SEED_DATA.manual[key]) || [];
    rows.forEach(row => { ops.push({ref: colRef(key).doc(), data: row, type:'set'}); });
  });
  Object.keys(DERIVED_SHEETS).forEach(key => {
    const extras = (SEED_DATA.extras && SEED_DATA.extras[key]) || {};
    Object.entries(extras).forEach(([erpCode, fields]) => {
      ops.push({ref: extrasRef(key).doc(sanitizeId(erpCode)), data: fields, type:'set'});
    });
  });
  await commitInChunks(ops);
  state.projectId = savedPid;
}

/* ---- Manual sheet row edits ---- */
function updateRowField(sheetKey, rowId, field, value){
  const row = (state.sheets[sheetKey]||[]).find(r => r.id === rowId);
  if(row) row[field] = value;
  setSyncState('saving');
  const timerKey = sheetKey+'|'+rowId+'|'+field;
  clearTimeout(saveTimers[timerKey]);
  saveTimers[timerKey] = setTimeout(async () => {
    try{
      await colRef(sheetKey).doc(rowId).set({[field]: value}, {merge:true});
      setSyncState('synced');
      if(sheetKey === 'bomMaster' && (field==='erpCode'||field==='description')) refreshErpDatalist();
    }catch(e){ setSyncState('error'); showToast('Save failed: ' + e.message); }
  }, 600);
}

function bomLockGuard(sheetKey){
  if(sheetKey === 'bomMaster' && state.bomLocked){
    showToast('BOM Master is locked — unlock it first to make changes.');
    return true;
  }
  return false;
}

async function addManualRow(sheetKey, data){
  if(bomLockGuard(sheetKey)) return null;
  if(sheetCfg(sheetKey).reorderable && (data.orderIndex === undefined || data.orderIndex === '')){
    const rows = state.sheets[sheetKey] || [];
    const maxIdx = rows.reduce((m,r) => Math.max(m, Number(r.orderIndex)||0), -10);
    data.orderIndex = maxIdx + 10;
  }
  const ref = await colRef(sheetKey).add(data);
  const row = {id: ref.id, ...data};
  state.sheets[sheetKey] = state.sheets[sheetKey] || [];
  state.sheets[sheetKey].push(row);
  if(sheetKey === 'bomMaster' && data.erpCode){ await ensurePartMasterRow(data.erpCode); refreshErpDatalist(); }
  if(sheetKey === 'partMaster' && data.erpCode){ await ensureBomMasterRow(data.erpCode, data); }
  return row;
}

async function deleteManualRow(sheetKey, rowId){
  if(bomLockGuard(sheetKey)) return;
  await colRef(sheetKey).doc(rowId).delete();
  state.sheets[sheetKey] = (state.sheets[sheetKey]||[]).filter(r => r.id !== rowId);
}

// Natural key(s) used to detect "this is the same row" during CSV import,
// so re-importing an updated sheet UPDATES matching rows instead of duplicating them.
const IMPORT_KEYS = {
  bomMaster: ['erpCode'],
  partMaster: ['erpCode'],
  actionPlan: ['erpCode','action'],
  erpAudit: ['auditItem'],
  changeIssues: ['logNo'],
  kpis: ['kpi'],
};

async function upsertManualRow(sheetKey, data){
  const keys = IMPORT_KEYS[sheetKey];
  if(keys){
    const keyOf = (obj) => keys.map(k => String(obj[k]||'').trim().toLowerCase()).join('|');
    const targetKey = keyOf(data);
    const blankKey = keys.map(()=>'').join('|');
    if(targetKey !== blankKey){
      const existing = (state.sheets[sheetKey]||[]).find(r => keyOf(r) === targetKey);
      if(existing){
        Object.keys(data).forEach(k => {
          if(data[k] !== '' && data[k] !== undefined && data[k] !== null){
            updateRowField(sheetKey, existing.id, k, data[k]);
          }
        });
        return existing;
      }
    }
  }
  return await addManualRow(sheetKey, data);
}

async function ensurePartMasterRow(erpCode){
  erpCode = String(erpCode).trim();
  const exists = (state.sheets.partMaster||[]).some(r => (r.erpCode||'').trim().toLowerCase() === erpCode.toLowerCase());
  if(exists) return;
  const bomMatch = (state.sheets.bomMaster||[]).find(b => (b.erpCode||'').trim().toLowerCase() === erpCode.toLowerCase());
  const data = {erpCode, makebuy:'', preferedMethodOfManufacturing:'', isThisItemNeedExternalOperations:'',
    preferredSupplier:'', altSupplier:'', leadTimePerItemDays:'', totalRequiredQuantity:'', onHandStock:'',
    onHandInternalLocation:'', uom:'', reorderPoint:'', unitCost:'', currency:'EGP', status:'Active', lastReview:'', notes:'', imageBase64:'',
    orderIndex: bomMatch && bomMatch.orderIndex !== undefined ? bomMatch.orderIndex : (state.sheets.partMaster||[]).length*10};
  applyLookup('partMaster', data);
  const ref = await colRef('partMaster').add(data);
  state.sheets.partMaster = state.sheets.partMaster || [];
  state.sheets.partMaster.push({id: ref.id, ...data});
  showToast('New part auto-added to Part Master — fill in its stock & cost details.');
}

// Reverse direction: adding/importing a part directly into Part Master (e.g. from an
// Excel export that already has everything) auto-creates its BOM Master row too, using
// whatever common fields (description/part no/category/material) came with the import.
async function ensureBomMasterRow(erpCode, sourceData){
  erpCode = String(erpCode).trim();
  const exists = (state.sheets.bomMaster||[]).some(r => (r.erpCode||'').trim().toLowerCase() === erpCode.toLowerCase());
  if(exists) return;
  const rows = state.sheets.bomMaster || [];
  const maxIdx = rows.reduce((m,r) => Math.max(m, Number(r.orderIndex)||0), -10);
  const data = {
    bomId:'', lvl:'', bomPath:'', erpCode,
    description: sourceData.description || '',
    partNumber: sourceData.partNo || sourceData.partNumber || '',
    category: sourceData.category || '',
    material: sourceData.material || '',
    qtyPerEach:'', uom: sourceData.uom || '', status:'Active', notes:'',
    orderIndex: maxIdx + 10,
  };
  const ref = await colRef('bomMaster').add(data);
  state.sheets.bomMaster = state.sheets.bomMaster || [];
  state.sheets.bomMaster.push({id: ref.id, ...data});
  refreshErpDatalist();
  showToast('New part auto-added to BOM Master too.');
}

async function cascadeDeleteByErpCode(erpCode){
  if(!erpCode) return;
  const ops = [];
  const pmRow = (state.sheets.partMaster||[]).find(r => r.erpCode === erpCode);
  if(pmRow) ops.push({ref: colRef('partMaster').doc(pmRow.id), type:'delete'});
  Object.keys(DERIVED_SHEETS).forEach(key => { ops.push({ref: extrasRef(key).doc(sanitizeId(erpCode)), type:'delete'}); });
  if(ops.length) await commitInChunks(ops);
  if(pmRow) state.sheets.partMaster = state.sheets.partMaster.filter(r => r.id !== pmRow.id);
  Object.keys(DERIVED_SHEETS).forEach(key => { if(state.extras[key]) delete state.extras[key][erpCode]; });
}

/* ---- Derived sheet "extra" field edits (keyed by ERP code) ---- */
function updateExtraField(sheetKey, erpCode, field, value){
  state.extras[sheetKey] = state.extras[sheetKey] || {};
  state.extras[sheetKey][erpCode] = state.extras[sheetKey][erpCode] || {};
  state.extras[sheetKey][erpCode][field] = value;
  setSyncState('saving');
  const timerKey = sheetKey+'|'+erpCode+'|'+field;
  clearTimeout(saveTimers[timerKey]);
  saveTimers[timerKey] = setTimeout(async () => {
    try{
      await extrasRef(sheetKey).doc(sanitizeId(erpCode)).set({[field]: value}, {merge:true});
      setSyncState('synced');
    }catch(e){ setSyncState('error'); showToast('Save failed: ' + e.message); }
  }, 600);
}

function setSyncState(s){
  const pill = document.getElementById('syncPill');
  if(!pill) return;
  if(s === 'saving'){ pill.textContent = 'Saving…'; pill.className = 'sync-pill saving'; }
  else if(s === 'synced'){ pill.textContent = 'Synced'; pill.className = 'sync-pill'; }
  else { pill.textContent = 'Error'; pill.className = 'sync-pill saving'; }
}
