// Calculs purs, partagés par le script de fond et le popup (et testables avec Node).
'use strict';

const DEFAULT_REGEN_MS = 10 * 60 * 1000;

// Durée d'une régénération, selon les mêmes règles que le site :
// (boost en cours, sinon config) x (1 - bonus d'abonnement).
function computeRegenMs(me, cfgRegenHours) {
  const hours = (me && me.freeBoost && me.freeBoost.regenHours) ?? cfgRegenHours;
  const pct = (me && me.membership && me.membership.regenBoostPct) || 0;
  const ms = Number(hours) * 3600000 * (1 - Number(pct) / 100);
  if (!Number.isFinite(ms) || ms < 30000 || ms > 86400000) return DEFAULT_REGEN_MS;
  return Math.round(ms);
}

// Estimation du stock à l'instant `now` à partir de la dernière lecture.
// Renvoie { free, nextAt } (nextAt = date du prochain +1, ou null si plein/inconnu).
function estimate(state, now) {
  if (!state || !Number.isInteger(state.free) || !Number.isInteger(state.max)) return null;
  const regen = state.regenMs || DEFAULT_REGEN_MS;
  const { free, max, nextFreeAt } = state;
  if (free >= max || !nextFreeAt) return { free, nextAt: null };
  if (now < nextFreeAt) return { free, nextAt: nextFreeAt };
  const gained = 1 + Math.floor((now - nextFreeAt) / regen);
  const est = Math.min(max, free + gained);
  return { free: est, nextAt: est >= max ? null : nextFreeAt + gained * regen };
}

function clampThreshold(threshold, max) {
  const t = Number.isInteger(threshold) ? threshold : 18;
  return Math.max(1, Math.min(t, max));
}

if (typeof module !== 'undefined') {
  module.exports = { DEFAULT_REGEN_MS, computeRegenMs, estimate, clampThreshold };
}
