/* public.js - Lógica de validação e acesso público */
const codeInput = document.getElementById('code');
const btn       = document.getElementById('enter-btn');
const btnLabel  = document.getElementById('enter-label');
const hint      = document.getElementById('hint');
const statusBar = document.getElementById('status-bar');
const statusText= document.getElementById('status-text');

function setStatus(text, kind) {
  statusText.textContent = text;
  statusBar.className = 'status-bar show' + (kind ? ' ' + kind : '');
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => statusBar.classList.remove('show'), 2400);
}
function setHint(text, err) {
  hint.textContent = text;
  hint.className = 'hint' + (err ? ' err' : '');
}
function setLoading(loading) {
  btn.disabled = loading;
  if (loading) btnLabel.innerHTML = '<span class="spin"></span>&nbsp;Verificando…';
  else         btnLabel.textContent = 'Entrar na obra';
}
function normalize(raw) {
  return (raw || '').trim().toUpperCase().replace(/\s+/g,'');
}

codeInput.addEventListener('input', (e) => {
  const pos = e.target.selectionStart;
  e.target.value = e.target.value.toUpperCase();
  e.target.setSelectionRange(pos, pos);
  e.target.classList.remove('error');
});

codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
});

btn.addEventListener('click', onEnter);

async function onEnter() {
  const code = normalize(codeInput.value);
  if (!code) {
    codeInput.classList.add('error');
    setHint('Digite um código para continuar', true);
    codeInput.focus();
    return;
  }
  if (!window.__TAILORED__) {
    setHint('Conectando ao servidor, tente novamente em instantes…', true);
    return;
  }

  setLoading(true);
  setHint('Verificando código…', false);

  try {
    const { db, ref, get } = window.__TAILORED__;
    const snap = await get(ref(db, 'codes/' + code));
    const data = snap.val();
    if (!data || !data.obraId || data.ativo === false) {
      codeInput.classList.add('error');
      setHint('Código não encontrado ou desativado. Verifique com a construtora.', true);
      setLoading(false);
      return;
    }
    setStatus('Acesso liberado', '');
    try { sessionStorage.setItem('planjar_last_code', code); } catch(e){}
    window.location.href = `obra.html?id=${encodeURIComponent(data.obraId)}&code=${encodeURIComponent(code)}`;
  } catch (err) {
    console.error(err);
    setHint('Erro de conexão. Tente novamente.', true);
    setStatus('Sem conexão', 'error');
    setLoading(false);
  }
}

/* Pré-preenche se veio com ?code= na URL */
const urlCode = new URLSearchParams(window.location.search).get('code');
if (urlCode) {
  codeInput.value = urlCode.toUpperCase();
  setTimeout(onEnter, 400);
}

window.addEventListener('fb-ready', () => {
  setStatus('Conectado', '');
});
