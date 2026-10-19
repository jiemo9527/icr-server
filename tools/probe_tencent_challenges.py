import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
from playwright.sync_api import sync_playwright
from pathlib import Path
import json
out=(Path(__file__).resolve().parents[1]/'reports/private')
with sync_playwright() as p:
 b=p.chromium.launch(**launch_kwargs(), headless=True)
 for kind,selector in [('slider','#captcha_click'),('icon','#image_click')]:
  page=b.new_page(viewport={'width':1400,'height':1000});page.goto('https://cloud.tencent.com/product/captcha',wait_until='domcontentloaded');page.wait_for_timeout(2500)
  page.locator(selector).click();page.wait_for_timeout(3500)
  print('KIND',kind,'frames',[f.url[:120] for f in page.frames])
  for f in page.frames:
   if 'captcha' in f.url and f!=page.main_frame:
    print(json.dumps(f.evaluate('''() => ({text:document.body.innerText.slice(-500),imgs:[...document.querySelectorAll('img')].map(e=>({id:e.id,cls:e.className,src:e.src.slice(0,90),w:e.width,h:e.height})),els:[...document.querySelectorAll('[id]')].filter(e=>/slide|drag|bg|instruction|piece/i.test(e.id)).map(e=>({id:e.id,cls:e.className,style:(e.getAttribute('style')||'').slice(0,150)}))})'''),ensure_ascii=False,indent=1))
  page.screenshot(path=str(out/f'tencent-{kind}.png'));page.close()
 b.close()
