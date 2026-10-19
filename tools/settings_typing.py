"""复现：设置窗口用真实键盘输入（Playwright keyboard，isTrusted=true），检查各输入框能否录入。
在空白页和腾讯官方页各测一次（腾讯页有自己的快捷键/焦点逻辑）。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
SHIM = '''(()=>{const store={};window.__menus=[];window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};
window.GM_registerMenuCommand=(n,f)=>window.__menus.push({n,f});window.GM_xmlhttpRequest=()=>{};
const a=Element.prototype.attachShadow;Element.prototype.attachShadow=function(){return a.call(this,{mode:'open'});};})();'''
FIELDS = [('common', '#icrh-local-url'), ('common', '#icrh-local-token'), ('engine', '#icrh-url'), ('engine', '#icrh-key'),
          ('engine', '#icrh-model'), ('engine', '#icrh-delay-min'), ('advanced', '#icrh-prompt-text')]
urls = sys.argv[1:] or ['about:blank', 'https://cloud.tencent.com/product/captcha']
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    for url in urls:
        pg = b.new_page(viewport={'width': 1300, 'height': 900})
        pg.add_init_script(SHIM + '\n' + SOURCE)
        if url == 'about:blank':
            pg.route('http://blank.test/', lambda r: r.fulfill(content_type='text/html', body='<h1>x</h1>'))
            url = 'http://blank.test/'
        pg.goto(url, wait_until='domcontentloaded', timeout=40000)
        pg.wait_for_timeout(4000)
        pg.evaluate("window.__menus.find(m=>m.n.includes('设置')).f()")
        pg.wait_for_timeout(300)
        root = "document.getElementById('icrh-settings-host').shadowRoot"
        out = {}
        for tab, sel in FIELDS:
            pg.evaluate(f"{root}.querySelector('[data-tab=\"{tab}\"]').click()")
            pg.wait_for_timeout(100)
            loc = pg.locator(f'#icrh-settings-host >> {sel}')
            loc.click()
            pg.keyboard.press('Control+A'); pg.keyboard.press('Delete')
            pg.keyboard.type('ab Q/s?1', delay=int(__import__('os').environ.get('TYPE_DELAY','30')))
            val = loc.input_value()
            active = pg.evaluate(f"(()=>{{const a={root}.activeElement;return a?('#'+a.id):String(document.activeElement&&document.activeElement.tagName)}})()")
            out[sel] = {'value': val, 'ok': val == 'ab Q/s?1', 'active': active}
        print(url, json.dumps(out, ensure_ascii=False))
        pg.close()
    b.close()
