const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'icr-helper.user.js'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 等待条件成立（CI 机器慢时固定 sleep 不够；点选默认间隔 1000~1500ms）
// 本文件测试大模型路径：配置里 localUrl 置空，避免先请求默认本地服务
async function waitFor(cond, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (cond()) return; await sleep(50); }
}

// 把油猴脚本装进某个 window，GM_* 共用同一份存储（模拟同一脚本管理器）
const opened = [];
test.afterEach(() => { while (opened.length) opened.pop().close(); });

// jsdom 不解码图片：data: 图片立即 onload，尺寸取 win.__natSize（默认 340x240）
function stubImage(win) {
  win.Image = class {
    set src(v) {
      this._src = v;
      const [w, h] = win.__natSize || [340, 240];
      this.naturalWidth = w; this.naturalHeight = h;
      setTimeout(() => this.onload && this.onload(), 0);
    }
    get src() { return this._src; }
  };
}

async function install(win, store, menus) {
  win.GM_getValue = (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d);
  win.GM_setValue = (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); };
  win.GM_deleteValue = (k) => { delete store[k]; };
  win.GM_xmlhttpRequest = () => { throw new Error('不应发网络请求'); };
  win.__icrhTestHooks={};win.GM_registerMenuCommand = (name, fn) => { menus.push({ name, fn }); };
  // jsdom 没有布局：给所有元素一个默认尺寸
  if (!win.__fakeLayout) win.HTMLElement.prototype.getBoundingClientRect = function () {
    const w = Number(this.dataset.w || 300), h = Number(this.dataset.h || 150);
    return { left: 10, top: 10, width: w, height: h, right: 10 + w, bottom: 10 + h };
  };
  stubImage(win);
  win.eval(source);
  await sleep(20);   // 脚本在 DOMContentLoaded 后启动
}

function makePage(bodyHtml, url = 'https://www.rainyun.com/login') {
  const dom = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>', {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  opened.push(dom.window);
  return dom;
}

// jsdom 的 postMessage 不填 event.source；按真实浏览器语义补上（发送方窗口）
function wirePostMessage(target, sender) {
  target.postMessage = (data) => {
    setTimeout(() => target.dispatchEvent(new target.MessageEvent('message', { data, source: sender })), 0);
  };
}

function rightClick(win, el, x = 50, y = 50) {
  const opts = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: x, clientY: y };
  el.dispatchEvent(new win.MouseEvent('mousedown', opts));
  el.dispatchEvent(new win.MouseEvent('mouseup', opts));
  const ev = new win.MouseEvent('contextmenu', opts);
  el.dispatchEvent(ev);
  return ev;
}

function chooseType(win, menus, type) {
  menus.find(m => m.name.includes('__pick')).fn();
  win.document.querySelector('#icrh-pick-panel button[data-type="' + type + '"]').click();
}

const CLICK_HTML =
  '<div id="cap"><div class="tip">请依次点击：<img id="hint" src="data:image/png;base64,AAAA" data-w="130" data-h="40"></div>' +
  '<div id="bg" style="background-image:url(data:image/png;base64,BBBB)" data-w="340" data-h="240"></div>' +
  '<div id="mask" data-w="340" data-h="240"></div></div>';

test('右键选中点选大图 + 题目提示，规则按本域名保存，且不刷新页面', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window, doc = win.document;
  const store = {}, menus = [];
  await install(win, store, menus);
  const pageClicks = [];
  doc.getElementById('bg').addEventListener('mousedown', e => pageClicks.push(e.button));
  doc.getElementById('bg').addEventListener('contextmenu', () => pageClicks.push('ctx'));

  chooseType(win, menus, 'click');
  await sleep(10);
  assert.match(doc.getElementById('icrh-pick-panel').textContent, /右键.*点选验证码大图/);

  // 左键：页面照常收到，不会被当成选中
  doc.getElementById('bg').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  assert.deepEqual(pageClicks, [0]);
  assert.equal(store.icrh_site_rules_v2, undefined);

  // 右键：被拦截，页面收不到，也不弹浏览器菜单
  const ev = rightClick(win, doc.getElementById('bg'));
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(pageClicks, [0]);
  assert.match(doc.getElementById('icrh-pick-panel').textContent, /题目提示/);

  rightClick(win, doc.getElementById('hint'));
  const rule = store.icrh_site_rules_v2['www.rainyun.com'][0];
  assert.equal(rule.type, 'click');
  assert.equal(rule.img, '#bg');
  assert.equal(rule.hint, '#hint');
  assert.equal(doc.getElementById('icrh-pick-panel'), null);
  assert.equal(doc.getElementById('icrh-pick-hl'), null);

  // 结束后右键恢复正常
  const after = rightClick(win, doc.getElementById('bg'));
  assert.equal(after.defaultPrevented, false);
});

test('图片上盖着透明遮罩时，按坐标穿透选到下面的图片', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window, doc = win.document;
  const store = {}, menus = [];
  await install(win, store, menus);
  doc.elementsFromPoint = () => [doc.getElementById('mask'), doc.getElementById('bg'), doc.getElementById('cap'), doc.body];

  chooseType(win, menus, 'click');
  await sleep(10);
  rightClick(win, doc.getElementById('mask'));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));  // 跳过可选的题目提示
  const rule = store.icrh_site_rules_v2['www.rainyun.com'][0];
  assert.equal(rule.img, '#bg');
  assert.equal(rule.hint, undefined);
});

test('添加滑块规则只问大图、把手、滑块图片三步', async () => {
  const dom = makePage('<img id="bg" src="data:image/png;base64,AAAA" data-w="300" data-h="150">' +
    '<div id="handle" data-w="40" data-h="40"></div><img id="piece" src="data:image/png;base64,BBBB" data-w="50" data-h="50">');
  const win = dom.window, doc = win.document;
  const store = {}, menus = [];
  await install(win, store, menus);
  chooseType(win, menus, 'slider');
  await sleep(10);
  rightClick(win, doc.getElementById('bg'));
  rightClick(win, doc.getElementById('handle'));
  rightClick(win, doc.getElementById('piece'));
  const rule = (store.icrh_site_rules_v2 || {})['www.rainyun.com']?.[0];
  assert.ok(rule, '第三步选完即保存');
  assert.deepEqual([rule.img, rule.handle, rule.piece, 'full' in rule], ['#bg', '#handle', '#piece', false]);
  assert.equal(doc.getElementById('icrh-pick-panel'), null);
});

test('Esc 取消，不保存规则', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window, doc = win.document;
  const store = {}, menus = [];
  await install(win, store, menus);
  chooseType(win, menus, 'click');
  await sleep(10);
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.getElementById('icrh-pick-panel'), null);
  const ev = rightClick(win, doc.getElementById('bg'));
  assert.equal(ev.defaultPrevented, false);
  assert.equal(store.icrh_site_rules_v2, undefined);
});

test('文本验证码：右键图片再右键输入框', async () => {
  const dom = makePage('<img id="code" src="data:image/png;base64,AAAA" data-w="100" data-h="40"><input id="vc" type="text">');
  const win = dom.window, doc = win.document;
  const store = {}, menus = [];
  await install(win, store, menus);
  chooseType(win, menus, 'text');
  await sleep(10);
  rightClick(win, doc.getElementById('code'));
  rightClick(win, doc.getElementById('vc'));
  assert.deepEqual(
    { img: store.icrh_site_rules_v2['www.rainyun.com'][0].img, input: store.icrh_site_rules_v2['www.rainyun.com'][0].input },
    { img: '#code', input: '#vc' });
});

test('验证码在 iframe 里：顶层下发拾取，iframe 内右键保存到 iframe 域名，并通知顶层结束', async () => {
  const dom = makePage('<iframe id="f"></iframe>');
  const top = dom.window;
  const store = {}, menus = [];
  const frameWin = top.document.getElementById('f').contentWindow;
  frameWin.document.body.innerHTML = CLICK_HTML;
  wirePostMessage(frameWin, top);
  wirePostMessage(top, frameWin);
  await install(top, store, menus);
  await install(frameWin, store, []);

  chooseType(top, menus, 'click');
  await sleep(30);   // 等 postMessage 送达
  const fdoc = frameWin.document;
  rightClick(frameWin, fdoc.getElementById('bg'));
  await sleep(30);
  assert.match(top.document.getElementById('icrh-pick-panel').textContent, /题目提示/);
  rightClick(frameWin, fdoc.getElementById('hint'));
  await sleep(30);
  const rules = store.icrh_site_rules_v2;
  assert.ok(rules, '规则已保存');
  const rule = Object.values(rules)[0][0];
  assert.equal(rule.img, '#bg');
  assert.equal(rule.hint, '#hint');
  assert.equal(top.document.getElementById('icrh-pick-panel'), null, '顶层提示条已关闭');
  assert.equal(fdoc.getElementById('icrh-pick-hl'), null);
  // 顶层的拾取也已停止
  const ev = rightClick(top, top.document.body);
  assert.equal(ev.defaultPrevented, false);
});

test('子框架发来的伪造/过期消息不会改动顶层状态', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window, doc = win.document;
  const store = {}, menus = [];
  await install(win, store, menus);
  chooseType(win, menus, 'click');
  await sleep(10);
  win.postMessage({ __icrh_msg__: 'progress', token: 'bad', text: '<b>伪造</b>' }, '*');
  win.postMessage({ __icrh_msg__: 'done', token: 'bad' }, '*');
  await sleep(30);
  assert.match(doc.getElementById('icrh-pick-panel').textContent, /点选验证码大图/);
});

test('点选规则带题目提示：识别时把大图和题目图一起发给模型，并按返回坐标点击大图', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window, doc = win.document;
  const store = {
    icrh_config_v1: { localUrl: '', apiKey: 'k', apiUrl: 'https://api.test/v1/chat/completions' },
    icrh_site_rules_v1: { 'www.rainyun.com': { type: 'click', enabled: true, img: '#bg', hint: '#hint' } },
  };
  const menus = [], sent = [], clicks = [];
  await install(win, store, menus);
  win.GM_xmlhttpRequest = (req) => {
    sent.push(JSON.parse(req.data));
    req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content:
      '{"points":[{"x_ratio":0.1,"y_ratio":0.1,"label":"0"},{"x_ratio":0.9,"y_ratio":0.4,"label":"2"}]}' } }] }) });
  };
  doc.elementFromPoint = () => doc.getElementById('bg');
  doc.getElementById('bg').addEventListener('click', e => clicks.push([e.clientX, e.clientY]));

  menus.find(m => m.name.includes('__recognize')).fn();
  await waitFor(() => clicks.length >= 2);
  assert.equal(sent.length, 1);
  const images = sent[0].messages[0].content.filter(c => c.type === 'image_url').map(c => c.image_url.url);
  assert.deepEqual(images, ['data:image/png;base64,BBBB', 'data:image/png;base64,AAAA']);
  const texts = sent[0].messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\\n');
  assert.match(texts, /坐标比例均相对于这张大图/);
  assert.match(texts, /题目提示/);
  assert.doesNotMatch(texts, /题目提示文字：/);   // 选中的是纯图片，没有空文字项
  // getBoundingClientRect 统一为 left/top=10，大图 340x240
  assert.deepEqual(clicks, [[10 + 34, 10 + 24], [10 + 306, 10 + 96]]);
});

test('油猴沙箱里 window 是代理对象时，点选仍能派发事件（不能把代理 window 当 view）', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window, doc = win.document;
  const store = {
    icrh_config_v1: { localUrl: '', apiKey: 'k' },
    icrh_site_rules_v1: { 'www.rainyun.com': { type: 'click', enabled: true, img: '#bg' } },
  };
  const menus = [], events = [];
  win.GM_getValue = (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d);
  win.GM_setValue = (k, v) => { store[k] = v; };
  win.__icrhTestHooks={};win.GM_registerMenuCommand = (name, fn) => menus.push({ name, fn });
  win.GM_xmlhttpRequest = (req) => req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
    content: '{"points":[{"x_ratio":0.5,"y_ratio":0.5,"label":"9"}]}' } }] }) });
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 };
  };
  doc.elementFromPoint = () => doc.getElementById('bg');
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    doc.getElementById('bg').addEventListener(t, e => events.push(t + '@' + e.clientX + ',' + e.clientY));
  }
  // 模拟沙箱：脚本看到的 window 是 Proxy，真实浏览器会拒绝它作为 view
  const sandboxWindow = new Proxy(win, {
    get(t, prop) {
      if (prop === 'top' || prop === 'self' || prop === 'window') return sandboxWindow;
      const v = Reflect.get(t, prop);
      return typeof v === 'function' && !/^[A-Z]/.test(String(prop)) ? v.bind(t) : v;
    },
  });
  assert.throws(() => new win.MouseEvent('click', { view: sandboxWindow }), TypeError);
  win.__sandboxWindow = sandboxWindow;
  win.__natSize = [200, 100];
  stubImage(win);
  win.eval('(function (window) {' + source + '\n})(window.__sandboxWindow);');
  await sleep(20);

  menus.find(m => m.name.includes('__recognize')).fn();
  await sleep(800);
  assert.deepEqual(events, ['pointerdown@100,50', 'mousedown@100,50', 'pointerup@100,50', 'mouseup@100,50', 'click@100,50']);
  assert.ok(![...doc.querySelectorAll('#icrh-toast-box div')].some(d => /失败/.test(d.textContent)));
});

// 按截图布局给元素指定矩形，并实现 elementsFromPoint
function fakeLayout(win, rects, W = 640, H = 590) {
  const doc = win.document;
  Object.defineProperty(win, 'innerWidth', { value: W, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: H, configurable: true });
  const rectOf = (el) => {
    if (el.id === 'icrh-fab') {
      const l = parseFloat(el.style.left) || 0, t = parseFloat(el.style.top) || 0;
      return { left: l, top: t, width: 70, height: 28, right: l + 70, bottom: t + 28 };
    }
    const r = rects[el.id];
    if (!r) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    return { left: r[0], top: r[1], width: r[2], height: r[3], right: r[0] + r[2], bottom: r[1] + r[3] };
  };
  win.__fakeLayout = true;
  win.HTMLElement.prototype.getBoundingClientRect = function () { return rectOf(this); };
  doc.elementsFromPoint = (x, y) => {
    const hits = [...doc.querySelectorAll('*')].filter(el => {
      const r = rectOf(el);
      return r.width && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    });
    return hits.reverse().concat([doc.body, doc.documentElement]);
  };
  return rectOf;
}

const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const DIALOG_HTML =
  '<div id="dlg"><button id="close">×</button><div id="tip">请依次点击：<img id="hint" src="data:image/png;base64,AAAA"></div>' +
  '<div id="bg" style="background-image:url(data:image/png;base64,BBBB)"></div>' +
  '<span id="help" role="button">?</span><span id="refresh" role="button">↻</span><button id="ok">确定</button></div>';
const DIALOG_RECTS = {
  dlg: [40, 0, 566, 570], close: [545, 25, 40, 40], tip: [57, 50, 270, 45], hint: [189, 52, 136, 40],
  bg: [57, 110, 535, 380], help: [88, 510, 40, 40], refresh: [158, 510, 40, 40], ok: [491, 503, 101, 52],
};

test('识别按钮自动避让：不挡住提交按钮、刷新/关闭按钮、验证码图片和题目', async () => {
  const dom = makePage(DIALOG_HTML);
  const win = dom.window, doc = win.document;
  const store = { icrh_site_rules_v1: { 'www.rainyun.com': { type: 'click', enabled: true, img: '#bg', hint: '#hint' } } };
  const menus = [];
  const rectOf = fakeLayout(win, DIALOG_RECTS);
  await install(win, store, menus);
  await sleep(700);   // 等启动后的首次扫描
  const fab = doc.getElementById('icrh-fab');
  assert.ok(fab, '悬浮按钮已出现');
  const f = rectOf(fab);
  for (const id of ['ok', 'close', 'help', 'refresh', 'bg', 'hint']) {
    assert.ok(!overlap(f, rectOf(doc.getElementById(id))), '不应挡住 #' + id + '，按钮位置 ' + JSON.stringify(f));
  }
  assert.ok(f.left >= 0 && f.right <= 640 && f.top >= 0 && f.bottom <= 590, '在可视区内');
});

test('拖动识别按钮后按域名记住位置，菜单可重置回自动避让', async () => {
  const dom = makePage(DIALOG_HTML);
  const win = dom.window, doc = win.document;
  const store = { icrh_site_rules_v1: { 'www.rainyun.com': { type: 'click', enabled: true, img: '#bg' } } };
  const menus = [];
  const rectOf = fakeLayout(win, DIALOG_RECTS);
  await install(win, store, menus);
  await sleep(700);   // 等启动后的首次扫描
  const fab = doc.getElementById('icrh-fab');
  const start = rectOf(fab);
  const pe = (type, x, y) => fab.dispatchEvent(new win.PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));
  pe('pointerdown', start.left + 5, start.top + 5);
  pe('pointermove', 15, 15);
  pe('pointerup', 15, 15);
  let clicked = false;
  const origFetch = win.GM_xmlhttpRequest;
  win.GM_xmlhttpRequest = () => { clicked = true; };
  fab.click();   // 拖动结束紧跟的 click 不应触发识别
  assert.equal(clicked, false);
  win.GM_xmlhttpRequest = origFetch;
  assert.deepEqual(store.icrh_fab_pos_v1['www.rainyun.com'], { left: 10, top: 10 });
  assert.equal(fab.style.left, '10px');

  menus.find(m => m.name.includes('__resetFab')).fn();
  assert.equal(store.icrh_fab_pos_v1['www.rainyun.com'], undefined);
  assert.ok(!overlap(rectOf(fab), rectOf(doc.getElementById('ok'))));
});

// 网易易盾（知乎）：大图和题目图标在同一张 320x240 雪碧图里，容器 overflow:hidden 只露上面 320x160；
// 图片 pointer-events:none，右键命中的是外层 div
const YIDUN_HTML =
  '<div id="ph" style="overflow:hidden"><div class="yidun_bgimg" style="overflow:hidden">' +
  '<img class="yidun_bg-img" alt="验证码背景" style="pointer-events:none" src="data:image/png;base64,SPRITE"></div></div>' +
  '<div class="yidun_tips">请依次点击<div class="yidun_tips__answer" style="overflow:hidden">' +
  '<img class="yidun_tips__img" style="position:absolute;top:-161px;pointer-events:none" src="data:image/png;base64,SPRITE"></div></div>';

test('易盾雪碧图：右键外层 div 也能选中图片，点击坐标按可见的 320x160 区域换算', async () => {
  const dom = makePage(YIDUN_HTML, 'https://www.zhihu.com/people/x');
  const win = dom.window, doc = win.document;
  const rects = { ph: [529, 226, 320, 160], 'yidun_bgimg': [529, 226, 320, 160], 'yidun_bg-img': [529, 226, 320, 240],
    'yidun_tips__answer': [690, 412, 80, 19], 'yidun_tips__img': [690, 251, 320, 240] };
  const keyOf = el => el.id || String(el.className);
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const r = rects[keyOf(this)] || [0, 0, 0, 0];
    return { left: r[0], top: r[1], width: r[2], height: r[3], right: r[0] + r[2], bottom: r[1] + r[3] };
  };
  win.__fakeLayout = true;
  doc.elementsFromPoint = () => [doc.querySelector('.yidun_bgimg'), doc.getElementById('ph'), doc.body, doc.documentElement];
  win.__natSize = [320, 240];
  const store = {}, menus = [];
  await install(win, store, menus);

  // 1) 右键拾取：命中外层 div，也要选到图片
  chooseType(win, menus, 'click');
  await sleep(10);
  rightClick(win, doc.querySelector('.yidun_bgimg'), 689, 306);
  rightClick(win, doc.querySelector('.yidun_tips__answer'), 700, 420);
  const rule = store.icrh_site_rules_v2['www.zhihu.com'][0];
  assert.equal(rule.img, 'img[alt="验证码背景"]');
  assert.equal(rule.hint, 'div.yidun_tips__answer');

  // 2) 旧规则选中的是外层 div：识别不再报「无法从该元素获取图片」，坐标按可见区域 320x160 换算
  store.icrh_site_rules_v2['www.zhihu.com'] = [{ id: 'r1', type: 'click', enabled: true, img: 'div.yidun_bgimg', hint: 'div.yidun_tips__answer' }];
  store.icrh_config_v1 = { localUrl: '', apiKey: 'k' };
  const sent = [], clicks = [];
  win.GM_xmlhttpRequest = (req) => {
    sent.push(JSON.parse(req.data));
    req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
      content: '{"points":[{"x_ratio":0.5,"y_ratio":0.5,"label":"a"},{"x_ratio":1,"y_ratio":1,"label":"b"}]}' } }] }) });
  };
  // 重新加载脚本以读取新规则
  const dom2 = makePage(YIDUN_HTML, 'https://www.zhihu.com/people/x');
  const w2 = dom2.window, d2 = w2.document;
  w2.__fakeLayout = true;
  w2.HTMLElement.prototype.getBoundingClientRect = win.HTMLElement.prototype.getBoundingClientRect;
  w2.__natSize = [320, 240];
  const menus2 = [];
  await install(w2, store, menus2);
  w2.GM_xmlhttpRequest = win.GM_xmlhttpRequest;
  d2.elementsFromPoint = () => [d2.querySelector('.yidun_bgimg'), d2.body];
  d2.querySelector('.yidun_bgimg').addEventListener('click', e => clicks.push([e.clientX, e.clientY]));
  menus2.find(m => m.name.includes('__recognize')).fn();
  for (let i = 0; i < 80 && clicks.length < 2; i++) await sleep(50);
  const toasts = [...d2.querySelectorAll('#icrh-toast-box div')].map(d => d.textContent);
  assert.ok(!toasts.some(t => /失败/.test(t)), toasts.join('\n'));
  assert.equal(sent.length, 1);
  assert.deepEqual(clicks, [[529 + 160, 226 + 80], [529 + 320, 226 + 160]]);
});

test('图片 data URL 带 charset（易盾 CDN 返回 image/jpeg;charset=UTF-8）时，发给模型前规范成 data:image/jpeg;base64', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window;
  const store = {
    icrh_config_v1: { localUrl: '', apiKey: 'k' },
    icrh_site_rules_v1: { 'www.rainyun.com': { type: 'click', enabled: true, img: '#bg' } },
  };
  const menus = [], sent = [];
  await install(win, store, menus);
  // 背景图换成 GM 下载的 JPEG（带 charset），模拟易盾
  win.document.getElementById('bg').style.backgroundImage = 'url(https://necaptcha.nosdn.127.net/a.jpg)';
  const jpegB64 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 2, 0, 0, 1, 0, 1, 0, 0]).toString('base64');
  win.GM_xmlhttpRequest = (req) => {
    if (req.method === 'GET') {
      req.onload({ status: 200, response: new win.Blob([Buffer.from(jpegB64, 'base64')], { type: 'image/jpeg;charset=UTF-8' }) });
      return;
    }
    sent.push(JSON.parse(req.data));
    req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"points":[{"x_ratio":0.5,"y_ratio":0.5}]}' } }] }) });
  };
  menus.find(m => m.name.includes('__recognize')).fn();
  await sleep(1500);
  assert.equal(sent.length, 1);
  const url = sent[0].messages[0].content.find(c => c.type === 'image_url').image_url.url;
  assert.equal(url, 'data:image/jpeg;base64,' + jpegB64);
});

test('易盾题目从图标切换成文字后，选中的元素为空也能取到题目（向上找有内容的容器）', async () => {
  const html = '<div id="bg" style="background-image:url(data:image/png;base64,BBBB)" data-w="320" data-h="160"></div>' +
    '<div class="yidun_tips__answer"><span class="yidun_tips__point"></span><span id="txt">"预" "咱" "悟"</span></div>';
  const dom = makePage(html, 'https://www.zhihu.com/');
  const win = dom.window;
  const store = {
    icrh_config_v1: { localUrl: '', apiKey: 'k' },
    icrh_site_rules_v1: { 'www.zhihu.com': { type: 'click', enabled: true, img: '#bg', hint: 'span.yidun_tips__point' } },
  };
  const menus = [], sent = [];
  await install(win, store, menus);
  win.GM_xmlhttpRequest = (req) => {
    sent.push(JSON.parse(req.data));
    req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"points":[{"x_ratio":0.5,"y_ratio":0.5}]}' } }] }) });
  };
  menus.find(m => m.name.includes('__recognize')).fn();
  await sleep(1500);
  const texts = sent[0].messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(texts, /题目提示文字："预" "咱" "悟"/);
});

/* ---------------- 多规则 ---------------- */

// 易盾同一个弹窗：大图同一个 <img>，滑块模式显示把手，点选模式显示题目
function yidunMulti(mode) {
  return '<div class="yidun_bgimg"><img class="yidun_bg-img" alt="验证码背景" src="data:image/png;base64,BBBB" data-w="320" data-h="160"></div>' +
    '<div class="yidun_tips"><span class="yidun_tips__text">' + (mode === 'slider' ? '向右拖动滑块填充拼图' : '请依次点击') + '</span>' +
    '<div class="yidun_tips__answer"' + (mode === 'slider' ? ' style="display:none"' : '') + ' data-w="80" data-h="19">' +
    '<span class="yidun_tips__point" data-w="60" data-h="18">"预" "咱"</span></div></div>' +
    '<div class="yidun_slider" style="cursor:pointer' + (mode === 'slider' ? '' : ';display:none') + '" data-w="40" data-h="39"></div>';
}

const TWO_RULES = () => ({
  'www.zhihu.com': [
    { id: 'slide1', type: 'slider', enabled: true, img: 'img[alt="验证码背景"]', handle: 'div.yidun_slider' },
    { id: 'click1', type: 'click', enabled: true, img: 'img[alt="验证码背景"]', hint: 'span.yidun_tips__point' },
  ],
});

// jsdom 没有布局：display:none 的元素返回 0 尺寸，其余按 data-w/h
function displayAwareLayout(win) {
  win.__fakeLayout = true;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    for (let n = this; n; n = n.parentElement) {
      if (n.style && n.style.display === 'none') return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    }
    const w = Number(this.dataset.w || 300), h = Number(this.dataset.h || 150);
    return { left: 10, top: 10, width: w, height: h, right: 10 + w, bottom: 10 + h };
  };
}

async function recognizeWith(mode, rules) {
  const dom = makePage(yidunMulti(mode), 'https://www.zhihu.com/people/x');
  const win = dom.window;
  displayAwareLayout(win);
  const store = { icrh_config_v1: { localUrl: '', apiKey: 'k' }, icrh_site_rules_v2: rules };
  const menus = [], sent = [];
  win.__natSize = [320, 160];
  await install(win, store, menus);
  win.GM_xmlhttpRequest = (req) => {
    sent.push(JSON.parse(req.data));
    req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"x_ratio":0.5,"points":[{"x_ratio":0.5,"y_ratio":0.5}]}' } }] }) });
  };
  menus.find(m => m.name.includes('__recognize')).fn();
  await sleep(2000);
  const prompt = sent.length ? sent[0].messages[0].content[0].text : '';
  return { sent, prompt, store, win, menus };
}

test('同一网站两条规则（滑块 + 点选，同一张大图）：按当前显示的配套元素自动选用', async () => {
  const s = await recognizeWith('slider', TWO_RULES());
  assert.equal(s.sent.length, 1, '只识别一次，不会两条规则都跑');
  assert.match(s.prompt, /滑块拼图验证码/);
  const c = await recognizeWith('click', TWO_RULES());
  assert.equal(c.sent.length, 1);
  assert.match(c.prompt, /点选验证码/);
  assert.match(JSON.stringify(c.sent[0].messages[0].content), /题目提示文字/);
});

test('停用单条规则后不再使用它；配套元素都不在时不乱识别', async () => {
  const rules = TWO_RULES();
  rules['www.zhihu.com'][1].enabled = false;   // 停用点选
  const r = await recognizeWith('click', rules);
  // 只剩滑块规则，且把手没显示：没法拖，不应调用模型（也不能误用已停用的点选规则）
  assert.equal(r.sent.length, 0);
  // 重新启用点选后正常使用点选
  rules['www.zhihu.com'][1].enabled = true;
  const r2 = await recognizeWith('click', rules);
  assert.equal(r2.sent.length, 1);
  assert.match(r2.prompt, /点选验证码/);
});

test('右键添加第二条规则是追加而不是覆盖；同类型不同选择器也追加，完全相同才更新', async () => {
  const dom = makePage(yidunMulti('slider'), 'https://www.zhihu.com/people/x');
  const win = dom.window, doc = win.document;
  displayAwareLayout(win);
  const store = { icrh_site_rules_v2: { 'www.zhihu.com': [{ id: 'click1', type: 'click', enabled: true, img: 'img[alt="验证码背景"]', hint: 'span.yidun_tips__point' }] } };
  const menus = [];
  await install(win, store, menus);
  doc.elementsFromPoint = () => [doc.querySelector('.yidun_bg-img'), doc.body];
  chooseType(win, menus, 'slider');
  await sleep(10);
  rightClick(win, doc.querySelector('.yidun_bg-img'));
  rightClick(win, doc.querySelector('.yidun_slider'));
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  let list = store.icrh_site_rules_v2['www.zhihu.com'];
  assert.deepEqual(list.map(r => r.type), ['click', 'slider']);
  assert.equal(list[1].handle, 'div.yidun_slider');
  assert.ok(list[1].id && list[1].id !== 'click1');

  // 同类型同一张图但把手选择器不同 → 视为另一条规则，追加（同一网站同类型可多条）
  doc.querySelector('.yidun_slider').id = 'handle2';
  chooseType(win, menus, 'slider');
  await sleep(10);
  rightClick(win, doc.querySelector('.yidun_bg-img'));
  rightClick(win, doc.querySelector('.yidun_slider'));
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  list = store.icrh_site_rules_v2['www.zhihu.com'];
  assert.equal(list.length, 3);
  assert.equal(list[2].handle, '#handle2');

  // 完全相同的选择器再添加一次 → 更新，不重复
  chooseType(win, menus, 'slider');
  await sleep(10);
  rightClick(win, doc.querySelector('.yidun_bg-img'));
  rightClick(win, doc.querySelector('.yidun_slider'));
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(store.icrh_site_rules_v2['www.zhihu.com'].length, 3);
});

test('管理界面：列出本站多条规则，可单独停用、单独删除', async () => {
  const dom = makePage(yidunMulti('click'), 'https://www.zhihu.com/people/x');
  const win = dom.window;
  displayAwareLayout(win);
  // closed shadow root 拿不到，测试里改成 open 以便检查
  const orig = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function () { return orig.call(this, { mode: 'open' }); };
  const store = { icrh_site_rules_v2: Object.assign(TWO_RULES(), {
    'other.example.com': [{ id: 'o1', type: 'text', enabled: true, img: '#c', input: '#i' }],
  }) };
  const menus = [];
  await install(win, store, menus);
  menus.find(m => m.name.includes('规则管理')).fn();
  const root = () => win.document.getElementById('icrh-rules-host').shadowRoot;
  const rows = () => [...root().querySelectorAll('.host[data-host="www.zhihu.com"] .rule')];
  assert.deepEqual(rows().map(r => r.dataset.ruleId), ['slide1', 'click1']);
  assert.match(rows()[0].textContent, /滑块验证码.*handle|滑块: div\.yidun_slider/);
  assert.match(root().textContent, /其他站点（1 个域名）/);

  // 停用滑块
  const cb = rows()[0].querySelector('input.toggle');
  cb.checked = false;
  cb.dispatchEvent(new win.Event('change'));
  assert.equal(store.icrh_site_rules_v2['www.zhihu.com'][0].enabled, false);
  assert.ok(rows()[0].classList.contains('disabled'));

  // 删除点选，滑块保留
  rows()[1].querySelector('button.del').click();
  assert.deepEqual(store.icrh_site_rules_v2['www.zhihu.com'].map(r => r.id), ['slide1']);
  assert.deepEqual(rows().map(r => r.dataset.ruleId), ['slide1']);
  // 其他站点不受影响
  assert.equal(store.icrh_site_rules_v2['other.example.com'].length, 1);

  // 删掉最后一条 → 该域名从存储里移除
  rows()[0].querySelector('button.del').click();
  assert.equal(store.icrh_site_rules_v2['www.zhihu.com'], undefined);
});

test('旧版 v1 规则（每域名一条）自动迁移成 v2 数组并补 id', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window;
  const store = { icrh_site_rules_v1: { 'www.rainyun.com': { type: 'click', enabled: true, img: '#bg', hint: '#hint' } } };
  const menus = [];
  await install(win, store, menus);
  await sleep(700);
  const list = store.icrh_site_rules_v2['www.rainyun.com'];
  assert.equal(list.length, 1);
  assert.equal(list[0].img, '#bg');
  assert.ok(list[0].id);
});

test('模型拒答（无 JSON 的「抱歉，我不能…」）时给出明确原因，而不是「不是合法 JSON」', async () => {
  const dom = makePage(CLICK_HTML);
  const win = dom.window;
  const store = {
    icrh_config_v1: { apiKey: 'k', localUrl: '' },
    icrh_site_rules_v2: { 'www.rainyun.com': [{ id: 'c1', type: 'click', enabled: true, img: '#bg' }] },
  };
  const menus = [];
  await install(win, store, menus);
  win.GM_xmlhttpRequest = (req) => req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '抱歉，我不能帮助完成验证码。' } }] }) });
  menus.find(m => m.name.includes('__recognize')).fn();
  await sleep(1500);
  const toasts = [...win.document.querySelectorAll('#icrh-toast-box div')].map(d => d.textContent).join('\n');
  assert.match(toasts, /模型拒绝了这次请求/);
  assert.doesNotMatch(toasts, /不是合法 JSON/);
});

/* ---------------- 弹窗关闭再打开：旧弹窗隐藏留在页面里 ---------------- */

// 易盾关闭再打开会新建一套弹窗，旧的 display:none 留在 DOM 里（排在前面）
function yidunTwoPopups(mode) {
  const popup = (hidden, img) => '<div class="yidun_popup"' + (hidden ? ' style="display:none"' : '') + '>' +
    '<div class="yidun_bgimg"><img class="yidun_bg-img" alt="验证码背景" src="https://necaptcha.nosdn.127.net/' + img + '.jpg" data-w="320" data-h="160"></div>' +
    '<div class="yidun_tips"><span class="yidun_tips__text">' + (mode === 'slider' ? '向右拖动滑块填充拼图' : '请依次点击') + '</span>' +
    '<div class="yidun_tips__answer"' + (mode === 'slider' ? ' style="display:none"' : '') + ' data-w="80" data-h="19">' +
    '<span class="yidun_tips__point" data-w="60" data-h="18">"预" "咱"</span></div></div>' +
    '<div class="yidun_slider yidun_slider--hover" style="cursor:pointer' + (mode === 'slider' ? '' : ';display:none') + '" data-w="40" data-h="39"></div></div>';
  return popup(true, '472f94ebd5ac4ebdbc9b8a2a2ce59366') + popup(false, '0e3472cfd1ff4f79bb26f497a982dc0e');
}

test('弹窗关闭再打开（旧弹窗隐藏仍在 DOM）：规则取可见那份的大图和配套元素', async () => {
  const dom = makePage(yidunTwoPopups('slider'), 'https://www.zhihu.com/people/x');
  const win = dom.window, doc = win.document;
  displayAwareLayout(win);
  const store = { icrh_config_v1: { localUrl: '', apiKey: 'k' }, icrh_site_rules_v2: TWO_RULES() };
  const menus = [], sent = [];
  win.__natSize = [320, 160];
  await install(win, store, menus);
  win.GM_xmlhttpRequest = (req) => {
    if (req.method === 'GET') return req.onload({ status: 200, response: new win.Blob([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])], { type: 'image/jpeg' }) });
    sent.push({ body: JSON.parse(req.data) });
    req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"x_ratio":0.5}' } }] }) });
  };
  const dragged = [];
  const visiblePopup = doc.querySelectorAll('.yidun_popup')[1];
  visiblePopup.querySelector('.yidun_slider').addEventListener('mousedown', () => dragged.push('visible'));
  doc.querySelectorAll('.yidun_popup')[0].querySelector('.yidun_slider').addEventListener('mousedown', () => dragged.push('hidden'));
  menus.find(m => m.name.includes('__recognize')).fn();
  await sleep(2500);
  assert.equal(sent.length, 1, '找到了验证码并调用模型');
  assert.match(sent[0].body.messages[0].content[0].text, /滑块拼图/);
  assert.deepEqual(dragged, ['visible'], '拖的是当前显示的弹窗里的滑块');
});

test('右键生成的选择器不含图片文件名、nth-of-type 路径和 hover 状态类，换一组/重开弹窗后仍可用', async () => {
  const dom = makePage(yidunTwoPopups('click'), 'https://www.zhihu.com/people/x');
  const win = dom.window, doc = win.document;
  displayAwareLayout(win);
  const store = {}, menus = [];
  await install(win, store, menus);
  const vis = doc.querySelectorAll('.yidun_popup')[1];
  doc.elementsFromPoint = () => [vis.querySelector('.yidun_bg-img'), doc.body];
  chooseType(win, menus, 'click');
  await sleep(10);
  rightClick(win, vis.querySelector('.yidun_bg-img'));
  rightClick(win, vis.querySelector('.yidun_tips__point'));
  const rule = store.icrh_site_rules_v2['www.zhihu.com'][0];
  assert.equal(rule.img, 'img[alt="验证码背景"]');
  assert.equal(rule.hint, 'span.yidun_tips__point');
  for (const v of [rule.img, rule.hint]) {
    assert.doesNotMatch(v, /nth-of-type|[a-f0-9]{12,}|--hover/);
  }
});

test('管理界面：旧规则的选择器含图片文件名 / nth-of-type 长路径时提示重新添加', async () => {
  const dom = makePage(yidunTwoPopups('click'), 'https://www.zhihu.com/people/x');
  const win = dom.window;
  displayAwareLayout(win);
  const orig = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function () { return orig.call(this, { mode: 'open' }); };
  const store = { icrh_site_rules_v2: { 'www.zhihu.com': [
    { id: 'bad', type: 'click', enabled: true, img: 'img[src*="\\34 72f94ebd5ac4ebdbc9b8a2a2ce59366\\.jpg"]',
      hint: 'div:nth-of-type(2) > div > div:nth-of-type(2) > span' },
  ] } };
  const menus = [];
  await install(win, store, menus);
  menus.find(m => m.name.includes('规则管理')).fn();
  const row = win.document.getElementById('icrh-rules-host').shadowRoot.querySelector('.rule[data-rule-id="bad"]');
  assert.match(row.textContent, /建议.*重新添加/);
});

/* ---------------- 点选间隔 ---------------- */

async function clickTimes(cfgExtra, n = 3) {
  const dom = makePage(CLICK_HTML);
  const win = dom.window, doc = win.document;
  const store = {
    icrh_config_v1: Object.assign({ apiKey: 'k', localUrl: '' }, cfgExtra),
    icrh_site_rules_v2: { 'www.rainyun.com': [{ id: 'c1', type: 'click', enabled: true, img: '#bg' }] },
  };
  const menus = [], times = [];
  await install(win, store, menus);
  const pts = Array.from({ length: n }, (_, i) => ({ x_ratio: 0.1 + i * 0.2, y_ratio: 0.5 }));
  win.GM_xmlhttpRequest = (req) => req.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ points: pts }) } }] }) });
  doc.elementFromPoint = () => doc.getElementById('bg');
  doc.getElementById('bg').addEventListener('click', () => times.push(Date.now()));
  menus.find(m => m.name.includes('__recognize')).fn();
  for (let i = 0; i < 100 && times.length < n; i++) await sleep(50);
  await sleep(100);
  return { times, gaps: times.slice(1).map((t, i) => t - times[i]), store, win, menus };
}

test('点选间隔按设置生效：固定 1000ms', async () => {
  const { times, gaps } = await clickTimes({ clickDelayMin: 1000, clickDelayMax: 1000 });
  assert.equal(times.length, 3);
  for (const g of gaps) assert.ok(g >= 950 && g <= 1300, '间隔 ' + g);
});

test('点选间隔为 0 时连续点击；min > max 自动互换', async () => {
  const fast = await clickTimes({ clickDelayMin: 0, clickDelayMax: 0 });
  assert.equal(fast.times.length, 3);
  for (const g of fast.gaps) assert.ok(g < 150, '间隔 ' + g);
  const swapped = await clickTimes({ clickDelayMin: 400, clickDelayMax: 200 });
  for (const g of swapped.gaps) assert.ok(g >= 180 && g <= 550, '间隔 ' + g);
});

test('设置面板可修改点选间隔，非法值不保存', async () => {
  const dom = makePage('<p>x</p>');
  const win = dom.window;
  const orig = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function () { return orig.call(this, { mode: 'open' }); };
  const store = { icrh_config_v1: { localUrl: '', apiKey: 'k' } };
  const menus = [];
  await install(win, store, menus);
  menus.find(m => m.name.includes('设置')).fn();
  const root = win.document.getElementById('icrh-settings-host').shadowRoot;
  assert.equal(root.querySelector('#icrh-delay-min').value, '1000');
  assert.equal(root.querySelector('#icrh-delay-max').value, '1500');
  root.querySelector('#icrh-delay-min').value = 'abc';
  root.querySelector('.icrh-save').click();
  assert.equal(store.icrh_config_v1.clickDelayMin, undefined, '非法值未保存');

  root.querySelector('#icrh-delay-min').value = '800';
  root.querySelector('#icrh-delay-max').value = '1200';
  root.querySelector('.icrh-save').click();
  assert.equal(store.icrh_config_v1.clickDelayMin, 800);
  assert.equal(store.icrh_config_v1.clickDelayMax, 1200);
});
