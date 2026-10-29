// Revisa TODAS las combinaciones de poderes posibles y avisa si alguna se pasa de rota.
// Uso: node tools/balance-check.js
const P = require('../powers');

const LEVELS = [1, 10, 20, 30];
const BURST_MS = 6000;
const REGEN_MP = 3;                         // energía por segundo (igual que el servidor)
const mmp = (l) => 50 + (l - 1) * 5;
const mhp = (l) => 100 + (l - 1) * 10;
const basicDps = (l, sword) => (10 + l * 2 + (sword ? 12 : 0)) / 0.5; // ataque básico cada 0.5 s

function* builds() {
  const mk = Object.keys(P.PARTS.mod);
  const rec = function* (i, mods) {
    if (i === mk.length) { yield { ...mods }; return; }
    for (let v = 0; v <= P.MOD_MAX; v++) yield* rec(i + 1, { ...mods, [mk[i]]: v });
  };
  for (const src in P.PARTS.src) for (const shape in P.PARTS.shape) for (const eff in P.PARTS.eff)
    for (const mods of rec(0, {})) yield { src, shape, eff, mods };
}

let problems = 0;
for (const lvl of LEVELS) {
  const budget = P.powerBudget(lvl);
  let n = 0, best = null, bestAoe = null, bestBurst = null, maxHit = 0, minCd = 1e9, maxHeal = 0;
  for (const c of builds()) {
    const cost = P.powerCost(c);
    if (cost > budget) continue;
    n++;
    const s = P.powerStats(c, lvl), sh = P.PARTS.shape[c.shape];
    const rate = Math.min(1000 / s.cd, REGEN_MP / s.mp);      // casts/s que la energía deja sostener
    const dps = s.dmg * rate;
    const aoe = dps * Math.min(sh.n, 3);                       // contra 3 enemigos juntos
    // ráfaga de 6 s con 3 poderes iguales: limitada por la recarga de cada uno, por la recarga global y por la energía
    const casts = Math.min(3 * (Math.floor(BURST_MS / s.cd) + 1), Math.floor(BURST_MS / P.POWER_GCD) + 1, Math.floor((mmp(lvl) + REGEN_MP * BURST_MS / 1000) / s.mp));
    const burst = s.dmg * casts * P.PVP_MUL;                   // contra otro jugador
    if (!best || dps > best.v) best = { v: dps, c, s, cost };
    if (!bestAoe || aoe > bestAoe.v) bestAoe = { v: aoe, c, s, cost };
    if (!bestBurst || burst > bestBurst.v) bestBurst = { v: burst, c, s, cost };
    maxHit = Math.max(maxHit, s.dmg); minCd = Math.min(minCd, s.cd); maxHeal = Math.max(maxHeal, s.heal);
  }
  const show = (b) => `${b.c.src}/${b.c.shape}/${b.c.eff} ${JSON.stringify(b.c.mods)} costo ${b.cost}`;
  console.log(`\nNivel ${lvl}  presupuesto ${budget}  combinaciones válidas ${n}`);
  console.log(`  ataque básico: ${basicDps(lvl, false)} dps (con espada ${basicDps(lvl, true)})`);
  console.log(`  mejor dps sostenido 1 objetivo: ${best.v.toFixed(1)}  ← ${show(best)}`);
  console.log(`  mejor dps sostenido vs 3:        ${bestAoe.v.toFixed(1)}  ← ${show(bestAoe)}`);
  console.log(`  mejor ráfaga de 6 s vs jugador:   ${bestBurst.v.toFixed(0)} de daño (ataque básico con espada: ${basicDps(lvl, true) * BURST_MS / 1000})  ← ${show(bestBurst)}`);
  console.log(`  golpe máximo ${maxHit} (tope ${P.POWER_DMG_CAP * mhp(lvl)}), enfriamiento mínimo ${minCd} ms, cura máxima ${(maxHeal * 100).toFixed(0)}%`);
  if (maxHit > P.POWER_DMG_CAP * mhp(lvl) + 0.5) { console.log('  ✗ un golpe pasa del tope'); problems++; }
  if (minCd < P.POWER_MIN_CD) { console.log('  ✗ enfriamiento por debajo del mínimo'); problems++; }
  if (maxHeal > P.POWER_HEAL_CAP + 1e-9) { console.log('  ✗ una cura pasa del tope'); problems++; }
  if (best.v > basicDps(lvl, true)) { console.log('  ✗ un poder sostenido supera al ataque básico con espada'); problems++; }
  const basicBurst = basicDps(lvl, true) * BURST_MS / 1000;
  if (bestBurst.v > basicBurst) { console.log('  ✗ en 6 s los poderes hacen más daño a jugadores que el ataque básico con espada (' + basicBurst + ')'); problems++; }
}
console.log(problems ? `\n${problems} problema(s) de balance` : '\nSin problemas de balance con estos límites.');
process.exit(problems ? 1 : 0);
