"""同一页面不刷新，反复打开腾讯官方体验验证码，统计客户端每轮的检测/识别/通过。

只记录结果码与诊断计数，不保存 ticket / 会话。GM 存储与 HTTP 为测试桥接。
用法: python tools/tencent_repeat.py [rounds] [kinds]   kinds 逗号分隔 icon,slider
"""
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
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 4
KINDS = (sys.argv[2] if len(sys.argv) > 2 else 'icon,slider').split(',')
MODE = sys.argv[3] if len(sys.argv) > 3 else 'rules'   # rules=预设规则+自动执行；manual=无规则，点悬浮按钮
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
BUTTONS = {'icon': '#image_click', 'slider': '#captcha_click', 'text': '#text_click'}

with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]
server = subprocess.Popen([sys.executable, str(ROOT / 'icr_server.py')], cwd=ROOT,
                          env={**os.environ, 'ICR_HOST': '127.0.0.1', 'ICR_PORT': str(PORT), 'ICR_TOKEN': ''},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

STORE = {
    'icrh_config_v1': {'localUrl': f'http://127.0.0.1:{PORT}', 'backend': 'local', 'apiKey': '',
                       'autoExecute': True, 'clickDelayMin': 400, 'clickDelayMax': 700},
    'icrh_site_rules_v2': {'cloud.tencent.com': [
        {'id': 'icon', 'type': 'click', 'img': '.tencent-captcha-dy__verify-bg-img',
         'hint': '.tencent-captcha-dy__header-answer'},
        {'id': 'slider', 'type': 'slider', 'img': '.tencent-captcha-dy__verify-bg-img',
         'handle': '.tencent-captcha-dy__slider-block', 'piece': '.tencent-captcha-dy__fg-item'}]}}
if MODE == 'manual':
    STORE['icrh_site_rules_v2'] = {}
    STORE['icrh_config_v1']['autoExecute'] = False
if MODE == 'rulebtn':   # 有规则、关闭自动执行，点悬浮按钮
    STORE['icrh_config_v1']['autoExecute'] = False
    STORE['icrh_site_rules_v2']['cloud.tencent.com'].append(
        {'id': 'text', 'type': 'click', 'img': '.tencent-captcha-dy__verify-bg-img', 'hint': '.tencent-captcha-dy__header-text'})
SHIM = '''(()=>{const store=STORE;
window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=o=>window.__xhr(JSON.stringify({url:o.url,method:o.method,data:o.data,headers:o.headers,rt:o.responseType})).then(r=>{
 if(r.error){o.onerror?.(r);return;}
 if(r.b64){const a=Uint8Array.from(atob(r.b64),c=>c.charCodeAt(0));r.response=o.responseType==='blob'?new Blob([a],{type:r.type}):a.buffer;}
 o.onload(r);});
window.__drops=[];
document.addEventListener('touchend',()=>{const vis=e=>e&&e.getBoundingClientRect().width>2&&getComputedStyle(e).display!=='none';
 const piece=[...document.querySelectorAll('.tencent-captcha-dy__fg-item')].find(vis);const bg=document.querySelector('.tencent-captcha-dy__verify-bg-img');
 if(piece&&bg){const p=piece.getBoundingClientRect(),b=bg.getBoundingClientRect();window.__drops.push({pieceLeft:p.left,bgLeft:b.left,bgWidth:b.width});}},true);
})();'''.replace('STORE', json.dumps(STORE))

calls = []


last_slider = []


def xhr(payload):
    d = json.loads(payload)
    if d['url'].startswith(f'http://127.0.0.1:{PORT}'):
        calls.append(d['url'].rsplit('/', 1)[-1])
        if d['url'].endswith('/slider'):
            (ROOT / 'reports/private/slider-samples').mkdir(parents=True, exist_ok=True)
            (ROOT / f'reports/private/slider-samples/{int(time.time()*1000)}.json').write_text(d['data'], encoding='utf-8')
    try:
        r = requests.request(d['method'], d['url'], data=d.get('data'), headers=d.get('headers'), timeout=30)
        if d['url'].endswith('/slider'):
            try: last_slider.append(r.json())
            except Exception: pass
        out = {'status': r.status_code, 'responseText': '' if d.get('rt') else r.text}
        if d.get('rt') in ('blob', 'arraybuffer'):
            out.update(b64=base64.b64encode(r.content).decode(), type=r.headers.get('content-type', 'image/png'))
        return out
    except Exception as e:
        return {'error': type(e).__name__}


DIAG = '''() => {
  const vis = e => { if(!e) return false; const r=e.getBoundingClientRect(); if(r.width<2||r.height<2) return false;
    for(let n=e;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n); if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false;} return true; };
  const all = s => [...document.querySelectorAll(s)];
  const bg = all('.tencent-captcha-dy__verify-bg-img');
  return {bg_total: bg.length, bg_visible: bg.filter(vis).length,
    hint_visible: all('.tencent-captcha-dy__header-answer').filter(vis).length,
    handle_visible: all('.tencent-captcha-dy__slider-block').filter(vis).length,
    containers: all('#tcaptcha_transform_dy').length,
    buttons: [...document.querySelectorAll('[data-icrh-target]')].map(b=>b.dataset.state+':'+b.textContent.trim()),
    toasts: [...document.querySelectorAll('#icrh-toast-box div')].map(d=>d.textContent).slice(-3)};
}'''


def close_challenge(pg):
    # 关闭官方弹窗（右上角关闭/ESC），模拟用户不刷新页面再次打开
    for sel in ['.tencent-captcha-dy__header-close', '[class*="close"]']:
        loc = pg.locator(sel).filter(has_not_text='关闭广告')
        try:
            for i in range(loc.count()):
                if loc.nth(i).is_visible():
                    loc.nth(i).click(timeout=1500); return True
        except Exception:
            pass
    pg.keyboard.press('Escape')
    return False


results = []
try:
    for _ in range(120):
        try:
            requests.get(f'http://127.0.0.1:{PORT}/health', timeout=1).raise_for_status(); break
        except requests.RequestException:
            time.sleep(.25)
    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs(), headless=True)
        for kind in KINDS:
            pg = browser.new_page(viewport={'width': 1400, 'height': 1000})
            codes = []
            pg.on('response', lambda r: codes.append(r) if 'cap_union_new_verify' in r.url else None)
            pg.expose_function('__xhr', xhr)
            pg.add_init_script(SHIM + chr(10) + SOURCE)
            pg.goto('https://cloud.tencent.com/product/captcha', wait_until='domcontentloaded', timeout=40000)
            sel = BUTTONS[kind]
            for _ in range(100):
                pg.wait_for_timeout(200)
                try:
                    if pg.evaluate(f'Boolean(document.querySelector("{sel}")?.onclick)'): break
                except Exception:
                    pg.wait_for_timeout(400)
            for rnd in range(1, ROUNDS + 1):
                before_calls, before_codes, before_sl = len(calls), len(codes), len(last_slider)
                pg.evaluate('window.__drops=[]')
                if rnd == 1 or MODE != 'retry':
                    pg.locator(sel).click()
                notice, diag = '', {}
                pressed = False
                for _ in range(120):
                    pg.wait_for_timeout(250)
                    diag = pg.evaluate(DIAG)
                    notice = ' | '.join(diag['toasts'])
                    if MODE in ('manual', 'retry', 'rulebtn') and not pressed and _ >= 16:
                        btns = pg.locator('#icrh-fab [data-icrh-target]')
                        diag['fab_count'] = btns.count()
                        if btns.count():
                            btns.first.click(); pressed = True
                        elif _ == 40:
                            notice = 'NO_BUTTON'; break
                    if any(k in notice for k in ['点选完成', '拖动完成', '失败', '已丢弃', '完成', '失败']): break
                if kind in ('icon', 'text') and '点选完成' in notice:
                    pg.locator('.tencent-captcha-dy__verify-confirm-btn').filter(visible=True).first.click(force=True)
                pg.wait_for_timeout(3500)
                verify = []
                for r in codes[before_codes:]:
                    try: verify.append(str(r.json().get('errorCode')))
                    except Exception: verify.append('?')
                after = pg.evaluate(DIAG)
                drops = pg.evaluate('window.__drops')
                errs = []
                for res, dr in zip(last_slider[before_sl:], drops):
                    if res.get('ok'):
                        k = dr['bgWidth'] / res['width']
                        # 拼图块元素可见左边缘 = 元素 left + 透明边距
                        errs.append(round(dr['pieceLeft'] + res['piece_offset_left'] * k - (dr['bgLeft'] + res['gap_left'] * k), 1))
                row = {'kind': kind, 'round': rnd, 'api': calls[before_calls:], 'verify': verify, 'drop_error_px': errs,
                       'notice': notice[-160:], 'diag_running': diag, 'diag_after': after}
                results.append(row)
                print(json.dumps({k: row[k] for k in ['kind', 'round', 'api', 'verify', 'drop_error_px', 'notice']}, ensure_ascii=False), flush=True)
                pg.screenshot(path=str(ROOT / 'reports/private' / f'repeat-{kind}-{rnd}.png'))
                # 通过后官方弹窗自动关闭；失败/未处理时手动关
                if after['bg_visible'] and MODE != 'retry':
                    close_challenge(pg); pg.wait_for_timeout(1500)
                pg.wait_for_timeout(int(os.environ.get('ROUND_GAP_MS', '1500')))
            pg.close()
        browser.close()
finally:
    server.terminate(); server.wait(timeout=15)
    (ROOT / 'reports/private').mkdir(parents=True, exist_ok=True)
    (ROOT / 'reports/private/tencent-repeat.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
summary = {}
for r in results:
    s = summary.setdefault(r['kind'], {'rounds': 0, 'api_called': 0, 'passed': 0})
    s['rounds'] += 1; s['api_called'] += bool(r['api']); s['passed'] += '0' in r['verify']
print('SUMMARY', json.dumps(summary, ensure_ascii=False))
