const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, 'icr-helper.user.js'), 'utf8');
const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const html = '<div id="wrapper"><div id="code"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 50" style="width:100%;height:100%"><path d="M10 10L30 30" fill="currentColor"/></svg></div><div id="mask">点击刷新</div></div><input id="answer">';
async function setup(img = '#mask') {
  const dom = new JSDOM(html, { url: 'https://example.com/login', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; windows.push(w);
  w.Element.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 150, height: 50, right: 160, bottom: 60 });
  const store = { icrh_config_v1: { backend: 'local' }, icrh_site_rules_v2: { 'example.com': [{ id: 'svg', type: 'math', img, input: '#answer' }] } };
  w.GM_getValue = (k, d) => store[k] ?? d;
  w.GM_setValue = (k, v) => { store[k] = v; };
  w.GM_registerMenuCommand = () => {};
  const requests = [], images = [], draws = [];
  let reply;
  w.GM_xmlhttpRequest = req => { requests.push(req); reply = value => req.onload({ status: 200, responseText: JSON.stringify(value) }); };
  w.Image = class { set src(v) { images.push(v); this.naturalWidth = 150; this.naturalHeight = 50; setTimeout(() => this.onload?.(), 0); } };
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage(...args) { draws.push(args); } });
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,UE5H';
  w.eval(source.replace(/\}\)\(\);\s*$/, 'window.__svgTest={scan,getCandidates,findImageSource,resolvePickTarget,imageToDataURL,challengeStamp};})();'));
  await sleep(30);
  return { w, doc: w.document, requests, images, draws, reply: value => reply(value), api: w.__svgTest };
}

test('SVG 验证码旧规则选中刷新遮罩：鼠标移开后仍能识别并填入', async () => {
  const h = await setup();
  h.api.scan();
  const button = h.doc.querySelector('#icrh-fab [data-icrh-target]');
  assert.ok(button);
  h.doc.getElementById('mask').style.opacity = '0';
  button.click();
  await sleep(40);
  assert.equal(h.requests.length, 1, h.doc.getElementById('icrh-toast-box')?.textContent);
  assert.match(h.requests[0].url, /\/math$/);
  assert.equal(JSON.parse(h.requests[0].data).image, 'data:image/png;base64,UE5H');
  h.reply({ ok: true, text: '7', kind: 'math' });
  await sleep(30);
  assert.equal(h.doc.getElementById('answer').value, '7');
});

test('右键点刷新遮罩或 SVG 路径时选择 SVG 根，不保存悬停遮罩', async () => {
  const h = await setup();
  const svg = h.doc.querySelector('svg'), path = svg.querySelector('path');
  const mask = h.doc.getElementById('mask'), wrapper = h.doc.getElementById('wrapper');
  for (const stack of [[mask, path, svg, wrapper], [path, svg, wrapper]]) {
    h.doc.elementsFromPoint = () => stack;
    assert.equal(h.api.resolvePickTarget({ target: stack[0], clientX: 40, clientY: 30 }, 'image'), svg);
  }
});

test('SVG 路径变化但没有文字变化时也算换题，迟到答案不填入', async () => {
  const h = await setup('#code');
  h.api.scan();
  h.doc.querySelector('#icrh-fab [data-icrh-target]').click();
  await sleep(40);
  assert.equal(h.requests.length, 1);
  h.doc.querySelector('path').setAttribute('d', 'M40 10L80 30');
  h.reply({ ok: true, text: 'old' });
  await sleep(30);
  assert.equal(h.doc.getElementById('answer').value, '');
  assert.match(h.doc.getElementById('icrh-toast-box').textContent, /已换图或关闭/);
});

test('SVG 导出固定百分比尺寸并保留页面继承的字色，发 PNG 而不是 SVG', async () => {
  const h = await setup('#code');
  h.doc.getElementById('code').style.color = 'rgb(18, 52, 86)';
  const svg = h.doc.querySelector('svg');
  assert.equal(await h.api.imageToDataURL(svg), 'data:image/png;base64,UE5H');
  const xml = decodeURIComponent(h.images.at(-1).split(',').slice(1).join(','));
  const copy = new h.w.DOMParser().parseFromString(xml, 'image/svg+xml');
  assert.equal(copy.querySelector('parsererror'), null);
  assert.equal(copy.documentElement.getAttribute('width'), '150');
  assert.equal(copy.documentElement.style.width, '150px');
  assert.match(copy.querySelector('path').getAttribute('style'), /rgb\(18, 52, 86\)/);
  assert.equal(svg.style.width, '100%', '导出不能修改页面上的 SVG');
  assert.equal(h.draws.length, 1);
});

test('SVG 所在弹窗隐藏后，即使旧规则匹配遮罩也不生成候选', async () => {
  const h = await setup();
  h.doc.getElementById('wrapper').style.display = 'none';
  assert.equal(h.api.getCandidates().length, 0);
  assert.equal(h.requests.length, 0);
});
