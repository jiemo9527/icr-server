"""探查腾讯滑块把手监听哪些事件：分别用 mouse / pointer / touch 合成事件拖动，观察把手 transform/left 是否变化。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
from playwright.sync_api import sync_playwright

PROBE = '''async (mode) => {
  const h = document.querySelector('.tencent-captcha-dy__slider-block');
  if (!h) return {err:'no handle'};
  const before = getComputedStyle(h).transform + '|' + h.style.left + '|' + h.style.transform;
  const r = h.getBoundingClientRect(); const x0 = r.left + r.width/2, y0 = r.top + r.height/2;
  const fire = (t, type, x, y) => {
    let e;
    if (mode === 'touch') {
      const touch = new Touch({identifier: 1, target: h, clientX: x, clientY: y, pageX: x, pageY: y});
      const list = type === 'touchend' ? [] : [touch];
      e = new TouchEvent(type, {bubbles:true, cancelable:true, composed:true, touches:list, targetTouches:list, changedTouches:[touch]});
    } else if (mode === 'pointer') {
      e = new PointerEvent(type, {bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y, pointerId:1, pointerType:'mouse', isPrimary:true, buttons: type==='pointerup'?0:1});
    } else {
      e = new MouseEvent(type, {bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y, buttons: type==='mouseup'?0:1, view: window});
    }
    t.dispatchEvent(e);
  };
  const names = {mouse:['mousedown','mousemove','mouseup'], pointer:['pointerdown','pointermove','pointerup'], touch:['touchstart','touchmove','touchend']}[mode];
  fire(h, names[0], x0, y0);
  let mid = '';
  for (let i = 1; i <= 10; i++) { fire(mode==='touch'?h:document, names[1], x0 + i*8, y0); await new Promise(r=>setTimeout(r,30)); if(i===10) mid = getComputedStyle(h).transform + '|' + h.style.left + '|' + h.style.transform; }
  // 不松手，避免提交，记录中途位置后再还原
  fire(mode==='touch'?h:document, names[1], x0, y0);
  fire(mode==='touch'?h:document, names[2], x0, y0);
  return {mode, before, mid, moved: before !== mid};
}'''

with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    out = []
    for mode in ['mouse', 'pointer', 'touch']:
        pg = b.new_page(viewport={'width': 1400, 'height': 1000}, has_touch=True)
        pg.goto('https://cloud.tencent.com/product/captcha', wait_until='domcontentloaded', timeout=40000)
        for _ in range(100):
            pg.wait_for_timeout(200)
            try:
                if pg.evaluate('Boolean(document.querySelector("#captcha_click")?.onclick)'): break
            except Exception: pg.wait_for_timeout(400)
        pg.locator('#captcha_click').click(); pg.wait_for_timeout(6000)
        out.append(pg.evaluate(PROBE, mode))
        pg.close()
    # 真实(可信)鼠标对照
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    pg.goto('https://cloud.tencent.com/product/captcha', wait_until='domcontentloaded', timeout=40000)
    for _ in range(100):
        pg.wait_for_timeout(200)
        try:
            if pg.evaluate('Boolean(document.querySelector("#captcha_click")?.onclick)'): break
        except Exception: pg.wait_for_timeout(400)
    pg.locator('#captcha_click').click(); pg.wait_for_timeout(6000)
    box = pg.locator('.tencent-captcha-dy__slider-block').bounding_box()
    before = pg.evaluate("(()=>{const h=document.querySelector('.tencent-captcha-dy__slider-block');return getComputedStyle(h).transform+'|'+h.style.left+'|'+h.style.transform})()")
    pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2); pg.mouse.down()
    pg.mouse.move(box['x'] + box['width'] / 2 + 80, box['y'] + box['height'] / 2, steps=10)
    mid = pg.evaluate("(()=>{const h=document.querySelector('.tencent-captcha-dy__slider-block');return getComputedStyle(h).transform+'|'+h.style.left+'|'+h.style.transform})()")
    pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2, steps=5); pg.mouse.up()
    out.append({'mode': 'trusted-mouse', 'before': before, 'mid': mid, 'moved': before != mid})
    b.close()
print(json.dumps(out, ensure_ascii=False, indent=1))
