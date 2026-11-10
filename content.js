// Tourne uniquement sur kyara.games. Ne fait aucune requête réseau.
// 1. Transmet au script de fond le jeton de session du site (pour la vérification de fond).
// 2. Signale les changements du compteur affiché dans l'en-tête.
'use strict';

(() => {
  let lastToken = null;
  let lastCount = null;

  const send = (msg) => browser.runtime.sendMessage(msg).catch(() => {});

  function sendAuth() {
    let token = null;
    let device = null;
    try {
      token = localStorage.getItem('kyara_token');
      device = localStorage.getItem('kyara_device');
    } catch {
      return;
    }
    if (token && token !== lastToken) {
      lastToken = token;
      send({ type: 'auth', token, device });
    }
  }

  function sendCount() {
    // Libellé d'accessibilité de l'en-tête : "9 boosters gratuits sur 20, 4078 chakra".
    const el = document.querySelector('[aria-label*="gratuit"][aria-label*=" sur "]');
    const m = el && /^(\d{1,3}) boosters? gratuits? sur (\d{1,3})/.exec(el.getAttribute('aria-label'));
    if (!m) return;
    const key = m[1] + '/' + m[2];
    if (key !== lastCount) {
      lastCount = key;
      send({ type: 'count', free: Number(m[1]), max: Number(m[2]) });
    }
  }

  function check() {
    if (document.hidden) return;
    sendAuth();
    sendCount();
  }

  setInterval(check, 5000);
  document.addEventListener('visibilitychange', check);
  check();
})();
