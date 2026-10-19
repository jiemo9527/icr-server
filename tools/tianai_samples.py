"""天爱验证码（tianai-captcha）文字点选采样：用官方演示页 captcha.tianai.cloud 的「文字点选」，
保存大图与题目图（不涉及任何网站账号）。每次点「点击验证」/刷新换新题。
用法：tianai_samples.py N [outdir] [captcha-type]   captcha-type 默认 WORD_IMAGE_CLICK"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
N = int(sys.argv[1]) if len(sys.argv) > 1 else 10
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'reports/private/tianai/samples'
TYPE = sys.argv[3] if len(sys.argv) > 3 else 'WORD_IMAGE_CLICK'
OUT.mkdir(parents=True, exist_ok=True)
GET = '''()=>{const bg=document.getElementById('tianai-captcha-slider-bg-img'),tip=document.getElementById('tianai-captcha-tip-img');
 const root=document.getElementById('tianai-captcha');
 const vis=e=>e&&e.getBoundingClientRect().width>2;
 return vis(bg)&&tip&&bg.complete&&bg.naturalWidth>0&&tip.complete&&tip.naturalWidth>0?{bg:bg.src,tip:tip.src,cls:root?root.className:'',
   bgCss:[bg.getBoundingClientRect().width,bg.getBoundingClientRect().height],tipCss:[tip.getBoundingClientRect().width,tip.getBoundingClientRect().height]}:null}'''

with sync_playwright() as p:
    # 演示站对无头浏览器返回「请稍后再试」：用有界面窗口（放到屏幕外）并去掉自动化标记
    b = p.chromium.launch(**launch_kwargs(), headless=False,
                          ignore_default_args=['--enable-automation'],
                          args=['--disable-blink-features=AutomationControlled', '--window-position=-2400,0'])
    pg = b.new_page(viewport={'width': 1300, 'height': 900})
    pg.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
    pg.goto('http://captcha.tianai.cloud/', wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(3000)
    pg.locator(f'li.captcha-type[data-captcha-type="{TYPE}"]').first.click()
    pg.wait_for_timeout(800)
    got, seen, last = 0, set(), None
    for i in range(N * 4):
        d = None
        if i == 0:
            pg.locator('#login-btn').click()
        for _ in range(20):
            d = pg.evaluate(GET)
            if d and d['bg'] != (last or {}).get('bg'): break
            d = None
            pg.wait_for_timeout(500)
        if not d:
            print('no captcha'); break
        last = dict(d)
        key = d['bg'][-300:] if d['bg'].startswith('data:') else d['bg']
        if key not in seen:
            seen.add(key)
            if not d['bg'].startswith('data:'):
                for k in ('bg', 'tip'):
                    d[k] = 'data:image/png;base64,' + base64.b64encode(pg.request.get(d[k]).body()).decode()
            (OUT / f'{got:02d}.json').write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
            for k in ('bg', 'tip'):
                (OUT / f'{got:02d}-{k}.png').write_bytes(base64.b64decode(d[k].split(',', 1)[1]))
            got += 1
            print('saved', got, d['cls'], d['bgCss'], d['tipCss'], flush=True)
            if got >= N: break
        ref = pg.locator('#tianai-captcha-slider-refresh-btn').filter(visible=True)
        if ref.count():
            ref.first.click()
        else:
            print('no refresh'); pg.screenshot(path=str(OUT / 'page.png')); break
        pg.wait_for_timeout(2500)
    b.close()
print('total', got)
