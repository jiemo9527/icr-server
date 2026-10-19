// ==UserScript==
// @name         易盾点击对照（诊断用，测完删除）
// @namespace    https://github.com/jiemo9527/icr-server/diag
// @version      0.1
// @description  只在网易易盾体验页运行：你在图上按顺序右键标出目标字的位置，脚本用与 ICR 验证码助手相同的方式（脚本事件 + 模拟鼠标移动轨迹）点击，并显示易盾的校验结果。用来判断脚本点击在真实浏览器里能否通过。
// @match        https://dun.163.com/trial/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:12px;top:80px;z-index:2147483647;background:#fff;border:2px solid #5e35b1;border-radius:8px;padding:10px 12px;font:13px/1.6 system-ui,sans-serif;width:300px;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    box.innerHTML = '<b style="color:#5e35b1">易盾点击对照</b><div id="dg-tip"></div>' +
        '<label style="display:block;margin:4px 0"><input type="checkbox" id="dg-move" checked> 点击前模拟鼠标移动轨迹</label>' +
        '<button id="dg-go" style="background:#5e35b1;color:#fff;border:0;border-radius:4px;padding:4px 12px;cursor:pointer">按标记顺序点击</button> ' +
        '<button id="dg-clear" style="border:1px solid #999;background:#fff;border-radius:4px;padding:4px 10px;cursor:pointer">清除标记</button>' +
        '<div id="dg-log" style="margin-top:6px;max-height:220px;overflow:auto;font-size:12px"></div>';
    document.documentElement.appendChild(box);
    const $ = s => box.querySelector(s);
    const log = (t, c) => { const d = document.createElement('div'); d.textContent = new Date().toLocaleTimeString() + ' ' + t; if (c) d.style.color = c; $('#dg-log').prepend(d); };
    $('#dg-tip').textContent = '先选「嵌入式」。用鼠标右键在验证码大图上按题目顺序标出目标字（不会触发验证），再点下面按钮。';

    const bgImg = () => [...document.querySelectorAll('.yidun_bg-img')].find(e => e.getBoundingClientRect().width > 2);
    let marks = [];
    const dots = [];
    const clearMarks = () => { marks = []; dots.splice(0).forEach(d => d.remove()); };
    $('#dg-clear').onclick = clearMarks;

    // 右键标记：只记录相对大图的位置；右键的按下/抬起也拦住，不让易盾收到
    const inBg = e => { const bg = bgImg(); if (!bg) return false; const r = bg.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'])
        document.addEventListener(t, e => { if (e.button === 2 && inBg(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    document.addEventListener('contextmenu', e => {
        const bg = bgImg();
        if (!bg) return;
        const r = bg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        e.preventDefault(); e.stopImmediatePropagation();
        marks.push([e.clientX - r.left, e.clientY - r.top]);
        const d = document.createElement('div');
        d.textContent = marks.length;
        d.style.cssText = `position:fixed;left:${e.clientX - 9}px;top:${e.clientY - 9}px;width:18px;height:18px;border-radius:50%;background:#ff9800;color:#fff;font:bold 12px/18px sans-serif;text-align:center;z-index:2147483646;pointer-events:none`;
        document.documentElement.appendChild(d); dots.push(d);
    }, true);

    // 与 ICR 验证码助手相同的事件派发：pointer + mouse + click
    function fire(type, x, y) {
        const el = document.elementFromPoint(x, y) || bgImg();
        const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY + (window.outerHeight - window.innerHeight), button: 0, view: window };
        if (type !== 'click') {
            const pt = type.replace('mouse', 'pointer');
            el.dispatchEvent(new PointerEvent(pt, Object.assign({}, base, { buttons: pt === 'pointerdown' ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true })));
        }
        el.dispatchEvent(new MouseEvent(type, Object.assign({}, base, { buttons: type === 'mousedown' ? 1 : 0 })));
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let cur = null;
    async function moveTo(x, y) {
        if (!cur) { cur = [x - 80 - Math.random() * 40, y + 60 + Math.random() * 30]; }
        const [sx, sy] = cur, n = 12 + Math.floor(Math.random() * 10);
        for (let i = 1; i <= n; i++) {
            const t = i / n, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            fire('mousemove', sx + (x - sx) * e + (Math.random() - .5) * 1.5, sy + (y - sy) * e + (Math.random() - .5) * 1.5);
            await sleep(12 + Math.random() * 18);
        }
        cur = [x, y];
    }

    // 记录易盾 check 结果（JSONP：拦截 script 标签）
    new MutationObserver(ms => {
        for (const m of ms) for (const n of m.addedNodes) {
            if (n.tagName === 'SCRIPT' && /c\.dun\.163\.com\/api\/v\d\/check/.test(n.src || '')) {
                const cb = (n.src.match(/callback=([^&]+)/) || [])[1];
                if (cb && typeof window[cb] === 'function' && !window[cb].__dg) {
                    const orig = window[cb];
                    window[cb] = function (res) {
                        const ok = res && res.data && res.data.result;
                        log('易盾校验结果：' + (ok ? '通过 ✔' : '失败 ✘'), ok ? '#2e7d32' : '#c62828');
                        return orig.apply(this, arguments);
                    };
                    window[cb].__dg = true;
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });

    $('#dg-go').onclick = async () => {
        const bg = bgImg();
        if (!bg || !marks.length) { log('请先在大图上右键标出位置', '#c62828'); return; }
        const r = bg.getBoundingClientRect(), pts = marks.slice();
        const move = $('#dg-move').checked;
        dots.forEach(d => d.style.opacity = '.35');
        log('开始点击 ' + pts.length + ' 处（' + (move ? '带轨迹' : '无轨迹') + '）');
        cur = null;
        for (const [px, py] of pts) {
            const x = r.left + px, y = r.top + py;
            if (move) await moveTo(x, y);
            fire('mousedown', x, y); await sleep(60 + Math.random() * 60);
            fire('mouseup', x, y); fire('click', x, y);
            await sleep(600 + Math.random() * 500);
        }
        clearMarks();
    };
})();
