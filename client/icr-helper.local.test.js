// 识别路由：数字字母 / 腾讯图标点选优先走本地服务（icr_server.py），计算题 / 滑块 / 汉字点选走大模型，本地失败改用大模型
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'icr-helper.user.js'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const opened = [];
test.afterEach(() => { while (opened.length) opened.pop().close(); });

const LOCAL = 'http://127.0.0.1:8899';
const LLM = 'https://api.test/v1/chat/completions';

// net: { '/ocr': fn(body) => json | 'down', '/solve': ..., llm: fn(body) => content }
async function setup({ html, url = 'https://www.example.com/login', cfg = {}, rules = {}, net = {} }) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  opened.push(dom.window);
  const win = dom.window, doc = win.document;
  const host = new URL(url).hostname;
  const store = {
    icrh_config_v1: Object.assign({ apiKey: 'sk-test', apiUrl: LLM, localUrl: LOCAL }, cfg),
    icrh_site_rules_v2: { [host]: rules },
  };
  const menus = [], calls = [];
  win.GM_getValue = (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d);
  win.GM_setValue = (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); };
  win.GM_deleteValue = (k) => { delete store[k]; };
  win.__icrhTestHooks={};win.GM_registerMenuCommand = (name, fn) => menus.push({ name, fn });
  win.GM_xmlhttpRequest = (req) => {
    const body = req.data ? JSON.parse(req.data) : null;
    calls.push({ url: req.url, headers: req.headers || {}, body });
    setTimeout(() => {
      if (req.url === LLM) {
        const content = net.llm ? net.llm(body) : 'UNKNOWN';
        return req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content } }] }) });
      }
      const p = req.url.startsWith(LOCAL) ? req.url.slice(LOCAL.length) : null;
      const h = p && net[p];
      if (!h) return req.onerror && req.onerror({});
      const r = h(body, req.headers || {});
      if (r === 'down') return req.onerror && req.onerror({});
      if (r && r.__status) return req.onload({ status: r.__status, responseText: '{}' });
      req.onload({ status: 200, responseText: JSON.stringify(r) });
    }, 0);
  };
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const w = Number(this.dataset.w || 300), h = Number(this.dataset.h || 150);
    return { left: 10, top: 10, width: w, height: h, right: 10 + w, bottom: 10 + h };
  };
  win.Image = class {
    set src(v) { this._src = v; this.naturalWidth = 340; this.naturalHeight = 240; setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return this._src; }
  };
  win.eval(source);
  await sleep(20);
  const run = async (ms = 1200) => { menus.find(m => m.name.includes('__recognize')).fn(); await sleep(ms); };
  const toasts = () => [...doc.querySelectorAll('#icrh-toast-box div')].map(d => d.textContent);
  const llmCalls = () => calls.filter(c => c.url === LLM);
  const localCalls = (p) => calls.filter(c => c.url === LOCAL + p);
  return { win, doc, store, menus, calls, run, toasts, llmCalls, localCalls };
}

const TEXT_HTML = '<img id="code" src="data:image/png;base64,QUFBQQ==" data-w="100" data-h="40"><input id="vc" type="text">';
const TEXT_RULE = [{ id: 't1', type: 'text', enabled: true, img: '#code', input: '#vc' }];

test('数字字母：本地 OCR 识别出结果就直接填入，不调用大模型', async () => {
  const t = await setup({
    html: TEXT_HTML, rules: TEXT_RULE, cfg: { localToken: 'tok' },
    net: { '/ocr': () => ({ ok: true, text: 'ab12' }) },
  });
  await t.run();
  assert.equal(t.doc.getElementById('vc').value, 'ab12');
  assert.equal(t.localCalls('/ocr').length, 1);
  assert.equal(t.localCalls('/ocr')[0].body.image, 'data:image/png;base64,QUFBQQ==');
  assert.equal(t.localCalls('/ocr')[0].headers['X-ICR-Token'], 'tok');
  assert.equal(t.llmCalls().length, 0);
  assert.ok(t.toasts().some(s => /本地 OCR 识别完成：已填入 ab12/.test(s)), t.toasts().join('|'));
});

test('uni-app 图片：规则选中的 img 是透明的（显示靠同层背景 div），识别时不能误判为「已换图或关闭」', async () => {
  const t = await setup({
    html: '<uni-image class="yzm" data-w="82" data-h="38"><div style="background-image:url(data:image/png;base64,QUFBQQ==)" data-w="82" data-h="38"></div>' +
      '<img src="data:image/png;base64,QUFBQQ==" style="opacity:0" data-w="82" data-h="38"></uni-image><input id="vc" type="text">',
    rules: [{ id: 'u1', type: 'text', enabled: true, img: 'uni-image.yzm > img', input: '#vc' }],
    net: { '/ocr': () => ({ ok: true, text: '8rzt' }) },
  });
  await t.run();
  assert.equal(t.doc.getElementById('vc').value, '8rzt', t.toasts().join('|'));
  assert.ok(!t.toasts().some(s => /已换图或关闭/.test(s)), t.toasts().join('|'));
});

test('计算题：本地返回安全计算结果时直接填入，不调用大模型', async () => {
  const t = await setup({
    html: TEXT_HTML, rules: TEXT_RULE,
    net: { '/ocr': () => ({ ok: true, text: '8', kind: 'math', reason: 'accepted' }), llm: () => '8' },
  });
  await t.run();
  assert.equal(t.llmCalls().length, 0);
  assert.equal(t.doc.getElementById('vc').value, '8');
  assert.ok(t.toasts().some(s => /本地计算 识别完成：已填入 8/.test(s)));
});

test('本地服务连不上或识别失败：改用大模型；关闭备选后报错且不调用大模型', async () => {
  const down = await setup({ html: TEXT_HTML, rules: TEXT_RULE, net: { '/ocr': () => 'down', llm: () => 'x9k2' } });
  await down.run();
  assert.equal(down.doc.getElementById('vc').value, 'x9k2');
  assert.equal(down.llmCalls().length, 1);

  const fail = await setup({ html: TEXT_HTML, rules: TEXT_RULE, net: { '/ocr': () => ({ ok: false, text: '', msg: '未识别出字符' }), llm: () => 'q7w8' } });
  await fail.run();
  assert.equal(fail.doc.getElementById('vc').value, 'q7w8');

  const off = await setup({
    html: TEXT_HTML, rules: TEXT_RULE, cfg: { llmFallback: false },
    net: { '/ocr': () => 'down', llm: () => 'zzzz' },
  });
  await off.run();
  assert.equal(off.llmCalls().length, 0);
  assert.equal(off.doc.getElementById('vc').value, '');
  assert.ok(off.toasts().some(s => /连不上.*已关闭/.test(s)), off.toasts().join('|'));
});

test('没配大模型 Key 时本地失败：提示去设置里填 Key，不发大模型请求', async () => {
  const t = await setup({ html: TEXT_HTML, rules: TEXT_RULE, cfg: { apiKey: '' }, net: { '/ocr': () => 'down' } });
  await t.run();
  assert.equal(t.llmCalls().length, 0);
  assert.ok(t.toasts().some(s => /未配置大模型 API Key.*设置 → 识别引擎/.test(s)), t.toasts().join('|'));
});

test('本地服务地址留空：数字字母直接交给大模型', async () => {
  const t = await setup({ html: TEXT_HTML, rules: TEXT_RULE, cfg: { localUrl: '' }, net: { llm: () => 'r2d2' } });
  await t.run();
  assert.equal(t.calls.filter(c => c.url.startsWith(LOCAL)).length, 0);
  assert.equal(t.doc.getElementById('vc').value, 'r2d2');
});

// 腾讯验证码 iframe 结构：#slideBg 背景图 + #instruction 里的图标条
const TC_HTML =
  '<div id="instruction"><span id="instructionText">请依次点击：</span>' +
  '<div class="tc-instruction-icon"><img id="sprite" src="data:image/png;base64,U1BSSVRF" data-w="86" data-h="25"></div></div>' +
  '<div id="slideBg" class="tc-bg-img" style="background-image:url(data:image/png;base64,QkdCRw==)" data-w="340" data-h="240"></div>';
const TC_RULE = [{ id: 'c1', type: 'click', enabled: true, img: '#slideBg', hint: '#sprite' }];
const TC_URL = 'https://turing.captcha.qcloud.com/template/drag_ele.html';

test('腾讯图标点选：原图发给本地 /solve，按返回的原图坐标换算后点击，不调用大模型', async () => {
  const t = await setup({
    html: TC_HTML, url: TC_URL, rules: TC_RULE,
    net: { '/solve': () => ({ ok: true, points: [[336, 240], [67.2, 48]], width: 672, height: 480 }) },
  });
  const clicks = [];
  const bg = t.doc.getElementById('slideBg');
  t.doc.elementFromPoint = () => bg;
  bg.addEventListener('click', e => clicks.push([e.clientX, e.clientY]));
  await t.run(100);
  for (let i = 0; i < 100 && clicks.length < 2; i++) await sleep(50);
  assert.equal(t.llmCalls().length, 0);
  const s = t.localCalls('/solve');
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].body, { bg: 'data:image/png;base64,QkdCRw==', sprite: 'data:image/png;base64,U1BSSVRF' });
  // 原图 672x480 → 页面上 340x240（left/top=10）
  assert.deepEqual(clicks.map(([x, y]) => [Math.round(x), Math.round(y)]), [[180, 130], [44, 34]]);
  assert.ok(t.toasts().some(x => /ICR 点选完成：已点击 2 处/.test(x)), t.toasts().join('|'));
});

test('腾讯图标点选本地识别失败（如多个图标落到同一处）：改用大模型', async () => {
  const t = await setup({
    html: TC_HTML, url: TC_URL, rules: TC_RULE,
    net: {
      '/solve': () => ({ ok: false, points: [[1, 1], [2, 2]], width: 672, height: 480, msg: '多个图标匹配到同一处' }),
      llm: () => '{"points":[{"x_ratio":0.5,"y_ratio":0.5,"label":"a"}]}',
    },
  });
  t.doc.elementFromPoint = () => t.doc.getElementById('slideBg');
  await t.run(2000);
  assert.equal(t.localCalls('/solve').length, 1);
  assert.equal(t.llmCalls().length, 1);
  assert.match(t.llmCalls()[0].body.messages[0].content[0].text, /点选验证码/);
  assert.ok(t.toasts().some(x => /大模型 点选完成/.test(x)), t.toasts().join('|'));
});

test('点选不再限腾讯：文字题走 /textclick，图标题走 /solve；规则可关闭本地点选', async () => {
  const wordHtml = '<div id="tip">请依次点击 "预" "咱" "悟"<span id="pt"></span></div>' +
    '<div id="slideBg" style="background-image:url(data:image/png;base64,QkdCRw==)" data-w="340" data-h="240"></div>';
  const llm = () => '{"points":[{"x_ratio":0.2,"y_ratio":0.2,"label":"预"}]}';
  const word = await setup({ html: wordHtml, url: 'https://dun.163.com/trial/picture-click', rules: [{ id: 'w', type: 'click', enabled: true, img: '#slideBg', hint: '#tip' }],
    net: { llm, '/textclick': () => ({ ok: true, points: [[34, 24]], width: 340, height: 240, targets: ['预'] }) } });
  word.doc.elementFromPoint = () => word.doc.getElementById('slideBg');
  await word.run(2000);
  assert.equal(word.localCalls('/textclick').length, 1);
  assert.match(word.localCalls('/textclick')[0].body.targets, /预.*咱.*悟/);
  assert.equal(word.llmCalls().length, 0);
  assert.ok(word.toasts().some(x => /本地文字点选 点选完成/.test(x)), word.toasts().join('|'));

  // 非腾讯站点的图标题：同样走本地 ICR
  const other = await setup({
    html: TC_HTML.replace(' class="tc-bg-img"', ''), url: 'https://dun.163.com/trial/icon-click',
    rules: TC_RULE, net: { llm, '/solve': () => ({ ok: true, points: [[10, 10]], width: 340, height: 240 }) },
  });
  other.doc.elementFromPoint = () => other.doc.getElementById('slideBg');
  await other.run(2000);
  assert.equal(other.localCalls('/solve').length, 1);
  assert.equal(other.llmCalls().length, 0);

  // 规则里关闭本地点选：直接用大模型，不请求本地
  const off = await setup({
    html: TC_HTML, url: TC_URL, rules: [{ ...TC_RULE[0], localClick: 'off' }],
    net: { llm, '/solve': () => ({ ok: true, points: [[1, 1]], width: 10, height: 10 }) },
  });
  off.doc.elementFromPoint = () => off.doc.getElementById('slideBg');
  await off.run(2000);
  assert.equal(off.localCalls('/solve').length, 0);
  assert.equal(off.llmCalls().length, 1);
});

test('规则强制本地点选方式：icon 时文字题也走 /solve，text 时图标题也走 /textclick', async () => {
  const wordHtml = '<div id="tip">请依次点击 "预" "咱"<img id="sp" src="data:image/png;base64,U1BSSVRF" data-w="80" data-h="20"></div>' +
    '<div id="slideBg" style="background-image:url(data:image/png;base64,QkdCRw==)" data-w="340" data-h="240"></div>';
  const net = { '/solve': () => ({ ok: true, points: [[1, 1]], width: 340, height: 240 }), '/textclick': () => ({ ok: true, points: [[1, 1]], width: 340, height: 240 }) };
  const icon = await setup({ html: wordHtml, url: 'https://a.test/', rules: [{ id: 'x', type: 'click', img: '#slideBg', hint: '#tip', localClick: 'icon' }], net, cfg: { backend: 'local' } });
  icon.doc.elementFromPoint = () => icon.doc.getElementById('slideBg');
  await icon.run(2000);
  assert.equal(icon.localCalls('/solve').length, 1); assert.equal(icon.localCalls('/textclick').length, 0);
  const text = await setup({ html: wordHtml, url: 'https://a.test/', rules: [{ id: 'x', type: 'click', img: '#slideBg', hint: '#tip', localClick: 'text' }], net, cfg: { backend: 'local' } });
  text.doc.elementFromPoint = () => text.doc.getElementById('slideBg');
  await text.run(2000);
  assert.equal(text.localCalls('/textclick').length, 1); assert.equal(text.localCalls('/solve').length, 0);
});

// 易盾：大图 320x240 只显示上面 320x160（父元素 overflow:hidden），题目图是同一张图，只露出 80x19 的一条。
// 本地识别必须按可见区域裁剪（原图分辨率，不放大），点击坐标按可见区域换算。
test('大图与题目图被裁剪显示时，本地点选只发送可见部分，坐标按可见区域换算', async () => {
  const html = '<div id="wrap" style="overflow:hidden" data-l="10" data-t="10" data-w="320" data-h="160">' +
    '<img id="bg" src="data:image/jpeg;base64,RlVMTA==" data-l="10" data-t="10" data-w="320" data-h="240"></div>' +
    '<div id="ans" style="overflow:hidden" data-l="10" data-t="200" data-w="80" data-h="19">' +
    '<img id="tip" src="data:image/jpeg;base64,RlVMTA==" data-l="10" data-t="39" data-w="320" data-h="240"></div>';
  const t = await setup({ html, url: 'https://dun.163.com/trial/icon-click',
    rules: [{ id: 'y', type: 'click', img: '#bg', hint: '#ans' }], cfg: { backend: 'local' },
    net: { '/solve': () => ({ ok: true, points: [[160, 80]], width: 320, height: 160 }),
      '/textclick': () => ({ ok: false, reason: 'hint_not_text', points: [], width: 320, height: 160 }) } });
  t.win.HTMLElement.prototype.getBoundingClientRect = function () {
    const l = Number(this.dataset.l || 10), tp = Number(this.dataset.t || 10), w = Number(this.dataset.w || 300), h = Number(this.dataset.h || 150);
    return { left: l, top: tp, width: w, height: h, right: l + w, bottom: tp + h };
  };
  t.win.Image = class { set src(v) { this._src = v; this.naturalWidth = 320; this.naturalHeight = 240; setTimeout(() => this.onload && this.onload(), 0); } get src() { return this._src; } };
  const draws = [];
  t.win.HTMLCanvasElement.prototype.getContext = function () { const c = this; return { drawImage: (...a) => draws.push([c.width, c.height, ...a.slice(1)]), set imageSmoothingEnabled(v) {} }; };
  t.win.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,CROP' + this.width + 'x' + this.height; };
  const clicks = [];
  const bg = t.doc.getElementById('bg');
  t.doc.elementFromPoint = () => bg;
  bg.addEventListener('click', e => clicks.push([e.clientX, e.clientY]));
  await t.run(2000);
  const s = t.localCalls('/solve');
  assert.equal(s.length, 1);
  assert.equal(s[0].body.bg, 'data:image/png;base64,CROP320x160');
  assert.equal(s[0].body.sprite, 'data:image/png;base64,CROP80x19');
  // 先发 /textclick 判断题目图（同样只发可见部分），判定不是文字后再发 /solve
  const tc = t.localCalls('/textclick');
  assert.equal(tc.length, 1);
  assert.equal(tc[0].body.hint_image, 'data:image/png;base64,CROP80x19');
  assert.deepEqual(draws.slice(-2).map(d => d.slice(0, 6)), [[320, 160, 0, 0, 320, 160], [80, 19, 0, 161, 80, 19]]);
  assert.deepEqual(clicks, [[10 + 160, 10 + 80]]);
});

test('滑块：直接用大模型，不请求本地服务', async () => {
  const html = '<div id="bg" style="background-image:url(data:image/png;base64,QkdCRw==)" data-w="340" data-h="240"></div>' +
    '<div id="handle" style="cursor:pointer" data-w="40" data-h="40"></div>';
  const t = await setup({
    html, rules: [{ id: 's', type: 'slider', enabled: true, img: '#bg', handle: '#handle' }],
    net: { llm: () => '{"x_ratio":0.6}', '/ocr': () => ({ ok: true, text: 'x' }), '/solve': () => ({ ok: true }) },
  });
  await t.run(2500);
  assert.equal(t.calls.filter(c => c.url.startsWith(LOCAL)).length, 0);
  assert.equal(t.llmCalls().length, 1);
  assert.match(t.llmCalls()[0].body.messages[0].content[0].text, /滑块拼图验证码/);
});

// 新增规则选项应完整传给本地引擎，含不确定结果的备选路线。
test('文本规则的字符集/长度/大小写约束送到本地；2x3 不误判为计算题', async () => {
  const t = await setup({ html: TEXT_HTML,
    rules: [{ ...TEXT_RULE[0], charset: 'alnum', length: 3, case: 'lower', mode: 'text' }],
    net: { '/ocr': () => ({ ok: true, text: '2x3', kind: 'text' }) },
  });
  await t.run();
  assert.equal(t.doc.getElementById('vc').value, '2x3');
  assert.equal(t.llmCalls().length, 0);
  assert.deepEqual(t.localCalls('/ocr')[0].body,
    { image: 'data:image/png;base64,QUFBQQ==', charset: 'alnum', length: 3, case: 'lower', mode: 'text' });
});

test('显式计算题规则使用 /math，保留输入框填写路径', async () => {
  const t = await setup({ html: TEXT_HTML, rules: [{ ...TEXT_RULE[0], type: 'math' }],
    net: { '/math': () => ({ ok: true, text: '24', kind: 'math' }) } });
  await t.run();
  assert.equal(t.localCalls('/math').length, 1);
  assert.equal(t.doc.getElementById('vc').value, '24');
  assert.equal(t.llmCalls().length, 0);
});

test('显式计算题失败时按文本答案协议调用大模型', async () => {
  const t = await setup({ html: TEXT_HTML, rules: [{ ...TEXT_RULE[0], type: 'math' }],
    net: { '/math': () => ({ ok: false, msg: '算式歧义' }), llm: () => '24' } });
  await t.run();
  assert.equal(t.llmCalls().length, 1);
  assert.equal(t.doc.getElementById('vc').value, '24');
});

test('本地计算歧义或模型冲突时走大模型，而不是采用非空文本', async () => {
  const t = await setup({ html: TEXT_HTML, rules: TEXT_RULE,
    net: { '/ocr': () => ({ ok: false, text: 'ab12', reason: 'model_conflict', msg: '两模型不同' }), llm: () => 'abI2' } });
  await t.run();
  assert.equal(t.doc.getElementById('vc').value, 'abI2');
  assert.equal(t.llmCalls().length, 1);
});

test('右键添加计算题规则：图片与答案输入框按 math 类型保存', async () => {
  const t = await setup({ html: TEXT_HTML, rules: [] });
  // 顶层菜单进入拾取，数学规则复用输入框流程。
  // setup 的菜单通过 GM 注册，这里模拟右键选择的真实 DOM 事件。
  t.win.document.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const menus = [];
  const store = t.store;
  const second = new JSDOM('<img id="code" src="data:image/png;base64,QUFBQQ=="><input id="vc">', {
    url: 'https://math.example.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  opened.push(second.window);
  const w = second.window;
  w.GM_getValue = (k,d) => store[k] || d;
  w.GM_setValue = (k,v) => { store[k]=v; };
  w.__icrhTestHooks={};w.GM_registerMenuCommand = (name,fn) => menus.push({name,fn});
  w.HTMLElement.prototype.getBoundingClientRect = () => ({left:10,top:10,width:100,height:40,right:110,bottom:50});
  w.eval(source);
  await sleep(30);
  menus.find(m=>m.name.includes('__pick')).fn();
  w.document.querySelector('button[data-type="math"]').click();
  for (const id of ['code','vc']) w.document.getElementById(id).dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));
  const rule = store.icrh_site_rules_v2['math.example.test'][0];
  assert.equal(rule.type,'math');
  assert.equal(rule.img,'#code');
  assert.equal(rule.input,'#vc');
});

test('普通滑块：按缺口左边缘和滑块当前位置计算距离；旧规则里的完整背景字段被丢弃、不发送', async () => {
  const html = '<img id="bg" src="data:image/png;base64,QkdCRw==" data-w="340" data-h="240">' +
    '<img id="full" src="data:image/png;base64,RlVMTA==" data-w="340" data-h="240">' +
    '<img id="piece" src="data:image/png;base64,UElFQ0U=" data-w="40" data-h="40">' +
    '<div id="handle" style="cursor:pointer" data-w="40" data-h="40"></div>';
  const t = await setup({ html, rules: [{ id: 's2', type: 'slider', enabled: true,
    img: '#bg', handle: '#handle', full: '#full', piece: '#piece' }],
    net: { '/slider': () => ({ ok: true, width: 680, height: 480, gap_left: 200,
      gap_width: 80, gap_top: 20, piece_offset_left: 4, piece_width: 80, method: 'template' }) } });
  const moves = [];
  t.doc.addEventListener('mousemove', e => moves.push(e.clientX));
  await t.run(2500);
  const calls = t.localCalls('/slider');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.full, undefined, '不发送完整背景');
  assert.ok(calls[0].body.piece);
  assert.equal(t.llmCalls().length, 0);
  // 页面缺口左边缘 10+100=110，滑块左边缘 10+透明边距2，位移98，起点把手中心30 → 128。
  assert.ok(Math.abs(moves.at(-1) - 128) < 1, moves.join(','));
  assert.equal('full' in t.store.icrh_site_rules_v2['www.example.com'][0], false, '存储里的完整背景字段已清除');
});

// 易盾：拼图块不与把手 1:1 跟随（前 20px 半速，之后一直落后把手约 10px）。
// 拖动时要看拼图块实际位置并补偿，不能把「拼图块该移动的距离」直接当把手距离。
test('滑块拖动按拼图块实际位置闭环补偿：拼图块落后把手 10px 时仍停在缺口', async () => {
  const html = '<img id="bg" src="data:image/png;base64,QkdCRw==" data-l="10" data-w="320" data-h="160">' +
    '<img id="piece" src="data:image/png;base64,UElFQ0U=" data-l="10" data-w="60" data-h="160">' +
    '<div id="handle" style="cursor:pointer" data-l="10" data-w="40" data-h="38"></div>';
  const t = await setup({ html, rules: [{ id: 's', type: 'slider', enabled: true, img: '#bg', handle: '#handle', piece: '#piece' }],
    net: { '/slider': () => ({ ok: true, width: 320, height: 160, gap_left: 190, gap_width: 54, gap_top: 50,
      piece_offset_left: 3, piece_width: 60, method: 'shaded-shape' }) } });
  t.win.HTMLElement.prototype.getBoundingClientRect = function () {
    const l = Number(this.dataset.l || 10), w = Number(this.dataset.w || 300), h = Number(this.dataset.h || 150);
    return { left: l, top: 10, width: w, height: h, right: l + w, bottom: 10 + h };
  };
  const handle = t.doc.getElementById('handle'), piece = t.doc.getElementById('piece');
  let startX = null;
  const follow = x => {
    const d = Math.max(0, x - startX);
    handle.dataset.l = String(10 + d);
    piece.dataset.l = String(10 + (d < 21 ? d / 2 : d - 10.5));
  };
  handle.addEventListener('mousedown', e => { startX = e.clientX; });
  t.doc.addEventListener('mousemove', e => { if (startX !== null) follow(e.clientX); });
  let pieceAtRelease = null;
  t.doc.addEventListener('mouseup', () => { pieceAtRelease = Number(piece.dataset.l); }, true);
  await t.run(4000);
  assert.equal(t.localCalls('/slider').length, 1);
  // 缺口可见左边缘 10+190=200；拼图块可见左边缘 = 元素 left + 3 → 元素应停在 197
  assert.ok(pieceAtRelease !== null, '已松手');
  assert.ok(Math.abs(pieceAtRelease - 197) <= 1, '拼图块松手位置 ' + pieceAtRelease);
});

test('拼图块不跟随时不做补偿（避免把手越拖越远）', async () => {
  const html = '<img id="bg" src="data:image/png;base64,QkdCRw==" data-w="340" data-h="240">' +
    '<img id="piece" src="data:image/png;base64,UElFQ0U=" data-w="40" data-h="40">' +
    '<div id="handle" style="cursor:pointer" data-w="40" data-h="40"></div>';
  const t = await setup({ html, rules: [{ id: 's', type: 'slider', enabled: true, img: '#bg', handle: '#handle', piece: '#piece' }],
    net: { '/slider': () => ({ ok: true, width: 680, height: 480, gap_left: 200, gap_width: 80, gap_top: 20,
      piece_offset_left: 4, piece_width: 80, method: 'template' }) } });
  const moves = [];
  t.doc.addEventListener('mousemove', e => moves.push(e.clientX));
  await t.run(2500);
  assert.ok(Math.abs(moves.at(-1) - 128) < 1, moves.slice(-5).join(','));
});

// 天爱验证码（tianai-captcha）：题目「请依次点击:」后面是一张写着汉字的图片；大图是 img，
// 上面盖着一个同尺寸、内容全透明的 canvas（用户右键常选中它）。
const TIANAI_HTML = '<div id="tianai-captcha" class="tianai-captcha-slider tianai-captcha-word-click">' +
  '<div class="click-tip"><span id="tianai-captcha-click-track-font">请依次点击:</span>' +
  '<img src="data:image/png;base64,VElQ" id="tianai-captcha-tip-img" class="tip-img" data-w="132" data-h="35"></div>' +
  '<div class="content"><div class="bg-img-div" data-w="300" data-h="180">' +
  '<img id="tianai-captcha-slider-bg-img" src="data:image/jpeg;base64,QkdCRw==" data-w="300" data-h="180">' +
  '<canvas id="tianai-captcha-slider-bg-canvas" width="300" height="150" data-w="300" data-h="180"></canvas>' +
  '<div id="bg-img-click-mask" data-w="300" data-h="180"></div></div></div>' +
  '<div class="click-confirm-btn">确定</div></div>';

test('题目是汉字图片：走本地文字点选并上传题目图；大图选成透明 canvas 时改用下面的 img', async () => {
  const t = await setup({ html: TIANAI_HTML, url: 'https://login.example.com/app',
    rules: [{ id: 'ta', type: 'click', enabled: true, img: '#tianai-captcha-slider-bg-canvas', hint: '#tianai-captcha-tip-img' }],
    cfg: { backend: 'local', clickDelayMin: 0, clickDelayMax: 0 },
    net: { '/textclick': () => ({ ok: true, points: [[150, 90], [450, 270]], width: 600, height: 360, targets: ['铁', '翻'] }),
      '/solve': () => ({ ok: false, msg: 'should not be called' }) } });
  // canvas 内容全透明（getImageData 全 0）；toDataURL 不应被当成大图发出去
  t.win.HTMLCanvasElement.prototype.getContext = () => ({ getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) });
  t.win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,RU1QVFk=';
  const mask = t.doc.getElementById('bg-img-click-mask');
  t.doc.elementFromPoint = () => mask;
  const clicks = [];
  mask.addEventListener('click', e => clicks.push([e.clientX, e.clientY]));
  await t.run(3000);
  const calls = t.localCalls('/textclick');
  assert.equal(calls.length, 1, t.toasts().join('|'));
  assert.equal(t.localCalls('/solve').length, 0);
  assert.equal(calls[0].body.bg, 'data:image/jpeg;base64,QkdCRw==', '大图用 img，不用透明 canvas');
  assert.equal(calls[0].body.hint_image, 'data:image/png;base64,VElQ', '上传题目图');
  // 600x360 原图坐标 → 300x180 显示：(150,90)→(10+75,10+45)
  assert.deepEqual(clicks, [[85, 55], [235, 145]]);
  assert.equal(t.llmCalls().length, 0);
});

test('大图规则选中的 canvas 跨域污染读不出内容时，改用同位置的 img', async () => {
  const t = await setup({ html: TIANAI_HTML, url: 'https://captcha.tianai.cloud/',
    rules: [{ id: 'ta', type: 'click', enabled: true, img: '#tianai-captcha-slider-bg-canvas', hint: '#tianai-captcha-tip-img' }],
    cfg: { backend: 'local', clickDelayMin: 0, clickDelayMax: 0 },
    net: { '/textclick': () => ({ ok: true, points: [[300, 180]], width: 600, height: 360, targets: ['铁'] }) } });
  const taint = () => { throw new t.win.DOMException('tainted', 'SecurityError'); };
  t.win.HTMLCanvasElement.prototype.getContext = () => ({ getImageData: taint });
  t.win.HTMLCanvasElement.prototype.toDataURL = taint;
  t.doc.elementFromPoint = () => t.doc.getElementById('bg-img-click-mask');
  await t.run(2500);
  const calls = t.localCalls('/textclick');
  assert.equal(calls.length, 1, t.toasts().join('|'));
  assert.equal(calls[0].body.bg, 'data:image/jpeg;base64,QkdCRw==');
});

test('题目图片服务端判定不是文字（hint_not_text）时自动改走图标点选', async () => {
  const t = await setup({ html: TIANAI_HTML, url: 'https://example.com/',
    rules: [{ id: 'ta', type: 'click', enabled: true, img: '#tianai-captcha-slider-bg-img', hint: '#tianai-captcha-tip-img' }],
    cfg: { backend: 'local' },
    net: { '/textclick': () => ({ ok: false, reason: 'hint_not_text', points: [], width: 600, height: 360 }),
      '/solve': () => ({ ok: true, points: [[300, 180]], width: 600, height: 360 }) } });
  t.doc.elementFromPoint = () => t.doc.getElementById('tianai-captcha-slider-bg-img');
  await t.run(2500);
  assert.equal(t.localCalls('/textclick').length, 1);
  assert.equal(t.localCalls('/solve').length, 1);
  assert.ok(t.toasts().some(x => /ICR 点选完成/.test(x)), t.toasts().join('|'));
});

test('仅大模型：即使本地可用也不请求本地', async () => {
  const t = await setup({ html: TEXT_HTML, rules: TEXT_RULE, cfg: { backend: 'llm' },
    net: { '/ocr': () => ({ok:true,text:'local'}), llm: () => 'cloud' } });
  await t.run();
  assert.equal(t.localCalls('/ocr').length,0);
  assert.equal(t.llmCalls().length,1);
  assert.equal(t.doc.getElementById('vc').value,'cloud');
});

test('仅本地：本地失败即停，不调用已配置的大模型', async () => {
  const t = await setup({html:TEXT_HTML,rules:TEXT_RULE,cfg:{backend:'local',llmFallback:true},
    net:{'/ocr':()=> 'down',llm:()=> 'cloud'}});
  await t.run();
  assert.equal(t.llmCalls().length,0);
  assert.equal(t.doc.getElementById('vc').value,'');
  assert.ok(t.toasts().some(s=>s.includes('仅本地')));
});

test('仅本地：缺地址或不支持的汉字点选也不能发送到大模型', async () => {
  const noAddress = await setup({html:TEXT_HTML,rules:TEXT_RULE,cfg:{backend:'local',localUrl:''},net:{llm:()=> 'cloud'}});
  await noAddress.run();
  assert.equal(noAddress.calls.length,0);
  const click = await setup({html:TC_HTML,url:'https://www.example.com/',rules:TC_RULE,cfg:{backend:'local'},
    net:{llm:()=>'{"points":[{"x_ratio":0.5,"y_ratio":0.5}]}'}});
  await click.run();
  assert.equal(click.llmCalls().length,0);
});

test('按类型选择覆盖全局：全局仅本地，文本类型选大模型', async () => {
  const t = await setup({html:TEXT_HTML,rules:TEXT_RULE,cfg:{backend:'local',backendByType:{text:'llm'}},
    net:{'/ocr':()=>({ok:true,text:'local'}),llm:()=> 'cloud'}});
  await t.run();
  assert.equal(t.localCalls('/ocr').length,0);
  assert.equal(t.doc.getElementById('vc').value,'cloud');
});

test('仅大模型未配 Key 时不反向调用本地', async () => {
  const t = await setup({html:TEXT_HTML,rules:TEXT_RULE,cfg:{backend:'llm',apiKey:''},
    net:{'/ocr':()=>({ok:true,text:'local'})}});
  await t.run();
  assert.equal(t.calls.length,0);
  assert.ok(t.toasts().some(s=>s.includes('Key')));
});

test('仅本地且识别成功正常填写', async () => {
  const t = await setup({html:TEXT_HTML,rules:TEXT_RULE,cfg:{backend:'local'},net:{'/ocr':()=>({ok:true,text:'ab12'})}});
  await t.run();
  assert.equal(t.doc.getElementById('vc').value,'ab12');
  assert.equal(t.llmCalls().length,0);
});

test('设置面板能保存全局和按类型引擎选项', async () => {
  const t = await setup({html:TEXT_HTML,rules:TEXT_RULE});
  const attach=t.win.Element.prototype.attachShadow;
  t.win.Element.prototype.attachShadow=function(){return attach.call(this,{mode:'open'});};
  t.menus.find(m=>m.name.includes('设置')).fn();
  const root=t.doc.getElementById('icrh-settings-host').shadowRoot;
  assert.ok(root.querySelector('#icrh-backend'));
  root.querySelector('#icrh-backend').value='local';
  root.querySelector('#icrh-backend-text').value='llm';
  root.querySelector('#icrh-backend-slider').value='auto';
  root.querySelector('.icrh-save').click();
  assert.equal(t.store.icrh_config_v1.backend,'local');
  assert.equal(t.store.icrh_config_v1.backendByType.text,'llm');
  assert.equal(t.store.icrh_config_v1.backendByType.slider,'auto');
  assert.equal(t.store.icrh_config_v1.backendByType.click,'inherit');
});
