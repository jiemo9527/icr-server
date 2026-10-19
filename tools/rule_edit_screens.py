"""渲染规则编号 + 编辑表单截图（设置「规则」页、规则管理），供目视检查布局。
场景：腾讯滑块页结构，含一条把完整背景误选成弹窗的规则。GM 为测试桩，强制 open shadow。"""
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
             {'id': 'a', 'type': 'click', 'img': 'div.tencent-captcha-dy__verify-bg-img', 'hint': 'div.tencent-captcha-dy__header-answer', 'backend': 'local'},
             {'id': 'b', 'type': 'slider', 'img': 'div.tencent-captcha-dy__verify-bg-img', 'handle': 'div.tencent-captcha-dy__slider-block',
              'piece': 'div[alt="拖动下方滑块完成拼图"]', 'backend': 'local'}]}}
SHIM = '''(()=>{const store=STORE;window.__menus=[];
window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};
window.GM_registerMenuCommand=(n,f)=>window.__menus.push({n,f});window.GM_xmlhttpRequest=o=>{};
const a=Element.prototype.attachShadow;Element.prototype.attachShadow=function(){return a.call(this,{mode:'open'});};})();'''.replace('STORE', json.dumps(STORE))
PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
HTML = f'''<div id="tCaptchaDyMainWrap" style="width:360px;height:363px;position:relative">
<div class="tencent-captcha-dy__header-answer" style="width:80px;height:25px"></div>
<div class="tencent-captcha-dy__verify-bg-img" style="width:330px;height:236px;background:url({PX}) 0 0/100% 100%"></div>
<div class="tencent-captcha-dy__fg-item" alt="拖动下方滑块完成拼图" style="position:absolute;left:20px;top:100px;width:59px;height:59px;background:url({PX})"></div>
<div class="tencent-captcha-dy__slider-block" alt="拖动下方滑块完成拼图" style="width:60px;height:47px;background:#ddd"></div></div>'''
out = ROOT / 'reports/private'
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1000, 'height': 760})
    pg.add_init_script(SHIM + '\n' + SOURCE)
    pg.route('http://ui.fixture/', lambda r: r.fulfill(content_type='text/html; charset=utf-8', body=HTML))
    pg.goto('http://ui.fixture/')
    pg.wait_for_timeout(500)
    pg.evaluate("window.__menus.find(m=>m.n.includes('规则管理')).f()")
    root = "document.getElementById('icrh-rules-host').shadowRoot"
    pg.evaluate(f"{root}.querySelector('.rule[data-rule-id=\"b\"] button.edit').click()")
    pg.wait_for_timeout(200)
    pg.screenshot(path=str(out / 'rules-manager-edit.png'))
    pg.evaluate(f"{root}.querySelector('.rule[data-rule-id=\"b\"] .icrh-edit-cancel').click()")
    pg.evaluate("document.getElementById('icrh-rules-host').remove()")
    pg.evaluate("window.__menus.find(m=>m.n.includes('设置')).f('rules')")
    sroot = "document.getElementById('icrh-settings-host').shadowRoot"
    pg.wait_for_timeout(200)
    pg.evaluate(f"{sroot}.querySelector('[data-tab=\"rules\"]').click()")
    pg.wait_for_timeout(150)
    pg.evaluate(f"[...{sroot}.querySelectorAll('[data-rule-id=\"b\"] button')].find(x=>x.textContent==='编辑').click()")
    pg.wait_for_timeout(200)
    pg.screenshot(path=str(out / 'settings-rules-edit.png'))
    b.close()
print('ok')
