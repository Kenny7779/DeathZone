# Regenera public/sprites/*.png y public/sprites.js a partir de la hoja de Faye.
# Uso: python3 tools/make-sprites.py ruta/a/la_hoja.jpg
import sys, os, base64, json, glob
from PIL import Image
import numpy as np
SRC = sys.argv[1]; root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
im = Image.open(SRC).convert('RGB')
def shift(m, k, fn):
    out = m.copy()
    for dy in range(-k, k+1):
        for dx in range(-k, k+1): out = fn(out, np.roll(np.roll(m, dy, 0), dx, 1))
    return out
def keep(img):
    x = np.asarray(img).astype(int); mx = x.max(-1); mn = x.min(-1)
    paper = (mn > 185) | (((mx - mn) < 25) & (mx > 150))
    cand = (~paper).astype(np.uint8)
    op = shift(shift(cand, 1, np.minimum), 1, np.maximum)
    op = shift(shift(op, 1, np.maximum), 1, np.minimum) * op
    return Image.fromarray(np.dstack([x.astype(np.uint8), (op * 255).astype(np.uint8)]), 'RGBA')
boxes = {'idle_front': (33, 628, 172, 735), 'idle_back': (262, 628, 366, 735)}
for i, x in enumerate([33, 195, 344, 493]):
    boxes[f'walk_down_{i}'] = (x, 237, x + 140, 385); boxes[f'walk_up_{i}'] = (x, 58, x + 140, 205)
os.makedirs(os.path.join(root, 'public', 'sprites'), exist_ok=True)
for k, b in boxes.items():
    s = keep(im.crop(b)); bb = s.getbbox(); s = s.crop(bb) if bb else s
    h = 110; s.resize((int(s.width * h / s.height), h), Image.NEAREST).save(os.path.join(root, 'public', 'sprites', k + '.png'))
out = {os.path.basename(f)[:-4]: 'data:image/png;base64,' + base64.b64encode(open(f, 'rb').read()).decode()
       for f in sorted(glob.glob(os.path.join(root, 'public', 'sprites', '*.png')))}
open(os.path.join(root, 'public', 'sprites.js'), 'w').write('// Sprites de Faye la guerrera. Generado por tools/make-sprites.py\nwindow.SPRITES = ' + json.dumps(out) + ';\n')
print('listo', len(out), 'sprites')
