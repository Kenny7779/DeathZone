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
const W = 100, H = 100;      // tamaño del mundo en tiles
const SAFE_X = 30;           // x < SAFE_X = ciudad segura; x >= SAFE_X = zona de la muerte (monstruos; si mueres pierdes el inventario en una bolsa que solo recoges tú)
const TICK = 50;             // 20 Hz
const SPEED = 4.5;           // tiles/seg
// La ciudad (lobby): zona segura donde apareces. Los edificios abren su menú al acercarte.
const CITY = { x0: 5, x1: 27, y0: 34, y1: 66, buildings: [
  { id: 'herreria', name: 'Herrería', x: 10, y: 40, w: 4, d: 3, h: 46, roof: '#b5651d', tab: 'craft' },
  { id: 'mercado',  name: 'Mercado',  x: 10, y: 56, w: 4, d: 3, h: 40, roof: '#2f8f8f', tab: 'market' },
  { id: 'torre',    name: 'Torre de poderes', x: 18, y: 45, w: 3, d: 3, h: 84, roof: '#7a4bd1', tab: 'powers' },
  { id: 'salon',    name: 'Salón de habilidades', x: 18, y: 56, w: 3, d: 3, h: 52, roof: '#3f7fe0', tab: 'tree' },
  { id: 'puerta',   name: 'Puerta de la zona de la muerte', x: 27.6, y: 46, w: 1.4, d: 8, h: 70, roof: '#7a1f1f', tab: null, solid: false },
] };
const inCity = (x, y) => x >= CITY.x0 && x <= CITY.x1 && y >= CITY.y0 && y <= CITY.y1;
// Colisiones: los edificios son sólidos (la puerta se puede cruzar). El jugador mide 0,4 tiles de radio.
const R_PLAYER = 0.4;
const blockedAt = (x, y) => CITY.buildings.some((b) => b.solid !== false && x > b.x - R_PLAYER && x < b.x + b.w + R_PLAYER && y > b.y - R_PLAYER && y < b.y + b.d + R_PLAYER);
const DATA_FILE = path.join(__dirname, 'data.json');

const RECIPES = {
  espada:   { wood: 4, ore: 3 },     // +12 de daño
  armadura: { stone: 6, ore: 2 },    // -30% daño recibido
  pocion:   { wood: 3, stone: 1 },   // cura 60 HP
};
const ITEMS = ['wood', 'stone', 'ore', 'nucleo', 'espada', 'armadura', 'pocion'];

// ---------- utilidades ----------
let seed = 1337;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const inRed = (x) => x >= SAFE_X;
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
const resources = [];
function spawnRes(type, n, minX, maxX) {
  for (let i = 0; i < n; i++) {
    const x = minX + rnd() * (maxX - minX), y = 2 + rnd() * (H - 4);
    if (inCity(x, y)) continue;                       // la ciudad no tiene árboles ni rocas
    resources.push({
      id: newId(), t: type, x, y,
      hp: type === 'ore' ? 4 : 3, alive: true, respawn: 0,
    });
  }
}
spawnRes('tree', 110, 3, W - 2);
spawnRes('rock', 70, 3, W - 2);
spawnRes('ore', 60, SAFE_X + 3, W - 2);

const mobs = [];
for (let i = 0; i < 28; i++) {
  const x = SAFE_X + 8 + rnd() * (W - SAFE_X - 12), y = 4 + rnd() * (H - 8);
  mobs.push({ id: newId(), x, y, hx: x, hy: y, hp: 60, mhp: 60, alive: true, respawn: 0, cd: 0 });
}
const bags = []; // bolsas de loot {id,x,y,items,silver,expires}
const players = new Map(); // ws -> player
let events = [];

const spawnPoint = () => ({ x: 8 + rnd() * 4, y: 48 + rnd() * 4 });

// ---------- jugador ----------
const mhpOf = (a) => 100 + (a.lvl - 1) * 10;
const mmpOf = (a) => 50 + (a.lvl - 1) * 5;
const baseDmg = (p) => 10 + p.acct.lvl * 2 + ((p.acct.inv.espada || 0) > 0 ? 12 : 0);

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of players.keys()) if (ws.readyState === 1) ws.send(s); }

function addXp(p, n) {
  const a = p.acct; a.xp += n;
  while (a.xp >= a.lvl * 40) { a.xp -= a.lvl * 40; a.lvl++; p.hp = mhpOf(a); p.mp = mmpOf(a); }
  p.dirty = true;
}
function addItem(a, item, n) { a.inv[item] = (a.inv[item] || 0) + n; if (a.inv[item] <= 0) delete a.inv[item]; }

function respawn(p) {
  const s = spawnPoint(); p.x = s.x; p.y = s.y; p.slowUntil = 0;
  p.hp = mhpOf(p.acct); p.mp = mmpOf(p.acct); p.dirty = true;
}
function killPlayer(p, killer) {
  const a = p.acct;
  if (inRed(p.x)) {
    const loot = { ...a.inv };
    const silver = Math.floor(a.silver / 2);
    if (Object.keys(loot).length || silver) {
      bags.push({ id: newId(), x: p.x, y: p.y, items: loot, silver, owner: a.name, expires: Date.now() + 120000 });
    }
    a.inv = {}; a.silver -= silver;
  }
  p.deaths = (p.deaths || 0) + 1;
  events.push({ t: 'death', x: p.x, y: p.y });
  send(p.ws, { t: 'msg', m: 'Has muerto. Tu inventario quedó en una bolsa: recógela antes de 2 minutos.' });
  if (killer && killer.acct) addXp(killer, 20);
  respawn(p);
}
function hurtPlayer(p, amt, killer) {
  if (p.acct.inv.armadura > 0) amt = Math.round(amt * 0.7);
  p.hp -= amt; p.dirty = true;
  events.push({ t: 'dmg', x: p.x, y: p.y, v: amt });
  if (p.hp <= 0) killPlayer(p, killer);
}
function hurtMob(m, amt, killer) {
  m.hp -= amt;
  events.push({ t: 'dmg', x: m.x, y: m.y, v: amt });
  if (m.hp <= 0) {
    m.alive = false; m.respawn = Date.now() + 15000;
    const s = 5 + Math.floor(rnd() * 11);
    killer.acct.silver += s; addXp(killer, 8); killer.dirty = true;
    if (rnd() < 0.3) addItem(killer.acct, 'nucleo', 1); // los núcleos solo salen de los monstruos de la zona de la muerte
  }
}
function enemiesNear(p, r) {
  const out = [];
  for (const m of mobs) if (m.alive && dist(p, m) <= r) out.push({ kind: 'mob', e: m, d: dist(p, m) });
  // Sin PvP: solo los monstruos son enemigos.
  return out.sort((a, b) => a.d - b.d);
}
function hit(p, target, dmg) {
  if (target.kind === 'mob') hurtMob(target.e, dmg, p); else hurtPlayer(target.e, dmg, p);
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
  events.push({ t: 'pw', sh: c.shape, src: c.src, x: p.x, y: p.y, dx: p.fx, dy: p.fy, r: st.range, tg: targets.slice(0, 4).map((t) => [t.e.x, t.e.y]) });
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
      const px = clamp(e.x + dx / d * push, 0.5, W - 0.5), py = clamp(e.y + dy / d * push, 0.5, H - 0.5);
      if (!blockedAt(px, py)) { e.x = px; e.y = py; }
    }
  }
  let heal = (E.heal ? st.heal * mhp : 0) + (E.leech ? E.leech * dealt : 0);
  heal = Math.min(Math.round(heal), Math.round(Pw.POWER_HEAL_CAP * mhp));
  if (heal > 0) { p.hp = Math.min(mhp, p.hp + heal); events.push({ t: 'heal', x: p.x, y: p.y, v: heal }); }
  p.dirty = true;
}

// ---------- mensajes del cliente ----------
const lastChat = new WeakMap();
function handle(ws, p, msg) {
  const now = Date.now();
  switch (msg.t) {
    case 'in': {
      let dx = +msg.dx || 0, dy = +msg.dy || 0;
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      p.dx = dx; p.dy = dy; p.lastIn = now;
      if (l > 0.1) { p.fx = dx / (l || 1); p.fy = dy / (l || 1); }
      break;
    }
    case 'atk': {
      if (now < p.cd.atk) return;
      p.cd.atk = now + 500;
      const t = enemiesNear(p, 2)[0];
      events.push({ t: 'swing', x: p.x, y: p.y, id: p.id });
      if (t) hit(p, t, baseDmg(p));
      break;
    }
    case 'sk': { // Tajo: área
      if (now < p.cd.sk || p.mp < 20) return;
      p.cd.sk = now + 3000; p.mp -= 20; p.dirty = true;
      events.push({ t: 'slash', x: p.x, y: p.y });
      for (const t of enemiesNear(p, 2.8)) hit(p, t, baseDmg(p) * 2);
      break;
    }
    case 'dash': {
      if (now < p.cd.dash || p.mp < 15) return;
      p.cd.dash = now + 4000; p.mp -= 15; p.dirty = true;
      for (let i = 0; i < 8; i++) {                       // 8 pasos de medio tile: se detiene ante un edificio
        const nx = clamp(p.x + p.fx * 0.5, 0.5, W - 0.5), ny = clamp(p.y + p.fy * 0.5, 0.5, H - 0.5);
        if (blockedAt(nx, ny)) break;
        p.x = nx; p.y = ny;
      }
      break;
    }
    case 'gather': {
      if (now < p.cd.gather) return;
      p.cd.gather = now + 600;
      // 1) bolsa de loot cercana
      const bi = bags.findIndex((b) => dist(p, b) < 1.8 && (!b.owner || b.owner === p.acct.name));
      if (bi >= 0) {
        const b = bags.splice(bi, 1)[0];
        for (const k in b.items) addItem(p.acct, k, b.items[k]);
        p.acct.silver += b.silver; p.dirty = true;
        send(ws, { t: 'msg', m: 'Recogiste una bolsa de botín.' });
        return;
      }
      // 2) recurso cercano
      let best = null, bd = 1.9;
      for (const r of resources) if (r.alive && dist(p, r) < bd) { best = r; bd = dist(p, r); }
      if (!best) return;
      best.hp--;
      events.push({ t: 'chop', x: best.x, y: best.y });
      if (best.hp <= 0) {
        best.alive = false; best.respawn = now + 30000;
        const item = best.t === 'tree' ? 'wood' : best.t === 'rock' ? 'stone' : 'ore';
        const a = p.acct; a.trades = a.trades || {};
        const tr = a.trades[item] || (a.trades[item] = { lvl: 1, xp: 0 });
        let qty = 1 + Math.floor(rnd() * 2);
        if (rnd() < Math.min(0.5, 0.1 * (tr.lvl - 1))) qty++;       // oficio: +10% de rendimiento extra por nivel (máx. 50%)
        addItem(a, item, qty);
        tr.xp++;
        if (tr.lvl < 10 && tr.xp >= tr.lvl * 5) { tr.xp -= tr.lvl * 5; tr.lvl++; send(ws, { t: 'msg', m: 'Oficio ' + item + ' sube a nivel ' + tr.lvl }); }
        addXp(p, 2); p.dirty = true;
      }
      break;
    }
    case 'craft': {
      const r = RECIPES[msg.item]; if (!r) return;
      for (const k in r) if ((p.acct.inv[k] || 0) < r[k]) return send(ws, { t: 'msg', m: 'Te faltan materiales.' });
      if ((msg.item === 'espada' || msg.item === 'armadura') && p.acct.inv[msg.item] > 0)
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
      events.push({ t: 'heal', x: p.x, y: p.y, v: 60 });
      break;
    }
    case 'sell': {
      if (inRed(p.x)) return send(ws, { t: 'msg', m: 'El mercado solo funciona en la ciudad segura.' });
      const item = msg.item, qty = Math.floor(+msg.qty), price = Math.floor(+msg.price);
      if (!ITEMS.includes(item) || !(qty > 0) || !(price > 0) || price > 1e6) return;
      if ((p.acct.inv[item] || 0) < qty) return send(ws, { t: 'msg', m: 'No tienes suficiente.' });
      addItem(p.acct, item, -qty);
      listings.push({ id: newId(), seller: p.acct.name, item, qty, price });
      p.dirty = true; broadcast({ t: 'market', list: listings });
      break;
    }
    case 'buy': {
      if (inRed(p.x)) return send(ws, { t: 'msg', m: 'El mercado solo funciona en la ciudad segura.' });
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
function makeSession(ws) {
  let p = null, acct = null, fails = 0;
  const err = (m) => send(ws, { t: 'err', m });
  const auth = () => send(ws, { t: 'auth', name: acct.name, hasChar: !!acct.char, look: acct.char || null, pp: POWER_INIT });
  return (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (p) return handle(ws, p, msg);
    if (msg.t === 'login' || msg.t === 'register') {
      const name = cleanName(msg.name), pass = String(msg.pass || '');
      if (name.length < 3) return err('El nombre debe tener entre 3 y 12 letras o números');
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') return err('Nombre no permitido');
      if (pass.length < 4 || pass.length > 40) return err('La contraseña debe tener al menos 4 caracteres');
      const ex = hasOwn(accounts, name) ? accounts[name] : null;
      if (msg.t === 'register') {
        if (ex) return err('Ese nombre ya existe. Usa Entrar.');
        acct = getAcct(name); acct.salt = newSalt(); acct.hash = hashPass(pass, acct.salt); save();
      } else {
        if (!ex) return err('Esa cuenta no existe. Usa Crear cuenta.');
        if (!ex.hash) { ex.salt = newSalt(); ex.hash = hashPass(pass, ex.salt); save(); }   // cuenta antigua sin contraseña: la primera que pongas queda guardada
        else if (hashPass(pass, ex.salt) !== ex.hash) { if (++fails >= 8) ws.close(); return err('Contraseña incorrecta'); }
        acct = getAcct(name);
      }
      return auth();
    }
    if (!acct) return;
    if (msg.t === 'create') {
      if (acct.char) return;
      const power = String(msg.power || '');
      if (!hasOwn(Pw.PARTS.src, power)) return err('Elige un poder');
      acct.char = { power, aura: msg.aura ? 1 : 0, tone: Math.max(0, Math.min(3, Math.floor(+msg.tone) || 0)), cloth: Math.max(0, Math.min(4, Math.floor(+msg.cloth) || 0)) };
      if (!(acct.powers && acct.powers.length)) {          // el poder elegido es tu primer poder, gratis y equipado
        const c = Pw.cleanPower({ src: power, shape: 'proyectil', eff: 'dano', mods: {} });
        c.name = Pw.defaultPowerName(c); acct.powers = [c]; acct.bar = [0, null, null];
      }
      save(); return auth();
    }
    if (msg.t === 'join') {
      if (!acct.char) return;
      for (const [ows, op] of players) if (op.acct === acct) { send(ows, { t: 'err', m: 'Sesión iniciada en otro lugar' }); players.delete(ows); ows.close(); }
      const s = spawnPoint();
      p = { ws, id: newId(), acct, x: s.x, y: s.y, hp: mhpOf(acct), mp: mmpOf(acct), dx: 0, dy: 0, fx: 1, fy: 0,
        lastIn: Date.now(), cd: { atk: 0, sk: 0, dash: 0, gather: 0, pot: 0 }, dirty: true };
      players.set(ws, p);
      send(ws, { t: 'init', id: p.id, W, H, SAFE_X, recipes: RECIPES, items: ITEMS, pp: POWER_INIT, city: CITY,
        res: resources.map((r) => ({ id: r.id, t: r.t, x: r.x, y: r.y })) });
      send(ws, { t: 'market', list: listings });
    }
  };
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
let tickN = 0, last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; tickN++;

  for (const p of players.values()) {
    if (now - p.lastIn > 1000) { p.dx = 0; p.dy = 0; }
    const sp = SPEED * (now < (p.slowUntil || 0) ? (p.slowMul || 0.6) : 1);
    const nx = clamp(p.x + p.dx * sp * dt, 0.5, W - 0.5);
    if (!blockedAt(nx, p.y)) p.x = nx;
    const ny = clamp(p.y + p.dy * sp * dt, 0.5, H - 0.5);
    if (!blockedAt(p.x, ny)) p.y = ny;
    const mh = mhpOf(p.acct), mm = mmpOf(p.acct);
    if (p.hp < mh) p.hp = Math.min(mh, p.hp + 1 * dt);
    if (p.mp < mm) p.mp = Math.min(mm, p.mp + 3 * dt);
  }

  for (const m of mobs) {
    if (!m.alive) { if (now >= m.respawn) { m.alive = true; m.hp = m.mhp; m.x = m.hx; m.y = m.hy; m.slowUntil = 0; } continue; }
    const mf = now < (m.slowUntil || 0) ? (m.slowMul || 0.6) : 1;
    let target = null, td = 7;
    for (const p of players.values()) { const d = dist(m, p); if (d < td && inRed(p.x)) { td = d; target = p; } }
    if (target && dist(m, { x: m.hx, y: m.hy }) < 14) {
      if (td > 1.2) { m.x += ((target.x - m.x) / td) * 3 * mf * dt; m.y += ((target.y - m.y) / td) * 3 * mf * dt; }
      else if (now >= m.cd) { m.cd = now + 1000; hurtPlayer(target, 8, null); }
    } else {
      const hd = dist(m, { x: m.hx, y: m.hy });
      if (hd > 0.5) { m.x += ((m.hx - m.x) / hd) * 2 * mf * dt; m.y += ((m.hy - m.y) / hd) * 2 * mf * dt; }
    }
  }

  for (const r of resources) if (!r.alive && now >= r.respawn) { r.alive = true; r.hp = r.t === 'ore' ? 4 : 3; }
  for (let i = bags.length - 1; i >= 0; i--) if (now > bags[i].expires) bags.splice(i, 1);

  if (tickN % 2 === 0 && players.size) { // 10 Hz
    const snap = {
      t: 's',
      p: [...players.values()].map((p) => ({ id: p.id, n: p.acct.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), hp: Math.round(p.hp), mh: mhpOf(p.acct), l: p.acct.lvl, sw: p.acct.inv.espada > 0 ? 1 : 0, fl: flagsOf(p, now), lk: p.acct.char ? [p.acct.char.power, p.acct.char.aura, p.acct.char.tone, p.acct.char.cloth] : null })),
      m: mobs.filter((m) => m.alive).map((m) => ({ id: m.id, x: +m.x.toFixed(2), y: +m.y.toFixed(2), hp: m.hp, mh: m.mhp, fl: flagsOf(m, now) })),
      d: resources.filter((r) => !r.alive).map((r) => r.id),
      b: bags.map((b) => ({ id: b.id, x: b.x, y: b.y })),
      e: events,
    };
    events = [];
    broadcast(snap);
    for (const [ws, p] of players) {
      if (p.dirty) {
        p.dirty = false;
        send(ws, { t: 'me', inv: p.acct.inv, silver: p.acct.silver, xp: p.acct.xp, lvl: p.acct.lvl,
          hp: Math.round(p.hp), mh: mhpOf(p.acct), mp: Math.round(p.mp), mm: mmpOf(p.acct), nx: p.acct.lvl * 40,
          tr: p.acct.trades || {}, pw: powersView(p.acct), bar: p.acct.bar || [null, null, null], pb: Pw.powerBudget(p.acct.lvl) });
      }
    }
  }
  // mp/hp cambian de forma continua: refrescar 'me' cada 1s
  if (tickN % 20 === 0) for (const p of players.values()) p.dirty = true;
}, TICK);

server.listen(PORT, () => console.log('MMORPG en http://localhost:' + PORT));
