const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, 'icr-helper.user.js'), 'utf8');
const start = source.indexOf("        overlay.querySelector('.icrh-test-local').addEventListener");
const end = source.indexOf("        overlay.querySelector('.icrh-test').addEventListener", start);
assert.ok(start >= 0 && end > start);

async function run(response) {
    const calls = [], notices = [];
    let callback;
    const cfg = { localUrl: 'saved-address', localToken: 'saved-token' };
    const button = { textContent: '', addEventListener: (_, cb) => { callback = cb; } };
    const overlay = { querySelector: selector => {
        if (selector === '.icrh-test-local') return button;
        return { value: selector === '#icrh-local-url' ? 'http://127.0.0.1:8899' : '' };
    } };
    vm.runInNewContext(source.slice(start, end), {
        cfg, overlay,
        localApi: async (route) => {
            calls.push(route);
            if (route !== '/health') throw new Error('本地服务 HTTP 500');
            if (response instanceof Error) throw response;
            return response;
        },
        toast: (text, type) => notices.push({ text, type }),
    });
    await callback();
    assert.deepEqual(cfg, { localUrl: 'saved-address', localToken: 'saved-token' });
    assert.equal(button.textContent, '测试本地服务');
    assert.deepEqual(calls, ['/health'], '连接测试不能上传图片或调用识别接口');
    return notices[0];
}

test('连接测试：健康且无需 Token，仅请求 /health', async () => {
    const r = await run({ ok: true, auth_required: false, auth_ok: true, endpoints: ['/solve', '/ocr'] });
    assert.equal(r.type, 'ok');
});
test('连接测试：Token 错误明确报错', async () => {
    const r = await run({ ok: true, auth_required: true, auth_ok: false });
    assert.equal(r.type, 'err');
    assert.match(r.text, /Token/);
});
test('连接测试：网络故障不能报可用', async () => {
    assert.equal((await run(new Error('连接失败'))).type, 'err');
});
test('连接测试：旧服务缺少鉴权状态时要求升级，不吞掉错误', async () => {
    const r = await run({ ok: true, endpoints: ['/solve', '/ocr'] });
    assert.equal(r.type, 'err');
    assert.match(r.text, /升级|重启/);
});
test('连接测试：健康响应无效时不能报可用', async () => {
    assert.equal((await run({ ok: false, auth_ok: true })).type, 'err');
});
