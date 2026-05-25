// migrate.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, get, update } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBJoDou1VsHAIAbVjESOGVh23dezmLETrE",
  authDomain: "franco-e-fragoso-advocacia.firebaseapp.com",
  databaseURL: "https://franco-e-fragoso-advocacia-default-rtdb.firebaseio.com",
  projectId: "franco-e-fragoso-advocacia",
  storageBucket: "franco-e-fragoso-advocacia.firebasestorage.app",
  messagingSenderId: "1096895063248",
  appId: "1:1096895063248:web:68a5c866e229124f3faad5"
};

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getDatabase(app);

window.runMigration = async function() {
  const email = document.getElementById('email').value;
  const pass  = document.getElementById('pass').value;
  const log   = document.getElementById('log');
  
  log.textContent = 'Logando...\n';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    log.textContent += '✓ Logado\n\n';
  } catch(e) {
    log.textContent += '✗ Erro no login: ' + e.message;
    return;
  }
  
  const flagSnap = await get(ref(db, 'meta/migrationDone/reorg_v1'));
  if (flagSnap.val()) {
    log.textContent += '⚠ Migração já foi executada. Abortando.\n';
    return;
  }
  
  log.textContent += 'Lendo /services...\n';
  const servicesSnap = await get(ref(db, 'services'));
  const allServices = servicesSnap.val() || {};
  
  const updates = {};
  let movedCount = 0;
  
  Object.entries(allServices).forEach(([obraId, svcs]) => {
    Object.entries(svcs || {}).forEach(([svcId, svc]) => {
      if (svc && typeof svc === 'object') {
        if (svc.realizado !== undefined && svc.realizado !== null) {
          updates[`services-private/${obraId}/${svcId}/realizado`] = svc.realizado;
          updates[`services/${obraId}/${svcId}/realizado`] = null;
          movedCount++;
        }
      }
    });
  });
  
  log.textContent += `Encontrados ${movedCount} campos 'realizado' para mover.\n`;
  log.textContent += 'Aplicando atualizações...\n';
  
  updates['meta/migrationDone/reorg_v1'] = { at: Date.now(), movedCount };
  
  try {
    await update(ref(db), updates);
    log.textContent += `✓ Migração concluída! ${movedCount} campos movidos para /services-private\n`;
  } catch(e) {
    log.textContent += '✗ ERRO: ' + e.message + '\n';
  }
};
