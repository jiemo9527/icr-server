"""网易易盾滑块（嵌入式）：对比本地识别的拖动距离与实际需要的距离。
每轮：抓取大图/拼图块（原图）→ 调本地 /slider（与客户端相同的输入）→ 按客户端公式算距离；
同时记录元素几何（大图 320x160 原图尺寸、拼图块 img 尺寸与 left、把手位置），
再用 Playwright 真实鼠标按「距离」拖动并读取易盾 check 结果，把拖动后拼图块 left 与缺口位置对照。
用法：yidun_slider_probe.py [rounds] [extra_px]  extra_px 用于对照补偿（默认 0）"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64
import json
import os
import random
import sys
from pathlib import Path

import cv2
import numpy as np
import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 4
EXTRA = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
LOCAL = os.environ.get('ICR_URL', 'http://127.0.0.1:8899')
OUT = ROOT / 'reports/private/yidun/slider'
OUT.mkdir(parents=True, exist_ok=True)

GEOM = r'''() => {
  const vis = e => e && e.getBoundingClientRect().width > 2;
  const bg = [...document.querySelectorAll('.yidun_bg-img')].find(vis);
  const pc = [...document.querySelectorAll('.yidun_jigsaw')].find(vis);
  const hd = [...document.querySelectorAll('.yidun_slider')].find(vis);
  const r = e => { const b = e.getBoundingClientRect(); return {x:b.left, y:b.top, w:b.width, h:b.height}; };
  return { bg: r(bg), bgNat: [bg.naturalWidth, bg.naturalHeight], bgSrc: bg.src,
           pc: r(pc), pcNat: [pc.naturalWidth, pc.naturalHeight], pcSrc: pc.src, pcLeft: getComputedStyle(pc).left,
           hd: r(hd) };
}'''


def fetch(url):
    return requests.get(url, timeout=20).content


def b64(raw, mime):
    return f'data:{mime};base64,' + base64.b64encode(raw).decode()


with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    checks = []
    pg.on('response', lambda r: checks.append(r) if 'c.dun.163.com/api/' in r.url and '/check' in r.url else None)
    pg.goto('https://dun.163.com/trial/jigsaw', wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(4000)
    pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click()
    pg.wait_for_timeout(5000)
    for rnd in range(1, ROUNDS + 1):
        g = pg.evaluate(GEOM)
        bg_raw, pc_raw = fetch(g['bgSrc']), fetch(g['pcSrc'])
        (OUT / f'{rnd:02d}-bg.jpg').write_bytes(bg_raw)
        (OUT / f'{rnd:02d}-piece.png').write_bytes(pc_raw)
        r = requests.post(LOCAL + '/slider', json={'bg': b64(bg_raw, 'image/jpeg'), 'piece': b64(pc_raw, 'image/png')}, timeout=30).json()
        row = {'round': rnd, 'bgNat': g['bgNat'], 'bgCss': [g['bg']['w'], g['bg']['h']], 'pcNat': g['pcNat'],
               'pcCss': [round(g['pc']['w'], 1), round(g['pc']['h'], 1)], 'pcLeftCss': g['pcLeft'],
               'resp': {k: r.get(k) for k in ('ok', 'gap_left', 'gap_width', 'piece_offset_left', 'piece_width', 'width', 'method', 'score', 'margin', 'msg')}}
        if r.get('ok'):
            scale = g['bg']['w'] / r['width']
            target = g['bg']['x'] + r['gap_left'] * scale
            current = g['pc']['x'] + r['piece_offset_left'] * g['pc']['w'] / r['piece_width']
            dist = target - current + EXTRA
            row.update(target=round(target, 1), current=round(current, 1), dist=round(dist, 1))
            # 用真实鼠标按距离拖动把手
            hx = g['hd']['x'] + g['hd']['w'] / 2; hy = g['hd']['y'] + g['hd']['h'] / 2
            c0 = len(checks)
            pg.mouse.move(hx, hy); pg.mouse.down()
            n = 30
            for i in range(1, n + 1):
                t = i / n; e = 1 - (1 - t) ** 3
                pg.mouse.move(hx + dist * e, hy + random.uniform(-1, 1)); pg.wait_for_timeout(random.randint(12, 25))
            pg.wait_for_timeout(150)
            moved = pg.evaluate(GEOM)
            pg.mouse.up()
            row['pieceMoved'] = round(moved['pc']['x'] - g['pc']['x'], 1)
            row['handleMoved'] = round(moved['hd']['x'] - g['hd']['x'], 1)
            pg.wait_for_timeout(2500)
            res = []
            for c in checks[c0:]:
                try: t = c.text(); res.append('pass' if '"result":true' in t else 'fail')
                except Exception: res.append('?')
            row['check'] = res
        print(json.dumps(row, ensure_ascii=False), flush=True)
        ref = pg.locator('.yidun_refresh').filter(visible=True)
        if ref.count(): ref.first.click()
        pg.wait_for_timeout(3500)
    b.close()
