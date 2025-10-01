// ===== Firebase =====
const auth = firebase.auth();
const db   = firebase.firestore();
db.enablePersistence({ synchronizeTabs: true }).catch(()=>{});

// ===== Estado =====
let qr = null;
let currentDeviceId = null;
let currentDocPath = null;
let decodingGuard = false;
let redeemBusy = false;

// ===== DOM =====
const $ = (id)=>document.getElementById(id);
const banner = $('statusBanner');
const debugBox = $('debugBox');

const bannerSet = (kind, text)=>{
  const cls = kind === 'ok' ? 'banner-ok' : kind === 'err' ? 'banner-err' : 'banner-warn';
  banner.className = 'banner ' + cls;
  banner.textContent = text;
};
const toast = (m)=>{ const t=$('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2200); };
const log = (...a)=>{ const line=a.map(x=>typeof x==='string'?x:JSON.stringify(x,null,2)).join(' '); debugBox.textContent+=line+'\n'; console.log('[VALIDAR]',...a); };

// ===== Helpers =====
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function waitForQrLib(maxMs=5000){
  const start = Date.now();
  while (typeof window.Html5Qrcode === 'undefined' && (Date.now()-start) < maxMs){
    await sleep(100);
  }
  return typeof window.Html5Qrcode !== 'undefined';
}

// ===== Relleno UI =====
function fill(o={}, d={}){
  $('r_uid').textContent    = o.uid || d.uid || '—';
  $('r_id').textContent     = o.redemptionId || d.redemptionId || '—';
  $('r_reward').textContent = d.rewardName || d.rewardId || o.rewardId || '—';
  $('r_cost').textContent   = (d.cost ?? o.cost ?? '—') + '';
  const exp = d.expiresAt?.toDate ? d.expiresAt.toDate() : (d.expiresAt ? new Date(d.expiresAt) : null);
  $('r_exp').textContent    = exp ? exp.toLocaleDateString('es-MX',{year:'numeric',month:'2-digit',day:'2-digit'}) : '—';
  const when = d.redeemedAt?.toDate ? d.redeemedAt.toDate() : null;
  $('r_when').textContent   = when ? when.toLocaleString('es-MX') : '—';
  $('r_by').textContent     = d.redeemedBy || '—';
}
function clearInfo(){
  fill(); $('r_status').textContent='—';
  $('btnRedeem').disabled=true; $('btnCopyId').disabled=true;
  currentDocPath=null;
}

// ===== Parse QR =====
function parsePayload(text){
  try{
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text);
      const p = u.searchParams.get('payload') || u.searchParams.get('q') || u.searchParams.get('data');
      if (p) text = p;
    }
    const o = JSON.parse(text);
    if(!o.uid || !o.redemptionId) throw new Error('Faltan campos (uid, redemptionId)');
    return o;
  }catch(e){ throw new Error('QR inválido: ' + e.message); }
}

// ===== Firestore =====
async function validate(uid, rid){
  const ref = db.collection('users').doc(uid).collection('redemptions').doc(rid);
  const snap = await ref.get();
  if (!snap.exists){
    fill({uid, redemptionId: rid},{});
    $('r_status').textContent='no existe';
    bannerSet('err','No se encontró el canje en Firestore.');
    $('btnCopyId').disabled=false;
    currentDocPath=null;
    return;
  }
  const d = snap.data();
  fill({uid, redemptionId: rid}, d);

  const now = new Date();
  const exp = d.expiresAt?.toDate ? d.expiresAt.toDate() : (d.expiresAt? new Date(d.expiresAt) : null);
  if (exp && exp < now){
    $('r_status').textContent='expirado';
    bannerSet('err','Cupón EXPIRADO.');
    $('btnCopyId').disabled=false;
    currentDocPath=ref.path;
    return;
  }

  const st = (d.status || 'pendiente').toLowerCase();
  $('r_status').textContent = st;

  if (st === 'canjeado'){
    bannerSet('err','Este cupón ya fue canjeado.');
    $('btnCopyId').disabled=false; $('btnRedeem').disabled=true; currentDocPath=ref.path; return;
  }
  if (st !== 'pendiente'){
    bannerSet('err','No válido. Estatus actual: ' + st);
    $('btnCopyId').disabled=false; $('btnRedeem').disabled=true; currentDocPath=ref.path; return;
  }

  bannerSet('ok','VÁLIDO. Puedes canjearlo.');
  $('btnRedeem').disabled=false; $('btnCopyId').disabled=false;
  currentDocPath = ref.path;
}

async function redeemTx(){
  if (redeemBusy) return;
  if (!currentDocPath) return;
  redeemBusy = true; $('btnRedeem').disabled=true;

  const ref = db.doc(currentDocPath);
  try{
    await db.runTransaction(async(tx)=>{
      const snap = await tx.get(ref);
      if(!snap.exists) throw new Error('Documento no existe');
      const d = snap.data();
      const exp = d.expiresAt?.toDate ? d.expiresAt.toDate() : (d.expiresAt? new Date(d.expiresAt):null);
      if (exp && exp < new Date()) throw new Error('Cupón expirado');
      const st = (d.status||'pendiente').toLowerCase();
      if (st !== 'pendiente') throw new Error('Estatus actual: ' + st);

      tx.update(ref,{
        status:'canjeado',
        redeemedAt: firebase.firestore.FieldValue.serverTimestamp(),
        redeemedBy: (auth.currentUser && (auth.currentUser.email || auth.currentUser.uid)) || 'gerencia'
      });
    });

    $('r_status').textContent='canjeado';
    bannerSet('ok','Canje marcado como CANJEADO ✔');
    try{ // beep corto
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const osc = ctx.createOscillator(), g=ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type='sine'; osc.frequency.value=880; g.gain.value=0.0001;
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime+0.02);
      osc.start(); osc.stop(ctx.currentTime+0.1);
    }catch{}
    closeModal(); await stopCamera();
  }catch(e){
    bannerSet('err','No se pudo canjear: ' + e.message);
    log('redeem error:', e);
    $('btnRedeem').disabled=false;
  }finally{
    redeemBusy=false;
  }
}

// ===== Escaneo =====
async function onScan(text){
  if (decodingGuard) return;
  decodingGuard = true; setTimeout(()=>decodingGuard=false, 800);
  try{
    const o = parsePayload(text);
    bannerSet('warn','Validando cupón…');
    await validate(o.uid, o.redemptionId);
  }catch(e){
    clearInfo(); bannerSet('err', e.message); log('scan parse error:', e);
  }
}

// ===== Cámara =====
async function listCameras(){
  try{
    // Pedimos permiso primero (Safari no da labels sin permiso)
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(t=>t.stop());

    const cams = await Html5Qrcode.getCameras();
    const sel = $('cameraSelect'); sel.innerHTML='';
    if (!cams || !cams.length){ sel.innerHTML='<option>Sin cámaras</option>'; return; }
    for (const c of cams){
      const opt = document.createElement('option'); opt.value=c.id; opt.textContent=c.label||c.id; sel.appendChild(opt);
    }
    const back = cams.find(c=>/back|rear|environment/i.test(c.label||'')) || cams[0];
    sel.value = back.id; currentDeviceId = back.id;
  }catch(e){
    // Fallback: sin permisos, usa facingMode
    const sel = $('cameraSelect'); sel.innerHTML='<option value="env">Cámara trasera</option>'; sel.value='env'; currentDeviceId='env';
    log('listCameras fallback:', e);
  }
}
function httpsHint(){
  if (location.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(location.hostname)){
    $('envWarning').textContent = '⚠ Para usar la cámara: abre esta página con HTTPS (o en localhost).';
    $('envWarning').hidden = false;
  }else{ $('envWarning').hidden = true; }
}
async function startCamera(){
  httpsHint();
  // Asegura que la librería esté lista
  const ok = await waitForQrLib(8000);
  if (!ok){ bannerSet('err','No se cargó la librería del lector QR.'); return; }

  try{
    if (qr){ try{ await qr.stop(); await qr.clear(); }catch{} }
    qr = new Html5Qrcode('reader');

    let source = $('cameraSelect').value || currentDeviceId;
    if (!source || source === 'env') source = { facingMode:'environment' };

    await qr.start(source, { fps:10, qrbox:280, rememberLastUsedCamera:true }, onScan, ()=>{});
    bannerSet('warn','Apunta la cámara al QR del cupón…');
  }catch(e){
    bannerSet('err','No fue posible iniciar la cámara: ' + e.message);
    log('startCamera error:', e);
  }
}
async function stopCamera(){ try{ if(qr){ await qr.stop(); await qr.clear(); } }catch(e){ log('stopCamera',e); } }

// ===== Modal =====
function openModal(){ const m=$('redeemModal'); m.classList.add('is-open'); m.setAttribute('aria-hidden','false'); }
function closeModal(){ const m=$('redeemModal'); m.classList.remove('is-open'); m.setAttribute('aria-hidden','true'); }

// ===== Boot =====
async function boot(){
  // Sesión anónima automática (no se muestra UI)
  try{ await auth.signInAnonymously(); }catch(e){ /* si tus reglas exigen auth != null, esto lo satisface */ }

  // Listeners UI
  $('btnStart').onclick = startCamera;
  $('btnStop').onclick  = stopCamera;
  $('btnTestCam').onclick = async ()=>{
    const msg = $('testCamMsg'); msg.textContent='Probando…';
    try{
      httpsHint(); const s = await navigator.mediaDevices.getUserMedia({video:true});
      s.getTracks().forEach(t=>t.stop()); msg.textContent='✅ Cámara OK';
    }catch(e){ msg.textContent='❌ ' + (e.name||'Error'); }
  };

  $('fileScan').addEventListener('change', async (ev)=>{
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try{
      await stopCamera();
      const tmp = new Html5Qrcode('reader');
      const text = await tmp.scanFile(file, true);
      await tmp.clear();
      await onScan(text);
    }catch(e){
      bannerSet('err','No se pudo leer el código en la imagen.');
      log('scanFromFile error:', e);
    }finally{
      ev.target.value = '';
    }
  });

  $('btnValidarManual').onclick = ()=>{
    const t = $('manualPayload').value.trim();
    if(!t){ bannerSet('warn','Pega el JSON del QR.'); return; }
    onScan(t);
  };
  $('btnValidarPorIds').onclick = async ()=>{
    const uid = $('uidInput').value.trim();
    const rid = $('ridInput').value.trim();
    if(!uid || !rid){ bannerSet('warn','Llena UID y Redemption ID.'); return; }
    clearInfo(); bannerSet('warn','Validando cupón…');
    try{ await validate(uid, rid); }catch(e){ bannerSet('err','No se pudo validar.'); log('validate by ids error:', e); }
  };
  $('btnCopyId').onclick = async ()=>{
    const id = $('r_id').textContent.trim();
    if(!id || id==='—'){ toast('Nada que copiar'); return; }
    try{ await navigator.clipboard.writeText(id); toast('ID copiado'); }catch{ toast('No se pudo copiar el ID'); }
  };
  $('btnRedeem').onclick = openModal;
  $('btnConfirmRedeem').onclick = redeemTx;
  $('btnCancelRedeem').onclick = closeModal;
  $('btnCloseModal').onclick = closeModal;

  document.addEventListener('visibilitychange', async ()=>{
    if (document.hidden) { await stopCamera(); }
  });

  // Inicial
  const ok = await waitForQrLib(8000);
  if (!ok){ bannerSet('err','No se cargó la librería del lector QR. Revisa tu conexión/CDN.'); return; }
  await listCameras();
}

document.addEventListener('DOMContentLoaded', boot);
