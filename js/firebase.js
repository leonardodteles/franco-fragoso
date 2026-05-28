/* firebase.js - Centralização da conexão e autenticação */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBJoDou1VsHAIAbVjESOGVh23dezmLETrE",
  authDomain: "franco-e-fragoso-advocacia.firebaseapp.com",
  databaseURL: "https://franco-e-fragoso-advocacia-default-rtdb.firebaseio.com",
  projectId: "franco-e-fragoso-advocacia",
  storageBucket: "franco-e-fragoso-advocacia.firebasestorage.app",
  messagingSenderId: "1096895063248",
  appId: "1:1096895063248:web:68a5c866e229124f3faad5"
};

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set, update, remove, get, push, child } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getStorage, ref as sRef, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getDatabase(app);
const storage = getStorage(app);

// Instância secundária — usada APENAS para criar usuários da equipe sem
// deslogar o admin. createUserWithEmailAndPassword no SDK cliente troca o
// usuário ativo do app principal; usar uma 2ª app evita esse efeito colateral.
const secondaryApp = initializeApp(FIREBASE_CONFIG, 'secondary');
const secondaryAuth = getAuth(secondaryApp);

window.__FB__ = { auth, db, storage, ref, onValue, set, update, remove, get, push, child,
  sRef, uploadBytes, getDownloadURL, deleteObject,
  signInWithEmailAndPassword: (e, p) => signInWithEmailAndPassword(auth, e, p),
  signOut: () => signOut(auth),
  onAuthStateChanged: (cb) => onAuthStateChanged(auth, cb),
  // Para cadastro de membros: usa a app secundária pra não deslogar o admin
  createUserSecondary: async (e, p) => {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, e, p);
    // Solta a sessão da app secundária imediatamente — só precisamos do uid
    try { await signOut(secondaryAuth); } catch(_) {}
    return cred.user;
  }
};
window.dispatchEvent(new CustomEvent('fb-ready'));
