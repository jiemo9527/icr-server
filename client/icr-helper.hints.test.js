const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, 'icr-helper.user.js'), 'utf8');
const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });
const html = '<div class="captcha_bg_c24e4dac captcha_bg" data-w="300" data-h="200" style="background-image:url(data:image/png;base64,Qkc=)"></div>' +
  '<div class="captcha_ques_c24e4dac captcha_ques" data-w="72" data-h="24"><img src="data:image/png;base64,QQ==" data-x="0"><img src="data:image/png;base64,Qg==" data-x="24"><img src="data:image/png;base64,Qw==" data-x="48"></div>';
function setup() {
  const dom = new JSDOM(html, { url: 'https://example.com', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; windows.push(w);
  w.CSS = { escape: value => value };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const left = Number(this.dataset.x || 0), width = Number(this.dataset.w || 24), height = Number(this.dataset.h || 24);
    return { left, top: 0, width, height, right: left + width, bottom: height };
  };
  w.GM_getValue = (k, d) => d; w.GM_setValue = () => {}; w.GM_registerMenuCommand = () => {};
  w.GM_xmlhttpRequest = () => { throw new Error('不应发网络请求'); };
  const loaded = [], drawn = [], sizes = [];
  w.Image = class { set src(value) { this.srcValue = value; this.naturalWidth = 48; this.naturalHeight = 48; loaded.push(value); setTimeout(() => this.onload?.(), 0); } };
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage(image, ...args) { drawn.push({ src: image.srcValue, args }); } });
  w.HTMLCanvasElement.prototype.toDataURL = function () { sizes.push([this.width, this.height]); return 'data:image/png;base64,Q09NUE9TSVRF'; };
  w.eval(source.replace(/\}\)\(\);\s*$/, 'window.__hints={smartSelector,hintImageData,readHint,challengeStamp,resolvePickTarget,captureVisible,localClick,solveClick};})();'));
  return { w, doc: w.document, api: w.__hints, loaded, drawn, sizes };
}

test('带随机十六进制后缀的类名：规则优先使用稳定类，重建后仍可定位', () => {
  const h = setup(), bg = h.doc.querySelector('.captcha_bg');
  const selector = h.api.smartSelector(bg);
  assert.equal(selector, 'div.captcha_bg');
  bg.className = 'captcha_bg_a18f72bd captcha_bg';
  assert.equal(h.doc.querySelector(selector), bg);
});

test('多张题目图片按页面顺序合成完整图标条，本地和大模型读取一致', async () => {
  const h = setup(), hint = h.doc.querySelector('.captcha_ques');
  const data = await h.api.hintImageData({ hint });
  assert.equal(data, 'data:image/png;base64,Q09NUE9TSVRF');
  assert.deepEqual(h.drawn.map(d => d.src), ['data:image/png;base64,QQ==', 'data:image/png;base64,Qg==', 'data:image/png;base64,Qw==']);
  assert.deepEqual(h.sizes.at(-1), [144, 48]);
  h.drawn.length = 0;
  assert.equal((await h.api.readHint(hint)).dataUrl, data);
  assert.equal(h.drawn.length, 3);
});

test('题目选中单个图标时提升到多图容器，换掉第二个目标也改变指纹', () => {
  const h = setup(), hint = h.doc.querySelector('.captcha_ques'), img = hint.querySelector('img');
  h.doc.elementsFromPoint = () => [img, hint, h.doc.body];
  assert.equal(h.api.resolvePickTarget({ target: img, clientX: 10, clientY: 10 }, 'hint'), hint);
  const cand = { el: h.doc.querySelector('.captcha_bg'), hint };
  const stamp = h.api.challengeStamp(cand);
  hint.children[1].src = 'data:image/png;base64,RA==';
  assert.notEqual(h.api.challengeStamp(cand), stamp);
});

test('三图题目仅返回一个点时拒绝，不把漏识别当成功', async () => {
  const h = setup();
  h.w.GM_xmlhttpRequest = req => req.onload({ status: 200, responseText: JSON.stringify({ ok: true, points: [[120, 188]], width: 300, height: 200 }) });
  await assert.rejects(h.api.localClick({ el: h.doc.querySelector('.captcha_bg'), hint: h.doc.querySelector('.captcha_ques') }), /数量.*不符/);
});

test('多图题目隐藏图标不合成，任一非首图目标更新都改变指纹', async () => {
  const h = setup(), hint = h.doc.querySelector('.captcha_ques');
  hint.children[1].style.display = 'none';
  await h.api.hintImageData({ hint });
  assert.deepEqual(h.drawn.map(d => d.src), ['data:image/png;base64,QQ==', 'data:image/png;base64,Qw==']);
});

test('题目容器里的图片刷新按钮不算目标图标', async () => {
  const h = setup(), hint = h.doc.querySelector('.captcha_ques');
  hint.dataset.w = '96';
  hint.insertAdjacentHTML('beforeend', '<button type="button"><img src="data:image/png;base64,UkVGUkVUSA==" data-x="72"></button>');
  await h.api.hintImageData({ hint });
  assert.deepEqual(h.drawn.map(d => d.src), ['data:image/png;base64,QQ==', 'data:image/png;base64,Qg==', 'data:image/png;base64,Qw==']);
  h.w.GM_xmlhttpRequest = req => req.onload({ status: 200, responseText: JSON.stringify({ ok: true, points: [[30, 30], [100, 100], [200, 100]], width: 300, height: 200 }) });
  assert.equal((await h.api.localClick({ el: h.doc.querySelector('.captcha_bg'), hint })).length, 3);
});

test('大模型返回坐标数量不足时一个也不点', async () => {
  const h = setup(), el = h.doc.querySelector('.captcha_bg');
  let clicks = 0; el.addEventListener('click', () => clicks++);
  await assert.rejects(h.api.solveClick({ el, hint: h.doc.querySelector('.captcha_ques') }, [{ x_ratio: .5, y_ratio: .5 }]), /数量.*不符/);
  assert.equal(clicks, 0);
});
