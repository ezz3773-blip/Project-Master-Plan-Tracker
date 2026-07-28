/* =====================================================================
   STATE
   ===================================================================== */
let state = {
  projectId: null, projectName: '', projects: [],
  sheets: {},   // manual sheets: { key: [ {id, ...fields}, ... ] }
  extras: {},   // derived sheets extras: { key: { erpCode: {...fields} } }
  current: 'dashboard', search: '', statusFilter: null, sortKey: null, sortDir: 1,
  columnFilters: {}, globalLists: {}, mainProducts: [], actionPlanGrouped: true,
  userRole: 'member', bomLocked: false, bomLockInfo: null,
};
let saveTimers = {};

/* =====================================================================
   AUTH
   ===================================================================== */
let authMode = 'signin';
document.getElementById('authToggle').onclick = () => {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  document.getElementById('authTitle').textContent = authMode === 'signin' ? 'Production OS' : 'Create Account';
  document.getElementById('authSubmit').textContent = authMode === 'signin' ? 'Sign In' : 'Create Account';
  document.getElementById('authToggleWrap').innerHTML = authMode === 'signin'
    ? 'New here? <a id="authToggle2">Create an account</a>'
    : 'Already have an account? <a id="authToggle2">Sign in</a>';
  document.getElementById('authToggle2').onclick = document.getElementById('authToggle').onclick;
};
document.getElementById('authSubmit').onclick = async () => {
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPassword').value;
  const errBox = document.getElementById('authError');
  errBox.style.display = 'none';
  if(!email || !pw){ errBox.textContent = 'Please enter email and password.'; errBox.style.display='block'; return; }
  try{
    if(authMode === 'signin'){ await auth.signInWithEmailAndPassword(email, pw); }
    else { await auth.createUserWithEmailAndPassword(email, pw); }
  }catch(e){ errBox.textContent = e.message; errBox.style.display = 'block'; }
};
document.getElementById('signOutBtn').onclick = () => auth.signOut();
document.getElementById('menuBtn').onclick = () => {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarBackdrop').classList.add('open');
};
document.getElementById('sidebarBackdrop').onclick = () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
};

auth.onAuthStateChanged(async user => {
  if(user){
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('userEmailLabel').textContent = user.email;
    showLoadingScreen();
    try{
      try{ await loadUserRole(user); }
      catch(e){ console.warn('Role load failed (non-fatal, defaulting to member):', e.message); state.userRole = 'member'; }
      try{ await loadGlobalLists(); }
      catch(e){ console.warn('Standard lists failed to load (non-fatal):', e.message); state.globalLists = state.globalLists || {}; }
      await loadProjectList();
      let pid = localStorage.getItem('productionOS_lastProject');
      if(!state.projects.find(p => p.id === pid)) pid = null;
      if(!pid && state.projects.length){ pid = state.projects[0].id; }
      if(!pid){
        // No projects at all yet — seed the original MAFI LR-340 project on first run.
        pid = await createProject('MAFI LR-340', true);
      }
      await switchProject(pid);
    }catch(e){ showLoadErrorScreen(e); }
  } else {
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
});

function showLoadingScreen(){
  document.getElementById('content').innerHTML = `
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
      <div>Loading your data…</div>
    </div>`;
}
function showLoadErrorScreen(e){
  const msg = (e && e.message) ? e.message : String(e);
  const isPermission = /permission|insufficient/i.test(msg);
  document.getElementById('content').innerHTML = `
    <div class="panel" style="max-width:640px; margin:40px auto;">
      <h3 style="color:var(--red);">Failed to load data</h3>
      <p style="font-size:13.5px; color:var(--ink-soft); margin-bottom:14px;">${escapeHtml(msg)}</p>
      ${isPermission ? `
        <p style="font-size:13.5px; margin-bottom:10px;">This usually means one of two things in your Firebase project (<b>${firebaseConfig.projectId}</b>):</p>
        <ol style="font-size:13.5px; color:var(--ink-soft); padding-left:20px; line-height:1.8;">
          <li><b>Firestore Database hasn't been created yet.</b> Firebase console → Build → Firestore Database → Create database.</li>
          <li><b>Security Rules are blocking access.</b> Firestore Database → Rules, paste:
            <pre style="background:var(--linen); padding:10px 12px; border-radius:8px; font-size:11.5px; overflow-x:auto; margin-top:6px;">rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{doc=**} { allow read, write: if request.auth != null; }
  }
}</pre>then click Publish.</li>
        </ol>` : ''}
      <button class="btn btn-primary btn-sm" id="retryLoadBtn" style="margin-top:16px;">Retry</button>
    </div>`;
  document.getElementById('retryLoadBtn').onclick = () => location.reload();
}

/* =====================================================================
   PROJECT MANAGEMENT
   ===================================================================== */
async function loadProjectList(){
  const snap = await db.collection('projects').orderBy('createdAt','asc').get();
  state.projects = snap.docs.map(d => ({id:d.id, ...d.data()}));
}

async function createProject(name, seedFromExcel){
  const ref = await db.collection('projects').add({
    name: name || 'Untitled Project',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  state.projects.push({id:ref.id, name});
  if(seedFromExcel){ await seedProjectFromExcel(ref.id); }
  return ref.id;
}

async function deleteProjectPrompt(id, name){
  if(!confirm(`Delete project "${name}"? This permanently deletes ALL its data (BOM, parts, everything). This cannot be undone.`)) return;
  showToast('Deleting project…');
  // Delete every sheet collection + extras collection for this project.
  const allKeys = [...Object.keys(MANUAL_SHEETS), ...Object.keys(DERIVED_SHEETS).map(k=>k+'Extras')];
  for(const key of allKeys){
    const snap = await db.collection('projects').doc(id).collection(key).get();
    let batch = db.batch(); let n = 0;
    for(const d of snap.docs){ batch.delete(d.ref); n++; if(n===400){ await batch.commit(); batch = db.batch(); n = 0; } }
    if(n>0) await batch.commit();
  }
  await db.collection('projects').doc(id).delete();
  state.projects = state.projects.filter(p => p.id !== id);
  if(state.projectId === id){
    const next = state.projects[0];
    if(next){ await switchProject(next.id); } else { await switchProject(await createProject('MAFI LR-340', false)); }
  }
  renderProjectList();
  showToast('Project deleted.');
}

async function switchProject(id){
  const proj = state.projects.find(p => p.id === id);
  if(!proj) return;
  state.projectId = id;
  state.projectName = proj.name;
  localStorage.setItem('productionOS_lastProject', id);
  document.getElementById('currentProjectLabel').textContent = proj.name;
  showLoadingScreen();
  try{
    await loadAllProjectData();
    buildNav();
    navigateTo('dashboard');
  }catch(e){ showLoadErrorScreen(e); }
}

document.getElementById('projectSwitcherBtn').onclick = () => {
  renderProjectList();
  document.getElementById('projectModalOverlay').classList.add('open');
};
document.getElementById('projectModalClose').onclick = () => document.getElementById('projectModalOverlay').classList.remove('open');
document.getElementById('projectModalOverlay').onclick = (e) => { if(e.target.id === 'projectModalOverlay') document.getElementById('projectModalOverlay').classList.remove('open'); };
document.getElementById('createProjectBtn').onclick = async () => {
  const input = document.getElementById('newProjectName');
  const name = input.value.trim();
  if(!name){ input.focus(); return; }
  input.value = '';
  const id = await createProject(name, false);
  document.getElementById('projectModalOverlay').classList.remove('open');
  await switchProject(id);
};

function renderProjectList(){
  const el = document.getElementById('projectListContainer');
  el.innerHTML = state.projects.map(p => `
    <div class="project-item ${p.id===state.projectId?'active':''}" data-pid="${p.id}">
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(p.name)}</span>
      <span class="del-proj" data-del-pid="${p.id}" data-del-name="${escapeHtml(p.name)}" title="Delete project">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </span>
    </div>`).join('');
  el.querySelectorAll('.project-item').forEach(row => {
    row.onclick = (e) => {
      if(e.target.closest('[data-del-pid]')) return;
      const id = row.getAttribute('data-pid');
      document.getElementById('projectModalOverlay').classList.remove('open');
      if(id !== state.projectId) switchProject(id);
    };
  });
  el.querySelectorAll('[data-del-pid]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteProjectPrompt(btn.getAttribute('data-del-pid'), btn.getAttribute('data-del-name'));
    };
  });
}
/* =====================================================================
   GLOBAL STANDARD LISTS (shared across all projects)
   ===================================================================== */
async function loadGlobalLists(){
  state.globalLists = {};
  const snap = await db.collection('globalLists').get();
  const existing = {};
  snap.docs.forEach(d => { existing[d.id] = (d.data().values)||[]; });
  const ops = [];
  Object.keys(GLOBAL_LIST_LABELS).forEach(key => {
    if(existing[key]){
      state.globalLists[key] = existing[key];
    } else {
      const seedVals = (GLOBAL_LISTS_SEED[key]||[]).slice();
      state.globalLists[key] = seedVals;
      ops.push({ref: db.collection('globalLists').doc(key), type:'set', data:{values: seedVals}});
    }
  });
  if(ops.length) await commitInChunksGlobal(ops);
}
async function commitInChunksGlobal(ops){
  for(let i=0; i<ops.length; i+=400){
    const batch = db.batch();
    ops.slice(i,i+400).forEach(op => batch.set(op.ref, op.data, {merge:true}));
    await batch.commit();
  }
}
async function addToGlobalList(listKey, value){
  if(!listKey || !value) return;
  value = String(value).trim();
  if(!value) return;
  state.globalLists[listKey] = state.globalLists[listKey] || [];
  const exists = state.globalLists[listKey].some(v => v.toLowerCase() === value.toLowerCase());
  if(exists) return;
  state.globalLists[listKey].push(value);
  state.globalLists[listKey].sort((a,b)=>a.localeCompare(b));
  try{
    await db.collection('globalLists').doc(listKey).set({values: firebase.firestore.FieldValue.arrayUnion(value)}, {merge:true});
  }catch(e){ /* non-critical */ }
}
async function removeFromGlobalList(listKey, value){
  state.globalLists[listKey] = (state.globalLists[listKey]||[]).filter(v => v !== value);
  try{
    await db.collection('globalLists').doc(listKey).set({values: firebase.firestore.FieldValue.arrayRemove(value)}, {merge:true});
  }catch(e){}
}
function optionsForColumn(sheetKey, col){
  if(col.opts === 'mainProducts') return (state.mainProducts||[]).map(p=>p.name);
  if(col.opts && col.opts.global){
    const global = state.globalLists[col.opts.global] || [];
    const local = distinctValues(sheetKey, col.key);
    const merged = new Set([...global, ...local]);
    return Array.from(merged).sort((a,b)=>String(a).localeCompare(String(b)));
  }
  if(col.opts === 'suggest') return distinctValues(sheetKey, col.key);
  return col.opts;
}

/* ---- Manage Standard Lists modal ---- */
document.getElementById('listsManagerBtn').onclick = () => { renderListsManager(); document.getElementById('listsManagerOverlay').classList.add('open'); };
document.getElementById('listsManagerClose').onclick = () => document.getElementById('listsManagerOverlay').classList.remove('open');
document.getElementById('listsManagerOverlay').onclick = (e) => { if(e.target.id==='listsManagerOverlay') document.getElementById('listsManagerOverlay').classList.remove('open'); };

function renderListsManager(){
  const body = document.getElementById('listsManagerBody');
  let html = '';
  Object.entries(GLOBAL_LIST_LABELS).forEach(([key, label]) => {
    const values = (state.globalLists[key]||[]).slice().sort((a,b)=>a.localeCompare(b));
    html += `<div class="list-manager-group">
      <div class="list-manager-title">${label}</div>
      <div class="list-manager-chips" data-list="${key}">
        ${values.map(v => `<span class="lm-chip">${escapeHtml(v)}<button data-rm="${escapeHtml(v)}" data-list="${key}">&times;</button></span>`).join('') || '<span class="hint">No values yet.</span>'}
      </div>
      <div class="list-manager-add">
        <input placeholder="Add ${label.toLowerCase()}…" data-add-input="${key}">
        <button class="btn btn-ghost btn-sm" data-add-btn="${key}">Add</button>
      </div>
    </div>`;
  });
  body.innerHTML = html;
  body.querySelectorAll('[data-rm]').forEach(btn => {
    btn.onclick = async () => { await removeFromGlobalList(btn.getAttribute('data-list'), btn.getAttribute('data-rm')); renderListsManager(); render(); };
  });
  body.querySelectorAll('[data-add-btn]').forEach(btn => {
    const key = btn.getAttribute('data-add-btn');
    const doAdd = async () => {
      const input = body.querySelector(`[data-add-input="${key}"]`);
      const v = input.value.trim();
      if(!v) return;
      input.value = '';
      await addToGlobalList(key, v);
      renderListsManager(); render();
    };
    btn.onclick = doAdd;
    body.querySelector(`[data-add-input="${key}"]`).addEventListener('keydown', (e) => { if(e.key==='Enter'){ e.preventDefault(); doAdd(); } });
  });
}
