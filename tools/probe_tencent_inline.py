import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
from playwright.sync_api import sync_playwright
from pathlib import Path
import json,time
out=(Path(__file__).resolve().parents[1]/'reports/private')
with sync_playwright() as p:
 b=p.chromium.launch(**launch_kwargs(), headless=True)
 for kind,selector in [('icon','#image_click'),('slider','#captcha_click')]:
  pg=b.new_page(viewport={'width':1400,'height':1000});pg.goto('https://cloud.tencent.com/product/captcha',wait_until='domcontentloaded',timeout=30000)
  for _ in range(60):
   pg.wait_for_timeout(250)
   if pg.evaluate(f'Boolean(document.querySelector("{selector}").onclick)'):break
  pg.locator(selector).click();pg.wait_for_timeout(8000)
  data=pg.evaluate('''() => ({text:document.body.innerText.slice(-240),ids:[...document.querySelectorAll('[id]')].filter(e=>/slide|instruction|tcaptcha|captcha.*bg/i.test(e.id)).map(e=>({id:e.id,cls:e.className,style:(e.getAttribute('style')||'').slice(0,180)})),imgs:[...document.querySelectorAll('img')].filter(e=>/captcha/.test(e.src)).map(e=>({id:e.id,cls:e.className,src:e.src.slice(0,100)})),shadows:[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).map(e=>e.tagName)})''')
  (out/f'{kind}-dom.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
  print(kind,json.dumps(data,ensure_ascii=False,indent=1));pg.screenshot(path=str(out/f'{kind}-loaded.png'));pg.close()
 b.close()
