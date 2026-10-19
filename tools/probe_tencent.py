import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
from playwright.sync_api import sync_playwright
from pathlib import Path
import json
out=(Path(__file__).resolve().parents[1]/'reports/private');out.mkdir(exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(**launch_kwargs(), headless=True)
 page=b.new_page(viewport={'width':1400,'height':1000})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://cloud.tencent.com/product/captcha',wait_until='domcontentloaded',timeout=30000)
 page.wait_for_timeout(3500)
 data=page.evaluate('''() => ({text:document.body.innerText.slice(400,1600),buttons:[...document.querySelectorAll('button,a,[role=button]')].filter(e=>/验证|体验/.test(e.textContent)&&e.getBoundingClientRect().width).map(e=>({tag:e.tagName,id:e.id,cls:e.className,text:e.textContent.trim().slice(0,80)})).slice(-30),iframes:[...document.querySelectorAll('iframe')].map(e=>({id:e.id,src:e.src})),sdk:typeof TencentCaptcha})''')
 page.screenshot(path=str(out/'tencent-initial.png'),full_page=False)
 print(json.dumps(data,ensure_ascii=False,indent=2));print('errors',errors[:5]);b.close()
