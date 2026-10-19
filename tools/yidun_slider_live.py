"""网易易盾滑块（嵌入式）：用客户端脚本（GM 桥接，真实本地服务）跑「本地」或「大模型模拟」路线，
测量松手前拼图块的位置和缺口的误差。缺口的参考位置由离线遮罩模板匹配得到（同一行、去掉白描边），
只作为测量参照，不等同于易盾的判定；易盾对自动化浏览器有风控，check 结果仅记录。
用法：yidun_slider_live.py [rounds] [local|llm]"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 4
MODE = sys.argv[2] if len(sys.argv) > 2 else 'local'
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]
server = subprocess.Popen([sys.executable, str(ROOT / 'icr_server.py')], cwd=ROOT,
                          env={**os.environ, 'ICR_HOST': '127.0.0.1', 'ICR_PORT': str(PORT), 'ICR_TOKEN': ''},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
RULE = {'id': 's', 'type': 'slider', 'img': 'div.yidun_panel', 'handle': 'div.yidun_slider', 'piece': 'img[alt="验证码滑块"]',
        'backend': 'local' if MODE == 'local' else 'llm'}
STORE = {'icrh_config_v1': {'localUrl': f'http://127.0.0.1:{PORT}', 'apiKey': 'probe', 'apiUrl': 'http://llm.probe/v1/chat/completions'},
         'icrh_site_rules_v2': {'dun.163.com': [RULE]}}
SHIM = '''(()=>{const store=STORE;window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=o=>window.__xhr(JSON.stringify({url:o.url,method:o.method,data:o.data,headers:o.headers,rt:o.responseType})).then(r=>{
 if(r.error){o.onerror?.(r);return;}
 if(r.b64){const a=Uint8Array.from(atob(r.b64),c=>c.charCodeAt(0));r.response=o.responseType==='blob'?new Blob([a],{type:r.type}):a.buffer;}
 o.onload(r);});
// 记录松手瞬间拼图块位置
document.addEventListener('mouseup',()=>{const p=[...document.querySelectorAll('.yidun_jigsaw')].find(e=>e.getBoundingClientRect().width>2);
 if(p)window.__release=p.getBoundingClientRect().left;},true);})();'''.replace('STORE', json.dumps(STORE))
truth = {}


def ref_gap(bg_raw, pc_raw):
    bg = cv2.imdecode(np.frombuffer(bg_raw, np.uint8), cv2.IMREAD_COLOR)
    pc = cv2.imdecode(np.frombuffer(pc_raw, np.uint8), cv2.IMREAD_UNCHANGED)
    a = pc[:, :, 3]; ys, xs = np.where(a > 127); y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    m = cv2.erode((a[y0:y1, x0:x1] > 200).astype(np.uint8), np.ones((5, 5), np.uint8))
    sc = np.nan_to_num(cv2.matchTemplate(bg[y0:y1], pc[y0:y1, x0:x1, :3], cv2.TM_CCOEFF_NORMED, mask=m * 255)[0], nan=-1)
    best = int(sc.argmax()); s2 = sc.copy(); s2[max(0, best - 15):best + 16] = -1
    return best, int(x0), float(sc.max()), float(sc.max() - s2.max())


def xhr(payload):
    d = json.loads(payload)
    if d['url'].startswith('http://llm.probe'):
        # 模拟「大模型」：返回参考缺口中心比例（代表一个准确的大模型）
        t = truth.get('cur')
        content = json.dumps({'x_ratio': (t['gap'] + t['w'] / 2) / 320}) if t else 'UNKNOWN'
        return {'status': 200, 'responseText': json.dumps({'choices': [{'message': {'content': content}}]})}
    try:
        r = requests.request(d['method'], d['url'], data=d.get('data'), headers=d.get('headers'), timeout=60)
    except Exception as e:
        return {'error': type(e).__name__}
    if d['url'].endswith('/slider'):
        truth['resp'] = r.json()
    out = {'status': r.status_code, 'responseText': '' if d.get('rt') else r.text}
    if d.get('rt') in ('blob', 'arraybuffer'):
        out.update(b64=base64.b64encode(r.content).decode(), type=r.headers.get('content-type', 'image/png'))
    return out


try:
    for _ in range(120):
        try: requests.get(f'http://127.0.0.1:{PORT}/health', timeout=1).raise_for_status(); break
        except requests.RequestException: time.sleep(.25)
    with sync_playwright() as p:
        b = p.chromium.launch(**launch_kwargs(), headless=True)
        pg = b.new_page(viewport={'width': 1400, 'height': 1000})
        pg.expose_function('__xhr', xhr)
        pg.add_init_script(SHIM + '\n' + SOURCE)
        pg.goto('https://dun.163.com/trial/jigsaw', wait_until='domcontentloaded', timeout=40000)
        pg.wait_for_timeout(4000)
        pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click(); pg.wait_for_timeout(5000)
        for rnd in range(1, ROUNDS + 1):
            g = pg.evaluate('''()=>{const v=e=>e.getBoundingClientRect().width>2;const bg=[...document.querySelectorAll('.yidun_bg-img')].find(v),
              pc=[...document.querySelectorAll('.yidun_jigsaw')].find(v);return {bgX:bg.getBoundingClientRect().left,bgSrc:bg.src,pcX:pc.getBoundingClientRect().left,pcSrc:pc.src}}''')
            gap, x0, score, margin = ref_gap(requests.get(g['bgSrc'], timeout=20).content, requests.get(g['pcSrc'], timeout=20).content)
            truth['cur'] = {'gap': gap, 'w': 54}
            truth.pop('resp', None)
            pg.evaluate('window.__release=null')
            btn = pg.locator('#icrh-fab [data-icrh-target]')
            toast = ''
            if btn.count():
                btn.first.click()
                for _ in range(60):
                    pg.wait_for_timeout(250)
                    toast = pg.evaluate("[...document.querySelectorAll('#icrh-toast-box div')].map(d=>d.textContent).slice(-1)[0]||''")
                    if '完成' in toast or '失败' in toast: break
            rel = pg.evaluate('window.__release')
            row = {'round': rnd, 'mode': MODE, 'refGap': gap, 'refScore': round(score, 2), 'refMargin': round(margin, 2),
                   'server': {k: (truth.get('resp') or {}).get(k) for k in ('ok', 'gap_left', 'method', 'msg')},
                   'toast': toast[:70]}
            if rel is not None:
                row['pieceVisibleLeftAtRelease'] = round(rel - g['bgX'] + x0, 1)
                row['errorPx'] = round(rel - g['bgX'] + x0 - gap, 1)
            print(json.dumps(row, ensure_ascii=False), flush=True)
            pg.wait_for_timeout(2500)
            ref = pg.locator('.yidun_refresh').filter(visible=True)
            if ref.count(): ref.first.click()
            pg.wait_for_timeout(3500)
        b.close()
finally:
    server.terminate(); server.wait(timeout=15)
