// Reglas de los poderes personalizados (la forja). Solo lógica pura, sin estado del juego:
// la usan el servidor, la versión sin conexión y tools/balance-check.js.
// Un poder = fuente + forma + efecto + hasta 3 niveles de 4 modificadores.
// Todo lo que se puede elegir cuesta puntos, y el presupuesto de puntos sube con el nivel.

const PARTS = {
  src: {
    fuego:    { name: 'Fuego',        cost: 2, dmg: 1.15, cd: 1.1,  mp: 1.0, color: '#ff7a2e', ico: '🔥' },
    hielo:    { name: 'Hielo',        cost: 2, dmg: 0.9,  cd: 1.0,  mp: 0.9, slow: 0.45, color: '#8fd8ff', ico: '❄️' },
    rayo:     { name: 'Electricidad', cost: 2, dmg: 0.95, cd: 0.85, mp: 1.1, color: '#f5e65a', ico: '⚡' },
    sangre:   { name: 'Sangre',       cost: 3, dmg: 1.0,  cd: 1.0,  mp: 0.7, hpcost: 0.06, color: '#c0283c', ico: '🩸' },
    gravedad: { name: 'Gravedad',     cost: 3, dmg: 0.8,  cd: 1.0,  mp: 1.0, push: 1.5, color: '#9a7aff', ico: '🌑' },
  },
  shape: {
    proyectil: { name: 'Proyectil', cost: 2, range: 7,   cd: 2600, mp: 12, dmg: 1.3, n: 1 },
    cono:      { name: 'Cono',      cost: 3, range: 3.6, cd: 3200, mp: 16, dmg: 1.1, n: 4 },
    area:      { name: 'Área',      cost: 4, range: 2.8, cd: 4200, mp: 22, dmg: 0.9, n: 99 },
  },
  eff: {
    dano:       { name: 'Daño',       cost: 1, dmg: 1.0 },
    ralentizar: { name: 'Ralentizar', cost: 2, dmg: 0.55, slow: 2500 },
    empujar:    { name: 'Empujar',    cost: 2, dmg: 0.55, push: 2.5 },
    robarVida:  { name: 'Robar vida', cost: 3, dmg: 0.75, leech: 0.5 },
    curar:      { name: 'Curar',      cost: 2, dmg: 0,    heal: 0.22 },
  },
  mod: {
    alcance:    { name: 'Alcance',    desc: '+20% de alcance por nivel' },
    potencia:   { name: 'Potencia',   desc: '+15% de efecto y +4 de energía por nivel' },
    rapidez:    { name: 'Rapidez',    desc: '-12% de enfriamiento por nivel' },
    eficiencia: { name: 'Eficiencia', desc: '-12% de energía por nivel' },
  },
};

const MOD_MAX = 3;
const MOD_COST = [0, 1, 3, 7];   // costo acumulado por nivel: rendimientos decrecientes
const POWER_MIN_CD = 2000;       // ningún poder se repite en menos de 2 s
const POWER_GCD = 900;           // entre dos poderes cualquiera pasan al menos 0,9 s
const POWER_DMG_CAP = 0.4;       // un golpe nunca pasa del 40% de la vida máxima de alguien de tu nivel
const POWER_HEAL_CAP = 0.3;      // una cura nunca pasa del 30% de la vida máxima
const PVP_MUL = 0.6;             // contra otros jugadores los poderes hacen 40% menos
const MAX_POWERS = 6;
const FORGE_COST = { nucleo: 1, silver: 10 };

const powerBudget = (lvl) => Math.min(40, 10 + lvl);

function cleanPower(d) {
  if (!d || !PARTS.src[d.src] || !PARTS.shape[d.shape] || !PARTS.eff[d.eff]) return null;
  const mods = {};
  for (const k in PARTS.mod) {
    const v = Math.floor(+(d.mods && d.mods[k]) || 0);
    if (v < 0 || v > MOD_MAX) return null;
    mods[k] = v;
  }
  const name = String(d.name || '').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 14);
  return { name, src: d.src, shape: d.shape, eff: d.eff, mods };
}

const defaultPowerName = (c) => PARTS.src[c.src].name + ' ' + PARTS.shape[c.shape].name;

const powerCost = (c) =>
  PARTS.src[c.src].cost + PARTS.shape[c.shape].cost + PARTS.eff[c.eff].cost +
  Object.keys(c.mods).reduce((s, k) => s + MOD_COST[c.mods[k]], 0);

function powerStats(c, lvl) {
  const S = PARTS.src[c.src], SH = PARTS.shape[c.shape], E = PARTS.eff[c.eff], m = c.mods;
  const mhp = 100 + (lvl - 1) * 10;
  let dmg = (16 + lvl * 4) * S.dmg * SH.dmg * E.dmg * (1 + 0.15 * m.potencia);
  dmg = Math.min(dmg, POWER_DMG_CAP * mhp);
  const cd = Math.max(POWER_MIN_CD, Math.round(SH.cd * S.cd * (1 - 0.12 * m.rapidez)));
  const mp = Math.max(6, Math.round((SH.mp * S.mp + 4 * m.potencia) * (1 - 0.12 * m.eficiencia) * (1 + 0.04 * (lvl - 1))));
  const range = +(SH.range * (1 + 0.2 * m.alcance)).toFixed(1);
  const heal = E.heal ? Math.min(POWER_HEAL_CAP, E.heal * (1 + 0.15 * m.potencia)) : 0;
  return { dmg: Math.round(dmg), cd, mp, range, heal: +heal.toFixed(2), hpcost: S.hpcost || 0 };
}

module.exports = { PARTS, MOD_MAX, MOD_COST, POWER_MIN_CD, POWER_GCD, POWER_DMG_CAP, POWER_HEAL_CAP, PVP_MUL, MAX_POWERS, FORGE_COST,
  powerBudget, cleanPower, defaultPowerName, powerCost, powerStats };
