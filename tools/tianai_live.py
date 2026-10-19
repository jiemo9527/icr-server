"""天爱验证码（官方演示站文字点选）上用客户端 + 真实本地服务跑一遍，核对路由：
大图规则选成透明 canvas 时实际发送的是 img；题目图随 /textclick 一起上传；识别不了时如何收尾。
不点「确定」（脚本不自动提交）。GM 为测试桥接，不等同 Tampermonkey 实装。
用法：tianai_live.py [rounds]"""
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

import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]
server = subprocess.Popen([sys.executable, str(ROOT / 'icr_server.py')], cwd=ROOT,
                          env={**os.environ, 'ICR_HOST': '127.0.0.1', 'ICR_PORT': str(PORT), 'ICR_TOKEN': ''},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
RULE = {'id': 'ta', 'type': 'click', 'img': '#tianai-captcha-slider-bg-canvas', 'hint': '#tianai-captcha-tip-img'}
STORE = {'icrh_config_v1': {'localUrl': f'http://127.0.0.1:{PORT}', 'backend': 'local', 'clickDelayMin': 400, 'clickDelayMax': 600},
         'icrh_site_rules_v2': {'captcha.tianai.cloud': [RULE]}}
SHIM = '''(()=>{const store=STORE;window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=o=>window.__xhr(JSON.stringify({url:o.url,method:o.method,data:o.data,headers:o.headers,rt:o.responseType})).then(r=>{
 if(r.error){o.onerror?.(r);return;}
 if(r.b64){const a=Uint8Array.from(atob(r.b64),c=>c.charCodeAt(0));r.response=o.responseType==='blob'?new Blob([a],{type:r.type}):a.buffer;}
 o.onload(r);});})();'''.replace('STORE', json.dumps(STORE))
sent = []


def xhr(payload):
    d = json.loads(payload)
    try:
        r = requests.request(d['method'], d['url'], data=d.get('data'), headers=d.get('headers'), timeout=90)
    except Exception as e:
        return {'error': type(e).__name__}
    if d['url'].startswith(f'http://127.0.0.1:{PORT}') and d.get('data'):
        body = json.loads(d['data'])
        sent.append({'api': d['url'].rsplit('/', 1)[-1], 'keys': sorted(body), 'bgHead': body.get('bg', '')[:30],
                     'resp': {k: r.json().get(k) for k in ('ok', 'reason', 'msg', 'targets', 'points', 'confidence')}})
    out = {'status': r.status_code, 'responseText': '' if d.get('rt') else r.text}
    if d.get('rt') in ('blob', 'arraybuffer'):
        out.update(b64=base64.b64encode(r.content).decode(), type=r.headers.get('content-type', 'image/png'))
    return out


try:
    for _ in range(120):
        try: requests.get(f'http://127.0.0.1:{PORT}/health', timeout=1).raise_for_status(); break
        except requests.RequestException: time.sleep(.25)
    with sync_playwright() as p:
        b = p.chromium.launch(**launch_kwargs(), headless=False,
                              ignore_default_args=['--enable-automation'],
                              args=['--disable-blink-features=AutomationControlled', '--window-position=-2400,0'])
        pg = b.new_page(viewport={'width': 1300, 'height': 900})
        pg.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        pg.expose_function('__xhr', xhr)
        pg.add_init_script(SHIM + '\n' + SOURCE)
        pg.goto('http://captcha.tianai.cloud/', wait_until='domcontentloaded', timeout=40000)
        pg.wait_for_timeout(3000)
        pg.locator('li.captcha-type[data-captcha-type="WORD_IMAGE_CLICK"]').first.click(); pg.wait_for_timeout(800)
        pg.locator('#login-btn').click(); pg.wait_for_timeout(5000)
        for rnd in range(1, ROUNDS + 1):
            n0 = len(sent)
            btn = pg.locator('#icrh-fab [data-icrh-target]')
            toast = ''
            if btn.count():
                btn.first.click()
                for _ in range(160):
                    pg.wait_for_timeout(250)
                    toast = pg.evaluate("[...document.querySelectorAll('#icrh-toast-box div')].map(d=>d.textContent).slice(-1)[0]||''")
                    if '完成' in toast or '失败' in toast: break
            marks = pg.evaluate("[...document.querySelectorAll('#bg-img-click-mask .click-span')].length")
            print(json.dumps({'round': rnd, 'buttons': btn.count(), 'calls': sent[n0:], 'marks': marks, 'toast': toast[:90]}, ensure_ascii=False), flush=True)
            pg.locator('#tianai-captcha-slider-refresh-btn').click(); pg.wait_for_timeout(3500)
        b.close()
finally:
    server.terminate(); server.wait(timeout=15)
