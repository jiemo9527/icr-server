"""网易易盾体验页探测：找出文字点选/图标点选（嵌入式）的触发方式、DOM 结构和校验接口。不提交。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/private/yidun'
OUT.mkdir(parents=True, exist_ok=True)
DUMP = '''() => {
  const vis=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;for(let n=e;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||+s.opacity===0)return false;}return true;};
  const pick=[...document.querySelectorAll('[class*="yidun"]')].filter(vis).slice(0,80).map(e=>{const r=e.getBoundingClientRect();
    return {tag:e.tagName,cls:String(e.className).slice(0,90),text:(e.innerText||'').trim().slice(0,30),src:(e.src||'').slice(0,90),
      r:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}});
  const tabs=[...document.querySelectorAll('a,li,button,span,div')].filter(e=>vis(e)&&/文字点选|图标点选|嵌入|弹出|触发|普通/.test((e.innerText||'').trim())&&(e.innerText||'').trim().length<12)
    .map(e=>({tag:e.tagName,cls:String(e.className).slice(0,60),text:(e.innerText||'').trim()}));
  return {url:location.href, frames:window.frames.length, tabs, pick};
}'''
url = sys.argv[1] if len(sys.argv) > 1 else 'https://dun.163.com/trial/jigsaw'
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    reqs = []
    pg.on('response', lambda r: reqs.append((r.status, r.url[:140])) if ('dun.163' in r.url or '126.net' in r.url) and '/api/' in r.url else None)
    pg.goto(url, wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(6000)
    d = pg.evaluate(DUMP)
    print(json.dumps({k: d[k] for k in ('url', 'frames', 'tabs')}, ensure_ascii=False, indent=1))
    print('YIDUN', json.dumps(d['pick'][:40], ensure_ascii=False))
    print('REQS', reqs[:20])
    pg.screenshot(path=str(OUT / 'page.png'), full_page=False)
    b.close()
