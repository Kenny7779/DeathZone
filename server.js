// Servidor autoritativo del MMORPG (Node.js + ws)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Pw = require('./powers');
const crypto = require('crypto');
function newSalt() { return crypto.randomBytes(8).toString('hex'); }
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex'); }

const PORT = process.env.PORT || 3000;
const TICK = 50;             // 20 Hz
const SPEED = 4.5;           // tiles/seg
// Razas: cada una da pequeñas ventajas y desventajas (hp/mp: vida y energía base, dmg: daño base, spd: velocidad, xp: experiencia, gat: prob. de recolección extra).
const RACES = {
  humano: { name: 'Humano', ico: '🧑', desc: '+15% de experiencia', hp: 0, mp: 0, dmg: 0, spd: 1, xp: 1.15, gat: 0 },
  elfo:   { name: 'Elfo', ico: '🧝', desc: '+25 energía · +6% velocidad', hp: 0, mp: 25, dmg: 0, spd: 1.06, xp: 1, gat: 0 },
  enano:  { name: 'Enano', ico: '🧔', desc: '+25 vida · +15% recolección extra', hp: 25, mp: 0, dmg: 0, spd: 1, xp: 1, gat: 0.15 },
  orco:   { name: 'Orco', ico: '👹', desc: '+4 daño · +15 vida · −15 energía', hp: 15, mp: -15, dmg: 4, spd: 1, xp: 1, gat: 0 },
  felino: { name: 'Felino', ico: '🐱', desc: '+12% velocidad · −10 vida', hp: -10, mp: 0, dmg: 0, spd: 1.12, xp: 1, gat: 0 },
};
const MAX_CHARS = 3;
// Nombres: únicos (sin distinguir mayúsculas ni acentos). "Kaito X" está reservado para el dueño del juego (variable OWNER_ACCOUNT = nombre de su cuenta;
// en el modo sin conexión eres tú). Los nombres de los personajes de la historia no los puede usar nadie.
const OWNER_ACCOUNT = (typeof process !== 'undefined' && process.env && process.env.OWNER_ACCOUNT || '').trim();
const SOLO_MODE = typeof SOLO !== 'undefined' && SOLO;
const nk = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') || String(n || '').toLowerCase();
const RESERVED_NPC = ['veyra', 'mirei', 'orionvael', 'orion', 'dorkan', 'nyx', 'garrick', 'seraphine', 'hombresinnombre', 'quintocreador'];
const reservedName = (n, loginName) => {
  if (RESERVED_NPC.includes(nk(n))) return true;
  if (nk(n).includes('kaito')) return !(SOLO_MODE || (OWNER_ACCOUNT && nk(loginName) === nk(OWNER_ACCOUNT)));
  return false;
};
// Historia: los villanos del libro son los jefes del mundo. Derrotar a cada uno por primera vez da una recompensa.
const STORY = [
  { nm: 'Dorkan el Quebrantahuesos', where: 'Zona de la muerte', lvl: 5, rew: { silver: 250, xp: 150, nucleo: 3 }, text: 'Un gigante cuyo don es volverse más duro con cada golpe recibido. Ya derribó un edificio, tres puentes y el orgullo de seis héroes.' },
  { nm: 'Garrick el Eterno', where: 'Tundra helada', lvl: 12, rew: { silver: 500, xp: 300, nucleo: 4 }, text: 'No puede morir, así que no intentes matarlo. Derrótalo y deja que el tedio haga el resto.' },
  { nm: 'Seraphine la Voz', where: 'Desierto de cristal', lvl: 18, rew: { silver: 800, xp: 500, nucleo: 5 }, text: 'Cada palabra suya es una orden. Acercarse sin obedecerla requiere ingenio... o silencio.' },
  { nm: 'Nyx, la Reina del Vacío', where: 'Ruinas de Calderón', lvl: 25, rew: { silver: 1200, xp: 800, nucleo: 6 }, text: 'Borra de la existencia todo lo que toca. El vacío no se vence con materia: se vence con significado.' },
  { nm: 'El Hombre Sin Nombre', where: 'Valle volcánico (Eldoria)', lvl: 30, rew: { silver: 2000, xp: 1300, nucleo: 8 }, text: 'Nadie recuerda su rostro cinco segundos después de verlo. Tiene todas las caras. Tiene la tuya.' },
  { nm: 'El Quinto Creador', where: 'Ruinas del Alba (Eldoria)', lvl: 35, rew: { silver: 3500, xp: 2200, nucleo: 12 }, text: 'El Gran Villano más antiguo, el que creó a los otros cuatro. Algo antiguo despertó en algún lugar muy lejos.' },
];
// Mapas. La ciudad es el lobby (zona principal, segura): ahí apareces y reapareces. Su puerta lleva al mundo de enemigos
// (zona de la muerte). Al llegar al borde de un mapa pasas al mapa vecino (links). Los edificios abren su menú al acercarte.
const MAPDEF = {
  lobby: { name: 'Aurelia', W: 44, H: 40, safe: true, biome: 'city', spawn: [6, 20],
    buildings: [
      { id: 'herreria', name: 'Herrería', x: 8, y: 10, w: 4, d: 3, h: 46, roof: '#b5651d', tab: 'craft' },
      { id: 'mercado',  name: 'Mercado',  x: 8, y: 26, w: 4, d: 3, h: 40, roof: '#2f8f8f', tab: 'market' },
      { id: 'torre',    name: 'Torre de poderes', x: 18, y: 12, w: 3, d: 3, h: 84, roof: '#7a4bd1', tab: 'powers' },
      { id: 'salon',    name: 'Salón de habilidades', x: 18, y: 26, w: 3, d: 3, h: 52, roof: '#3f7fe0', tab: 'tree' },
      { id: 'academia', name: 'Gran Academia de Héroes', x: 19, y: 1.5, w: 12, d: 4, h: 96, roof: '#6d3fb5', tab: null },
      { id: 'tablon',   name: 'Tablón de misiones', x: 28, y: 12, w: 3, d: 2, h: 44, roof: '#c9a227', tab: 'quests' },
      { id: 'puerta',   name: 'Puerta de la zona de la muerte', x: 41.6, y: 16, w: 1.4, d: 8, h: 70, roof: '#7a1f1f', tab: null, solid: false },
    ],
    npcs: [
      { id: 'veyra', name: 'Veyra', title: 'Examinadora de la Gran Academia', x: 26, y: 9, look: ['hielo', 0, 0, 1, 'humano'] },
      { id: 'mirei', name: 'Mirei', title: 'Heroína de rango A · luz solidificada', x: 14.5, y: 19.5, look: ['rayo', 1, 0, 2, 'humano'] },
      { id: 'orion', name: 'Orion Vael', title: 'El último Creador antes que tú', x: 23, y: 17.5, look: ['tierra', 0, 0, 4, 'humano'] },
    ],
    links: [{ side: 'e', min: 16, max: 24, to: 'muerte' }] },
  muerte: { tier: 1, boss: 'Dorkan el Quebrantahuesos', name: 'Zona de la muerte', W: 120, H: 120, biome: 'death', hp: 60, dmg: 8, rew: 1, core: 0.3, mobs: 55, tree: 150, rock: 90, ore: 80,
    links: [{ side: 'w', to: 'lobby' }, { side: 'n', to: 'bosque' }, { side: 's', to: 'hielo' }, { side: 'e', to: 'desierto' }] },
  bosque: { tier: 1, boss: 'El Pato Gigante', name: 'Bosque encantado', W: 100, H: 100, biome: 'forest', hp: 40, dmg: 5, rew: 0.7, core: 0.12, mobs: 35, tree: 320, rock: 40, ore: 20,
    links: [{ side: 's', to: 'muerte' }] },
  hielo: { tier: 2, boss: 'Garrick el Eterno', name: 'Tundra helada', W: 100, H: 100, biome: 'ice', hp: 90, dmg: 11, rew: 1.5, core: 0.4, mobs: 45, tree: 60, rock: 150, ore: 110,
    links: [{ side: 'n', to: 'muerte' }] },
  desierto: { tier: 3, boss: 'Seraphine la Voz', name: 'Desierto de cristal', W: 110, H: 110, biome: 'desert', hp: 110, dmg: 13, rew: 2, core: 0.45, mobs: 45, tree: 20, rock: 170, ore: 140,
    links: [{ side: 'w', to: 'muerte' }, { side: 'e', to: 'ruinas' }] },
  ruinas: { tier: 4, boss: 'Nyx, la Reina del Vacío', name: 'Ruinas de Calderón', W: 100, H: 100, biome: 'ruins', hp: 170, dmg: 18, rew: 3, core: 0.7, mobs: 40, tree: 30, rock: 120, ore: 160,
    links: [{ side: 'w', to: 'desierto' }] },
};
// Continente de Eldoria: mundo enorme (360x360) dividido en 9 regiones con clima y dificultad propios.
// Los Maestros de vuelo (edificios dorados) permiten viajar volando entre regiones y mapas, como en WoW.
const TIERS = { 1: { hp: 45, dmg: 6, rew: 0.8, core: 0.15 }, 2: { hp: 80, dmg: 10, rew: 1.3, core: 0.3 }, 3: { hp: 120, dmg: 14, rew: 2, core: 0.45 }, 4: { hp: 170, dmg: 19, rew: 3, core: 0.6 } };
const FLIGHTS = [{ id: 'aurora', name: 'Aurelia', map: 'lobby', x: 29.5, y: 31.5 }];
const FLIGHT_START = ['aurora', 'eld_plains'];
MAPDEF.lobby.buildings.splice(MAPDEF.lobby.buildings.length - 1, 0, { id: 'vuelo', name: 'Maestro de vuelo', x: 28, y: 28.5, w: 3, d: 2, h: 50, roof: '#d9a441', tab: 'fly' });
MAPDEF.bosque.links.push({ side: 'n', to: 'eldoria' });
MAPDEF.eldoria = { tier: 1, name: 'Continente de Eldoria', W: 360, H: 360, biome: 'plains', regions: [], buildings: [], links: [{ side: 's', to: 'bosque' }] };
[[0, 0, 'Cumbres nevadas', 'ice', 4, { tree: 8, rock: 60, ore: 45 }, 'El Yunque Colosal'], [1, 0, 'Montañas de hierro', 'mount', 2, { tree: 25, rock: 70, ore: 55 }, 'Gólem de Dorkan'], [2, 0, 'Pantano de la niebla', 'swamp', 3, { tree: 80, rock: 25, ore: 30 }, 'El Pato Devoramesas'],
 [0, 1, 'Bosque de Aldea', 'forest', 1, { tree: 110, rock: 20, ore: 10 }, 'Sombra de Nyx'], [1, 1, 'Llanuras de Eldoria', 'plains', 1, { tree: 50, rock: 35, ore: 15 }, 'El Pato Gigante Mayor'], [2, 1, 'Desierto escarlata', 'desert', 3, { tree: 8, rock: 60, ore: 50 }, 'Eco de Seraphine'],
 [0, 2, 'Costa cristalina', 'beach', 2, { tree: 40, rock: 40, ore: 25 }, 'Leviatán de Ramen'], [1, 2, 'Valle volcánico', 'volcano', 4, { tree: 6, rock: 60, ore: 60 }, 'El Hombre Sin Nombre'], [2, 2, 'Ruinas del Alba', 'ruins', 4, { tree: 12, rock: 55, ore: 55 }, 'El Quinto Creador']].forEach(([cx, cy, name, biome, tier, res, boss]) => {
  const x0 = cx * 120, y0 = cy * 120, mx = x0 + 60, my = y0 + 60;
  MAPDEF.eldoria.regions.push({ x0, y0, x1: x0 + 120, y1: y0 + 120, name, biome, tier, res, boss, mobs: 40, node: [mx, my + 3.5] });
  MAPDEF.eldoria.buildings.push({ id: 'vuelo_' + biome, name: 'Maestro de vuelo · ' + name, x: mx - 1.5, y: my - 1, w: 3, d: 2, h: 50, roof: '#d9a441', tab: 'fly' });
  FLIGHTS.push({ id: 'eld_' + biome, name: name, map: 'eldoria', x: mx, y: my + 3.5 });
});
// Colisiones: los edificios son sólidos (la puerta se puede cruzar). El jugador mide 0,4 tiles de radio.
const R_PLAYER = 0.4;
const blockedAt = (w, x, y) => (w.buildings || []).some((b) => b.solid !== false && x > b.x - R_PLAYER && x < b.x + b.w + R_PLAYER && y > b.y - R_PLAYER && y < b.y + b.d + R_PLAYER);
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' };
const DATA_FILE = path.join(__dirname, 'data.json');

const RECIPES = {
  espada:   { wood: 4, ore: 3 },     // +12 de daño
  armadura: { stone: 6, ore: 2 },    // -30% daño recibido
  pocion:   { wood: 3, stone: 1 },   // cura 60 HP
  montura:  { wood: 10, ore: 6, nucleo: 2 },   // +50% de velocidad; al recibir daño te tira
};
const ITEMS = ['wood', 'stone', 'ore', 'nucleo', 'espada', 'armadura', 'pocion', 'montura'];

// ---------- utilidades ----------
let seed = 1337;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let nextId = 1;
const newId = () => nextId++;

// ---------- cuentas (persistentes) ----------
let accounts = {};
let listings = [];
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  accounts = d.accounts || {};
  listings = d.listings || [];
  nextId = d.nextId || 1;
} catch (e) { /* primera vez */ }
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ accounts, listings, nextId })); } catch (e) { console.error('save', e.message); }
}
setInterval(save, 30000);
process.on('SIGINT', () => { save(); process.exit(0); });

function getAcct(name) {
  if (!accounts[name]) accounts[name] = { name, inv: {}, silver: 20, xp: 0, lvl: 1 };
  const a = accounts[name];
  if (!a.starter) { a.starter = true; a.inv.nucleo = (a.inv.nucleo || 0) + 1; } // 1 núcleo para forjar el primer poder
  return a;
}

// ---------- mundo ----------
// Tipos de monstruo: normal, rápido (frágil), bruto (lento y duro) y jefe (uno por zona peligrosa).
const KINDS = { nor: { hp: 1, dmg: 1, sp: 3, rew: 1, ag: 7 }, rap: { hp: 0.6, dmg: 0.8, sp: 5, rew: 1.3, ag: 8 },
  bru: { hp: 2.2, dmg: 1.6, sp: 2, rew: 2, ag: 6 }, jef: { hp: 14, dmg: 2.2, sp: 2.6, rew: 10, ag: 10 } };
const worlds = {};
for (const id in MAPDEF) {
  const d = MAPDEF[id], w = worlds[id] = { ...d, id, res: [], mobs: [], bags: [] };
  const put = (type, n) => {
    for (let i = 0; i < n; i++) {
      const x = 2 + rnd() * (w.W - 4), y = 2 + rnd() * (w.H - 4);
      w.res.push({ id: newId(), t: type, x, y, hp: type === 'ore' ? 4 : 3, alive: true, respawn: 0 });
    }
  };
  put('tree', d.tree || 0); put('rock', d.rock || 0); put('ore', d.ore || 0);
  for (let i = 0; i < (d.mobs || 0); i++) {   // lejos de los bordes (zonas de llegada)
    const x = 9 + rnd() * (w.W - 18), y = 9 + rnd() * (w.H - 18);
    const r = rnd(), k = r < 0.6 ? 'nor' : r < 0.85 ? 'rap' : 'bru', K = KINDS[k], hp = Math.round(d.hp * K.hp);
    w.mobs.push({ id: newId(), w: id, k, tier: d.tier || 1, sp: K.sp, ag: K.ag, x, y, hx: x, hy: y, hp, mhp: hp, dmg: Math.round(d.dmg * K.dmg), rew: d.rew * K.rew, core: d.core, rt: 15000, alive: true, respawn: 0, cd: 0 });
  }
  for (const R of d.regions || []) {   // regiones del continente: recursos, monstruos y un jefe cada una
    const T = TIERS[R.tier], bx = (R.x0 + R.x1) / 2, by = (R.y0 + R.y1) / 2, nx = R.node[0], ny = R.node[1];
    for (const type of ['tree', 'rock', 'ore']) for (let i = 0; i < R.res[type]; i++) {
      const x = R.x0 + 3 + rnd() * (R.x1 - R.x0 - 6), y = R.y0 + 3 + rnd() * (R.y1 - R.y0 - 6);
      if (Math.hypot(x - nx, y - ny) < 8) continue;
      w.res.push({ id: newId(), t: type, x, y, hp: type === 'ore' ? 4 : 3, alive: true, respawn: 0 });
    }
    for (let i = 0; i < R.mobs; i++) {
      const x = R.x0 + 9 + rnd() * (R.x1 - R.x0 - 18), y = R.y0 + 9 + rnd() * (R.y1 - R.y0 - 18);
      if (Math.hypot(x - nx, y - ny) < 16) continue;
      const r = rnd(), k = r < 0.6 ? 'nor' : r < 0.85 ? 'rap' : 'bru', K = KINDS[k], hp = Math.round(T.hp * K.hp);
      w.mobs.push({ id: newId(), w: id, k, tier: R.tier, sp: K.sp, ag: K.ag, x, y, hx: x, hy: y, hp, mhp: hp, dmg: Math.round(T.dmg * K.dmg), rew: T.rew * K.rew, core: T.core, rt: 15000, alive: true, respawn: 0, cd: 0 });
    }
    const K = KINDS.jef, hp = Math.round(T.hp * K.hp), x = bx + 25, y = by - 25;
    w.mobs.push({ id: newId(), w: id, k: 'jef', nm: R.boss, tier: R.tier, sp: K.sp, ag: K.ag, x, y, hx: x, hy: y, hp, mhp: hp, dmg: Math.round(T.dmg * K.dmg), rew: T.rew * K.rew, core: 1, rt: 180000, alive: true, respawn: 0, cd: 0, sc: 0 });
  }
  if (!d.safe && !d.regions) {   // jefe en el centro del mapa
    const K = KINDS.jef, hp = Math.round(d.hp * K.hp), x = w.W / 2, y = w.H / 2;
    w.mobs.push({ id: newId(), w: id, k: 'jef', nm: d.boss || 'Jefe', tier: d.tier || 1, sp: K.sp, ag: K.ag, x, y, hx: x, hy: y, hp, mhp: hp, dmg: Math.round(d.dmg * K.dmg), rew: d.rew * K.rew, core: 1, rt: 120000, alive: true, respawn: 0, cd: 0, sc: 0 });
  }
}
const players = new Map(); // ws -> player
let events = [];

// ---------- jugador ----------
const raceOf = (a) => { const r = a.char && a.char.race; return (typeof r === 'string' && Object.prototype.hasOwnProperty.call(RACES, r)) ? RACES[r] : RACES.humano; };
// ---------- equipo con rareza: casco (vida), pecho (defensa), botas (velocidad), anillo (daño) ----------
const SLOTS = { casco: { ico: '🪖', n: 'Casco', k: 'hp', base: 12 }, pecho: { ico: '🛡️', n: 'Peto', k: 'def', base: 0.03 }, botas: { ico: '👢', n: 'Botas', k: 'spd', base: 0.03 }, anillo: { ico: '💍', n: 'Anillo', k: 'dmg', base: 0.04 } };
const RARS = [{ n: 'Común', m: 1, c: '#c8ccd2' }, { n: 'Poco común', m: 1.5, c: '#5fd35f' }, { n: 'Raro', m: 2.2, c: '#4aa3ff' }, { n: 'Épico', m: 3.2, c: '#c05cff' }];
const TIER_N = ['rústico', 'de hierro', 'glacial', 'de cristal', 'arcano'], GEAR_MAX = 24;
function rollGear(tier, minRar) {
  const r = rnd(), rar = Math.max(minRar || 0, r < 0.6 ? 0 : r < 0.85 ? 1 : r < 0.97 ? 2 : 3);
  const keys = Object.keys(SLOTS), slot = keys[Math.floor(rnd() * keys.length)], S = SLOTS[slot];
  const v = S.base * RARS[rar].m * (1 + 0.35 * (tier - 1));
  return { id: newId(), slot, rar, tier, name: S.n + ' ' + TIER_N[Math.min(4, tier)], v: S.k === 'hp' ? Math.round(v) : +v.toFixed(3) };
}
function gearStat(a) {
  const o = { hp: 0, def: 0, spd: 0, dmg: 0 };
  for (const id of Object.values(a.eq || {})) { const g = (a.gear || []).find((x) => x.id === id); if (g) o[SLOTS[g.slot].k] += g.v; }
  return o;
}
const mhpOf = (a) => Math.max(40, 100 + (a.lvl - 1) * 10 + raceOf(a).hp + gearStat(a).hp);
const mmpOf = (a) => Math.max(20, 50 + (a.lvl - 1) * 5 + raceOf(a).mp);
const UP_MAX = 5, upOf = (a, k) => (a.up && a.up[k]) || 0;
const upCost = (n) => ({ nucleo: n + 1, silver: 30 * (n + 1) });      // mejorar de +n a +n+1
const baseDmg = (p) => 10 + p.acct.lvl * 2 + raceOf(p.acct).dmg + ((p.acct.inv.espada || 0) > 0 ? 12 + 4 * upOf(p.acct, 'espada') : 0);

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of players.keys()) if (ws.readyState === 1) ws.send(s); }

function addXp(p, n) {
  const a = p.acct; n = Math.round(n * raceOf(a).xp); a.xp += n;
  while (a.xp >= a.lvl * 40) { a.xp -= a.lvl * 40; a.lvl++; p.hp = mhpOf(a); p.mp = mmpOf(a); }
  p.dirty = true;
}
function addItem(a, item, n) { a.inv[item] = (a.inv[item] || 0) + n; if (a.inv[item] <= 0) delete a.inv[item]; }

const fpOf = (a) => { if (!Array.isArray(a.fp)) a.fp = FLIGHT_START.slice(); return a.fp; };
const flightHere = (p) => FLIGHTS.find((f) => f.map === p.map && dist(p, f) < 6 && fpOf(p.acct).includes(f.id));
const flightCost = (from, to) => (from.map !== to.map ? 15 : 3 + Math.round(dist(from, to) / 5));
function enterMap(p, id, x, y) {
  const w = worlds[id]; p.map = id; p.x = x; p.y = y; p.dx = 0; p.dy = 0; p.slowUntil = 0; p.dirty = true;
  send(p.ws, { t: 'init', id: p.id, nm: p.acct.name, map: id, mapName: w.name, biome: w.biome, safe: !!w.safe, W: w.W, H: w.H, recipes: RECIPES, items: ITEMS, pp: POWER_INIT,
    city: w.buildings ? { buildings: w.buildings } : null, npcs: (w.npcs || []).map((n) => ({ id: n.id, name: n.name, title: n.title, x: n.x, y: n.y, look: n.look })), regions: w.regions ? w.regions.map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, name: r.name, biome: r.biome, tier: r.tier })) : null,
    links: (w.links || []).map((l) => ({ side: l.side, min: l.min, max: l.max, to: worlds[l.to].name })), res: w.res.map((r) => ({ id: r.id, t: r.t, x: r.x, y: r.y })) });
}
const spawnIn = () => { const d = MAPDEF.lobby; return [d.spawn[0] + rnd() * 4, d.spawn[1] - 2 + rnd() * 4]; };
function respawn(p) {
  const s = spawnIn(); enterMap(p, 'lobby', s[0], s[1]);
  p.hp = mhpOf(p.acct); p.mp = mmpOf(p.acct); p.dirty = true;
}
// ---------- grupos (hasta 4): comparten experiencia y progreso de misiones de muerte de monstruos ----------
let nextParty = 1;
const partyMates = (p) => (p.party ? p.party.members.filter((m) => m !== p && players.get(m.ws) === m) : []);
function leaveParty(p) {
  const g = p.party; if (!g) return;
  g.members = g.members.filter((m) => m !== p); p.party = null; p.dirty = true;
  for (const m of g.members) { send(m.ws, { t: 'msg', m: p.acct.name + ' dejó el grupo.' }); m.dirty = true; }
  if (g.members.length < 2) for (const m of g.members) { m.party = null; m.dirty = true; send(m.ws, { t: 'msg', m: 'El grupo se disolvió.' }); }
}
function killPlayer(p, killer) {
  const a = p.acct;
  if (!worlds[p.map].safe) {
    const loot = { ...a.inv };
    const silver = Math.floor(a.silver / 2);
    if (Object.keys(loot).length || silver) {
      worlds[p.map].bags.push({ id: newId(), x: p.x, y: p.y, items: loot, silver, owner: a.name, expires: Date.now() + 120000 });
    }
    a.inv = {}; a.silver -= silver;
  }
  p.deaths = (p.deaths || 0) + 1;
  events.push({ w: p.map, t: 'death', x: p.x, y: p.y });
  send(p.ws, { t: 'msg', m: 'Has muerto. Tu inventario quedó en una bolsa: recógela antes de 2 minutos.' });
  if (killer && killer.acct) addXp(killer, 20);
  respawn(p);
}
function hurtPlayer(p, amt, killer) {
  if (p.flight) return;
  if (p.acct.inv.armadura > 0) amt = Math.round(amt * (0.7 - 0.03 * upOf(p.acct, 'armadura')));
  amt = Math.round(amt * (1 - Math.min(0.4, gearStat(p.acct).def)));
  p.hp -= amt; p.dirty = true;
  if (p.mounted) { p.mounted = false; send(p.ws, { t: 'msg', m: '¡Te tiran de la montura!' }); }
  events.push({ w: p.map, t: 'dmg', x: p.x, y: p.y, v: amt });
  if (p.hp <= 0) killPlayer(p, killer);
}
// ---------- misiones: 3 activas por cuenta; al reclamar una sale otra nueva ----------
const QDEF = { kill: { lo: 6, hi: 16, silver: 12, xp: 6 }, wood: { lo: 10, hi: 24, silver: 4, xp: 2 }, stone: { lo: 8, hi: 20, silver: 5, xp: 2 }, ore: { lo: 6, hi: 14, silver: 9, xp: 4 }, boss: { lo: 1, hi: 1, silver: 300, xp: 120 } };
function genQuest(avoid) {
  const keys = Object.keys(QDEF).filter((k) => !avoid.includes(k));
  const k = keys[Math.floor(rnd() * keys.length)], D = QDEF[k], n = D.lo + Math.floor(rnd() * (D.hi - D.lo + 1));
  return { k, n, got: 0, rew: { silver: n * D.silver, xp: n * D.xp, nucleo: k === 'boss' ? 3 : k === 'ore' ? 1 : 0 } };
}
function questsOf(a) {
  if (!Array.isArray(a.quests)) a.quests = [];
  while (a.quests.length < 3) a.quests.push(genQuest(a.quests.map((q) => q.k)));
  return a.quests;
}
function qprog(p, k, n) { for (const q of questsOf(p.acct)) if (q.k === k && q.got < q.n) { q.got = Math.min(q.n, q.got + n); p.dirty = true; } }
function storyKill(p, nm) {
  const ch = STORY.find((c) => c.nm === nm), a = p.acct;
  if (!ch) return;
  a.bossDone = a.bossDone || {};
  if (a.bossDone[nm]) return;
  a.bossDone[nm] = 1; a.silver += ch.rew.silver; addXp(p, ch.rew.xp); addItem(a, 'nucleo', ch.rew.nucleo); p.dirty = true;
  send(p.ws, { t: 'msg', m: '📖 Historia: derrotaste a ' + nm + ' (+' + ch.rew.silver + ' plata, +' + ch.rew.nucleo + ' núcleos)' });
}
function hurtMob(m, amt, killer, crit) {
  if (Date.now() < (killer.ramenUntil || 0)) amt = Math.round(amt * 1.1);
  amt = Math.round(amt * (1 + gearStat(killer.acct).dmg));
  m.hp -= amt;
  events.push({ w: m.w, t: 'dmg', x: m.x, y: m.y, v: amt, c: crit ? 1 : 0 });
  if (m.hp <= 0) {
    const now = Date.now();
    m.alive = false; m.respawn = now + m.rt;
    killer.combo = now < (killer.comboT || 0) ? killer.combo + 1 : 1; killer.comboT = now + 6000;   // racha: +10% por muerte seguida (máx. +100%)
    const bonus = 1 + Math.min(1, (killer.combo - 1) * 0.1);
    const s = Math.round((5 + Math.floor(rnd() * 11)) * m.rew * bonus);
    killer.acct.silver += s; addXp(killer, Math.round(8 * m.rew * bonus)); killer.dirty = true;
    if (rnd() < m.core) addItem(killer.acct, 'nucleo', m.k === 'jef' ? 3 : 1); // los núcleos solo salen de los monstruos fuera de la ciudad
    if (rnd() < (m.k === 'jef' ? 1 : 0.1)) { addItem(killer.acct, 'pocion', 1); send(killer.ws, { t: 'msg', m: 'Soltó una poción' }); }
    for (const q of partyMates(killer)) if (q.map === killer.map && dist(q, killer) < 40) { addXp(q, Math.round(4 * m.rew * bonus)); qprog(q, 'kill', 1); if (m.k === 'jef') qprog(q, 'boss', 1); }
    if (rnd() < (m.k === 'jef' ? 1 : m.k === 'bru' ? 0.12 : 0.06)) {                     // botín de equipo
      const a = killer.acct, g = rollGear(m.tier || 1, m.k === 'jef' ? 2 : 0);
      a.gear = a.gear || [];
      if (a.gear.length >= GEAR_MAX) { a.silver += 10 * (g.rar + 1) * g.tier; send(killer.ws, { t: 'msg', m: 'Bolsa de equipo llena: vendiste ' + g.name + ' (' + RARS[g.rar].n + ')' }); }
      else { a.gear.push(g); send(killer.ws, { t: 'msg', m: 'Botín: ' + g.name + ' (' + RARS[g.rar].n + ')' }); }
    }
    qprog(killer, 'kill', 1); if (m.k === 'jef') qprog(killer, 'boss', 1);
    if (m.k === 'jef') { broadcast({ t: 'msg', m: killer.acct.name + ' derrotó a ' + m.nm + '!' }); storyKill(killer, m.nm); for (const q of partyMates(killer)) if (q.map === killer.map && dist(q, killer) < 40) storyKill(q, m.nm); }
    else if (killer.combo >= 3 && killer.combo % 3 === 0) send(killer.ws, { t: 'msg', m: 'Racha x' + killer.combo + ' (+' + Math.round((bonus - 1) * 100) + '% botín)' });
  }
}
function enemiesNear(p, r) {
  const out = [];
  for (const m of worlds[p.map].mobs) if (m.alive && dist(p, m) <= r) out.push({ kind: 'mob', e: m, d: dist(p, m) });
  // Sin PvP: solo los monstruos son enemigos.
  return out.sort((a, b) => a.d - b.d);
}
function hit(p, target, dmg, crit) {
  if (target.kind === 'mob') hurtMob(target.e, dmg, p, crit); else hurtPlayer(target.e, dmg, p);
}

// ---------- poderes personalizados (las reglas viven en powers.js) ----------
const POWER_INIT = { parts: Pw.PARTS, modMax: Pw.MOD_MAX, modCost: Pw.MOD_COST, max: Pw.MAX_POWERS, forge: Pw.FORGE_COST, pvp: Pw.PVP_MUL, tree: Pw.TREE, refund: Pw.FORJA_REFUND };
const flagsOf = (e, now) => (now < (e.slowUntil || 0) ? 2 : 0);
function powersView(a) { return (a.powers || []).map((c, i) => ({ ...c, i, cost: Pw.powerCost(c), st: Pw.powerStats(c, a.lvl) })); }

function castPower(p, ws, slot, now) {
  const a = p.acct, idx = (a.bar || [])[slot], c = idx == null ? null : (a.powers || [])[idx];
  if (!c) return send(ws, { t: 'msg', m: 'Ese espacio no tiene poder. Equipa uno en Menú > Poderes.' });
  const key = 'p' + idx;
  if (now < (p.cd[key] || 0) || now < (p.cd.pg || 0)) return;
  const st = Pw.powerStats(c, a.lvl);
  if (p.mp < st.mp) return send(ws, { t: 'msg', m: 'Sin energía' });
  const mhp = mhpOf(a), S = Pw.PARTS.src[c.src], E = Pw.PARTS.eff[c.eff], SH = Pw.PARTS.shape[c.shape];
  let targets = [];
  if (c.eff !== 'curar') {
    let near = enemiesNear(p, st.range);
    if (c.shape === 'cono') near = near.filter((t) => { const dx = t.e.x - p.x, dy = t.e.y - p.y, d = Math.hypot(dx, dy) || 1; return d < 0.6 || (dx * p.fx + dy * p.fy) / d >= 0.55; });
    targets = near.slice(0, SH.n);
    if (!targets.length) return send(ws, { t: 'msg', m: 'Sin objetivo a tu alcance' });
  }
  p.mp -= st.mp; p.cd[key] = now + st.cd; p.cd.pg = now + Pw.POWER_GCD;
  if (st.hpcost) p.hp = Math.max(1, p.hp - Math.round(mhp * st.hpcost));
  events.push({ w: p.map, t: 'pw', sh: c.shape, src: c.src, x: p.x, y: p.y, dx: p.fx, dy: p.fy, r: st.range, tg: targets.slice(0, 4).map((t) => [t.e.x, t.e.y]) });
  let dealt = 0;
  for (const t of targets) {
    const e = t.e, isPl = t.kind === 'pl';
    let dmg = st.dmg;
    if (isPl) dmg = Math.min(Math.round(dmg * Pw.PVP_MUL), Math.round(Pw.POWER_DMG_CAP * mhpOf(e.acct)));
    const deaths = e.deaths || 0;
    if (dmg > 0) { if (isPl) hurtPlayer(e, dmg, p); else hurtMob(e, dmg, p); dealt += dmg; }
    if (isPl ? (e.deaths || 0) !== deaths : !e.alive) continue;
    const slowMs = E.slow || (S.slow ? 1500 : 0), slowBy = Math.max(S.slow || 0, E.slow ? 0.4 : 0);
    if (slowMs) { e.slowUntil = Math.max(e.slowUntil || 0, now + slowMs); e.slowMul = 1 - slowBy; }
    const push = Math.min(3.5, (S.push || 0) + (E.push || 0)) * (isPl ? 0.6 : 1);
    if (push) {
      const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1;
      const wd = worlds[p.map], px = clamp(e.x + dx / d * push, 0.5, wd.W - 0.5), py = clamp(e.y + dy / d * push, 0.5, wd.H - 0.5);
      if (!blockedAt(wd, px, py)) { e.x = px; e.y = py; }
    }
  }
  let heal = (E.heal ? st.heal * mhp : 0) + (E.leech ? E.leech * dealt : 0);
  heal = Math.min(Math.round(heal), Math.round(Pw.POWER_HEAL_CAP * mhp));
  if (heal > 0) { p.hp = Math.min(mhp, p.hp + heal); events.push({ w: p.map, t: 'heal', x: p.x, y: p.y, v: heal }); }
  p.dirty = true;
}

// ---------- NPC de la historia (Veyra, Mirei, Orion Vael) ----------
const RANKS = [1, 5, 10, 15, 20, 25, 30];
const rankOf = (a) => (nk(a.name).includes('kaito') ? '∞' : 'FEDCBAS'[RANKS.reduce((r, t, k) => (a.lvl >= t ? k : r), 0)]);
function npcDlg(p, id, opt) {
  const a = p.acct, npc = (MAPDEF.lobby.npcs || []).find((n) => n.id === id);
  if (!npc) return null;
  const D = (text, opts) => ({ t: 'dlg', id, name: npc.name, title: npc.title, text, opts: (opts || []).concat([{ k: 'bye', l: 'Adiós' }]) });
  if (opt === 'bye') return { t: 'dlg', id, close: true };
  if (id === 'veyra') {
    const main = [{ k: 'rank', l: '¿Cuál es mi rango?' }, { k: 'academy', l: '¿Qué es la Gran Academia?' }];
    if (opt === 'rank') {
      if (nk(a.name).includes('kaito')) return D('—Rango: INDETERMINADO. Por primera vez en la historia, la Academia aceptó a un estudiante sin saber qué era. Es usted insoportable... y necesario.', [{ k: 'main', l: 'Volver' }]);
      const next = RANKS.find((t) => t > a.lvl);
      return D('—Su rango actual es ' + rankOf(a) + ' (nivel ' + a.lvl + '). Rango F para los más débiles, Rango S para los legendarios.' + (next ? ' Alcanzará el siguiente rango en el nivel ' + next + '.' : ' Ha alcanzado el rango más alto.'), [{ k: 'main', l: 'Volver' }]);
    }
    if (opt === 'academy') return D('—La Gran Academia de Héroes mide y registra los dones de todo Aurelia. Unos controlan el fuego, otros hablan con las tormentas. Y los libros antiguos mencionan un don que nadie ha visto en trescientos años: la Creación.', [{ k: 'main', l: 'Volver' }]);
    return D('—Silencio, aspirante. Soy la examinadora Veyra. Detecto mentiras, así que sea breve.', main);
  }
  if (id === 'mirei') {
    const main = [{ k: 'heal', l: 'Curarme (gratis)' }, { k: 'ramen', l: 'Ramen con sal (12 🪙)' }, { k: 'kaito', l: '¿Quién es Kaito X?' }];
    if (opt === 'heal') { p.hp = mhpOf(a); p.mp = mmpOf(a); p.dirty = true; return D('—Come algo, estás pálido. (Recuperas toda tu vida y energía.)', [{ k: 'main', l: 'Volver' }]); }
    if (opt === 'ramen') {
      if (a.silver < 12) return D('—Te faltan monedas. Vuelve cuando tengas 12 de plata.', [{ k: 'main', l: 'Volver' }]);
      a.silver -= 12; p.hp = mhpOf(a); p.mp = mmpOf(a); p.ramenUntil = Date.now() + 120000; p.dirty = true;
      return D('—Le puse sal. (Vida y energía al máximo y +10% de daño durante 2 minutos.)', [{ k: 'main', l: 'Volver' }]);
    }
    if (opt === 'kaito') return D('—Kaito X es insoportable, presumido y cree que el mundo gira a su alrededor. Pero es el primero en correr hacia el peligro. Alguien tiene que vigilarlo... y ponerle sal al ramen.', [{ k: 'main', l: 'Volver' }]);
    return D('—Hola. Soy Mirei, rango A, con el don de la luz solidificada. Alguien tiene que cuidar de los novatos y evitar que hagan una locura.', main);
  }
  // Orion Vael
  a.bossDone = a.bossDone || {};
  const back = [{ k: 'main', l: 'Volver' }];
  if (opt === 'rule') return D('—Primera regla de la Creación: crear nunca es gratis. Cada cosa que haces sale de ti: de tu energía, tu memoria y tu vida. Y por favor, deja de crear patos. Los patos se comen las mesas.', back);
  if (opt === 'book') {
    const done = STORY.filter((c) => a.bossDone[c.nm]).length;
    const lines = STORY.map((c) => (a.bossDone[c.nm] ? '✔ ' : '✘ ') + c.nm + ' — ' + c.where + ' (nivel ' + c.lvl + '+)').join('\n');
    const tail = done === STORY.length ? '\n\n—Los grandes villanos han caído. Pero esto no ha terminado: Kaito X regresará en "El Quinto Creador".' : '\n\n—Elige uno para leer lo que anoté sobre él.';
    return D('—En esta libreta escribí todo lo que descubrí. Los Grandes Villanos de Aurelia (' + done + '/' + STORY.length + ' derrotados):\n' + lines + tail, STORY.map((c, i) => ({ k: 'v' + i, l: c.nm })).concat(back));
  }
  if (/^v\d$/.test(opt || '')) {
    const c = STORY[+opt.slice(1)];
    if (c) return D('—' + c.nm + '. ' + c.text + '\n\nLo encontrarás en: ' + c.where + '. Nivel recomendado: ' + c.lvl + '. Recompensa la primera vez: ' + c.rew.silver + ' plata, ' + c.rew.nucleo + ' núcleos y ' + c.rew.xp + ' de experiencia.' + (a.bossDone[c.nm] ? '\n\n(Ya lo derrotaste.)' : ''), [{ k: 'book', l: 'Volver a la libreta' }]);
  }
  return D('—Soy Orion Vael, el último Creador antes que tú. Y tú, muchacho, tienes un problema... o una gran aventura. Elige.', [{ k: 'book', l: 'La libreta de Orion (historia)' }, { k: 'rule', l: 'La primera regla de la Creación' }]);
}

// ---------- mensajes del cliente ----------
const lastChat = new WeakMap();
function handle(ws, p, msg) {
  const now = Date.now();
  if (p.flight && ['in', 'atk', 'sk', 'pcast', 'gather', 'dash', 'mount', 'potion', 'fly'].includes(msg.t)) return;   // volando: solo mirar
  switch (msg.t) {
    case 'in': {
      let dx = +msg.dx || 0, dy = +msg.dy || 0;
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      p.dx = dx; p.dy = dy; p.lastIn = now;
      if (l > 0.1) { p.fx = dx / (l || 1); p.fy = dy / (l || 1); }
      break;
    }
    case 'fly': {
      const a = p.acct, f = FLIGHTS.find((x) => x.id === msg.to);
      if (!f || !fpOf(a).includes(f.id)) return;
      const here = flightHere(p);
      if (!here) return send(ws, { t: 'msg', m: 'Debes estar junto a un Maestro de vuelo.' });
      if (here === f) return;
      const cost = flightCost(here, f), cross = here.map !== f.map;
      if (a.silver < cost) return send(ws, { t: 'msg', m: 'Necesitas ' + cost + ' de plata para ese vuelo.' });
      a.silver -= cost;
      p.flight = { to: f, from: { x: p.x, y: p.y }, t0: now, dur: cross ? 5000 : Math.max(3, Math.min(20, dist(here, f) / 20)) * 1000, cross };
      p.mounted = false; p.dx = 0; p.dy = 0; p.dirty = true;
      send(ws, { t: 'msg', m: 'Vuelas hacia: ' + f.name });
      break;
    }
    case 'talk': case 'talkopt': {
      const npc = (MAPDEF.lobby.npcs || []).find((n) => n.id === msg.id);
      if (!npc || p.map !== 'lobby' || dist(p, npc) > 5) return;
      const d = npcDlg(p, npc.id, msg.t === 'talk' ? 'main' : String(msg.opt || '').slice(0, 8));
      if (d) send(ws, d);
      break;
    }
    case 'mount': {
      if (p.mounted) { p.mounted = false; send(ws, { t: 'msg', m: 'Desmontas.' }); }
      else if (!(p.acct.inv.montura > 0)) send(ws, { t: 'msg', m: 'Necesitas una montura: fabrícala en la Herrería.' });
      else { p.mounted = true; send(ws, { t: 'msg', m: 'Montas: +50% de velocidad (no puedes atacar).' }); }
      p.dirty = true; break;
    }
    case 'atk': {
      if (p.mounted) return send(ws, { t: 'msg', m: 'Desmonta para combatir.' });
      if (now < p.cd.atk) return;
      p.cd.atk = now + 500;
      const t = enemiesNear(p, 2)[0];
      events.push({ w: p.map, t: 'swing', x: p.x, y: p.y, id: p.id });
      if (t) { const crit = rnd() < 0.15; hit(p, t, Math.round(baseDmg(p) * (crit ? 1.8 : 1)), crit); }
      break;
    }
    case 'sk': { // Tajo: área
      if (p.mounted) return send(ws, { t: 'msg', m: 'Desmonta para combatir.' });
      if (now < p.cd.sk || p.mp < 20) return;
      p.cd.sk = now + 3000; p.mp -= 20; p.dirty = true;
      events.push({ w: p.map, t: 'slash', x: p.x, y: p.y });
      for (const t of enemiesNear(p, 2.8)) hit(p, t, baseDmg(p) * 2);
      break;
    }
    case 'dash': {
      if (now < p.cd.dash || p.mp < 15) return;
      p.cd.dash = now + 4000; p.mp -= 15; p.dirty = true;
      for (let i = 0; i < 8; i++) {                       // 8 pasos de medio tile: se detiene ante un edificio
        const wd = worlds[p.map], nx = clamp(p.x + p.fx * 0.5, 0.5, wd.W - 0.5), ny = clamp(p.y + p.fy * 0.5, 0.5, wd.H - 0.5);
        if (blockedAt(wd, nx, ny)) break;
        p.x = nx; p.y = ny;
      }
      break;
    }
    case 'gather': {
      if (now < p.cd.gather) return;
      p.cd.gather = now + 600;
      // 1) bolsa de loot cercana
      const wd = worlds[p.map], bi = wd.bags.findIndex((b) => dist(p, b) < 1.8 && (!b.owner || b.owner === p.acct.name));
      if (bi >= 0) {
        const b = wd.bags.splice(bi, 1)[0];
        for (const k in b.items) addItem(p.acct, k, b.items[k]);
        p.acct.silver += b.silver; p.dirty = true;
        send(ws, { t: 'msg', m: 'Recogiste una bolsa de botín.' });
        return;
      }
      // 2) recurso cercano
      let best = null, bd = 1.9;
      for (const r of wd.res) if (r.alive && dist(p, r) < bd) { best = r; bd = dist(p, r); }
      if (!best) return;
      best.hp--;
      events.push({ w: p.map, t: 'chop', x: best.x, y: best.y });
      if (best.hp <= 0) {
        best.alive = false; best.respawn = now + 30000;
        const item = best.t === 'tree' ? 'wood' : best.t === 'rock' ? 'stone' : 'ore';
        const a = p.acct; a.trades = a.trades || {};
        const tr = a.trades[item] || (a.trades[item] = { lvl: 1, xp: 0 });
        let qty = 1 + Math.floor(rnd() * 2);
        if (rnd() < Math.min(0.5, 0.1 * (tr.lvl - 1))) qty++;
        if (rnd() < raceOf(a).gat) qty++;       // oficio: +10% de rendimiento extra por nivel (máx. 50%)
        addItem(a, item, qty); qprog(p, item === 'wood' ? 'wood' : item === 'stone' ? 'stone' : 'ore', qty);
        tr.xp++;
        if (tr.lvl < 10 && tr.xp >= tr.lvl * 5) { tr.xp -= tr.lvl * 5; tr.lvl++; send(ws, { t: 'msg', m: 'Oficio ' + item + ' sube a nivel ' + tr.lvl }); }
        addXp(p, 2); p.dirty = true;
      }
      break;
    }
    case 'craft': {
      const r = RECIPES[msg.item]; if (!r) return;
      for (const k in r) if ((p.acct.inv[k] || 0) < r[k]) return send(ws, { t: 'msg', m: 'Te faltan materiales.' });
      if ((msg.item === 'espada' || msg.item === 'armadura' || msg.item === 'montura') && p.acct.inv[msg.item] > 0)
        return send(ws, { t: 'msg', m: 'Ya tienes ese equipo.' });
      for (const k in r) addItem(p.acct, k, -r[k]);
      addItem(p.acct, msg.item, 1); addXp(p, 3); p.dirty = true;
      send(ws, { t: 'msg', m: 'Fabricaste: ' + msg.item });
      if (rnd() < Pw.FORJA_REFUND) { for (const k in r) addItem(p.acct, k, r[k]); send(ws, { t: 'msg', m: 'Forja: recuperaste los materiales' }); }
      break;
    }
    case 'potion': {
      if (now < p.cd.pot || !(p.acct.inv.pocion > 0)) return;
      p.cd.pot = now + 1000; addItem(p.acct, 'pocion', -1);
      p.hp = Math.min(mhpOf(p.acct), p.hp + 60); p.dirty = true;
      events.push({ w: p.map, t: 'heal', x: p.x, y: p.y, v: 60 });
      break;
    }
    case 'sell': {
      if (!worlds[p.map].safe) return send(ws, { t: 'msg', m: 'El mercado solo funciona en la ciudad.' });
      const item = msg.item, qty = Math.floor(+msg.qty), price = Math.floor(+msg.price);
      if (!ITEMS.includes(item) || !(qty > 0) || !(price > 0) || price > 1e6) return;
      if ((p.acct.inv[item] || 0) < qty) return send(ws, { t: 'msg', m: 'No tienes suficiente.' });
      addItem(p.acct, item, -qty);
      listings.push({ id: newId(), seller: p.acct.name, item, qty, price });
      p.dirty = true; broadcast({ t: 'market', list: listings });
      break;
    }
    case 'buy': {
      if (!worlds[p.map].safe) return send(ws, { t: 'msg', m: 'El mercado solo funciona en la ciudad.' });
      const i = listings.findIndex((l) => l.id === msg.id); if (i < 0) return;
      const l = listings[i];
      if (p.acct.silver < l.price) return send(ws, { t: 'msg', m: 'No tienes plata suficiente.' });
      listings.splice(i, 1);
      p.acct.silver -= l.price; addItem(p.acct, l.item, l.qty);
      const seller = getAcct(l.seller);
      seller.silver += Math.floor(l.price * 0.95); // 5% de impuesto
      for (const q of players.values()) if (q.acct === seller) q.dirty = true;
      p.dirty = true; broadcast({ t: 'market', list: listings });
      break;
    }
    case 'cancel': {
      const i = listings.findIndex((l) => l.id === msg.id && l.seller === p.acct.name); if (i < 0) return;
      const l = listings.splice(i, 1)[0]; addItem(p.acct, l.item, l.qty);
      p.dirty = true; broadcast({ t: 'market', list: listings });
      break;
    }
    case 'upgrade': {
      const k = msg.item; if (k !== 'espada' && k !== 'armadura') return;
      const a = p.acct, n = upOf(a, k);
      if (!(a.inv[k] > 0)) return send(ws, { t: 'msg', m: 'Primero fabrica ese equipo.' });
      if (n >= UP_MAX) return send(ws, { t: 'msg', m: 'Ya está al máximo.' });
      const c = upCost(n);
      if ((a.inv.nucleo || 0) < c.nucleo || a.silver < c.silver) return send(ws, { t: 'msg', m: `Mejorar cuesta ${c.nucleo} núcleos y ${c.silver} de plata` });
      addItem(a, 'nucleo', -c.nucleo); a.silver -= c.silver;
      if (rnd() < 0.85 - 0.1 * n) { a.up = a.up || {}; a.up[k] = n + 1; send(ws, { t: 'msg', m: '¡' + k + ' mejorada a +' + (n + 1) + '!' }); }
      else send(ws, { t: 'msg', m: 'La mejora falló (se gastaron los materiales).' });
      p.dirty = true;
      break;
    }
    case 'party': {
      if (msg.a === 'inv') {
        const nm = String(msg.name || '').toLowerCase();
        let tg = null; for (const q of players.values()) if (q !== p && q.acct.name.toLowerCase() === nm) tg = q;
        if (!tg) return send(ws, { t: 'msg', m: 'No hay ningún jugador conectado con ese nombre.' });
        if (tg.party) return send(ws, { t: 'msg', m: tg.acct.name + ' ya está en un grupo.' });
        if (p.party && p.party.members.length >= 4) return send(ws, { t: 'msg', m: 'Tu grupo está lleno (máx. 4).' });
        tg.pinv = { from: p, until: now + 30000 };
        send(tg.ws, { t: 'pinv', from: p.acct.name });
        send(ws, { t: 'msg', m: 'Invitaste a ' + tg.acct.name });
      } else if (msg.a === 'acc') {
        const iv = p.pinv; p.pinv = null;
        if (!iv || now > iv.until || players.get(iv.from.ws) !== iv.from) return send(ws, { t: 'msg', m: 'La invitación expiró.' });
        if (p.party) return;
        if (!iv.from.party) iv.from.party = { id: nextParty++, members: [iv.from] };
        const g = iv.from.party;
        if (g.members.length >= 4) return send(ws, { t: 'msg', m: 'El grupo está lleno.' });
        g.members.push(p); p.party = g;
        for (const m of g.members) { m.dirty = true; if (m !== p) send(m.ws, { t: 'msg', m: p.acct.name + ' se unió al grupo.' }); }
      } else if (msg.a === 'leave') leaveParty(p);
      break;
    }
    case 'equip': {
      const a = p.acct, id = Math.floor(+msg.id), g = (a.gear || []).find((x) => x.id === id);
      if (!g) return;
      a.eq = a.eq || {}; a.eq[g.slot] = id; p.hp = Math.min(p.hp, mhpOf(a)); p.dirty = true;
      break;
    }
    case 'unequip': {
      const a = p.acct; if (!a.eq || !hasOwn(SLOTS, msg.slot)) return;
      delete a.eq[msg.slot]; p.hp = Math.min(p.hp, mhpOf(a)); p.dirty = true;
      break;
    }
    case 'scrap': {
      const a = p.acct, id = Math.floor(+msg.id), i = (a.gear || []).findIndex((x) => x.id === id);
      if (i < 0) return;
      const g = a.gear.splice(i, 1)[0];
      for (const k in a.eq || {}) if (a.eq[k] === id) delete a.eq[k];
      a.silver += 10 * (g.rar + 1) * g.tier; p.hp = Math.min(p.hp, mhpOf(a)); p.dirty = true;
      break;
    }
    case 'qclaim': {
      const qs = questsOf(p.acct), i = Math.floor(+msg.i), q = qs[i];
      if (!q || q.got < q.n) return;
      p.acct.silver += q.rew.silver; addXp(p, q.rew.xp); if (q.rew.nucleo) addItem(p.acct, 'nucleo', q.rew.nucleo);
      qs[i] = genQuest(qs.map((x) => x.k));
      send(ws, { t: 'msg', m: 'Misión cumplida: +' + q.rew.silver + ' plata' }); p.dirty = true;
      break;
    }
    case 'pprev': {
      if (now - (p.lastPrev || 0) < 100) return; p.lastPrev = now;
      const c = Pw.cleanPower(msg.def);
      if (!c) return send(ws, { t: 'pprev', r: { ok: false, err: 'Poder inválido' } });
      const cost = Pw.powerCost(c), budget = Pw.powerBudget(p.acct.lvl);
      send(ws, { t: 'pprev', r: { ok: cost <= budget, err: cost > budget ? 'Te pasas del presupuesto de puntos' : '', cost, budget, st: Pw.powerStats(c, p.acct.lvl) } });
      break;
    }
    case 'pcreate': {
      const a = p.acct, c = Pw.cleanPower(msg.def);
      if (!c) return send(ws, { t: 'msg', m: 'Poder inválido' });
      a.powers = a.powers || [];
      if (a.powers.length >= Pw.MAX_POWERS) return send(ws, { t: 'msg', m: 'Ya tienes el máximo de poderes. Borra alguno.' });
      if (Pw.powerCost(c) > Pw.powerBudget(a.lvl)) return send(ws, { t: 'msg', m: 'Te pasas del presupuesto de puntos' });
      const F = Pw.FORGE_COST;
      if ((a.inv.nucleo || 0) < F.nucleo || a.silver < F.silver) return send(ws, { t: 'msg', m: `Forjar cuesta ${F.nucleo} núcleo y ${F.silver} de plata` });
      addItem(a, 'nucleo', -F.nucleo); a.silver -= F.silver;
      if (!c.name) c.name = Pw.defaultPowerName(c);
      a.powers.push(c);
      a.bar = a.bar || [null, null, null];
      const free = a.bar.indexOf(null); if (free >= 0) a.bar[free] = a.powers.length - 1;
      p.dirty = true; send(ws, { t: 'msg', m: 'Forjaste: ' + c.name });
      break;
    }
    case 'pdel': {
      const a = p.acct, i = Math.floor(+msg.i);
      if (!a.powers || !a.powers[i]) return;
      a.powers.splice(i, 1);
      a.bar = (a.bar || [null, null, null]).map((b) => (b === i ? null : b != null && b > i ? b - 1 : b));
      p.dirty = true;
      break;
    }
    case 'pbar': {
      const a = p.acct, slot = Math.floor(+msg.slot), i = msg.i == null ? null : Math.floor(+msg.i);
      if (!(slot >= 0 && slot < 3)) return;
      if (i !== null && !(a.powers && a.powers[i])) return;
      a.bar = a.bar || [null, null, null];
      if (i !== null) a.bar = a.bar.map((b) => (b === i ? null : b));
      a.bar[slot] = i; p.dirty = true;
      break;
    }
    case 'pcast': {
      const slot = Math.floor(+msg.slot);
      if (p.mounted) return send(ws, { t: 'msg', m: 'Desmonta para combatir.' });
      if (slot >= 0 && slot < 3) castPower(p, ws, slot, now);
      break;
    }
    case 'chat': {
      if (now - (lastChat.get(ws) || 0) < 700) return;
      lastChat.set(ws, now);
      const m = String(msg.m || '').slice(0, 100).trim(); if (!m) return;
      broadcast({ t: 'chat', n: p.acct.name, m });
      break;
    }
  }
}

// ---------- sesión: inicio de sesión, creación de personaje y entrada al mundo ----------
const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 12);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const charsOf = (l) => { if (!Array.isArray(l.chars)) l.chars = l.char ? [l.name] : []; return l.chars.filter((n) => hasOwn(accounts, n) && accounts[n].char); };
const lookOf = (r) => [r.char.power, r.char.aura, r.char.tone, r.char.cloth, r.char.race || 'humano'];
function resetRec(r) { for (const k of Object.keys(r)) if (!['name', 'salt', 'hash', 'chars'].includes(k)) delete r[k]; Object.assign(r, { inv: {}, silver: 20, xp: 0, lvl: 1 }); }
function makeSession(ws) {
  let p = null, login = null, fails = 0;
  const err = (m) => send(ws, { t: 'err', m });
  const auth = (created) => send(ws, { t: 'auth', name: login.name, pp: POWER_INIT, max: MAX_CHARS, created: created || null,
    races: Object.fromEntries(Object.entries(RACES).map(([k, r]) => [k, { name: r.name, ico: r.ico, desc: r.desc }])),
    chars: charsOf(login).map((n) => ({ name: n, lvl: accounts[n].lvl, look: lookOf(accounts[n]) })) });
  const run = (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (p) return handle(ws, p, msg);
    if (msg.t === 'login' || msg.t === 'register') {
      const name = cleanName(msg.name), pass = String(msg.pass || '');
      if (name.length < 3) return err('El nombre debe tener entre 3 y 12 letras o números');
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') return err('Nombre no permitido');
      if (pass.length < 4 || pass.length > 40) return err('La contraseña debe tener al menos 4 caracteres');
      const ex = hasOwn(accounts, name) ? accounts[name] : null;
      if (msg.t === 'register') {
        if (ex || Object.keys(accounts).some((k) => nk(k) === nk(name))) return err('Ese nombre ya existe. Usa Entrar.');
        if (reservedName(name, name)) return err('Ese nombre está reservado. Elige otro.');
        login = getAcct(name); login.salt = newSalt(); login.hash = hashPass(pass, login.salt); save();
      } else {
        if (!ex || ex.owner) return err('Esa cuenta no existe. Usa Crear cuenta.');
        if (!ex.hash) { ex.salt = newSalt(); ex.hash = hashPass(pass, ex.salt); save(); }   // cuenta antigua sin contraseña: la primera que pongas queda guardada
        else if (hashPass(pass, ex.salt) !== ex.hash) { if (++fails >= 8) ws.close(); return err('Contraseña incorrecta'); }
        login = getAcct(name);
      }
      return auth();
    }
    if (!login) return;
    if (msg.t === 'create') {
      const list = charsOf(login);
      if (list.length >= MAX_CHARS) return err('Ya tienes el máximo de personajes');
      const cname = cleanName(msg.name), power = String(msg.power || ''), race = String(msg.race || 'humano');
      if (cname.length < 3) return err('El nombre del personaje debe tener entre 3 y 12 letras o números');
      if (['__proto__', 'constructor', 'prototype'].includes(cname)) return err('Nombre no permitido');
      if (!hasOwn(Pw.PARTS.src, power)) return err('Elige un poder');
      if (!hasOwn(RACES, race)) return err('Elige una raza');
      const reuse = cname === login.name && !login.char && !list.length;   // el primer personaje puede llevar el nombre de la cuenta
      if (reservedName(cname, login.name)) return err('Ese nombre está reservado. Elige otro.');
      if (Object.keys(accounts).some((k) => nk(k) === nk(cname) && !(reuse && k === login.name))) return err('Ese nombre de personaje ya está en uso');
      const rec = reuse ? login : getAcct(cname);
      if (!reuse) rec.owner = login.name;
      rec.char = { power, race, aura: msg.aura ? 1 : 0, tone: Math.max(0, Math.min(3, Math.floor(+msg.tone) || 0)), cloth: Math.max(0, Math.min(4, Math.floor(+msg.cloth) || 0)) };
      const c = Pw.cleanPower({ src: power, shape: 'proyectil', eff: 'dano', mods: {} });   // el poder elegido es tu primer poder, gratis y equipado
      c.name = Pw.defaultPowerName(c); rec.powers = [c]; rec.bar = [0, null, null];
      login.chars = list.concat(cname);
      save(); return auth(cname);
    }
    if (msg.t === 'delchar') {
      const cname = String(msg.name || ''), list = charsOf(login);
      if (!list.includes(cname)) return;
      if (accounts[cname] === login) resetRec(login); else delete accounts[cname];
      login.chars = list.filter((n) => n !== cname);
      save(); return auth();
    }
    if (msg.t === 'join') {
      const cname = String(msg.name || '');
      if (!charsOf(login).includes(cname)) return;
      const acct = accounts[cname];
      for (const [ows, op] of players) if (op.acct === acct) { send(ows, { t: 'err', m: 'Sesión iniciada en otro lugar' }); players.delete(ows); ows.close(); }
      const s = spawnIn();
      p = { ws, id: newId(), acct, map: 'lobby', x: s[0], y: s[1], hp: mhpOf(acct), mp: mmpOf(acct), dx: 0, dy: 0, fx: 1, fy: 0,
        lastIn: Date.now(), cd: { atk: 0, sk: 0, dash: 0, gather: 0, pot: 0 }, dirty: true };
      players.set(ws, p);
      enterMap(p, 'lobby', s[0], s[1]);
      send(ws, { t: 'market', list: listings });
    }
  };
  return (raw) => { try { return run(raw); } catch (e) { console.error('msg', e); } };
}

// ---------- red ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let f = req.url.split('?')[0]; if (f === '/') f = '/index.html';
  const full = path.join(__dirname, 'public', path.normalize(f).replace(/^(\.\.[\/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (e, d) => {
    if (e) { res.writeHead(404); return res.end('no encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on('connection', (ws) => {
  ws.on('message', makeSession(ws));
  ws.on('close', () => players.delete(ws));
});

// ---------- bucle principal ----------
let tickN = 0, last = Date.now(), nextInvasion = Date.now() + 180000;
function tick() {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; tickN++;

  for (const p of players.values()) {
    if (p.flight) {   // en vuelo: posición interpolada, sin daño ni control
      const F = p.flight, k = Math.min(1, (now - F.t0) / F.dur);
      if (!F.cross) { p.x = F.from.x + (F.to.x - F.from.x) * k; p.y = F.from.y + (F.to.y - F.from.y) * k; }
      if (k >= 1) { p.flight = null; if (F.cross) enterMap(p, F.to.map, F.to.x, F.to.y); else { p.x = F.to.x; p.y = F.to.y; } p.dirty = true; send(p.ws, { t: 'msg', m: 'Llegaste a: ' + F.to.name }); }
      continue;
    }
    for (const f of FLIGHTS) if (f.map === p.map && dist(p, f) < 6) {
      const fp = fpOf(p.acct);
      if (!fp.includes(f.id)) { fp.push(f.id); p.dirty = true; send(p.ws, { t: 'msg', m: '✈ Descubriste un punto de vuelo: ' + f.name }); }
    }
    if (now - p.lastIn > 1000) { p.dx = 0; p.dy = 0; }
    const wd = worlds[p.map], sp = SPEED * raceOf(p.acct).spd * (1 + gearStat(p.acct).spd) * (p.mounted && p.acct.inv.montura > 0 ? 1.5 : 1) * (now < (p.slowUntil || 0) ? (p.slowMul || 0.6) : 1);
    const nx = clamp(p.x + p.dx * sp * dt, 0.5, wd.W - 0.5);
    if (!blockedAt(wd, nx, p.y)) p.x = nx;
    const ny = clamp(p.y + p.dy * sp * dt, 0.5, wd.H - 0.5);
    if (!blockedAt(wd, p.x, ny)) p.y = ny;
    if (p.combo && now > p.comboT) { p.combo = 0; p.dirty = true; }
    const mh = mhpOf(p.acct), mm = mmpOf(p.acct);
    if (p.hp < mh) p.hp = Math.min(mh, p.hp + 1 * dt);
    if (p.mp < mm) p.mp = Math.min(mm, p.mp + 3 * dt);
    // borde del mapa: pasas al mapa vecino
    for (const l of wd.links || []) {
      const along = l.side === 'e' || l.side === 'w' ? p.y : p.x, len = l.side === 'e' || l.side === 'w' ? wd.H : wd.W;
      const hit = l.side === 'e' ? p.x >= wd.W - 0.8 : l.side === 'w' ? p.x <= 0.8 : l.side === 's' ? p.y >= wd.H - 0.8 : p.y <= 0.8;
      if (!hit || (l.min != null && (along < l.min || along > l.max))) continue;
      const dst = worlds[l.to], back = (dst.links || []).find((q) => q.side === OPP[l.side] && q.to === wd.id) || {};
      const dl = l.side === 'e' || l.side === 'w' ? dst.H : dst.W;
      let a = along / len * dl;
      if (back.min != null) a = clamp(a, back.min + 1, back.max - 1);
      a = clamp(a, 2, dl - 2);
      const off = 2.5, o = OPP[l.side];   // llegas por el lado opuesto
      const tx = o === 'w' ? off : o === 'e' ? dst.W - off : a, ty = o === 'n' ? off : o === 's' ? dst.H - off : a;
      enterMap(p, l.to, tx, ty);
      send(p.ws, { t: 'msg', m: 'Entras a: ' + dst.name });
      break;
    }
  }

  const byMap = {};
  for (const p of players.values()) (byMap[p.map] = byMap[p.map] || []).push(p);
  // Invasión: cada 5-8 minutos una horda aparece alrededor de los jugadores de la zona de la muerte (botín x2,5, desaparece a los 4 min)
  if (now >= nextInvasion) {
    nextInvasion = now + 300000 + rnd() * 180000;
    const hereI = byMap.muerte || [], d = MAPDEF.muerte;
    if (hereI.length) {
      const c = hereI[Math.floor(rnd() * hereI.length)], w = worlds.muerte;
      for (let i = 0; i < 12; i++) {
        const k = rnd() < 0.5 ? 'rap' : rnd() < 0.7 ? 'nor' : 'bru', K = KINDS[k], hp = Math.round(d.hp * K.hp);
        const a = rnd() * 6.28, r = 9 + rnd() * 5, x = clamp(c.x + Math.cos(a) * r, 2, w.W - 2), y = clamp(c.y + Math.sin(a) * r, 2, w.H - 2);
        w.mobs.push({ id: newId(), w: 'muerte', k, sp: K.sp * 1.1, ag: 14, x, y, hx: x, hy: y, hp, mhp: hp, dmg: Math.round(d.dmg * K.dmg), rew: d.rew * K.rew * 2.5, core: d.core, rt: 0, tmp: true, exp: now + 240000, alive: true, respawn: 0, cd: 0 });
      }
      for (const q of hereI) send(q.ws, { t: 'msg', m: '¡Invasión! Una horda ataca la Zona de la muerte.' });
    }
  }
  for (const id in worlds) {
    const w = worlds[id], here = byMap[id] || [];
    for (const m of w.mobs) {
      if (m.tmp && (!m.alive || now > m.exp)) { m.gone = true; continue; }
      if (!m.alive) { if (now >= m.respawn) { m.sc = 0; m.alive = true; m.hp = m.mhp; m.x = m.hx; m.y = m.hy; m.slowUntil = 0; } continue; }
      const mf = now < (m.slowUntil || 0) ? (m.slowMul || 0.6) : 1;
      let target = null, td = m.ag;
      for (const p of here) { if (p.map !== id || p.flight) continue; const d = dist(m, p); if (d < td) { td = d; target = p; } }
      if (target && dist(m, { x: m.hx, y: m.hy }) < (m.k === 'jef' ? 22 : m.tmp ? 40 : 14)) {
        if (m.k === 'jef' && td < 3.2 && now >= m.sc) {   // pisotón del jefe: daño en área
          m.sc = now + 5000; events.push({ w: id, t: 'slash', x: m.x, y: m.y });
          for (const q of here.slice()) if (q.map === id && dist(m, q) < 3.2) hurtPlayer(q, Math.round(m.dmg * 1.5), null);
        } else if (td > 1.2 + (m.k === 'jef' ? 0.6 : 0)) { m.x += ((target.x - m.x) / td) * m.sp * mf * dt; m.y += ((target.y - m.y) / td) * m.sp * mf * dt; }
        else if (now >= m.cd) { m.cd = now + 1000; hurtPlayer(target, m.dmg, null); }
      } else {
        const hd = dist(m, { x: m.hx, y: m.hy });
        if (hd > 0.5) { m.x += ((m.hx - m.x) / hd) * 2 * mf * dt; m.y += ((m.hy - m.y) / hd) * 2 * mf * dt; }
      }
    }
    if (w.mobs.some((m) => m.gone)) w.mobs = w.mobs.filter((m) => !m.gone);
    for (const r of w.res) if (!r.alive && now >= r.respawn) { r.alive = true; r.hp = r.t === 'ore' ? 4 : 3; }
    for (let i = w.bags.length - 1; i >= 0; i--) if (now > w.bags[i].expires) w.bags.splice(i, 1);
  }

  if (tickN % 2 === 0 && players.size) { // 10 Hz
    const evs = {};
    for (const e of events) (evs[e.w] = evs[e.w] || []).push(e);
    events = [];
    const AOI = 45, near = (e, p) => Math.abs(e.x - p.x) <= AOI && Math.abs(e.y - p.y) <= AOI;   // área de interés de cada jugador
    const pv = (p) => ({ id: p.id, n: p.acct.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), hp: Math.round(p.hp), mh: mhpOf(p.acct), l: p.acct.lvl, sw: p.acct.inv.espada > 0 ? 1 : 0, fl: flagsOf(p, now) | (p.mounted ? 4 : 0) | (p.flight ? 8 : 0), pt: p.party ? p.party.id : 0, lk: p.acct.char ? [p.acct.char.power, p.acct.char.aura, p.acct.char.tone, p.acct.char.cloth, p.acct.char.race || 'humano'] : null });
    for (const k in byMap) delete byMap[k];   // la gente pudo cambiar de mapa (muerte, bordes) durante este tick
    for (const q of players.values()) (byMap[q.map] = byMap[q.map] || []).push(q);
    const snaps = {};
    for (const id in byMap) {
      const w = worlds[id];
      snaps[id] = { p: byMap[id].map(pv), m: w.mobs.filter((m) => m.alive).map((m) => ({ id: m.id, k: m.k, nm: m.nm, x: +m.x.toFixed(2), y: +m.y.toFixed(2), hp: m.hp, mh: m.mhp, fl: flagsOf(m, now) })),
        d: w.res.filter((r) => !r.alive).map((r) => ({ id: r.id, x: r.x, y: r.y })), b: w.bags.map((b) => ({ id: b.id, x: b.x, y: b.y })), e: evs[id] || [] };
    }
    for (const [ws, p] of players) {
      const sn = snaps[p.map];
      send(ws, { t: 's', p: sn.p.filter((q) => near(q, p)), m: sn.m.filter((q) => near(q, p)), d: sn.d.filter((q) => near(q, p)).map((q) => q.id),
        b: sn.b.filter((q) => near(q, p)), e: sn.e.filter((q) => near(q, p)) });
    }
    for (const [ws, p] of players) {
      if (p.dirty) {
        p.dirty = false;
        send(ws, { t: 'me', inv: p.acct.inv, silver: p.acct.silver, xp: p.acct.xp, lvl: p.acct.lvl,
          hp: Math.round(p.hp), mh: mhpOf(p.acct), mp: Math.round(p.mp), mm: mmpOf(p.acct), nx: p.acct.lvl * 40,
          tr: p.acct.trades || {}, pw: powersView(p.acct), bar: p.acct.bar || [null, null, null], pb: Pw.powerBudget(p.acct.lvl), cb: p.combo || 0, qs: questsOf(p.acct), up: p.acct.up || {}, rk: rankOf(p.acct), fv: p.flight ? p.flight.to.name : null, fly: { near: !!flightHere(p) && !p.flight, list: FLIGHTS.filter((f) => fpOf(p.acct).includes(f.id)).map((f) => ({ id: f.id, name: f.name, mapName: worlds[f.map].name, cost: flightCost(p, f), here: f.map === p.map && dist(p, f) < 6 })) }, gear: p.acct.gear || [], eq: p.acct.eq || {}, gst: gearStat(p.acct), gmax: GEAR_MAX, mt: p.mounted ? 1 : 0, pty: partyMates(p).map((m) => ({ n: m.acct.name, hp: Math.round(m.hp), mh: mhpOf(m.acct), l: m.acct.lvl })), upm: UP_MAX, upc: [0, 1, 2, 3, 4].map(upCost) });
      }
    }
  }
  // mp/hp cambian de forma continua: refrescar 'me' cada 1s
  if (tickN % 20 === 0) for (const p of players.values()) p.dirty = true;
}
setInterval(() => { try { tick(); } catch (e) { console.error('tick', e); } }, TICK);   // un fallo en un tick no tumba el servidor

server.listen(PORT, () => console.log('MMORPG en http://localhost:' + PORT));
