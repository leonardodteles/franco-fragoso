/* obra.js - Lógica do painel do cliente */
/* ═══════════════════════════════════════════
   CONTEXT (obra + código via querystring)
═══════════════════════════════════════════ */
const params = new URLSearchParams(window.location.search);
const OBRA_ID = params.get('id');
const ACCESS_CODE = (params.get('code') || '').toUpperCase();
const IS_ADMIN = params.get('admin') === '1';

/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
const DEPT_PALETTE = ['#1A6B9A','#B07010','#5E3FA0','#1A8A5B','#2A4E7A','#A04020','#1A7A60','#7A2A6B','#2A7A40','#8B4000','#1A4A7A','#6B1A6B'];
let DEPT_COLOR = {};
let TASKS_DEF = [];
let obraData = null;
let CHART_START_STR = null;
let CHART_END_STR = null;
let state = {};                 // { taskId: 'pending'|'progress'|'done' }
let fbSync = null;
let syncMode = 'local';
let isApplyingRemote = false;

// Variáveis de UI/edição (acessadas em render() e em handlers; mantemos
// declaradas no topo pra evitar TDZ — são reatribuídas mais abaixo)
let selectedTaskId = null;     // ID da linha selecionada (para "+ Subatividade")
let editingTaskId = null;      // ID em edição no modal de atividade
let linkingMode = false;       // Modo "Ligar" ativo?
let linkSourceId = null;       // No modo Ligar, ID da pred já selecionada
let propagCtx = null;          // Contexto do modal de propagação
let anchorCtx = null;          // Contexto do drag do anchor de dependência

const LS_PREFIX = 'ff_gantt_v4_';
const LS_NOTIF_KEY = 'ff_gantt_notif_v1';

function lsKey() { return LS_PREFIX + (OBRA_ID || 'default'); }

function loadLocal() {
  try { state = JSON.parse(localStorage.getItem(lsKey()) || '{}'); }
  catch(e) { state = {}; }
}
function saveLocal() {
  try { localStorage.setItem(lsKey(), JSON.stringify(state)); } catch(e) {}
}

function getStatus(id) { return state[id] || 'pending'; }

function cycleStatus(id) {
  if (!IS_ADMIN) return {prev:null, next:null}; // client read-only (guard #2)
  const cycle = { pending:'progress', progress:'done', done:'pending' };
  const prev = getStatus(id);
  const next = cycle[prev];
  state[id] = next;
  saveLocal();
  pushRemote(id, next);
  return {prev, next};
}

async function pushRemote(id, value) {
  if (!IS_ADMIN) return; // client read-only (guard #3)
  if (!fbSync) return;
  showSaving();
  try {
    await fbSync.set(fbSync.ref(fbSync.db, `progress/${OBRA_ID}/${id}`), value);
    await fbSync.set(fbSync.ref(fbSync.db, `meta/${OBRA_ID}/lastUpdate`), Date.now());
    // Carimba na própria tarefa quem mexeu por último (status conta como edição)
    const labelStatus = { pending:'Pendente', progress:'Em andamento', done:'Concluída' }[value] || value;
    const stamp = _currentUserStamp(`Alterou status para “${labelStatus}”`);
    if (stamp) {
      try {
        await fbSync.set(
          fbSync.ref(fbSync.db, `tasks/${OBRA_ID}/definition/${id}/lastUpdatedBy`),
          stamp
        );
      } catch(_) { /* não bloqueia o save principal */ }
    }
    showOnlineSaved();
  } catch(e) {
    console.warn('[sync] falha:', e);
    showError('Erro ao sincronizar');
  }
}

/* ═══════════════════════════════════════════
   SAVE INDICATOR
═══════════════════════════════════════════ */
const saveInd = () => document.getElementById('save-ind');
const saveLbl = () => document.getElementById('save-lbl');
function setIndicatorClass(cls) { const el = saveInd(); if (el) el.className = 'save-indicator ' + cls; }
function showSaving()      { setIndicatorClass('saving'); saveLbl().textContent = 'Salvando...'; }
function showOnlineSaved() { syncMode = 'online';  setIndicatorClass('live');    saveLbl().textContent = 'Online · sincronizado'; }
function showLocalSaved()  { syncMode = 'local';   setIndicatorClass('');        saveLbl().textContent = 'Salvo (local)'; }
function showOffline()     { syncMode = 'offline'; setIndicatorClass('offline'); saveLbl().textContent = 'Offline — salvo local'; }
function showError(msg)    { syncMode = 'error';   setIndicatorClass('error');   saveLbl().textContent = msg || 'Erro'; }

/* ═══════════════════════════════════════════
   HISTÓRICO DE EDIÇÃO (quem mexeu por último)
═══════════════════════════════════════════ */
// Cache local: uid -> { displayName, email }
const _userInfoCache = {};
async function _resolveUserInfo(uid) {
  if (!uid) return null;
  if (_userInfoCache[uid]) return _userInfoCache[uid];
  if (!fbSync) return null;
  try {
    const snap = await fbSync.get(fbSync.ref(fbSync.db, `users/${uid}`));
    const v = snap.val() || {};
    _userInfoCache[uid] = { displayName: v.displayName || null, email: v.email || null };
    return _userInfoCache[uid];
  } catch(_) { return null; }
}
function _currentUserStamp(action) {
  if (!IS_ADMIN || !fbSync || !fbSync.auth || !fbSync.auth.currentUser) return null;
  const u = fbSync.auth.currentUser;
  // Cacheia o próprio usuário com nome se já tiver perfil em memória
  _userInfoCache[u.uid] = _userInfoCache[u.uid] || {
    displayName: u.displayName || null,
    email: u.email || null,
  };
  const stamp = {
    uid: u.uid,
    name: u.displayName || null,
    email: u.email || null,
    at: Date.now(),
  };
  if (action) stamp.action = action; // descrição da ação (texto curto)
  return stamp;
}
function _formatRelativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1)   return 'agora há pouco';
  if (min < 60)  return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24)    return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30)    return `há ${d} dia${d>1?'s':''}`;
  // Acima disso, mostra data
  const dt = new Date(ts);
  return dt.toLocaleDateString('pt-BR');
}
function renderTaskHistoryLine(task) {
  const lu = task && task.lastUpdatedBy;
  if (!lu) {
    return `<div class="pop-history" style="opacity:.6"><em>Sem alterações registradas ainda.</em><br><span class="pop-history-when">O histórico aparece aqui após a próxima edição.</span></div>`;
  }
  const cached = _userInfoCache[lu.uid] || {};
  const who = lu.name || cached.displayName || lu.email || cached.email || 'Alguém';
  const when = _formatRelativeTime(lu.at);
  // Se ainda não temos nome, pede async (atualiza UI depois se quiser)
  if (!lu.name && !cached.displayName && lu.uid) {
    _resolveUserInfo(lu.uid);
  }
  const actionHtml = lu.action
    ? `<br><span class="pop-history-action">${escapeHtml(lu.action)}</span>`
    : '';
  return `<div class="pop-history">Última alteração por <strong>${escapeHtml(who)}</strong>${actionHtml}<br><span class="pop-history-when">${escapeHtml(when)}</span></div>`;
}
window.renderTaskHistoryLine = renderTaskHistoryLine;

/* ═══════════════════════════════════════════
   TOASTS
═══════════════════════════════════════════ */
function toast({title, msg, kind='success', duration=4200, icon}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (kind==='info'?'info':kind==='warn'?'warn':kind==='err'?'err':'');
  const ic = icon || (kind==='success'?'✓':kind==='info'?'ℹ':kind==='err'?'✕':'!');
  el.innerHTML = `
    <div class="toast-icon">${ic}</div>
    <div class="toast-body">
      <div class="toast-title">${title||''}</div>
      ${msg?`<div class="toast-msg">${msg}</div>`:''}
    </div>
    <button class="toast-close" aria-label="Fechar">×</button>
  `;
  stack.appendChild(el);
  const close = () => { el.classList.add('exit'); setTimeout(()=>el.remove(), 350); };
  el.querySelector('.toast-close').addEventListener('click', close);
  setTimeout(close, duration);
}

/* ═══════════════════════════════════════════
   ERROR SCREEN
═══════════════════════════════════════════ */
function showErrorScreen(title, msg) {
  document.getElementById('loading-screen').classList.add('hide');
  document.getElementById('main').style.display = 'none';
  document.getElementById('error-title').textContent = title;
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('error-screen').style.display = 'block';
}

function hideLoading() {
  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('hide');
    document.getElementById('main').style.display = 'block';
  }, 300);
}

/* ═══════════════════════════════════════════
   ACCESS VALIDATION + LOAD
═══════════════════════════════════════════ */
async function bootstrap() {
  if (!OBRA_ID) {
    showErrorScreen('Obra não informada', 'É preciso um código de acesso pra abrir uma obra.');
    return;
  }

  if (!fbSync) {
    showErrorScreen('Sem conexão', 'Não foi possível conectar ao servidor. Tente novamente em alguns instantes.');
    return;
  }

  // Modo admin: precisa estar autenticado pra que os writes passem na regra
  // "auth != null" do Firebase. Se o admin abriu essa aba sem ter feito login
  // antes em admin.html, oferecemos um redirect.
  if (IS_ADMIN && !(fbSync.auth && fbSync.auth.currentUser)) {
    showErrorScreen(
      'Sessão de admin expirada',
      'Faça login novamente em admin.html antes de abrir a obra. ' +
      'Sem login, o Firebase nega permissão para salvar alterações.'
    );
    // Botão de retorno
    setTimeout(() => {
      const errMsg = document.getElementById('error-msg');
      if (errMsg && !document.getElementById('go-admin-btn')) {
        const btn = document.createElement('a');
        btn.id = 'go-admin-btn';
        btn.href = 'admin.html';
        btn.textContent = 'Ir para o login do admin';
        btn.style.cssText = 'display:inline-block;margin-top:14px;padding:10px 18px;background:var(--teal,#1A7A9A);color:#fff;border-radius:8px;text-decoration:none;font-weight:600';
        errMsg.appendChild(document.createElement('br'));
        errMsg.appendChild(btn);
      }
    }, 50);
    return;
  }

  try {
    // Se não for admin, valida o código
    if (!IS_ADMIN) {
      if (!ACCESS_CODE) {
        showErrorScreen('Código de acesso ausente', 'Entre pela tela inicial usando um código.');
        return;
      }
      const codeSnap = await fbSync.get(fbSync.ref(fbSync.db, 'codes/' + ACCESS_CODE));
      const codeInfo = codeSnap.val();
      if (!codeInfo || codeInfo.obraId !== OBRA_ID || codeInfo.ativo === false) {
        showErrorScreen('Acesso negado', 'O código não corresponde a esta obra ou foi desativado.');
        return;
      }
    }

    // Carrega obra
    const obraSnap = await fbSync.get(fbSync.ref(fbSync.db, 'obras/' + OBRA_ID));
    obraData = obraSnap.val();
    if (!obraData) {
      showErrorScreen('Obra não encontrada', 'Essa obra foi removida ou nunca existiu.');
      return;
    }

    // Carrega branding (user padrão, com override por obra)
    await loadAndApplyBranding(obraData);

    // Preenche header com dados da obra
    document.title = `${obraData.nome} — ${currentBranding.companyName || 'Sistema de Acompanhamento'}`;
    document.getElementById('hdr-title').textContent = obraData.nome;
    document.getElementById('client-name').textContent = obraData.cliente || obraData.nome;
    document.getElementById('client-sub').textContent = obraData.sub || 'Cliente';
    document.getElementById('client-logo').textContent = (obraData.cliente || obraData.nome || '?').trim().charAt(0).toUpperCase();
    if (IS_ADMIN) {
      document.getElementById('admin-badge-wrap').style.display = '';
      document.body.classList.add('is-admin');
    }

    CHART_START_STR = obraData.start;
    CHART_END_STR   = obraData.end;

    // Carrega tasks e subscreve progresso
    subscribeTasks();
    subscribeProgress();
    subscribeFinancials();
    hideLoading();

  } catch(e) {
    console.error(e);
    showErrorScreen('Erro ao carregar', 'Não foi possível carregar os dados desta obra: ' + e.message);
  }
}

/* ═══════════════════════════════════════════
   BRANDING (white-label)
═══════════════════════════════════════════ */
let currentBranding = {
  companyName: 'Sistema de Acompanhamento',
  companyTag:  'Construa com clareza',
  primaryColor:'#1A7A9A',
  secondaryColor:'#2A5580',
  logoUrl: null,    // se tiver imagem
  logoInitial: 'P', // fallback colorido
};

async function loadAndApplyBranding(obraData) {
  try {
    let companyBranding = null;

    // Multi-tenant: branding vive em companies/{companyId}/branding.
    let companyId = obraData.companyId;

    // Fallback legado: se a obra ainda tem ownerUid (antes da migração) e
    // o usuário logado é admin, tenta resolver via users/{uid}/companyId.
    if (!companyId && IS_ADMIN && fbSync.auth && fbSync.auth.currentUser) {
      try {
        const uid = fbSync.auth.currentUser.uid;
        const profileSnap = await fbSync.get(fbSync.ref(fbSync.db, `users/${uid}`));
        const profile = profileSnap.val();
        if (profile && profile.companyId) companyId = profile.companyId;
      } catch(_) { /* ignore */ }
    }

    if (companyId) {
      try {
        const csnap = await fbSync.get(fbSync.ref(fbSync.db, `companies/${companyId}/branding`));
        companyBranding = csnap.val();
      } catch(e) {
        console.warn('[branding] falha ao ler company branding', e);
      }
    }

    // Fallback legado adicional: branding antigo em settings/users/{uid}/branding,
    // pra cobrir o intervalo entre subir o código novo e a migração rodar.
    if (!companyBranding) {
      let ownerUid = obraData.ownerUid;
      if (!ownerUid && IS_ADMIN && fbSync.auth && fbSync.auth.currentUser) {
        ownerUid = fbSync.auth.currentUser.uid;
      }
      if (ownerUid) {
        try {
          const usnap = await fbSync.get(fbSync.ref(fbSync.db, `settings/users/${ownerUid}/branding`));
          companyBranding = usnap.val();
        } catch(_) { /* sem permissão é ok */ }
      }
    }

    // Branding agora é só por empresa — ignoramos obraBranding (legado) por
    // completo, pra que mudanças na empresa sempre apareçam em todas as obras.
    // Merge: company > default
    const merged = Object.assign(
      {},
      currentBranding,
      companyBranding || {}
    );
    currentBranding = merged;
  } catch(e) {
    console.warn('[branding] falha ao carregar, usando padrão', e);
  }
  applyBranding();
}

/* ── Helpers de cor: derivam paleta completa + escolhem texto claro/escuro ── */
function _hexToRgb(hex) {
  const h = (hex || '').replace('#','').trim();
  if (h.length === 3) {
    return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16) };
  }
  if (h.length === 6) {
    return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
  }
  return null;
}
function _rgbToHex(r,g,b) {
  const c = n => Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0');
  return '#' + c(r) + c(g) + c(b);
}
function _mix(hex, target, amount) {
  // amount 0..1: 0 = mantém hex, 1 = vira target
  const a = _hexToRgb(hex), b = _hexToRgb(target);
  if (!a || !b) return hex;
  return _rgbToHex(
    a.r + (b.r - a.r) * amount,
    a.g + (b.g - a.g) * amount,
    a.b + (b.b - a.b) * amount
  );
}
function _darken(hex, amt)  { return _mix(hex, '#000000', amt); }
function _lighten(hex, amt) { return _mix(hex, '#FFFFFF', amt); }
// Luminância relativa (sRGB) — pra decidir texto claro/escuro
function _luminance(hex) {
  const c = _hexToRgb(hex);
  if (!c) return 0.5;
  const f = v => {
    const s = v / 255;
    return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4);
  };
  return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b);
}
function _isLight(hex) { return _luminance(hex) > 0.55; }
function _contrastText(bg) { return _isLight(bg) ? '#1A2D3D' : '#FFFFFF'; }
function _contrastTextSoft(bg) { return _isLight(bg) ? 'rgba(26,45,61,.65)' : 'rgba(255,255,255,.65)'; }
function _contrastTextSofter(bg) { return _isLight(bg) ? 'rgba(26,45,61,.45)' : 'rgba(255,255,255,.45)'; }

function applyBranding() {
  const b = currentBranding;
  const root = document.documentElement;

  const primary = b.primaryColor || '#1A7A9A';
  // Se não tem secundária, deriva uma versão mais escura da primária
  const secondary = b.secondaryColor || _darken(primary, 0.35);

  // ── Paleta derivada (consistente entre claro/escuro) ────────────────
  // Usamos a primária como o "destaque" (--teal) e uma cadeia escurecida
  // a partir da secundária pros tons "navy" do header e KPIs.
  // IMPORTANTE: --navy também é usado como cor de TEXTO em várias partes
  // (datas, títulos, tabs ativas) sobre fundo branco. Por isso, se a
  // secundária for muito clara, escurecemos até atingir contraste seguro.
  let navy = _darken(secondary, 0.10);
  let _safety = 0;
  while (_luminance(navy) > 0.42 && _safety++ < 8) navy = _darken(navy, 0.18);
  const navyDark   = _darken(navy, 0.30);
  const navyLight  = secondary;
  const teal       = primary;
  const tealBright = _lighten(primary, 0.10);
  const tealLight  = _lighten(primary, 0.82);

  // [v3] Mix navy×primária pra gradiente sutil do header — dá identidade
  // sem destoar (mantém escuro o suficiente pra texto branco contrastar).
  let navyMix = _mix(navy, primary, 0.30);
  // Garante que o mix continue escuro pra não quebrar contraste do texto
  let _mixSafety = 0;
  while (_luminance(navyMix) > 0.38 && _mixSafety++ < 6) navyMix = _darken(navyMix, 0.15);

  // Sobrescreve as variáveis usadas pelo CSS
  root.style.setProperty('--brand-color',   primary);
  root.style.setProperty('--brand-color-2', secondary);
  root.style.setProperty('--teal',          teal);
  root.style.setProperty('--teal-bright',   tealBright);
  root.style.setProperty('--teal-light',    tealLight);
  root.style.setProperty('--navy',          navy);
  root.style.setProperty('--navy-dark',     navyDark);
  root.style.setProperty('--navy-light',    navyLight);
  root.style.setProperty('--navy-mix',      navyMix);
  root.style.setProperty('--bar-proj',      teal);

  // ── Texto contrastante automático ───────────────────────────────────
  // Cores que vão SOBRE backgrounds escuros (header, KPIs, prog-strip).
  // Se a cor secundária for clara, o texto fica escuro; se escura, fica claro.
  const onNavy        = _contrastText(navy);
  const onNavyLight   = _contrastText(navyLight);
  const onNavySoft    = _contrastTextSoft(navy);
  const onNavySofter  = _contrastTextSofter(navy);
  const onNavyLightSoft   = _contrastTextSoft(navyLight);
  const onNavyLightSofter = _contrastTextSofter(navyLight);
  const onTeal        = _contrastText(teal);
  const onTealSoft    = _contrastTextSoft(teal);

  root.style.setProperty('--on-navy',              onNavy);
  root.style.setProperty('--on-navy-soft',         onNavySoft);
  root.style.setProperty('--on-navy-softer',       onNavySofter);
  root.style.setProperty('--on-navy-light',        onNavyLight);
  root.style.setProperty('--on-navy-light-soft',   onNavyLightSoft);
  root.style.setProperty('--on-navy-light-softer', onNavyLightSofter);
  root.style.setProperty('--on-teal',              onTeal);
  root.style.setProperty('--on-teal-soft',         onTealSoft);

  // RGB equivalentes pra usar em rgba() dinâmico (bordas, sombras suaves)
  const rgbNavy = _hexToRgb(navy);
  const rgbTeal = _hexToRgb(teal);
  if (rgbNavy) root.style.setProperty('--navy-rgb', `${rgbNavy.r}, ${rgbNavy.g}, ${rgbNavy.b}`);
  if (rgbTeal) root.style.setProperty('--teal-rgb', `${rgbTeal.r}, ${rgbTeal.g}, ${rgbTeal.b}`);

  // Texto da marca
  const nameEl = document.getElementById('brand-name');
  const tagEl  = document.getElementById('brand-tag');
  if (nameEl) nameEl.textContent = b.companyName || 'Sistema de Acompanhamento';
  if (tagEl)  tagEl.textContent  = b.companyTag  || 'Construa com clareza';

  // Hint e footer
  const hintBy = document.getElementById('hint-by');
  if (hintBy) hintBy.textContent = b.companyName ? `pela equipe ${b.companyName}` : '';
  const footerComp = document.getElementById('footer-company');
  if (footerComp) footerComp.textContent = `${b.companyName || 'Sistema de Acompanhamento'}${b.companyTag ? ' · ' + b.companyTag : ''}`;

  // Logo: se tem URL, usa imagem; senão, usa inicial colorida
  const fb = document.getElementById('brand-logo-fb');
  if (!fb) return;
  const parent = fb.parentNode;
  // Remove imagem antiga se houver
  const oldImg = parent.querySelector('.brand-logo-img');
  if (oldImg) oldImg.remove();

  if (b.logoUrl) {
    fb.style.display = 'none';
    const img = document.createElement('img');
    img.src = b.logoUrl;
    img.className = 'brand-logo-img';
    img.alt = b.companyName || 'Logo';
    img.onerror = () => {
      img.remove(); fb.style.display = '';
      _setPlanjarFallback(fb, b);
    };
    parent.insertBefore(img, fb);
  } else {
    fb.style.display = '';
    _setPlanjarFallback(fb, b);
  }
}

/* Fallback de logo: se a construtora não tem nome (ainda no onboarding) ou
   está usando o nome padrão "Sistema de Acompanhamento", mostra a logo oficial do Sistema de Acompanhamento.
   Caso tenha nome próprio sem logo, cai no formato inicial colorida. */
function _setPlanjarFallback(fb, b) {
  const isPlanjarOrEmpty = !b.companyName || /plan.?jar/i.test(b.companyName.trim());
  if (isPlanjarOrEmpty) {
    fb.innerHTML = '';
    fb.style.background = 'transparent';
    fb.style.padding = '0';
    const img = document.createElement('img');
    img.src = 'logo-planjar-mark.png';
    img.alt = 'Sistema de Acompanhamento';
    img.style.cssText = 'display:block;width:auto;height:50px;max-height:100%';
    fb.appendChild(img);
  } else {
    fb.style.background = '';
    fb.style.padding = '';
    const initial = (b.logoInitial || (b.companyName || 'P').trim().charAt(0)).toUpperCase();
    fb.textContent = initial;
  }
}

function subscribeTasks() {
  fbSync.onValue(fbSync.ref(fbSync.db, `tasks/${OBRA_ID}/definition`), snap => {
    const def = snap.val() || {};
    TASKS_DEF = Object.entries(def)
      .map(([id, t]) => ({ ...t, id }))
      .sort((a,b) => (a.order ?? 999) - (b.order ?? 999));

    // Constrói paleta dinâmica por departamento
    DEPT_COLOR = {};
    const depts = [...new Set(TASKS_DEF.map(t => t.dept).filter(Boolean))];
    depts.forEach((d, i) => DEPT_COLOR[d] = DEPT_PALETTE[i % DEPT_PALETTE.length]);

    // Se período da obra for vazio, deriva
    if (TASKS_DEF.length && (!CHART_START_STR || !CHART_END_STR)) {
      CHART_START_STR = TASKS_DEF.reduce((a,t) => !a || t.start < a ? t.start : a, null);
      CHART_END_STR   = TASKS_DEF.reduce((a,t) => !a || t.end > a ? t.end : a, null);
    }
    render();
    // Se a aba Financeiro está aberta nas sub-abas que dependem das tasks, re-renderiza
    if (currentMainTab === 'financeiro' &&
        (currentFinSub === 'servicos' || currentFinSub === 'medicoes' || currentFinSub === 'potes')) {
      renderFinanceiro();
    }
    // Recálculo automático do caminho crítico — debounce 600ms agrupa
    // múltiplas mudanças (drag em massa, import) numa única gravação.
    _scheduleAutoRecalc();
  }, err => {
    console.error('[tasks]', err);
    toast({title:'Erro ao carregar atividades', msg:err.message, kind:'err'});
  });
}

let remoteUpdatedIds = new Set();

function subscribeProgress() {
  fbSync.onValue(fbSync.ref(fbSync.db, `progress/${OBRA_ID}`), snap => {
    const remote = snap.val() || {};
    const changedIds = [];
    TASKS_DEF.forEach(t => {
      const before = state[t.id];
      const after  = remote[t.id] || 'pending';
      if (before !== after && before !== undefined) changedIds.push(t.id);
    });
    isApplyingRemote = true;
    const merged = {};
    TASKS_DEF.forEach(t => { if (remote[t.id]) merged[t.id] = remote[t.id]; });
    state = merged;
    saveLocal();
    changedIds.forEach(id => remoteUpdatedIds.add(id));
    render();
    isApplyingRemote = false;
    showOnlineSaved();
    if (changedIds.length) setTimeout(() => { remoteUpdatedIds.clear(); render(); }, 1500);
    // Status afeta o avanço físico — re-renderiza a aba Medições e o resumo
    if (currentMainTab === 'financeiro' && (currentFinSub === 'medicoes' || currentFinSub === 'servicos')) {
      renderFinanceiro();
    }
  }, err => {
    console.error('[progress]', err);
    showError('Sem permissão');
  });
}

window.addEventListener('firebase-ready', () => {
  fbSync = window.__FB__;
  window.addEventListener('online',  () => showOnlineSaved());
  window.addEventListener('offline', () => showOffline());
  bootstrap();
});
window.addEventListener('firebase-failed', () => {
  showErrorScreen('Erro no servidor', 'Não foi possível conectar ao banco de dados.');
});

/* ═══════════════════════════════════════════
   DATES
═══════════════════════════════════════════ */
function parseDate(str) { const [y,m,d] = str.split('-').map(Number); return new Date(y, m-1, d); }
function dayOff(str, ref) { return Math.round((parseDate(str) - ref) / 86400000); }
function fmtDate(str) {
  const [,m,d] = str.split('-');
  const mnames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${parseInt(d)} ${mnames[parseInt(m)-1]}`;
}
function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}
function fmtFull(date) {
  const dias = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  return `${dias[date.getDay()]}, ${date.getDate()} de ${meses[date.getMonth()]} de ${date.getFullYear()}`;
}
function fmtDateBr(iso) {
  if (!iso) return '—';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/* ═══════════════════════════════════════════
   NOTIFICATIONS
═══════════════════════════════════════════ */
let notifEnabled = false;
function loadNotifPref() {
  try { notifEnabled = localStorage.getItem(LS_NOTIF_KEY) === '1'; } catch(e){ notifEnabled = false; }
  updateNotifBtn();
}
function saveNotifPref() { try { localStorage.setItem(LS_NOTIF_KEY, notifEnabled ? '1':'0'); } catch(e){} }
function updateNotifBtn() {
  const btn = document.getElementById('notif-btn');
  const lbl = document.getElementById('notif-label');
  const ico = document.getElementById('notif-icon');
  if (!btn) return;
  if (!('Notification' in window)) {
    btn.classList.remove('on'); lbl.textContent = 'Indisponível'; ico.textContent = '🔕';
    btn.disabled = true; btn.style.opacity = '.55'; btn.style.cursor = 'not-allowed';
    return;
  }
  if (notifEnabled && Notification.permission === 'granted') {
    btn.classList.add('on'); lbl.textContent = 'Notificações ativas'; ico.textContent = '🔔';
  } else {
    btn.classList.remove('on'); lbl.textContent = 'Notificações'; ico.textContent = '🔕';
  }
}
async function toggleNotifications() {
  if (!('Notification' in window)) {
    toast({title:'Navegador não compatível', kind:'warn'}); return;
  }
  if (notifEnabled) {
    notifEnabled = false; saveNotifPref(); updateNotifBtn();
    toast({title:'Notificações desativadas', kind:'info', duration:2600});
    return;
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm === 'granted') {
    notifEnabled = true; saveNotifPref(); updateNotifBtn();
    toast({title:'Notificações ativadas', msg:'Você será alertado quando uma atividade for concluída.', kind:'success'});
    try { new Notification('Cronograma — ' + (currentBranding.companyName || 'Sistema de Acompanhamento'), {body:'Notificações ativadas ✓'}); } catch(e){}
  } else if (perm === 'denied') {
    toast({title:'Permissão bloqueada', msg:'Libere notificações nas configurações do navegador.', kind:'warn', duration:6000});
  }
}
function fireNotification(task, source='local') {
  if (!notifEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const prefix = source==='remote' ? '🔄 Concluída (outro dispositivo)' : '✓ Atividade concluída';
    new Notification(prefix, { body: `${task.name}\n${task.phase === 'PROJETOS' ? 'Projetos' : 'Obra'} — ${task.dept}`, tag: 'task-' + task.id });
  } catch(e) {}
}

/* ═══════════════════════════════════════════
   FILTER
═══════════════════════════════════════════ */
let currentFilter = 'all';
function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
}
function matchFilter(task) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'PROJETOS' || currentFilter === 'OBRA') return task.phase === currentFilter;
  const s = getStatus(task.id);
  if (currentFilter === 'pending')  return s === 'pending';
  if (currentFilter === 'progress') return s === 'progress';
  if (currentFilter === 'done')     return s === 'done';
  return true;
}

/* ═══════════════════════════════════════════
   MONTH SEGMENTS (dynamic range)
═══════════════════════════════════════════ */
function buildMonthSegments(startStr, endStr) {
  const ref = parseDate(startStr);
  const endDay = dayOff(endStr, ref);
  const segs = [];
  let cur = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const mnames = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
  while (true) {
    const nextMonth = new Date(cur.getFullYear(), cur.getMonth()+1, 1);
    const segStart = cur < ref ? ref : cur;
    const segEnd   = new Date(Math.min(nextMonth - 86400000, parseDate(endStr)));
    const s = Math.max(0, Math.round((segStart - ref) / 86400000));
    const e = Math.min(endDay, Math.round((segEnd - ref) / 86400000));
    if (e >= s) segs.push({ label: mnames[cur.getMonth()] + (cur.getFullYear() % 100 !== ref.getFullYear() % 100 ? '/' + String(cur.getFullYear()).slice(-2) : ''), days: e - s + 1, startDay: s });
    cur = nextMonth;
    if (cur > parseDate(endStr)) break;
  }
  return segs;
}

function buildWeekLabels(startStr, endStr) {
  const ref = parseDate(startStr);
  const endDay = dayOff(endStr, ref);
  const mnames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const labels = [];
  for (let d=0; d<=endDay; d+=7) {
    const date = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()+d);
    labels.push({ d, l: `${String(date.getDate()).padStart(2,'0')}/${mnames[date.getMonth()]}` });
  }
  return labels;
}

/* ═══════════════════════════════════════════
   RENDER
═══════════════════════════════════════════ */
const COL_NAME  = 280;
const COL_DAYS  = 48;
const COL_DATES = 88;
const COL_STAT  = 120;
const COL_REMAIN = 90;   // Prazo restante (admin)
const COL_TL_MIN = 500;

const STATUS_CFG = {
  pending:  { cls:'s-pending',  label:'Pendente'    },
  progress: { cls:'s-progress', label:'Em Andamento'},
  done:     { cls:'s-done',     label:'Concluído'   },
};

let justDoneIds = new Set();

/* Calcula prazo restante (em dias) para uma atividade.
   Regras:
   - se concluída, retorna null (mostra "—")
   - se hoje < início, retorna dias até o início (positivo, "para começar")
   - se hoje entre início e fim, retorna dias até o fim (positivo, "restantes")
   - se hoje > fim e não concluída, retorna número negativo ("atrasada") */
function computeRemaining(task, status) {
  if (status === 'done') return { days: null, kind: 'done' };
  const today = parseDate(todayStr());
  const start = parseDate(task.start);
  const end   = parseDate(task.end);
  const msDay = 86400000;
  if (today < start) {
    const diff = Math.round((start - today) / msDay);
    return { days: diff, kind: 'future', label: 'p/ iniciar' };
  }
  if (today > end) {
    const diff = Math.round((today - end) / msDay);
    return { days: -diff, kind: 'late', label: 'em atraso' };
  }
  // hoje entre início e fim — inclui o dia de hoje
  const diff = Math.round((end - today) / msDay) + 1;
  const kind = diff <= 3 ? 'soon' : 'ok';
  return { days: diff, kind, label: 'restantes' };
}

function fmtRemaining(rem) {
  if (rem.kind === 'done') return `<div class="remain-val remain-done">—</div><div class="remain-unit">concluída</div>`;
  if (rem.kind === 'late') {
    const abs = Math.abs(rem.days);
    return `<div class="remain-val remain-late">−${abs}d</div><div class="remain-unit">em atraso</div>`;
  }
  const cls = rem.kind === 'future' ? 'remain-future' : (rem.kind === 'soon' ? 'remain-soon' : 'remain-ok');
  return `<div class="remain-val ${cls}">${rem.days}d</div><div class="remain-unit">${rem.label}</div>`;
}

function render() {
  const root = document.getElementById('gantt-root');

  if (!TASKS_DEF.length) {
    root.innerHTML = `
      <div class="empty-schedule">
        <div class="big-icon">📋</div>
        <h3>Cronograma em preparação</h3>
        <p>A construtora ainda não importou as atividades desta obra. Assim que a planilha for enviada, o cronograma aparece aqui automaticamente.</p>
      </div>`;
    // Zera KPIs
    ['kpi-total','kpi-done','kpi-prog','kpi-pend'].forEach(id => document.getElementById(id).textContent = '0');
    document.getElementById('prog-fill').style.width = '0%';
    document.getElementById('prog-pct').textContent = '0%';
    document.getElementById('hdr-sub').textContent = 'Aguardando importação da planilha';
    document.getElementById('today-badge').textContent = `Hoje: ${fmtFull(new Date())}`;
    return;
  }

  if (!CHART_START_STR || !CHART_END_STR) return;

  const CHART_REF = parseDate(CHART_START_STR);
  const TOTAL_DAYS = dayOff(CHART_END_STR, CHART_REF) + 1;

  const today = new Date();
  const todayS = todayStr();
  const todayOff = dayOff(todayS, CHART_REF);

  // Header subtitle: "Abril – Junho 2026"
  const startD = parseDate(CHART_START_STR), endD = parseDate(CHART_END_STR);
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const periodLabel = startD.getFullYear() === endD.getFullYear()
    ? `${meses[startD.getMonth()]} – ${meses[endD.getMonth()]} ${startD.getFullYear()}`
    : `${meses[startD.getMonth()]}/${startD.getFullYear()} – ${meses[endD.getMonth()]}/${endD.getFullYear()}`;
  document.getElementById('hdr-sub').textContent = `${periodLabel}  ·  Atualizado em ${fmtFull(today)}`;
  document.getElementById('today-badge').textContent = `Hoje: ${fmtFull(today)}`;
  document.getElementById('footer-rev').textContent = `Cronograma de Obra — Atualizado ${today.toLocaleDateString('pt-BR')}`;

  // KPIs
  const total = TASKS_DEF.length;
  const done  = TASKS_DEF.filter(t => getStatus(t.id) === 'done').length;
  const prog  = TASKS_DEF.filter(t => getStatus(t.id) === 'progress').length;
  const pend  = total - done - prog;
  const pct   = Math.round((done / total) * 100);

  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('prog-pct').textContent  = pct + '%';
  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-done').textContent  = done;
  document.getElementById('kpi-prog').textContent  = prog;
  document.getElementById('kpi-pend').textContent  = pend;
  document.getElementById('kpi-end').textContent   = fmtDateBr(CHART_END_STR);

  const critTask = TASKS_DEF.find(t => t.critical);
  if (critTask) {
    const firstWord = critTask.name.split(/\s+/)[0];
    document.getElementById('kpi-crit').textContent = `${firstWord} — ${critTask.days}d`;
  } else {
    document.getElementById('kpi-crit').textContent = '—';
  }

  // Layout
  const availW = root.parentElement.clientWidth || 1100;
  const remainW = IS_ADMIN ? COL_REMAIN : 0;
  const tlW = Math.max(COL_TL_MIN, availW - COL_NAME - COL_DAYS - COL_DATES - COL_STAT - remainW - 4);
  const ppd = tlW / TOTAL_DAYS;
  const todayX = Math.max(0, Math.min(tlW, todayOff * ppd));

  const months = buildMonthSegments(CHART_START_STR, CHART_END_STR);
  const weekStarts = [];
  for (let d=0; d<=TOTAL_DAYS; d+=7) weekStarts.push(d);
  const weekLabels = buildWeekLabels(CHART_START_STR, CHART_END_STR);

  const colspanHdr = IS_ADMIN ? 5 : 4;
  const remainCol = IS_ADMIN ? `<col style="width:${COL_REMAIN}px">` : '';
  const remainHdr = IS_ADMIN ? `<th class="th-center col-remain" title="Prazo restante (visível só para admin)">Prazo Rest.</th>` : '';

  let h = `<table class="gantt">
  <colgroup>
    <col style="width:${COL_NAME}px">
    <col style="width:${COL_DAYS}px">
    <col style="width:${COL_DATES}px">
    <col style="width:${COL_STAT}px">
    ${remainCol}
    <col style="width:${tlW}px">
  </colgroup>
  <thead>
    <tr class="row-months">
      <th class="th-tl col-name">Atividade / Entregável</th>
      <th class="th-center col-days">Dias</th>
      <th class="th-center col-dates">Entrega</th>
      <th class="th-center col-status">Status</th>
      ${remainHdr}
      <th style="padding:0;background:var(--c-navy)">
        <div style="display:flex">`;

  months.forEach(m => {
    h += `<div style="flex:none;width:${m.days*ppd}px;text-align:center;padding:8px 0;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#fff;border-right:1px solid rgba(255,255,255,0.12)">${m.label}</div>`;
  });

  h += `</div></th></tr>
    <tr class="row-weeks">
      <td class="td-blank" colspan="${colspanHdr}" style="border-right:2px solid rgba(255,255,255,0.1)"></td>
      <td style="position:relative;height:22px;padding:0">`;

  h += `<div class="today-pin-tl" style="left:${todayX}px">Hoje</div>`;
  h += `<div class="today-vline" style="left:${todayX}px;top:0"></div>`;

  weekLabels.forEach(w => {
    if (w.d > 0 && w.d < TOTAL_DAYS) h += `<div style="position:absolute;left:${w.d*ppd}px;top:0;bottom:0;border-left:1px solid rgba(255,255,255,0.08);padding-left:3px;display:flex;align-items:center"><span style="font-size:8px;color:rgba(255,255,255,0.38);white-space:nowrap">${w.l}</span></div>`;
  });

  h += `</td></tr>
  </thead><tbody>`;

  // Calcula folga (slack) por CPM completo — só para tarefas com dependências
  const slackById = computeSlackForAll();

  let lastPhase = null;
  let rowIndex = 0;
  TASKS_DEF.forEach((t, idx) => {
    if (t.phase !== lastPhase) {
      const hasVisible = TASKS_DEF.some(f => f.phase === t.phase && matchFilter(f));
      if (hasVisible) {
        lastPhase = t.phase;
        const icon  = t.phase === 'PROJETOS' ? '📐' : '🏗';
        const lbl   = t.phase === 'PROJETOS' ? 'PROJETOS E APROVAÇÕES' : 'EXECUÇÃO DE OBRA';
        const phcls = t.phase === 'PROJETOS' ? 'ph-proj' : 'ph-obra';
        h += `<tr class="phase-row ${phcls}"><td colspan="${IS_ADMIN ? 6 : 5}">${icon}&ensp;${lbl}</td></tr>`;
      } else {
        lastPhase = t.phase;
      }
    }

    if (!matchFilter(t)) return;

    const st  = getStatus(t.id);
    const sc  = STATUS_CFG[st];
    const rowBg = rowIndex % 2 === 0 ? '#fff' : 'var(--row-alt)';
    rowIndex++;
    const doneCls = st === 'done' ? 'done' : '';
    const justDoneCls = justDoneIds.has(t.id) ? 'just-done' : '';
    const remoteCls = remoteUpdatedIds.has(t.id) ? 'remote-update' : '';
    const pendingCls = (typeof pendingChanges !== 'undefined' && pendingChanges.has(t.id)) ? 'has-pending' : '';
    const selectedCls = (selectedTaskId === t.id) ? 'row-selected' : '';
    const animDelay = Math.min(rowIndex * 22, 600);

    const sDay = Math.max(0, dayOff(t.start, CHART_REF));
    const eDay = Math.min(TOTAL_DAYS, dayOff(t.end, CHART_REF) + 1);
    const barL = sDay * ppd;
    const barW = Math.max(3, (eDay - sDay) * ppd);

    // Cor da barra agora é por STATUS (pendente/andamento/concluída/atrasada),
    // não mais por fase. Mantemos `bar-crit` (caminho crítico) intacto, pois é
    // uma camada visual diferente: borda em volta da barra.
    const remInfo = computeRemaining(t, st);
    const isLate = remInfo && remInfo.kind === 'late' && st !== 'done';

    let barColor;
    let barTextColor = '#fff';
    if (st === 'done') {
      barColor = 'var(--bar-done)';
      barTextColor = 'var(--bar-done-text)';
    } else if (isLate) {
      barColor = 'var(--bar-late)';
    } else if (st === 'progress') {
      barColor = 'var(--bar-progress)';
    } else {
      // pending — cinza neutro, texto escuro pra contraste
      barColor = 'var(--bar-pending)';
      barTextColor = 'var(--bar-pending-text)';
    }
    let barClass = 'bar bar-' + (st === 'done' ? 'done' : isLate ? 'late' : st);
    let barStyle = `left:${barL}px;width:${barW}px;background:${barColor};color:${barTextColor};animation-delay:${animDelay}ms`;
    // Caminho crítico: contorno por cima, mantém a regra original
    if (t.critical) {
      barClass += ' bar-crit';
      barStyle = `left:${barL}px;width:${barW}px;background:${barColor};color:${barTextColor};animation-delay:${animDelay}ms`;
    }
    const checkmark = st === 'done' ? '✓ ' : '';
    const daysLabel = barW > 28 ? (t.days + 'd') : '';

    // Folga (slack) — só para admin e quando há dependências definidas
    const slack = slackById[t.id];
    let slackHtml = '';
    if (IS_ADMIN && slack !== undefined && slack !== null) {
      const sc2 = slack === 0 ? 'slack-zero' : (slack <= 2 ? 'slack-low' : 'slack-ok');
      const txt = slack === 0 ? 'CRÍTICA' : `+${slack}d folga`;
      slackHtml = `<div class="slack-tag ${sc2}" title="Folga calculada por CPM">${txt}</div>`;
    }

    // Prazo restante (somente admin)
    const remainCell = IS_ADMIN
      ? `<td class="td-remaining">${fmtRemaining(computeRemaining(t, st))}${slackHtml}</td>`
      : '';

    // Handles de resize + anchor de ligar (somente admin, criados via JS)
    const handlesHtml = IS_ADMIN
      ? '<div class="resize-handle left" data-edge="left"></div><div class="resize-handle right" data-edge="right"></div><div class="dep-anchor" data-anchor title="Arraste até outra barra para criar dependência"></div>'
      : '';

    // Coluna de dias: admin pode editar (recalcula a data fim ao salvar)
    const daysCell = IS_ADMIN
      ? `<td class="td-days td-days-edit">
           <input type="number" min="1" max="999" step="1" value="${t.days}" data-days-input="${t.id}" class="days-input" title="Edite e pressione Enter para recalcular a data fim">
           <div class="dunit">dias</div>
         </td>`
      : `<td class="td-days"><div class="dval">${t.days}</div><div class="dunit">dias</div></td>`;

    // Chip mostrando predecessoras (admin)
    let depChipHtml = '';
    const deps = getDeps(t);
    if (IS_ADMIN && deps.length > 0) {
      const txt = deps.length === 1 ? `↳ ${deps[0].predId}` : `↳ ${deps.length} pred.`;
      const tooltip = deps.map(d => {
        const p = TASKS_DEF.find(x => x.id === d.predId);
        return (p ? p.name : d.predId) + (d.lag ? ` (lag ${d.lag>0?'+':''}${d.lag}d)` : '');
      }).join('\n');
      depChipHtml = `<span class="dep-chip" title="Predecessoras:\n${escapeHtml(tooltip)}">${escapeHtml(txt)}</span>`;
    }

    // Indicador de subatividade
    const subCls = t.parentId ? 'tname-sub' : '';

    // Botão de ações por linha (admin)
    const actionsBtn = IS_ADMIN
      ? `<button class="row-actions-btn" onclick="event.stopPropagation();showRowPopover(event,'${t.id}')" title="Mais ações">⋯</button>`
      : '';

    h += `<tr class="task-row ${doneCls} ${justDoneCls} ${remoteCls} ${pendingCls} ${selectedCls}" style="background:${rowBg};animation-delay:${animDelay}ms" data-task-id="${t.id}" onclick="onRowClick(event,'${t.id}')">
      <td class="td-name">
        <div class="tname ${subCls}">${t.critical ? '⚡ ' : ''}${checkmark}${escapeHtml(t.name)}${depChipHtml}${actionsBtn}</div>
        <div class="tdept">
          <span class="dept-dot" style="background:${DEPT_COLOR[t.dept]||'#888'}"></span>
          ${escapeHtml(t.dept||'')}
        </div>
      </td>
      ${daysCell}
      <td class="td-dates"><div class="dstart">${fmtDate(t.start)}</div><div class="dend">${fmtDate(t.end)}</div></td>
      <td class="td-status">
        <div class="status-pill ${sc.cls}" onclick="onStatusClick(event,'${t.id}')" title="${IS_ADMIN ? 'Clique para alterar status' : ''}">
          ${sc.label}
        </div>
      </td>
      ${remainCell}
      <td class="td-timeline" data-task-id="${t.id}" data-ppd="${ppd}" data-tlw="${tlW}">
        ${weekStarts.filter(d=>d>0&&d<TOTAL_DAYS).map(d=>`<div class="wline" style="left:${d*ppd}px"></div>`).join('')}
        <div class="today-vline" style="left:${todayX}px;top:0"></div>
        <div class="${barClass}" style="${barStyle}" data-task-id="${t.id}" data-bar>
          ${handlesHtml}
          <span>${daysLabel}</span>
        </div>
      </td>
    </tr>`;
  });

  h += `</tbody></table>`;
  root.innerHTML = h;

  // Ativa drag/resize só pra admin
  if (IS_ADMIN) {
    attachBarInteractions();
    attachDaysInputs();
    attachDepAnchors();
  }

  // Desenha setas das dependências (clientes e admin veem)
  drawDependencyArrows();

  if (justDoneIds.size) setTimeout(() => { justDoneIds.clear(); }, 900);
}

/* Liga listeners aos inputs de dias na coluna do Gantt. Quando o admin
   altera o número e tira o foco (ou aperta Enter), recalculamos a data
   fim de forma proporcional ao novo número de dias e salvamos no banco. */
function attachDaysInputs() {
  document.querySelectorAll('input[data-days-input]').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = TASKS_DEF.find(t => t.id === inp.dataset.daysInput)?.days || ''; inp.blur(); }
    });
    inp.addEventListener('focus', e => e.target.select());
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('blur', onDaysInputBlur);
  });
}

async function onDaysInputBlur(e) {
  if (!IS_ADMIN || !fbSync) return;
  const inp = e.target;
  const id = inp.getAttribute('data-days-input');
  if (!id) return;
  const t = TASKS_DEF.find(x => x.id === id);
  if (!t) return;

  const newDays = Math.max(1, Math.min(999, Math.round(Number(inp.value) || 0)));
  if (!newDays) { inp.value = t.days; return; }
  if (newDays === t.days) return;  // sem mudança

  // Calcula a nova data fim a partir da data início + (newDays - 1).
  // Usamos -1 porque o cálculo de "dias" inclui o dia inicial: ex. start
  // 01/01 e end 03/01 = 3 dias.
  const startDate = new Date(t.start + 'T00:00:00');
  const newEnd = new Date(startDate.getTime() + (newDays - 1) * 86400000);
  const newEndIso = newEnd.toISOString().slice(0, 10);

  showSaving();
  try {
    const updates = {};
    updates[`tasks/${OBRA_ID}/definition/${t.id}/days`] = newDays;
    updates[`tasks/${OBRA_ID}/definition/${t.id}/end`]  = newEndIso;
    const stamp = _currentUserStamp(`Alterou duração para ${newDays} dia${newDays>1?'s':''}`);
    if (stamp) updates[`tasks/${OBRA_ID}/definition/${t.id}/lastUpdatedBy`] = stamp;
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    toast({title:'Duração atualizada', msg:`${escapeHtml(t.name)} agora tem ${newDays} dia${newDays>1?'s':''} (até ${fmtDate(newEndIso)})`});
    // O onValue listener já vai redesenhar quando o servidor confirmar.
  } catch(err) {
    console.error('[onDaysInputBlur]', err);
    showError('Erro ao salvar duração');
    toast({title:'Erro ao salvar', msg:err.message, kind:'err'});
    inp.value = t.days;  // reverte visual
  }
}

function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

/* ═══════════════════════════════════════════
   GANTT EDIT (drag & resize de barras) — admin
═══════════════════════════════════════════ */
let dragCtx = null;     // contexto do arrasto atual
let pendingDateSave = null; // último estado a salvar
let saveDebounceTimer = null;

function isoFromDayOff(dayOff) {
  const d = parseDate(CHART_START_STR);
  d.setDate(d.getDate() + dayOff);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

function showDragTooltip(x, y, label, content) {
  const tip = document.getElementById('drag-tooltip');
  document.getElementById('drag-tip-label').textContent = label;
  document.getElementById('drag-tip-content').innerHTML = content;
  tip.style.left = (x + 14) + 'px';
  tip.style.top  = (y + 14) + 'px';
  tip.classList.add('show');
}
function hideDragTooltip() {
  document.getElementById('drag-tooltip').classList.remove('show');
}

function attachBarInteractions() {
  document.querySelectorAll('[data-bar]').forEach(bar => {
    // Evita registrar duas vezes (renderização re-cria os elementos, então isso é seguro)
    bar.addEventListener('mousedown', onBarMouseDown);
    bar.addEventListener('touchstart', onBarMouseDown, { passive:false });
  });
}

function onBarMouseDown(e) {
  if (!IS_ADMIN) return;
  // Ignora se for um clique simples na pílula de status (evento separado)
  // Mas o bar não tem pill dentro — então qualquer clique aqui inicia o drag.

  const isTouch = e.type === 'touchstart';
  const point = isTouch ? e.touches[0] : e;
  const target = e.target;
  const bar = e.currentTarget;
  const taskId = bar.dataset.taskId;
  const task = TASKS_DEF.find(t => t.id === taskId);
  if (!task) return;

  // Identifica se é resize (pega borda) ou move (pega centro)
  let mode = 'move';
  if (target.classList && target.classList.contains('resize-handle')) {
    mode = target.dataset.edge === 'left' ? 'resize-left' : 'resize-right';
  }

  e.preventDefault();
  e.stopPropagation();

  const cell = bar.parentElement; // td.td-timeline
  const ppd = parseFloat(cell.dataset.ppd);
  const tlW = parseFloat(cell.dataset.tlw);

  const rect = bar.getBoundingClientRect();
  const startX = point.clientX;
  const initialLeft = parseFloat(bar.style.left) || 0;
  const initialWidth = parseFloat(bar.style.width) || rect.width;

  dragCtx = {
    taskId, mode, ppd, tlW, bar, cell, task,
    startX, initialLeft, initialWidth,
    moved: false,
    origStart: task.start, origEnd: task.end,
    newStart: task.start, newEnd: task.end
  };

  bar.classList.add('dragging');

  if (isTouch) {
    document.addEventListener('touchmove', onBarMouseMove, { passive:false });
    document.addEventListener('touchend', onBarMouseUp);
    document.addEventListener('touchcancel', onBarMouseUp);
  } else {
    document.addEventListener('mousemove', onBarMouseMove);
    document.addEventListener('mouseup', onBarMouseUp);
  }
}

function onBarMouseMove(e) {
  if (!dragCtx) return;
  const isTouch = e.type === 'touchmove';
  const point = isTouch ? e.touches[0] : e;

  if (isTouch) e.preventDefault();

  const dx = point.clientX - dragCtx.startX;
  if (Math.abs(dx) > 2) dragCtx.moved = true;

  const ppd = dragCtx.ppd;
  // dia mínimo é 1 (barra com 1 dia)
  const minWidth = Math.max(3, ppd);
  let newLeft = dragCtx.initialLeft;
  let newWidth = dragCtx.initialWidth;

  if (dragCtx.mode === 'move') {
    newLeft = dragCtx.initialLeft + dx;
    // Limites: não passa do início (0) nem do fim (tlW)
    newLeft = Math.max(0, Math.min(dragCtx.tlW - newWidth, newLeft));
  } else if (dragCtx.mode === 'resize-left') {
    // arrasta borda esquerda: muda left e width inversamente
    let proposedLeft = dragCtx.initialLeft + dx;
    proposedLeft = Math.max(0, Math.min(dragCtx.initialLeft + dragCtx.initialWidth - minWidth, proposedLeft));
    newWidth = dragCtx.initialWidth + (dragCtx.initialLeft - proposedLeft);
    newLeft = proposedLeft;
  } else if (dragCtx.mode === 'resize-right') {
    newWidth = dragCtx.initialWidth + dx;
    newWidth = Math.max(minWidth, Math.min(dragCtx.tlW - dragCtx.initialLeft, newWidth));
  }

  dragCtx.bar.style.left = newLeft + 'px';
  dragCtx.bar.style.width = newWidth + 'px';

  // Snap em dias inteiros pra calcular novas datas
  const startDay = Math.round(newLeft / ppd);
  const endDay   = Math.round((newLeft + newWidth) / ppd) - 1;  // inclusivo

  const newStart = isoFromDayOff(Math.max(0, startDay));
  const newEnd   = isoFromDayOff(Math.max(startDay, endDay));

  dragCtx.newStart = newStart;
  dragCtx.newEnd   = newEnd;

  // Atualiza colunas de "Dias" e "Entrega" em tempo real
  updateRowVisualLive(dragCtx.taskId, newStart, newEnd);

  // Tooltip
  const days = Math.max(1, daysBetween(newStart, newEnd));
  const label = dragCtx.mode === 'move' ? 'Movendo atividade' : 'Redimensionando';
  showDragTooltip(point.clientX, point.clientY, label,
    `<strong>${fmtDateBr(newStart)}</strong> → <strong>${fmtDateBr(newEnd)}</strong><br>${days} dia${days===1?'':'s'}`
  );
}

function onBarMouseUp(e) {
  if (!dragCtx) return;
  const ctx = dragCtx;
  dragCtx = null;

  document.removeEventListener('mousemove', onBarMouseMove);
  document.removeEventListener('mouseup', onBarMouseUp);
  document.removeEventListener('touchmove', onBarMouseMove);
  document.removeEventListener('touchend', onBarMouseUp);
  document.removeEventListener('touchcancel', onBarMouseUp);

  ctx.bar.classList.remove('dragging');
  hideDragTooltip();

  if (!ctx.moved) return;

  const datesChanged = ctx.newStart !== ctx.origStart || ctx.newEnd !== ctx.origEnd;
  if (!datesChanged) return;

  // Atualiza estado local (visual)
  const task = TASKS_DEF.find(t => t.id === ctx.taskId);
  if (task) {
    task.start = ctx.newStart;
    task.end = ctx.newEnd;
    task.days = daysBetween(ctx.newStart, ctx.newEnd);
  }

  // Adiciona ao buffer de mudanças pendentes (NÃO salva ainda)
  addPendingChange(ctx.taskId, ctx.origStart, ctx.origEnd, ctx.newStart, ctx.newEnd);

  // Re-renderiza
  render();
}

/* ═══════════════════════════════════════════
   BUFFER DE MUDANÇAS PENDENTES (admin)
═══════════════════════════════════════════ */
// Mapa: taskId → { origStart, origEnd, newStart, newEnd } (mantém o ORIGINAL antes de qualquer mudança nessa sessão)
const pendingChanges = new Map();
// Pilha de undo: cada entry é { taskId, beforeStart, beforeEnd, afterStart, afterEnd }
const undoStack = [];

function addPendingChange(taskId, beforeStart, beforeEnd, afterStart, afterEnd) {
  // Se já tinha pending pra esse task, mantém origStart/origEnd originais e atualiza só o "new"
  const existing = pendingChanges.get(taskId);
  const origStart = existing ? existing.origStart : beforeStart;
  const origEnd   = existing ? existing.origEnd   : beforeEnd;

  // Se voltou ao original, remove a entry (sem mudança líquida)
  if (afterStart === origStart && afterEnd === origEnd) {
    pendingChanges.delete(taskId);
  } else {
    pendingChanges.set(taskId, { origStart, origEnd, newStart:afterStart, newEnd:afterEnd });
  }

  // Pilha de undo registra cada step individual
  undoStack.push({ taskId, beforeStart, beforeEnd, afterStart, afterEnd });

  updatePendingBar();
}

function updatePendingBar() {
  const bar = document.getElementById('pending-bar');
  if (!bar) return;
  const n = pendingChanges.size;
  if (n === 0) {
    bar.classList.remove('show', 'saving');
    return;
  }
  bar.classList.add('show');
  bar.classList.remove('saving');
  document.getElementById('pending-icon').textContent = '!';
  document.getElementById('pending-title').textContent =
    `${n} alteraç${n===1?'ão':'ões'} de cronograma não salva${n===1?'':'s'}`;
  // Lista os primeiros tasks alterados
  const ids = [...pendingChanges.keys()].slice(0, 3);
  const names = ids.map(id => {
    const t = TASKS_DEF.find(x => x.id === id);
    return t ? t.name : id;
  });
  let sub = names.join(' · ');
  if (n > 3) sub += ` · e mais ${n-3}`;
  document.getElementById('pending-sub').textContent = sub;

  // Reseta estado do botão Salvar (BUGFIX: depois de um save bem-sucedido, se o usuário
  // arrastasse outra barra, o botão ficava preso em "Salvando…" porque updatePendingBar
  // só reabilitava o botão no catch de erro, nunca quando a barra reaparecia)
  const btnSave = document.getElementById('btn-save-pending');
  const btnSaveLbl = document.getElementById('btn-save-pending-label');
  if (btnSave) btnSave.disabled = false;
  if (btnSaveLbl) btnSaveLbl.textContent = 'Salvar alterações';

  // Botão Undo só ativo se tem stack
  document.getElementById('btn-undo').disabled = undoStack.length === 0;
}

function undoLastChange() {
  if (undoStack.length === 0) return;
  const last = undoStack.pop();
  // Reverte a alteração no TASKS_DEF
  const task = TASKS_DEF.find(t => t.id === last.taskId);
  if (task) {
    task.start = last.beforeStart;
    task.end = last.beforeEnd;
    task.days = daysBetween(last.beforeStart, last.beforeEnd);
  }
  // Atualiza pending: se voltou ao original, remove; senão mantém com o novo "after"
  const existing = pendingChanges.get(last.taskId);
  if (existing) {
    if (last.beforeStart === existing.origStart && last.beforeEnd === existing.origEnd) {
      pendingChanges.delete(last.taskId);
    } else {
      pendingChanges.set(last.taskId, { ...existing, newStart:last.beforeStart, newEnd:last.beforeEnd });
    }
  }
  updatePendingBar();
  render();
  toast({title:'Alteração desfeita', kind:'info', duration:1800});
}
window.undoLastChange = undoLastChange;

function discardAllChanges() {
  if (pendingChanges.size === 0) return;
  if (!confirm(`Descartar ${pendingChanges.size} alteraç${pendingChanges.size===1?'ão':'ões'} pendente${pendingChanges.size===1?'':'s'} no cronograma?`)) return;
  // Restaura cada task ao estado original
  pendingChanges.forEach((ch, taskId) => {
    const task = TASKS_DEF.find(t => t.id === taskId);
    if (task) {
      task.start = ch.origStart;
      task.end   = ch.origEnd;
      task.days  = daysBetween(ch.origStart, ch.origEnd);
    }
  });
  pendingChanges.clear();
  undoStack.length = 0;
  updatePendingBar();
  render();
  toast({title:'Alterações descartadas', kind:'info'});
}
window.discardAllChanges = discardAllChanges;

async function saveAllPendingChanges() {
  if (pendingChanges.size === 0) return;
  if (!IS_ADMIN || !fbSync) return;

  const bar = document.getElementById('pending-bar');
  const btnSave = document.getElementById('btn-save-pending');
  const btnSaveLbl = document.getElementById('btn-save-pending-label');
  bar.classList.add('saving');
  document.getElementById('pending-icon').textContent = '⟳';
  document.getElementById('pending-title').textContent = 'Salvando alterações…';
  btnSave.disabled = true;
  btnSaveLbl.textContent = 'Salvando…';
  showSaving();

  // Snapshot de quais tarefas mudaram (para propagação) ANTES de limpar pending
  const changedSnapshot = [];
  pendingChanges.forEach((ch, taskId) => {
    const deltaStart = _diffDays(_toDate(ch.origStart), _toDate(ch.newStart));
    const deltaEnd = _diffDays(_toDate(ch.origEnd), _toDate(ch.newEnd));
    if (deltaStart || deltaEnd) {
      changedSnapshot.push({ taskId, deltaStart, deltaEnd });
    }
  });

  try {
    const updates = {};
    const n = pendingChanges.size;
    const stamp = _currentUserStamp(n > 1 ? 'Reposicionou no cronograma (em lote)' : 'Reposicionou no cronograma');
    pendingChanges.forEach((ch, taskId) => {
      const days = daysBetween(ch.newStart, ch.newEnd);
      updates[`tasks/${OBRA_ID}/definition/${taskId}/start`] = ch.newStart;
      updates[`tasks/${OBRA_ID}/definition/${taskId}/end`]   = ch.newEnd;
      updates[`tasks/${OBRA_ID}/definition/${taskId}/days`]  = days;
      if (stamp) updates[`tasks/${OBRA_ID}/definition/${taskId}/lastUpdatedBy`] = stamp;
    });
    updates[`tasks/${OBRA_ID}/updatedAt`] = Date.now();
    updates[`meta/${OBRA_ID}/lastUpdate`] = Date.now();
    await fbSync.update(fbSync.ref(fbSync.db), updates);

    pendingChanges.clear();
    undoStack.length = 0;
    updatePendingBar();
    showOnlineSaved();
    toast({title:`${n} alteraç${n===1?'ão salva':'ões salvas'} ✓`, kind:'success'});

    // Após salvar, verifica se alguma das tarefas alteradas é predecessora de outras
    // e abre o modal de propagação caso a caso. Espera um pouco pro Firebase
    // re-disparar TASKS_DEF com os novos dados antes de calcular o que mover.
    setTimeout(() => {
      // Constrói uma única lista de items consolidada (várias tarefas alteradas)
      const consolidatedItems = [];
      changedSnapshot.forEach(({ taskId }) => {
        const succs = TASKS_DEF.filter(x => getDeps(x).some(d => d.predId === taskId));
        const pred = TASKS_DEF.find(x => x.id === taskId);
        if (!pred) return;
        succs.forEach(s => {
          const dep = getDeps(s).find(d => d.predId === taskId);
          const lag = dep?.lag || 0;
          const idealStart = isoFromDayOff(dayOff(pred.end, parseDate(CHART_START_STR)) + lag + 1);
          const shift = _diffDays(_toDate(s.start), _toDate(idealStart));
          if (shift !== 0) {
            // Evita duplicar se a mesma sucessora aparece múltiplas vezes
            if (!consolidatedItems.find(x => x.id === s.id)) {
              consolidatedItems.push({
                id: s.id, name: s.name, curStart: s.start,
                suggestedStart: idealStart, suggestedShiftDays: shift, action: 'move',
              });
            }
          }
        });
      });
      if (consolidatedItems.length) {
        propagCtx = { changedId: null, items: consolidatedItems };
        renderPropagModal();
      }
    }, 250);

  } catch(e) {
    console.error('[saveAllPending]', e);
    showError('Erro ao salvar');
    btnSave.disabled = false;
    btnSaveLbl.textContent = 'Salvar alterações';
    bar.classList.remove('saving');
    document.getElementById('pending-icon').textContent = '!';
    document.getElementById('pending-title').textContent = 'Falha ao salvar — tente novamente';
    toast({
      title:'Erro ao salvar',
      msg: e.code === 'PERMISSION_DENIED' ? 'Permissão negada. Veja o passo a passo de regras do Firebase.' : e.message,
      kind:'err',
      duration: 7000,
    });
  }
}
window.saveAllPendingChanges = saveAllPendingChanges;

/* Avisa antes de fechar a página com alterações pendentes */
window.addEventListener('beforeunload', (e) => {
  if (pendingChanges.size > 0) {
    e.preventDefault();
    e.returnValue = 'Você tem alterações de cronograma não salvas. Deseja sair mesmo assim?';
    return e.returnValue;
  }
});

/* Atalhos de teclado: Ctrl+Z (undo), Ctrl+S (save) */
document.addEventListener('keydown', (e) => {
  if (!IS_ADMIN) return;
  // Não interceptar quando estiver dentro de input/textarea
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    if (pendingChanges.size > 0) {
      e.preventDefault();
      undoLastChange();
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    if (pendingChanges.size > 0) {
      e.preventDefault();
      saveAllPendingChanges();
    }
  }
});

function updateRowVisualLive(taskId, newStart, newEnd) {
  const row = document.querySelector(`tr.task-row[data-task-id="${taskId}"]`);
  if (!row) return;
  // Atualiza coluna dias (input em modo admin, span em modo cliente)
  const days = Math.max(1, daysBetween(newStart, newEnd));
  const daysInput = row.querySelector('input[data-days-input]');
  if (daysInput) daysInput.value = days;
  const dval = row.querySelector('.dval');
  if (dval) dval.textContent = days;
  // Atualiza coluna datas
  const dstart = row.querySelector('.dstart');
  const dend   = row.querySelector('.dend');
  if (dstart) dstart.textContent = fmtDate(newStart);
  if (dend)   dend.textContent = fmtDate(newEnd);
  // Atualiza prazo restante (se admin)
  const tdRem = row.querySelector('.td-remaining');
  if (tdRem) {
    const t = TASKS_DEF.find(x => x.id === taskId);
    if (t) {
      const tempTask = { ...t, start:newStart, end:newEnd };
      tdRem.innerHTML = fmtRemaining(computeRemaining(tempTask, getStatus(taskId)));
    }
  }
}

async function saveTaskDates(taskId, newStart, newEnd, newDays) {
  if (!IS_ADMIN || !fbSync) return;
  showSaving();
  try {
    const updates = {};
    updates[`tasks/${OBRA_ID}/definition/${taskId}/start`] = newStart;
    updates[`tasks/${OBRA_ID}/definition/${taskId}/end`]   = newEnd;
    updates[`tasks/${OBRA_ID}/definition/${taskId}/days`]  = newDays;
    const stamp = _currentUserStamp(`Mudou datas para ${fmtDateBr(newStart)} → ${fmtDateBr(newEnd)}`);
    if (stamp) updates[`tasks/${OBRA_ID}/definition/${taskId}/lastUpdatedBy`] = stamp;
    updates[`tasks/${OBRA_ID}/updatedAt`] = Date.now();
    updates[`meta/${OBRA_ID}/lastUpdate`] = Date.now();
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    toast({title:'Datas atualizadas', msg:`${fmtDateBr(newStart)} → ${fmtDateBr(newEnd)}`, kind:'success', duration:2600});
  } catch(e) {
    console.error('[saveTaskDates]', e);
    showError('Erro ao salvar datas');
    toast({title:'Erro ao salvar', msg:e.message, kind:'err'});
  }
}

function daysBetween(startIso, endIso) {
  if (!startIso || !endIso) return 1;
  const a = parseDate(startIso), b = parseDate(endIso);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/* ═══════════════════════════════════════════
   INTERACTIONS
═══════════════════════════════════════════ */
function handleStatusChange(id) {
  if (!IS_ADMIN) return; // cliente é read-only
  const task = TASKS_DEF.find(t => t.id === id);
  if (!task) return;
  const {prev, next} = cycleStatus(id);
  if (next === 'done' && prev !== 'done') {
    justDoneIds.add(id);
    fireNotification(task, 'local');
    toast({title: 'Atividade concluída ✓', msg: task.name, kind: 'success'});
  }
  render();
}
function onRowClick(e, id) {
  // No modo Linking, o clique na linha funciona como passo do "ligar".
  if (linkingMode && IS_ADMIN) {
    handleLinkingClick(id);
    return;
  }
  // Em admin, clicar na linha (fora da pílula/barra/inputs) seleciona a tarefa,
  // o que habilita o botão "+ Subatividade".
  if (!IS_ADMIN) return;
  // Ignora se o clique veio de elementos interativos (input, bar, pill, button)
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input','button','select','textarea'].includes(tag)) return;
  if (e.target.closest('.bar') || e.target.closest('.status-pill') ||
      e.target.closest('.row-actions-btn') || e.target.closest('.dep-chip')) return;

  // Toggle: clicar de novo deseleciona
  selectedTaskId = (selectedTaskId === id) ? null : id;
  updateSubButton();
  // Atualiza visual sem re-render completo (mais leve)
  document.querySelectorAll('tr.task-row.row-selected').forEach(r => r.classList.remove('row-selected'));
  if (selectedTaskId) {
    const row = document.querySelector(`tr.task-row[data-task-id="${selectedTaskId}"]`);
    if (row) row.classList.add('row-selected');
  }
}
function onStatusClick(e, id) {
  if (!IS_ADMIN) return;
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  handleStatusChange(id);
}

/* ═══════════════════════════════════════════
   FINANCEIRO — abas, potes (% metas), serviços, lançamentos, medições
═══════════════════════════════════════════ */
let potes = {};        // { poteId: { name, percentMeta, cor, icon, desc, order } }
let lancamentos = {};  // { lancId: { poteId, desc, valor, data, tipo, categoria, formaPagto, obs, createdAt } }
let services = {};     // { taskId: { cobrado, realizado, updatedAt } }
let servicesPrivate = {};  // { svcId: { realizado, ... } } — só admin
let editingPoteId = null;
let editingLancId = null;
let currentMainTab = 'cronograma';
let currentFinSub = 'servicos';

/* --- abas principais --- */
function switchMainTab(name) {
  currentMainTab = name;
  document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'financeiro') {
    renderFinanceiro();
  } else if (name === 'cronograma') {
    setTimeout(render, 30); // re-render Gantt pra recalcular largura
  }
  // Atualiza footer-rev pra refletir a aba
  const fr = document.getElementById('footer-rev');
  if (fr) fr.textContent = name === 'financeiro' ? 'Planejamento Financeiro' : 'Cronograma de Obra';
}
window.switchMainTab = switchMainTab;

/* --- sub-abas financeiras --- */
function switchFinSub(name) {
  // Defesa: aba Lançamentos e Relatórios são exclusivas do admin.
  // Se um cliente tentar acessar (via algum link ou erro), redirecionamos para Serviços.
  if (!IS_ADMIN && (name === 'lancamentos' || name === 'relatorios')) {
    name = 'servicos';
  }
  currentFinSub = name;
  document.querySelectorAll('.fin-subtab').forEach(t => t.classList.toggle('active', t.dataset.sub === name));
  document.querySelectorAll('.fin-pane').forEach(p => p.classList.toggle('active', p.id === 'fin-pane-' + name));
  // Esses botões já são .admin-only (escondem-se em modo cliente). Aqui só
  // alternamos entre subabas pra admin. Como .admin-only usa !important pra
  // bater outras regras, aqui também precisamos de !important pra mostrar.
  const btnPote = document.getElementById('btn-new-pote');
  const btnLanc = document.getElementById('btn-new-lanc');
  if (name === 'potes' && IS_ADMIN)        btnPote.style.setProperty('display', 'inline-flex', 'important');
  else                                       btnPote.style.setProperty('display', 'none', 'important');
  if (name === 'lancamentos' && IS_ADMIN)  btnLanc.style.setProperty('display', 'inline-flex', 'important');
  else                                       btnLanc.style.setProperty('display', 'none', 'important');
  if (name === 'servicos')    renderServicos();
  if (name === 'potes')       renderPotes();
  if (name === 'lancamentos') renderLancamentos();
  if (name === 'medicoes')    renderMedicoes();
  if (name === 'relatorios')  renderRelatorios();
}
window.switchFinSub = switchFinSub;

/* --- subscriptions --- */
function subscribeFinancials() {
  if (IS_ADMIN) {
    fbSync.onValue(fbSync.ref(fbSync.db, `financials/${OBRA_ID}/potes`), snap => {
      potes = snap.val() || {};
      maybeMigrateOldPotes();
      if (currentMainTab === 'financeiro') renderFinanceiro();
      updateFinTabPill();
    }, err => {
      console.warn('[potes]', err);
    });

    fbSync.onValue(fbSync.ref(fbSync.db, `financials/${OBRA_ID}/lancamentos`), snap => {
      lancamentos = snap.val() || {};
      if (currentMainTab === 'financeiro') renderFinanceiro();
      updateFinTabPill();
    }, err => {
      console.warn('[lancamentos]', err);
    });

    fbSync.onValue(fbSync.ref(fbSync.db, `services-private/${OBRA_ID}`), snap => {
      servicesPrivate = snap.val() || {};
      if (currentMainTab === 'financeiro') renderFinanceiro();
    }, err => {
      console.warn('[services-private]', err);
    });
  } else {
    potes = {};
    lancamentos = {};
    servicesPrivate = {};
  }

  fbSync.onValue(fbSync.ref(fbSync.db, `services/${OBRA_ID}`), snap => {
    services = snap.val() || {};
    if (currentMainTab === 'financeiro') renderFinanceiro();
  }, err => {
    console.warn('[services]', err);
  });
}

/* --- migração one-shot: potes antigos com R$ → % do orçamento existente --- */
let migrationPotesRunning = false;
async function maybeMigrateOldPotes() {
  if (!IS_ADMIN || !fbSync || migrationPotesRunning) return;
  // Detecta potes com `planejado` (R$) mas sem `percentMeta`. Se nenhum, nada a fazer.
  const oldOnes = Object.entries(potes).filter(([_, p]) => (
    p && p.percentMeta == null && (Number(p.planejado) > 0)
  ));
  if (oldOnes.length === 0) return;

  migrationPotesRunning = true;
  try {
    const totalOld = oldOnes.reduce((s, [_, p]) => s + (Number(p.planejado) || 0), 0);
    if (totalOld <= 0) { migrationPotesRunning = false; return; }
    const updates = {};
    oldOnes.forEach(([id, p]) => {
      const pct = Math.round(((Number(p.planejado) || 0) / totalOld) * 1000) / 10; // 1 casa
      updates[`financials/${OBRA_ID}/potes/${id}/percentMeta`] = pct;
      // remove o campo planejado pra não manter dado obsoleto
      updates[`financials/${OBRA_ID}/potes/${id}/planejado`] = null;
    });
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    console.log('[migration potes] convertidos:', oldOnes.length, '— total antigo R$', totalOld);
    toast({title:'Potes convertidos para meta de %', msg:'Os valores antigos em R$ foram redistribuídos como percentuais. Você pode ajustar nos potes.', kind:'info', duration:7000});
  } catch(e) {
    console.warn('[migration potes] falhou:', e);
  } finally {
    migrationPotesRunning = false;
  }
}

function updateFinTabPill() {
  const pill = document.getElementById('fin-tab-pill');
  const n = Object.keys(potes).length;
  if (pill) {
    if (n > 0) { pill.style.display = ''; pill.textContent = n; }
    else pill.style.display = 'none';
  }
}

/* --- helpers de moeda e cálculo --- */
function fmtBRL(n) {
  return (n || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL', minimumFractionDigits:2 });
}
function fmtPct(n) {
  return (n || 0).toLocaleString('pt-BR', { minimumFractionDigits:0, maximumFractionDigits:1 }) + '%';
}

// Orçamento total da obra = soma do "cobrado" de todos os serviços
function getOrcamentoTotal() {
  let total = 0;
  Object.values(services).forEach(s => { total += Number(s.cobrado) || 0; });
  return total;
}
// Soma das metas (%) dos potes — deveria ser 100%
function getSumPercentMetas() {
  let s = 0;
  Object.values(potes).forEach(p => { s += Number(p.percentMeta) || 0; });
  return s;
}

/* --- compute: gasto e previsto por pote (mantido como estava) --- */
function computePoteSpend(poteId) {
  let gasto = 0, previsto = 0;
  Object.values(lancamentos).forEach(l => {
    if (l.poteId !== poteId) return;
    if (l.tipo === 'previsto') previsto += Number(l.valor) || 0;
    else gasto += Number(l.valor) || 0;
  });
  return { gasto, previsto, total: gasto + previsto };
}

// Disponível em R$ de um pote = (% / 100) × orçamento total
function computePoteAvailable(pote) {
  const orcamento = getOrcamentoTotal();
  const pct = Number(pote.percentMeta) || 0;
  return (pct / 100) * orcamento;
}

/* --- renders --- */
function renderFinanceiro() {
  renderFinSummary();
  if (currentFinSub === 'servicos')    renderServicos();
  else if (currentFinSub === 'potes')       renderPotes();
  else if (currentFinSub === 'lancamentos') renderLancamentos();
  else if (currentFinSub === 'medicoes')    renderMedicoes();
}

function renderFinSummary() {
  const cont = document.getElementById('fin-summary');
  if (!cont) return;
  const potesArr = Object.values(potes);
  const servicesArr = Object.values(services);
  if (!potesArr.length && !servicesArr.length) {
    cont.innerHTML = '';
    return;
  }

  // Orçamento total = soma do "cobrado" dos serviços
  const orcamento = getOrcamentoTotal();
  // Realizado dos serviços (o que foi efetivamente faturado pelo cliente)
  let totalRealizadoServ = 0;
  Object.keys(services).forEach(svcId => { totalRealizadoServ += getRealizado(svcId); });

  // Custos lançados (gasto + previsto = saída de caixa real ou comprometida)
  let totalGasto = 0, totalPrev = 0;
  Object.values(lancamentos).forEach(l => {
    if (l.tipo === 'previsto') totalPrev += Number(l.valor) || 0;
    else totalGasto += Number(l.valor) || 0;
  });

  const margem = totalRealizadoServ - (totalGasto + totalPrev);
  const usadoPct = orcamento > 0 ? Math.round(((totalGasto + totalPrev) / orcamento) * 100) : 0;

  if (IS_ADMIN) {
    // Construtora: visão completa com margem e custos
    cont.innerHTML = `
      <div class="fin-stat">
        <div class="fin-stat-lbl">Orçamento da obra</div>
        <div class="fin-stat-val">${fmtBRL(orcamento)}</div>
        <div class="fin-stat-sub">soma do cobrado dos serviços</div>
      </div>
      <div class="fin-stat">
        <div class="fin-stat-lbl">Faturado ao cliente</div>
        <div class="fin-stat-val">${fmtBRL(totalRealizadoServ)}</div>
        <div class="fin-stat-sub">${orcamento > 0 ? Math.round(totalRealizadoServ/orcamento*100) : 0}% do orçamento</div>
      </div>
      <div class="fin-stat">
        <div class="fin-stat-lbl">Custos (gasto + previsto)</div>
        <div class="fin-stat-val">${fmtBRL(totalGasto + totalPrev)}</div>
        <div class="fin-stat-sub">${usadoPct}% do orçamento</div>
      </div>
      <div class="fin-stat">
        <div class="fin-stat-lbl">Margem (realizado − custos)</div>
        <div class="fin-stat-val ${margem >= 0 ? 'pos' : 'neg'}">${fmtBRL(margem)}</div>
        <div class="fin-stat-sub">${margem < 0 ? 'no vermelho' : 'sobra atual'}</div>
      </div>
    `;
  } else {
    // Cliente: NÃO vê custos internos nem margem/lucro. Vê só:
    //  - Orçamento total contratado
    //  - Quanto já foi entregue (medido) — calculado pelo avanço físico × valor cobrado
    //  - % de avanço financeiro
    //  - Saldo a entregar
    let totalMedido = 0;
    if (TASKS_DEF) {
      TASKS_DEF.forEach(t => {
        const s = services[t.id] || {};
        const cobrado = Number(s.cobrado) || 0;
        const status = state ? state[t.id] : null;
        let pctAv = 0;
        if (status === 'done') pctAv = 1;
        else if (status === 'progress') pctAv = 0.5;
        totalMedido += cobrado * pctAv;
      });
    }
    const saldoEntregar = orcamento - totalMedido;
    const pctAvFin = orcamento > 0 ? Math.round((totalMedido / orcamento) * 100) : 0;

    cont.innerHTML = `
      <div class="fin-stat">
        <div class="fin-stat-lbl">Orçamento contratado</div>
        <div class="fin-stat-val">${fmtBRL(orcamento)}</div>
        <div class="fin-stat-sub">valor total da obra</div>
      </div>
      <div class="fin-stat">
        <div class="fin-stat-lbl">Entregue até agora</div>
        <div class="fin-stat-val pos">${fmtBRL(totalMedido)}</div>
        <div class="fin-stat-sub">${pctAvFin}% do contratado</div>
      </div>
      <div class="fin-stat">
        <div class="fin-stat-lbl">Saldo a entregar</div>
        <div class="fin-stat-val">${fmtBRL(Math.max(0, saldoEntregar))}</div>
        <div class="fin-stat-sub">previsão restante</div>
      </div>
    `;
  }
}

/* Detecta se o pote representa "Lucro" — usado para esconder do cliente.
   Olha pro nome (case-insensitive) ou pelo ícone padrão de lucro. */
function isPoteLucro(p) {
  const n = (p.name || '').toLowerCase().trim();
  if (n === 'lucro' || n.startsWith('lucro ') || n.includes(' lucro')) return true;
  if (n === 'margem' || n.startsWith('margem ')) return true;
  // ícone padrão de lucro
  if (p.icon === '💰') return true;
  return false;
}

function renderPotes() {
  const grid = document.getElementById('potes-grid');
  const empty = document.getElementById('potes-empty');
  const summaryBar = document.getElementById('potes-summary-bar');

  // Construtora vê todos os potes; cliente NÃO vê o pote de Lucro.
  const fullList = Object.entries(potes)
    .map(([id, p]) => ({ ...p, id }))
    .sort((a,b) => (a.order ?? 999) - (b.order ?? 999) || (a.name||'').localeCompare(b.name||''));
  const list = IS_ADMIN ? fullList : fullList.filter(p => !isPoteLucro(p));

  if (!list.length) {
    grid.innerHTML = '';
    if (summaryBar) summaryBar.style.display = 'none';
    empty.style.display = '';
    // Mostra "Criar 4 potes padrão" só pra admin quando NÃO há nenhum pote
    const btnPadrao = document.getElementById('btn-criar-potes-padrao');
    if (btnPadrao) {
      // O botão tem class admin-only — o display é tratado via CSS,
      // mas é seguro forçar inline-flex pra construtora.
      btnPadrao.style.display = IS_ADMIN ? 'inline-flex' : 'none';
    }
    return;
  }
  empty.style.display = 'none';

  // ── Barra de soma das metas (verifica se fecha em 100%) — só admin
  const sumPct = getSumPercentMetas(); // sempre considera todos os potes (inclui lucro)
  const orcamento = getOrcamentoTotal();
  if (summaryBar) {
    if (!IS_ADMIN) {
      summaryBar.style.display = 'none';
    } else {
      let cls = 'ok';
      let msg = 'A soma das metas fecha em 100% — perfeito.';
      if (Math.abs(sumPct - 100) > 0.5) {
        if (sumPct > 100.5) {
          cls = 'over';
          msg = `As metas somam ${fmtPct(sumPct)} — passou de 100%. Ajuste pra fechar em 100%.`;
        } else {
          cls = 'warn';
          msg = `As metas somam ${fmtPct(sumPct)} — falta ${fmtPct(100 - sumPct)} pra fechar em 100%.`;
        }
      }
      const fillW = Math.min(100, Math.max(0, sumPct));
      summaryBar.className = 'potes-summary-bar ' + cls;
      summaryBar.style.display = '';
      summaryBar.innerHTML = `
        <div>
          <div class="potes-sum-label">Soma das metas</div>
          <div class="potes-sum-value">${fmtPct(sumPct)}</div>
        </div>
        <div class="potes-sum-track"><div class="potes-sum-track-fill" style="width:${fillW}%"></div></div>
        <div class="potes-sum-msg">${msg}${orcamento > 0 ? ` Orçamento base: <strong>${fmtBRL(orcamento)}</strong>.` : ' <em>Preencha o cobrado dos serviços para ativar o cálculo em R$ por pote.</em>'}</div>
      `;
    }
  }

  let html = '';
  list.forEach(p => {
    const { gasto, previsto, total } = computePoteSpend(p.id);
    const disponivelTotal = computePoteAvailable(p); // R$ alocados a esse pote pelo % do orçamento
    const percentMeta = Number(p.percentMeta) || 0;
    const realPct = disponivelTotal > 0 ? Math.round((total / disponivelTotal) * 100) : 0;
    const pct = Math.min(100, realPct);
    const disp = disponivelTotal - total;
    const cor = p.cor || '#1A7A9A';
    const corLight = cor + '22';
    const fillCls = realPct >= 100 ? 'over' : realPct >= 85 ? 'warn' : '';
    const pctCls  = realPct >= 100 ? 'over' : realPct >= 85 ? 'warn' : '';

    const subline = orcamento > 0
      ? `${fmtPct(percentMeta)} do orçamento · ${fmtBRL(disponivelTotal)}`
      : `${fmtPct(percentMeta)} (R$ a calcular)`;

    if (IS_ADMIN) {
      // Admin: vê gasto, previsto, disponível e % utilizado (visão completa interna)
      html += `
        <div class="pote-card" style="--pote-color:${cor};--pote-color-light:${corLight}" onclick="openPoteModal('${p.id}')">
          <div class="pote-hdr">
            <div class="pote-icon">${p.icon || '🏺'}</div>
            <div style="flex:1;min-width:0">
              <div class="pote-name">${escapeHtml(p.name||'—')}</div>
              <div class="pote-name-sub">${subline}</div>
            </div>
          </div>
          <div class="pote-vals">
            <div class="pote-val-grp">
              <span class="pote-val-lbl">Gasto</span>
              <span class="pote-val gasto">${fmtBRL(gasto)}</span>
            </div>
            ${previsto ? `<div class="pote-val-grp">
              <span class="pote-val-lbl">Previsto</span>
              <span class="pote-val" style="color:${cor}">${fmtBRL(previsto)}</span>
            </div>` : ''}
            <div class="pote-val-grp" style="text-align:right">
              <span class="pote-val-lbl">${disp >= 0 ? 'Disponível' : 'Excedente'}</span>
              <span class="pote-val disp ${disp < 0 ? 'neg' : ''}">${fmtBRL(Math.abs(disp))}</span>
            </div>
          </div>
          <div class="pote-bar-track"><div class="pote-bar-fill ${fillCls}" style="width:${pct}%"></div></div>
          <div class="pote-foot">
            <span>${realPct}% utilizado</span>
            <span class="pct ${pctCls}">${realPct >= 100 ? '⚠ pote estourado' : (realPct >= 85 ? '⚠ atenção' : 'no plano')}</span>
          </div>
          ${p.desc ? `<div class="pote-desc">${escapeHtml(p.desc)}</div>` : ''}
        </div>
      `;
    } else {
      // Cliente: NÃO vê gasto real nem disponível interno. Vê só:
      //  - O nome e a meta planejada (% do orçamento + R$ alocado)
      //  - Quanto desse pote já foi "entregue" (avanço físico × R$ planejado)
      //  - Não vê "previsto" (compromissos internos), nem disp/excedente, nem alerta de estouro
      const entreguePote = computePoteEntregue(p.id);
      const pctEntregue = disponivelTotal > 0 ? Math.round((entreguePote / disponivelTotal) * 100) : 0;
      const pctEntreguePct = Math.min(100, pctEntregue);
      html += `
        <div class="pote-card" style="--pote-color:${cor};--pote-color-light:${corLight};cursor:default">
          <div class="pote-hdr">
            <div class="pote-icon">${p.icon || '🏺'}</div>
            <div style="flex:1;min-width:0">
              <div class="pote-name">${escapeHtml(p.name||'—')}</div>
              <div class="pote-name-sub">${subline}</div>
            </div>
          </div>
          <div class="pote-vals">
            <div class="pote-val-grp">
              <span class="pote-val-lbl">Entregue até agora</span>
              <span class="pote-val gasto">${fmtBRL(entreguePote)}</span>
            </div>
            <div class="pote-val-grp" style="text-align:right">
              <span class="pote-val-lbl">% concluído</span>
              <span class="pote-val">${pctEntregue}%</span>
            </div>
          </div>
          <div class="pote-bar-track"><div class="pote-bar-fill" style="width:${pctEntreguePct}%;background:${cor}"></div></div>
          ${p.desc ? `<div class="pote-desc">${escapeHtml(p.desc)}</div>` : ''}
        </div>
      `;
    }
  });
  grid.innerHTML = html;
}

/* "Entregue" no pote = quanto foi medido (avanço físico × R$ planejado) das
   atividades que se referem a esse pote. Como atividades não têm pote
   atribuído, distribuímos proporcionalmente ao % do pote no orçamento.
   Isso dá ao cliente uma visão de "quanto desse compromisso a obra já
   entregou" sem expor gasto real nem lucro. */
function computePoteEntregue(poteId) {
  const p = potes[poteId]; if (!p) return 0;
  const pct = Number(p.percentMeta) || 0;
  if (pct <= 0) return 0;
  // Total medido = soma de (avanço da atividade × valor cobrado)
  let totalMedido = 0;
  if (typeof TASKS_DEF !== 'undefined' && TASKS_DEF) {
    TASKS_DEF.forEach(t => {
      const s = services[t.id] || {};
      const cobrado = Number(s.cobrado) || 0;
      const status = (typeof state !== 'undefined' && state) ? state[t.id] : null;
      // Heurística simples: pendente=0%, em andamento=50%, concluído=100%
      let pctAv = 0;
      if (status === 'done') pctAv = 1;
      else if (status === 'progress') pctAv = 0.5;
      totalMedido += cobrado * pctAv;
    });
  }
  return totalMedido * (pct / 100);
}

/* ═══════════ SERVIÇOS (cobrado × realizado por atividade) ═══════════ */
function getRealizado(svcId) {
  if (!IS_ADMIN) return 0;
  return Number(servicesPrivate?.[svcId]?.realizado) || 0;
}

function renderServicos() {
  const tbody = document.getElementById('services-body');
  const tfoot = document.getElementById('services-foot');
  const empty = document.getElementById('services-empty');
  const wrap  = document.querySelector('#fin-pane-servicos .services-table-wrap');
  const tableEl = document.getElementById('services-table');
  if (!tbody || !tfoot) return;

  if (!TASKS_DEF || TASKS_DEF.length === 0) {
    tbody.innerHTML = '';
    tfoot.innerHTML = '';
    if (wrap) wrap.style.display = 'none';
    if (empty) empty.style.display = '';
    return;
  }
  if (wrap) wrap.style.display = '';
  if (empty) empty.style.display = 'none';

  // Reescreve o cabeçalho conforme perfil. Cliente vê:
  // # | Serviço | Cobrado | Entregue | % concluído  (sem "realizado" real interno)
  // Admin vê: # | Serviço | Cobrado | Realizado | Diferença
  if (tableEl) {
    const thead = tableEl.querySelector('thead');
    if (thead) {
      if (IS_ADMIN) {
        thead.innerHTML = `<tr>
          <th style="width:48px">#</th>
          <th>Serviço</th>
          <th class="num">Cobrado (R$)</th>
          <th class="num">Realizado (R$)</th>
          <th class="num">Diferença</th>
        </tr>`;
      } else {
        thead.innerHTML = `<tr>
          <th style="width:48px">#</th>
          <th>Serviço</th>
          <th class="num">Valor do serviço</th>
          <th class="num">Entregue até agora</th>
          <th class="num">% concluído</th>
        </tr>`;
      }
    }
    // Atualiza também o texto de ajuda
    const help = document.querySelector('#fin-pane-servicos .services-help');
    if (help) {
      if (IS_ADMIN) {
        help.innerHTML = `<strong>Como funciona:</strong> cada atividade do cronograma vira uma linha aqui. Preencha o <em>cobrado</em> (o que vai cobrar do cliente por aquele serviço) e o <em>realizado</em> (o que já foi efetivamente faturado). A soma do cobrado é o orçamento total da obra — base do cálculo dos potes em %.`;
      } else {
        help.innerHTML = `<strong>O que você vê aqui:</strong> cada atividade da obra com o valor contratado e o quanto já foi <em>entregue</em>. O entregue é calculado pelo avanço físico — atividades concluídas contam 100% do valor, em andamento contam 50%, e pendentes ainda não contam.`;
      }
    }
  }

  let totCobrado = 0, totRealizado = 0, totMedido = 0;
  let html = '';
  TASKS_DEF.forEach((t, idx) => {
    const s = services[t.id] || {};
    const cobrado = Number(s.cobrado) || 0;
    const realizado = getRealizado(t.id);
    totCobrado += cobrado;
    totRealizado += realizado;

    const status = state ? state[t.id] : null;
    let pctAv = 0;
    if (status === 'done') pctAv = 1;
    else if (status === 'progress') pctAv = 0.5;
    const medido = cobrado * pctAv;
    totMedido += medido;
    const pctConcl = cobrado > 0 ? Math.round(pctAv * 100) : 0;

    const diff = realizado - cobrado;
    const diffCls = Math.abs(diff) < 0.005 ? 'diff-zero' : (diff >= 0 ? 'diff-pos' : 'diff-neg');
    const diffStr = (diff >= 0 ? '+' : '−') + fmtBRL(Math.abs(diff)).replace('R$', 'R$ ').trim();

    if (IS_ADMIN) {
      html += `<tr>
        <td style="color:var(--c-muted);font-size:11px">${idx + 1}</td>
        <td>
          <div class="services-name">${escapeHtml(t.name || '')}</div>
          <div class="services-name-sub">${escapeHtml((t.dept||'') + (t.phase ? ' · ' + t.phase : ''))}</div>
        </td>
        <td class="num"><input class="services-input" data-svc-task="${t.id}" data-svc-field="cobrado" type="number" min="0" step="0.01" value="${cobrado || ''}" placeholder="0,00"></td>
        <td class="num"><input class="services-input" data-svc-task="${t.id}" data-svc-field="realizado" type="number" min="0" step="0.01" value="${realizado || ''}" placeholder="0,00"></td>
        <td class="num ${diffCls}">${(cobrado===0 && realizado===0) ? '<span class="services-zero">—</span>' : diffStr}</td>
      </tr>`;
    } else {
      // Cliente: NÃO vê "realizado" (gasto real interno) — vê só "entregue" calculado pelo avanço
      const pctCls = pctConcl >= 100 ? 'diff-pos' : (pctConcl > 0 ? '' : 'services-zero');
      html += `<tr>
        <td style="color:var(--c-muted);font-size:11px">${idx + 1}</td>
        <td>
          <div class="services-name">${escapeHtml(t.name || '')}</div>
          <div class="services-name-sub">${escapeHtml((t.dept||'') + (t.phase ? ' · ' + t.phase : ''))}</div>
        </td>
        <td class="num"><span class="services-readonly ${cobrado===0?'services-zero':''}">${cobrado === 0 ? '—' : fmtBRL(cobrado)}</span></td>
        <td class="num"><span class="services-readonly ${medido===0?'services-zero':''}">${medido === 0 ? '—' : fmtBRL(medido)}</span></td>
        <td class="num ${pctCls}" style="font-weight:700">${cobrado === 0 ? '—' : pctConcl + '%'}</td>
      </tr>`;
    }
  });
  tbody.innerHTML = html;

  if (IS_ADMIN) {
    const totDiff = totRealizado - totCobrado;
    const totDiffCls = Math.abs(totDiff) < 0.005 ? 'diff-zero' : (totDiff >= 0 ? 'diff-pos' : 'diff-neg');
    tfoot.innerHTML = `<tr>
      <td colspan="2" style="text-transform:uppercase;font-size:11px;letter-spacing:1px;color:var(--c-muted)">Totais da obra</td>
      <td class="num">${fmtBRL(totCobrado)}</td>
      <td class="num">${fmtBRL(totRealizado)}</td>
      <td class="num ${totDiffCls}">${fmtBRL(totDiff)}</td>
    </tr>`;
  } else {
    const pctTot = totCobrado > 0 ? Math.round((totMedido / totCobrado) * 100) : 0;
    tfoot.innerHTML = `<tr>
      <td colspan="2" style="text-transform:uppercase;font-size:11px;letter-spacing:1px;color:var(--c-muted)">Total da obra</td>
      <td class="num">${fmtBRL(totCobrado)}</td>
      <td class="num">${fmtBRL(totMedido)}</td>
      <td class="num diff-pos" style="font-weight:700">${pctTot}%</td>
    </tr>`;
  }

  // Liga listeners de input apenas para admin
  if (IS_ADMIN) {
    tbody.querySelectorAll('.services-input').forEach(inp => {
      inp.addEventListener('blur', onServiceFieldBlur);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });
  }
}

// Debounce simples por (taskId, field) para evitar gravações duplicadas no blur
const _svcInputState = new Map(); // chave "tid|field" → último valor salvo
async function onServiceFieldBlur(e) {
  if (!IS_ADMIN || !fbSync) return;
  const inp = e.target;
  const taskId = inp.getAttribute('data-svc-task');
  const field  = inp.getAttribute('data-svc-field');
  if (!taskId || !field) return;

  const value = parseFloat((inp.value || '').toString().replace(',', '.')) || 0;
  if (value < 0) {
    inp.value = '';
    toast({title:'Valor inválido', kind:'warn'});
    return;
  }
  const key = taskId + '|' + field;
  const old = _svcInputState.get(key);
  if (old === value) return; // nada mudou
  _svcInputState.set(key, value);

  inp.classList.remove('saved');
  inp.classList.add('saving');
  try {
    const updates = {};
    if (field === 'realizado') {
      updates[`services-private/${OBRA_ID}/${taskId}/${field}`] = value > 0 ? value : null;
    } else {
      updates[`services/${OBRA_ID}/${taskId}/${field}`] = value > 0 ? value : null;
    }
    updates[`services/${OBRA_ID}/${taskId}/updatedAt`] = Date.now();
    updates[`meta/${OBRA_ID}/lastUpdate`] = Date.now();
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    inp.classList.remove('saving');
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 1200);
  } catch(err) {
    console.error('[saveService]', err);
    inp.classList.remove('saving');
    toast({title:'Erro ao salvar', msg: err.code === 'PERMISSION_DENIED' ? 'Permissão negada.' : err.message, kind:'err'});
  }
}

/* ═══════════ MEDIÇÕES (físico × financeiro) ═══════════ */
// Avanço físico por status: pendente=0, em-andamento=50%, concluído=100%
function physicalProgressOf(taskId) {
  const status = (state && state[taskId]) || 'pending';
  if (status === 'done')     return 1.0;
  if (status === 'progress') return 0.5;
  return 0;
}

/* Modo de exibição da matriz: "mensal" mostra o medido EM cada mês,
   "acumulado" mostra o medido ATÉ cada mês. */
let medicaoMode = 'acumulado';
function setMedicaoMode(mode) {
  medicaoMode = mode;
  document.querySelectorAll('.medicao-mode').forEach(b => b.classList.toggle('active', b.dataset.mmode === mode));
  renderMedicoes();
}
window.setMedicaoMode = setMedicaoMode;

/* Calcula, para um único serviço, o valor medido em cada mês.
   Retorna um Map de yyyy-mm => valor.
   Lógica:
     - Se status === 'done', o serviço inteiro foi entregue: distribui o
       valor cobrado proporcionalmente aos dias em cada mês entre start..end.
     - Se status === 'progress' (50%), distribui só metade do cobrado,
       limitado aos meses já transcorridos (até hoje).
     - Se status === 'pending', tudo zero.
   Isso dá uma curva de medição realista para o boletim mensal. */
function _medicaoMensalDoServico(t, cobrado, hojeIso) {
  const out = new Map();
  if (!t.start || !t.end || !cobrado) return out;
  const status = (state && state[t.id]) || 'pending';
  if (status === 'pending') return out;
  const fator = status === 'done' ? 1 : 0.5;

  const startDate = new Date(t.start + 'T00:00:00');
  const endDate   = new Date(t.end   + 'T00:00:00');
  const dayMs = 86400000;
  const totalDias = Math.max(1, Math.round((endDate - startDate) / dayMs) + 1);
  const valorPorDia = (cobrado * fator) / totalDias;

  // Para "progress", só conta dias até hoje (atividade ainda em curso).
  const cutOff = (status === 'progress' && hojeIso)
    ? new Date(hojeIso + 'T00:00:00')
    : endDate;

  // Itera dia a dia (n dias é tipicamente <300, então é seguro).
  for (let d = new Date(startDate); d <= endDate && d <= cutOff; d = new Date(d.getTime() + dayMs)) {
    const ym = d.toISOString().slice(0, 7); // yyyy-mm
    out.set(ym, (out.get(ym) || 0) + valorPorDia);
  }
  return out;
}

function renderMedicoes() {
  const wrap = document.getElementById('medicao-matrix-wrap');
  const empty = document.getElementById('medicoes-empty');
  if (!wrap) return;

  if (!TASKS_DEF || TASKS_DEF.length === 0) {
    wrap.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }

  // Pega serviços com cobrado > 0 (sem cobrado, não há o que medir)
  const linhas = TASKS_DEF.map(t => {
    const s = services[t.id] || {};
    const cobrado = Number(s.cobrado) || 0;
    return { t, cobrado };
  }).filter(r => r.cobrado > 0);

  if (linhas.length === 0) {
    wrap.innerHTML = '';
    if (empty) {
      empty.style.display = '';
      const sub = empty.querySelector('.empty-sub');
      if (sub) sub.textContent = 'Preencha o "cobrado" dos serviços (na aba Serviços) e atualize o status no cronograma para ver o boletim aqui.';
    }
    return;
  }
  if (empty) empty.style.display = 'none';

  // Determina a faixa de meses da obra (min start → max end de TODOS os serviços com cobrado).
  let minStart = null, maxEnd = null;
  linhas.forEach(({t}) => {
    if (!minStart || t.start < minStart) minStart = t.start;
    if (!maxEnd   || t.end   > maxEnd)   maxEnd   = t.end;
  });
  if (!minStart || !maxEnd) {
    wrap.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }

  // Constrói lista de meses entre minStart e maxEnd (inclusivo)
  const meses = [];
  let cur = new Date(minStart.slice(0,8) + '01T00:00:00');
  const fim = new Date(maxEnd.slice(0,8) + '01T00:00:00');
  // Defensive: limita a 60 meses (5 anos) pra não estourar
  let safety = 0;
  while (cur <= fim && safety++ < 80) {
    meses.push(cur.toISOString().slice(0, 7));
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  const hojeIso = new Date().toISOString().slice(0, 10);
  const mesAtual = hojeIso.slice(0, 7);

  // Pré-calcula medição mensal de cada linha
  linhas.forEach(r => {
    r.porMes = _medicaoMensalDoServico(r.t, r.cobrado, hojeIso);
  });

  // Total por mês, total por linha
  const totalPorMes = new Map();
  meses.forEach(m => totalPorMes.set(m, 0));

  // Acumulado por mês (para modo acumulado)
  const acumPorMes = new Map();

  // Monta matriz
  const NMES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  function mesLabel(ym) {
    const [y, m] = ym.split('-');
    return { name: NMES[parseInt(m)-1], year: y };
  }

  let html = '<table class="medicao-matrix"><thead><tr>';
  html += '<th class="col-svc">Serviço</th>';
  html += '<th class="col-cob">Valor cobrado</th>';
  meses.forEach(ym => {
    const isCurrent = ym === mesAtual;
    const lbl = mesLabel(ym);
    html += `<th class="col-month${isCurrent ? ' month-current' : ''}">
      <span class="month-name">${lbl.name}</span>
      <span class="month-year">${lbl.year}</span>
    </th>`;
  });
  html += '<th class="col-total">Total medido</th>';
  html += '</tr></thead><tbody>';

  linhas.forEach(({t, cobrado, porMes}) => {
    const status = (state && state[t.id]) || 'pending';
    const statusLbl = status === 'done' ? 'concluído' : status === 'progress' ? 'em andamento' : 'pendente';
    const statusCls = status === 'done' ? 'done' : status === 'progress' ? 'prog' : 'pend';

    let totalLinha = 0;
    let acumLinha = 0;

    let rowHtml = '';
    rowHtml += `<td class="cell-svc">
      <div class="med-svc-name">${escapeHtml(t.name || '')}<span class="med-svc-status ${statusCls}">${statusLbl}</span></div>
      <div class="med-svc-meta">${escapeHtml((t.dept||'') + (t.phase ? ' · ' + t.phase : '') + ' · ' + fmtDate(t.start) + ' → ' + fmtDate(t.end))}</div>
    </td>`;
    rowHtml += `<td class="cell-cob">${fmtBRL(cobrado)}</td>`;

    meses.forEach(ym => {
      const v = porMes.get(ym) || 0;
      totalLinha += v;
      acumLinha += v;
      const showVal = medicaoMode === 'acumulado' ? acumLinha : v;
      const isCurrent = ym === mesAtual;
      let cls = 'cell-month';
      if (isCurrent) cls += ' month-current';
      if (showVal > 0) cls += ' has-value';
      else cls += ' empty';
      // Acumulado pode ter valor (carregado de meses anteriores) mesmo se mês atual não teve nada
      const display = showVal > 0
        ? fmtBRL(showVal)
        : '<span class="cell-zero">—</span>';
      rowHtml += `<td class="${cls}">${display}</td>`;

      // Atualiza total por mês usando valor "do mês" (não acumulado),
      // para a linha de totais ser sempre consistente
      totalPorMes.set(ym, (totalPorMes.get(ym) || 0) + v);
    });

    rowHtml += `<td class="cell-total">${fmtBRL(totalLinha)}</td>`;
    html += `<tr>${rowHtml}</tr>`;
  });

  html += '</tbody><tfoot><tr>';
  html += '<td class="cell-svc">Total mensal</td>';
  // Total da coluna "cobrado" = soma do cobrado de todas as linhas
  const totalCobrado = linhas.reduce((s, r) => s + r.cobrado, 0);
  html += `<td class="cell-cob">${fmtBRL(totalCobrado)}</td>`;
  let totalGeralAcum = 0;
  let totalGeral = 0;
  meses.forEach(ym => {
    const m = totalPorMes.get(ym) || 0;
    totalGeralAcum += m;
    totalGeral += m;
    const showM = medicaoMode === 'acumulado' ? totalGeralAcum : m;
    html += `<td class="cell-month">${showM > 0 ? fmtBRL(showM) : '<span class="cell-zero" style="color:rgba(255,255,255,.4)">—</span>'}</td>`;
  });
  html += `<td class="cell-total">${fmtBRL(totalGeral)}</td>`;
  html += '</tr></tfoot></table>';

  wrap.innerHTML = html;
}

function renderLancamentos() {
  // Atualiza filtros (potes e categorias)
  const selPote = document.getElementById('lanc-filter-pote');
  if (selPote) {
    const cur = selPote.value;
    let opts = '<option value="">Todos os potes</option>';
    Object.entries(potes).sort((a,b) => (a[1].name||'').localeCompare(b[1].name||''))
      .forEach(([id, p]) => opts += `<option value="${id}">${escapeHtml(p.name||'')}</option>`);
    selPote.innerHTML = opts;
    selPote.value = cur;
  }

  // Categorias presentes em uso (extrai dos lançamentos)
  const cats = [...new Set(Object.values(lancamentos).map(l => l.categoria).filter(Boolean))];
  const selCat = document.getElementById('lanc-filter-cat');
  if (selCat) {
    const cur = selCat.value;
    let opts = '<option value="">Todas as categorias</option>';
    cats.sort().forEach(c => opts += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
    selCat.innerHTML = opts;
    selCat.value = cur;
  }

  const list = document.getElementById('lanc-list');
  const empty = document.getElementById('lanc-empty');
  const fPote = selPote ? selPote.value : '';
  const fCat  = selCat ? selCat.value : '';
  const fSearch = (document.getElementById('lanc-search')?.value || '').toLowerCase();

  let arr = Object.entries(lancamentos)
    .map(([id, l]) => ({ ...l, id }))
    .filter(l => {
      if (fPote && l.poteId !== fPote) return false;
      if (fCat && l.categoria !== fCat) return false;
      if (fSearch && !((l.desc||'').toLowerCase().includes(fSearch) || (l.obs||'').toLowerCase().includes(fSearch))) return false;
      return true;
    })
    .sort((a,b) => {
      // Mais recente primeiro
      const da = a.data || '0000', db = b.data || '0000';
      if (da !== db) return db.localeCompare(da);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

  if (!arr.length) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  let html = '';
  arr.forEach(l => {
    const p = potes[l.poteId];
    const cor = p?.cor || '#1A7A9A';
    const poteName = p?.name || '— pote removido —';
    const corLight = cor + '22';
    const cliquePote = l.id;
    html += `
      <div class="lanc-row" onclick="${IS_ADMIN ? `openLancamentoModal('${l.id}')` : ''}">
        <div class="lanc-pote-tag" style="background:${corLight};color:${cor}">
          ${p?.icon || '🏺'} ${escapeHtml(poteName)}
        </div>
        <div>
          <div class="lanc-desc">${escapeHtml(l.desc||'(sem descrição)')}</div>
          <div class="lanc-meta">
            ${l.categoria ? `<span class="lanc-cat-tag">${escapeHtml(l.categoria)}</span>` : ''}
            ${l.formaPagto ? `<span>${escapeHtml(l.formaPagto)}</span>` : ''}
            ${l.obs ? `<span title="${escapeHtml(l.obs)}">📝 obs</span>` : ''}
          </div>
        </div>
        <div class="lanc-data">${fmtDateBr(l.data)}</div>
        <div>
          <span class="lanc-tipo-pill ${l.tipo==='previsto'?'previsto':'gasto'}">${l.tipo==='previsto'?'Previsto':'Realizado'}</span>
        </div>
        <div class="lanc-valor ${l.tipo==='previsto'?'previsto':''}">${fmtBRL(Number(l.valor) || 0)}</div>
      </div>
    `;
  });
  list.innerHTML = html;
}
window.renderLancamentos = renderLancamentos;

function renderRelatorios() {
  const cont = document.getElementById('relatorios-content');
  if (!cont) return;
  if (!IS_ADMIN) {
    cont.innerHTML = '<div class="empty-state"><div class="empty-icon">🔒</div><div class="empty-title">Acesso restrito</div><div class="empty-sub" style="display:block">Os relatórios financeiros são visíveis apenas para a construtora.</div></div>';
    return;
  }

  const potesArr = Object.entries(potes)
    .map(([id, p]) => ({ ...p, id }))
    .sort((a,b) => (a.order ?? 999) - (b.order ?? 999));

  const lancamentosArr = Object.values(lancamentos);
  const orcamento = getOrcamentoTotal();

  if (!potesArr.length && !lancamentosArr.length) {
    cont.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📊</div>
      <div class="empty-title">Sem dados para relatório</div>
      <div class="empty-sub" style="display:block">Crie potes e adicione lançamentos para ver os relatórios.</div>
    </div>`;
    return;
  }

  // Totais gerais
  let totalGasto = 0, totalPrev = 0;
  lancamentosArr.forEach(l => {
    if (l.tipo === 'previsto') totalPrev += Number(l.valor) || 0;
    else totalGasto += Number(l.valor) || 0;
  });
  let totalRealizadoServ = 0;
  Object.keys(services).forEach(svcId => { totalRealizadoServ += getRealizado(svcId); });
  const margem = totalRealizadoServ - (totalGasto + totalPrev);
  const margemProj = orcamento - (totalGasto + totalPrev);

  // ═══════════ KPIs principais ═══════════
  let html = `
    <div class="rep-kpis">
      <div class="rep-kpi">
        <div class="rep-kpi-lbl">Gastos realizados</div>
        <div class="rep-kpi-val">${fmtBRL(totalGasto)}</div>
        <div class="rep-kpi-sub">${orcamento > 0 ? Math.round(totalGasto/orcamento*100) : 0}% do orçamento</div>
      </div>
      <div class="rep-kpi">
        <div class="rep-kpi-lbl">Comprometido (previsto)</div>
        <div class="rep-kpi-val" style="color:var(--c-warning)">${fmtBRL(totalPrev)}</div>
        <div class="rep-kpi-sub">${orcamento > 0 ? Math.round(totalPrev/orcamento*100) : 0}% do orçamento</div>
      </div>
      <div class="rep-kpi">
        <div class="rep-kpi-lbl">Margem atual</div>
        <div class="rep-kpi-val ${margem >= 0 ? 'pos' : 'neg'}">${fmtBRL(margem)}</div>
        <div class="rep-kpi-sub">faturado − custos</div>
      </div>
      <div class="rep-kpi">
        <div class="rep-kpi-lbl">Margem projetada</div>
        <div class="rep-kpi-val ${margemProj >= 0 ? 'pos' : 'neg'}">${fmtBRL(margemProj)}</div>
        <div class="rep-kpi-sub">orçamento − custos lançados</div>
      </div>
    </div>
  `;

  // ═══════════ 1) Gasto por pote (com meta de % do orçamento) ═══════════
  if (potesArr.length) {
    html += '<div class="rep-section"><div class="rep-title">📦 Gasto realizado vs. meta por pote</div>';
    const maxValor = Math.max(...potesArr.map(p => Math.max(computePoteAvailable(p), computePoteSpend(p.id).total)), 1);
    potesArr.forEach(p => {
      const { gasto, previsto, total } = computePoteSpend(p.id);
      const meta = computePoteAvailable(p);
      const usadoPct = meta > 0 ? Math.round((total / meta) * 100) : 0;
      const fillW = Math.min(100, (total / maxValor) * 100);
      const metaW = Math.min(100, (meta / maxValor) * 100);
      const cls = usadoPct >= 100 ? 'over' : usadoPct >= 85 ? 'warn' : '';
      html += `
        <div class="rep-bar-row">
          <div class="rep-bar-name">${p.icon||'🏺'} ${escapeHtml(p.name)}</div>
          <div class="rep-bar-track" style="position:relative">
            <div class="rep-bar-fill ${cls}" style="background:${p.cor||'#1A7A9A'};width:${Math.max(2, fillW)}%">${total > 0 && fillW > 18 ? fmtBRL(total) : ''}</div>
            <div class="rep-bar-meta-line" style="left:${metaW}%" title="Meta: ${fmtBRL(meta)}"></div>
          </div>
          <div class="rep-bar-val">${fmtBRL(gasto)}${previsto > 0 ? ` <span style="color:var(--c-warning);font-size:10px">+${fmtBRL(previsto)} prev</span>` : ''}</div>
          <div class="rep-bar-pct ${cls}">${meta > 0 ? usadoPct + '%' : '—'}</div>
        </div>`;
    });
    html += '<div style="font-size:10.5px;color:var(--c-muted);margin-top:8px;display:flex;align-items:center;gap:8px"><span style="display:inline-block;width:14px;height:2px;background:var(--c-text);vertical-align:middle"></span>linha vertical = meta de R$ pelo % do pote</div>';
    html += '</div>';
  }

  // ═══════════ 2) Pizza/anel: distribuição do gasto entre potes ═══════════
  if (potesArr.length && totalGasto > 0) {
    const totalGastoPotes = potesArr.reduce((s, p) => s + computePoteSpend(p.id).gasto, 0);
    if (totalGastoPotes > 0) {
      html += '<div class="rep-section"><div class="rep-title">🥧 Distribuição do gasto entre potes</div>';
      html += '<div class="rep-pie-wrap">';
      // Constrói gradientes do conic
      let cumPct = 0;
      let stops = [];
      potesArr.forEach(p => {
        const g = computePoteSpend(p.id).gasto;
        if (g <= 0) return;
        const pct = (g / totalGastoPotes) * 100;
        const cor = p.cor || '#1A7A9A';
        stops.push(`${cor} ${cumPct.toFixed(2)}% ${(cumPct+pct).toFixed(2)}%`);
        cumPct += pct;
      });
      const conic = stops.length ? `conic-gradient(${stops.join(', ')})` : '#E8EEF5';
      html += `<div class="rep-pie" style="background:${conic}">
        <div class="rep-pie-hole">
          <div class="rep-pie-val">${fmtBRL(totalGastoPotes)}</div>
          <div class="rep-pie-lbl">total gasto</div>
        </div>
      </div>`;
      html += '<div class="rep-pie-legend">';
      potesArr.forEach(p => {
        const g = computePoteSpend(p.id).gasto;
        if (g <= 0) return;
        const pct = ((g / totalGastoPotes) * 100).toFixed(1);
        html += `<div class="rep-pie-leg-item">
          <span class="rep-pie-leg-dot" style="background:${p.cor||'#1A7A9A'}"></span>
          <span class="rep-pie-leg-name">${p.icon||'🏺'} ${escapeHtml(p.name)}</span>
          <span class="rep-pie-leg-pct">${pct}%</span>
          <span class="rep-pie-leg-val">${fmtBRL(g)}</span>
        </div>`;
      });
      html += '</div></div></div>';
    }
  }

  // ═══════════ 3) Gasto por categoria ═══════════
  const byCat = {};
  lancamentosArr.forEach(l => {
    if (l.tipo === 'previsto') return;
    const c = l.categoria || '— sem categoria —';
    byCat[c] = (byCat[c] || 0) + (Number(l.valor) || 0);
  });
  const catArr = Object.entries(byCat).sort((a,b) => b[1] - a[1]);
  if (catArr.length) {
    const totalCat = catArr.reduce((s, [,v]) => s + v, 0);
    const maxCat = catArr[0][1] || 1;
    html += '<div class="rep-section"><div class="rep-title">🏷 Gasto por categoria</div>';
    catArr.forEach(([cat, val]) => {
      const pct = (val / maxCat) * 100;
      const pctTotal = totalCat > 0 ? Math.round((val / totalCat) * 100) : 0;
      html += `
        <div class="rep-bar-row">
          <div class="rep-bar-name">${escapeHtml(cat)}</div>
          <div class="rep-bar-track">
            <div class="rep-bar-fill" style="background:#2A5580;width:${Math.max(2, pct)}%">${val > 0 && pct > 18 ? fmtBRL(val) : ''}</div>
          </div>
          <div class="rep-bar-val">${fmtBRL(val)}</div>
          <div class="rep-bar-pct">${pctTotal}%</div>
        </div>`;
    });
    html += '</div>';
  }

  // ═══════════ 4) Evolução mensal: gastos vs faturamento ═══════════
  const byMonthGasto = {};
  const byMonthPrev = {};
  lancamentosArr.forEach(l => {
    if (!l.data) return;
    const ym = l.data.substring(0, 7);
    if (l.tipo === 'previsto') byMonthPrev[ym] = (byMonthPrev[ym] || 0) + (Number(l.valor) || 0);
    else byMonthGasto[ym] = (byMonthGasto[ym] || 0) + (Number(l.valor) || 0);
  });
  const allMonths = new Set([...Object.keys(byMonthGasto), ...Object.keys(byMonthPrev)]);
  const monthsSorted = [...allMonths].sort();
  if (monthsSorted.length) {
    const maxM = Math.max(
      ...monthsSorted.map(m => (byMonthGasto[m] || 0) + (byMonthPrev[m] || 0)),
      1
    );
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    html += '<div class="rep-section"><div class="rep-title">📅 Evolução de gastos por mês</div>';
    html += '<div class="rep-monthbars">';
    monthsSorted.forEach(ym => {
      const [y, m] = ym.split('-');
      const lbl = `${meses[parseInt(m)-1]}/${y.slice(-2)}`;
      const g = byMonthGasto[ym] || 0;
      const p = byMonthPrev[ym] || 0;
      const total = g + p;
      const totalH = (total / maxM) * 100;
      const gH = total > 0 ? (g / total) * totalH : 0;
      const pH = total > 0 ? (p / total) * totalH : 0;
      html += `
        <div class="rep-monthbar">
          <div class="rep-monthbar-stack" title="Realizado: ${fmtBRL(g)} | Previsto: ${fmtBRL(p)}">
            <div class="rep-monthbar-prev" style="height:${pH}%"></div>
            <div class="rep-monthbar-real" style="height:${gH}%"></div>
          </div>
          <div class="rep-monthbar-lbl">${lbl}</div>
          <div class="rep-monthbar-val">${fmtBRL(total).replace('R$','').trim()}</div>
        </div>`;
    });
    html += '</div>';
    html += '<div style="font-size:10.5px;color:var(--c-muted);margin-top:8px;display:flex;align-items:center;gap:14px"><span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:2px;background:var(--c-teal);display:inline-block"></span>Realizado</span><span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:2px;background:var(--c-warning);display:inline-block"></span>Previsto/Comprometido</span></div>';
    html += '</div>';
  }

  // ═══════════ 5) Avanço físico × financeiro (se houver serviços) ═══════════
  if (TASKS_DEF && TASKS_DEF.length > 0 && orcamento > 0) {
    let totalDone = 0, totalProg = 0, totalPend = 0;
    TASKS_DEF.forEach(t => {
      const cobrado = Number((services[t.id] || {}).cobrado) || 0;
      const status = state ? state[t.id] : null;
      if (status === 'done') totalDone += cobrado;
      else if (status === 'progress') totalProg += cobrado;
      else totalPend += cobrado;
    });
    const pctDone = orcamento > 0 ? (totalDone / orcamento) * 100 : 0;
    const pctProg = orcamento > 0 ? (totalProg / orcamento) * 100 : 0;
    const pctPend = orcamento > 0 ? (totalPend / orcamento) * 100 : 0;

    html += `<div class="rep-section"><div class="rep-title">🏗 Avanço físico (por valor de serviço)</div>
      <div class="rep-stack">
        <div class="rep-stack-bar">
          <div class="rep-stack-seg done" style="width:${pctDone}%" title="Concluído: ${fmtBRL(totalDone)}">${pctDone > 8 ? Math.round(pctDone)+'%' : ''}</div>
          <div class="rep-stack-seg prog" style="width:${pctProg}%" title="Em andamento: ${fmtBRL(totalProg)}">${pctProg > 8 ? Math.round(pctProg)+'%' : ''}</div>
          <div class="rep-stack-seg pend" style="width:${pctPend}%" title="Pendente: ${fmtBRL(totalPend)}">${pctPend > 8 ? Math.round(pctPend)+'%' : ''}</div>
        </div>
        <div class="rep-stack-legend">
          <span><span class="rep-stack-dot done"></span>Concluído ${fmtBRL(totalDone)}</span>
          <span><span class="rep-stack-dot prog"></span>Em andamento ${fmtBRL(totalProg)}</span>
          <span><span class="rep-stack-dot pend"></span>Pendente ${fmtBRL(totalPend)}</span>
        </div>
      </div>
    </div>`;
  }

  cont.innerHTML = html;
}
window.renderRelatorios = renderRelatorios;


/* ═══════════════════════════════════════════
   POTE: criar / editar / excluir
═══════════════════════════════════════════ */
function selectPoteColor(el) {
  document.querySelectorAll('.color-picker .color-swatch').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('pf-cor').value = el.dataset.color;
}
window.selectPoteColor = selectPoteColor;

function openPoteModal(id) {
  if (!IS_ADMIN) return;
  editingPoteId = id || null;
  document.getElementById('pote-modal-title').textContent = id ? 'Editar pote' : 'Novo pote';
  document.getElementById('pote-del-btn').style.display = id ? '' : 'none';

  if (id) {
    const p = potes[id];
    if (!p) return;
    document.getElementById('pf-nome').value = p.name || '';
    document.getElementById('pf-percent').value = (p.percentMeta != null) ? p.percentMeta : '';
    document.getElementById('pf-cor').value = p.cor || '#1A7A9A';
    document.getElementById('pf-icon').value = p.icon || '🧱';
    document.getElementById('pf-desc').value = p.desc || '';
  } else {
    document.getElementById('pf-nome').value = '';
    document.getElementById('pf-percent').value = '';
    document.getElementById('pf-cor').value = '#1A7A9A';
    document.getElementById('pf-icon').value = '🧱';
    document.getElementById('pf-desc').value = '';
  }
  // Marca cor ativa
  const corAtual = document.getElementById('pf-cor').value;
  document.querySelectorAll('.color-picker .color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === corAtual);
  });
  // Atualiza resumo de soma de metas
  refreshPoteMetaSummary();
  // Liga listener no campo de % pra atualizar o resumo enquanto digita
  const pctInput = document.getElementById('pf-percent');
  pctInput.oninput = refreshPoteMetaSummary;

  document.getElementById('pote-modal').classList.add('show');
  setTimeout(() => document.getElementById('pf-nome').focus(), 50);
}

function refreshPoteMetaSummary() {
  const box = document.getElementById('pote-meta-summary');
  if (!box) return;
  const orcamento = getOrcamentoTotal();
  // Soma das metas dos OUTROS potes (excluindo o que está sendo editado)
  let outras = 0;
  Object.entries(potes).forEach(([id, p]) => {
    if (id === editingPoteId) return;
    outras += Number(p.percentMeta) || 0;
  });
  const inputPct = parseFloat((document.getElementById('pf-percent').value || '').replace(',', '.')) || 0;
  const soma = outras + inputPct;
  const restanteAteFechar = 100 - outras;

  let cls = '', msg = '';
  if (Math.abs(soma - 100) < 0.5) {
    cls = 'ok';
    msg = `Soma das metas: <strong>${fmtPct(soma)}</strong> ✓ Fechou em 100%.`;
  } else if (soma > 100.5) {
    cls = 'warn';
    msg = `Soma das metas: <strong>${fmtPct(soma)}</strong> — passou ${fmtPct(soma - 100)} de 100%. Reduza pra fechar.`;
  } else {
    cls = '';
    msg = `Outros potes somam ${fmtPct(outras)}. Resta <strong>${fmtPct(restanteAteFechar)}</strong> pra fechar em 100%.`;
  }
  if (orcamento > 0 && inputPct > 0) {
    const r$ = (inputPct / 100) * orcamento;
    msg += ` Esse pote vai dispor de <strong>${fmtBRL(r$)}</strong> (${fmtPct(inputPct)} do orçamento de ${fmtBRL(orcamento)}).`;
  } else if (orcamento === 0) {
    msg += ` <em>Preencha o "cobrado" dos serviços para ver o valor em R$ deste pote.</em>`;
  }
  box.className = 'pote-meta-summary ' + cls;
  box.innerHTML = msg;
}
function closePoteModal() {
  document.getElementById('pote-modal').classList.remove('show');
  editingPoteId = null;
}
window.openPoteModal = openPoteModal;
window.closePoteModal = closePoteModal;

async function savePote() {
  if (!IS_ADMIN || !fbSync) return;
  const nome = document.getElementById('pf-nome').value.trim();
  const percentMeta = parseFloat((document.getElementById('pf-percent').value || '').replace(',', '.')) || 0;
  const cor = document.getElementById('pf-cor').value;
  const icon = document.getElementById('pf-icon').value;
  const desc = document.getElementById('pf-desc').value.trim();

  if (!nome) {
    toast({title:'Nome obrigatório', kind:'warn'});
    return;
  }
  if (percentMeta < 0 || percentMeta > 100) {
    toast({title:'Meta inválida', msg:'Use um valor entre 0 e 100%.', kind:'warn'});
    return;
  }

  const id = editingPoteId || ('pote_' + Date.now().toString(36));
  const order = editingPoteId
    ? (potes[editingPoteId].order ?? Object.keys(potes).length)
    : Object.keys(potes).length;
  const data = { name:nome, percentMeta, cor, icon, desc, order, updatedAt: Date.now() };

  showSaving();
  try {
    await fbSync.set(fbSync.ref(fbSync.db, `financials/${OBRA_ID}/potes/${id}`), data);
    showOnlineSaved();
    closePoteModal();
    toast({title: editingPoteId ? 'Pote atualizado' : 'Pote criado', msg:`${nome} · ${fmtPct(percentMeta)}`});
  } catch(e) {
    console.error(e);
    showError('Erro ao salvar pote');
    toast({title:'Erro ao salvar', msg:e.message, kind:'err'});
  }
}
window.savePote = savePote;

/* Cria os 4 potes padrão da metodologia Sistema de Acompanhamento:
   Material (50%), Mão de obra (25%), Taxas e Impostos (15%), Lucro (10%).
   Não sobrescreve potes existentes — só roda quando não há nenhum. */
async function criarPotesPadrao() {
  if (!IS_ADMIN || !fbSync) return;
  // Segurança: se já existem potes, não cria duplicado.
  if (Object.keys(potes).length > 0) {
    toast({title:'Já existem potes', msg:'Apague os potes antes de recriar os padrão.', kind:'warn'});
    return;
  }
  const padroes = [
    { id:'pote_material',    name:'Material',          percentMeta:50, cor:'#1A7A9A', icon:'🧱', desc:'Insumos, materiais de construção, ferramentas e equipamentos.', order:0 },
    { id:'pote_maodeobra',   name:'Mão de obra',       percentMeta:25, cor:'#1A8A55', icon:'👷', desc:'Salários, diárias, encargos, terceiros e empreiteiros.', order:1 },
    { id:'pote_taxasimpostos', name:'Taxas e Impostos', percentMeta:15, cor:'#C05A00', icon:'📋', desc:'Tributos, taxas de prefeitura, alvarás, ART, ISS e similares.', order:2 },
    { id:'pote_lucro',       name:'Lucro',             percentMeta:10, cor:'#5E3FA0', icon:'💰', desc:'Margem da construtora — o lucro é planejado primeiro, não é "o que sobra".', order:3 },
  ];
  showSaving();
  try {
    const updates = {};
    const now = Date.now();
    padroes.forEach(p => {
      const { id, ...data } = p;
      updates[`financials/${OBRA_ID}/potes/${id}`] = { ...data, updatedAt: now };
    });
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    toast({title:'4 potes padrão criados', msg:'Material 50% · Mão de obra 25% · Taxas e Impostos 15% · Lucro 10%. Você pode ajustar os percentuais clicando em cada pote.', duration:6500});
  } catch(e) {
    console.error('[criarPotesPadrao]', e);
    showError('Erro ao criar potes padrão');
    toast({title:'Erro ao criar potes padrão', msg:e.message, kind:'err'});
  }
}
window.criarPotesPadrao = criarPotesPadrao;

/* ═══════════════════════════════════════════════════════════════════════
   CPM (Critical Path Method) — algoritmo correto baseado em DEPENDÊNCIAS
   ═══════════════════════════════════════════════════════════════════════
   Estrutura: cada tarefa pode ter t.deps = [{predId, lag}], onde lag em dias.
   FS (finish-to-start) é o tipo de dependência usado.

   Fluxo:
     1) Forward pass: ES (Early Start) e EF (Early Finish) por ordem topológica
     2) Backward pass: LS (Late Start) e LF (Late Finish) em ordem reversa
     3) Slack = LS - ES (em dias). Crítica = slack ≤ 0
     4) Se nenhuma dependência foi declarada, infere por proximidade temporal
        SOMENTE para a "espinha dorsal" (cadeia FS sequencial mais longa).
*/

// Lê dependências de uma tarefa de forma defensiva (formato pode ser objeto ou
// array, dependendo de como o Firebase serializou)
function getDeps(task) {
  if (!task || !task.deps) return [];
  if (Array.isArray(task.deps)) return task.deps.filter(d => d && d.predId);
  // Objeto indexado (Firebase às vezes guarda assim)
  return Object.values(task.deps).filter(d => d && d.predId);
}

function _toDate(s) { return new Date(s + 'T00:00:00'); }
function _diffDays(a, b) { return Math.round((b - a) / 86400000); }

// Detecta ciclo na cadeia de dependências. Retorna true se adicionar
// edge predId → succId criaria ciclo.
function _wouldCreateCycle(predId, succId, allTasks) {
  if (predId === succId) return true;
  // BFS a partir de succId seguindo as dependências (predecessoras dela e descendentes)
  const byId = {};
  allTasks.forEach(t => byId[t.id] = t);
  // Construímos o grafo: pred → succ. Para cada t, getDeps(t) = lista de preds
  // Logo "saindo" de pred chegamos em todos os t que têm pred como predecessor.
  const succsOf = {};
  allTasks.forEach(t => {
    getDeps(t).forEach(d => {
      (succsOf[d.predId] = succsOf[d.predId] || []).push(t.id);
    });
  });
  // Se já existe um caminho de succId até predId, criar predId→succId fecha o ciclo
  const visited = new Set();
  const stack = [succId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === predId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    (succsOf[cur] || []).forEach(s => stack.push(s));
  }
  return false;
}

// Ordena tarefas em ordem topológica (predecessoras antes). Em caso de
// ciclos remanescentes (não deveria ocorrer com validação no add), retorna
// ordem original.
function _topoSort(tasks) {
  const byId = {};
  tasks.forEach(t => byId[t.id] = t);
  const inDeg = {};
  const adj = {};
  tasks.forEach(t => {
    inDeg[t.id] = 0;
    adj[t.id] = [];
  });
  tasks.forEach(t => {
    getDeps(t).forEach(d => {
      if (byId[d.predId]) {
        adj[d.predId].push(t.id);
        inDeg[t.id] = (inDeg[t.id] || 0) + 1;
      }
    });
  });
  const queue = tasks.filter(t => !inDeg[t.id]).map(t => t.id);
  const order = [];
  while (queue.length) {
    const cur = queue.shift();
    order.push(cur);
    (adj[cur] || []).forEach(s => {
      inDeg[s]--;
      if (!inDeg[s]) queue.push(s);
    });
  }
  if (order.length !== tasks.length) {
    // Tem ciclo — devolve ordem natural pra não travar
    return tasks.map(t => t.id);
  }
  return order;
}

/* CPM Forward + Backward pass baseado em dependências EXPLÍCITAS.
   Retorna { es, ef, ls, lf, slack } indexados por taskId, em offset de dia
   absoluto a partir do menor ES (= 0). */
function _runCPM(tasks) {
  if (!tasks.length) return { es:{}, ef:{}, ls:{}, lf:{}, slack:{}, projectEnd:0 };
  const byId = {};
  tasks.forEach(t => byId[t.id] = t);

  // Reference: dia 0 = menor data de início entre tarefas SEM predecessoras.
  // Para tarefas com pred, ES vem de max(EF_pred + 1 + lag) — FS dependency:
  // sucessora começa NO DIA SEGUINTE ao fim da pred, ajustado pelo lag.
  const minStart = tasks.reduce((a,t) => !a || t.start < a ? t.start : a, null);
  const ref = _toDate(minStart);
  const startOff = id => _diffDays(ref, _toDate(byId[id].start));
  const dur = id => Math.max(1, byId[id].days || (_diffDays(_toDate(byId[id].start), _toDate(byId[id].end)) + 1));

  const order = _topoSort(tasks);
  const es = {}, ef = {};
  // Forward pass
  order.forEach(id => {
    const t = byId[id];
    const deps = getDeps(t);
    if (!deps.length) {
      es[id] = startOff(id);
    } else {
      let maxEF = -Infinity;
      deps.forEach(d => {
        if (ef[d.predId] !== undefined) {
          // FS: sucessora começa no dia EF_pred + 1 + lag
          const candidate = ef[d.predId] + 1 + (d.lag || 0);
          if (candidate > maxEF) maxEF = candidate;
        }
      });
      // Se nenhum pred válido foi resolvido, usa start próprio
      es[id] = (maxEF === -Infinity) ? startOff(id) : maxEF;
    }
    ef[id] = es[id] + dur(id) - 1;  // EF inclusivo
  });

  const projectEnd = order.reduce((a,id) => Math.max(a, ef[id]), 0);

  // Backward pass
  const ls = {}, lf = {};
  // Construir mapa de sucessores (quem depende de quem)
  const succs = {};
  tasks.forEach(t => {
    getDeps(t).forEach(d => {
      (succs[d.predId] = succs[d.predId] || []).push({ succId: t.id, lag: d.lag || 0 });
    });
  });

  // Em ordem reversa de topo
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const ss = succs[id] || [];
    if (!ss.length) {
      lf[id] = projectEnd;  // sem sucessoras → LF = fim do projeto
    } else {
      let minLF = Infinity;
      ss.forEach(({succId, lag}) => {
        if (ls[succId] !== undefined) {
          // Pred deve terminar 1 dia ANTES do início da sucessora (menos o lag)
          const c = ls[succId] - 1 - lag;
          if (c < minLF) minLF = c;
        }
      });
      lf[id] = (minLF === Infinity) ? projectEnd : minLF;
    }
    ls[id] = lf[id] - dur(id) + 1;
  }

  // Slack
  const slack = {};
  order.forEach(id => { slack[id] = ls[id] - es[id]; });

  return { es, ef, ls, lf, slack, projectEnd };
}

/* Calcula o conjunto de tarefas no caminho crítico — agora baseado em deps
   reais quando elas existem; fallback para heurística temporal quando NÃO
   há nenhuma dependência declarada (planilha legada). */
function _computeCriticalPath(tasks) {
  if (!tasks || tasks.length === 0) return new Set();

  const hasAnyDeps = tasks.some(t => getDeps(t).length > 0);

  if (hasAnyDeps) {
    // CPM real: crítica = slack ≤ 0 OU folga ≤ tolerância pequena (1d para
    // amortecer arredondamento de planilha)
    const cpm = _runCPM(tasks);
    const critSet = new Set();
    tasks.forEach(t => {
      if (cpm.slack[t.id] !== undefined && cpm.slack[t.id] <= 0) {
        critSet.add(t.id);
      }
    });
    return critSet;
  }

  // FALLBACK: sem dependências declaradas, infere a espinha dorsal temporal.
  // Mantém a heurística antiga MAS sem o limite arbitrário de 35% — a cadeia
  // mais longa É o caminho crítico nesse modelo simplificado.
  const sorted = [...tasks].sort((a,b) => {
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    if (a.end   !== b.end)   return b.end.localeCompare(a.end);
    return (a.id||'').localeCompare(b.id||'');
  });
  const N = sorted.length;
  const dur = i => _diffDays(_toDate(sorted[i].start), _toDate(sorted[i].end)) + 1;
  const dp = new Array(N).fill(0);
  const parent = new Array(N).fill(-1);

  for (let i = 0; i < N; i++) {
    dp[i] = dur(i);
    let bestJ = -1, bestDp = 0;
    for (let j = 0; j < i; j++) {
      const gap = _diffDays(_toDate(sorted[j].end), _toDate(sorted[i].start));
      if (gap < 0) continue;
      if (gap > 2) continue;
      if (dp[j] > bestDp) { bestDp = dp[j]; bestJ = j; }
    }
    if (bestJ >= 0) { dp[i] = bestDp + dur(i); parent[i] = bestJ; }
  }
  let bestEnd = 0;
  for (let i = 1; i < N; i++) if (dp[i] > dp[bestEnd]) bestEnd = i;
  const chain = new Set();
  let cur = bestEnd;
  while (cur >= 0) { chain.add(sorted[cur].id); cur = parent[cur]; }
  return chain;
}

/* Retorna { taskId → slack em dias }. Se a tarefa não tem dep nem é
   sucessora de ninguém, retorna undefined (não exibimos chip). */
function computeSlackForAll() {
  const result = {};
  if (!TASKS_DEF || !TASKS_DEF.length) return result;
  const hasAnyDeps = TASKS_DEF.some(t => getDeps(t).length > 0);
  if (!hasAnyDeps) return result;
  const cpm = _runCPM(TASKS_DEF);
  // Só retornamos para tarefas que efetivamente participam da rede de deps
  // (têm pred OU são pred de alguém)
  const inNetwork = new Set();
  TASKS_DEF.forEach(t => {
    if (getDeps(t).length > 0) inNetwork.add(t.id);
    getDeps(t).forEach(d => inNetwork.add(d.predId));
  });
  inNetwork.forEach(id => {
    if (cpm.slack[id] !== undefined) result[id] = cpm.slack[id];
  });
  return result;
}

async function recalcCaminhoCritico() {
  if (!IS_ADMIN || !fbSync) return;
  if (!TASKS_DEF || TASKS_DEF.length < 2) {
    toast({title:'Poucas atividades', msg:'Adicione pelo menos 2 atividades pra calcular o caminho crítico.', kind:'warn'});
    return;
  }
  const hasAnyDeps = TASKS_DEF.some(t => getDeps(t).length > 0);
  const msg = hasAnyDeps
    ? 'Recalcular o caminho crítico (CPM) com base nas dependências e datas? As marcações anteriores serão substituídas.'
    : 'Nenhuma dependência foi definida — vou usar a heurística temporal (cadeia sequencial mais longa).\n\nDica: para um cálculo mais preciso, ligue as barras predecessoras antes (botão "Ligar").\n\nContinuar mesmo assim?';
  if (!confirm(msg)) return;

  const critSet = _computeCriticalPath(TASKS_DEF);
  showSaving();
  try {
    const updates = {};
    TASKS_DEF.forEach(t => {
      updates[`tasks/${OBRA_ID}/definition/${t.id}/critical`] = critSet.has(t.id);
    });
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    const method = hasAnyDeps ? 'CPM (dependências)' : 'heurística temporal';
    toast({
      title: critSet.size > 0 ? `Caminho crítico recalculado · ${method}` : 'Nenhuma atividade crítica',
      msg: critSet.size > 0
        ? `${critSet.size} de ${TASKS_DEF.length} atividade${TASKS_DEF.length>1?'s':''} no caminho crítico ⚡`
        : 'As datas estão muito espaçadas pra formar uma cadeia. Use "Limpar marcações" se quiser.',
      duration: 5000
    });
  } catch(e) {
    console.error('[recalcCaminhoCritico]', e);
    showError('Erro ao recalcular');
    toast({title:'Erro ao recalcular', msg:e.message, kind:'err'});
  }
}
window.recalcCaminhoCritico = recalcCaminhoCritico;

/* Versão silenciosa do recálculo, disparada automaticamente quando algo
   muda (deps, datas, criação/exclusão). Usa debounce pra evitar múltiplas
   gravações em sequência (ex: import em lote, drag de várias barras).
   Só roda em modo admin e só persiste se o resultado mudou de fato. */
let _recalcCritTimer = null;
let _recalcCritLastHash = null;

function _hashCriticalSet(taskIds) {
  return [...taskIds].sort().join(',');
}

function _scheduleAutoRecalc() {
  if (!IS_ADMIN || !fbSync) return;
  clearTimeout(_recalcCritTimer);
  _recalcCritTimer = setTimeout(_runAutoRecalc, 600);
}

async function _runAutoRecalc() {
  if (!IS_ADMIN || !fbSync) return;
  if (!TASKS_DEF || TASKS_DEF.length < 2) return;

  let critSet;
  try {
    critSet = _computeCriticalPath(TASKS_DEF);
  } catch(e) {
    console.warn('[autoRecalc] falha no cálculo:', e);
    return;
  }

  // Compara com o estado atual: só grava se mudou de fato.
  // Isso é o que evita loop infinito: quando o próprio recálculo grava
  // os flags `critical` e o onValue dispara de novo, o newHash já bate
  // com o estado atual e a função sai sem regravar.
  const currentCriticals = TASKS_DEF.filter(t => t.critical).map(t => t.id);
  const oldHash = _hashCriticalSet(currentCriticals);
  const newHash = _hashCriticalSet([...critSet]);
  if (oldHash === newHash) return;

  _recalcCritLastHash = newHash;
  const updates = {};
  TASKS_DEF.forEach(t => {
    const isNowCritical = critSet.has(t.id);
    if (!!t.critical !== isNowCritical) {
      updates[`tasks/${OBRA_ID}/definition/${t.id}/critical`] = isNowCritical;
    }
  });
  if (!Object.keys(updates).length) return;

  try {
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    // Toast discreto, só pra avisar que recalculou — sem confirmar nada
    toast({
      title: 'Caminho crítico atualizado',
      msg: `${critSet.size} atividade${critSet.size!==1?'s':''} no caminho crítico ⚡`,
      duration: 2400
    });
  } catch(e) {
    console.warn('[autoRecalc] falha ao gravar:', e);
  }
}
window._scheduleAutoRecalc = _scheduleAutoRecalc;

async function limparCaminhoCritico() {
  if (!IS_ADMIN || !fbSync) return;
  if (!TASKS_DEF || TASKS_DEF.length === 0) return;
  const totalCriticas = TASKS_DEF.filter(t => t.critical).length;
  if (totalCriticas === 0) {
    toast({title:'Já está limpo', msg:'Nenhuma atividade está marcada como crítica.'});
    return;
  }
  if (!confirm(`Remover marcação de "caminho crítico" de todas as ${totalCriticas} atividade${totalCriticas>1?'s':''}?`)) return;
  showSaving();
  try {
    const updates = {};
    TASKS_DEF.forEach(t => {
      updates[`tasks/${OBRA_ID}/definition/${t.id}/critical`] = false;
    });
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    toast({title:'Caminho crítico limpo', msg:'Todas as marcações ⚡ foram removidas.'});
  } catch(e) {
    console.error('[limparCaminhoCritico]', e);
    showError('Erro ao limpar');
    toast({title:'Erro ao limpar', msg:e.message, kind:'err'});
  }
}
window.limparCaminhoCritico = limparCaminhoCritico;


/* ═══════════════════════════════════════════════════════════════════════
   EDIÇÃO DE DEPENDÊNCIAS EM MASSA (B2) + IMPORT SÓ DE DEPS (B3)
   ═══════════════════════════════════════════════════════════════════════ */

// Estado pendente da edição em massa: taskId → { predIds:string[], lag:number }
let depsBulkPending = {};

function openDepsBulkModal() {
  if (!IS_ADMIN) return;
  if (!TASKS_DEF || !TASKS_DEF.length) {
    toast({title:'Sem atividades', msg:'Adicione atividades primeiro.', kind:'warn'});
    return;
  }
  depsBulkPending = {};
  const tbody = document.getElementById('deps-bulk-body');
  // Ordena tasks pela ordem visual atual (sortable)
  const sorted = [...TASKS_DEF].sort((a,b) => (a.order||0) - (b.order||0));
  tbody.innerHTML = sorted.map(t => {
    const deps = getDeps(t);
    const predIds = deps.map(d => d.predId).join(', ');
    // Lag mais comum entre as deps (se todas iguais)
    const lags = deps.map(d => d.lag || 0);
    const lagShared = lags.length && lags.every(l => l === lags[0]) ? lags[0] : '';
    return `
      <tr data-task-id="${t.id}">
        <td class="id-cell">${escapeHtml(t.id)}</td>
        <td class="name-cell">${escapeHtml(t.name || '—')}</td>
        <td><input type="text" data-bulk-preds="${t.id}" value="${escapeHtml(predIds)}" placeholder="(vazio = sem preds)" oninput="onDepsBulkChange('${t.id}')"></td>
        <td><input type="number" data-bulk-lag="${t.id}" value="${lagShared}" placeholder="0" step="1" oninput="onDepsBulkChange('${t.id}')"></td>
      </tr>
    `;
  }).join('');
  document.getElementById('deps-bulk-summary').textContent = `${sorted.length} atividade${sorted.length>1?'s':''}`;
  document.getElementById('deps-bulk-modal').classList.add('show');
}
window.openDepsBulkModal = openDepsBulkModal;

function closeDepsBulkModal() {
  document.getElementById('deps-bulk-modal').classList.remove('show');
  depsBulkPending = {};
}
window.closeDepsBulkModal = closeDepsBulkModal;

// Marca a linha como "alterada" (visual) e armazena o estado pendente
function onDepsBulkChange(taskId) {
  const predInput = document.querySelector(`input[data-bulk-preds="${taskId}"]`);
  const lagInput  = document.querySelector(`input[data-bulk-lag="${taskId}"]`);
  if (!predInput || !lagInput) return;
  const t = TASKS_DEF.find(x => x.id === taskId);
  const origDeps = getDeps(t);
  const origPredIds = origDeps.map(d => d.predId).join(', ');
  const origLags = origDeps.map(d => d.lag || 0);
  const origLagShared = origLags.length && origLags.every(l => l === origLags[0]) ? String(origLags[0]) : '';

  const changed = predInput.value.trim() !== origPredIds || lagInput.value.trim() !== origLagShared;
  predInput.classList.toggle('changed', changed);
  lagInput.classList.toggle('changed', changed);

  // Conta total de mudanças
  const allChanged = document.querySelectorAll('input.changed[data-bulk-preds]').length;
  const summary = document.getElementById('deps-bulk-summary');
  summary.textContent = allChanged > 0
    ? `${allChanged} alteração${allChanged>1?'ões':''} pendente${allChanged>1?'s':''}`
    : `${TASKS_DEF.length} atividades`;
}
window.onDepsBulkChange = onDepsBulkChange;

// Parseia "t01, t02" → array de predIds existentes (válidos). Retorna {ok, deps, errors}
function _parsePredsText(text, ownTaskId) {
  const tokens = String(text || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const deps = [];
  const errors = [];
  tokens.forEach(tok => {
    let match = TASKS_DEF.find(t => t.id === tok);
    if (!match) match = TASKS_DEF.find(t => t.id.toLowerCase() === tok.toLowerCase());
    if (!match) match = TASKS_DEF.find(t => t.name && t.name.toLowerCase() === tok.toLowerCase());
    if (!match) match = TASKS_DEF.find(t => t.name && t.name.toLowerCase().includes(tok.toLowerCase()));
    if (!match) { errors.push(tok); return; }
    if (match.id === ownTaskId) { errors.push(`${tok} (próprio)`); return; }
    if (seen.has(match.id)) return;
    seen.add(match.id);
    deps.push(match.id);
  });
  return { deps, errors };
}

async function saveDepsBulk() {
  if (!IS_ADMIN || !fbSync) return;
  const rows = document.querySelectorAll('#deps-bulk-body tr');
  const updates = {};
  let nChanged = 0;
  const errorsList = [];

  rows.forEach(tr => {
    const taskId = tr.dataset.taskId;
    const predInput = tr.querySelector('input[data-bulk-preds]');
    const lagInput  = tr.querySelector('input[data-bulk-lag]');
    if (!predInput.classList.contains('changed') && !lagInput.classList.contains('changed')) return;

    const parsed = _parsePredsText(predInput.value, taskId);
    if (parsed.errors.length) {
      errorsList.push(`${taskId}: ${parsed.errors.join(', ')}`);
      predInput.classList.add('error');
      return;
    }
    predInput.classList.remove('error');

    const lag = Number(lagInput.value) || 0;
    const newDeps = parsed.deps.length ? parsed.deps.map(pid => ({ predId: pid, lag })) : null;
    updates[`tasks/${OBRA_ID}/definition/${taskId}/deps`] = newDeps;
    nChanged++;
  });

  if (errorsList.length) {
    toast({title:'IDs inválidos encontrados', msg:errorsList.slice(0,3).join(' · ') + (errorsList.length>3?'…':''), kind:'err'});
    return;
  }

  if (nChanged === 0) {
    closeDepsBulkModal();
    return;
  }

  // Carimbo de quem editou (no escopo da operação em lote)
  const stamp = _currentUserStamp(`Editou dependências em massa (${nChanged} atividade${nChanged>1?'s':''})`);
  if (stamp) {
    Object.keys(updates).filter(k => k.endsWith('/deps')).forEach(depKey => {
      const taskKey = depKey.replace(/\/deps$/, '/lastUpdatedBy');
      updates[taskKey] = stamp;
    });
  }
  updates[`tasks/${OBRA_ID}/updatedAt`] = Date.now();
  updates[`meta/${OBRA_ID}/lastUpdate`] = Date.now();

  showSaving();
  try {
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    toast({title:'Dependências atualizadas', msg:`${nChanged} atividade${nChanged>1?'s':''} alterada${nChanged>1?'s':''}.`, kind:'success'});
    closeDepsBulkModal();
  } catch(e) {
    console.error(e);
    showError('Erro ao salvar');
    toast({title:'Erro', msg:e.message, kind:'err'});
  }
}
window.saveDepsBulk = saveDepsBulk;



/* ═══════════════════════════════════════════════════════════════════════
   DESENHO DE SETAS DE DEPENDÊNCIA
   ═══════════════════════════════════════════════════════════════════════
   Para cada tarefa com deps, desenha uma seta da BORDA DIREITA da pred até
   a BORDA ESQUERDA da successor. Camada SVG sobreposta sobre o tbody do gantt. */
function drawDependencyArrows() {
  // Remove camada anterior
  const oldLayer = document.querySelector('.dep-svg-layer');
  if (oldLayer) oldLayer.remove();

  if (!TASKS_DEF || !TASKS_DEF.length) return;

  const root = document.getElementById('gantt-root');
  if (!root) return;
  const table = root.querySelector('table.gantt');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  const tableRect = table.getBoundingClientRect();
  const tbodyRect = tbody.getBoundingClientRect();

  // Cria SVG cobrindo toda a área da tabela (mesmo as colunas da esquerda
  // ficam dentro do retângulo, mas só desenharemos sobre as barras)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'dep-svg-layer');
  svg.style.width = tableRect.width + 'px';
  svg.style.height = tableRect.height + 'px';
  svg.style.position = 'absolute';
  svg.style.left = '0px';
  svg.style.top = '0px';
  // O wrap tem position:relative? Vamos nos ancorar nele.
  const wrap = root.parentElement;  // .gantt-wrap
  if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
  wrap.appendChild(svg);

  // Cache: bar position by taskId (relative to wrap)
  const barPos = {};
  document.querySelectorAll('.bar[data-task-id]').forEach(bar => {
    const id = bar.dataset.taskId;
    const r = bar.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    barPos[id] = {
      left: r.left - wrapRect.left,
      right: r.right - wrapRect.left,
      top: r.top - wrapRect.top,
      bottom: r.bottom - wrapRect.top,
      cy: (r.top + r.bottom) / 2 - wrapRect.top,
    };
  });

  TASKS_DEF.forEach(t => {
    const succPos = barPos[t.id];
    if (!succPos) return;
    getDeps(t).forEach(d => {
      const predPos = barPos[d.predId];
      if (!predPos) return;
      const isCrit = t.critical && (TASKS_DEF.find(x => x.id === d.predId) || {}).critical;

      // Detecta conflito: predecessora termina depois (ou junto) que sucessora começa
      const succStart = predPos === succPos ? null : succPos.left;
      const conflict = (predPos.right >= succPos.left + 1);

      const x1 = predPos.right;
      const y1 = predPos.cy;
      const x2 = succPos.left;
      const y2 = succPos.cy;

      // Curva: sai da direita da pred, vai pra direita um pouco, desce/sobe,
      // entra na esquerda da sucessora.
      const offsetX = 12;
      const path = `M ${x1} ${y1}
                    L ${x1 + offsetX} ${y1}
                    L ${x1 + offsetX} ${y2}
                    L ${x2 - 6} ${y2}`;

      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', path);
      let cls = '';
      if (conflict) cls = 'dep-conflict';
      else if (isCrit) cls = 'dep-crit';
      if (cls) p.setAttribute('class', cls);
      p.dataset.from = d.predId;
      p.dataset.to = t.id;
      svg.appendChild(p);

      // Arrow head triangle
      const ah = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      ah.setAttribute('points', `${x2-6},${y2-3.5} ${x2},${y2} ${x2-6},${y2+3.5}`);
      ah.setAttribute('class', 'arrow-head ' + cls);
      svg.appendChild(ah);
    });
  });
}

// Re-desenha quando a janela redimensiona (debounced)
let _drawDepsTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_drawDepsTimer);
  _drawDepsTimer = setTimeout(() => drawDependencyArrows(), 80);
});


/* ═══════════════════════════════════════════════════════════════════════
   MODAL: criar / editar atividade (admin)
   ═══════════════════════════════════════════════════════════════════════
   Modos:
     'new'  → criar atividade nova (sem pré-fill)
     'sub'  → criar subatividade (parentId = selectedTaskId, pred = selectedTaskId)
     'edit' → editar atividade existente (id em arg2) */

function updateSubButton() {
  const btn = document.getElementById('btn-add-sub');
  if (!btn) return;
  btn.disabled = !selectedTaskId;
  if (selectedTaskId) {
    const t = TASKS_DEF.find(x => x.id === selectedTaskId);
    btn.title = `Criar subatividade de "${t ? t.name : '?'}"`;
  } else {
    btn.title = 'Selecione uma atividade primeiro para criar uma subatividade';
  }
}

function openTaskModal(mode, taskIdToEdit) {
  if (!IS_ADMIN) return;
  if (mode === 'sub' && !selectedTaskId) {
    toast({title:'Selecione uma atividade', msg:'Clique na linha de uma atividade no cronograma e depois em "Subatividade".', kind:'warn'});
    return;
  }
  editingTaskId = (mode === 'edit') ? taskIdToEdit : null;
  const m = document.getElementById('task-modal');
  const title = document.getElementById('task-modal-title');
  const sub = document.getElementById('task-modal-sub');
  const btnSave = document.getElementById('tm-btn-save');
  const btnDel = document.getElementById('tm-btn-delete');

  // Reset campos
  ['tm-name','tm-start','tm-days','tm-dept','tm-valor','tm-pred-text'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('tm-phase').value = 'auto';
  document.querySelectorAll('.gm-err').forEach(el => el.classList.remove('show'));
  btnDel.style.display = 'none';

  // Datalist de departamentos
  const dl = document.getElementById('tm-dept-list');
  dl.innerHTML = '';
  const depts = [...new Set(TASKS_DEF.map(t => t.dept).filter(Boolean))].sort();
  depts.forEach(d => { const opt = document.createElement('option'); opt.value = d; dl.appendChild(opt); });

  let prefilledPreds = [];

  if (mode === 'new') {
    title.textContent = 'Nova atividade';
    sub.textContent = 'Preencha os campos abaixo. O sistema preenche o que faltar.';
    btnSave.textContent = 'Criar atividade';
    // Sugestão: data início = hoje (ou data fim da última tarefa + 1)
    const lastEnd = TASKS_DEF.reduce((a, t) => (!a || t.end > a) ? t.end : a, null);
    document.getElementById('tm-start').value = lastEnd
      ? isoFromDayOff(dayOff(lastEnd, parseDate(CHART_START_STR)) + 1)
      : todayStr();
  } else if (mode === 'sub') {
    const parent = TASKS_DEF.find(t => t.id === selectedTaskId);
    if (!parent) return;
    title.textContent = 'Nova subatividade';
    sub.textContent = `Será uma subatividade de "${parent.name}". Predecessora pré-selecionada.`;
    btnSave.textContent = 'Criar subatividade';
    // Sugestão: começa logo após o fim do pai
    document.getElementById('tm-start').value = isoFromDayOff(dayOff(parent.end, parseDate(CHART_START_STR)) + 1);
    document.getElementById('tm-dept').value = parent.dept || '';
    document.getElementById('tm-phase').value = parent.phase || 'auto';
    prefilledPreds = [{ predId: parent.id, lag: 0 }];
  } else if (mode === 'edit') {
    const t = TASKS_DEF.find(x => x.id === taskIdToEdit);
    if (!t) return;
    title.textContent = 'Editar atividade';
    sub.textContent = `ID: ${t.id}`;
    btnSave.textContent = 'Salvar alterações';
    btnDel.style.display = '';
    document.getElementById('tm-name').value = t.name || '';
    document.getElementById('tm-start').value = t.start || '';
    document.getElementById('tm-days').value = t.days || 1;
    document.getElementById('tm-dept').value = t.dept || '';
    document.getElementById('tm-phase').value = t.phase || 'auto';
    // Carrega valor cobrado existente do services/
    const svc = (typeof services !== 'undefined' && services && services[t.id]) || {};
    const cobrado = Number(svc.cobrado) || 0;
    document.getElementById('tm-valor').value = cobrado > 0 ? cobrado : '';
    prefilledPreds = getDeps(t);
  }

  renderPredList(editingTaskId, prefilledPreds);
  m.classList.add('show');
  setTimeout(() => document.getElementById('tm-name').focus(), 100);
}
window.openTaskModal = openTaskModal;

function closeTaskModal() {
  document.getElementById('task-modal').classList.remove('show');
  editingTaskId = null;
}
window.closeTaskModal = closeTaskModal;

function renderPredList(excludeId, prefilled) {
  const list = document.getElementById('tm-pred-list');
  const candidates = TASKS_DEF.filter(t => t.id !== excludeId);
  if (!candidates.length) {
    list.innerHTML = '<div class="pred-empty">Nenhuma outra atividade no cronograma ainda.</div>';
    return;
  }
  // Para evitar ciclos: exclui também os DESCENDENTES da tarefa que está sendo
  // editada (não pode depender de quem depende dela)
  const descendants = excludeId ? _getDescendants(excludeId) : new Set();

  const prefMap = {};
  (prefilled || []).forEach(d => prefMap[d.predId] = d.lag || 0);

  list.innerHTML = candidates.map(t => {
    const isDesc = descendants.has(t.id);
    const checked = prefMap[t.id] !== undefined;
    const lag = prefMap[t.id] || 0;
    return `
      <label class="pred-item ${isDesc ? 'pred-disabled' : ''}" title="${isDesc ? 'Não pode ser predecessora — criaria ciclo' : ''}">
        <input type="checkbox" data-pred-id="${t.id}" ${checked?'checked':''} ${isDesc?'disabled':''}>
        <div class="pred-item-name">${escapeHtml(t.name)}</div>
        <div class="pred-item-id">${t.id}</div>
        <div class="pred-item-dates">${fmtDate(t.start)} → ${fmtDate(t.end)}</div>
        <input type="number" class="pred-lag" data-pred-lag-id="${t.id}" value="${lag}" placeholder="lag" title="Lag (dias) — positivo: espera; negativo: começa antes" style="${checked?'display:inline-block':''}">
      </label>`;
  }).join('');

  // Mostra/esconde input de lag conforme o checkbox muda
  list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const lagInp = list.querySelector(`input[data-pred-lag-id="${cb.dataset.predId}"]`);
      if (lagInp) lagInp.style.display = cb.checked ? 'inline-block' : 'none';
    });
  });
}

function _getDescendants(taskId) {
  const desc = new Set();
  const stack = [taskId];
  const succsOf = {};
  TASKS_DEF.forEach(t => {
    getDeps(t).forEach(d => {
      (succsOf[d.predId] = succsOf[d.predId] || []).push(t.id);
    });
  });
  while (stack.length) {
    const cur = stack.pop();
    (succsOf[cur] || []).forEach(s => {
      if (!desc.has(s)) { desc.add(s); stack.push(s); }
    });
  }
  return desc;
}

async function saveTaskFromModal() {
  if (!IS_ADMIN || !fbSync) return;
  const name = document.getElementById('tm-name').value.trim();
  const start = document.getElementById('tm-start').value;
  const daysVal = Number(document.getElementById('tm-days').value);
  const dept = document.getElementById('tm-dept').value.trim() || 'Geral';
  let phase = document.getElementById('tm-phase').value;

  // Valor cobrado (R$) — opcional. Vazio = não toca em services.
  // Zero explícito = limpa o cobrado existente (admin escolheu remover).
  const valorRaw = document.getElementById('tm-valor').value.trim();
  let valorCobrado = null;
  if (valorRaw !== '') {
    const n = Number(valorRaw.replace(',', '.'));
    if (!isNaN(n) && n >= 0) valorCobrado = n;
  }

  // Validação
  let err = false;
  if (!name) { document.getElementById('tm-err-name').classList.add('show'); err = true; }
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) { document.getElementById('tm-err-start').classList.add('show'); err = true; }
  if (!daysVal || daysVal < 1 || daysVal > 999) { document.getElementById('tm-err-days').classList.add('show'); err = true; }
  if (err) return;

  // Coleta predecessoras: campo de texto livre tem prioridade sobre checkboxes
  const predTextRaw = (document.getElementById('tm-pred-text').value || '').trim();
  let deps = [];
  if (predTextRaw) {
    // Modo texto: parseia "t01, t02, t03" ou nomes aproximados
    const tokens = predTextRaw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const seen = new Set();
    const notFound = [];
    tokens.forEach(tok => {
      // 1) match direto por id
      let match = TASKS_DEF.find(t => t.id === tok);
      // 2) match por id case-insensitive
      if (!match) match = TASKS_DEF.find(t => t.id.toLowerCase() === tok.toLowerCase());
      // 3) match por nome (case-insensitive, includes)
      if (!match) match = TASKS_DEF.find(t => t.name && t.name.toLowerCase() === tok.toLowerCase());
      if (!match) match = TASKS_DEF.find(t => t.name && t.name.toLowerCase().includes(tok.toLowerCase()));
      if (match && match.id !== editingTaskId && !seen.has(match.id)) {
        seen.add(match.id);
        deps.push({ predId: match.id, lag: 0 });
      } else if (!match) {
        notFound.push(tok);
      }
    });
    if (notFound.length) {
      toast({title:'Predecessoras não encontradas', msg:`Ignoradas: ${notFound.join(', ')}`, kind:'warn'});
    }
  } else {
    // Modo checkbox (padrão)
    const checks = document.querySelectorAll('#tm-pred-list input[type=checkbox]:checked');
    checks.forEach(cb => {
      const pid = cb.dataset.predId;
      const lagInp = document.querySelector(`input[data-pred-lag-id="${pid}"]`);
      const lag = lagInp ? Number(lagInp.value) || 0 : 0;
      deps.push({ predId: pid, lag });
    });
  }

  // Inferir fase se 'auto'
  if (phase === 'auto') phase = inferPhaseClient(name, dept) || 'OBRA';

  // Calcular fim
  const end = isoFromDayOff(dayOff(start, parseDate(CHART_START_STR || start)) + daysVal - 1);

  // Gerar id se for new
  let id = editingTaskId;
  let parentId = null;
  if (!id) {
    id = generateNewTaskId();
    // Se for subatividade
    if (selectedTaskId && deps.length === 1 && deps[0].predId === selectedTaskId) {
      parentId = selectedTaskId;
    }
  }

  // Validar ciclo (apenas pra edição — em new é impossível)
  if (editingTaskId) {
    for (const d of deps) {
      if (_wouldCreateCycle(d.predId, editingTaskId, TASKS_DEF)) {
        const errEl = document.getElementById('tm-err-general');
        const t = TASKS_DEF.find(x => x.id === d.predId);
        errEl.textContent = `Não posso adicionar "${t ? t.name : d.predId}" como predecessora — criaria um ciclo.`;
        errEl.classList.add('show');
        return;
      }
    }
  }

  showSaving();
  try {
    const updates = {};
    const order = editingTaskId
      ? (TASKS_DEF.find(x => x.id === editingTaskId)?.order ?? TASKS_DEF.length)
      : TASKS_DEF.length;
    const data = {
      name, dept, phase, start, end, days: daysVal,
      critical: editingTaskId ? !!TASKS_DEF.find(x => x.id === editingTaskId)?.critical : false,
      order,
      deps,
    };
    // Carimbo de quem editou (com descrição da ação)
    const stamp = _currentUserStamp(editingTaskId ? 'Editou a atividade' : 'Criou a atividade');
    if (stamp) data.lastUpdatedBy = stamp;
    if (parentId) data.parentId = parentId;
    if (editingTaskId) {
      // Mantém parentId se existir
      const cur = TASKS_DEF.find(x => x.id === editingTaskId);
      if (cur && cur.parentId) data.parentId = cur.parentId;
    }
    Object.entries(data).forEach(([k,v]) => {
      updates[`tasks/${OBRA_ID}/definition/${id}/${k}`] = v;
    });
    // Para deps em particular, sobrescreve por completo (limpa antigas)
    updates[`tasks/${OBRA_ID}/definition/${id}/deps`] = deps.length ? deps : null;

    // Valor cobrado em services/{OBRA_ID}/{taskId}/cobrado
    // - vazio (null) → não toca no campo (preserva valor atual)
    // - 0 → limpa explícito
    // - > 0 → grava
    if (valorRaw !== '') {
      updates[`services/${OBRA_ID}/${id}/cobrado`] = valorCobrado > 0 ? valorCobrado : null;
      updates[`services/${OBRA_ID}/${id}/updatedAt`] = Date.now();
    }
    updates[`tasks/${OBRA_ID}/updatedAt`] = Date.now();
    updates[`meta/${OBRA_ID}/lastUpdate`] = Date.now();
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    closeTaskModal();
    toast({title: editingTaskId ? 'Atividade atualizada ✓' : 'Atividade criada ✓', msg: name, kind:'success'});
  } catch(e) {
    console.error('[saveTaskFromModal]', e);
    showError('Erro ao salvar atividade');
    toast({title:'Erro ao salvar', msg:e.message, kind:'err'});
  }
}
window.saveTaskFromModal = saveTaskFromModal;

async function deleteTaskFromModal() {
  if (!editingTaskId || !IS_ADMIN || !fbSync) return;
  const t = TASKS_DEF.find(x => x.id === editingTaskId);
  if (!t) return;

  // Avisa se há sucessoras
  const succs = TASKS_DEF.filter(x => getDeps(x).some(d => d.predId === editingTaskId));
  let warn = `Excluir a atividade "${t.name}"?`;
  if (succs.length) {
    warn += `\n\n⚠️ ${succs.length} atividade${succs.length>1?'s dependem':' depende'} desta — a${succs.length>1?'s':''} dependência${succs.length>1?'s':''} ${succs.length>1?'serão removidas':'será removida'} automaticamente.`;
  }
  // Avisa se tem subatividades (parentId apontando pra essa)
  const children = TASKS_DEF.filter(x => x.parentId === editingTaskId);
  if (children.length) {
    warn += `\n\n⚠️ ${children.length} subatividade${children.length>1?'s':''} também ser${children.length>1?'ão':'á'} removida${children.length>1?'s':''}.`;
  }
  if (!confirm(warn)) return;

  showSaving();
  try {
    const updates = {};
    updates[`tasks/${OBRA_ID}/definition/${editingTaskId}`] = null;
    updates[`progress/${OBRA_ID}/${editingTaskId}`] = null;
    // Remove subatividades em cascata
    children.forEach(c => {
      updates[`tasks/${OBRA_ID}/definition/${c.id}`] = null;
      updates[`progress/${OBRA_ID}/${c.id}`] = null;
    });
    // Remove referências em deps de outras tarefas
    succs.forEach(s => {
      const newDeps = getDeps(s).filter(d => d.predId !== editingTaskId);
      updates[`tasks/${OBRA_ID}/definition/${s.id}/deps`] = newDeps.length ? newDeps : null;
    });
    updates[`tasks/${OBRA_ID}/updatedAt`] = Date.now();
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    closeTaskModal();
    if (selectedTaskId === editingTaskId) selectedTaskId = null;
    updateSubButton();
    toast({title:'Atividade excluída', msg:t.name, kind:'info'});
  } catch(e) {
    console.error('[deleteTaskFromModal]', e);
    showError('Erro ao excluir');
    toast({title:'Erro ao excluir', msg:e.message, kind:'err'});
  }
}
window.deleteTaskFromModal = deleteTaskFromModal;

function generateNewTaskId() {
  // Encontra o maior número usado em IDs do tipo "tNNN" e soma 1
  let max = 0;
  TASKS_DEF.forEach(t => {
    const m = String(t.id || '').match(/^t(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 't' + String(max + 1).padStart(3, '0');
}

// Versão client-side da inferência de fase (espelha o admin.html simplificado)
const _PROJ_KW = ['projeto','arquitet','estrutural','cálculo','calculista','hidráulic','elétric','aprovaç','alvará','prefeitur','licenç','memorial','orçament','planejament','levantament','topograf','sondagem','compatibiliz','as built','as-built','art ','crea','consultor','engenheir'];
const _OBRA_KW = ['escavaç','movimentaç','fundaç','sapata','estaca','baldrame','estrutura ','pilar','viga','laje','concretagem','forma ','fôrma','alvenaria','tijolo','bloco','reboco','chapisc','massa ','cobertura','telhad','forro','esquadria','porta ','janela ','vidro','piso ','cerâmic','porcelanat','azulej','rejunte','pintura','textur','massa corrida','instalaç','tubulaç','fiaç','cabo ','fio ','acabament','limpeza ','paisagism','jardim','execuç','demoliç','gesso','drywall'];
function inferPhaseClient(name, dept) {
  const text = ((name||'') + ' ' + (dept||'')).toLowerCase();
  for (const kw of _PROJ_KW) if (text.includes(kw)) return 'PROJETOS';
  for (const kw of _OBRA_KW) if (text.includes(kw)) return 'OBRA';
  return null;
}


/* ═══════════════════════════════════════════════════════════════════════
   MODO LIGAR — clicar em barra A, depois B, cria dependência A→B
   ═══════════════════════════════════════════════════════════════════════ */

function toggleLinkingMode() {
  if (!IS_ADMIN) return;
  linkingMode = !linkingMode;
  linkSourceId = null;
  document.body.classList.toggle('linking-mode', linkingMode);
  const btn = document.getElementById('btn-link-mode');
  if (btn) btn.classList.toggle('mode-active', linkingMode);
  document.querySelectorAll('.bar.link-source').forEach(b => b.classList.remove('link-source'));
  if (linkingMode) {
    toast({title:'Modo Ligar ativado', msg:'Clique na atividade PREDECESSORA, depois na SUCESSORA. Esc para sair.', kind:'info', duration:5000});
  } else {
    toast({title:'Modo Ligar desativado', kind:'info', duration:1500});
  }
}
window.toggleLinkingMode = toggleLinkingMode;

function handleLinkingClick(taskId) {
  if (!linkingMode) return;
  if (!linkSourceId) {
    linkSourceId = taskId;
    document.querySelectorAll('.bar.link-source').forEach(b => b.classList.remove('link-source'));
    const bar = document.querySelector(`.bar[data-task-id="${taskId}"]`);
    if (bar) bar.classList.add('link-source');
    const t = TASKS_DEF.find(x => x.id === taskId);
    toast({title:'Predecessora selecionada', msg:`Agora clique na sucessora de "${t ? t.name : taskId}".`, kind:'info', duration:3500});
    return;
  }
  if (linkSourceId === taskId) {
    toast({title:'Mesma atividade', msg:'Escolha duas atividades diferentes.', kind:'warn'});
    return;
  }
  createDependency(linkSourceId, taskId);
  // Mantém ligando — facilita encadear várias
  linkSourceId = null;
  document.querySelectorAll('.bar.link-source').forEach(b => b.classList.remove('link-source'));
}

async function createDependency(predId, succId, lag = 0) {
  if (!IS_ADMIN || !fbSync) return;
  if (predId === succId) return;
  // Validar ciclo
  if (_wouldCreateCycle(predId, succId, TASKS_DEF)) {
    const p = TASKS_DEF.find(x => x.id === predId);
    const s = TASKS_DEF.find(x => x.id === succId);
    toast({title:'Não pode ligar', msg:`"${p?.name||predId}" não pode ser predecessora de "${s?.name||succId}" — criaria um ciclo.`, kind:'err', duration:5000});
    return;
  }
  const succ = TASKS_DEF.find(x => x.id === succId);
  if (!succ) return;
  // Já existe?
  const existing = getDeps(succ);
  if (existing.some(d => d.predId === predId)) {
    toast({title:'Já está ligada', msg:'Essa dependência já existe.', kind:'info'});
    return;
  }
  const newDeps = [...existing, { predId, lag }];
  showSaving();
  try {
    await fbSync.update(fbSync.ref(fbSync.db, `tasks/${OBRA_ID}/definition/${succId}`), {
      deps: newDeps,
    });
    showOnlineSaved();
    const p = TASKS_DEF.find(x => x.id === predId);
    toast({title:'Dependência criada ⛓', msg:`"${p?.name||predId}" → "${succ.name}"`, kind:'success'});
  } catch(e) {
    console.error('[createDependency]', e);
    showError('Erro ao criar dependência');
    toast({title:'Erro ao ligar', msg:e.message, kind:'err'});
  }
}
window.createDependency = createDependency;

async function removeDependency(predId, succId) {
  if (!IS_ADMIN || !fbSync) return;
  const succ = TASKS_DEF.find(x => x.id === succId);
  if (!succ) return;
  const newDeps = getDeps(succ).filter(d => d.predId !== predId);
  showSaving();
  try {
    await fbSync.update(fbSync.ref(fbSync.db, `tasks/${OBRA_ID}/definition/${succId}`), {
      deps: newDeps.length ? newDeps : null,
    });
    showOnlineSaved();
    toast({title:'Dependência removida', kind:'info'});
  } catch(e) {
    console.error('[removeDependency]', e);
    toast({title:'Erro ao remover dependência', msg:e.message, kind:'err'});
  }
}
window.removeDependency = removeDependency;

// ESC sai do modo Ligar
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && linkingMode) toggleLinkingMode();
});


/* ═══════════════════════════════════════════════════════════════════════
   ANCHOR DE LIGAR (drag from edge) — bolinha azul na borda direita da barra
   ═══════════════════════════════════════════════════════════════════════ */
function attachDepAnchors() {
  document.querySelectorAll('.dep-anchor').forEach(a => {
    a.addEventListener('mousedown', onAnchorMouseDown);
    a.addEventListener('touchstart', onAnchorMouseDown, { passive:false });
  });
}

function onAnchorMouseDown(e) {
  if (!IS_ADMIN) return;
  e.preventDefault();
  e.stopPropagation();
  const isTouch = e.type === 'touchstart';
  const point = isTouch ? e.touches[0] : e;
  const anchor = e.currentTarget;
  const bar = anchor.parentElement;
  const taskId = bar.dataset.taskId;
  const rect = anchor.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;

  // Cria SVG temporário cobrindo a tela inteira
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'temp-link-line');
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.width = window.innerWidth + 'px';
  svg.style.height = window.innerHeight + 'px';
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', startX);
  line.setAttribute('y1', startY);
  line.setAttribute('x2', startX);
  line.setAttribute('y2', startY);
  line.setAttribute('stroke', '#1A7A9A');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-dasharray', '5,4');
  line.setAttribute('opacity', '0.85');
  svg.appendChild(line);
  document.body.appendChild(svg);

  anchorCtx = { taskId, svg, line, startX, startY, isTouch };

  if (isTouch) {
    document.addEventListener('touchmove', onAnchorMouseMove, { passive:false });
    document.addEventListener('touchend', onAnchorMouseUp);
  } else {
    document.addEventListener('mousemove', onAnchorMouseMove);
    document.addEventListener('mouseup', onAnchorMouseUp);
  }
}

function onAnchorMouseMove(e) {
  if (!anchorCtx) return;
  const isTouch = e.type === 'touchmove';
  if (isTouch) e.preventDefault();
  const point = isTouch ? e.touches[0] : e;
  anchorCtx.line.setAttribute('x2', point.clientX);
  anchorCtx.line.setAttribute('y2', point.clientY);

  // Highlight da barra hovered
  document.querySelectorAll('.bar.link-source').forEach(b => b.classList.remove('link-source'));
  const elBelow = document.elementFromPoint(point.clientX, point.clientY);
  const bar = elBelow ? elBelow.closest('.bar') : null;
  if (bar && bar.dataset.taskId !== anchorCtx.taskId) {
    bar.classList.add('link-source');
  }
}

function onAnchorMouseUp(e) {
  if (!anchorCtx) return;
  const ctx = anchorCtx;
  anchorCtx = null;
  document.removeEventListener('mousemove', onAnchorMouseMove);
  document.removeEventListener('mouseup', onAnchorMouseUp);
  document.removeEventListener('touchmove', onAnchorMouseMove);
  document.removeEventListener('touchend', onAnchorMouseUp);

  const isTouch = ctx.isTouch;
  const point = isTouch ? (e.changedTouches && e.changedTouches[0]) : e;
  const elBelow = point ? document.elementFromPoint(point.clientX, point.clientY) : null;
  const targetBar = elBelow ? elBelow.closest('.bar') : null;
  document.querySelectorAll('.bar.link-source').forEach(b => b.classList.remove('link-source'));

  ctx.svg.remove();

  if (!targetBar) return;
  const targetId = targetBar.dataset.taskId;
  if (!targetId || targetId === ctx.taskId) return;
  createDependency(ctx.taskId, targetId);
}


/* ═══════════════════════════════════════════════════════════════════════
   POPOVER de ações por linha (botão "⋯")
   ═══════════════════════════════════════════════════════════════════════ */
function showRowPopover(e, taskId) {
  if (!IS_ADMIN) return;
  e.stopPropagation();
  const t = TASKS_DEF.find(x => x.id === taskId);
  if (!t) return;
  let pop = document.getElementById('row-popover');
  if (!pop) return;

  // [v3] Garante que o popover seja filho direto do <body>, pra escapar de
  // qualquer contexto de stacking ou container com transform/overflow.
  if (pop.parentElement !== document.body) {
    document.body.appendChild(pop);
  }
  pop.setAttribute('data-pop-version', 'v3');

  const deps = getDeps(t);
  const succs = TASKS_DEF.filter(x => getDeps(x).some(d => d.predId === taskId));

  // Histórico: quem editou por último
  const historyHtml = renderTaskHistoryLine(t);

  pop.innerHTML = `
    <button onclick="closeRowPopover();openTaskModal('edit','${taskId}')"><span class="pop-icon">✎</span> Editar atividade</button>
    <button onclick="closeRowPopover();selectedTaskId='${taskId}';updateSubButton();openTaskModal('sub')"><span class="pop-icon">↳</span> Criar subatividade</button>
    <div class="pop-divider"></div>
    <button onclick="closeRowPopover();openTaskModal('edit','${taskId}')"><span class="pop-icon">⛓</span> Editar predecessoras${deps.length?` (${deps.length})`:''}</button>
    ${succs.length ? `<button onclick="closeRowPopover();showSuccessorsToast('${taskId}')"><span class="pop-icon">→</span> ${succs.length} sucessora${succs.length>1?'s':''}</button>` : ''}
    <div class="pop-divider"></div>
    <button class="danger" onclick="closeRowPopover();editingTaskId='${taskId}';deleteTaskFromModal()"><span class="pop-icon">🗑</span> Excluir atividade</button>
    ${historyHtml}
  `;

  // [v3] Força reset de posição inline e estilos críticos antes de medir
  pop.style.position = 'fixed';
  pop.style.left = '-9999px';
  pop.style.top  = '-9999px';
  pop.classList.add('show');

  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Posição preferencial: abaixo do botão, alinhada à direita do botão
  let left = rect.right - pw;
  let top  = rect.bottom + 4;

  // Se ultrapassar borda direita
  if (left + pw > vw - 8) left = vw - pw - 8;
  // Se ultrapassar borda esquerda
  if (left < 8) left = 8;
  // Se não couber abaixo, abre acima
  if (top + ph > vh - 8) {
    top = rect.top - ph - 4;
    if (top < 8) top = Math.max(8, vh - ph - 8);
  }

  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';

  // Fechar ao clicar fora (ou rolar a página)
  setTimeout(() => {
    document.addEventListener('click', closeRowPopover, { once: true });
    window.addEventListener('scroll', closeRowPopover, { once: true, capture: true });
  }, 50);
}
window.showRowPopover = showRowPopover;

function closeRowPopover() {
  const pop = document.getElementById('row-popover');
  if (pop) pop.classList.remove('show');
}
window.closeRowPopover = closeRowPopover;

function showSuccessorsToast(taskId) {
  const succs = TASKS_DEF.filter(x => getDeps(x).some(d => d.predId === taskId));
  if (!succs.length) return;
  const lst = succs.slice(0, 5).map(s => '• ' + s.name).join('\n');
  toast({title:`${succs.length} sucessora${succs.length>1?'s':''}`, msg: lst + (succs.length > 5 ? `\n…e mais ${succs.length-5}` : ''), duration:6000});
}
window.showSuccessorsToast = showSuccessorsToast;


/* ═══════════════════════════════════════════════════════════════════════
   PROPAGAÇÃO de mudança de datas para sucessoras (modal "caso a caso")
   ═══════════════════════════════════════════════════════════════════════
   Quando o admin move/redimensiona uma barra que é predecessora, perguntamos
   o que fazer com cada sucessora afetada (mover ou manter parada). */

/* Detecta sucessoras impactadas por uma mudança e abre o modal se houver */
function maybePromptPropagation(changedTaskId, deltaDays) {
  if (!deltaDays) return;
  const succs = TASKS_DEF.filter(x => getDeps(x).some(d => d.predId === changedTaskId));
  if (!succs.length) return;
  // Para cada sucessora, calcula o "shift sugerido" = o quanto mover ela pra
  // manter o lag original. Se a pred apenas mudou ENCURTANDO antes do início,
  // talvez não precise mover — só perguntamos quando há conflito (a pred passa
  // do início da sucessora) OU quando mantar o lag original ajudaria.
  const items = succs.map(s => {
    const dep = getDeps(s).find(d => d.predId === changedTaskId);
    const lag = dep?.lag || 0;
    // Cálculo: idealmente, novo start de s = novo end de pred + lag + 1
    const pred = TASKS_DEF.find(x => x.id === changedTaskId);
    const idealStart = isoFromDayOff(dayOff(pred.end, parseDate(CHART_START_STR)) + lag + 1);
    const curShift = _diffDays(_toDate(s.start), _toDate(idealStart));
    return { id: s.id, name: s.name, curStart: s.start, suggestedStart: idealStart, suggestedShiftDays: curShift, action: 'move' };
  }).filter(i => i.suggestedShiftDays !== 0); // só mostra as que precisam mover

  if (!items.length) return;

  propagCtx = { changedId: changedTaskId, items };
  renderPropagModal();
}

function renderPropagModal() {
  if (!propagCtx) return;
  const m = document.getElementById('propag-modal');
  const list = document.getElementById('propag-list');
  list.innerHTML = propagCtx.items.map(it => {
    const dir = it.suggestedShiftDays > 0 ? 'avançar' : 'recuar';
    const abs = Math.abs(it.suggestedShiftDays);
    return `
      <div class="propag-item" data-pid="${it.id}">
        <div class="propag-info">
          <div class="propag-name">${escapeHtml(it.name)}</div>
          <div class="propag-shift">Sugestão: <strong>${dir} ${abs} dia${abs>1?'s':''}</strong> (de ${fmtDate(it.curStart)} para ${fmtDate(it.suggestedStart)})</div>
        </div>
        <div class="propag-actions">
          <button class="propag-pill ${it.action==='move'?'active-move':''}" onclick="setPropag('${it.id}','move')" type="button">Mover junto</button>
          <button class="propag-pill ${it.action==='keep'?'active-keep':''}" onclick="setPropag('${it.id}','keep')" type="button">Manter parada</button>
        </div>
      </div>`;
  }).join('');
  m.classList.add('show');
}

function setPropag(id, action) {
  if (!propagCtx) return;
  const it = propagCtx.items.find(x => x.id === id);
  if (it) it.action = action;
  renderPropagModal();
}
window.setPropag = setPropag;

function setAllPropag(action) {
  if (!propagCtx) return;
  propagCtx.items.forEach(it => it.action = action);
  renderPropagModal();
}
window.setAllPropag = setAllPropag;

function cancelPropag() {
  document.getElementById('propag-modal').classList.remove('show');
  propagCtx = null;
}
window.cancelPropag = cancelPropag;

async function applyPropag() {
  if (!propagCtx) return;
  const toMove = propagCtx.items.filter(i => i.action === 'move');
  document.getElementById('propag-modal').classList.remove('show');
  if (!toMove.length) { propagCtx = null; return; }

  showSaving();
  try {
    const updates = {};
    toMove.forEach(it => {
      const t = TASKS_DEF.find(x => x.id === it.id);
      if (!t) return;
      const newEnd = isoFromDayOff(dayOff(it.suggestedStart, parseDate(CHART_START_STR)) + (t.days - 1));
      updates[`tasks/${OBRA_ID}/definition/${it.id}/start`] = it.suggestedStart;
      updates[`tasks/${OBRA_ID}/definition/${it.id}/end`] = newEnd;
    });
    updates[`tasks/${OBRA_ID}/updatedAt`] = Date.now();
    await fbSync.update(fbSync.ref(fbSync.db), updates);
    showOnlineSaved();
    toast({title:`${toMove.length} sucessora${toMove.length>1?'s movidas':' movida'}`, kind:'success'});
  } catch(e) {
    console.error('[applyPropag]', e);
    toast({title:'Erro ao mover sucessoras', msg:e.message, kind:'err'});
  }
  propagCtx = null;
}
window.applyPropag = applyPropag;


async function deletePote() {
  if (!IS_ADMIN || !editingPoteId) return;
  const p = potes[editingPoteId];
  if (!p) return;
  const lancsDoPote = Object.values(lancamentos).filter(l => l.poteId === editingPoteId).length;
  const msg = `Excluir o pote "${p.name}"?` +
    (lancsDoPote ? `\n\nAtenção: existem ${lancsDoPote} lançamento(s) vinculado(s) a este pote. Eles ficarão sem pote (mas serão preservados).` : '');
  if (!confirm(msg)) return;

  showSaving();
  try {
    await fbSync.set(fbSync.ref(fbSync.db, `financials/${OBRA_ID}/potes/${editingPoteId}`), null);
    showOnlineSaved();
    closePoteModal();
    toast({title:'Pote excluído', kind:'info'});
  } catch(e) {
    showError('Erro ao excluir');
    toast({title:'Erro', msg:e.message, kind:'err'});
  }
}
window.deletePote = deletePote;

/* ═══════════════════════════════════════════
   LANÇAMENTO: criar / editar / excluir
═══════════════════════════════════════════ */
function openLancamentoModal(id) {
  if (!IS_ADMIN) return;
  if (!Object.keys(potes).length) {
    toast({title:'Crie um pote primeiro', msg:'Você precisa criar pelo menos um pote para registrar lançamentos.', kind:'warn'});
    switchFinSub('potes');
    return;
  }
  editingLancId = id || null;
  document.getElementById('lanc-modal-title').textContent = id ? 'Editar lançamento' : 'Novo lançamento';
  document.getElementById('lanc-del-btn').style.display = id ? '' : 'none';

  // Preenche select de potes
  const sel = document.getElementById('lf-pote');
  let opts = '';
  Object.entries(potes).sort((a,b) => (a[1].order ?? 999) - (b[1].order ?? 999)).forEach(([pid, p]) => {
    opts += `<option value="${pid}">${escapeHtml(p.name||'')}</option>`;
  });
  sel.innerHTML = opts;

  if (id) {
    const l = lancamentos[id];
    if (!l) return;
    sel.value = l.poteId || '';
    document.getElementById('lf-cat').value = l.categoria || '';
    document.getElementById('lf-desc').value = l.desc || '';
    document.getElementById('lf-valor').value = l.valor || '';
    document.getElementById('lf-data').value = l.data || todayStr();
    document.getElementById('lf-tipo').value = l.tipo || 'gasto';
    document.getElementById('lf-pagto').value = l.formaPagto || '';
    document.getElementById('lf-obs').value = l.obs || '';
  } else {
    document.getElementById('lf-cat').value = '';
    document.getElementById('lf-desc').value = '';
    document.getElementById('lf-valor').value = '';
    document.getElementById('lf-data').value = todayStr();
    document.getElementById('lf-tipo').value = 'gasto';
    document.getElementById('lf-pagto').value = '';
    document.getElementById('lf-obs').value = '';
  }
  document.getElementById('lanc-modal').classList.add('show');
  setTimeout(() => document.getElementById('lf-desc').focus(), 50);
}
function closeLancamentoModal() {
  document.getElementById('lanc-modal').classList.remove('show');
  editingLancId = null;
}
window.openLancamentoModal = openLancamentoModal;
window.closeLancamentoModal = closeLancamentoModal;

async function saveLancamento() {
  if (!IS_ADMIN || !fbSync) return;
  const poteId = document.getElementById('lf-pote').value;
  const cat = document.getElementById('lf-cat').value;
  const desc = document.getElementById('lf-desc').value.trim();
  const valor = parseFloat(document.getElementById('lf-valor').value) || 0;
  const data = document.getElementById('lf-data').value;
  const tipo = document.getElementById('lf-tipo').value;
  const formaPagto = document.getElementById('lf-pagto').value;
  const obs = document.getElementById('lf-obs').value.trim();

  if (!poteId) { toast({title:'Selecione um pote', kind:'warn'}); return; }
  if (!desc) { toast({title:'Descrição obrigatória', kind:'warn'}); return; }
  if (!data) { toast({title:'Data obrigatória', kind:'warn'}); return; }
  if (valor <= 0) { toast({title:'Valor deve ser maior que zero', kind:'warn'}); return; }

  const id = editingLancId || ('lanc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7));
  const payload = {
    poteId, categoria:cat, desc, valor, data, tipo, formaPagto, obs,
    createdAt: editingLancId ? (lancamentos[editingLancId]?.createdAt || Date.now()) : Date.now(),
    updatedAt: Date.now(),
  };

  showSaving();
  try {
    await fbSync.set(fbSync.ref(fbSync.db, `financials/${OBRA_ID}/lancamentos/${id}`), payload);
    showOnlineSaved();
    closeLancamentoModal();
    toast({title: editingLancId ? 'Lançamento atualizado' : 'Lançamento registrado', msg:`${desc} · ${fmtBRL(valor)}`});
  } catch(e) {
    console.error(e);
    showError('Erro ao salvar');
    toast({title:'Erro', msg:e.message, kind:'err'});
  }
}
window.saveLancamento = saveLancamento;

async function deleteLancamento() {
  if (!IS_ADMIN || !editingLancId) return;
  const l = lancamentos[editingLancId];
  if (!l) return;
  if (!confirm(`Excluir lançamento "${l.desc}" de ${fmtBRL(Number(l.valor)||0)}?`)) return;
  try {
    await fbSync.set(fbSync.ref(fbSync.db, `financials/${OBRA_ID}/lancamentos/${editingLancId}`), null);
    showOnlineSaved();
    closeLancamentoModal();
    toast({title:'Lançamento excluído', kind:'info'});
  } catch(e) {
    toast({title:'Erro', msg:e.message, kind:'err'});
  }
}
window.deleteLancamento = deleteLancamento;

/* Fecha modais ao clicar no backdrop ou pressionar ESC */
document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop.show').forEach(m => m.classList.remove('show'));
});

/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
loadLocal();
loadNotifPref();

if (typeof navigator !== 'undefined' && navigator.onLine === false) showOffline();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});

window.setFilter = setFilter;
window.onRowClick = onRowClick;
window.onStatusClick = onStatusClick;
window.toggleNotifications = toggleNotifications;
