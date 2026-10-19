"""用脚本自己的 smartSelector 为腾讯官方 DOM 生成规则，关闭再打开（不刷新）后检查选择器是否还能命中可见元素。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'client/icr-helper.user.js').read_text(encoding='utf-8')
SHIM = '''(()=>{const store={};window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};
window.GM_registerMenuCommand=()=>{};window.GM_xmlhttpRequest=()=>{};})();'''
EXPOSE = SOURCE.replace("    function start() {", "    window.__probe={smartSelector,queryVisible,queryVisibleImage,visible,findImageSource};\n    function start() {", 1)
TARGETS = {
    'bg': '.tencent-captcha-dy__verify-bg-img',
    'hint': '.tencent-captcha-dy__header-answer',
    'handle': '.tencent-captcha-dy__slider-block',
    'piece': '.tencent-captcha-dy__fg-item',
}
GEN = '''(targets) => { const out={}; const vis=window.__probe.visible;
 for (const [k,s] of Object.entries(targets)) { const el=[...document.querySelectorAll(s)].find(e=>vis(e)||vis(e.parentElement));
   if(!el){out[k]=null;continue;}
   // 模拟右键：用户点到的通常是可见的最上层元素
   const r=el.getBoundingClientRect(); const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
   out[k]={exact:window.__probe.smartSelector(el), top:top?window.__probe.smartSelector(top):null, topTag:top&&top.tagName+'.'+top.className}; }
 return out; }'''
CHECK = '''(sels) => { const out={}; for (const [k,v] of Object.entries(sels)) { if(!v) continue;
  for (const kind of ['exact','top']) { const s=v[kind]; if(!s) continue; let all=[]; try{all=[...document.querySelectorAll(s)];}catch(e){}
   const hit=window.__probe.queryVisible(s); out[k+'.'+kind]={sel:s,total:all.length,visibleHit:!!hit&&window.__probe.visible(hit)}; } } return out; }'''

with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    report = {}
    for kind, btn in [('icon', '#image_click'), ('slider', '#captcha_click')]:
        pg = b.new_page(viewport={'width': 1400, 'height': 1000})
        pg.add_init_script(SHIM + chr(10) + EXPOSE)
        pg.goto('https://cloud.tencent.com/product/captcha', wait_until='domcontentloaded', timeout=40000)
        for _ in range(100):
            pg.wait_for_timeout(200)
            try:
                if pg.evaluate(f'Boolean(document.querySelector("{btn}")?.onclick)'): break
            except Exception: pg.wait_for_timeout(400)
        pg.locator(btn).click(); pg.wait_for_timeout(6000)
        sels = pg.evaluate(GEN, TARGETS)
        rounds = [pg.evaluate(CHECK, sels)]
        for _ in range(2):
            pg.keyboard.press('Escape'); pg.wait_for_timeout(500)
            for c in pg.locator('[class*="tencent-captcha-dy__header-close"], [class*="close-btn"]').all():
                try:
                    if c.is_visible(): c.click(timeout=1000)
                except Exception: pass
            pg.wait_for_timeout(1500)
            pg.locator(btn).click(); pg.wait_for_timeout(6000)
            rounds.append(pg.evaluate(CHECK, sels))
        report[kind] = {'generated': sels, 'rounds': rounds}
        pg.close()
    b.close()
print(json.dumps(report, ensure_ascii=False, indent=1))
