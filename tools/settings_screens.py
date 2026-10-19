"""渲染新版设置面板四个标签页的截图，供目视检查。GM 为测试桩，强制 open shadow 以便截图前切页。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
STORE = {'icrh_config_v1': {'localUrl': 'http://127.0.0.1:8899'},
         'icrh_site_rules_v2': {'ui.fixture': [
             {'id': 'a', 'type': 'click', 'img': '#bg', 'hint': '#hint'},
             {'id': 'b', 'type': 'slider', 'img': '#bg', 'handle': '#handle', 'backend': 'local', 'autoExecute': True},
             {'id': 'c', 'type': 'text', 'img': '#code', 'input': '#answer', 'enabled': False}]}}
SHIM = '''(()=>{const store=STORE;window.__menus=[];
window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};
window.GM_registerMenuCommand=(n,f)=>window.__menus.push({n,f});window.GM_xmlhttpRequest=o=>setTimeout(()=>o.onload({status:200,responseText:JSON.stringify({ok:true,auth_ok:true,auth_required:false,endpoints:['/solve','/ocr','/math','/slider']})}),200);
const a=Element.prototype.attachShadow;Element.prototype.attachShadow=function(){return a.call(this,{mode:'open'});};})();'''.replace('STORE', json.dumps(STORE))
HTML = '<h1>页面</h1><img id="code" src="data:image/png;base64,iVBORw0KGgo="><input id="answer">'
out = ROOT / 'reports/private'
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1100, 'height': 760})
    pg.add_init_script(SHIM + '\n' + SOURCE)
    pg.route('http://ui.fixture/', lambda r: r.fulfill(content_type='text/html', body=HTML))
    pg.goto('http://ui.fixture/')
    pg.wait_for_timeout(500)
    pg.evaluate("window.__menus.find(m=>m.n.includes('设置')).f()")
    root = "document.getElementById('icrh-settings-host').shadowRoot"
    pg.evaluate(f"{root}.querySelector('.icrh-test-local').click()")
    pg.wait_for_timeout(400)
    for tab in ['common', 'engine', 'rules', 'advanced']:
        pg.evaluate(f"{root}.querySelector('[data-tab=\"{tab}\"]').click()")
        pg.wait_for_timeout(150)
        pg.screenshot(path=str(out / f'settings-{tab}.png'))
    b.close()
print('ok')
