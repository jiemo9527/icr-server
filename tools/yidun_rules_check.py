"""易盾三种体验页（滑块 / 文字点选 / 图标点选，嵌入式）上用真实规则检查：出现哪些按钮、自动执行了哪些规则。
只记录请求，不转发给本地服务（返回 ok:false），所以不会真的拖动或点击；用于核对「只执行一种规则、不能判断时让用户选」。
GM 为测试桥接，不等同于 Tampermonkey 实装。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
RULES = [
    {'id': 'mveyxg4adyla0', 'enabled': True, 'type': 'click', 'img': 'img[alt="验证码背景"]', 'hint': 'span.yidun_tips__point'},
    {'id': 'mveyz1g28zha2', 'enabled': True, 'type': 'click', 'img': 'img[alt="验证码背景"]', 'hint': 'div.yidun_tips__answer'},
    {'id': 'mvezp4itwqrhc', 'enabled': True, 'type': 'slider', 'img': 'div.yidun_panel', 'handle': 'div.yidun_slider',
     'piece': 'img[alt="验证码滑块"]', 'full': 'div.yidun_panel'},
]
STORE = {'icrh_config_v1': {'localUrl': 'http://127.0.0.1:1', 'backend': 'local', 'autoExecute': True},
         'icrh_site_rules_v2': {'dun.163.com': RULES}}
SHIM = '''(()=>{const store=STORE;window.__menus=[];window.__sent=[];
window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};window.__store=store;
window.GM_registerMenuCommand=(n,f)=>window.__menus.push({n,f});
window.GM_xmlhttpRequest=o=>{const b=o.data?JSON.parse(o.data):{};window.__sent.push({api:o.url.split('/').pop(),keys:Object.keys(b)});
 setTimeout(()=>o.onload({status:200,responseText:JSON.stringify({ok:false,msg:'probe'})}),50);};})();'''.replace('STORE', json.dumps(STORE))
PAGES = {'jigsaw': ('jigsaw', None), 'word': ('picture-click', '普通版'), 'icon': ('icon-click', None)}
which = sys.argv[1:] or list(PAGES)
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    for name in which:
        path, cat = PAGES[name]
        pg = b.new_page(viewport={'width': 1400, 'height': 1000})
        pg.add_init_script(SHIM + '\n' + SOURCE)
        pg.goto(f'https://dun.163.com/trial/{path}', wait_until='domcontentloaded', timeout=40000)
        pg.wait_for_timeout(4000)
        if cat:
            t = pg.locator('.tcapt-category-tabs__tab', has_text=cat)
            if t.count(): t.first.click(); pg.wait_for_timeout(800)
        pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click()
        pg.wait_for_timeout(6000)
        r = pg.evaluate('''()=>({
          tip:[...document.querySelectorAll('.yidun_tips__content')].map(e=>e.innerText.trim()).find(Boolean)||'',
          btns:[...document.querySelectorAll('#icrh-fab [data-icrh-target]')].map(b=>b.textContent.trim()),
          sent:window.__sent.map(s=>s.api),
          fullLeft:(window.__store.icrh_site_rules_v2['dun.163.com']||[]).some(r=>'full' in r)})''')
        print(name, json.dumps(r, ensure_ascii=False), flush=True)
        pg.close()
    b.close()
