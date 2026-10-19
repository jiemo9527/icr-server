const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'icr-helper.user.js'),'utf8');
const windows=[];test.afterEach(()=>{while(windows.length)windows.pop().close();});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function harness(html,rules,cfg={}){
 const dom=new JSDOM(html,{url:'https://fixture.test/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;windows.push(w);const store={icrh_site_rules_v2:{'fixture.test':rules},icrh_config_v1:{...cfg,localUrl:'http://127.0.0.1:8899',backend:'local'}};
 const menus=[],calls=[];let respond;
 w.GM_getValue=(k,d)=>store[k]??d;w.GM_setValue=(k,v)=>{store[k]=v;};w.__icrhTestHooks={};w.GM_registerMenuCommand=(name,fn)=>menus.push({name,fn});
 w.GM_xmlhttpRequest=o=>{calls.push(o.data?JSON.parse(o.data):{method:o.method,url:o.url});respond=(value)=>o.onload({status:200,responseText:JSON.stringify(value)});};
 w.HTMLElement.prototype.getBoundingClientRect=function(){for(let n=this;n;n=n.parentElement)if(n.style.display==='none')return {left:0,top:0,width:0,height:0,right:0,bottom:0};return {left:10,top:10,width:200,height:100,right:210,bottom:110};};
 w.Image=class{set src(v){this.naturalWidth=200;this.naturalHeight=100;setTimeout(()=>this.onload?.(),0);}};
 const shadows=[];const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(o){const s=attach.call(this,o);shadows.push(s);return s;};
 const exposed=source.replace(/\}\)\(\);\s*$/, 'window.__test={scan,getCandidates,recognizeCandidate,solveClick,humanDrag,upsertRule,normalizeLlmPoints};})();');w.eval(exposed);await sleep(30);
 return {w,doc:w.document,store,menus,calls,shadows,reply:r=>respond(r),scan:()=>w.__test.scan()};
}
const text='<img id="code" src="data:image/png;base64,AAAA"><input id="answer">';
const rule={id:'r1',type:'text',img:'#code',input:'#answer'};
test('按钮点击立即变色、运行中防重复，结束显示成功或失败',async()=>{
 const h=await harness(text,[rule]);h.scan();const btn=h.doc.querySelector('[data-icrh-btn]');const color=btn.style.background;
 btn.click();await sleep(30);assert.equal(btn.dataset.state,'running');assert.notEqual(btn.style.background,color);btn.click();assert.equal(h.calls.length,1);
 h.reply({ok:true,text:'ab12'});await sleep(30);assert.equal(btn.dataset.state,'success');assert.equal(h.doc.getElementById('answer').value,'ab12');
 btn.click();await sleep(30);h.reply({ok:false,msg:'uncertain'});await sleep(30);assert.equal(btn.dataset.state,'error');
});
test('自动执行只用于已保存规则，同图成功/失败不重复，换图再执行',async()=>{
 const h=await harness(text,[rule],{autoExecute:true});h.scan();await sleep(50);assert.equal(h.calls.length,1);h.reply({ok:false,msg:'uncertain'});await sleep(30);
 h.scan();await sleep(30);assert.equal(h.calls.length,1);
 h.doc.getElementById('code').src='data:image/png;base64,BBBB';h.scan();await sleep(50);assert.equal(h.calls.length,2);
});
test('自动执行默认关闭，自动探测到的无规则目标不自动发请求',async()=>{
 const manual=await harness(text,[rule]);manual.scan();await sleep(40);assert.equal(manual.calls.length,0);
 const noRule=await harness('<img id="captcha" src="data:image/png;base64,AAAA"><input id="vcode">',[],{autoExecute:true});noRule.scan();await sleep(40);assert.equal(noRule.calls.length,0);
});
test('不同位置多类型验证码各有独立按钮，不一键同时作答',async()=>{
 const h=await harness('<img id="a" src="data:image/png;base64,AAAA"><img id="b" src="data:image/png;base64,BBBB"><div id="handle"></div>',[
  {id:'a',type:'click',img:'#a'},{id:'b',type:'slider',img:'#b',handle:'#handle'}]);h.scan();
 const buttons=h.doc.querySelectorAll('#icrh-fab [data-icrh-target]');assert.equal(buttons.length,2);assert.match(buttons[0].textContent,/点选/);assert.match(buttons[1].textContent,/滑块/);
 buttons[0].click();await sleep(30);assert.equal(h.calls.length,0); // 非腾讯仅本地报错，不执行另一个滑块
 assert.equal(buttons[0].dataset.state,'error');assert.notEqual(buttons[1].dataset.state,'error');
});
test('显式滑块把手隐藏时不能将刷新按钮误认为把手',async()=>{
 const h=await harness('<div><img id="a" src="data:image/png;base64,AAAA"><div id="handle" style="display:none"></div><div id="reload" style="cursor:pointer">刷新</div><div id="hint">请依次点击</div></div>',[
 {id:'c',type:'click',img:'#a',hint:'#hint'},{id:'s',type:'slider',img:'#a',handle:'#handle'}]);
 const list=h.w.__test.getCandidates();assert.equal(list.length,1);assert.equal(list[0].type,'click');
});

test('父级 opacity=0 的配套元素不能令隐藏规则变成可用',async()=>{
 const h=await harness('<div><img id="a" src="data:image/png;base64,AAAA"><div style="opacity:0"><div id="hint">请依次点击</div></div><div id="handle"></div><span>拖动滑块</span></div>',[
 {id:'c',type:'click',img:'#a',hint:'#hint'},{id:'s',type:'slider',img:'#a',handle:'#handle'}]);
 const list=h.w.__test.getCandidates();assert.equal(list.length,1);assert.equal(list[0].type,'slider');
});

test('识别响应到达前换图时不填旧答案，按钮恢复待识别',async()=>{
 const h=await harness(text,[rule]);h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(30);
 h.doc.getElementById('code').src='data:image/png;base64,BBBB';h.reply({ok:true,text:'old'});await sleep(40);
 assert.equal(h.doc.getElementById('answer').value,'');assert.equal(h.doc.querySelector('[data-icrh-btn]').dataset.state,'idle');
});
test('识别期间原目标移除时不填写旧输入框',async()=>{
 const h=await harness(text,[rule]);h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(30);
 h.doc.getElementById('code').remove();h.reply({ok:true,text:'old'});await sleep(40);assert.equal(h.doc.getElementById('answer').value,'');
});
test('运行中换图再点也不并发；完成后新图可重新识别',async()=>{
 const h=await harness(text,[rule]);h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(30);
 h.doc.getElementById('code').src='data:image/png;base64,BBBB';h.scan();const btn=h.doc.querySelector('[data-icrh-btn]');
 assert.equal(btn.disabled,true);btn.click();await sleep(30);assert.equal(h.calls.length,1);
 h.reply({ok:true,text:'old'});await sleep(40);btn.click();await sleep(30);assert.equal(h.calls.length,2);h.reply({ok:true,text:'new'});await sleep(30);assert.equal(h.doc.getElementById('answer').value,'new');
});

test('按规则自动执行开关覆盖全局开关',async()=>{
 const off=await harness(text,[{...rule,autoExecute:false}],{autoExecute:true});off.scan();await sleep(40);assert.equal(off.calls.length,0);
 const on=await harness(text,[{...rule,autoExecute:true}],{autoExecute:false});on.scan();await sleep(40);assert.equal(on.calls.length,1);
});
test('手动执行同一张图后开启自动执行不会重复请求',async()=>{
 const h=await harness(text,[rule]);h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(30);h.reply({ok:true,text:'ab12'});await sleep(30);
 h.store.icrh_config_v1.autoExecute=true;h.scan();await sleep(50);assert.equal(h.calls.length,1);
});
test('每次扫描同步其他框架保存的配置',async()=>{
 const h=await harness(text,[rule]);h.store.icrh_config_v1={...h.store.icrh_config_v1,autoExecute:true};h.scan();await sleep(40);assert.equal(h.calls.length,1);
});
test('规则后端优先于按类型和全局后端',async()=>{
 const h=await harness(text,[{...rule,backend:'llm'}],{backendByType:{text:'local'}});h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(40);
 assert.equal(h.calls.length,0);assert.equal(h.doc.querySelector('[data-icrh-btn]').dataset.state,'error');
});

test('规则管理器的后端和自动执行选择器独立保存',async()=>{
 const h=await harness(text,[rule]);h.menus.find(m=>m.name.includes('规则管理')).fn();const shadow=h.shadows.at(-1);
 const backend=shadow.querySelector('select[data-rule-backend]'),auto=shadow.querySelector('select[data-rule-auto]');assert.ok(backend);assert.ok(auto);
 backend.value='local';backend.dispatchEvent(new h.w.Event('change'));assert.equal(h.store.icrh_site_rules_v2['fixture.test'][0].backend,'local');
 const current=h.shadows.at(-1).querySelector('select[data-rule-auto]');current.value='off';current.dispatchEvent(new h.w.Event('change'));assert.equal(h.store.icrh_site_rules_v2['fixture.test'][0].autoExecute,false);
});
test('点选等待期间验证变化时停止后续点击',async()=>{
 const h=await harness('<img id="a" src="data:image/png;base64,AAAA">',[],{clickDelayMin:30,clickDelayMax:30});let current=true,count=0;const el=h.doc.getElementById('a');
 el.addEventListener('click',()=>{count++;current=false;});
 await assert.rejects(h.w.__test.solveClick({el},[{x_ratio:.2,y_ratio:.3},{x_ratio:.5,y_ratio:.6}],()=>{if(!current)throw new Error('changed');}),/changed/);assert.equal(count,1);
});
test('拖动中关闭验证时释放鼠标并停止后续移动',async()=>{
 const h=await harness('<div id="handle"></div>',[]);const el=h.doc.getElementById('handle');let moving=0,up=0;
 h.doc.addEventListener('mousemove',()=>moving++);h.doc.addEventListener('mouseup',()=>up++);
 await assert.rejects(h.w.__test.humanDrag(el,10,10,100,()=>{if(moving>0)throw new Error('closed');}),/closed/);
 const stopped=moving;await sleep(100);assert.equal(moving,stopped);assert.equal(up,1);
});

test('弹窗隐藏或规则停用后迟到响应不能填写',async()=>{
 for(const action of ['hide','disable']){
  const h=await harness(text,[{...rule}]);h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(30);
  if(action==='hide')h.doc.getElementById('code').style.display='none';else h.store.icrh_site_rules_v2['fixture.test'][0].enabled=false;
  h.reply({ok:true,text:'old'});await sleep(40);assert.equal(h.doc.getElementById('answer').value,'');
 }
});
test('全部点选坐标先校验，包含越界或非数值时一个也不点击',async()=>{
 const h=await harness('<img id="a" src="data:image/png;base64,AAAA">',[]);const el=h.doc.getElementById('a');let count=0;el.addEventListener('click',()=>count++);
 for(const invalid of [NaN,Infinity,-.1,1.1,'0.5']){
  await assert.rejects(h.w.__test.solveClick({el},[{x_ratio:.2,y_ratio:.3},{x_ratio:invalid,y_ratio:.6}]),/坐标/);
 }
 assert.equal(count,0);
});

test('本地失败返回前换图时不得继续发送大模型请求',async()=>{
 const h=await harness(text,[{...rule,backend:'auto'}],{apiKey:'test',llmFallback:true});h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(30);
 h.doc.getElementById('code').src='data:image/png;base64,BBBB';h.reply({ok:false,msg:'uncertain'});await sleep(50);assert.equal(h.calls.length,1);assert.equal(h.doc.getElementById('answer').value,'');
});

test('设置面板分为常用/识别引擎/规则/高级四个标签页，切换只显示一页',async()=>{
 const h=await harness(text,[rule]);h.menus.find(m=>m.name.includes('设置')).fn();const s=h.shadows.at(-1);
 const tabs=[...s.querySelectorAll('[data-tab]')].map(t=>t.textContent.trim());assert.deepEqual(tabs,['常用','识别引擎','规则','高级']);
 const shown=()=>[...s.querySelectorAll('[data-page]')].filter(p=>!p.hidden).map(p=>p.dataset.page);
 assert.deepEqual(shown(),['common']);
 s.querySelector('[data-tab="engine"]').click();assert.deepEqual(shown(),['engine']);
 assert.ok(s.querySelector('[data-page="engine"] #icrh-backend'));assert.ok(s.querySelector('[data-page="advanced"] #icrh-prompt-text'));
 assert.ok(s.querySelector('[data-page="common"] #icrh-auto-execute'));assert.ok(s.querySelector('[data-page="common"] #icrh-local-url'));
});
test('设置规则页列出本站规则，可直接切换启用/后端/自动执行',async()=>{
 const h=await harness(text,[rule]);h.menus.find(m=>m.name.includes('设置')).fn();let s=h.shadows.at(-1);
 s.querySelector('[data-tab="rules"]').click();
 const row=s.querySelector('[data-page="rules"] [data-rule-id="r1"]');assert.ok(row);assert.match(row.textContent,/当前页可用/);
 row.querySelector('select[data-rule-backend]').value='llm';row.querySelector('select[data-rule-backend]').dispatchEvent(new h.w.Event('change'));
 assert.equal(h.store.icrh_site_rules_v2['fixture.test'][0].backend,'llm');
 s=h.shadows.at(-1);assert.ok(!s.querySelector('[data-page="rules"]').hidden,'保存后仍停留在规则页');
});
test('设置有未保存修改时关闭需确认；保存按钮常驻底部',async()=>{
 const h=await harness(text,[rule]);h.menus.find(m=>m.name.includes('设置')).fn();const s=h.shadows.at(-1);
 assert.ok(s.querySelector('.icrh-footer .icrh-save'));
 const input=s.querySelector('#icrh-local-url');input.value='http://127.0.0.1:9999';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
 let asked=0;h.w.confirm=()=>{asked++;return false;};s.querySelector('.icrh-close').click();
 assert.equal(asked,1);assert.ok(h.doc.getElementById('icrh-settings-host'),'取消后面板仍在');
 h.w.confirm=()=>true;s.querySelector('.icrh-close').click();assert.equal(h.doc.getElementById('icrh-settings-host'),null);
});
test('常用页显示本地服务状态检测结果',async()=>{
 const h=await harness(text,[rule]);h.menus.find(m=>m.name.includes('设置')).fn();const s=h.shadows.at(-1);
 s.querySelector('.icrh-test-local').click();await sleep(10);h.reply({ok:true,auth_ok:true,auth_required:false,endpoints:['/ocr']});await sleep(20);
 assert.match(s.querySelector('#icrh-local-status').textContent,/可用/);
});

test('自动执行连续换图最多 2 次，目标消失后才重置，防止失败→换图→再执行的循环',async()=>{
 const h=await harness(text,[rule],{autoExecute:true});const code=h.doc.getElementById('code');
 for(const [i,src] of ['AAAA','BBBB','CCCC'].entries()){code.src='data:image/png;base64,'+src;h.scan();await sleep(50);if(h.calls.length>i){h.reply({ok:false,msg:'x'});await sleep(30);}}
 assert.equal(h.calls.length,2);
 code.remove();h.scan();await sleep(30);h.doc.body.prepend(code);code.src='data:image/png;base64,DDDD';h.scan();await sleep(50);assert.equal(h.calls.length,3);
});

test('油猴菜单只保留设置和规则管理',async()=>{
 const h=await harness(text,[rule]);assert.deepEqual(h.menus.filter(m=>!m.name.startsWith('__')).map(m=>m.name.replace(/^[^\u4e00-\u9fff]+/u,'')),['设置','规则管理']);
});
test('菜单回调传入事件对象时设置仍默认显示常用页，不空白',async()=>{
 const h=await harness(text,[rule]);h.menus.find(m=>m.name.includes('设置')).fn({type:'click'});const s=h.shadows.at(-1);
 assert.deepEqual([...s.querySelectorAll('[data-page]')].filter(p=>!p.hidden).map(p=>p.dataset.page),['common']);
});
test('大模型 Key 与测试连接位于识别引擎页',async()=>{
 const h=await harness(text,[rule]);h.menus.find(m=>m.name.includes('设置')).fn();const s=h.shadows.at(-1);
 for(const sel of ['#icrh-key','.icrh-test','#icrh-url','#icrh-model'])assert.ok(s.querySelector('[data-page="engine"] '+sel),sel);
 assert.equal(s.querySelector('[data-page="common"] #icrh-key'),null);
});
test('无规则且类型不明确的图片不显示任何按钮、不做任何事',async()=>{
 const h=await harness('<div class="captcha-box"><img class="captcha-img" src="data:image/png;base64,AAAA" alt="captcha"><div class="slider-btn" style="cursor:pointer"></div></div>',[],{autoExecute:true});
 h.scan();await sleep(40);assert.equal(h.doc.querySelectorAll('[data-icrh-target],[data-icrh-btn]').length,0);assert.equal(h.calls.length,0);
});
const OLD_TC='<div id="instruction" class="tc-title"><span id="instructionText">请依次点击：</span><img src="data:image/png;base64,SPRITE"></div><div id="slideBg" class="tc-bg-img" style="background-image:url(data:image/png;base64,BGBG)"></div>';
const DY_SLIDER='<div id="tcaptcha_transform_dy"><div class="tencent-captcha-dy__header-answer"><img src="data:image/png;base64,HDR"></div><div class="tencent-captcha-dy__verify-bg-img" style="background-image:url(data:image/png;base64,BGBG)"></div><div class="tencent-captcha-dy__fg-item" style="background-image:url(data:image/png;base64,PIECE)"></div><div class="tencent-captcha-dy__slider-block"></div></div>';
const DY_TEXT='<div id="tcaptcha_transform_dy"><div class="tencent-captcha-dy__header-text">请依次点击：驳 把 布 </div><div class="tencent-captcha-dy__header-answer"></div><div class="tencent-captcha-dy__verify-bg-img" style="background-image:url(data:image/png;base64,BGBG)"></div><div class="tencent-captcha-dy__slider-block"></div></div>';
test('不再自动识别类型：腾讯图标点选 / 文字点选 / 滑块未设规则时都不显示按钮、不请求',async()=>{
 for(const html of [OLD_TC,DY_SLIDER,DY_TEXT]){
  const h=await harness(html,[],{autoExecute:true});h.scan();await sleep(30);
  assert.equal(h.doc.querySelectorAll('[data-icrh-target],[data-icrh-btn]').length,0,html.slice(0,40));assert.equal(h.calls.length,0);
 }
});
test('腾讯旧版图标点选设了规则后走本地 /solve',async()=>{
 const h=await harness(OLD_TC,[{id:'i',type:'click',img:'#slideBg',hint:'#instruction'}]);
 h.scan();const btns=h.doc.querySelectorAll('#icrh-fab [data-icrh-target]');assert.equal(btns.length,1);assert.match(btns[0].textContent,/点选/);
 // 题目只有图片：先问 /textclick 图片里是不是汉字，服务端说不是（图标条）再走 /solve
 btns[0].click();await sleep(40);assert.equal(h.calls.length,1);assert.ok(h.calls[0].bg&&h.calls[0].hint_image,'先发题目图到 /textclick');
 h.reply({ok:false,reason:'hint_not_text',points:[],width:340,height:240});await sleep(60);
 assert.equal(h.calls.length,2);assert.ok(h.calls[1].bg&&h.calls[1].sprite,'再调用 /solve');
});
test('悬浮面板按下时不捕获指针（否则 click 落到面板，按钮点了没反应）',async()=>{
 const h=await harness(OLD_TC,[{id:'i',type:'click',img:'#slideBg',hint:'#instruction'}]);
 h.scan();const panel=h.doc.getElementById('icrh-fab');let captured=0;panel.setPointerCapture=()=>{captured++;};
 const btn=panel.querySelector('[data-icrh-target]');const ev=(t,x)=>btn.dispatchEvent(new h.w.MouseEvent(t,{bubbles:true,button:0,clientX:x,clientY:5}));
 ev('pointerdown',5);ev('pointerup',5);assert.equal(captured,0);
 ev('pointerdown',5);ev('pointermove',40);assert.equal(captured,1,'拖动后才捕获');ev('pointerup',40);
});
test('腾讯新版文字点选设了规则后调用本地 /textclick',async()=>{
 const h=await harness(DY_TEXT,[{id:'t',type:'click',img:'.tencent-captcha-dy__verify-bg-img',hint:'.tencent-captcha-dy__header-text'}],{backend:'local'});
 h.scan();const btns=[...h.doc.querySelectorAll('#icrh-fab [data-icrh-target]')];assert.equal(btns.length,1);
 btns[0].click();await sleep(40);assert.equal(h.calls.length,1);assert.match(h.calls[0].targets,/驳 把 布/);assert.ok(h.calls[0].bg);
});
test('大模型返回像素坐标或千分比时换算为比例，单位不明时不猜',async()=>{
 const h=await harness(text,[rule]);const n=h.w.__test.normalizeLlmPoints;
 assert.deepEqual(n([{x_ratio:.5,y_ratio:.25}],672,480).map(p=>[p.x_ratio,p.y_ratio]),[[.5,.25]]);
 assert.deepEqual(n([{x:336,y:240},{x:672,y:120}],672,480).map(p=>[p.x_ratio,p.y_ratio]),[[.5,.5],[1,.25]]);
 assert.deepEqual(n([[500,800]],300,200).map(p=>[p.x_ratio,p.y_ratio]),[[.5,.8]]);
 assert.ok(n([{x_ratio:5000,y_ratio:10}],300,200)[0].x_ratio>1,'超出像素和千分比范围保持原样，由 solveClick 拒绝');
});
test('同一网站同一类型可添加多条规则（不同选择器追加，完全相同才更新）',async()=>{
 const h=await harness(text,[]);h.w.__test.upsertRule('fixture.test',{type:'text',img:'#code',input:'#answer'});
 h.w.__test.upsertRule('fixture.test',{type:'text',img:'#code',input:'#other'});
 h.w.__test.upsertRule('fixture.test',{type:'text',img:'#code2',input:'#answer'});
 const again=h.w.__test.upsertRule('fixture.test',{type:'text',img:'#code',input:'#answer'});
 assert.equal(h.store.icrh_site_rules_v2['fixture.test'].length,3);assert.equal(again.updated,true);
});

test('同一图多类型同分不可确定时不猜、不自动执行，每条规则一个按钮让用户选',async()=>{
 const h=await harness('<img id="a" src="data:image/png;base64,AAAA"><div id="handle"></div><div id="hint">a</div>',[
  {id:'a',type:'click',img:'#a',hint:'#hint'},{id:'b',type:'slider',img:'#a',handle:'#handle'}],{autoExecute:true});h.scan();await sleep(40);
 assert.equal(h.calls.length,0);const btns=[...h.doc.querySelectorAll('#icrh-fab [data-icrh-target]')];assert.equal(btns.length,2);
 assert.match(btns[0].textContent,/规则1/);assert.match(btns[1].textContent,/规则2/);
});
const TWO_INPUTS='<img id="code" src="data:image/png;base64,AAAA"><input id="answer"><input id="answer2">';
const SAME_TYPE=[{id:'t1',type:'text',img:'#code',input:'#answer'},{id:'t2',type:'text',img:'#code',input:'#answer2'}];
test('同一元素多条同类型规则：不同时自动执行，用按钮选其一，只执行所选规则',async()=>{
 const h=await harness(TWO_INPUTS,SAME_TYPE,{autoExecute:true});h.scan();await sleep(50);
 assert.equal(h.calls.length,0,'不自动执行');
 assert.equal(h.doc.querySelectorAll('[data-icrh-btn]').length,0,'不在输入框旁挂单一按钮，避免替用户选');
 const btns=[...h.doc.querySelectorAll('#icrh-fab [data-icrh-target]')];assert.equal(btns.length,2);
 assert.match(btns[0].textContent,/文本验证码.*规则1/);assert.match(btns[1].textContent,/规则2/);assert.match(btns[1].title,/answer2/);
 btns[1].click();await sleep(30);assert.equal(h.calls.length,1);
 assert.equal(btns[1].dataset.state,'running');assert.equal(btns[0].dataset.state,'idle');assert.equal(btns[0].disabled,true,'同一元素其他规则执行期间禁用');
 h.reply({ok:true,text:'ab12'});await sleep(40);assert.equal(btns[0].disabled,false);
 assert.equal(h.doc.getElementById('answer2').value,'ab12');assert.equal(h.doc.getElementById('answer').value,'');
 h.scan();await sleep(40);assert.equal(h.calls.length,1,'选过之后也不自动再跑');
});
test('不同元素上同类型的多个目标也不同时自动执行',async()=>{
 const h=await harness('<img id="a" src="data:image/png;base64,AAAA"><input id="ia"><img id="b" src="data:image/png;base64,BBBB"><input id="ib">',
  [{id:'x',type:'text',img:'#a',input:'#ia'},{id:'y',type:'text',img:'#b',input:'#ib'}],{autoExecute:true});h.scan();await sleep(50);
 assert.equal(h.calls.length,0);assert.equal(h.doc.querySelectorAll('#icrh-fab [data-icrh-target]').length,2);
});
test('悬停选择按钮时高亮对应目标，移开恢复',async()=>{
 const h=await harness(TWO_INPUTS,SAME_TYPE);h.scan();const btn=h.doc.querySelectorAll('#icrh-fab [data-icrh-target]')[1];
 const before=h.doc.getElementById('answer2').style.outline;
 btn.dispatchEvent(new h.w.MouseEvent('mouseenter'));assert.match(h.doc.getElementById('answer2').style.outline,/solid/);
 btn.dispatchEvent(new h.w.MouseEvent('mouseleave'));assert.equal(h.doc.getElementById('answer2').style.outline,before);
});

test('脚本头不沿用原始名称/作者/更新地址；弹出消息无前缀',async()=>{
 const head=source.slice(0,source.indexOf('// ==/UserScript=='));
 assert.match(head,/@name\s+ICR 验证码助手/);
 for(const bad of [/AI Captcha Solver/,/ai-captcha-solver/,/多模态大模型版/,/greasyfork/i,/@downloadURL/,/@updateURL/])assert.doesNotMatch(head,bad);
 assert.doesNotMatch(source,/\[AI验证码\]/);
 const h=await harness(text,[rule]);h.scan();h.doc.querySelector('[data-icrh-btn]').click();await sleep(20);h.reply({ok:true,text:'ab12'});await sleep(40);
 const msgs=[...h.doc.querySelectorAll('#icrh-toast-box div')].map(d=>d.textContent);
 assert.ok(msgs.length,'有提示');for(const m of msgs)assert.doesNotMatch(m,/^\[/,m);
});

test('设置/规则窗口内按键不冒泡到页面（防止网站单键快捷键抢走焦点）',async()=>{
 const h=await harness(text,[rule]);const seen=[];
 for(const t of ['keydown','keypress','keyup','input'])h.doc.addEventListener(t,e=>seen.push(t));
 h.menus.find(m=>m.name.includes('设置')).fn();const s=h.shadows.at(-1);const inp=s.querySelector('#icrh-local-url');
 for(const t of ['keydown','keypress','keyup'])inp.dispatchEvent(new h.w.KeyboardEvent(t,{key:'s',bubbles:true,composed:true}));
 inp.dispatchEvent(new h.w.Event('input',{bubbles:true,composed:true}));
 h.menus.find(m=>m.name.includes('规则管理')).fn();const r=h.shadows.at(-1);const any=r.querySelector('button')||r.firstElementChild;
 any.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'/',bubbles:true,composed:true}));
 assert.deepEqual(seen,[]);
});

test('规则页可为点选规则选择本地点选方式并保存，非点选规则不显示该选项',async()=>{
 const h=await harness('<img id="code" src="data:image/png;base64,AAAA"><input id="answer"><div id="hint">请依次点击</div>',[rule,{id:'c1',type:'click',img:'#code',hint:'#hint'}]);
 h.menus.find(m=>m.name.includes('设置')).fn('rules');const s=h.shadows.at(-1);
 assert.equal(s.querySelector('[data-rule-id="r1"] select[data-rule-localclick]'),null);
 const sel=s.querySelector('[data-rule-id="c1"] select[data-rule-localclick]');assert.ok(sel);
 assert.deepEqual([...sel.options].map(o=>o.value),['auto','icon','text','off']);
 sel.value='text';sel.dispatchEvent(new h.w.Event('change'));
 assert.equal(h.store.icrh_site_rules_v2['fixture.test'].find(r=>r.id==='c1').localClick,'text');
 const again=h.shadows.at(-1).querySelector('[data-rule-id="c1"] select[data-rule-localclick]');again.value='auto';again.dispatchEvent(new h.w.Event('change'));
 assert.equal('localClick' in h.store.icrh_site_rules_v2['fixture.test'].find(r=>r.id==='c1'),false);
});

test('点选前模拟鼠标移动轨迹：多个 move 事件逐步逼近目标，按下有停顿，坐标带 screenX/Y',async()=>{
 // 间隔设 0 时轨迹不等待，但仍完整派发；harness 布局固定 200x100 于 (10,10)，目标中心 (110,60)
 const h=await harness('<img id="a" src="data:image/png;base64,AAAA">',[{id:'c',type:'click',img:'#a'}],{clickDelayMin:0,clickDelayMax:0});
 const el=h.doc.getElementById('a');h.doc.elementsFromPoint=()=>[el];const seq=[];
 for(const t of ['mousemove','pointermove','mousedown','mouseup','click'])el.addEventListener(t,e=>seq.push({t,x:e.clientX,y:e.clientY,sx:e.screenX,at:Date.now()}));
 const cand=h.w.__test.getCandidates()[0];
 await h.w.__test.solveClick(cand,[{x_ratio:.5,y_ratio:.5},{x_ratio:.9,y_ratio:.2}]);
 const types=seq.map(e=>e.t);const firstDown=types.indexOf('mousedown');
 assert.ok(types.slice(0,firstDown).filter(t=>t==='mousemove').length>=8,'第一次点击前有多个 mousemove');
 assert.ok(types.slice(0,firstDown).includes('pointermove'),'同时有 pointermove');
 const lastMove=seq.slice(0,firstDown).filter(e=>e.t==='mousemove').at(-1);
 assert.ok(Math.abs(lastMove.x-110)<=2&&Math.abs(lastMove.y-60)<=2,'轨迹终点在目标附近');
 const moves=seq.slice(0,firstDown).filter(e=>e.t==='mousemove');
 assert.ok(moves.some(e=>Math.hypot(e.x-110,e.y-60)>40),'轨迹从远处开始');
 const down=seq[firstDown],up=seq[types.indexOf('mouseup')];assert.ok(up.at-down.at>=30,'按下到抬起有停顿');
 assert.equal(down.x,110);assert.equal(down.y,60);assert.ok(Number.isFinite(down.sx)&&down.sx>=down.x,'screenX 已填');
 const secondDown=types.indexOf('mousedown',firstDown+1);
 assert.ok(types.slice(firstDown+1,secondDown).filter(t=>t==='mousemove').length>=8,'第二次点击前也有轨迹');
 assert.equal(types.filter(t=>t==='click').length,2);
});

const EDIT_HTML='<img id="bg" src="data:image/png;base64,AAAA"><div id="h1"></div><div id="h2"></div><img id="pc" src="data:image/png;base64,BBBB">';
const EDIT_RULES=()=>[{id:'s1',type:'slider',img:'#bg',handle:'#h1'},{id:'c1',type:'click',img:'#bg',localClick:'text'}];
test('规则管理：本站规则显示编号「规则N」，可编辑选择器并保存，id 与其他规则不变',async()=>{
 const h=await harness(EDIT_HTML,EDIT_RULES());h.menus.find(m=>m.name.includes('规则管理')).fn();const r=h.shadows.at(-1);
 const rows=()=>[...r.querySelectorAll('.host[data-host="fixture.test"] .rule')];
 assert.deepEqual(rows().map(x=>x.querySelector('.no').textContent),['规则1','规则2']);
 rows()[0].querySelector('button.edit').click();
 const form=rows()[0].querySelector('.icrh-edit');assert.ok(form,'出现编辑表单');
 const field=k=>form.querySelector('input[data-field="'+k+'"]');
 assert.equal(field('handle').value,'#h1');assert.equal(field('hint'),null,'滑块规则没有题目字段');
 assert.equal(field('full'),null,'没有完整背景字段');assert.doesNotMatch(form.textContent,/完整背景/);
 field('handle').value='#h2';field('piece').value='#pc';
 form.querySelector('.icrh-edit-save').click();
 const saved=h.store.icrh_site_rules_v2['fixture.test'];
 assert.deepEqual(saved.map(x=>x.id),['s1','c1']);
 assert.equal(saved[0].handle,'#h2');assert.equal(saved[0].piece,'#pc');
 assert.deepEqual(JSON.parse(JSON.stringify(saved[1])),{id:'c1',type:'click',img:'#bg',localClick:'text'},'其他规则原样不动');
 assert.equal(rows()[0].querySelector('.icrh-edit'),null,'保存后收起表单');
 assert.match(rows()[0].textContent,/滑块: #h2/);
});
test('规则编辑：选择器语法错误或必填项为空时不保存，并提示原因',async()=>{
 const h=await harness(EDIT_HTML,EDIT_RULES());h.menus.find(m=>m.name.includes('规则管理')).fn();const r=h.shadows.at(-1);
 const row=()=>r.querySelector('.rule[data-rule-id="s1"]');
 row().querySelector('button.edit').click();let form=row().querySelector('.icrh-edit');
 form.querySelector('input[data-field="handle"]').value='div[';form.querySelector('.icrh-edit-save').click();
 assert.equal(h.store.icrh_site_rules_v2['fixture.test'][0].handle,'#h1');
 assert.match(form.querySelector('.icrh-edit-err').textContent,/滑块把手.*语法错误/);
 form.querySelector('input[data-field="handle"]').value='#h2';form.querySelector('input[data-field="img"]').value='  ';form.querySelector('.icrh-edit-save').click();
 assert.equal(h.store.icrh_site_rules_v2['fixture.test'][0].img,'#bg');
 assert.match(form.querySelector('.icrh-edit-err').textContent,/背景大图.*不能为空/);
 form.querySelector('.icrh-edit-cancel').click();assert.equal(row().querySelector('.icrh-edit'),null);
});
test('规则编辑：当前页面实时提示选择器匹配情况',async()=>{
 const h=await harness(EDIT_HTML,EDIT_RULES());h.menus.find(m=>m.name.includes('规则管理')).fn();const r=h.shadows.at(-1);
 r.querySelector('.rule[data-rule-id="s1"] button.edit').click();const form=r.querySelector('.rule[data-rule-id="s1"] .icrh-edit');
 const st=k=>form.querySelector('input[data-field="'+k+'"]').parentElement.querySelector('.icrh-edit-st').textContent;
 assert.match(st('handle'),/匹配 1 个/);
 const inp=form.querySelector('input[data-field="piece"]');inp.value='#nope';inp.dispatchEvent(new h.w.Event('input'));
 assert.match(st('piece'),/未找到/);
});
test('设置「规则」页同样显示编号并可编辑',async()=>{
 const h=await harness(EDIT_HTML,EDIT_RULES());h.menus.find(m=>m.name.includes('设置')).fn('rules');const s=h.shadows.at(-1);
 const row=()=>s.querySelector('[data-rule-id="c1"]');
 assert.match(s.querySelector('[data-rule-id="s1"] .icrh-no').textContent,/规则1/);assert.match(row().querySelector('.icrh-no').textContent,/规则2/);
 [...row().querySelectorAll('button')].find(b=>b.textContent==='编辑').click();
 const form=row().querySelector('.icrh-edit');form.querySelector('input[data-field="hint"]').value='#h2';form.querySelector('.icrh-edit-save').click();
 assert.equal(h.store.icrh_site_rules_v2['fixture.test'][1].hint,'#h2');
});

// 网易滑块页：点选规则的大图是 img.yidun_bg-img，滑块规则的大图是外层 div.yidun_panel（两个不同元素，但同一个验证码）
const YIDUN_JIGSAW='<div class="yidun"><div class="yidun_panel"><img class="yidun_bg-img" alt="验证码背景" src="data:image/png;base64,AAAA">'+
 '<img class="yidun_jigsaw" alt="验证码滑块" src="data:image/png;base64,BBBB"></div>'+
 '<div class="yidun_control"><div class="yidun_slider"></div><span class="yidun_tips__content">向右拖动滑块填充拼图</span>'+
 '<div class="yidun_tips__answer hide" style="display:none"><span class="yidun_tips__point"></span></div></div></div>';
const YIDUN_RULES=()=>[{id:'c1',type:'click',img:'img[alt="验证码背景"]',hint:'span.yidun_tips__point'},
 {id:'c2',type:'click',img:'img[alt="验证码背景"]',hint:'div.yidun_tips__answer'},
 {id:'s1',type:'slider',img:'div.yidun_panel',handle:'div.yidun_slider',piece:'img[alt="验证码滑块"]'}];
test('网易滑块页：点选规则的题目不在时不出现点选按钮，只执行滑块规则',async()=>{
 const h=await harness(YIDUN_JIGSAW,YIDUN_RULES(),{autoExecute:true});
 const list=h.w.__test.getCandidates();
 assert.deepEqual(JSON.parse(JSON.stringify(list.map(c=>c.type))),['slider'],'只剩滑块');
 // 单独看点选规则2：题目容器 .yidun_tips__answer 被隐藏（display:none），即使外层可见也不算题目在
 const only=await harness(YIDUN_JIGSAW,[YIDUN_RULES()[1]]);
 assert.equal(only.w.__test.getCandidates().length,0,'隐藏的题目容器不能因父元素可见而算作显示');
 h.scan();await sleep(60);
 const btns=[...h.doc.querySelectorAll('#icrh-fab [data-icrh-target]')].map(b=>b.textContent);
 assert.equal(btns.length,1);assert.match(btns[0],/滑块/);
 assert.ok(h.calls.every(c=>!c.targets&&!c.sprite),'没有发出点选识别请求');
});
test('同一个验证码里多条不同类型规则都适用（大图元素不同也算）：不自动执行，按钮让用户选一个',async()=>{
 const html='<div class="cap"><div class="panel"><img id="bg" src="data:image/png;base64,AAAA"></div>'+
  '<div class="hint">题目</div><div class="handle"></div></div>';
 const rules=[{id:'c1',type:'click',img:'#bg',hint:'.hint'},{id:'s1',type:'slider',img:'.panel',handle:'.handle'}];
 const h=await harness(html,rules,{autoExecute:true});
 const list=h.w.__test.getCandidates();
 assert.equal(list.length,2);assert.ok(list.every(c=>c.choice),'都列为待选');
 assert.deepEqual(JSON.parse(JSON.stringify(list.map(c=>c.ruleNo).sort())),[1,2]);
 h.scan();await sleep(80);
 assert.equal(h.calls.length,0,'不自动执行任何一条');
 const btns=[...h.doc.querySelectorAll('#icrh-fab [data-icrh-target]')];
 assert.equal(btns.length,2);assert.ok(btns.every(b=>/规则\d/.test(b.textContent)));
});
test('页面上两个互不相关的验证码（不同弹窗）各自自动执行，不受影响',async()=>{
 const html='<div class="a"><img id="ta" src="data:image/png;base64,AAAA"><input id="ia"></div>'+
  '<div class="b"><img id="cb" src="data:image/png;base64,BBBB"><div id="hb">请依次点击</div></div>';
 const rules=[{id:'t',type:'text',img:'#ta',input:'#ia'},{id:'c',type:'click',img:'#cb',hint:'#hb'}];
 const h=await harness(html,rules);
 const list=h.w.__test.getCandidates();
 assert.equal(list.length,2);assert.ok(list.every(c=>!c.choice));
});

test('滑块自动执行要等大图和拼图块加载完成（含背景图）才执行',async()=>{
 const html='<div id="bg" style="background-image:url(https://img.test/bg.jpg)"></div><img id="pc" src="https://img.test/pc.png"><div id="handle"></div>';
 const loads=[];
 const h=await harness(html,[{id:'s',type:'slider',img:'#bg',handle:'#handle',piece:'#pc'}],{autoExecute:true});
 // 背景图：脚本用 Image 预加载，加载完成前不执行；拼图块 img 未 complete 前不执行
 h.w.Image=class{set src(v){this._s=v;loads.push(this);}get src(){return this._s;}};
 const pc=h.doc.getElementById('pc');let done=false;
 Object.defineProperty(pc,'complete',{configurable:true,get:()=>done});Object.defineProperty(pc,'naturalWidth',{configurable:true,get:()=>done?60:0});
 h.scan();await sleep(60);assert.equal(h.calls.length,0,'图未加载完不执行');
 assert.ok(loads.some(i=>i.src==='https://img.test/bg.jpg'),'预加载背景图');
 done=true;h.scan();await sleep(60);assert.equal(h.calls.length,0,'背景图还没加载完');
 for(const i of loads)i.naturalWidth=320,i.onload?.();
 h.scan();await sleep(60);assert.equal(h.calls.length,0,'刚加载完先稳定一下');
 await sleep(450);h.scan();await sleep(80);
 assert.equal(h.calls.length,1,'加载完成并稳定后执行一次');
});
