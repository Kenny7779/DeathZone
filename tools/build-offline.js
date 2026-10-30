// Genera public/offline.html: el mismo juego, con el "servidor" corriendo dentro de la página (un jugador, sin internet).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
let html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const cut = (a, b) => { const i = srv.indexOf(a), j = srv.indexOf(b); if (i < 0 || j < 0) throw new Error('marca no encontrada: ' + a + ' / ' + b); return srv.slice(i, j); };
const consts = cut('const W = ', 'const DATA_FILE').replace(/^/, '');
const rest1 = cut('const RECIPES', '// ---------- cuentas');
const util = cut('// ---------- utilidades', '// ---------- cuentas');
const world = cut('// ---------- mundo ----------', '// ---------- red ----------');
const powersSrc = fs.readFileSync(path.join(root, 'powers.js'), 'utf8');
const loop = cut('// ---------- bucle principal ----------', 'server.listen');

const local = `
(function(){
const Pw = (function(){ const module = { exports: {} };
${powersSrc}
return module.exports; })();
${consts}
const store = { get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch(e){} } };
let accounts = {}, listings = [];
try { const d = JSON.parse(store.get('rp_offline_data') || '{}'); accounts = d.accounts || {}; listings = d.listings || []; nextId = d.nextId || 1; } catch(e){}
function save(){ store.set('rp_offline_data', JSON.stringify({ accounts, listings, nextId })); }
setInterval(save, 10000);
addEventListener('pagehide', save);
function getAcct(name){ if (!accounts[name]) accounts[name] = { name, inv: {}, silver: 20, xp: 0, lvl: 1 }; const a = accounts[name];
  if (!a.starter) { a.starter = true; a.inv.nucleo = (a.inv.nucleo || 0) + 1; } return a; }
${rest1}
${world}
function newSalt(){ return String(Math.random()).slice(2, 12); }
function hashPass(p, salt){ let h = 5381; const t = salt + p; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); }
${loop}
window.WebSocket = function(){
  const c = { readyState: 0, onopen: null, onclose: null, onmessage: null };
  const s = { readyState: 1, send(d){ setTimeout(() => c.onmessage && c.onmessage({ data: d }), 0); },
    close(){ c.readyState = 3; c.onclose && c.onclose(); } };
  const handler = makeSession(s);
  c.send = (raw) => handler(raw);
  c.close = () => { players.delete(s); };
  setTimeout(() => { c.readyState = 1; c.onopen && c.onopen(); }, 0);
  return c;
};
})();
`;
// extraer title, style, cuerpo
const title = '<title>Reinos de Plata</title>';
const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
let body = html.match(/<body>([\s\S]*)<\/body>/)[1];
body = body.replace('<script>', '<script>' + local + '</script>\n<script>');
body = body.replace("localStorage.setItem('rp_name', n);", "try{localStorage.setItem('rp_name', n);}catch(e){}")
           .replace("document.getElementById('name').value = localStorage.getItem('rp_name') || '';", "try{document.getElementById('name').value = localStorage.getItem('rp_name') || '';}catch(e){}")
           .replace('Recolecta, fabrica, comercia y sobrevive en la zona de la muerte.', 'Recolecta, fabrica, comercia y sobrevive en la zona de la muerte. (Modo sin conexión: juegas tú solo y se guarda en este dispositivo.)');
const out = title + '\n' + style + '\n' + body;
fs.writeFileSync(path.join(root, 'public', 'offline.html'), out);
console.log('offline.html', out.length, 'bytes');
