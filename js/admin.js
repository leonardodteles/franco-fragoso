/* admin.js - Lógica de gestão do painel */
/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
let fb = null;
let currentUser = null;
let currentCompanyId = null;     // construtora do usuário logado
let currentCompany = null;       // { name, branding, ownerUid, ... }
let currentUserProfile = null;   // { companyId, role, displayName, ... }
let companyMembers = {};         // { uid: { email, displayName, role, addedAt } }
let obras = {};            // { obraId: {...} }
let codes = {};            // { CODE: { obraId, ativo } }
let tasksCount = {};       // { obraId: number }
let editingObraId = null;
let importObraId = null;
let pendingImport = null;  // { tasks: [...] }

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function normalizeCode(s) { return (s||'').trim().toUpperCase().replace(/\s+/g,''); }

function showLoading(text) { $('loading-text').textContent = text || 'Carregando…'; $('loading').classList.add('show'); }
function hideLoading() { $('loading').classList.remove('show'); }

function toast({title, msg, kind='success', duration=3800}) {
  const stack = $('toast-stack');
  const el = document.createElement('div');
  el.className = 'toast ' + (kind==='info'?'info':kind==='warn'?'warn':kind==='err'?'err':'');
  const ic = kind==='success'?'✓':kind==='info'?'ℹ':kind==='err'?'✕':'!';
  el.innerHTML = `
    <div class="toast-icon">${ic}</div>
    <div class="toast-body">
      <div class="toast-title">${esc(title||'')}</div>
      ${msg?`<div class="toast-msg">${esc(msg)}</div>`:''}
    </div>
    <button class="toast-close">×</button>
  `;
  stack.appendChild(el);
  const close = () => { el.classList.add('exit'); setTimeout(()=>el.remove(), 320); };
  el.querySelector('.toast-close').addEventListener('click', close);
  setTimeout(close, duration);
}

/* ═══════════════════════════════════════════
   AUTH + COMPANY BOOTSTRAP
═══════════════════════════════════════════ */
window.addEventListener('fb-ready', () => {
  fb = window.__FB__;
  fb.onAuthStateChanged(async user => {
    if (user) {
      currentUser = user;
      $('user-email').textContent = user.email;
      $('login-screen').style.display = 'none';
      // Esconde o painel até saber a empresa do usuário
      $('admin').classList.remove('active');
      $('onboarding').classList.remove('show');
      showLoading('Carregando seu painel…');

      try {
        // 1) Migração one-shot da Tailored (idempotente)
        await runTailoredMigrationIfNeeded(user);

        // 2) Carrega o perfil do usuário
        const profileSnap = await fb.get(fb.ref(fb.db, `users/${user.uid}`));
        currentUserProfile = profileSnap.val();

        if (currentUserProfile && currentUserProfile.companyId) {
          // Usuário pertence a uma construtora — carrega a empresa
          currentCompanyId = currentUserProfile.companyId;
          await loadCurrentCompany();
          hideLoading();
          $('admin').classList.add('active');
          subscribeData();
        } else {
          // Primeiro login: oferece criar a construtora
          hideLoading();
          $('onboarding').classList.add('show');
        }
      } catch(e) {
        console.error('[bootstrap]', e);
        hideLoading();
        toast({title:'Erro ao carregar painel', msg:e.message, kind:'err', duration:8000});
      }
    } else {
      currentUser = null;
      currentCompanyId = null;
      currentCompany = null;
      currentUserProfile = null;
      $('login-screen').style.display = 'flex';
      $('admin').classList.remove('active');
      $('onboarding').classList.remove('show');
    }
  });

  $('login-btn').addEventListener('click', doLogin);
  $('password').addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); });
  $('email').addEventListener('keydown', e => { if (e.key==='Enter') $('password').focus(); });
});

/* ═══════════════════════════════════════════
   MIGRAÇÃO ONE-SHOT: TAILORED
   Cria a empresa "tailored" se não existir, atribui leonardo.teles@tailored.eng.br
   como owner, atrela a única obra existente e migra branding.
═══════════════════════════════════════════ */
async function runTailoredMigrationIfNeeded(user) {
  // Roda apenas uma vez por instalação. Marcador em meta/migrationDone/tailored_v1.
  try {
    const flagSnap = await fb.get(fb.ref(fb.db, 'meta/migrationDone/tailored_v1'));
    if (flagSnap.val()) return; // já rodou
  } catch(e) {
    // se a leitura falhou, presumimos que a flag não existe e tentamos rodar
    console.warn('[migration] falha ao ler flag, tentando migrar:', e.message);
  }

  // Só faz sentido migrar quando o usuário logado é o Leonardo
  if ((user.email || '').toLowerCase() !== 'leonardo.teles@tailored.eng.br') return;

  console.log('[migration] iniciando migração Tailored…');
  const COMPANY_ID = 'tailored';
  const updates = {};

  // 1) Lê tudo que precisa (em paralelo, ignorando erros isolados)
  const [companySnap, oldBrandingSnap, obrasSnap, userProfileSnap] = await Promise.all([
    fb.get(fb.ref(fb.db, `companies/${COMPANY_ID}`)).catch(() => null),
    fb.get(fb.ref(fb.db, `settings/users/${user.uid}/branding`)).catch(() => null),
    fb.get(fb.ref(fb.db, 'obras')).catch(() => null),
    fb.get(fb.ref(fb.db, `users/${user.uid}`)).catch(() => null),
  ]);

  // 2) Cria a empresa Tailored (se ainda não existe)
  if (!companySnap || !companySnap.val()) {
    const oldBranding = (oldBrandingSnap && oldBrandingSnap.val()) || {};
    updates[`companies/${COMPANY_ID}`] = {
      name: oldBranding.companyName || 'Tailored Engenharia',
      ownerUid: user.uid,
      branding: {
        companyName: oldBranding.companyName || 'Tailored Engenharia',
        companyTag: oldBranding.companyTag || 'Excelência em cada detalhe',
        primaryColor: oldBranding.primaryColor || '#1A7A9A',
        secondaryColor: oldBranding.secondaryColor || '#2A5580',
        logoUrl: oldBranding.logoUrl || null,
        logoPath: oldBranding.logoPath || null,
      },
      createdAt: Date.now(),
    };
  }

  // 3) Cria/atualiza o perfil do Leonardo como owner
  if (!userProfileSnap || !userProfileSnap.val() || !userProfileSnap.val().companyId) {
    updates[`users/${user.uid}`] = {
      companyId: COMPANY_ID,
      role: 'owner',
      email: user.email,
      displayName: 'Leonardo Teles',
      addedAt: Date.now(),
    };
  }

  // 4) Atrela toda obra existente sem companyId à construtora Tailored
  const allObras = (obrasSnap && obrasSnap.val()) || {};
  Object.entries(allObras).forEach(([obraId, o]) => {
    if (!o.companyId) {
      updates[`obras/${obraId}/companyId`] = COMPANY_ID;
    }
  });

  // 5) Marca a migração como concluída
  updates['meta/migrationDone/tailored_v1'] = { at: Date.now(), by: user.uid };

  // Aplica tudo de uma vez
  if (Object.keys(updates).length > 0) {
    try {
      await fb.update(fb.ref(fb.db), updates);
      console.log('[migration] Tailored migrado com sucesso:', Object.keys(updates));
    } catch(e) {
      console.error('[migration] falhou:', e);
      // Não bloqueia o login — só loga
    }
  }
}

async function loadCurrentCompany() {
  if (!currentCompanyId) return;
  const snap = await fb.get(fb.ref(fb.db, `companies/${currentCompanyId}`));
  currentCompany = snap.val() || null;
  if (!currentCompany) {
    // Estado inconsistente: o usuário aponta pra uma empresa que sumiu
    throw new Error('Construtora não encontrada. Avise o suporte.');
  }
}

async function doLogin() {
  const email = $('email').value.trim();
  const pass  = $('password').value;
  const err   = $('login-err');
  err.classList.remove('show');

  if (!email || !pass) {
    err.textContent = 'Preencha email e senha.';
    err.classList.add('show');
    return;
  }
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-btn-label').innerHTML = '<span class="spin"></span>&nbsp;Entrando…';

  try {
    await fb.signInWithEmailAndPassword(email, pass);
  } catch(e) {
    let msg = 'Falha no login.';
    const code = e.code || '';
    if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
      msg = 'Email ou senha incorretos.';
    } else if (code.includes('too-many-requests')) {
      msg = 'Muitas tentativas. Tente novamente em alguns minutos.';
    } else if (code.includes('network')) {
      msg = 'Sem conexão com o servidor.';
    } else if (code.includes('operation-not-allowed')) {
      msg = 'Login por email/senha não está habilitado no Firebase. Vá em Authentication → Sign-in method e ative.';
    }
    err.textContent = msg;
    err.classList.add('show');
    btn.disabled = false;
    $('login-btn-label').textContent = 'Entrar';
  }
}

async function doLogout() {
  if (!confirm('Sair do painel administrativo?')) return;
  await fb.signOut();
}
window.doLogout = doLogout;

/* ═══════════════════════════════════════════
   DATA SUBSCRIPTIONS
═══════════════════════════════════════════ */
function subscribeData() {
  if (!currentCompanyId) return;

  // obras: lê todas e filtra por companyId
  fb.onValue(fb.ref(fb.db, 'obras'), snap => {
    const all = snap.val() || {};
    obras = {};
    Object.entries(all).forEach(([id, o]) => {
      if (o && o.companyId === currentCompanyId) obras[id] = o;
    });
    renderObras();
  }, err => {
    console.error('[obras]', err);
    toast({title:'Erro ao ler obras', msg:err.message, kind:'err', duration:6000});
  });

  // codes: lê todos (apenas para validar duplicatas; render filtra pelos obras visíveis)
  fb.onValue(fb.ref(fb.db, 'codes'), snap => {
    codes = snap.val() || {};
    renderObras();
  });

  // tasks count
  fb.onValue(fb.ref(fb.db, 'tasks'), snap => {
    const all = snap.val() || {};
    tasksCount = {};
    Object.keys(all).forEach(obraId => {
      const node = all[obraId];
      tasksCount[obraId] = node && node.definition ? Object.keys(node.definition).length : 0;
    });
    renderObras();
  });

  // membros da construtora
  fb.onValue(fb.ref(fb.db, 'users'), snap => {
    const all = snap.val() || {};
    companyMembers = {};
    Object.entries(all).forEach(([uid, u]) => {
      if (u && u.companyId === currentCompanyId) companyMembers[uid] = u;
    });
    renderEquipe();
  }, err => {
    console.warn('[users]', err);
  });

  // Recarrega a empresa em tempo real (pra refletir branding mudado em outra aba)
  fb.onValue(fb.ref(fb.db, `companies/${currentCompanyId}`), snap => {
    currentCompany = snap.val() || currentCompany;
    renderEquipe();
    // Se a aba "Empresa" estiver aberta e ainda não preencheu, sincroniza
    fillEmpresaFormFromCompany();
  });
}

/* ═══════════════════════════════════════════
   RENDER
═══════════════════════════════════════════ */
/* ──────── Estado de filtros / ordenação ──────── */
let obrasFilter = 'all';   // 'all' | 'active' | 'inactive'
let obrasSort = { key: 'nome', dir: 'asc' }; // key: nome|code|tasks|periodo

function setObrasFilter(f) {
  obrasFilter = f;
  document.querySelectorAll('.filter-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  renderObras();
}
window.setObrasFilter = setObrasFilter;

function setObrasSort(key) {
  if (obrasSort.key === key) {
    obrasSort.dir = obrasSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    obrasSort = { key, dir: 'asc' };
  }
  renderObras();
}
window.setObrasSort = setObrasSort;

function renderObras() {
  const body = $('obras-body');
  const q = ($('search').value || '').toLowerCase().trim();

  let list = Object.entries(obras)
    .map(([id, o]) => ({ id, ...o }))
    .filter(o => {
      // busca textual
      if (q) {
        const m = (o.nome||'').toLowerCase().includes(q) ||
                  (o.cliente||'').toLowerCase().includes(q) ||
                  (o.code||'').toLowerCase().includes(q);
        if (!m) return false;
      }
      // filtro de status
      if (obrasFilter !== 'all') {
        const ci = codes[o.code];
        const isActive = ci ? ci.ativo !== false : false;
        if (obrasFilter === 'active' && !isActive) return false;
        if (obrasFilter === 'inactive' && isActive) return false;
      }
      return true;
    });

  // ordenação
  const dir = obrasSort.dir === 'asc' ? 1 : -1;
  list.sort((a,b) => {
    let A, B;
    switch (obrasSort.key) {
      case 'code':    A=(a.code||''); B=(b.code||''); break;
      case 'tasks':   A=(tasksCount[a.id]||0); B=(tasksCount[b.id]||0); break;
      case 'periodo': A=(a.start||'9999'); B=(b.start||'9999'); break;
      default:        A=(a.nome||'').toLowerCase(); B=(b.nome||'').toLowerCase();
    }
    return A>B ? dir : A<B ? -dir : 0;
  });

  // Stats
  const total = Object.keys(obras).length;
  const active = Object.values(codes).filter(c => c && c.ativo !== false).length;
  const tasksAll = Object.values(tasksCount).reduce((a,b)=>a+b, 0);
  $('stat-total').textContent = total;
  $('stat-active').textContent = active;
  $('stat-tasks').textContent = tasksAll;

  if (list.length === 0) {
    if (total === 0) {
      body.innerHTML = `
        <div class="empty">
          <div class="empty-icon">🏗</div>
          <div class="empty-title">Nenhuma obra cadastrada</div>
          <div class="empty-sub">Clique em <strong>"Nova obra"</strong> no topo pra começar.<br><span style="font-size:11px;color:var(--c-muted)">Atalho: pressione <kbd style="background:var(--c-gray-bg);border:1px solid var(--c-border);border-radius:4px;padding:1px 6px;font-size:10px">N</kbd></span></div>
        </div>`;
    } else {
      body.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">Nenhum resultado</div><div class="empty-sub">Tente outra busca ou troque o filtro.</div></div>`;
    }
    return;
  }

  const sortClass = (k) => {
    if (obrasSort.key !== k) return 'sortable';
    return 'sortable sort-' + obrasSort.dir;
  };

  let html = `<table class="obras-table"><thead><tr>
    <th class="${sortClass('nome')}" style="width:32%" onclick="setObrasSort('nome')">Obra / Cliente <span class="sort-arrow"></span></th>
    <th class="${sortClass('code')}" onclick="setObrasSort('code')">Código <span class="sort-arrow"></span></th>
    <th class="${sortClass('tasks')}" onclick="setObrasSort('tasks')">Atividades <span class="sort-arrow"></span></th>
    <th class="${sortClass('periodo')}" onclick="setObrasSort('periodo')">Período <span class="sort-arrow"></span></th>
    <th style="text-align:right">Ações</th>
  </tr></thead><tbody>`;

  list.forEach(o => {
    const codeInfo = codes[o.code];
    const ativo = codeInfo ? codeInfo.ativo !== false : false;
    const nTasks = tasksCount[o.id] || 0;
    const periodo = (o.start && o.end)
      ? `${fmtDateBr(o.start)} — ${fmtDateBr(o.end)}`
      : '<span style="color:var(--c-muted);font-size:11px">Não definido</span>';

    html += `<tr>
      <td>
        <div class="obra-name">${esc(o.nome||'—')}</div>
        <div class="obra-client">${esc(o.cliente||'')}</div>
      </td>
      <td><span class="obra-code ${ativo?'':'off'}" onclick="copyCode(this,'${esc(o.code)}')" title="Clique pra copiar">${esc(o.code||'')}</span></td>
      <td><div class="obra-tasks">${nTasks}<span class="muted"> atividades</span></div></td>
      <td style="font-size:11.5px;color:var(--c-muted)">${periodo}</td>
      <td>
        <div class="row-actions">
          <button class="icon-action share" title="Compartilhar com cliente" onclick="openShareModal('${o.id}','${esc(o.code)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </button>
          <button class="icon-action" title="Ver obra" onclick="openObra('${o.id}','${esc(o.code)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="icon-action" title="Importar planilha" onclick="openImportModal('${o.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </button>
          <button class="icon-action" title="Editar" onclick="openEditObraModal('${o.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-action danger" title="Excluir" onclick="deleteObra('${o.id}','${esc(o.code)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  body.innerHTML = html;
}

function fmtDateBr(iso) {
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

$('#search'); // no-op
document.getElementById('search').addEventListener('input', renderObras);

/* ═══════════════════════════════════════════
   CREATE / EDIT OBRA
═══════════════════════════════════════════ */
/* ═══════════════════════════════════════════
   CODE VALIDATION (tempo real)
═══════════════════════════════════════════ */
function checkCodeAvailability() {
  const input = $('f-code');
  const help = $('f-code-help');
  const saveBtn = $('save-obra-btn');
  const raw = input.value;
  const code = normalizeCode(raw);

  // Reseta classes do help
  help.className = 'field-help';

  // Vazio — estado neutro
  if (!code) {
    help.textContent = 'Curto, memorável, ex: OBRA-001, CASA-VN.';
    saveBtn.disabled = false;
    return true;
  }

  // Formato inválido
  if (!/^[A-Z0-9\-]{2,20}$/.test(code)) {
    help.classList.add('err');
    help.innerHTML = '⚠ Use só letras, números e hífen (2–20 caracteres).';
    saveBtn.disabled = true;
    return false;
  }

  const existing = codes[code];
  const isOwnCode = editingObraId && existing && existing.obraId === editingObraId;

  if (existing && !isOwnCode) {
    // Código em uso por outra obra — sugere alternativas livres
    const suggestions = generateSuggestions(code).slice(0, 3);
    const chips = suggestions.map(s =>
      `<button type="button" class="suggestion-btn" onclick="applyCodeSuggestion('${s}')">${s}</button>`
    ).join('');
    help.classList.add('err');
    help.innerHTML = `⚠ Código <span class="code-chip">${esc(code)}</span> já está em uso. Sugestões: ${chips}`;
    saveBtn.disabled = true;
    return false;
  }

  // Disponível
  help.classList.add('ok');
  help.innerHTML = `✓ Código <span class="code-chip">${esc(code)}</span> disponível.`;
  saveBtn.disabled = false;
  return true;
}

function generateSuggestions(base) {
  const results = [];
  // 1) Sufixo numérico: CODIGO → CODIGO-2, CODIGO-3…
  for (let i = 2; i <= 9; i++) {
    const c = base + '-' + i;
    if (!codes[c] && c.length <= 20) results.push(c);
    if (results.length >= 5) break;
  }
  // 2) Sufixo letra: CODIGO → CODIGOA, CODIGOB…
  for (const L of ['A','B','C','D','E']) {
    const c = base + L;
    if (!codes[c] && c.length <= 20) results.push(c);
    if (results.length >= 8) break;
  }
  return [...new Set(results)];
}

function applyCodeSuggestion(code) {
  $('f-code').value = code;
  checkCodeAvailability();
  $('f-code').focus();
}
window.applyCodeSuggestion = applyCodeSuggestion;

// Instala o listener uma vez
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('f-code');
  if (input) {
    input.addEventListener('input', checkCodeAvailability);
    input.addEventListener('blur', checkCodeAvailability);
  }
});

function openNewObraModal() {
  editingObraId = null;
  $('obra-modal-title').textContent = 'Nova obra';
  $('f-nome').value = '';
  $('f-cliente').value = '';
  $('f-code').value = '';
  $('f-ativo').value = 'true';
  $('f-start').value = '';
  $('f-end').value = '';
  $('f-sub').value = '';
  $('obra-modal').classList.add('show');
  checkCodeAvailability();
  setTimeout(() => $('f-nome').focus(), 100);
}
function openEditObraModal(id) {
  const o = obras[id];
  if (!o) return;
  editingObraId = id;
  $('obra-modal-title').textContent = 'Editar obra';
  $('f-nome').value = o.nome || '';
  $('f-cliente').value = o.cliente || '';
  $('f-code').value = o.code || '';
  $('f-ativo').value = (codes[o.code]?.ativo === false) ? 'false' : 'true';
  $('f-start').value = o.start || '';
  $('f-end').value = o.end || '';
  $('f-sub').value = o.sub || '';
  $('obra-modal').classList.add('show');
  checkCodeAvailability();
}
function closeObraModal() {
  $('obra-modal').classList.remove('show');
}
window.openNewObraModal = openNewObraModal;
window.openEditObraModal = openEditObraModal;
window.closeObraModal = closeObraModal;

async function saveObra() {
  const nome    = $('f-nome').value.trim();
  const cliente = $('f-cliente').value.trim();
  const code    = normalizeCode($('f-code').value);
  const ativo   = $('f-ativo').value === 'true';
  const start   = $('f-start').value || null;
  const end     = $('f-end').value || null;
  const sub     = $('f-sub').value.trim();

  if (!nome || !cliente || !code) {
    toast({title:'Campos obrigatórios', msg:'Preencha nome, cliente e código.', kind:'warn'});
    return;
  }
  if (!/^[A-Z0-9\-]{2,20}$/.test(code)) {
    toast({title:'Código inválido', msg:'Use letras, números e hífen (2 a 20 caracteres).', kind:'warn'});
    return;
  }

  const existing = codes[code];
  if (existing && existing.obraId && existing.obraId !== editingObraId) {
    toast({title:'Código já em uso', msg:`O código ${code} já aponta para outra obra.`, kind:'err'});
    return;
  }

  showLoading('Salvando…');
  $('save-obra-btn').disabled = true;

  try {
    let id = editingObraId;
    if (!id) {
      id = 'obra_' + Date.now().toString(36);
    }

    // Toda obra pertence a uma construtora (multi-tenant). Em edição preserva o
    // companyId existente; em criação aplica a empresa do usuário logado.
    const existingCompanyId = editingObraId && obras[editingObraId] ? obras[editingObraId].companyId : null;
    const companyId = existingCompanyId || currentCompanyId;
    if (!companyId) {
      hideLoading();
      toast({title:'Sem construtora vinculada', msg:'Recarregue o painel.', kind:'err'});
      $('save-obra-btn').disabled = false;
      return;
    }

    const obraData = { nome, cliente, code, start, end, sub, companyId, updatedAt: Date.now() };
    // Branding agora é só por empresa — se existir branding antigo na obra, limpa
    if (editingObraId && obras[editingObraId]?.branding) {
      obraData.branding = null;
    }

    const updates = {};
    if (editingObraId && obras[editingObraId] && obras[editingObraId].code && obras[editingObraId].code !== code) {
      updates[`codes/${obras[editingObraId].code}`] = null;
    }
    updates[`obras/${id}`] = obraData;
    updates[`codes/${code}`] = { obraId: id, ativo };

    await fb.update(fb.ref(fb.db), updates);

    hideLoading();
    closeObraModal();
    toast({title: editingObraId ? 'Obra atualizada' : 'Obra criada', msg:`Código: ${code}`});
  } catch(e) {
    hideLoading();
    console.error(e);
    toast({title:'Erro ao salvar', msg:e.message, kind:'err', duration:6000});
  } finally {
    $('save-obra-btn').disabled = false;
  }
}
window.saveObra = saveObra;

async function deleteObra(id, code) {
  const o = obras[id];
  if (!o) return;
  const nTasks = tasksCount[id] || 0;
  openDangerModal({
    title: `Excluir a obra "${o.nome}"?`,
    sub: 'Esta ação não pode ser desfeita.',
    items: [
      'O cadastro completo da obra',
      `O código de acesso <strong>${esc(code)}</strong>`,
      `<strong>${nTasks}</strong> atividades cadastradas`,
      'Todo o progresso e histórico salvo',
    ],
    typedWord: 'EXCLUIR',
    confirmLabel: 'Excluir obra',
    onConfirm: async () => {
      showLoading('Excluindo…');
      try {
        const updates = {};
        updates[`obras/${id}`] = null;
        updates[`codes/${code}`] = null;
        updates[`tasks/${id}`] = null;
        updates[`progress/${id}`] = null;
        await fb.update(fb.ref(fb.db), updates);
        hideLoading();
        toast({title:'Obra excluída', kind:'info'});
      } catch(e) {
        hideLoading();
        toast({title:'Erro ao excluir', msg:e.message, kind:'err'});
      }
    }
  });
}
window.deleteObra = deleteObra;

function openObra(id, code) {
  window.location.href = `obra.html?id=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}&admin=1`;
}
window.openObra = openObra;

/* ═══════════════════════════════════════════
   IMPORT XLSX
═══════════════════════════════════════════ */
function openImportModal(obraId) {
  importObraId = obraId;
  pendingImport = null;
  const o = obras[obraId];
  $('import-obra-name').textContent = o ? o.nome : '';
  $('import-result').innerHTML = '';
  $('confirm-import-btn').style.display = 'none';
  $('file-input').value = '';
  $('import-modal').classList.add('show');
}
function closeImportModal() {
  $('import-modal').classList.remove('show');
  pendingImport = null;
  importObraId = null;
}
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;

const dropZone = $('drop-zone');
const fileInput = $('file-input');
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) handleFile(f);
});

function handleFile(file) {
  if (!file.name.match(/\.xlsx?$/i)) {
    showImportResult('Arquivo deve ser .xlsx ou .xls', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array', cellDates: true });
      const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('atividade')) || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' });
      processImport(rows);
    } catch(err) {
      console.error(err);
      showImportResult('Erro ao ler arquivo: ' + err.message, true);
    }
  };
  reader.readAsArrayBuffer(file);
}

// mapeia variações de nomes de coluna → chave interna
const HEADER_MAP = {
  'id':'id', 'ID':'id',
  'fase':'phase', 'Fase':'phase', 'FASE':'phase',
  'atividade':'name', 'Atividade':'name', 'nome':'name', 'tarefa':'name',
  'departamento':'dept', 'Departamento':'dept', 'setor':'dept', 'responsável':'dept', 'responsavel':'dept',
  'data início':'start', 'Data Início':'start', 'data inicio':'start', 'início':'start', 'inicio':'start', 'start':'start',
  'data fim':'end', 'Data Fim':'end', 'fim':'end', 'end':'end', 'término':'end', 'termino':'end',
  'dias':'days', 'Dias':'days', 'duração':'days', 'duracao':'days',
  'prazo':'days', 'Prazo':'days', 'prazo (dias)':'days',
  'crítica':'critical', 'Crítica':'critical', 'critica':'critical', 'critical':'critical',
  'predecessora':'pred', 'Predecessora':'pred', 'predecessoras':'pred', 'predec':'pred',
  'lag':'lag', 'Lag':'lag', 'lag (dias)':'lag', 'folga':'lag',
  'valor':'valor', 'Valor':'valor', 'valor (r$)':'valor', 'valor r$':'valor',
  'preço':'valor', 'preco':'valor', 'cobrado':'valor', 'orçamento':'valor', 'orcamento':'valor',
};

function normalizeKey(k) {
  return String(k||'').trim().toLowerCase().replace(/\s+/g,' ');
}

/* Parser robusto de valor monetário em pt-BR. Aceita:
   - número puro: 12000, 12000.5
   - formato BR: 12.000,50  →  12000.50
   - formato US: 12,000.50  →  12000.50
   - com prefixo: "R$ 12.000,50", "r$12000"
   - vazio/null/inválido → retorna null (campo continua opcional) */
function parseValorBR(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) && v >= 0 ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  // Remove R$, espaços, e qualquer letra
  s = s.replace(/r\$\s*/i, '').replace(/[^\d.,\-]/g, '');
  if (!s) return null;
  // Decide o separador decimal: o último ',' ou '.' que apareça é o decimal
  // se houver algum dos dois; o outro é separador de milhar.
  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // formato BR: 12.000,50 → 12000.50
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // formato US: 12,000.50 → 12000.50
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // só vírgula → assume decimal BR (12000,50)
    // exceção: se houver mais de uma vírgula, todas são milhar (1,234,567)
    const commaCount = (s.match(/,/g) || []).length;
    if (commaCount > 1) s = s.replace(/,/g, '');
    else                s = s.replace(',', '.');
  }
  // só ponto ou nada: parseFloat lida
  const n = parseFloat(s);
  if (isNaN(n) || n < 0) return null;
  return n;
}

function mapRow(row) {
  const out = {};
  Object.keys(row).forEach(k => {
    const mapped = HEADER_MAP[normalizeKey(k)] || HEADER_MAP[k];
    if (mapped) out[mapped] = row[k];
  });
  return out;
}

function excelDateToISO(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth()+1).padStart(2,'0'), d = String(v.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  // dd/mm/yyyy ou dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2,'0'), mm = m[2].padStart(2,'0');
    let yy = m[3]; if (yy.length === 2) yy = (Number(yy) > 50 ? '19' : '20') + yy;
    return `${yy}-${mm}-${dd}`;
  }
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  // número serial do Excel
  const n = Number(s);
  if (!isNaN(n) && n > 25000 && n < 60000) {
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    const y = d.getUTCFullYear(), mo = String(d.getUTCMonth()+1).padStart(2,'0'), dy = String(d.getUTCDate()).padStart(2,'0');
    return `${y}-${mo}-${dy}`;
  }
  return null;
}

function daysBetween(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const a = new Date(startIso), b = new Date(endIso);
  return Math.round((b - a) / 86400000) + 1;
}

/* Detecta automaticamente se uma atividade é PROJETOS ou OBRA com base em
   palavras-chave do nome e departamento. Usado quando o usuário não preenche
   a coluna "Fase" (que agora é opcional). */
const PROJ_KEYWORDS = [
  'projeto', 'projetos', 'projetar', 'projeção',
  'arquitetôn', 'arquitetura', 'arquiteto',
  'estrutural', 'cálculo', 'calculista',
  'hidráulic', 'elétric', 'sanitár', 'preventiv', 'incêndio',
  'aprovaç', 'alvará', 'prefeitur', 'licenç', 'corpo de bombeiro',
  'memorial', 'orçament', 'planejamento', 'projetiv',
  'levantament', 'topograf', 'sondagem', 'son dagem',
  'compatibiliz', 'as built', 'as-built', 'art ', 'crea', 'cau ',
  'consultor', 'engenheir', 'arquit'
];
const OBRA_KEYWORDS = [
  'escavaç', 'movimentaç', 'fundaç', 'sapata', 'estaca', 'baldrame',
  'estrutura ', 'pilar', 'viga', 'laje', 'concretagem', 'forma ', 'fôrma',
  'alvenaria', 'tijolo', 'bloco', 'reboco', 'chapisc', 'massa ',
  'cobertura', 'telhad', 'forro',
  'esquadria', 'porta ', 'janela ', 'vidro',
  'piso ', 'cerâmic', 'porcelanat', 'azulej', 'rejunte',
  'pintura', 'textur', 'massa corrida',
  'instalaç', 'tubulaç', 'fiaç', 'cabo ', 'fio ',
  'acabament', 'limpeza ', 'paisagism', 'jardim',
  'execuç', 'demoliç', 'demolic', 'gesso', 'drywall'
];

function inferPhase(name, dept) {
  const text = ((name||'') + ' ' + (dept||'')).toLowerCase();
  for (const kw of PROJ_KEYWORDS) if (text.includes(kw)) return 'PROJETOS';
  for (const kw of OBRA_KEYWORDS) if (text.includes(kw)) return 'OBRA';
  return null; // não consegui inferir
}

/* Detecta caminho crítico: heurística sem dependências explícitas.
   Modelo: ordena tarefas por data de início (e fim como tie-break). Constrói
   uma cadeia "encadeada" — cada próxima tarefa do caminho começa <= 1 dia
   após o fim da anterior (ou se sobrepõe). A cadeia mais longa em duração
   total é tratada como caminho crítico. */
function computeCriticalPath(tasks) {
  if (!tasks || tasks.length === 0) return new Set();
  const sorted = [...tasks].sort((a,b) => {
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    return a.end.localeCompare(b.end);
  });

  const N = sorted.length;
  const dayMs = 86400000;
  const toDate = s => new Date(s + 'T00:00:00');

  // dp[i] = duração total da maior cadeia que TERMINA em i
  const dp = new Array(N).fill(0);
  const parent = new Array(N).fill(-1);

  for (let i = 0; i < N; i++) {
    const ti = sorted[i];
    const dur = (toDate(ti.end) - toDate(ti.start)) / dayMs + 1;
    dp[i] = dur;
    for (let j = 0; j < i; j++) {
      const tj = sorted[j];
      // Considera "encadeado" se i começa até 1 dia após o fim de j
      // (ou simultâneo). Isso captura sequências sem folga.
      const gap = (toDate(ti.start) - toDate(tj.end)) / dayMs;
      if (gap <= 1 && (dp[j] + dur) > dp[i]) {
        dp[i] = dp[j] + dur;
        parent[i] = j;
      }
    }
  }
  // Pega o índice com maior dp
  let bestEnd = 0;
  for (let i = 1; i < N; i++) if (dp[i] > dp[bestEnd]) bestEnd = i;
  const critical = new Set();
  let cur = bestEnd;
  while (cur >= 0) {
    critical.add(sorted[cur].id);
    cur = parent[cur];
  }
  return critical;
}

function processImport(rows) {
  if (!rows || !rows.length) {
    showImportResult('Planilha vazia ou formato não reconhecido.', true);
    return;
  }

  const tasks = [];
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  let inferredPhaseCount = 0;
  let computedEndCount = 0;

  // 1ª passada: validação básica e construção das tarefas
  rows.forEach((raw, idx) => {
    const r = mapRow(raw);
    const lineNum = idx + 2;

    const name = String(r.name||'').trim();
    // Linha de subcabeçalho (Obrigatório/Opcional/Calculado) — pula
    if (!name) return;
    if (/^obrigat[óo]rio|opcional|calculado$/i.test(name)) return;

    // Fase: opcional (inferida)
    const phaseRaw = String(r.phase||'').trim().toUpperCase();
    let phase = phaseRaw.startsWith('PROJ') ? 'PROJETOS' : (phaseRaw.startsWith('OBRA') ? 'OBRA' : null);
    if (!phase) {
      phase = inferPhase(name, r.dept);
      if (phase) inferredPhaseCount++;
      else { phase = 'OBRA'; warnings.push(`Linha ${lineNum}: fase de "${name}" não identificada — assumi OBRA.`); }
    }

    const dept = String(r.dept||'').trim() || 'Geral';

    const start = excelDateToISO(r.start);
    if (!start) { errors.push(`Linha ${lineNum}: Data início inválida ("${r.start}").`); return; }

    // PRAZO em dias é a nova entrada principal. Fim é calculado a partir disso.
    let days = Number(r.days);
    let end = excelDateToISO(r.end);

    if (days && days > 0 && !isNaN(days)) {
      // Tem prazo informado → calcula fim como início + dias - 1
      const endComputed = addDaysIso(start, Math.floor(days) - 1);
      if (!end) { end = endComputed; computedEndCount++; }
      else if (end !== endComputed) {
        // Tem ambos: se conflitam, prefere o prazo (porque é o novo padrão)
        warnings.push(`Linha ${lineNum}: "Fim" da planilha (${fmtDateBr(end)}) não bate com Prazo de ${days}d. Usei o prazo → ${fmtDateBr(endComputed)}.`);
        end = endComputed;
      }
    } else if (end) {
      // Tem fim mas não tem prazo → calcula prazo a partir das datas
      days = daysBetween(start, end);
    } else {
      errors.push(`Linha ${lineNum}: informe o Prazo (em dias) ou a Data Fim de "${name}".`);
      return;
    }

    if (start > end) { errors.push(`Linha ${lineNum}: Início (${fmtDateBr(start)}) é posterior ao Fim (${fmtDateBr(end)}).`); return; }

    let id = String(r.id||'').trim();
    if (!id) id = 't' + String(tasks.length + 1).padStart(3,'0');
    if (seenIds.has(id)) { errors.push(`Linha ${lineNum}: ID duplicado ("${id}").`); return; }
    seenIds.add(id);

    const criticalRaw = String(r.critical||'').trim().toLowerCase();
    const explicitCritical = ['sim','s','yes','y','true','1','x'].includes(criticalRaw);

    // Valor (R$) — opcional. Aceita 12000, 12.000,50, 12,000.50, R$ 12000 etc.
    const valor = parseValorBR(r.valor);

    tasks.push({
      id, phase, name, dept, start, end, days,
      critical: explicitCritical, _explicitCritical: explicitCritical,
      valor: valor,                            // null se não preenchido
      _predRaw: String(r.pred || '').trim(),
      _lagRaw: r.lag,
      _line: lineNum,
    });
  });

  if (errors.length) {
    showImportResult(`Foram encontrados ${errors.length} erro(s):\n\n• ${errors.slice(0,8).join('\n• ')}${errors.length>8?'\n…':''}`, true);
    $('confirm-import-btn').style.display = 'none';
    pendingImport = null;
    return;
  }
  if (!tasks.length) {
    showImportResult('Nenhuma atividade válida encontrada.', true);
    return;
  }

  // 2ª passada: resolve predecessoras (texto livre → IDs)
  let predResolvedCount = 0;
  let predFailedRefs = [];
  tasks.forEach(t => {
    if (!t._predRaw) { t.deps = []; return; }
    const tokens = t._predRaw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    const deps = [];
    const lagShared = Number(t._lagRaw) || 0;
    tokens.forEach(tok => {
      // Tenta ID exato primeiro, depois nome aproximado
      let pred = tasks.find(x => x.id.toLowerCase() === tok.toLowerCase());
      if (!pred) {
        const norm = tok.toLowerCase();
        pred = tasks.find(x => x.name.toLowerCase() === norm)
            || tasks.find(x => x.name.toLowerCase().includes(norm) && norm.length >= 4)
            || tasks.find(x => norm.includes(x.name.toLowerCase()) && x.name.length >= 4);
      }
      if (pred && pred.id !== t.id) {
        // Evita duplicatas
        if (!deps.find(d => d.predId === pred.id)) {
          deps.push({ predId: pred.id, lag: lagShared });
          predResolvedCount++;
        }
      } else if (pred && pred.id === t.id) {
        warnings.push(`Linha ${t._line}: "${t.name}" não pode ser predecessora dela mesma.`);
      } else {
        predFailedRefs.push(`Linha ${t._line}: predecessora "${tok}" não encontrada para "${t.name}".`);
      }
    });
    t.deps = deps;
  });

  if (predFailedRefs.length) {
    predFailedRefs.slice(0, 5).forEach(r => warnings.push(r));
    if (predFailedRefs.length > 5) warnings.push(`…e mais ${predFailedRefs.length - 5} predecessora${predFailedRefs.length-5>1?'s':''} não resolvida${predFailedRefs.length-5>1?'s':''}`);
  }

  // 3ª passada: detecta ciclos nas dependências importadas
  const cycleNodes = detectCycles(tasks);
  if (cycleNodes.size) {
    const names = [...cycleNodes].slice(0, 4).map(id => {
      const t = tasks.find(x => x.id === id);
      return t ? t.name : id;
    });
    warnings.push(`Ciclo de dependências detectado em: ${names.join(', ')}${cycleNodes.size > 4 ? '…' : ''}. Removendo dependências problemáticas — revise manualmente.`);
    // Remove deps das tarefas em ciclo (mantém as tarefas, mas sem deps que causariam loop)
    tasks.forEach(t => {
      if (cycleNodes.has(t.id)) t.deps = [];
    });
  }

  // 4ª passada: SUGESTÕES INTELIGENTES de predecessoras pra tarefas sem nenhuma
  // Heurística: se uma tarefa não tem pred explícita, sugere a tarefa que
  // termina mais próximo ao início desta (até 5 dias antes), preferindo mesmo
  // departamento ou cadeia natural por palavras-chave.
  let suggestedDepsCount = 0;
  const sortedByStart = [...tasks].sort((a,b) => a.start.localeCompare(b.start));
  tasks.forEach(t => {
    if (t.deps && t.deps.length) return;  // já tem
    // Candidatos: tarefas que terminam até 5 dias antes desta começar
    const candidates = tasks.filter(c => {
      if (c.id === t.id) return false;
      const gap = Math.round((new Date(t.start) - new Date(c.end)) / 86400000);
      return gap >= -1 && gap <= 5;  // permite até 1 dia de overlap, até 5 de gap
    });
    if (!candidates.length) return;
    // Pontuação: mesmo dept = +5, fim mais perto = +pontos, fase igual = +2
    let best = null, bestScore = -Infinity;
    candidates.forEach(c => {
      const gap = Math.round((new Date(t.start) - new Date(c.end)) / 86400000);
      let score = 10 - Math.abs(gap);  // mais perto = mais alto
      if (c.dept === t.dept) score += 5;
      if (c.phase === t.phase) score += 2;
      // Penaliza se já é predecessora de muitas outras (poderia virar gargalo artificial)
      const succsCount = tasks.filter(x => (x.deps||[]).some(d => d.predId === c.id)).length;
      score -= succsCount * 0.5;
      if (score > bestScore) { bestScore = score; best = c; }
    });
    if (best && bestScore >= 5) {  // limiar mínimo pra evitar sugestões fracas
      // Verifica que não cria ciclo
      const hypothetical = tasks.map(x => ({ ...x, deps: x.deps || [] }));
      const tInHypo = hypothetical.find(x => x.id === t.id);
      tInHypo.deps = [{ predId: best.id, lag: 0 }];
      const newCycles = detectCycles(hypothetical);
      if (!newCycles.has(t.id)) {
        t.deps = [{ predId: best.id, lag: 0 }];
        t._suggestedDep = true;
        suggestedDepsCount++;
      }
    }
  });

  // 5ª passada: caminho crítico (com deps quando existem)
  const anyExplicitCrit = tasks.some(t => t._explicitCritical);
  let autoCritCount = 0;
  if (!anyExplicitCrit) {
    const criticalSet = computeCriticalPathNew(tasks);
    tasks.forEach(t => {
      if (criticalSet.has(t.id)) { t.critical = true; autoCritCount++; }
    });
  }

  // Avisos sobre paralelismo no mesmo dept (ainda útil)
  const byDept = {};
  tasks.forEach(t => { (byDept[t.dept] = byDept[t.dept] || []).push(t); });
  Object.entries(byDept).forEach(([dept, arr]) => {
    arr.sort((a,b) => a.start.localeCompare(b.start));
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].start <= arr[i-1].end && arr[i].id !== arr[i-1].id) {
        warnings.push(`Sobreposição em "${dept}": "${arr[i-1].name}" e "${arr[i].name}" rodam em paralelo.`);
      }
    }
  });

  // Limpeza: remove campos internos antes de salvar
  pendingImport = {
    tasks: tasks.map(t => {
      const { _explicitCritical, _predRaw, _lagRaw, _line, _suggestedDep, ...keep } = t;
      // Garante que deps seja array (ou undefined). Não salva array vazio pra não poluir.
      if (!keep.deps || !keep.deps.length) delete keep.deps;
      return keep;
    }),
  };
  renderImportPreview(tasks, {
    inferredPhaseCount,
    computedEndCount,
    predResolvedCount,
    suggestedDepsCount,
    autoCritCount,
    warnings,
  });
  $('confirm-import-btn').style.display = 'inline-flex';
}

/* Adiciona N dias a uma data ISO (string) e retorna ISO. N pode ser negativo. */
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

/* Detecta ciclos na rede de dependências. Retorna Set com IDs envolvidos.
   Faz Kahn topological sort: nós que não saem da fila são parte de ciclo. */
function detectCycles(tasks) {
  const inDeg = {};
  const adj = {};
  tasks.forEach(t => { inDeg[t.id] = 0; adj[t.id] = []; });
  tasks.forEach(t => {
    (t.deps || []).forEach(d => {
      if (inDeg[t.id] !== undefined && adj[d.predId]) {
        adj[d.predId].push(t.id);
        inDeg[t.id]++;
      }
    });
  });
  const queue = tasks.filter(t => !inDeg[t.id]).map(t => t.id);
  const visited = new Set(queue);
  while (queue.length) {
    const cur = queue.shift();
    (adj[cur] || []).forEach(s => {
      inDeg[s]--;
      if (!inDeg[s] && !visited.has(s)) { visited.add(s); queue.push(s); }
    });
  }
  const inCycle = new Set();
  tasks.forEach(t => { if (!visited.has(t.id)) inCycle.add(t.id); });
  return inCycle;
}

/* CPM novo: usa deps quando existem; fallback para heurística temporal */
function computeCriticalPathNew(tasks) {
  if (!tasks.length) return new Set();
  const hasDeps = tasks.some(t => (t.deps || []).length > 0);
  if (!hasDeps) return computeCriticalPath(tasks);  // heurística antiga

  // Forward + backward pass
  const byId = {}; tasks.forEach(t => byId[t.id] = t);
  const minStart = tasks.reduce((a,t) => !a || t.start < a ? t.start : a, null);
  const ref = new Date(minStart + 'T00:00:00');
  const startOff = id => Math.round((new Date(byId[id].start + 'T00:00:00') - ref) / 86400000);
  const dur = id => Math.max(1, byId[id].days || daysBetween(byId[id].start, byId[id].end));

  // Topological sort
  const inDeg = {}; const adj = {};
  tasks.forEach(t => { inDeg[t.id] = 0; adj[t.id] = []; });
  tasks.forEach(t => {
    (t.deps || []).forEach(d => {
      if (inDeg[t.id] !== undefined && adj[d.predId]) { adj[d.predId].push(t.id); inDeg[t.id]++; }
    });
  });
  const order = [];
  const queue = tasks.filter(t => !inDeg[t.id]).map(t => t.id);
  while (queue.length) {
    const cur = queue.shift();
    order.push(cur);
    (adj[cur]||[]).forEach(s => { inDeg[s]--; if (!inDeg[s]) queue.push(s); });
  }
  if (order.length !== tasks.length) return computeCriticalPath(tasks);  // ciclo: fallback

  const es = {}, ef = {};
  order.forEach(id => {
    const t = byId[id];
    const deps = t.deps || [];
    if (!deps.length) es[id] = startOff(id);
    else {
      let mx = -Infinity;
      deps.forEach(d => { if (ef[d.predId] !== undefined) { const c = ef[d.predId] + 1 + (d.lag||0); if (c > mx) mx = c; } });
      es[id] = (mx === -Infinity) ? startOff(id) : mx;
    }
    ef[id] = es[id] + dur(id) - 1;
  });
  const projectEnd = order.reduce((a,id) => Math.max(a, ef[id]), 0);

  const succs = {};
  tasks.forEach(t => (t.deps || []).forEach(d => {
    (succs[d.predId] = succs[d.predId] || []).push({ succId: t.id, lag: d.lag || 0 });
  }));
  const ls = {}, lf = {};
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const ss = succs[id] || [];
    if (!ss.length) lf[id] = projectEnd;
    else {
      let mn = Infinity;
      ss.forEach(({succId, lag}) => { if (ls[succId] !== undefined) { const c = ls[succId] - 1 - lag; if (c < mn) mn = c; } });
      lf[id] = (mn === Infinity) ? projectEnd : mn;
    }
    ls[id] = lf[id] - dur(id) + 1;
  }
  const crit = new Set();
  order.forEach(id => { if ((ls[id] - es[id]) <= 0) crit.add(id); });
  return crit;
}


function renderImportPreview(tasks, info) {
  const byPhase = { PROJETOS: 0, OBRA: 0 };
  let critCount = 0;
  let depsCount = 0;
  tasks.forEach(t => {
    byPhase[t.phase]++;
    if (t.critical) critCount++;
    if (t.deps && t.deps.length) depsCount++;
  });
  const dateStart = tasks.reduce((a,t) => !a || t.start < a ? t.start : a, null);
  const dateEnd   = tasks.reduce((a,t) => !a || t.end > a ? t.end : a, null);

  const inferredPhaseCount = info?.inferredPhaseCount || 0;
  const computedEndCount = info?.computedEndCount || 0;
  const predResolvedCount = info?.predResolvedCount || 0;
  const suggestedDepsCount = info?.suggestedDepsCount || 0;
  const autoCritCount = info?.autoCritCount || 0;
  const warnings = info?.warnings || [];

  let smartLine = '';
  const smartParts = [];
  if (computedEndCount > 0) smartParts.push(`<strong>${computedEndCount}</strong> com Fim calculado pelo Prazo`);
  if (inferredPhaseCount > 0) smartParts.push(`<strong>${inferredPhaseCount}</strong> com fase identificada`);
  if (predResolvedCount > 0) smartParts.push(`<strong>${predResolvedCount}</strong> dependência${predResolvedCount>1?'s':''} resolvida${predResolvedCount>1?'s':''}`);
  if (suggestedDepsCount > 0) smartParts.push(`<strong>${suggestedDepsCount}</strong> dependência${suggestedDepsCount>1?'s':''} sugerida${suggestedDepsCount>1?'s':''} 💡`);
  if (autoCritCount > 0) smartParts.push(`<strong>${autoCritCount}</strong> no caminho crítico ⚡`);
  if (smartParts.length) {
    smartLine = `<div style="font-size:11.5px;color:var(--c-teal);margin-top:6px;line-height:1.6">🤖 Sistema preencheu: ${smartParts.join(' · ')}</div>`;
  }

  // Caixa de explicação sobre as sugestões (caso tenham sido feitas)
  let suggestBox = '';
  if (suggestedDepsCount > 0) {
    suggestBox = `<div style="background:#E8F5EE;border-left:3px solid var(--c-success);padding:10px 14px;border-radius:7px;margin:10px 0;font-size:11.5px;color:#0E4A2E;line-height:1.55">
      💡 <strong>Sugestões inteligentes:</strong> ${suggestedDepsCount} atividade${suggestedDepsCount>1?'s':''} sem predecessora declarada receberam uma sugestão (a tarefa que termina logo antes, mesmo departamento de preferência). Você pode revisar e ajustar no cronograma após importar.
    </div>`;
  }

  let warnHtml = '';
  if (warnings.length) {
    warnHtml = `<div style="background:var(--c-warning-bg);border-left:3px solid var(--c-warning);padding:10px 14px;border-radius:7px;margin:10px 0;font-size:11.5px;color:#7A3500;line-height:1.55">
      <strong>${warnings.length} aviso${warnings.length>1?'s':''}:</strong>
      <ul style="margin:6px 0 0 16px;padding:0">${warnings.slice(0,5).map(w => `<li>${esc(w)}</li>`).join('')}${warnings.length>5?`<li>…e mais ${warnings.length-5}</li>`:''}</ul>
    </div>`;
  }

  let html = `
    <div class="import-summary">
      <strong>${tasks.length} atividades prontas pra importar</strong><br>
      <span style="font-size:11.5px;color:var(--c-success-deep)">
        ${byPhase.PROJETOS} em projetos · ${byPhase.OBRA} em obra · ${critCount} no caminho crítico · ${depsCount} com predecessora · período ${fmtDateBr(dateStart)} → ${fmtDateBr(dateEnd)}
      </span>
      ${smartLine}
    </div>
    ${suggestBox}
    ${warnHtml}
    <div class="import-preview">
      <table>
        <thead><tr><th>ID</th><th>Fase</th><th>Atividade</th><th>Dep.</th><th>Início</th><th>Fim</th><th>Dias</th><th>Pred.</th></tr></thead>
        <tbody>
  `;
  tasks.slice(0, 30).forEach(t => {
    let predTxt = '—';
    if (t.deps && t.deps.length) {
      const ids = t.deps.map(d => d.predId);
      predTxt = ids.join(', ') + (t._suggestedDep ? ' 💡' : '');
    }
    html += `<tr>
      <td>${esc(t.id)}</td>
      <td>${esc(t.phase)}</td>
      <td>${t.critical?'⚡ ':''}${esc(t.name)}</td>
      <td>${esc(t.dept)}</td>
      <td>${fmtDateBr(t.start)}</td>
      <td>${fmtDateBr(t.end)}</td>
      <td>${t.days}</td>
      <td style="font-size:10.5px;color:var(--c-muted)">${esc(predTxt)}</td>
    </tr>`;
  });
  if (tasks.length > 30) {
    html += `<tr><td colspan="8" style="text-align:center;color:var(--c-muted);font-style:italic">…mais ${tasks.length-30} atividades</td></tr>`;
  }
  html += '</tbody></table></div>';
  $('import-result').innerHTML = html;
}

function showImportResult(msg, isError) {
  $('import-result').innerHTML = `<div class="import-summary ${isError?'err':''}" style="white-space:pre-wrap">${esc(msg)}</div>`;
}

async function confirmImport() {
  if (!pendingImport || !importObraId) return;
  const o = obras[importObraId];
  if (!o) return;

  if (!confirm(`Importar ${pendingImport.tasks.length} atividades para "${o.nome}"?\n\nAs atividades atuais desta obra serão SUBSTITUÍDAS. O progresso dos IDs que permanecerem será mantido.`)) return;

  showLoading('Importando atividades…');
  $('confirm-import-btn').disabled = true;

  try {
    // Lê serviços atuais pra decidir se sobrescreve ou preserva (default:
    // não sobrescreve quem já tem cobrado preenchido pelo admin).
    const servicesSnap = await fb.get(fb.ref(fb.db, `services/${importObraId}`));
    const currentServices = servicesSnap.val() || {};

    // Monta definição indexada por id (sem o campo `valor` — esse vai pra
    // outro lugar, em services/, pra alimentar o financeiro).
    const definition = {};
    const valoresPorId = {};   // taskId → valor (apenas os preenchidos)
    pendingImport.tasks.forEach((t, i) => {
      const { valor, _predRaw, _lagRaw, _line, _explicitCritical, _suggestedDep, ...clean } = t;
      definition[t.id] = { ...clean, order: i };
      if (valor !== null && valor !== undefined && valor > 0) {
        valoresPorId[t.id] = valor;
      }
    });

    // Infere período se a obra não tiver
    const dateStart = pendingImport.tasks.reduce((a,t) => !a || t.start < a ? t.start : a, null);
    const dateEnd   = pendingImport.tasks.reduce((a,t) => !a || t.end > a ? t.end : a, null);

    const updates = {};
    updates[`tasks/${importObraId}/definition`] = definition;
    updates[`tasks/${importObraId}/updatedAt`] = Date.now();
    if (!o.start) updates[`obras/${importObraId}/start`] = dateStart;
    if (!o.end)   updates[`obras/${importObraId}/end`]   = dateEnd;

    // Popula services/ com os valores informados na planilha. Regra: só
    // preenche serviços vazios — não sobrescreve valor que o admin já
    // editou manualmente no Financeiro › Serviços.
    let servicosCriados = 0, servicosPreservados = 0;
    Object.entries(valoresPorId).forEach(([taskId, valor]) => {
      const atual = currentServices[taskId] || {};
      const cobradoAtual = Number(atual.cobrado) || 0;
      if (cobradoAtual > 0) {
        servicosPreservados++;
        return; // já tem valor manual, não toca
      }
      updates[`services/${importObraId}/${taskId}/cobrado`] = valor;
      updates[`services/${importObraId}/${taskId}/updatedAt`] = Date.now();
      servicosCriados++;
    });

    // Limpa progresso de IDs que não existem mais
    const progSnap = await fb.get(fb.ref(fb.db, `progress/${importObraId}`));
    const currentProg = progSnap.val() || {};
    Object.keys(currentProg).forEach(pid => {
      if (!definition[pid]) updates[`progress/${importObraId}/${pid}`] = null;
    });

    await fb.update(fb.ref(fb.db), updates);

    hideLoading();
    closeImportModal();
    let msgFinanceiro = '';
    if (servicosCriados > 0 || servicosPreservados > 0) {
      const parts = [];
      if (servicosCriados > 0)     parts.push(`${servicosCriados} valor${servicosCriados>1?'es':''} no financeiro`);
      if (servicosPreservados > 0) parts.push(`${servicosPreservados} preservado${servicosPreservados>1?'s':''} (já tinham valor)`);
      msgFinanceiro = ' · ' + parts.join(', ');
    }
    toast({title:'Importação concluída', msg:`${pendingImport.tasks.length} atividades salvas${msgFinanceiro}.`});
  } catch(e) {
    hideLoading();
    console.error(e);
    toast({title:'Erro ao importar', msg:e.message, kind:'err', duration:6000});
  } finally {
    $('confirm-import-btn').disabled = false;
  }
}
window.confirmImport = confirmImport;

/* ═══════════════════════════════════════════
   DOWNLOAD MODELO XLSX (gerado dinamicamente)
═══════════════════════════════════════════ */
function downloadModeloAtividades() {
  // Modelo radicalmente simples: 3 obrigatórios + 6 opcionais.
  // Atividade · Início · Prazo (dias) · [Fim calculado] · Predecessora · Lag · Valor (R$) · Departamento · ID · Fase
  const wb = XLSX.utils.book_new();

  const headers = ['Atividade', 'Início', 'Prazo (dias)', 'Fim', 'Predecessora', 'Lag (dias)', 'Valor (R$)', 'Departamento', 'ID', 'Fase'];
  const subhdr  = ['Obrigatório','Obrigatório','Obrigatório','Calculado','Opcional','Opcional','Opcional','Opcional','Opcional','Opcional'];
  const data = [
    headers,
    subhdr,
    ['Projeto arquitetônico final',         '06/01/2026', 15, '', '',     '',  8500,  'Arquitetura',  't01', ''],
    ['Escavação e movimentação de terra',   '02/02/2026', 20, '', 't01',  '',  12000, 'Equipe Obra',  't02', ''],
    ['Fundações',                           '23/02/2026', 25, '', 't02',  '',  35000, 'Equipe Obra',  't03', ''],
  ];
  // Mais 60 linhas em branco
  for (let i = 0; i < 60; i++) data.push(['', '', '', '', '', '', '', '', '', '']);

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Fórmula da coluna Fim para todas as linhas de dados (3..67)
  // Fim = Início + Prazo - 1 (inclusivo)
  for (let r = 3; r <= 67; r++) {
    const cell = `D${r}`;
    ws[cell] = { t: 's', f: `IF(AND(B${r}<>"",C${r}<>""),B${r}+C${r}-1,"")` };
  }

  ws['!cols'] = [
    { wch: 42 },  // Atividade
    { wch: 13 },  // Início
    { wch: 12 },  // Prazo
    { wch: 13 },  // Fim
    { wch: 18 },  // Predecessora
    { wch: 11 },  // Lag
    { wch: 14 },  // Valor (R$)
    { wch: 22 },  // Departamento
    { wch: 9 },   // ID
    { wch: 13 },  // Fase
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 2, topLeftCell: 'A3', activePane: 'bottomLeft' };
  XLSX.utils.book_append_sheet(wb, ws, 'Atividades');

  // Aba 2: Como preencher
  const ins = [
    ['COMO PREENCHER A PLANILHA', ''],
    ['', ''],
    ['Você só precisa de 3 colunas:', ''],
    ['Atividade', 'Nome da tarefa, ex: "Fundações", "Pintura externa"'],
    ['Início', 'Data em que começa, ex: 02/02/2026'],
    ['Prazo (dias)', 'Quantos dias dura, ex: 20'],
    ['', ''],
    ['A coluna Fim é calculada automaticamente.', ''],
    ['', ''],
    ['PARA UM PLANEJAMENTO MAIS INTELIGENTE:', ''],
    ['Predecessora', 'Qual atividade precisa terminar antes desta começar.'],
    ['', '  Use o ID da outra atividade (ex: t02) ou o nome dela.'],
    ['', '  Para várias predecessoras: separe por vírgula → "t01, t02"'],
    ['Lag (dias)', 'Folga em dias entre o fim da predecessora e o início desta.'],
    ['', '  Ex: 3 = espera 3 dias depois que a anterior termina.'],
    ['', '  Negativo (-2) = começa 2 dias antes do fim da anterior.'],
    ['', ''],
    ['VALOR DO SERVIÇO (financeiro):', ''],
    ['Valor (R$)', 'Valor que será cobrado por este serviço, ex: 12000.'],
    ['', '  Quando preenchido, vira o "Cobrado" na aba Financeiro › Serviços.'],
    ['', '  Vazio: a atividade não entra no financeiro (você pode preencher depois).'],
    ['', ''],
    ['OPCIONAIS (deixe vazio se não souber):', ''],
    ['Departamento', 'Setor responsável. Define a cor da barra.'],
    ['ID', 'Código curto pra referenciar (ex: t01). Sistema gera se vazio.'],
    ['Fase', 'PROJETOS ou OBRA. Sistema descobre pelo nome se vazio.'],
    ['', ''],
    ['O QUE O SISTEMA FAZ SOZINHO:', ''],
    ['•', 'Calcula a Data Fim (Início + Prazo)'],
    ['•', 'Identifica a Fase quando você não preenche'],
    ['•', 'Calcula o caminho crítico de verdade (com base nas predecessoras)'],
    ['•', 'Sugere predecessoras que faltam, depois que você importa'],
    ['•', 'Popula o financeiro com os valores informados'],
    ['•', 'Avisa de problemas: datas conflitantes, atividades órfãs, ciclos'],
    ['', ''],
    ['REGRAS:', ''],
    ['•', 'Não renomeie as colunas nem mude a ordem'],
    ['•', 'A primeira aba precisa se chamar "Atividades"'],
    ['•', 'Datas: dd/mm/aaaa, dd-mm-aaaa ou aaaa-mm-dd'],
    ['•', 'Valores: use ponto ou vírgula como separador decimal (12000 ou 12.000,50)'],
    ['•', 'IDs duplicados são rejeitados'],
    ['•', 'Apague os 3 exemplos antes de importar (linhas 3-5)'],
    ['', ''],
    ['DICA:', 'Não trave montando o cronograma perfeito na planilha. Coloque o que sabe, importe, e ajuste no Gantt — é mais fácil arrastar barra do que mexer em planilha.'],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(ins);
  ws2['!cols'] = [{ wch: 30 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Como preencher');

  XLSX.writeFile(wb, 'modelo-atividades.xlsx');
  toast({title:'Modelo baixado', msg:'Confira a aba "Como preencher" para o passo-a-passo.'});
}
window.downloadModeloAtividades = downloadModeloAtividades;


/* ═══════════════════════════════════════════
   ADMIN TABS (Obras / Equipe / Minha Empresa)
═══════════════════════════════════════════ */
function switchAdmTab(name) {
  document.querySelectorAll('.adm-tab').forEach(t => t.classList.toggle('active', t.dataset.admTab === name));
  document.querySelectorAll('.adm-pane').forEach(p => p.classList.toggle('active', p.id === 'adm-pane-' + name));
  if (name === 'empresa') {
    loadEmpresaIntoForm();
  } else if (name === 'equipe') {
    renderEquipe();
  }
}
window.switchAdmTab = switchAdmTab;

/* ═══════════════════════════════════════════
   MINHA EMPRESA (branding por construtora)
═══════════════════════════════════════════ */
let currentCompanyBranding = null;

const DEFAULT_EMPRESA = {
  companyName: '',
  companyTag: '',
  primaryColor: '#1A7A9A',
  secondaryColor: '#2A5580',
  logoUrl: null,
};

async function loadEmpresaIntoForm() {
  if (!currentUser || !currentCompanyId) return;
  // O branding agora vive em companies/{cid}/branding e já é mantido em
  // currentCompany pela subscription. Lê o valor de lá quando possível;
  // cai para get() se ainda não chegou.
  if (currentCompany && currentCompany.branding) {
    currentCompanyBranding = { ...DEFAULT_EMPRESA, ...currentCompany.branding };
  } else {
    try {
      const snap = await fb.get(fb.ref(fb.db, `companies/${currentCompanyId}/branding`));
      currentCompanyBranding = snap.val() || { ...DEFAULT_EMPRESA };
    } catch(e) {
      console.warn(e);
      currentCompanyBranding = { ...DEFAULT_EMPRESA };
    }
  }
  fillEmpresaForm(currentCompanyBranding);
  updateEmpresaPreview();
}

// Chamada pela subscription companies/{cid} sempre que a empresa muda no DB.
// Atualiza o form se a aba estiver aberta, sem recarregar à toa.
function fillEmpresaFormFromCompany() {
  if (!currentCompany) return;
  const empresaPaneActive = document.getElementById('adm-pane-empresa').classList.contains('active');
  if (!empresaPaneActive) return;
  currentCompanyBranding = { ...DEFAULT_EMPRESA, ...(currentCompany.branding || {}) };
  fillEmpresaForm(currentCompanyBranding);
  updateEmpresaPreview();
}

function fillEmpresaForm(b) {
  $('emp-nome').value = b.companyName || '';
  $('emp-slogan').value = b.companyTag || '';
  $('emp-cor-custom').value = b.primaryColor || '#1A7A9A';
  $('emp-cor2-custom').value = b.secondaryColor || '#2A5580';
  highlightSwatch('cor-primaria', b.primaryColor || '#1A7A9A');
  highlightSwatch('cor-secundaria', b.secondaryColor || '#2A5580');
  // Logo
  const prev = $('logo-prev');
  const removeBtn = $('btn-remove-logo');
  if (b.logoUrl) {
    prev.innerHTML = '';
    prev.classList.add('has-img');
    prev.classList.remove('fallback');
    const img = document.createElement('img');
    img.src = b.logoUrl;
    img.alt = 'Logo';
    img.onerror = () => fillLogoFallback(b);
    prev.appendChild(img);
    removeBtn.style.display = '';
  } else {
    fillLogoFallback(b);
    removeBtn.style.display = 'none';
  }
}

function fillLogoFallback(b) {
  const prev = $('logo-prev');
  const initial = (b.companyName || 'P').trim().charAt(0).toUpperCase() || 'P';
  prev.classList.remove('has-img');
  prev.classList.add('fallback');
  prev.innerHTML = '';
  prev.style.background = `linear-gradient(135deg, ${b.primaryColor || '#1A7A9A'}, ${b.secondaryColor || '#2A5580'})`;
  prev.textContent = initial;
}

function highlightSwatch(containerId, color) {
  const c = (color || '').toLowerCase();
  document.querySelectorAll(`#${containerId} .color-swatch`).forEach(s => {
    if (s.classList.contains('custom')) return;
    s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === c);
  });
}

function updateEmpresaPreview() {
  const nome = $('emp-nome').value.trim() || 'Plan&jar';
  const slogan = $('emp-slogan').value.trim() || 'Construa com clareza';

  // [v3] Lê do mesmo modo que saveEmpresa (input custom OU bolinha .active)
  function _readSel(pickerId, customId, def) {
    const el = $(customId);
    let v = el ? el.value : '';
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
    const a = document.querySelector(`#${pickerId} .color-swatch.active`);
    if (a && a.dataset.color) return a.dataset.color;
    return def;
  }
  const cor  = _readSel('cor-primaria',   'emp-cor-custom',  '#1A7A9A');
  const cor2 = _readSel('cor-secundaria', 'emp-cor2-custom', '#2A5580');

  $('prev-name').textContent = nome;
  $('prev-tag').textContent = slogan;
  document.documentElement.style.setProperty('--prev-color', cor);
  document.documentElement.style.setProperty('--prev-color-2', cor2);

  // Logo preview no card de prévia
  const prevLogo = $('prev-logo');
  // Remove imagem antiga
  prevLogo.innerHTML = '';
  prevLogo.classList.remove('has-img');
  // Vê se tem logo no formulário (logo-prev tem img dentro)
  const formImg = $('logo-prev').querySelector('img');
  if (formImg) {
    prevLogo.classList.add('has-img');
    const img = document.createElement('img');
    img.src = formImg.src;
    prevLogo.appendChild(img);
  } else {
    prevLogo.style.background = `linear-gradient(135deg, ${cor}, ${cor2})`;
    prevLogo.textContent = (nome || 'P').trim().charAt(0).toUpperCase();
  }
}
window.updateEmpresaPreview = updateEmpresaPreview;

// Listeners para os swatches de cor
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#cor-primaria .color-swatch:not(.custom)').forEach(s => {
    s.addEventListener('click', () => {
      const c = s.dataset.color;
      $('emp-cor-custom').value = c;
      highlightSwatch('cor-primaria', c);
      updateEmpresaPreview();
    });
  });
  document.querySelectorAll('#cor-secundaria .color-swatch:not(.custom)').forEach(s => {
    s.addEventListener('click', () => {
      const c = s.dataset.color;
      $('emp-cor2-custom').value = c;
      highlightSwatch('cor-secundaria', c);
      updateEmpresaPreview();
    });
  });
  // Inputs custom color
  const corCustom = $('emp-cor-custom');
  if (corCustom) {
    corCustom.addEventListener('input', () => {
      highlightSwatch('cor-primaria', corCustom.value);
      updateEmpresaPreview();
    });
  }
  const cor2Custom = $('emp-cor2-custom');
  if (cor2Custom) {
    cor2Custom.addEventListener('input', () => {
      highlightSwatch('cor-secundaria', cor2Custom.value);
      updateEmpresaPreview();
    });
  }
  // Upload de logo
  const logoFile = $('emp-logo-file');
  if (logoFile) {
    logoFile.addEventListener('change', handleLogoUpload);
  }
});

/* ── Helpers de logo: converte arquivo em data URL e (se for raster) redimensiona pra caber no DB ── */
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('Falha ao ler arquivo'));
    r.readAsDataURL(file);
  });
}

// Redimensiona PNG/JPG/WEBP para no máximo 256px no maior lado e exporta em PNG
// (ou JPEG, se for foto). SVG não é redimensionado — mantém o original.
async function shrinkImageDataURL(file, maxDim = 256, quality = 0.9) {
  if (file.type === 'image/svg+xml') {
    return await fileToDataURL(file); // SVG: usa como está
  }
  const dataUrl = await fileToDataURL(file);
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      // Tenta PNG (preserva transparência); cai pra JPEG só se ficar enorme.
      let out = canvas.toDataURL('image/png');
      if (out.length > 220 * 1024) {
        out = canvas.toDataURL('image/jpeg', quality);
      }
      res(out);
    };
    img.onerror = () => rej(new Error('Imagem inválida'));
    img.src = dataUrl;
  });
}

async function handleLogoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!currentUser || !currentCompanyId) {
    toast({title:'Faça login primeiro', kind:'warn'});
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    toast({title:'Arquivo muito grande', msg:'Use uma imagem de até 4 MB. O sistema vai redimensionar automaticamente.', kind:'err'});
    e.target.value = '';
    return;
  }
  if (!/^image\/(png|jpeg|jpg|svg\+xml|webp)$/.test(file.type)) {
    toast({title:'Formato não suportado', msg:'Use PNG, JPG, SVG ou WebP.', kind:'err'});
    e.target.value = '';
    return;
  }

  setEmpStatus('saving', 'Processando logo…');
  try {
    // Converte (e redimensiona se raster). Resultado é uma data URL pronta pra
    // ser salva no Realtime Database — não depende do Firebase Storage.
    const dataUrl = await shrinkImageDataURL(file, 256, 0.9);

    // Sanidade: não passa de ~280KB depois do shrink. Se passar, avisa.
    if (dataUrl.length > 280 * 1024) {
      toast({title:'Logo muito pesado', msg:'Mesmo após redimensionar, ficou maior que o limite. Tente uma imagem mais simples ou um SVG.', kind:'err', duration:7000});
      setEmpStatus('error', 'Logo muito pesado');
      return;
    }

    // Atualiza o preview imediatamente (antes mesmo de salvar)
    const prev = $('logo-prev');
    prev.innerHTML = '';
    prev.classList.add('has-img');
    prev.classList.remove('fallback');
    const img = document.createElement('img');
    img.src = dataUrl;
    prev.appendChild(img);
    $('btn-remove-logo').style.display = '';

    if (!currentCompanyBranding) currentCompanyBranding = { ...DEFAULT_EMPRESA };
    // logoUrl agora é uma data URL (base64). Mantemos o mesmo nome de campo
    // para que o resto do app (obra.html) continue funcionando sem alterações.
    currentCompanyBranding.logoUrl = dataUrl;
    // logoPath não é mais necessário (sem Storage), mas zeramos pra limpar dados antigos
    currentCompanyBranding.logoPath = null;

    updateEmpresaPreview();
    setEmpStatus('saved', 'Logo carregado — clique em "Salvar" para confirmar');
  } catch(err) {
    console.error('[upload logo]', err);
    toast({title:'Erro ao processar logo', msg: err.message || 'Tente outra imagem.', kind:'err', duration:6000});
    setEmpStatus('error', 'Falha ao processar');
  } finally {
    e.target.value = '';
  }
}

async function removeLogo() {
  if (!currentUser || !currentCompanyBranding) return;
  if (!confirm('Remover o logo? A inicial colorida voltará a ser exibida.')) return;
  currentCompanyBranding.logoUrl = null;
  currentCompanyBranding.logoPath = null;
  fillLogoFallback(currentCompanyBranding);
  updateEmpresaPreview();
  $('btn-remove-logo').style.display = 'none';
  setEmpStatus('saved', 'Logo removido — clique em "Salvar" para confirmar');
}
window.removeLogo = removeLogo;

async function saveEmpresa() {
  if (!currentUser || !currentCompanyId) return;
  // Só o owner pode mudar branding (regra simples no client; o Firebase
  // ainda decide pelas rules — esse if só evita o toast feio).
  if (currentUserProfile && currentUserProfile.role !== 'owner') {
    toast({title:'Só o owner pode editar a marca', msg:'Peça pro admin da construtora.', kind:'warn'});
    return;
  }

  // [v3] Lê primeiro do input custom; se vazio/inválido, fallback pra bolinha ativa
  function _readSelectedColor(pickerId, customId, defaultHex) {
    const customEl = $(customId);
    let v = customEl ? customEl.value : '';
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
    // Fallback: lê da bolinha .active dentro do container do picker
    const active = document.querySelector(`#${pickerId} .color-swatch.active`);
    if (active && active.dataset.color) return active.dataset.color;
    return defaultHex;
  }
  const primary   = _readSelectedColor('cor-primaria',   'emp-cor-custom',  '#1A7A9A');
  const secondary = _readSelectedColor('cor-secundaria', 'emp-cor2-custom', '#2A5580');

  const data = {
    companyName: $('emp-nome').value.trim() || null,
    companyTag:  $('emp-slogan').value.trim() || null,
    primaryColor: primary,
    secondaryColor: secondary,
    logoUrl: currentCompanyBranding?.logoUrl || null,
    logoPath: currentCompanyBranding?.logoPath || null,
    updatedAt: Date.now(),
  };
  setEmpStatus('saving', 'Salvando…');
  try {
    const updates = {};
    updates[`companies/${currentCompanyId}/branding`] = data;
    // Mantém o nome da empresa em sincronia com o branding (campo top-level
    // serve como fonte canônica para listagem em outras telas).
    if (data.companyName) {
      updates[`companies/${currentCompanyId}/name`] = data.companyName;
    }
    await fb.update(fb.ref(fb.db), updates);
    currentCompanyBranding = data;
    setEmpStatus('saved', 'Configurações salvas ✓');
    toast({title:'Empresa salva', msg:'Suas obras já vão aparecer com a nova marca.', kind:'success'});
  } catch(e) {
    console.error(e);
    setEmpStatus('error', 'Erro ao salvar');
    toast({title:'Erro', msg:e.message, kind:'err'});
  }
}
window.saveEmpresa = saveEmpresa;

async function resetEmpresa() {
  if (!confirm('Restaurar configurações padrão? O logo será mantido (você pode removê-lo separadamente).')) return;
  $('emp-nome').value = '';
  $('emp-slogan').value = '';
  $('emp-cor-custom').value = '#1A7A9A';
  $('emp-cor2-custom').value = '#2A5580';
  highlightSwatch('cor-primaria', '#1A7A9A');
  highlightSwatch('cor-secundaria', '#2A5580');
  updateEmpresaPreview();
  setEmpStatus('saving', 'Não salvo — clique em "Salvar"');
}
window.resetEmpresa = resetEmpresa;

function setEmpStatus(kind, label) {
  const s = $('emp-save-status');
  const l = $('emp-save-lbl');
  if (s) s.className = 'save-status ' + (kind || '');
  if (l) l.textContent = label || '';
}

/* ═══════════════════════════════════════════
   ONBOARDING — criar construtora no 1º login
═══════════════════════════════════════════ */
async function createCompany() {
  if (!currentUser) return;
  const name = $('ob-company-name').value.trim();
  const display = $('ob-display-name').value.trim();
  const errEl = $('ob-err');
  errEl.classList.remove('show');

  if (!name) {
    errEl.textContent = 'Digite o nome da construtora.';
    errEl.classList.add('show');
    return;
  }

  const btn = $('ob-create-btn');
  btn.disabled = true;
  btn.textContent = 'Criando…';

  try {
    // Gera um companyId estável baseado no nome (slug ascii). Append do uid
    // só nos últimos 6 chars pra evitar colisão se duas empresas tiverem o mesmo nome.
    const slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30);
    const companyId = slug + '-' + currentUser.uid.slice(-6);

    const updates = {};
    updates[`companies/${companyId}`] = {
      name,
      ownerUid: currentUser.uid,
      branding: {
        companyName: name,
        companyTag: '',
        primaryColor: '#1A7A9A',
        secondaryColor: '#2A5580',
        logoUrl: null,
      },
      createdAt: Date.now(),
    };
    updates[`users/${currentUser.uid}`] = {
      companyId,
      role: 'owner',
      email: currentUser.email,
      displayName: display || currentUser.email.split('@')[0],
      addedAt: Date.now(),
    };

    await fb.update(fb.ref(fb.db), updates);

    // Recarrega o perfil e a empresa
    currentCompanyId = companyId;
    currentUserProfile = updates[`users/${currentUser.uid}`];
    await loadCurrentCompany();

    $('onboarding').classList.remove('show');
    $('admin').classList.add('active');
    subscribeData();
    toast({title:'Construtora criada ✓', msg:`Bem-vindo a ${name}.`, kind:'success'});
  } catch(e) {
    console.error('[createCompany]', e);
    errEl.textContent = 'Erro ao criar: ' + (e.code === 'PERMISSION_DENIED'
      ? 'permissão negada. Verifique as regras do Firebase.'
      : e.message);
    errEl.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Criar construtora';
  }
}
window.createCompany = createCompany;

/* ═══════════════════════════════════════════
   EQUIPE — gerenciar usuários da construtora
═══════════════════════════════════════════ */
function fmtDateBrFromTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

function renderEquipe() {
  const body = $('equipe-body');
  if (!body) return;

  // Cabeçalho com nome da empresa
  const nameEl = $('equipe-company-name');
  const infoEl = $('equipe-company-info');
  if (currentCompany) {
    nameEl.textContent = currentCompany.name || 'Construtora';
    const memberCount = Object.keys(companyMembers).length;
    infoEl.textContent = `${memberCount} usuário${memberCount===1?'':'s'} cadastrado${memberCount===1?'':'s'}`;
  }

  // Botão "Novo usuário" só aparece pro owner
  const btnNew = $('btn-new-member');
  if (btnNew) {
    btnNew.style.display = (currentUserProfile && currentUserProfile.role === 'owner') ? '' : 'none';
  }

  const list = Object.entries(companyMembers)
    .map(([uid, u]) => ({ uid, ...u }))
    .sort((a, b) => {
      // Owner sempre primeiro
      if (a.role === 'owner' && b.role !== 'owner') return -1;
      if (b.role === 'owner' && a.role !== 'owner') return 1;
      return (a.addedAt || 0) - (b.addedAt || 0);
    });

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty"><div class="empty-title">Sem usuários</div><div class="empty-sub">Cadastre o primeiro usuário da equipe.</div></td></tr>`;
    return;
  }

  body.innerHTML = list.map(m => {
    const isSelf = m.uid === currentUser.uid;
    const isOwner = m.role === 'owner';
    const canIRemove = (currentUserProfile?.role === 'owner') && !isSelf && !isOwner;
    return `<tr>
      <td>
        <div class="equipe-name">${esc(m.displayName || m.email.split('@')[0])} ${isSelf ? '<span class="equipe-self">(você)</span>' : ''}</div>
        <div class="equipe-email">${esc(m.email)}</div>
      </td>
      <td><span class="role-badge ${isOwner ? 'owner' : 'member'}">${isOwner ? 'Dono' : 'Usuário'}</span></td>
      <td style="color:var(--c-muted);font-size:12px">${fmtDateBrFromTs(m.addedAt)}</td>
      <td style="text-align:right">
        ${canIRemove ? `
          <button class="icon-action danger" title="Remover do painel" onclick="removeMember('${m.uid}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        ` : ''}
      </td>
    </tr>`;
  }).join('');
}

function openMemberModal() {
  if (!currentUserProfile || currentUserProfile.role !== 'owner') {
    toast({title:'Só o dono cadastra usuários', kind:'warn'});
    return;
  }
  $('m-email').value = '';
  $('m-name').value = '';
  $('m-pass').value = '';
  $('m-err').classList.remove('show');
  $('member-modal').classList.add('show');
  setTimeout(() => $('m-email').focus(), 100);
}
window.openMemberModal = openMemberModal;

function closeMemberModal() {
  $('member-modal').classList.remove('show');
}
window.closeMemberModal = closeMemberModal;

function generatePassword() {
  // 12 caracteres legíveis (sem confundir 0/O, 1/l)
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let p = '';
  for (let i = 0; i < 12; i++) p += chars.charAt(Math.floor(Math.random() * chars.length));
  $('m-pass').value = p;
}
window.generatePassword = generatePassword;

async function saveMember() {
  if (!currentCompanyId || !currentUserProfile || currentUserProfile.role !== 'owner') return;

  const email = $('m-email').value.trim().toLowerCase();
  const name  = $('m-name').value.trim();
  const pass  = $('m-pass').value;
  const errEl = $('m-err');
  errEl.classList.remove('show');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = 'Email inválido.';
    errEl.classList.add('show');
    return;
  }
  if (!pass || pass.length < 6) {
    errEl.textContent = 'A senha precisa ter no mínimo 6 caracteres.';
    errEl.classList.add('show');
    return;
  }

  const btn = $('save-member-btn');
  btn.disabled = true;
  btn.textContent = 'Cadastrando…';

  try {
    // 1) Cria a conta no Firebase Auth pela app secundária (não desloga o admin)
    const newUser = await fb.createUserSecondary(email, pass);

    // 2) Vincula o uid à construtora
    await fb.set(fb.ref(fb.db, `users/${newUser.uid}`), {
      companyId: currentCompanyId,
      role: 'member',
      email,
      displayName: name || email.split('@')[0],
      addedAt: Date.now(),
    });

    closeMemberModal();
    toast({
      title:'Usuário cadastrado ✓',
      msg:`${email} já pode fazer login. Compartilhe a senha por um canal seguro.`,
      kind:'success',
      duration:7000
    });
  } catch(e) {
    console.error('[saveMember]', e);
    let msg = e.message || 'Erro ao cadastrar.';
    if (e.code === 'auth/email-already-in-use') {
      msg = 'Esse email já tem conta no Firebase. Se for da sua equipe, peça pra ele(a) fazer login — depois vincule manualmente. Ou use outro email.';
    } else if (e.code === 'auth/weak-password') {
      msg = 'Senha muito fraca. Mínimo 6 caracteres.';
    } else if (e.code === 'auth/invalid-email') {
      msg = 'Email inválido.';
    } else if (e.code === 'PERMISSION_DENIED') {
      msg = 'Permissão negada nas regras do Firebase. O usuário foi criado mas não foi vinculado.';
    }
    errEl.textContent = msg;
    errEl.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Cadastrar usuário';
  }
}
window.saveMember = saveMember;

async function removeMember(uid) {
  if (!currentUserProfile || currentUserProfile.role !== 'owner') return;
  const m = companyMembers[uid];
  if (!m) return;
  if (uid === currentUser.uid) {
    toast({title:'Você não pode se remover', kind:'warn'});
    return;
  }
  if (!confirm(`Remover ${m.email} da construtora?\n\nAviso: a conta no Firebase NÃO é deletada — só a vinculação à empresa. O usuário não conseguirá mais entrar nesse painel, mas a conta de login dele continua existindo.`)) return;

  try {
    await fb.set(fb.ref(fb.db, `users/${uid}`), null);
    toast({title:'Usuário removido', kind:'info'});
  } catch(e) {
    console.error('[removeMember]', e);
    toast({title:'Erro ao remover', msg:e.message, kind:'err'});
  }
}
window.removeMember = removeMember;

// Fecha modais ao clicar no backdrop
document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
});

/* ════════════════════════════════════════════════════════
   ✨ FUNÇÕES NOVAS (adicionadas em 2026)
═══════════════════════════════════════════════════════ */

/* ─── Modal de exclusão segura (typed-confirm) ─── */
let _dangerOnConfirm = null;
function openDangerModal({ title, sub, items, typedWord, confirmLabel, onConfirm }) {
  $('danger-title').textContent = title;
  $('danger-sub').textContent = sub || 'Esta ação não pode ser desfeita.';
  $('danger-list').innerHTML = items.map(i => `• ${i}`).join('<br>');
  $('danger-typed-word').textContent = typedWord;
  const inp = $('danger-input');
  const btn = $('danger-confirm-btn');
  inp.value = '';
  inp.classList.remove('match');
  btn.disabled = true;
  btn.textContent = confirmLabel || 'Confirmar';
  _dangerOnConfirm = onConfirm;

  inp.oninput = () => {
    const matches = inp.value.trim().toUpperCase() === typedWord;
    btn.disabled = !matches;
    inp.classList.toggle('match', matches);
  };
  btn.onclick = async () => {
    closeDangerModal();
    if (_dangerOnConfirm) await _dangerOnConfirm();
    _dangerOnConfirm = null;
  };
  $('danger-modal').classList.add('show');
  setTimeout(() => inp.focus(), 100);
}
function closeDangerModal() {
  $('danger-modal').classList.remove('show');
  _dangerOnConfirm = null;
}
window.closeDangerModal = closeDangerModal;

/* ─── Copiar código com 1 clique ─── */
async function copyCode(el, code) {
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
  } catch(e) {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = code; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 1500);
}
window.copyCode = copyCode;

/* ─── Compartilhar obra: link + WhatsApp + mensagem ─── */
let _shareCtx = null;
function openShareModal(obraId, code) {
  const o = obras[obraId];
  if (!o || !code) return;
  const url = `${window.location.origin}${window.location.pathname.replace(/admin\.html.*$/,'')}index.html?code=${encodeURIComponent(code)}`;
  _shareCtx = { obraId, code, url, obra: o };

  $('share-link-input').value = url;
  $('share-link-copy').textContent = 'Copiar';
  $('share-link-copy').classList.remove('copied');
  $('share-copy-msg-label').textContent = 'Copiar mensagem';

  // WhatsApp share
  const empName = (currentCompany && currentCompany.name) || 'sua construtora';
  const msg = `Olá! 👋\n\nO acompanhamento da sua obra *${o.nome}* já está disponível em tempo real pela ${empName}.\n\nAcesse pelo link:\n${url}\n\nOu pelo código: *${code}*\nem ${window.location.origin}${window.location.pathname.replace(/admin\.html.*$/,'')}index.html`;
  $('share-wa-btn').href = `https://wa.me/?text=${encodeURIComponent(msg)}`;

  $('share-modal').classList.add('show');
}
window.openShareModal = openShareModal;
function closeShareModal() { $('share-modal').classList.remove('show'); }
window.closeShareModal = closeShareModal;

async function copyShareLink() {
  if (!_shareCtx) return;
  try {
    await navigator.clipboard.writeText(_shareCtx.url);
    const b = $('share-link-copy');
    b.textContent = '✓ Copiado'; b.classList.add('copied');
    setTimeout(() => { b.textContent = 'Copiar'; b.classList.remove('copied'); }, 1800);
  } catch(e) { toast({title:'Não foi possível copiar', kind:'err'}); }
}
window.copyShareLink = copyShareLink;

async function copyShareMessage() {
  if (!_shareCtx) return;
  const o = _shareCtx.obra;
  const empName = (currentCompany && currentCompany.name) || 'sua construtora';
  const msg = `Olá! 👋\n\nO acompanhamento da sua obra ${o.nome} já está disponível em tempo real pela ${empName}.\n\nAcesse pelo link:\n${_shareCtx.url}\n\nOu pelo código: ${_shareCtx.code}`;
  try {
    await navigator.clipboard.writeText(msg);
    const lbl = $('share-copy-msg-label');
    lbl.textContent = '✓ Copiado!';
    setTimeout(() => { lbl.textContent = 'Copiar mensagem'; }, 1800);
  } catch(e) { toast({title:'Não foi possível copiar', kind:'err'}); }
}
window.copyShareMessage = copyShareMessage;

/* ─── Atalhos de teclado (?) ─── */
function openShortcuts() { $('shortcut-overlay').classList.add('show'); }
function closeShortcuts() { $('shortcut-overlay').classList.remove('show'); }
window.openShortcuts = openShortcuts;
window.closeShortcuts = closeShortcuts;

let _gPressed = false;
let _gTimer = null;
function isTypingTarget(t) {
  if (!t) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}
document.addEventListener('keydown', (e) => {
  // ESC: fecha modais e overlays
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.show').forEach(m => m.classList.remove('show'));
    closeShortcuts();
    return;
  }
  // Não capturar atalhos quando estiver digitando
  if (isTypingTarget(e.target)) return;
  // Ignorar com modifiers (deixa Ctrl/Cmd+L pro usuário)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Não rodar atalhos se estiver na tela de login
  if (!$('admin').classList.contains('active')) return;

  // ? mostra ajuda
  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
  // / foca busca
  if (e.key === '/') {
    if ($('adm-pane-obras').classList.contains('active')) {
      e.preventDefault();
      $('search').focus(); $('search').select();
    }
    return;
  }
  // n nova obra
  if (e.key.toLowerCase() === 'n') {
    if ($('adm-pane-obras').classList.contains('active')) {
      e.preventDefault(); openNewObraModal();
    } else if ($('adm-pane-equipe').classList.contains('active')) {
      e.preventDefault(); openMemberModal();
    }
    return;
  }
  // d alterna dark mode
  if (e.key.toLowerCase() === 'd') {
    e.preventDefault(); toggleTheme(); return;
  }
  // Sequência g+letra (gO=obras, gE=equipe, gM=empresa)
  if (e.key.toLowerCase() === 'g') {
    _gPressed = true;
    clearTimeout(_gTimer);
    _gTimer = setTimeout(() => { _gPressed = false; }, 1200);
    return;
  }
  if (_gPressed) {
    const k = e.key.toLowerCase();
    if (k === 'o') { _gPressed = false; switchAdmTab('obras'); }
    else if (k === 'e') { _gPressed = false; switchAdmTab('equipe'); }
    else if (k === 'm') { _gPressed = false; switchAdmTab('empresa'); }
  }
});

/* ─── Dark mode ─── */
const THEME_KEY = 'planjar_admin_theme';
function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'dark') {
    html.setAttribute('data-theme','dark');
    $('theme-icon-light') && ($('theme-icon-light').style.display='none');
    $('theme-icon-dark')  && ($('theme-icon-dark').style.display='block');
  } else {
    html.removeAttribute('data-theme');
    $('theme-icon-light') && ($('theme-icon-light').style.display='block');
    $('theme-icon-dark')  && ($('theme-icon-dark').style.display='none');
  }
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, cur); } catch(e){}
  applyTheme(cur);
  toast({ title: cur === 'dark' ? '🌙 Modo escuro ativado' : '☀️ Modo claro ativado', kind: 'info', duration: 1800 });
}
window.toggleTheme = toggleTheme;
// aplica tema inicial
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark') applyTheme('dark');
} catch(e){}

/* ─── Wizard de boas-vindas (3 passos) ─── */
const WIZARD_KEY = 'planjar_admin_wizard_done';
function maybeShowWizard() {
  try {
    if (localStorage.getItem(WIZARD_KEY) === '1') return;
  } catch(e){}
  // só mostra depois do login + primeiro render
  setTimeout(() => $('welcome-wizard').classList.add('show'), 600);
}
function wizardGo(step) {
  document.querySelectorAll('.wizard-step').forEach(s => {
    s.classList.toggle('active', Number(s.dataset.step) === step);
  });
  document.querySelectorAll('.wizard-dot').forEach(d => {
    const n = Number(d.dataset.step);
    d.classList.remove('active','done');
    if (n < step) d.classList.add('done');
    else if (n === step) d.classList.add('active');
  });
}
window.wizardGo = wizardGo;
function closeWizard() {
  $('welcome-wizard').classList.remove('show');
  try { localStorage.setItem(WIZARD_KEY, '1'); } catch(e){}
}
window.closeWizard = closeWizard;
function finishWizard() {
  closeWizard();
  // leva direto pra Empresa pra construtora personalizar
  switchAdmTab('empresa');
  toast({ title: 'Vamos lá! ✨', msg: 'Comece personalizando sua marca.', kind: 'success', duration: 4000 });
  // depois de 3s, mostra o FAB de ajuda
  setTimeout(() => { $('help-fab').hidden = false; }, 2500);
}
window.finishWizard = finishWizard;

/* ─── Exportação CSV ─── */
function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }).join(',')).join('\n');
  // BOM pra abrir certo no Excel
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

function exportObrasCSV() {
  const rows = [['Nome','Cliente','Código','Status','Atividades','Início','Fim','Endereço/Sub']];
  Object.entries(obras).forEach(([id,o]) => {
    const ci = codes[o.code];
    const ativo = ci ? ci.ativo !== false : false;
    rows.push([
      o.nome||'', o.cliente||'', o.code||'',
      ativo ? 'Ativa' : 'Inativa',
      tasksCount[id]||0,
      o.start ? fmtDateBr(o.start) : '',
      o.end ? fmtDateBr(o.end) : '',
      o.sub||''
    ]);
  });
  if (rows.length <= 1) { toast({ title:'Nenhuma obra para exportar', kind:'info'}); return; }
  const date = new Date().toISOString().slice(0,10);
  downloadCSV(`planjar-obras-${date}.csv`, rows);
  toast({ title: '✓ Exportado', msg: `${rows.length-1} obras baixadas`, kind: 'success' });
}
window.exportObrasCSV = exportObrasCSV;

function exportEquipeCSV() {
  const rows = [['E-mail','Nome','Função','Adicionado em']];
  // Tenta ler dos elementos da tabela (compatibilidade)
  const tbody = $('equipe-body');
  if (tbody) {
    tbody.querySelectorAll('tr').forEach(tr => {
      const cells = tr.querySelectorAll('td');
      if (cells.length >= 3) {
        const r = [];
        cells.forEach((c,i) => { if (i < 4) r.push(c.innerText.trim().replace(/\s+/g,' ')); });
        while (r.length < 4) r.push('');
        rows.push(r.slice(0,4));
      }
    });
  }
  if (rows.length <= 1) { toast({ title:'Nenhum usuário para exportar', kind:'info'}); return; }
  const date = new Date().toISOString().slice(0,10);
  downloadCSV(`planjar-equipe-${date}.csv`, rows);
  toast({ title: '✓ Exportado', msg: `${rows.length-1} usuários baixados`, kind: 'success' });
}
window.exportEquipeCSV = exportEquipeCSV;

/* ─── PWA: prompt de instalação ─── */
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  // mostrar banner só depois do login + onboarding concluído
  try {
    if (localStorage.getItem('planjar_admin_install_dismissed') === '1') return;
  } catch(e){}
  setTimeout(() => {
    if ($('admin').classList.contains('active')) {
      $('install-banner').classList.add('show');
    }
  }, 4000);
});
$('install-banner-btn') && ($('install-banner-btn').onclick = async () => {
  if (!_deferredInstall) return;
  $('install-banner').classList.remove('show');
  _deferredInstall.prompt();
  const choice = await _deferredInstall.userChoice;
  if (choice.outcome === 'accepted') {
    toast({ title:'✓ App instalado!', msg:'Agora tem ícone na sua tela.', kind:'success' });
  }
  _deferredInstall = null;
});
function dismissInstall() {
  $('install-banner').classList.remove('show');
  try { localStorage.setItem('planjar_admin_install_dismissed','1'); } catch(e){}
}
window.dismissInstall = dismissInstall;

// Service worker (registrado depois do load)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {/* silencioso */});
  });
}

/* ─── Detectar primeiro login pra disparar wizard ─── */
// Hook: depois da primeira vez que o painel admin fica .active, espera 600ms e mostra wizard
const _origSwitchTab = window.switchAdmTab;
let _wizardCheckedThisSession = false;
function checkWizardOnce() {
  if (_wizardCheckedThisSession) return;
  _wizardCheckedThisSession = true;
  maybeShowWizard();
  // ativa o FAB de ajuda assim que o admin fica visível
  setTimeout(() => { if ($('help-fab')) $('help-fab').hidden = false; }, 1500);
}

// Observa quando o painel #admin ganhar a classe .active
const _adminEl = $('admin');
if (_adminEl) {
  const _obs = new MutationObserver(() => {
    if (_adminEl.classList.contains('active')) checkWizardOnce();
  });
  _obs.observe(_adminEl, { attributes: true, attributeFilter: ['class'] });
  if (_adminEl.classList.contains('active')) checkWizardOnce();
}
