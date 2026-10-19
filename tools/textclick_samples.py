"""腾讯官方体验页「文字点选」：找到触发按钮，抓取 N 张样本（大图 + 题目文字）存到 reports/private/textclick-samples/。不提交。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / (sys.argv[2] if len(sys.argv) > 2 else 'reports/private/textclick-samples')
OUT.mkdir(parents=True, exist_ok=True)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 8
GRAB = '''async () => {
  const vis=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;for(let n=e;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||+s.opacity===0)return false;}return true;};
  const bg=[...document.querySelectorAll('.tencent-captcha-dy__verify-bg-img')].find(vis);
  if(!bg) return null;
  const head=[...document.querySelectorAll('[class*="tencent-captcha-dy__header"]')].filter(vis).map(e=>({cls:e.className,text:(e.innerText||'').trim().slice(0,40),html:e.innerHTML.slice(0,300)}));
  const u=(getComputedStyle(bg).backgroundImage.match(/url\\(["']?(.*?)["']?\\)/)||[])[1];
  const b=await (await fetch(u)).blob();const data=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(b);});
  const r=bg.getBoundingClientRect();
  return {data, rect:[r.left,r.top,r.width,r.height], head, slider: !!document.querySelector('.tencent-captcha-dy__fg-item') && vis(document.querySelector('.tencent-captcha-dy__fg-item'))};
}'''
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    pg.goto('https://cloud.tencent.com/product/captcha', wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(6000)
    btns = pg.evaluate('''() => [...document.querySelectorAll('[id$="_click"], a, button')].filter(e=>/立即体验/.test(e.innerText||''))
        .map(e=>({id:e.id, title:(e.closest('div[class]')?.parentElement?.innerText||'').split('\\n')[0].slice(0,20)}))''')
    print('BUTTONS', json.dumps(btns, ensure_ascii=False))
    sel = '#text_click'
    print('TEXT BUTTON', sel)
    if not sel:
        sys.exit(1)
    got = 0
    for i in range(N):
        pg.locator(sel).click(); pg.wait_for_timeout(5500)
        g = pg.evaluate(GRAB)
        if g:
            head = ' '.join(h['text'] for h in g['head'] if h['text'])
            (OUT / f'{i:02d}.json').write_text(json.dumps({'hint': head, 'rect': g['rect'], 'head': g['head'], 'image': g['data']}, ensure_ascii=False), encoding='utf-8')
            print(i, head[:40], g['rect'])
            got += 1
        pg.keyboard.press('Escape'); pg.wait_for_timeout(600)
        for c in pg.locator('[class*="header-close"]').all():
            try:
                if c.is_visible(): c.click(timeout=1000)
            except Exception: pass
        pg.wait_for_timeout(2500)
    b.close()
print('saved', got)
