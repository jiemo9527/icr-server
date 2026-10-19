import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
from playwright.sync_api import sync_playwright
from pathlib import Path
import json
with sync_playwright() as p:
 b=p.chromium.launch(**launch_kwargs(), headless=True)
 pg=b.new_page();pg.goto('https://cloud.tencent.com/product/captcha',wait_until='domcontentloaded');pg.wait_for_timeout(6000);pg.locator('#captcha_click').click();pg.wait_for_timeout(8000)
 result=pg.evaluate('''() => [...document.querySelectorAll('#tcaptcha_transform_dy *')].filter(e=>/url\\(/.test(getComputedStyle(e).backgroundImage)||/slider|piece|block|jigsaw/.test(e.className)).map(e=>({tag:e.tagName,cls:e.className,id:e.id,style:(e.getAttribute('style')||'').slice(0,250),bg:getComputedStyle(e).backgroundImage.slice(0,160),rect:{w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}}))''')
 print(json.dumps(result,ensure_ascii=False,indent=1));(Path(__file__).resolve().parents[1]/'reports/private/slider-elements.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');b.close()
