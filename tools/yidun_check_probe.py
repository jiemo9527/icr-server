"""易盾点选：用 Playwright 真实鼠标（isTrusted）在大图上点 3 下（坐标随便），抓 check 请求参数和返回，
同时记录页面监听到的事件类型，弄清易盾判定依赖哪些事件/字段。不涉及任何账号。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

KIND = sys.argv[1] if len(sys.argv) > 1 else 'word'
MODE = sys.argv[2] if len(sys.argv) > 2 else 'trusted'   # trusted | synthetic
PATH = {'word': 'picture-click', 'icon': 'icon-click'}[KIND]
HOOK = '''(()=>{window.__ev=[];const orig=EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener=function(t,f,o){try{if(this&&this.className&&String(this.className).includes('yidun'))window.__ev.push(t+'@'+String(this.className).split(' ')[0]);}catch(e){}return orig.call(this,t,f,o);};})();'''
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    pg.add_init_script(HOOK)
    checks = []

    def on_resp(r):
        if 'c.dun.163.com/api/' in r.url and '/check' in r.url:
            q = parse_qs(urlparse(r.url).query)
            try: body = r.text()
            except Exception: body = ''
            checks.append({'params': {k: (v[0][:80] + ('…%d' % len(v[0]) if len(v[0]) > 80 else '')) for k, v in q.items()}, 'body': body[:300]})
    pg.on('response', on_resp)
    pg.goto(f'https://dun.163.com/trial/{PATH}', wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(4000)
    basic = pg.locator('.tcapt-category-tabs__tab', has_text='普通版')
    if basic.count(): basic.first.click(); pg.wait_for_timeout(800)
    pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click(); pg.wait_for_timeout(5000)
    bg = pg.locator('.yidun_bg-img').filter(visible=True).first
    box = bg.bounding_box()
    pts = [(0.2, 0.3), (0.5, 0.5), (0.8, 0.6)]
    if MODE == 'trusted':
        for x, y in pts:
            pg.mouse.move(box['x'] + x * box['width'], box['y'] + y * box['height'], steps=8)
            pg.wait_for_timeout(300); pg.mouse.down(); pg.wait_for_timeout(80); pg.mouse.up(); pg.wait_for_timeout(700)
    else:
        pg.evaluate('''([pts,box])=>{const el=document.querySelector('.yidun_bg-img');const t=[...document.querySelectorAll('.yidun_bg-img')].find(e=>e.getBoundingClientRect().width>2);
          for(const [x,y] of pts){const cx=box.x+x*box.width,cy=box.y+y*box.height;const tg=document.elementFromPoint(cx,cy)||t;
            for(const ty of ['mousedown','mouseup','click'])tg.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:0}));}}''', [pts, box])
    pg.wait_for_timeout(4000)
    ev = pg.evaluate('[...new Set(window.__ev)]')
    marks = pg.evaluate("[...document.querySelectorAll('.yidun_bg-img ~ *, .yidun_bgimg *')].filter(e=>/point|mark|dot/i.test(e.className)).length")
    print('EVENTS', ev)
    print('MARKS', marks)
    print('CHECK', json.dumps(checks, ensure_ascii=False, indent=1)[:2500])
    b.close()
