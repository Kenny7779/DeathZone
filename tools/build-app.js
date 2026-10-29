// Prepara la carpeta www/ que empaqueta Capacitor dentro del APK:
//   index.html  menú (jugar online / jugar solo)
//   online.html el juego con servidor (usa la URL de app.config.json o la variable SERVER_URL)
//   solo.html   el juego sin conexión (servidor dentro de la página)
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..'), www = path.join(root, 'www'), pub = path.join(root, 'public');

cp.execFileSync(process.execPath, [path.join(__dirname, 'build-offline.js')], { stdio: 'inherit' });

let url = (process.env.SERVER_URL || '').trim();
if (!url) { try { url = (JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8')).serverUrl || '').trim(); } catch (e) {} }
url = url.replace(/\/+$/, '').replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
if (url && !/^wss?:\/\//.test(url)) url = 'wss://' + url;

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
fs.copyFileSync(path.join(pub, 'index.html'), path.join(www, 'online.html'));
fs.copyFileSync(path.join(pub, 'offline.html'), path.join(www, 'solo.html'));
fs.writeFileSync(path.join(www, 'config.js'), 'window.SERVER_URL = ' + JSON.stringify(url) + ';\n');
fs.writeFileSync(path.join(www, 'index.html'), `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>DeathZone</title>
<script src="config.js"></script>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%;background:#10141a;color:#e8ecf1;font-family:system-ui,sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));text-align:center}
  img{width:96px;height:96px;border-radius:22px}
  h1{margin:0;font-size:32px;letter-spacing:2px}
  p{margin:0;max-width:300px;font-size:14px;opacity:.75;line-height:1.4}
  a.btn{display:block;width:260px;padding:14px;border-radius:12px;background:#a11d1d;color:#fff;text-decoration:none;font-size:18px;border:1px solid #d44}
  a.btn.alt{background:#2b3a52;border-color:#4a5d7c}
  a.off{opacity:.45;pointer-events:none}
  small{opacity:.6;font-size:12px;max-width:300px}
</style>
</head>
<body>
  <img src="icon.png" alt="">
  <h1>DEATHZONE</h1>
  <p>Recolecta, fabrica y comercia en la ciudad segura. Cruza a la zona de la muerte y arriesga todo.</p>
  <a id="online" class="btn" href="online.html">Jugar online</a>
  <a class="btn alt" href="solo.html">Jugar solo (sin conexión)</a>
  <small id="note"></small>
<script>
  if (!window.SERVER_URL) {
    document.getElementById('online').classList.add('off');
    document.getElementById('note').textContent = 'El modo online se activa cuando la app tiene la dirección del servidor.';
  }
</script>
</body>
</html>
`);
fs.copyFileSync(path.join(pub, 'icons', 'icon-512.png'), path.join(www, 'icon.png'));
fs.copyFileSync(path.join(pub, 'sprites.js'), path.join(www, 'sprites.js'));
console.log('www listo. Servidor:', url || '(sin configurar: solo modo sin conexión)');
