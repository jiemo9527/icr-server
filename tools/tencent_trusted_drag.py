"""对照实验：腾讯滑块用本地服务识别缺口，再用 Playwright 可信鼠标（isTrusted=true）拖动。

用来区分 errorCode 12 是“位置/识别错误”还是“合成事件轨迹被风控”。不注入油猴脚本。
"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64
import json
import os
from pathlib import Path
import random
import socket
import subprocess
import sys
import time

import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 4
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]
server = subprocess.Popen([sys.executable, str(ROOT / 'icr_server.py')], cwd=ROOT,
                          env={**os.environ, 'ICR_HOST': '127.0.0.1', 'ICR_PORT': str(PORT), 'ICR_TOKEN': ''},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
GRAB = '''async () => {
  const vis=e=>e&&e.getBoundingClientRect().width>2&&getComputedStyle(e).display!=='none';
  const bgEl=document.querySelector('.tencent-captcha-dy__verify-bg-img');
  const piece=[...document.querySelectorAll('.tencent-captcha-dy__fg-item')].find(vis);
  const handle=document.querySelector('.tencent-captcha-dy__slider-block');
  const url=e=>(getComputedStyle(e).backgroundImage.match(/url\\(["']?(.*?)["']?\\)/)||[])[1];
  const toData=async u=>{const b=await (await fetch(u)).blob();return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(b);});};
  const bgUrl=url(bgEl), pUrl=url(piece);
  const im=await new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src=pUrl;});
  const st=getComputedStyle(piece), pr=piece.getBoundingClientRect(), br=bgEl.getBoundingClientRect(), hr=handle.getBoundingClientRect();
  const [sw,sh]=st.backgroundSize.split(' ').map(parseFloat);const k=im.naturalWidth/sw;
  const px=-parseFloat(st.backgroundPositionX)*k, py=-parseFloat(st.backgroundPositionY)*k;
  return {bg:await toData(bgUrl),piece:await toData(pUrl),crop:[Math.round(px),Math.round(py),Math.round(pr.width*k),Math.round(pr.height*k)],
          pieceLeft:pr.left,bgLeft:br.left,bgWidth:br.width,handle:{x:hr.left+hr.width/2,y:hr.top+hr.height/2}};
}'''
results = []
try:
    for _ in range(120):
        try: requests.get(f'http://127.0.0.1:{PORT}/health', timeout=1).raise_for_status(); break
        except requests.RequestException: time.sleep(.25)
    with sync_playwright() as p:
        b = p.chromium.launch(**launch_kwargs(), headless=True)
        pg = b.new_page(viewport={'width': 1400, 'height': 1000})
        codes = []
        pg.on('response', lambda r: codes.append(r) if 'cap_union_new_verify' in r.url else None)
        pg.goto('https://cloud.tencent.com/product/captcha', wait_until='domcontentloaded', timeout=40000)
        for _ in range(100):
            pg.wait_for_timeout(200)
            try:
                if pg.evaluate('Boolean(document.querySelector("#captcha_click")?.onclick)'): break
            except Exception: pg.wait_for_timeout(400)
        for rnd in range(1, ROUNDS + 1):
            before = len(codes)
            pg.locator('#captcha_click').click(); pg.wait_for_timeout(5000)
            g = pg.evaluate(GRAB)
            r = requests.post(f'http://127.0.0.1:{PORT}/slider', json={'bg': g['bg'], 'piece': g['piece'], 'piece_crop': g['crop']}, timeout=30).json()
            row = {'round': rnd, 'ok': r.get('ok'), 'method': r.get('method')}
            if r.get('ok'):
                k = g['bgWidth'] / r['width']
                dist = g['bgLeft'] + r['gap_left'] * k - (g['pieceLeft'] + r['piece_offset_left'] * k)
                hx, hy = g['handle']['x'], g['handle']['y']
                pg.mouse.move(hx, hy); pg.mouse.down(); pg.wait_for_timeout(random.randint(120, 260))
                steps = random.randint(22, 34)
                for i in range(1, steps + 1):
                    t = i / steps; ease = 1 - (1 - t) ** 3
                    pg.mouse.move(hx + dist * ease, hy + random.uniform(-1.5, 1.5)); pg.wait_for_timeout(random.randint(12, 30))
                pg.wait_for_timeout(random.randint(80, 200)); pg.mouse.up()
                row['dist'] = round(dist, 1)
            pg.wait_for_timeout(3500)
            vals = []
            for c in codes[before:]:
                try: vals.append(str(c.json().get('errorCode')))
                except Exception: vals.append('?')
            row['verify'] = vals
            results.append(row); print(json.dumps(row), flush=True)
            try:
                if pg.locator('.tencent-captcha-dy__verify-bg-img').is_visible():
                    pg.keyboard.press('Escape'); pg.wait_for_timeout(800)
                    for c in pg.locator('[class*="header-close"]').all():
                        if c.is_visible(): c.click(timeout=1000)
            except Exception: pass
            pg.wait_for_timeout(int(os.environ.get('ROUND_GAP_MS', '6000')))
        b.close()
finally:
    server.terminate(); server.wait(timeout=15)
print('SUMMARY', json.dumps({'rounds': len(results), 'recognized': sum(bool(r['ok']) for r in results), 'passed': sum('0' in r['verify'] for r in results)}))
