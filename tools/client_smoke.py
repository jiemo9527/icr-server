"""Real Chromium + real local OCR; GM HTTP bridge, not Tampermonkey sandbox."""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
import base64
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import requests
from PIL import Image,ImageDraw,ImageFont
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
env={**os.environ,'ICR_HOST':'127.0.0.1','ICR_PORT':str(port),'ICR_TOKEN':''}
server=subprocess.Popen([sys.executable,str(ROOT/'icr_server.py')],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
    for _ in range(120):
        try:
            requests.get(f'http://127.0.0.1:{port}/health',timeout=1).raise_for_status();break
        except requests.RequestException:time.sleep(.25)
    else:raise RuntimeError('local API startup timed out')
    image=Image.new('RGB',(150,45),'white')
    ImageDraw.Draw(image).text((5,3),'ab12',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',32),fill='black')
    buf=io.BytesIO();image.save(buf,'PNG');data='data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()
    store={'icrh_config_v1':{'localUrl':f'http://127.0.0.1:{port}','backend':'local'},'icrh_site_rules_v2':{'client.fixture':[{'id':'r','type':'text','img':'#code','input':'#answer'}]}}
    shim='''(() => {const store=STORE; window.__menus=[];window.__requests=0;window.__replyDelay=0;
    window.GM_getValue=(k,d)=>store[k]??d;window.GM_setValue=(k,v)=>store[k]=v;
    window.__icrhTestHooks={};window.GM_registerMenuCommand=(name,fn)=>window.__menus.push({name,fn});
    window.GM_xmlhttpRequest=o=>{window.__requests++;window.__xhr(JSON.stringify({url:o.url,method:o.method,data:o.data,headers:o.headers})).then(r=>setTimeout(()=>o.onload(r),window.__replyDelay)).catch(e=>o.onerror?.(e));};
    const attach=Element.prototype.attachShadow;window.__shadows=[];
    Element.prototype.attachShadow=function(options){const s=attach.call(this,options);window.__shadows.push(s);return s;};
    window.__store=store;})();'''.replace('STORE',json.dumps(store))
    def xhr(payload):
        d=json.loads(payload);r=requests.request(d['method'],d['url'],data=d['data'],headers=d['headers'],timeout=45)
        return {'status':r.status_code,'responseText':r.text}
    results={}
    with sync_playwright() as p:
        browser=p.chromium.launch(**launch_kwargs(), headless=True)
        page=browser.new_page(viewport={'width':1200,'height':800})
        page.expose_function('__xhr',xhr)
        page.add_init_script(shim+'\n'+(ROOT/'client/icr-helper.user.js').read_text(encoding='utf-8'))
        page.route('http://client.fixture/',lambda route:route.fulfill(content_type='text/html',body=f'<h1>Client smoke fixture</h1><img id="code" src="{data}"><input id="answer">'))
        page.goto('http://client.fixture/')
        button=page.locator('[data-icrh-btn]');button.wait_for()
        button.click();page.wait_for_function("document.querySelector('#answer').value==='ab12'",timeout=60000)
        results['real_ocr_fill']=True
        page.evaluate("document.querySelector('#answer').value='';window.__replyDelay=700")
        button.click();page.wait_for_function("document.querySelector('[data-icrh-btn]').dataset.state==='running'")
        page.evaluate("document.querySelector('#code').src += '#changed'")
        page.wait_for_function("document.querySelector('[data-icrh-btn]').dataset.state==='idle'",timeout=10000)
        assert page.locator('#answer').input_value()==''
        results['stale_reply_discarded']=True
        page.evaluate("window.__menus.find(m=>m.name.includes('规则管理')).fn()")
        page.evaluate("""() => {let s=window.__shadows.at(-1);let b=s.querySelector('[data-rule-backend]');b.value='llm';b.dispatchEvent(new Event('change'));s=window.__shadows.at(-1);let a=s.querySelector('[data-rule-auto]');a.value='off';a.dispatchEvent(new Event('change'));}""")
        saved=page.evaluate("window.__store.icrh_site_rules_v2['client.fixture'][0]")
        assert saved['backend']=='llm' and saved['autoExecute'] is False
        results['rule_controls_saved']=True
        # Fixture hooks above are test-only; the distributed script keeps closed shadow roots.
        results['http_requests']=page.evaluate('window.__requests')
        browser.close()
    print(json.dumps(results))
finally:
    server.terminate();server.wait(timeout=15)
