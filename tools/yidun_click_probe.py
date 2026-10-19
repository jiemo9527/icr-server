"""网易易盾体验页：切到 文字点选/图标点选 + 普通版 + 嵌入式，导出 DOM、图片样本和 get/check 接口返回。
用法：yidun_click_probe.py [word|icon] [N]   不点击、不提交，只采样。"""
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
KIND = sys.argv[1] if len(sys.argv) > 1 else 'word'
N = int(sys.argv[2]) if len(sys.argv) > 2 else 3
OUT = ROOT / f'reports/private/yidun/{KIND}'
OUT.mkdir(parents=True, exist_ok=True)
TAB = {'word': '文字点选', 'icon': '图标点选'}[KIND]
DUMP = '''async () => {
  const vis=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;for(let n=e;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||+s.opacity===0)return false;}return true;};
  const all=[...document.querySelectorAll('.yidun [class*="yidun_"]')].filter(vis);
  const items=all.slice(0,60).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,cls:String(e.className).slice(0,80),
    text:(e.innerText||'').trim().slice(0,40),src:(e.src||'').slice(0,100),bg:getComputedStyle(e).backgroundImage.slice(0,80),
    r:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}});
  const bg=[...document.querySelectorAll('.yidun_bg-img')].find(vis);
  let data=null,nat=null;
  if(bg){const b=await (await fetch(bg.src)).blob();data=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(b);});
    nat=[bg.naturalWidth,bg.naturalHeight];}
  const tip=[...document.querySelectorAll('.yidun_tips__text,.yidun_tips__point,.yidun_tips__content')].filter(vis).map(e=>({cls:e.className,text:(e.innerText||'').trim(),html:e.innerHTML.slice(0,300)}));
  const r=bg&&bg.getBoundingClientRect();
  const ti=[...document.querySelectorAll('.yidun_tips__img')].find(e=>vis(e)&&e.src);
  let hintImg=null;
  if(ti){const b=await (await fetch(ti.src)).blob();hintImg=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(b);});}
  return {items,tip,bgRect:r&&[r.left,r.top,r.width,r.height],nat,data,hintImg};
}'''
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    api = []

    def on_resp(r):
        if 'c.dun.163.com/api/' in r.url and ('/get?' in r.url or '/check?' in r.url):
            try: body = r.text()
            except Exception: body = ''
            api.append({'url': r.url.split('?')[0], 'body': body[:600]})
    pg.on('response', on_resp)
    pg.goto('https://dun.163.com/trial/jigsaw', wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(5000)
    pg.get_by_text(TAB, exact=True).first.click(); pg.wait_for_timeout(2500)
    basic = pg.locator('.tcapt-category-tabs__tab', has_text='普通版')
    if basic.count(): basic.first.click(); pg.wait_for_timeout(1000)
    pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click(); pg.wait_for_timeout(5000)
    print('URL', pg.url)
    for i in range(N):
        d = pg.evaluate(DUMP)
        if i == 0:
            print('ITEMS', json.dumps(d['items'], ensure_ascii=False)[:3500])
        print(i, 'TIP', json.dumps(d['tip'], ensure_ascii=False)[:600], 'bgRect', d['bgRect'], 'nat', d['nat'])
        if d['data']:
            (OUT / f'{i:02d}.json').write_text(json.dumps({'tip': d['tip'], 'bgRect': d['bgRect'], 'nat': d['nat'], 'image': d['data'], 'hint_image': d['hintImg']}, ensure_ascii=False), encoding='utf-8')
        pg.screenshot(path=str(OUT / f'{i:02d}.png'))
        ref = pg.locator('.yidun_refresh').filter(visible=True)
        if ref.count(): ref.first.click(); pg.wait_for_timeout(2500)
    print('API', json.dumps(api[-4:], ensure_ascii=False)[:1500])
    b.close()
