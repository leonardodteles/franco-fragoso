/* public.js - Lógica de validação e acesso público */
const codeInput = document.getElementById('code');
const btn       = document.getElementById('enter-btn');
const btnLabel  = document.getElementById('btn-label');
const btnLoader = document.getElementById('btn-loader');
const hintEl    = document.getElementById('hint');
const statusEl  = document.getElementById('status-msg');

function setHint(msg, isError) {
  if(!hintEl) return;
  hintEl.textContent = msg;
  hintEl.className = 'hint' + (isError ? ' error' : '');
}

function setStatus(msg, type) {
  if(!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = 'status-msg ' + type;
}

function setLoading(isLoad) {
  if(!btnLabel || !btnLoader || !btn) return;
  btnLabel.style.display = isLoad ? 'none' : 'block';
  btnLoader.style.display = isLoad ? 'block' : 'none';
  btn.style.pointerEvents = isLoad ? 'none' : 'auto';
}

function normalize(val) {
  return val.trim().toUpperCase();
}

// Ouve os cliques e o Enter do teclado
btn.addEventListener('click', onEnter);
codeInput.addEventListener('keypress', e => { 
  if(e.key === 'Enter') onEnter(); 
});

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
    
    // Redireciona para a tela da obra
    window.location.href = `obra.html?id=${encodeURIComponent(data.obraId)}&code=${encodeURIComponent(code)}`;
    
  } catch (err) {
    console.error(err);
    setHint('Erro de conexão. Tente novamente.', true);
    setStatus('Sem conexão', 'error');
    setLoading(false);
  }
}

// Auto-preenchimento caso o cliente acesse por um Link com QR Code
const urlCode = new URLSearchParams(window.location.search).get('code');
if(urlCode) {
  codeInput.value = urlCode;
  setTimeout(onEnter, 500);
}
