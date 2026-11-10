// Test de bout en bout du script de fond avec une API navigateur et un site simulés.
// Lancer : node test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const MIN = 60000;
const T0 = Date.parse('2026-11-10T17:00:00Z');

const sim = {
  now: T0,
  store: {},
  alarm: null,
  idle: 'active',
  onScreen: false,
  notifs: [],
  fetches: [],
  badge: '',
  me: { freePacks: 9, freePacksMax: 20, nextFreeAt: new Date(T0 + 7 * MIN).toISOString(), membership: { regenBoostPct: 20 }, pseudo: 'Test' },
  meStatus: 200,
  listeners: {},
};

const on = (name) => ({ addListener: (fn) => { sim.listeners[name] = fn; } });
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const browser = {
  idle: { setDetectionInterval() {}, queryState: async () => sim.idle, onStateChanged: on('idle') },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in sim.store).map((k) => [k, clone(sim.store[k])])),
      set: async (obj) => { Object.assign(sim.store, clone(obj)); },
      remove: async (k) => { delete sim.store[k]; },
    },
    onChanged: on('storage'),
  },
  alarms: { create: (name, o) => { sim.alarm = o.when; }, onAlarm: on('alarm') },
  windows: { getLastFocused: async () => ({ id: 1, focused: true }), update: async () => {} },
  tabs: { query: async () => (sim.onScreen ? [{ id: 1, windowId: 1, url: 'https://kyara.games/' }] : []), update: async () => {}, create: async () => {} },
  browserAction: { setBadgeText: async ({ text }) => { sim.badge = text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  notifications: { create: async (id, o) => { sim.notifs.push(o.message); }, clear() {}, onClicked: on('notifClick') },
  runtime: { getURL: (p) => 'moz-extension://x/' + p, onStartup: on('startup'), onInstalled: on('installed'), onMessage: on('message') },
};

async function fetchMock(url, opts = {}) {
  sim.fetches.push(url.replace('https://kyara.games/api', ''));
  const headers = { get: (k) => ({ date: new Date(sim.now).toUTCString(), 'x-kyara-rush': '1' })[k] || null };
  if (url.endsWith('/config')) return { ok: true, status: 200, headers, json: async () => ({ freePacks: { max: 10, regenHours: 1 / 6 } }) };
  assert.strictEqual(opts.headers.authorization, 'Bearer ' + 'a'.repeat(64));
  return { ok: sim.meStatus === 200, status: sim.meStatus, headers, json: async () => clone(sim.me) };
}

const ctx = vm.createContext({ browser, fetch: fetchMock, AbortSignal, console });
vm.runInContext('Date.now = () => globalThis.__now();', ctx);
ctx.__now = () => sim.now;
for (const f of ['logic.js', 'background.js']) vm.runInContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), ctx, { filename: f });

const site = { tab: { id: 1 }, url: 'https://kyara.games/' };
const meReads = () => sim.fetches.filter((u) => u === '/me').length;
// Avance le temps en déclenchant les alarmes programmées, jusqu'à `until`.
async function runUntil(until) {
  while (sim.alarm && sim.alarm <= until) {
    sim.now = sim.alarm;
    sim.alarm = null;
    await sim.listeners.alarm({ name: 'tick' });
  }
  sim.now = until;
}

(async () => {
  // Un message venu d'une autre origine est ignoré.
  await sim.listeners.message({ type: 'auth', token: 'a'.repeat(64) }, { tab: { id: 2 }, url: 'https://evil.example/' });
  assert.strictEqual(sim.store.auth, undefined);

  // Visite du site : jeton reçu, première lecture.
  await sim.listeners.message({ type: 'auth', token: 'a'.repeat(64), device: 'dev-1' }, site);
  assert.strictEqual(sim.badge, '9');
  assert.strictEqual(meReads(), 1);
  assert.strictEqual(sim.store.state.regenMs, 8 * MIN);

  // Le minuteur monte jusqu'à 17 sans aucune requête.
  await runUntil(T0 + 7 * MIN + 7 * 8 * MIN + 1000);
  assert.strictEqual(sim.badge, '17');
  assert.strictEqual(meReads(), 1);
  assert.deepStrictEqual(sim.notifs, []);

  // Estimation à 18, mais des boosters ont été ouverts sur le téléphone : pas d'alerte.
  sim.me.freePacks = 12;
  sim.me.nextFreeAt = new Date(T0 + 7 * MIN + 8 * 8 * MIN + 3 * MIN).toISOString();
  await runUntil(T0 + 7 * MIN + 8 * 8 * MIN + 1000);
  assert.strictEqual(meReads(), 2);
  assert.strictEqual(sim.badge, '12');
  assert.deepStrictEqual(sim.notifs, []);

  // Remontée à 18 pendant une absence du PC : ni requête ni alerte.
  sim.idle = 'idle';
  const t18 = Date.parse(sim.me.nextFreeAt) + 5 * 8 * MIN;
  sim.me.freePacks = 18;
  sim.me.nextFreeAt = new Date(t18 + 8 * MIN).toISOString();
  await runUntil(t18 + 1000);
  assert.strictEqual(meReads(), 2);
  assert.deepStrictEqual(sim.notifs, []);

  // Retour devant le PC : une vérification, puis une seule alerte.
  sim.now += 20 * MIN;
  sim.me.freePacks = 20;
  sim.me.nextFreeAt = null;
  sim.idle = 'active';
  await sim.listeners.idle('active');
  assert.strictEqual(meReads(), 3);
  assert.deepStrictEqual(sim.notifs, ['20/20 boosters gratuits (chiffre vérifié sur le site).']);

  // Stock plein pendant 2 h : relectures espacées de 30 min, pas de nouvelle alerte.
  const before = meReads();
  await runUntil(sim.now + 120 * MIN);
  assert.strictEqual(meReads() - before, 4);
  assert.strictEqual(sim.notifs.length, 1);

  // Vidé sur le téléphone puis re-rempli : l'alerte est réarmée, mais muette si le site est à l'écran.
  sim.me.freePacks = 17;
  sim.me.nextFreeAt = new Date(sim.now + 40 * MIN).toISOString();
  await runUntil(sim.now + 31 * MIN);
  assert.strictEqual(sim.store.state.alerted, false);
  sim.onScreen = true;
  sim.me.freePacks = 18;
  sim.me.nextFreeAt = new Date(sim.now + 17 * MIN).toISOString();
  await runUntil(sim.now + 10 * MIN);
  assert.strictEqual(sim.store.state.alerted, true);
  assert.strictEqual(sim.notifs.length, 1);

  // Session expirée : jeton oublié, plus aucune requête.
  sim.meStatus = 401;
  const n = meReads();
  await runUntil(sim.now + 31 * MIN);
  assert.strictEqual(meReads(), n + 1);
  assert.strictEqual(sim.store.auth, undefined);
  assert.strictEqual(sim.badge, '!');
  await runUntil(sim.now + 300 * MIN);
  assert.strictEqual(meReads(), n + 1);

  assert.strictEqual(sim.fetches.filter((u) => u === '/config').length, 1);
  console.log(`OK - ${meReads()} lectures /api/me sur ${Math.round((sim.now - T0) / 3600000)} h simulées`);
})().catch((e) => { console.error(e); process.exit(1); });
