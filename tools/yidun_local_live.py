"""易盾嵌入式点选实测（第 1-2 步验证）：设规则 → 点悬浮按钮 → 本地识别，检查发给服务的图是否为可见区域，
保存请求图片供目视核对，不提交（嵌入式点满即自动校验，记录 check 结果但不据此下结论）。
用法：yidun_local_live.py [word|icon] [rounds]"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import cv2
import numpy as np
import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
KIND = sys.argv[1] if len(sys.argv) > 1 else 'word'
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
PATH = {'word': 'picture-click', 'icon': 'icon-click'}[KIND]
OUT = ROOT / f'reports/private/yidun/live-{KIND}'
OUT.mkdir(parents=True, exist_ok=True)
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]
server = subprocess.Popen([sys.executable, str(ROOT / 'icr_server.py')], cwd=ROOT,
                          env={**os.environ, 'ICR_HOST': '127.0.0.1', 'ICR_PORT': str(PORT), 'ICR_TOKEN': ''},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
RULE = {'id': 'y', 'type': 'click', 'img': '.yidun_bg-img', 'hint': '.yidun_tips__content' if KIND == 'word' else '.yidun_tips__answer'}
STORE = {'icrh_config_v1': {'localUrl': f'http://127.0.0.1:{PORT}', 'backend': 'local', 'clickDelayMin': 500, 'clickDelayMax': 800},
         'icrh_site_rules_v2': {'dun.163.com': [RULE]}}
SHIM = '''(()=>{const store=STORE;window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=o=>window.__xhr(JSON.stringify({url:o.url,method:o.method,data:o.data,headers:o.headers,rt:o.responseType})).then(r=>{
 if(r.error){o.onerror?.(r);return;}
 if(r.b64){const a=Uint8Array.from(atob(r.b64),c=>c.charCodeAt(0));r.response=o.responseType==='blob'?new Blob([a],{type:r.type}):a.buffer;}
 o.onload(r);});})();'''.replace('STORE', json.dumps(STORE))
sent = []


def xhr(payload):
    d = json.loads(payload)
    local = d['url'].startswith(f'http://127.0.0.1:{PORT}')
    try:
        r = requests.request(d['method'], d['url'], data=d.get('data'), headers=d.get('headers'), timeout=60)
    except Exception as e:
        return {'error': type(e).__name__}
    if local and d.get('data'):
        sent.append({'api': d['url'].rsplit('/', 1)[-1], 'body': json.loads(d['data']), 'resp': r.json()})
    out = {'status': r.status_code, 'responseText': '' if d.get('rt') else r.text}
    if d.get('rt') in ('blob', 'arraybuffer'):
        out.update(b64=base64.b64encode(r.content).decode(), type=r.headers.get('content-type', 'image/png'))
    return out


def shape(data_url):
    im = cv2.imdecode(np.frombuffer(base64.b64decode(data_url.split(',', 1)[1]), np.uint8), cv2.IMREAD_COLOR)
    return im, (im.shape[1], im.shape[0])


try:
    for _ in range(120):
        try: requests.get(f'http://127.0.0.1:{PORT}/health', timeout=1).raise_for_status(); break
        except requests.RequestException: time.sleep(.25)
    with sync_playwright() as p:
        b = p.chromium.launch(**launch_kwargs(), headless=True)
        pg = b.new_page(viewport={'width': 1400, 'height': 1000})
        checks = []
        pg.on('response', lambda r: checks.append(r) if 'c.dun.163.com/api/' in r.url and '/check' in r.url else None)
        pg.expose_function('__xhr', xhr)
        pg.add_init_script(SHIM + '\n' + SOURCE)
        pg.goto(f'https://dun.163.com/trial/{PATH}', wait_until='domcontentloaded', timeout=40000)
        pg.wait_for_timeout(4000)
        basic = pg.locator('.tcapt-category-tabs__tab', has_text='普通版')
        if basic.count(): basic.first.click(); pg.wait_for_timeout(800)
        pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click(); pg.wait_for_timeout(5000)
        for rnd in range(1, ROUNDS + 1):
            n0, c0 = len(sent), len(checks)
            tip = pg.evaluate("[...document.querySelectorAll('.yidun_tips__content')].map(e=>e.innerText.trim()).find(Boolean)||''")
            btn = pg.locator('#icrh-fab [data-icrh-target]')
            row = {'round': rnd, 'tip': tip, 'buttons': btn.count()}
            if btn.count():
                btn.first.click()
                for _ in range(80):
                    pg.wait_for_timeout(250)
                    t = pg.evaluate("[...document.querySelectorAll('#icrh-toast-box div')].map(d=>d.textContent).slice(-1)[0]||''")
                    if '完成' in t or '失败' in t: break
                row['toast'] = t
            pg.wait_for_timeout(2500)
            for i, s in enumerate(sent[n0:]):
                bg, bsz = shape(s['body']['bg'])
                row['api'] = s['api']; row['bg_size'] = bsz
                if 'sprite' in s['body']:
                    sp, ssz = shape(s['body']['sprite']); row['sprite_size'] = ssz
                    cv2.imwrite(str(OUT / f'{rnd:02d}-sprite.png'), sp)
                img = bg.copy()
                for k, (x, y) in enumerate(s['resp'].get('points') or []):
                    cv2.circle(img, (int(x), int(y)), 9, (255, 0, 255), 2); cv2.putText(img, str(k + 1), (int(x) - 5, int(y) + 5), 0, .5, (255, 0, 255), 2)
                cv2.imwrite(str(OUT / f'{rnd:02d}-bg.png'), img)
                row['resp'] = {k: s['resp'].get(k) for k in ('ok', 'points', 'msg', 'targets', 'width', 'height')}
            vals = []
            for c in checks[c0:]:
                try: vals.append(c.text()[-120:])
                except Exception: vals.append('?')
            row['check'] = vals
            print(json.dumps(row, ensure_ascii=False), flush=True)
            ref = pg.locator('.yidun_refresh').filter(visible=True)
            if ref.count(): ref.first.click()
            pg.wait_for_timeout(3000)
        b.close()
finally:
    server.terminate(); server.wait(timeout=15)
