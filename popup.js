'use strict';

const $ = (id) => document.getElementById(id);
let state = {};
let settings = { threshold: 18 };

const two = (n) => String(n).padStart(2, '0');

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h ${two(m % 60)}`;
}

function render() {
  const now = Date.now();
  const est = estimate(state, now);
  $('count').textContent = '';
  if (est) {
    $('count').append(String(est.free));
    const small = document.createElement('small');
    small.textContent = ' / ' + state.max;
    $('count').append(small);
    $('next').textContent = est.nextAt ? `+1 dans ${duration(est.nextAt - now)}` : 'Stock plein';
    const sure = now - state.readAt < 90000;
    $('read').textContent = `Lu sur le site ${ago(now - state.readAt)}` + (sure ? '' : ' (estimation depuis)');
    $('account').textContent = state.pseudo ? `Compte : ${state.pseudo}` : '';
    $('threshold').max = state.max;
  } else {
    $('count').textContent = '-';
    $('next').textContent = '';
    $('read').textContent = '';
    $('account').textContent = '';
  }

  let msg = '';
  if (state.status === 'no_token' || (!est && !state.status)) msg = 'Ouvre kyara.games une fois (connecté) pour relier la session.';
  else if (state.status === 'auth') msg = 'Session expirée : ouvre kyara.games et reconnecte-toi.';
  else if (state.status === 'error') msg = `Site injoignable (${state.error}). Nouvel essai automatique plus tard.`;
  $('msg').textContent = msg;
}

async function init() {
  const s = await browser.storage.local.get(['state', 'settings']);
  state = s.state || {};
  settings = Object.assign(settings, s.settings);
  $('threshold').value = settings.threshold;
  render();
  setInterval(render, 1000);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) {
    state = changes.state.newValue || {};
    render();
  }
});

$('threshold').addEventListener('change', () => {
  const v = Math.round(Number($('threshold').value));
  if (!Number.isInteger(v) || v < 1 || v > 99) return;
  settings.threshold = v;
  browser.storage.local.set({ settings });
});

$('refresh').addEventListener('click', () => {
  browser.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
});

init();
