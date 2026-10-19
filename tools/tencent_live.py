"""腾讯官方体验页与当前客户端 + 本地服务联调。只保存结果码，不存票据或会话 URL。"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64,json,time
from pathlib import Path
import requests
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
source=(ROOT/'client/icr-helper.user.js').read_text(encoding='utf-8')
store={'icrh_config_v1':{'localUrl':'http://127.0.0.1:8910','backend':'local','apiKey':'','autoExecute':True,'clickDelayMin':1000,'clickDelayMax':1500},
 'icrh_site_rules_v2':{'cloud.tencent.com':[
  {'id':'official-icon','type':'click','img':'.tencent-captcha-dy__verify-bg-img','hint':'.tencent-captcha-dy__header-answer'},
  {'id':'official-slider','type':'slider','img':'.tencent-captcha-dy__verify-bg-img','handle':'.tencent-captcha-dy__slider-block','piece':'.tencent-captcha-dy__fg-item'}]}}
# GM shim intentionally mirrors network only; no official CAPTCHA callbacks are mocked.
shim='''(()=>{const store=STORE;
window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>{store[k]=v;};window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=o=>window.__xhr(JSON.stringify({url:o.url,method:o.method,data:o.data,headers:o.headers,rt:o.responseType})).then(r=>{
 if(r.error){o.onerror?.(r);return;}
 if(r.b64){const a=Uint8Array.from(atob(r.b64),c=>c.charCodeAt(0));r.response=o.responseType==='blob'?new Blob([a],{type:r.type}):a.buffer;}
 o.onload(r);
});})();'''.replace('STORE',json.dumps(store))
requests_seen=[]
def xhr(payload):
 d=json.loads(payload)
 if d['url'].endswith('/slider'):
  private=ROOT/'reports/private';private.mkdir(parents=True,exist_ok=True)
  (private/'slider-request.json').write_text(d['data'],encoding='utf-8')
 if d['url'].startswith('http://127.0.0.1:8910'):requests_seen.append(d['url'].rsplit('/',1)[-1])
 try:
  r=requests.request(d['method'],d['url'],data=d.get('data'),headers=d.get('headers'),timeout=20)
  out={'status':r.status_code,'responseText':r.text if not d.get('rt') else ''}
  if d.get('rt') in ('blob','arraybuffer'):out.update(b64=base64.b64encode(r.content).decode(),type=r.headers.get('content-type','image/png'))
  return out
 except Exception as e:return {'error':type(e).__name__}
results=[]
with sync_playwright() as p:
 b=p.chromium.launch(**launch_kwargs(), headless=True)
 for kind,selector in [('slider','#captcha_click')]:
  pg=b.new_page(viewport={'width':1400,'height':1000});codes=[];errors=[]
  def response(r):
   if 'cap_union_new_verify' in r.url:
    try:codes.append(str(r.json().get('errorCode')))
    except Exception:pass
  pg.on('response',response);pg.on('pageerror',lambda e:errors.append(str(e)[:150]))
  pg.expose_function('__xhr',xhr);pg.add_init_script(shim+chr(10)+source)
  pg.goto('https://cloud.tencent.com/product/captcha',wait_until='domcontentloaded',timeout=30000)
  for _ in range(100):
   pg.wait_for_timeout(200)
   try:
    if pg.evaluate(f'Boolean(document.querySelector("{selector}")?.onclick)'):break
   except Exception:
    pg.wait_for_timeout(500)
  pg.locator(selector).click()
  before=len(requests_seen);done=''
  for _ in range(140):
   pg.wait_for_timeout(250)
   done=pg.evaluate("[...document.querySelectorAll('#icrh-toast-box div')].map(d=>d.textContent).join(' | ')")
   if '点选完成' in done or '拖动完成' in done or '失败' in done:break
  if kind=='icon' and '点选完成' in done:
   pg.locator('.tencent-captcha-dy__verify-confirm-btn').click(force=True)
  pg.wait_for_timeout(3000)
  results.append({'kind':kind,'notice':done,'api_calls':requests_seen[before:],'verify_codes':codes,'page_errors':errors,
    'buttons':pg.locator('[data-icrh-target]').count()})
  pg.screenshot(path=str(ROOT/'reports'/f'official-{kind}-result.png'));pg.close()
 b.close()
(ROOT/'reports/tencent-integration.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False,indent=2))
