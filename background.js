// Script de fond (page d'événement : ne reste pas chargé en mémoire entre deux réveils).
// Principe : on estime le stock par minuteur, et on ne notifie qu'après avoir relu
// le vrai chiffre sur le site (GET /api/me) avec la session déjà ouverte dans Firefox.
'use strict';

const API = 'https://kyara.games/api';
const SITE = 'https://kyara.games/';

const MIN = 60 * 1000;
const GAP_AUTO = 5 * MIN;       // écart minimal entre deux lectures automatiques
const GAP_VISIT = 30 * 1000;    // quand le site est ouvert et que le compteur bouge
const GAP_MANUAL = 15 * 1000;   // bouton "Vérifier maintenant"
const RECHECK = 30 * MIN;       // relecture tant que le stock est au seuil (pour réarmer l'alerte)
const BACKOFF = 15 * MIN;       // pause après une erreur du site
const CONFIG_TTL = 24 * 60 * MIN;
const FRESH = 90 * 1000;        // une lecture plus récente que ça compte comme "sûre"
const IDLE_SECONDS = 120;

browser.idle.setDetectionInterval(IDLE_SECONDS);

async function load() {
  const s = await browser.storage.local.get(['state', 'settings', 'auth']);
  return {
    state: s.state || {},
    settings: Object.assign({ threshold: 18 }, s.settings),
    auth: s.auth || null,
  };
}

const saveState = (state) => browser.storage.local.set({ state });

function wakeAt(when) {
  browser.alarms.create('tick', { when: Math.max(when, Date.now() + 1000) });
}

async function userActive() {
  return (await browser.idle.queryState(IDLE_SECONDS)) === 'active';
}

async function kyaraOnScreen() {
  try {
    const win = await browser.windows.getLastFocused();
    if (!win.focused) return false;
    const tabs = await browser.tabs.query({ active: true, windowId: win.id });
    return tabs.some((t) => typeof t.url === 'string' && t.url.startsWith(SITE));
  } catch {
    return false;
  }
}

async function updateBadge(state, threshold) {
  const now = Date.now();
  const est = estimate(state, now);
  let text = '';
  let color = '#868e96';
  let title = 'Kyara Boosters';
  if (state.status === 'auth' || state.status === 'no_token') {
    text = '!';
    color = '#c92a2a';
    title += ' - ouvre kyara.games pour relier la session';
  } else if (est) {
    text = String(est.free);
    const recent = now - state.readAt < 15 * MIN;
    if (recent) color = est.free >= threshold ? '#d9480f' : '#2b8a3e';
    title += ` - ${est.free}/${state.max}` + (recent ? '' : ' (estimation)');
  }
  await browser.browserAction.setBadgeText({ text });
  await browser.browserAction.setBadgeBackgroundColor({ color });
  await browser.browserAction.setTitle({ title });
}

// Lit le vrai compteur sur le site. `kind` : 'auto' | 'visit' | 'manual'.
async function readNow(kind) {
  const { state, auth } = await load();
  const now = Date.now();

  if (!auth || !auth.token) {
    state.status = 'no_token';
    await saveState(state);
    return evaluate();
  }

  const rush = Math.min(10, Math.max(1, state.rush || 1));
  const gap = kind === 'manual' ? GAP_MANUAL : kind === 'visit' ? GAP_VISIT : GAP_AUTO * rush;
  const earliest = Math.max(
    (state.lastFetchAt || 0) + gap,
    kind === 'manual' ? 0 : state.backoffUntil || 0
  );
  if (now < earliest) {
    wakeAt(earliest);
    return;
  }

  state.lastFetchAt = now;
  await saveState(state);

  const headers = { authorization: 'Bearer ' + auth.token };
  if (auth.device) headers['x-device-id'] = auth.device;

  let res;
  try {
    res = await fetch(API + '/me', {
      headers,
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail(state, 'network');
  }

  if (res.status === 401 || res.status === 403) {
    // Session expirée : on oublie le jeton et on attend que le site en fournisse un nouveau.
    await browser.storage.local.remove('auth');
    state.status = 'auth';
    await saveState(state);
    return evaluate();
  }
  if (!res.ok) return fail(state, 'http_' + res.status);

  let me;
  try {
    me = await res.json();
  } catch {
    return fail(state, 'format');
  }
  if (!me || !Number.isInteger(me.freePacks) || !Number.isInteger(me.freePacksMax)) {
    return fail(state, 'format');
  }

  // Décalage entre l'horloge du serveur et celle du PC.
  const serverNow = Date.parse(res.headers.get('date') || '');
  const skew = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
  const next = me.nextFreeAt ? Date.parse(me.nextFreeAt) : NaN;

  state.rush = Number(res.headers.get('x-kyara-rush')) || 1;
  await refreshConfig(state);

  state.free = me.freePacks;
  state.max = me.freePacksMax;
  state.nextFreeAt = Number.isFinite(next) ? next - skew : null;
  state.regenMs = computeRegenMs(me, state.cfgRegenHours);
  state.pseudo = typeof me.pseudo === 'string' ? me.pseudo.slice(0, 40) : null;
  state.readAt = Date.now();
  state.status = 'ok';
  state.error = null;
  state.backoffUntil = 0;
  await saveState(state);
  return evaluate();
}

async function fail(state, error) {
  state.status = 'error';
  state.error = error;
  state.backoffUntil = Date.now() + BACKOFF;
  await saveState(state);
  wakeAt(state.backoffUntil);
  const { settings } = await load();
  await updateBadge(state, clampThreshold(settings.threshold, state.max || 20));
}

// Durée de régénération de base : donnée publique du site, relue au plus une fois par jour.
async function refreshConfig(state) {
  if (state.cfgAt && Date.now() - state.cfgAt < CONFIG_TTL) return;
  state.cfgAt = Date.now();
  try {
    const res = await fetch(API + '/config', { credentials: 'omit', signal: AbortSignal.timeout(15000) });
    if (!res.ok) return;
    const cfg = await res.json();
    const h = cfg && cfg.freePacks && cfg.freePacks.regenHours;
    if (typeof h === 'number' && h > 0) state.cfgRegenHours = h;
  } catch {
    // on garde l'ancienne valeur
  }
}

// Cœur de la logique : met à jour le badge, décide d'une lecture ou d'une alerte,
// et programme le prochain réveil.
async function evaluate() {
  const { state, settings } = await load();
  const now = Date.now();
  const est = estimate(state, now);
  // Sans lecture ou sans session valide : rien à faire tant que le site n'a pas fourni de jeton.
  if (!est || state.status === 'auth' || state.status === 'no_token') {
    await updateBadge(state, settings.threshold);
    return;
  }
  const threshold = clampThreshold(settings.threshold, state.max);
  await updateBadge(state, threshold);

  if (est.free < threshold) {
    if (state.alerted) {
      state.alerted = false;
      await saveState(state);
    }
    if (est.nextAt) wakeAt(est.nextAt);
    return;
  }

  // Seuil atteint d'après l'estimation.
  const age = now - state.readAt;
  if (!state.alerted) {
    if (!(await userActive())) return; // absent du PC : on reprendra au retour (idle.onStateChanged)
    if (age > FRESH) return readNow('auto'); // vérifier le vrai chiffre avant toute alerte
    state.alerted = true;
    await saveState(state);
    if (!(await kyaraOnScreen())) await notify(est.free, state.max);
  } else if (age >= RECHECK * (state.rush || 1)) {
    // Déjà alerté : relecture espacée pour détecter une ouverture faite sur le téléphone.
    if (await userActive()) return readNow('auto');
    return;
  }
  const recheckAt = state.readAt + RECHECK * (state.rush || 1);
  wakeAt(est.nextAt ? Math.min(est.nextAt, recheckAt) : recheckAt);
}

async function notify(free, max) {
  await browser.notifications.create('kyara-boosters', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icon.svg'),
    title: free >= max ? 'Kyara : stock de boosters plein' : 'Kyara : boosters presque au max',
    message: `${free}/${max} boosters gratuits (chiffre vérifié sur le site).`,
  });
}

browser.notifications.onClicked.addListener(async (id) => {
  if (id !== 'kyara-boosters') return;
  browser.notifications.clear(id);
  const tabs = await browser.tabs.query({ url: SITE + '*' });
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: SITE });
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') return evaluate();
});

browser.idle.onStateChanged.addListener((s) => {
  if (s === 'active') return evaluate();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) evaluate();
});

browser.runtime.onStartup.addListener(evaluate);
browser.runtime.onInstalled.addListener(evaluate);

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{1,64}$/;
const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 999;

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;
  const fromSite = !!sender.tab && typeof sender.url === 'string' && sender.url.startsWith(SITE);
  const fromPopup = !sender.tab && sender.url === browser.runtime.getURL('popup.html');

  if (fromSite && msg.type === 'auth') return onAuth(msg);
  if (fromSite && msg.type === 'count') return onCount(msg);
  if (fromPopup && msg.type === 'refresh') return readNow('manual');
});

async function onAuth(msg) {
  if (typeof msg.token !== 'string' || !TOKEN_RE.test(msg.token)) return;
  const device = typeof msg.device === 'string' && DEVICE_RE.test(msg.device) ? msg.device : null;
  const { auth, state } = await load();
  const changed = !auth || auth.token !== msg.token;
  if (changed || auth.device !== device) {
    await browser.storage.local.set({ auth: { token: msg.token, device } });
  }
  if (changed || !state.readAt || Date.now() - state.readAt > MIN) return readNow('visit');
}

async function onCount(msg) {
  if (!isCount(msg.free) || !isCount(msg.max)) return;
  const { state } = await load();
  const est = estimate(state, Date.now());
  // Le compteur affiché ne sert que de déclencheur : la valeur retenue vient toujours de l'API.
  if (!est || est.free !== msg.free || state.max !== msg.max) return readNow('visit');
}
