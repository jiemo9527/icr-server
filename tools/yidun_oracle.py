"""对照实验：网易易盾嵌入式文字点选，坐标由人工（看图）给出，分别用
  trusted  —— Playwright 真实鼠标（isTrusted=true，带移动轨迹）
  synthetic —— 页面内 dispatchEvent（isTrusted=false，与油猴脚本相同）
点击，记录 check 结果。用于判断「点对也失败」是否因为非可信事件。
流程：每轮保存可见大图到 reports/private/yidun/oracle/NN.png，等待同目录 NN.coords（内容 JSON [[x,y],...]，
坐标为 320x160 可见图像素），读到后点击。
用法：yidun_oracle.py trusted,synthetic,trusted,synthetic"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
import random
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/private/yidun/oracle'
OUT.mkdir(parents=True, exist_ok=True)
MODES = (sys.argv[1] if len(sys.argv) > 1 else 'trusted,synthetic').split(',')
SYNTH = '''([pts])=>{const bg=[...document.querySelectorAll('.yidun_bg-img')].find(e=>e.getBoundingClientRect().width>2);const r=bg.getBoundingClientRect();
  const fire=(t,x,y,C)=>{const el=document.elementFromPoint(x,y)||bg;el.dispatchEvent(new C(t,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons:t.endsWith('down')?1:0,pointerType:'mouse',pointerId:1,isPrimary:true}));};
  let i=0;return new Promise(res=>{const step=()=>{if(i>=pts.length)return res(true);const [px,py]=pts[i++];const x=r.left+px,y=r.top+py;
    fire('pointermove',x,y,PointerEvent);fire('mousemove',x,y,MouseEvent);fire('pointerdown',x,y,PointerEvent);fire('mousedown',x,y,MouseEvent);
    fire('pointerup',x,y,PointerEvent);fire('mouseup',x,y,MouseEvent);fire('click',x,y,MouseEvent);setTimeout(step,700+Math.random()*400);};step();});}'''
with sync_playwright() as p:
    # STEALTH=1：有界面、去掉自动化特征（navigator.webdriver、--enable-automation），排查是否因自动化浏览器被拒
    import os
    stealth = os.environ.get('STEALTH') == '1'
    kw = launch_kwargs(headless=not stealth)
    if stealth:
        kw.update(ignore_default_args=['--enable-automation'], args=['--disable-blink-features=AutomationControlled', '--window-size=1400,1050'])
    b = p.chromium.launch(**kw)
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    if stealth:
        pg.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
    print('ENV', pg.evaluate('({wd:navigator.webdriver,ua:navigator.userAgent.slice(-60),plugins:navigator.plugins.length})') if pg.goto('about:blank') is None else '', flush=True)
    checks = []
    pg.on('response', lambda r: checks.append(r) if 'c.dun.163.com/api/' in r.url and '/check' in r.url else None)
    pg.goto('https://dun.163.com/trial/picture-click', wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(4000)
    basic = pg.locator('.tcapt-category-tabs__tab', has_text='普通版')
    if basic.count(): basic.first.click(); pg.wait_for_timeout(800)
    pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click(); pg.wait_for_timeout(5000)
    for i, mode in enumerate(MODES):
        tip = pg.evaluate("[...document.querySelectorAll('.yidun_tips__content')].map(e=>e.innerText.trim()).find(Boolean)||''")
        bg = pg.locator('.yidun_bg-img').filter(visible=True).first
        bg.screenshot(path=str(OUT / f'{i:02d}.png'))
        (OUT / f'{i:02d}.tip').write_text(tip, encoding='utf-8')
        print('WAIT', i, mode, tip, flush=True)
        cf = OUT / f'{i:02d}.coords'
        for _ in range(600):
            if cf.exists(): break
            time.sleep(0.5)
        pts = json.loads(cf.read_text(encoding='utf-8'))
        box = bg.bounding_box()
        print('BOX', i, box, flush=True)
        c0 = len(checks)
        if mode == 'trusted':
            pg.mouse.move(box['x'] - 40, box['y'] + 200, steps=5)
            for k, (x, y) in enumerate(pts):
                pg.mouse.move(box['x'] + x + random.uniform(-1, 1), box['y'] + y + random.uniform(-1, 1), steps=random.randint(12, 20))
                pg.wait_for_timeout(random.randint(150, 300)); pg.mouse.down(); pg.wait_for_timeout(random.randint(60, 120)); pg.mouse.up()
                if k < len(pts) - 1:
                    pg.wait_for_timeout(250)
                    pg.locator('.yidun_panel').filter(visible=True).first.screenshot(path=str(OUT / f'{i:02d}-click{k + 1}.png'))
                pg.wait_for_timeout(random.randint(500, 900))
        else:
            pg.evaluate(SYNTH, [pts[:-1]])
            pg.wait_for_timeout(250)
            pg.locator('.yidun_panel').filter(visible=True).first.screenshot(path=str(OUT / f'{i:02d}-click{len(pts) - 1}.png'))
            pg.evaluate(SYNTH, [pts[-1:]])
        pg.wait_for_timeout(3500)
        res = []
        for c in checks[c0:]:
            try:
                t = c.text(); res.append('result:true' if '"result":true' in t else 'result:false')
            except Exception: res.append('?')
        print('RESULT', i, mode, tip, pts, res, flush=True)
        pg.screenshot(path=str(OUT / f'{i:02d}-after.png'))
        ref = pg.locator('.yidun_refresh').filter(visible=True)
        if ref.count(): ref.first.click()
        pg.wait_for_timeout(3500)
    b.close()
