"""实测：同一验证码有两条规则同时适用、开启自动执行时，不自动执行，出现两个选择按钮；点其一后真实提交。"""
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

import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]
server = subprocess.Popen([sys.executable, str(ROOT / 'icr_server.py')], cwd=ROOT,
                          env={**os.environ, 'ICR_HOST': '127.0.0.1', 'ICR_PORT': str(PORT), 'ICR_TOKEN': ''},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BG = '.tencent-captcha-dy__verify-bg-img'
STORE = {'icrh_config_v1': {'localUrl': f'http://127.0.0.1:{PORT}', 'backend': 'local', 'autoExecute': True,
                            'clickDelayMin': 400, 'clickDelayMax': 700},
         'icrh_site_rules_v2': {'cloud.tencent.com': [
             {'id': 'a', 'type': 'click', 'img': BG, 'hint': '.tencent-captcha-dy__header-answer'},
             {'id': 'b', 'type': 'click', 'img': BG, 'hint': '#tcaptcha_transform_dy .tencent-captcha-dy__header-answer'}]}}
SHIM = '''(()=>{const store=STORE;window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=o=>window.__xhr(JSON.stringify({url:o.url,method:o.method,data:o.data,headers:o.headers,rt:o.responseType})).then(r=>{
 if(r.b64){const a=Uint8Array.from(atob(r.b64),c=>c.charCodeAt(0));r.response=o.responseType==='blob'?new Blob([a],{type:r.type}):a.buffer;}
 o.onload(r);});})();'''.replace('STORE', json.dumps(STORE))
calls = []


def xhr(payload):
    d = json.loads(payload)
    if d['url'].startswith(f'http://127.0.0.1:{PORT}'): calls.append(d['url'].rsplit('/', 1)[-1])
    r = requests.request(d['method'], d['url'], data=d.get('data'), headers=d.get('headers'), timeout=30)
    out = {'status': r.status_code, 'responseText': '' if d.get('rt') else r.text}
    if d.get('rt') in ('blob', 'arraybuffer'):
        out.update(b64=base64.b64encode(r.content).decode(), type=r.headers.get('content-type', 'image/png'))
    return out


STATE = '''() => ({btns:[...document.querySelectorAll('#icrh-fab [data-icrh-target]')].map(b=>b.dataset.state+':'+b.textContent),
  toasts:[...document.querySelectorAll('#icrh-toast-box div')].map(d=>d.textContent)})'''
try:
    for _ in range(120):
        try: requests.get(f'http://127.0.0.1:{PORT}/health', timeout=1).raise_for_status(); break
        except requests.RequestException: time.sleep(.25)
    with sync_playwright() as p:
        b = p.chromium.launch(**launch_kwargs(), headless=True)
        pg = b.new_page(viewport={'width': 1400, 'height': 1000})
        codes = []
        pg.on('response', lambda r: codes.append(r) if 'cap_union_new_verify' in r.url else None)
        pg.expose_function('__xhr', xhr)
        pg.add_init_script(SHIM + '\n' + SOURCE)
        pg.goto('https://cloud.tencent.com/product/captcha', wait_until='domcontentloaded', timeout=40000)
        for _ in range(100):
            pg.wait_for_timeout(200)
            try:
                if pg.evaluate('Boolean(document.querySelector("#image_click")?.onclick)'): break
            except Exception: pg.wait_for_timeout(400)
        pg.locator('#image_click').click(); pg.wait_for_timeout(7000)
        before = pg.evaluate(STATE)
        print('BEFORE', json.dumps({'calls': list(calls), **before}, ensure_ascii=False))
        pg.screenshot(path=str(ROOT / 'reports/private/choice-buttons.png'))
        pg.locator('#icrh-fab [data-icrh-target]').nth(1).click()
        for _ in range(60):
            pg.wait_for_timeout(250)
            st = pg.evaluate(STATE)
            if any('完成' in t or '失败' in t for t in st['toasts']): break
        pg.locator('.tencent-captcha-dy__verify-confirm-btn').filter(visible=True).first.click(force=True)
        pg.wait_for_timeout(3500)
        vals = []
        for c in codes:
            try: vals.append(str(c.json().get('errorCode')))
            except Exception: vals.append('?')
        print('AFTER', json.dumps({'calls': calls, 'verify': vals, **pg.evaluate(STATE)}, ensure_ascii=False))
        b.close()
finally:
    server.terminate(); server.wait(timeout=15)
