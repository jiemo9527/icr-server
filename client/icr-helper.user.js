// ==UserScript==
// @name         ICR 验证码助手
// @namespace    https://github.com/jiemo9527/icr-server
// @version      2.0.0
// @description  按规则识别网页验证码：数字字母、计算题、滑块、图标点选、文字点选。识别由本机 icr-server 完成，可选多模态大模型备选；只填写/点击/拖动，不自动提交。使用大模型时验证码图片会发往你配置的 API。
// @author       jiemo9527
// @license      MIT
// @homepageURL  https://github.com/jiemo9527/icr-server
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    /* ======================================================
     * 配置存储
     * ====================================================== */
    const CFG_KEY = 'icrh_config_v1';
    const RULES_KEY = 'icrh_site_rules_v2';      // { host: [rule, ...] }，每条规则带 id
    const RULES_KEY_V1 = 'icrh_site_rules_v1';   // 旧版：{ host: rule }，读取时自动迁移

    const DEFAULT_CFG = {
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: '',
        model: 'gpt-4o-mini',
        debug: false,
        // —— 本地识别服务（icr_server.py）——
        // 数字字母验证码走 /ocr，腾讯「依次点击图标」走 /solve；留空则全部交给大模型
        localUrl: 'http://127.0.0.1:8899',
        localToken: '',
        llmFallback: true,       // 本地优先模式下，失败时改用大模型
        autoExecute: false,     // 仅已保存规则，目标换图才自动再执行
        backend: 'auto',         // auto=本地优先，local=仅本地，llm=仅大模型
        backendByType: {},       // text/math/slider/click 单独选择，inherit=跟随全局
        // —— 点选：相邻两次点击之间的等待（毫秒），每次在 [min, max] 里随机取 ——
        clickDelayMin: 1000,
        clickDelayMax: 1500,
        // —— LLM 可配置项 ——
        temperature: 0,
        maxTokens: 500,
        extraHeaders: '',        // 额外请求头，JSON 格式，如 {"X-Token":"xxx"}
        promptText: '你是验证码识别器。请识别图片中的验证码字符（数字/字母/汉字/算术题结果）。' +
            '只输出识别结果本身，不要任何解释、引号或多余字符。' +
            '如果是算术验证码（如 3+5=?），输出计算结果数字。如果图中不是验证码，输出 UNKNOWN。',
        promptSlider: '图中是一个滑块拼图验证码。背景图上有一个明显缺口（凹槽）。' +
            '请定位缺口的中心点，返回 JSON：{"x_ratio": <缺口中心横坐标占图片宽度的比例, 0~1 的小数>}。' +
            '只输出 JSON，不要其他内容。',
        promptClick: '图中是一个点选验证码，需要按顺序点击图中指定的文字/字符（按题目要求或从左到右、从上到下的顺序）。' +
            '请返回 JSON：{"points":[{"x_ratio": <横坐标占比 0~1>, "y_ratio": <纵坐标占比 0~1>, "label": "该位置的字符"}, ...]}，' +
            '按点击顺序排列。只输出 JSON，不要其他内容。',
    };

    let cfg = Object.assign({}, DEFAULT_CFG, GM_getValue(CFG_KEY, {}) || {});
    const saveCfg = () => GM_setValue(CFG_KEY, cfg);
    const refreshCfg = () => { cfg = Object.assign({}, DEFAULT_CFG, GM_getValue(CFG_KEY, {}) || {}); };

    /* ------------------------------------------------------
     * 站点规则存储
     * 规则在所有框架间共享（同一脚本的 GM 存储），每次都读最新值，
     * 这样在顶层管理界面里改了 iframe 域名的规则，iframe 里立即生效
     * ------------------------------------------------------ */
    function newRuleId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function normalizeRules(all) {
        const out = {};
        if (!all || typeof all !== 'object') return out;
        for (const [host, v] of Object.entries(all)) {
            const list = (Array.isArray(v) ? v : [v]).filter(r => r && typeof r === 'object' && r.img && r.type);
            // 「完整背景」(full) 已移除：旧规则里的这个字段加载时丢弃
            if (list.length) out[host] = list.map(r => { const { full, ...rest } = r; return Object.assign(rest, { id: r.id || newRuleId() }); });
        }
        return out;
    }

    function loadAllRules() {
        const v2 = GM_getValue(RULES_KEY, null);
        if (v2 && typeof v2 === 'object') {
            const norm = normalizeRules(v2);
            // 缺 id 的（手工导入等）补上后写回，保证删除/停用能定位到单条
            if (JSON.stringify(norm) !== JSON.stringify(v2)) GM_setValue(RULES_KEY, norm);
            return norm;
        }
        const migrated = normalizeRules(GM_getValue(RULES_KEY_V1, {}));
        if (Object.keys(migrated).length) GM_setValue(RULES_KEY, migrated);
        return migrated;
    }

    function saveAllRules(all) {
        for (const h of Object.keys(all)) if (!all[h] || !all[h].length) delete all[h];
        GM_setValue(RULES_KEY, all);
    }

    const getHostRules = (host = location.hostname) => loadAllRules()[host] || [];

    // 编辑已保存规则的选择器：只改给出的字段，空值删除该字段；id、启用和执行设置不变
    function updateRuleSelectors(host, id, values) {
        const all = loadAllRules();
        const current = (all[host] || []).find(r => r.id === id);
        if (!current) return null;
        for (const [k, v] of Object.entries(values)) {
            if (v) current[k] = v; else delete current[k];
        }
        saveAllRules(all);
        return current;
    }

    // 新增规则；同一域名同一类型可以有多条。只有类型和全部选择器都相同才视为同一条（更新）
    const RULE_SELECTOR_KEYS = ['img', 'input', 'handle', 'hint', 'piece'];
    function upsertRule(host, rule) {
        const all = loadAllRules();
        const list = all[host] || (all[host] = []);
        const idx = list.findIndex(r => r.type === rule.type && RULE_SELECTOR_KEYS.every(k => (r[k] || '') === (rule[k] || '')));
        let saved;
        if (idx >= 0) {
            saved = Object.assign({}, rule, { id: list[idx].id, enabled: true });
            list[idx] = saved;
        } else {
            saved = Object.assign({ id: newRuleId(), enabled: true }, rule);
            list.push(saved);
        }
        saveAllRules(all);
        return { rule: saved, updated: idx >= 0, total: list.length };
    }

    function removeRule(host, id) {
        const all = loadAllRules();
        if (!all[host]) return false;
        const before = all[host].length;
        all[host] = all[host].filter(r => r.id !== id);
        saveAllRules(all);
        return all[host] ? all[host].length < before : before > 0;
    }

    function setRuleEnabled(host, id, enabled) {
        const all = loadAllRules();
        const r = (all[host] || []).find(x => x.id === id);
        if (!r) return false;
        r.enabled = !!enabled;
        saveAllRules(all);
        return true;
    }

    function clearHostRules(host) {
        const all = loadAllRules();
        const had = (all[host] || []).length;
        delete all[host];
        saveAllRules(all);
        return had;
    }

    /* ======================================================
     * 日志 / 提示
     * ====================================================== */
    function log(...args) {
        if (cfg.debug) console.log('%c[ICR]', 'color:#7c4dff;font-weight:bold', ...args);
    }
    function toast(msg, type = 'info', ms = 3500) {
        try {
            let box = document.getElementById('icrh-toast-box');
            if (!box) {
                box = document.createElement('div');
                box.id = 'icrh-toast-box';
                box.setAttribute('style', [
                    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
                    'display:flex', 'flex-direction:column', 'gap:8px', 'align-items:flex-end',
                    'pointer-events:none',
                ].join(';'));
                document.documentElement.appendChild(box);
            }
            const colors = { info: '#1e88e5', ok: '#43a047', warn: '#fb8c00', err: '#e53935' };
            const t = document.createElement('div');
            t.setAttribute('style', [
                'max-width:340px', 'padding:8px 12px', 'border-radius:6px',
                'background:' + (colors[type] || colors.info), 'color:#fff',
                'font-size:13px', 'line-height:1.5', 'box-shadow:0 2px 8px rgba(0,0,0,.3)',
                'font-family:system-ui,-apple-system,sans-serif', 'white-space:pre-wrap',
                'word-break:break-all',
            ].join(';'));
            t.textContent = msg;
            box.appendChild(t);
            setTimeout(() => t.remove(), ms);
        } catch (e) { /* ignore */ }
        log(msg);
    }

    /* ======================================================
     * 工具：可见性 / 选择器
     * ====================================================== */
    function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        for (let node=el; node && node.nodeType===1; node=node.parentElement) {
            const st = getComputedStyle(node);
            if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        }
        return true;
    }

    // 选择器里的标签名：用 localName。uni-app H5 会把 <uni-image>/<uni-view> 的 tagName 改写成 IMAGE/VIEW，
    // 用 tagName 拼出的 image > img 在页面上匹配不到任何元素
    function tagSel(el) {
        return CSS.escape(el.localName || el.tagName.toLowerCase());
    }

    function cssPath(el) {
        if (!(el instanceof Element)) return '';
        const path = [];
        while (el && el.nodeType === 1 && path.length < 10) {
            let sel = tagSel(el);
            if (el.id) {
                sel += '#' + CSS.escape(el.id);
                path.unshift(sel);
                break;
            }
            const parent = el.parentNode;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.localName === el.localName);
                if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
            }
            path.unshift(sel);
            el = el.parentElement;
        }
        return path.join(' > ');
    }

    // 选择器是否稳定：不含每次刷新都会变的东西（图片文件名、nth-of-type 路径、随机 id/类名）
    const UNSTABLE_TOKEN = /\d{5,}|[a-f0-9]{12,}|^(css|sc|jsx|_)-[a-z0-9]{4,}$/i;

    // 选择器匹配的元素里有 el，且（全页唯一 或 el 是可见的那个）→ 识别时 queryVisible 能取回它
    function selectorResolves(sel, el) {
        let all;
        try { all = Array.from(document.querySelectorAll(sel)); } catch (e) { return false; }
        if (!all.includes(el)) return false;
        if (all.length === 1) return true;
        if (all.length > 20) return false;   // 太泛（如 div.icon），容易选错
        return queryVisible(sel) === el || queryVisibleImage(sel) === el;
    }

    // 生成尽量稳定、简短的选择器（参考原脚本 Aimed 思路）
    function smartSelector(el) {
        if (!el) return '';
        // 1. id
        if (el.id && !UNSTABLE_TOKEN.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
            return '#' + CSS.escape(el.id);
        }
        // 2. 属性值（data-captcha、name、placeholder、alt 等）
        const attrNames = ['data-captcha', 'name', 'placeholder', 'alt', 'title', 'aria-label'];
        for (const attr of attrNames) {
            const v = el.getAttribute && el.getAttribute(attr);
            if (v && v.length <= 60 && !UNSTABLE_TOKEN.test(v)) {
                const sel = tagSel(el) + '[' + attr + '="' + v.replace(/"/g, '\\"') + '"]';
                if (selectorResolves(sel, el)) return sel;
            }
        }
        // 3. class 组合：只用稳定的类名，且去掉 hover/active 之类的状态类（鼠标移开就没了）
        const cls = (typeof el.className === 'string' ? el.className : '').trim();
        if (cls) {
            const parts = cls.split(/\s+/).filter(p => p.length < 40 && !UNSTABLE_TOKEN.test(p) &&
                !/(^|[-_])(hover|active|focus|focused|selected|current|checked|disabled|loading|show|hide|hidden|visible|open|in|enter|leave|done|fail|success|error)$/i.test(p));
            for (let n = 1; n <= Math.min(parts.length, 3); n++) {
                const sel = tagSel(el) + '.' + parts.slice(0, n).map(CSS.escape).join('.');
                if (selectorResolves(sel, el)) return sel;
            }
        }
        // 3b. 父元素的稳定类名 + 自身标签（如 div.yidun_tips__answer > span）
        const parent = el.parentElement;
        if (parent && parent !== document.body) {
            const pcls = (typeof parent.className === 'string' ? parent.className : '').trim().split(/\s+/)
                .filter(p => p && p.length < 40 && !UNSTABLE_TOKEN.test(p));
            for (const pc of pcls.slice(0, 3)) {
                const sel = tagSel(parent) + '.' + CSS.escape(pc) + ' > ' + tagSel(el);
                if (selectorResolves(sel, el)) return sel;
            }
        }
        // 4. src 特征：验证码图片的文件名每次都换，只用不含随机串的文件名
        if (el.src && el.src.length < 300) {
            try {
                const u = new URL(el.src, location.href);
                const name = u.pathname.split('/').pop();
                if (name && !UNSTABLE_TOKEN.test(name)) {
                    const sel = tagSel(el) + '[src*="' + name.replace(/"/g, '') + '"]';
                    if (selectorResolves(sel, el)) return sel;
                }
            } catch (e) { /* ignore */ }
        }
        // 5. 兜底：CSS 路径
        return cssPath(el);
    }

    function queryOne(sel) {
        if (!sel) return null;
        try { return document.querySelector(sel); } catch (e) { return null; }
    }

    function queryAll(sel) {
        if (!sel) return [];
        try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; }
    }

    // 选择器可能匹配多个元素：弹窗关掉再打开时，很多验证码（如易盾）会新建一套 DOM，
    // 旧的只是 display:none 留在页面里。querySelector 只拿第一个，就会拿到隐藏的旧弹窗。
    // 这里优先取可见的（多个可见时取面积最大的），都不可见再退回第一个。
    function queryVisible(sel, near) {
        const all = queryAll(sel);
        if (all.length <= 1) return all[0] || null;
        const shown = all.filter(el => visible(el) || (el.parentElement && visible(el.parentElement) && el.parentElement !== document.body));
        if (!shown.length) return near ? nearestTo(all, near) : all[0];
        if (shown.length === 1) return shown[0];
        // 有参照元素（大图）时，优先跟它在同一个弹窗里的
        if (near) return nearestTo(shown, near);
        return shown.reduce((a, b) => (rectArea(rectOf(b)) > rectArea(rectOf(a)) ? b : a));
    }

    function nearestTo(list, near) {
        let best = list[0], bestDepth = Infinity;
        for (const el of list) {
            const d = commonAncestorDepth(el, near);
            if (d < bestDepth) { best = el; bestDepth = d; }
        }
        return best;
    }

    // a 到 a、b 最近公共祖先的距离（越小越近）
    function commonAncestorDepth(a, b) {
        let d = 0;
        for (let n = a; n; n = n.parentElement, d++) {
            if (n.contains(b)) return d;
        }
        return Infinity;
    }

    /* ======================================================
     * 图片转 base64（data URL）
     * ====================================================== */
    function gmFetchDataURL(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                timeout: 30000,
                onload(res) {
                    if (res.status >= 200 && res.status < 300) {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(new Error('图片读取失败'));
                        reader.readAsDataURL(res.response);
                    } else {
                        reject(new Error('图片下载失败 HTTP ' + res.status));
                    }
                },
                onerror: () => reject(new Error('图片下载失败（网络错误）')),
                ontimeout: () => reject(new Error('图片下载超时')),
            });
        });
    }

    async function imageToDataURL(el) {
        if (!el) throw new Error('验证码元素不存在');
        const tag = el.tagName.toLowerCase();

        if (tag === 'canvas') {
            try {
                return el.toDataURL('image/png');
            } catch (e) {
                throw new Error('canvas 画布受跨域污染，无法导出图片（该站点 canvas 验证码需站点自身支持）');
            }
        }

        if (tag === 'img' || tag === 'input') {
            const src = el.src || '';
            if (!src) throw new Error('图片没有 src');
            if (src.startsWith('data:')) return src;
            // 先试 canvas（同源可用），失败再走 GM 请求
            try {
                const img = tag === 'img' ? el : null;
                if (img && img.complete && img.naturalWidth > 0) {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    return c.toDataURL('image/png');
                }
            } catch (e) { /* 跨域污染，走 GM 请求 */ }
            return await gmFetchDataURL(src);
        }

        // div 背景图
        const bg = getComputedStyle(el).backgroundImage || '';
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) {
            const url = m[1];
            if (url.startsWith('data:')) return url;
            return await gmFetchDataURL(url);
        }
        throw new Error('无法从该元素获取图片');
    }

    /* ======================================================
     * 按「屏幕上实际可见的区域」截取验证码图片
     * 很多验证码（如网易易盾）把大图和题目图标拼在一张雪碧图里，
     * 再用 overflow:hidden / 负偏移只露出一部分；图片本身还常设 pointer-events:none，
     * 右键只能选到外层容器。这里：
     *   1. 在选中元素内部找真正的图片源（img / canvas / 背景图）
     *   2. 计算它被祖先裁剪后的可见矩形
     *   3. 只把可见部分画到 canvas 上发给模型，点击坐标也按这块区域换算
     * ====================================================== */
    function rectOf(el) {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
    }

    function intersectRect(a, b) {
        const r = {
            left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
            right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
        };
        return (r.right - r.left >= 1 && r.bottom - r.top >= 1) ? r : null;
    }

    const rectArea = r => (r ? (r.right - r.left) * (r.bottom - r.top) : 0);

    // 元素被祖先 overflow 裁剪后的可见矩形
    function visibleRect(el) {
        let r = rectOf(el);
        for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            const st = getComputedStyle(n);
            if (/hidden|clip|auto|scroll/.test(st.overflow + st.overflowX + st.overflowY)) {
                r = intersectRect(r, rectOf(n));
                if (!r) return null;
            }
            if (st.position === 'fixed') break;
        }
        return r;
    }

    function bgUrlOf(el) {
        const m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
        return m && m[1] ? m[1] : '';
    }

    // canvas 状态：'blank' 内容全透明（天爱验证码在大图上盖一层空 canvas 用来画轨迹）；
    // 'tainted' 画过跨域图片、读不出内容；'ok' 可读且有内容
    function canvasState(el) {
        try {
            const ctx = el.getContext('2d');
            if (!ctx || !ctx.getImageData) return 'ok';
            const step = Math.max(1, Math.floor(Math.min(el.width, el.height) / 24));
            for (let y = 0; y < el.height; y += step) {
                const row = ctx.getImageData(0, y, el.width, 1).data;
                for (let i = 3; i < row.length; i += 4 * step) if (row[i]) return 'ok';
            }
            return 'blank';
        } catch (e) { return 'tainted'; }
    }
    const canvasBlank = el => canvasState(el) === 'blank';

    function isImageSource(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.tagName === 'IMG') return !!el.src;
        if (el.tagName === 'CANVAS') return el.width > 0 && el.height > 0 && !canvasBlank(el);
        if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'image') return !!el.src;
        return !!bgUrlOf(el);
    }

    function shownOnScreen(el) {
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }

    // 在选中元素（含自身）里找与选区重叠最多的图片源
    function findImageSource(el) {
        if (!el) return null;
        const region = visibleRect(el) || rectOf(el);
        let best = null, bestArea = 0;
        const list = [el].concat(Array.from(el.querySelectorAll('img, canvas, input[type="image"], [style*="background"], div, span, i')));
        for (const c of list) {
            if (!isImageSource(c) || !shownOnScreen(c)) continue;
            const vr = visibleRect(c);
            const area = rectArea(vr && intersectRect(vr, region));
            if (area > bestArea) { best = c; bestArea = area; }
        }
        // 选中的是盖在图上的空 canvas / 遮罩，或读不出内容的跨域 canvas：在同一父容器里找与它位置重合的图片
        const unreadable = best && best.tagName === 'CANVAS' && canvasState(best) === 'tainted';
        if ((!best || unreadable) && el.parentElement) {
            const minArea = 0.6 * rectArea(region);
            for (const c of el.parentElement.querySelectorAll('img, [style*="background"]')) {
                if (c === el || !isImageSource(c) || !shownOnScreen(c)) continue;
                const vr = visibleRect(c);
                const area = rectArea(vr && intersectRect(vr, region));
                if (area > minArea) { best = c; bestArea = area; break; }
            }
        }
        return best;
    }

    function loadImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const timer = setTimeout(() => reject(new Error('图片解码超时')), 5000);
            img.onload = () => { clearTimeout(timer); resolve(img); };
            img.onerror = () => { clearTimeout(timer); reject(new Error('图片解码失败')); };
            img.src = dataUrl;
        });
    }

    // 背景图在元素内的绘制位置（只处理常见写法：auto / cover / contain / 长度 / 百分比）
    function backgroundBox(el, natW, natH) {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const size = (st.backgroundSize || 'auto').split(',')[0].trim();
        let w = natW, h = natH;
        if (size === 'cover' || size === 'contain') {
            const k = size === 'cover' ? Math.max(r.width / natW, r.height / natH) : Math.min(r.width / natW, r.height / natH);
            w = natW * k; h = natH * k;
        } else if (size !== 'auto') {
            const parts = size.split(/\s+/);
            const len = (v, ref) => (/%$/.test(v) ? parseFloat(v) / 100 * ref : parseFloat(v));
            const pw = parts[0] === 'auto' ? NaN : len(parts[0], r.width);
            const ph = !parts[1] || parts[1] === 'auto' ? NaN : len(parts[1], r.height);
            if (!isNaN(pw) && !isNaN(ph)) { w = pw; h = ph; }
            else if (!isNaN(pw)) { w = pw; h = natH * pw / natW; }
            else if (!isNaN(ph)) { h = ph; w = natW * ph / natH; }
        }
        const pos = (v, free) => (/%$/.test(v) ? parseFloat(v) / 100 * free : (parseFloat(v) || 0));
        const x = pos(st.backgroundPositionX || '0%', r.width - w);
        const y = pos(st.backgroundPositionY || '0%', r.height - h);
        return { left: r.left + x, top: r.top + y, width: w, height: h };
    }

    // 返回 { dataUrl, rect }：rect 是截图对应的视口区域，点击坐标按它换算
    // opts.native：本地识别用，按原图分辨率裁剪，不放大（大模型路径会把小图放大便于看清）
    async function captureVisible(el, opts = {}) {
        const src = findImageSource(el);
        if (!src) throw new Error('选中的元素里没有找到图片（img / canvas / 背景图）');
        const region = intersectRect(visibleRect(src) || rectOf(src), visibleRect(el) || rectOf(el)) || rectOf(src);
        const fullUrl = await imageToDataURL(src);
        const toResult = (dataUrl, r) => ({
            dataUrl,
            rect: { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top },
            source: src,
        });
        // img / canvas 完整可见（没被裁剪）时直接用原图，不用解码重画
        if (src.tagName === 'IMG' || src.tagName === 'CANVAS' || src.tagName === 'INPUT') {
            const full = rectOf(src);
            if (Math.abs(full.left - region.left) < 1 && Math.abs(full.top - region.top) < 1 &&
                Math.abs(full.right - region.right) < 1 && Math.abs(full.bottom - region.bottom) < 1) {
                return toResult(fullUrl, region);
            }
        }
        let img;
        try { img = await loadImage(fullUrl); } catch (e) { return toResult(fullUrl, region); }
        const natW = img.naturalWidth, natH = img.naturalHeight;
        let box;   // 整张图在视口里的位置
        if (src.tagName === 'IMG' || src.tagName === 'CANVAS' || src.tagName === 'INPUT') {
            const r = src.getBoundingClientRect();
            box = { left: r.left, top: r.top, width: r.width, height: r.height };
        } else {
            box = backgroundBox(src, natW, natH);
        }
        const kx = natW / box.width, ky = natH / box.height;
        const sx = Math.max(0, (region.left - box.left) * kx), sy = Math.max(0, (region.top - box.top) * ky);
        const sw = Math.min(natW - sx, (region.right - region.left) * kx);
        const sh = Math.min(natH - sy, (region.bottom - region.top) * ky);
        if (!(sw > 1 && sh > 1)) return toResult(fullUrl, region);
        // 已经是整张图就不用重画
        if (sx < 1 && sy < 1 && Math.abs(sw - natW) < 1 && Math.abs(sh - natH) < 1) return toResult(fullUrl, region);
        // 太小的（如题目图标条）放大，方便模型看清
        const scale = opts.native ? 1 : Math.max(1, Math.min(4, 240 / Math.max(sw, sh * 3)));
        const c = document.createElement('canvas');
        c.width = Math.round(sw * scale);
        c.height = Math.round(sh * scale);
        const ctx = c.getContext('2d');
        if (!ctx) return toResult(fullUrl, region);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        log('按可见区域裁剪', { natW, natH, sx, sy, sw, sh, scale });
        return toResult(c.toDataURL('image/png'), region);
    }

    /* ======================================================
     * 规范化图片 data URL
     * 有的 CDN（如网易易盾）返回 Content-Type: image/jpeg;charset=UTF-8，
     * 读出来是 data:image/jpeg;charset=utf-8;base64,...，OpenAI 兼容接口会拒收
     * （Expected a base64-encoded data URL with an image MIME type）。
     * 这里按文件头识别真实格式，统一成 data:image/xxx;base64,...；
     * 接口不支持的格式（svg、bmp 等）转成 PNG。
     * ====================================================== */
    const API_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

    function sniffImageType(b64) {
        let head = '';
        try { head = atob(b64.slice(0, 24)); } catch (e) { return ''; }
        const b = i => head.charCodeAt(i);
        if (b(0) === 0x89 && head.slice(1, 4) === 'PNG') return 'image/png';
        if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
        if (head.slice(0, 4) === 'GIF8') return 'image/gif';
        if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return 'image/webp';
        return '';
    }

    async function normalizeImageDataUrl(dataUrl) {
        const m = /^data:([^,]*),([\s\S]*)$/.exec(dataUrl || '');
        if (!m) throw new Error('图片数据不是 data URL');
        const meta = m[1].trim();
        const declared = meta.split(';')[0].trim().toLowerCase();
        let b64;
        if (/;\s*base64$/i.test(meta)) {
            b64 = m[2].replace(/\s+/g, '');
        } else {
            // 未 base64 编码的（多见于 svg）：先解码再编码
            const text = decodeURIComponent(m[2]);
            b64 = btoa(unescape(encodeURIComponent(text)));
        }
        const type = sniffImageType(b64) || (API_IMAGE_TYPES.includes(declared) ? declared : '');
        if (type) return 'data:' + type + ';base64,' + b64;
        // 其它格式：交给浏览器解码后重新导出为 PNG
        try {
            const img = await loadImage('data:' + (declared || 'image/png') + ';base64,' + b64);
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            const ctx = c.getContext('2d');
            if (!ctx || !c.width || !c.height) throw new Error('canvas 不可用');
            ctx.drawImage(img, 0, 0);
            return c.toDataURL('image/png');
        } catch (e) {
            throw new Error('不支持的图片格式（' + (meta || '未知') + '），无法发送给模型');
        }
    }

    /* ======================================================
     * 调用多模态大模型（OpenAI 兼容 /chat/completions）
     * ====================================================== */
    // 运行时的提示词以配置项为准，PROMPTS 仅作为旧配置缺省兜底
    const PROMPTS = {
        text: DEFAULT_CFG.promptText,
        slider: DEFAULT_CFG.promptSlider,
        click: DEFAULT_CFG.promptClick,
    };

    function llmChat(payload) {
        if (!cfg.apiKey) throw new Error('未配置大模型 API Key（「设置 → 识别引擎」填写）');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg.apiKey,
        };
        if (cfg.extraHeaders && cfg.extraHeaders.trim()) {
            try {
                const extra = JSON.parse(cfg.extraHeaders);
                Object.assign(headers, extra);
            } catch (e) {
                throw new Error('「额外请求头」不是合法 JSON: ' + e.message);
            }
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: cfg.apiUrl,
                timeout: 90000,
                headers,
                data: JSON.stringify(payload),
                onload(res) {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (res.status >= 200 && res.status < 300) {
                            const content = data.choices && data.choices[0] && data.choices[0].message &&
                                data.choices[0].message.content;
                            if (typeof content === 'string') resolve(content.trim());
                            else reject(new Error('响应中无内容: ' + res.responseText.slice(0, 200)));
                        } else {
                            reject(new Error('API 返回 HTTP ' + res.status + ': ' + res.responseText.slice(0, 200)));
                        }
                    } catch (e) {
                        reject(new Error('API 响应解析失败: ' + res.responseText.slice(0, 200)));
                    }
                },
                onerror: () => reject(new Error('API 请求失败（网络错误或跨域被拦截）')),
                ontimeout: () => reject(new Error('API 请求超时')),
            });
        });
    }

    // 模型拒答：没有 JSON，且是「抱歉 / 不能 / 无法协助」之类的话
    function isModelRefusal(reply) {
        const t = String(reply || '').trim();
        if (!t || /[{[]/.test(t)) return false;
        return /抱歉|对不起|不能|无法|不便|拒绝|sorry|can(?:no|')t|unable to|not able to|won't|I'm not allowed/i.test(t);
    }

    async function askLLM(dataUrl, type, hint) {
        const promptText = { text: cfg.promptText, slider: cfg.promptSlider, click: cfg.promptClick }[type]
            || PROMPTS.text;
        dataUrl = await normalizeImageDataUrl(dataUrl);
        if (hint && hint.dataUrl) {
            try { hint.dataUrl = await normalizeImageDataUrl(hint.dataUrl); } catch (e) {
                log('题目提示图片格式不支持，只发送文字', e);
                hint.dataUrl = '';
            }
        }
        const content = [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: dataUrl } }];
        // 点选验证码的题目提示（文字或图片）单独附上，让模型按题目顺序返回坐标
        if (hint && (hint.text || hint.dataUrl)) {
            content[0].text += '\n第一张图是需要点击的大图，坐标比例均相对于这张大图。';
            if (hint.text) content.push({ type: 'text', text: '题目提示文字：' + hint.text });
            if (hint.dataUrl) {
                content.push({ type: 'text', text: '下面这张小图是题目提示，请严格按其中从左到右的顺序依次点击大图中对应的字符/图案：' });
                content.push({ type: 'image_url', image_url: { url: hint.dataUrl } });
            }
        }
        const payload = {
            model: cfg.model,
            messages: [{
                role: 'user',
                content,
            }],
            temperature: Number(cfg.temperature) || 0,
            max_tokens: Number(cfg.maxTokens) || 500,
        };
        const reply = await llmChat(payload);
        log('LLM 原始返回:', reply);
        if (type === 'text') {
            const clean = reply.replace(/```[a-z]*|```/g, '').trim();
            if (!clean || /UNKNOWN/i.test(clean)) throw new Error('模型未能识别该图片');
            return { text: clean };
        }
        // slider / click：解析 JSON
        let jsonText = reply.replace(/```json|```/g, '').trim();
        const braceStart = jsonText.indexOf('{');
        const braceEnd = jsonText.lastIndexOf('}');
        if (braceStart >= 0 && braceEnd > braceStart) jsonText = jsonText.slice(braceStart, braceEnd + 1);
        try {
            return JSON.parse(jsonText);
        } catch (e) {
            if (isModelRefusal(reply)) {
                const err = new Error('模型拒绝了这次请求（「' + reply.slice(0, 60) + '」）。' +
                    '这是模型服务方的内容策略，不是脚本解析出错；同一模型对不同图片可能时而接受时而拒绝。' +
                    '可在设置里换用允许该用途的模型，或改用本地识别服务');
                err.refusal = true;
                throw err;
            }
            throw new Error('模型返回的不是合法 JSON: ' + reply.slice(0, 120));
        }
    }

    /* ======================================================
     * 本地识别服务（icr_server.py）
     *   /ocr   数字字母图形验证码 → 文本（ddddocr）
     *   /solve 腾讯「请依次点击」图标点选 → 坐标（OpenCV 模板匹配）
     *   /math  简单计算题 → OCR 交叉复核 + 安全四则解析
     *   /slider 普通滑块 → 滑块图片模板/形状匹配
     * 不支持或不确定时使用大模型备选
     * ====================================================== */
    const localBase = () => String(cfg.localUrl || '').trim().replace(/\/+$/, '');

    function localApi(path, body) {
        const base = localBase();
        if (!base) return Promise.reject(new Error('未配置本地识别服务'));
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.localToken) headers['X-ICR-Token'] = cfg.localToken;
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: body ? 'POST' : 'GET',
                url: base + path,
                headers,
                data: body ? JSON.stringify(body) : undefined,
                timeout: 20000,
                onload(res) {
                    if (res.status === 401) return reject(new Error('本地服务 Token 错误'));
                    if (res.status !== 200) {
                        return reject(new Error('本地服务 HTTP ' + res.status + ' ' + String(res.responseText || '').slice(0, 100)));
                    }
                    try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(new Error('本地服务返回的不是 JSON')); }
                },
                onerror: () => reject(new Error('本地服务连不上（' + base + '）')),
                ontimeout: () => reject(new Error('本地服务超时')),
            });
        });
    }

    // 兼容旧服务只返回算式的情况：不将未计算的表达式直接填入。x/X 可以是普通字符。
    function looksLikeMath(text) {
        return /\d\s*[+\-*/×÷]\s*\d|[=＝]/.test(text || '');
    }

    async function localText(dataUrl, cand) {
        const rule = cand.rule || {};
        const body = { image: dataUrl, charset: rule.charset || 'alnum',
            case: rule.case || 'any', mode: cand.type === 'math' ? 'math' : (rule.mode || 'auto') };
        if (Number.isInteger(rule.length) && rule.length > 0) body.length = rule.length;
        const r = await localApi(cand.type === 'math' ? '/math' : '/ocr', body);
        if (!r.ok) throw new Error('未识别（' + (r.msg || '无结果') + '）');
        cand.localKind = r.kind === 'math' || cand.type === 'math' ? 'math' : 'text';
        return r.text;
    }

    // 题目区里除去「请依次点击」之类的说明后，还剩汉字 → 是汉字点选（易盾等），本地做不了
    function hintHasTargetChars(text) {
        const rest = String(text || '').replace(/请?(依次|按顺序)?点击|请依次|[：:\s"“”'‘’，,、]/g, '');
        return /[\u4e00-\u9fff]/.test(rest);
    }

    // 题目元素（或其附近）里的图标条图片
    function hintImageSource(hintEl) {
        for (let n = hintEl, i = 0; n && i < 3 && n !== document.body; n = n.parentElement, i++) {
            const src = findImageSource(n);
            if (src) return src;
        }
        return null;
    }

    function clickHintText(cand) {
        if (!cand.hint) return '';
        return (cand.hint.innerText || cand.hint.textContent || '') +
            (cand.hint.parentElement ? ' ' + (cand.hint.parentElement.innerText || '') : '');
    }

    // 点选走哪种本地识别：规则 localClick = auto（默认，按题目判断）/ icon / text / off。
    // auto：题目里有目标汉字 → 文字点选（/textclick）；否则题目有图标图片 → 图标点选（/solve）。
    // 不再限定腾讯：网易等站点同样可用，效果以实测为准；不需要时在规则里选「关闭」改走大模型。
    const LOCAL_CLICK_MODES = { auto: '自动判断', icon: '图标点选', text: '文字点选', off: '关闭（用大模型）' };
    // auto 且题目只有图片时返回 'image'：先让服务端判断图片里是不是汉字（天爱验证码），不是再按图标点选
    function localClickMode(cand) {
        if (!localBase() || !cand.hint) return null;
        const mode = cand.rule && Object.hasOwn(LOCAL_CLICK_MODES, cand.rule.localClick) ? cand.rule.localClick : 'auto';
        if (mode === 'off') return null;
        if (mode !== 'auto') return mode;
        if (hintHasTargetChars(clickHintText(cand))) return 'text';
        return hintImageSource(cand.hint) ? 'image' : null;
    }

    // 本地点选的大图：按可见区域裁剪（易盾 320x240 原图只显示上面 320x160），原图分辨率
    async function localClickBg(cand) {
        const shot = await captureVisible(cand.el, { native: true });
        cand.area = shot.rect;
        return shot;
    }
    const pointsFrom = (r, labels) => r.points.map(([x, y], i) => ({ x_ratio: x / r.width, y_ratio: y / r.height, label: (labels || [])[i] || String(i + 1) }));

    // 题目图片（天爱验证码「请依次点击:」后面写着汉字的图）：按可见区域、原图分辨率截取
    async function hintImageData(cand) {
        const src = hintImageSource(cand.hint);
        if (!src) return null;
        const el = src.contains(cand.hint) ? src : (cand.hint.contains(src) ? cand.hint : src);
        return (await captureVisible(el, { native: true })).dataUrl;
    }

    // withImage：题目文字里没有目标字时，把题目图片一起发给服务端读字。
    // 服务端判定图片不是文字（图标条）时返回 null，由调用方改走图标点选
    async function localTextClick(cand, withImage = false) {
        if (!findImageSource(cand.el)) throw new Error('未识别到元素：缺少大图');
        const text = ((cand.hint.innerText || cand.hint.textContent || '').trim() || clickHintText(cand)).slice(0, 100);
        const shot = await localClickBg(cand);
        const body = { bg: shot.dataUrl, targets: text };
        if (withImage || !hintHasTargetChars(text)) {
            const img = await hintImageData(cand);
            if (img) body.hint_image = img;
        }
        const r = await localApi('/textclick', body);
        if (r.reason === 'hint_not_text') return null;
        if (!r.ok || !Array.isArray(r.points) || !r.points.length) {
            const error = new Error('未识别到文字（' + (r.msg || '无结果') + '）');
            // 服务端已经读出了目标字：确定是文字点选，只是没找准位置
            error.textConfirmed = Array.isArray(r.targets) && r.targets.length > 0;
            throw error;
        }
        return pointsFrom(r, r.targets);
    }

    // 返回与大模型相同格式的 points（相对大图的 0~1 比例），并把点击区域设为大图元素本身
    async function localSlider(cand) {
        const rule = cand.rule || {};
        const piece = queryVisibleImage(rule.piece);
        if (!piece) return null; // 没有滑块图片不猜缺口，继续大模型路线
        const shot = await captureVisible(cand.el);
        const body = { bg: shot.dataUrl };
        if (piece) {
            const src=findImageSource(piece)||piece;
            body.piece=await imageToDataURL(src);
            if (src.tagName !== 'IMG' && src.tagName !== 'CANVAS') {
                const im=await loadImage(body.piece), box=backgroundBox(src,im.naturalWidth,im.naturalHeight), rect=piece.getBoundingClientRect();
                const kx=im.naturalWidth/box.width, ky=im.naturalHeight/box.height;
                body.piece_crop=[Math.max(0,Math.round((rect.left-box.left)*kx)),Math.max(0,Math.round((rect.top-box.top)*ky)),Math.round(rect.width*kx),Math.round(rect.height*ky)];
                const bgImage=await loadImage(shot.dataUrl);
                body.piece_scale=bgImage.naturalWidth/shot.rect.width/kx;
            }
        }
        const r = await localApi('/slider', body);
        if (!r.ok) throw new Error('未识别到缺口（' + (r.msg || '不确定') + '）');
        if (!Number.isFinite(r.gap_left) || !(r.width > 0) || r.gap_left < 0 || r.gap_left >= r.width) {
            throw new Error('服务返回的缺口坐标异常');
        }
        const scale = shot.rect.width / r.width;
        const target = shot.rect.left + r.gap_left * scale;
        let current;
        if (piece) {
            const rect = piece.getBoundingClientRect();
            // 服务端保留透明通道，返回滑块原图宽度与可见边缘偏移。
            const pieceWidth = r.piece_width;
            if (!(pieceWidth > 0)) throw new Error('本地服务未返回滑块原图宽度，请升级服务端');
            const offset = (r.piece_offset_left || 0) * rect.width / pieceWidth;
            current = rect.left + offset;
        } else if (Number.isFinite(rule.pieceStartRatio)) {
            current = shot.rect.left + rule.pieceStartRatio * shot.rect.width;
        } else {
            throw new Error('请指定滑块图片或滑块起始位置，不能把缺口坐标直接当拖动距离');
        }
        const distance = target-current;
        if (!Number.isFinite(distance) || distance < 0 || distance > shot.rect.width) throw new Error('滑块拖动距离异常');
        cand.area = shot.rect;
        const track = piece ? { piece, offset: current - piece.getBoundingClientRect().left, target } : null;
        return { x_ratio: (r.gap_left + (r.gap_width || 0)/2)/r.width, distance, track };
    }

    async function localClick(cand) {
        const spSrc = hintImageSource(cand.hint);
        if (!findImageSource(cand.el) || !spSrc) throw new Error('未识别到元素：缺少大图或题目图标');
        // 题目图也按可见区域裁剪：易盾的题目条和大图是同一张图，只露出 80x19 的一条
        const hintEl = spSrc.contains(cand.hint) ? spSrc : (cand.hint.contains(spSrc) ? cand.hint : spSrc);
        const [shot, sprite] = await Promise.all([localClickBg(cand), captureVisible(hintEl, { native: true })]);
        const r = await localApi('/solve', { bg: shot.dataUrl, sprite: sprite.dataUrl });
        if (!r.ok || !Array.isArray(r.points) || !r.points.length) {
            throw new Error('未识别到图标（' + (r.msg || '无结果') + '）');
        }
        return pointsFrom(r);
    }

    const BACKEND_LABELS = {auto: '本地优先', local: '仅本地', llm: '仅大模型'};
    const BACKEND_TYPES = {text: '数字字母 / 自动文本', math: '计算题', slider: '滑块', click: '点选'};

    function backendFor(cand) {
        if (cand.rule && Object.hasOwn(BACKEND_LABELS, cand.rule.backend)) return cand.rule.backend;
        const perType = (cfg.backendByType || {})[cand.type];
        if (Object.hasOwn(BACKEND_LABELS, perType)) return perType;
        return Object.hasOwn(BACKEND_LABELS, cfg.backend) ? cfg.backend : 'auto';
    }

    // 强制仅本地绝不访问大模型；自动模式沿用旧版备选开关。
    function fallbackOrThrow(localErr, why, mode = 'auto') {
        const reason = why || (localErr && localErr.message) || '本地识别失败';
        if (mode === 'local') throw new Error(reason + '；当前为仅本地，未使用大模型');
        if (cfg.llmFallback && cfg.apiKey) {
            log('本地识别失败，改用大模型：', reason);
            return;
        }
        throw new Error(reason + (cfg.apiKey ? '；已关闭「本地失败时改用大模型」' : '；未配置大模型 API Key，无备选（「设置 → 识别引擎」填写）'));
    }

    // 大模型常不按要求返回 0~1 比例：可能给像素坐标、0~1000 千分比或 x/y 字段名。
    // 统一换算成比例；判断不了单位的保持原样，由 solveClick 拒绝（不猜着点）。
    function normalizeLlmPoints(points, natW, natH) {
        if (!Array.isArray(points)) return points;
        const pts = points.map(p => {
            if (Array.isArray(p)) p = { x: p[0], y: p[1] };
            if (!p || typeof p !== 'object') return p;
            const x = Number(p.x_ratio ?? p.x), y = Number(p.y_ratio ?? p.y);
            return { ...p, x_ratio: x, y_ratio: y };
        });
        const valid = pts.filter(p => p && Number.isFinite(p.x_ratio) && Number.isFinite(p.y_ratio) && p.x_ratio >= 0 && p.y_ratio >= 0);
        if (valid.length !== pts.length) return pts;
        const mx = Math.max(...valid.map(p => p.x_ratio)), my = Math.max(...valid.map(p => p.y_ratio));
        if (mx <= 1 && my <= 1) return pts;
        let sx, sy;
        if (natW > 0 && natH > 0 && mx <= natW && my <= natH) { sx = natW; sy = natH; }   // 像素坐标
        else if (mx <= 1000 && my <= 1000) { sx = 1000; sy = 1000; }                      // 千分比（Qwen 等）
        else return pts;
        log('大模型坐标单位换算', mx, my, '→ 除以', sx, sy);
        return pts.map(p => ({ ...p, x_ratio: p.x_ratio / sx, y_ratio: p.y_ratio / sy }));
    }

    // 弹出消息里的引擎名：本地按类型细分，ICR 专指腾讯图标点选
    const LOCAL_ENGINE = { text: '本地 OCR', math: '本地计算', slider: '本地滑块', click: 'ICR', textclick: '本地文字点选' };
    const engineName = (type, via) => (via === 'llm' ? '大模型' : LOCAL_ENGINE[type] || '本地');

    // 读取点选题目提示：优先取元素本身/内部的图片，同时带上可见文字
    async function readHint(el) {
        if (!el) return null;
        // 易盾的题目会在「文字」和「图标」之间切换：选中的元素这次可能是空的，
        // 那就往上找最近一个有文字或图片的容器
        let node = el;
        for (let i = 0; i < 3 && node && node.parentElement; i++) {
            const txt = (node.innerText || node.textContent || '').trim();
            if (txt || findImageSource(node)) break;
            node = node.parentElement;
        }
        el = node || el;
        const hint = { text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) };
        if (findImageSource(el)) {
            try { hint.dataUrl = (await captureVisible(el)).dataUrl; } catch (e) { log('题目提示图片读取失败', e); }
        }
        return hint;
    }

    /* ======================================================
     * 填写输入框（兼容 React / Vue 受控组件）
     * ====================================================== */
    function fillInput(input, value) {
        input.focus();
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(input, value);
        else input.value = value;
        for (const name of ['input', 'change']) {
            input.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }));
        }
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || 'a' }));
        input.blur();
    }

    /* ======================================================
     * 滑块：模拟真人拖动（先快后慢 + 轻微超调回拉）
     * ====================================================== */
    // 油猴沙箱里的 window 是代理对象，传给 MouseEvent 的 view 会报
    // "Failed to convert value to 'Window'"。改用目标元素所在文档的真实 window，
    // 并用该 window 自己的事件构造器；仍失败就去掉 view 再建。
    function realView(el) {
        const doc = (el && el.ownerDocument) || (el && el.nodeType === 9 ? el : document);
        return doc.defaultView || null;
    }

    function makeEvent(ctorName, el, type, init) {
        const view = realView(el);
        const Ctor = (view && view[ctorName]) || globalThis[ctorName];
        if (!Ctor) return null;
        try {
            return new Ctor(type, Object.assign({}, init, { view }));
        } catch (e) {
            return new Ctor(type, init);
        }
    }

    // 视口坐标 → 屏幕坐标（真实事件都带 screenX/Y，全 0 容易被风控识别）
    function screenXY(x, y) {
        const v = window;
        const chromeTop = Math.max(0, (v.outerHeight || 0) - (v.innerHeight || 0));
        return { screenX: Math.round(x + (v.screenX || 0)), screenY: Math.round(y + (v.screenY || 0) + chromeTop) };
    }

    function dispatchMouse(el, type, x, y, extra) {
        const target = el || document;
        const base = Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 }, screenXY(x, y));
        const pType = type.replace('mouse', 'pointer');
        const pressed = type === 'mousedown' || (type === 'mousemove' && extra && extra.buttons);
        // 真实浏览器顺序：pointerdown → mousedown，pointerup → mouseup
        try {
            const pe = makeEvent('PointerEvent', target, pType, Object.assign({}, base, {
                buttons: pType === 'pointerup' ? 0 : (type === 'mousemove' ? 0 : 1),
                pointerId: 1, pointerType: 'mouse', isPrimary: true,
            }, extra || {}));
            if (pe) target.dispatchEvent(pe);
        } catch (e) { /* 老浏览器忽略 */ }
        const ev = makeEvent('MouseEvent', target, type, Object.assign({}, base, {
            buttons: type === 'mouseup' ? 0 : (type === 'mousemove' ? 0 : 1),
        }, extra || {}));
        target.dispatchEvent(ev);
        return pressed;
    }

    // 点选前的鼠标移动轨迹：从上一个位置（首次从目标外侧随机一点）沿略带弯曲的缓动曲线移到目标，
    // 每步派发到该坐标下的页面元素，附带 ±1px 抖动。网易易盾等会记录点击前的移动轨迹。
    let lastPointer = null;
    const sleepMs = ms => new Promise(r => setTimeout(r, ms));
    // 等到某个时刻：按墙钟计算，计时器的粗粒度（Windows 约 15.6ms）不会逐步累积
    async function sleepUntil(at) {
        const wait = at - Date.now();
        if (wait >= 4) await sleepMs(wait);
    }
    // durationMs：整段轨迹的耗时（0 表示连续派发、不等待）
    async function movePointer(x, y, fallbackEl, assertCurrent = () => {}, durationMs = 300) {
        let sx, sy;
        if (lastPointer) [sx, sy] = lastPointer;
        else { const a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 60; sx = x + Math.cos(a) * d; sy = y + Math.sin(a) * d; }
        const steps = 12 + Math.floor(Math.random() * 10);
        const bend = (Math.random() - 0.5) * 0.35;          // 轨迹弯曲程度
        const nx = -(y - sy), ny = x - sx;                 // 垂直方向
        const t0 = Date.now();
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const arc = Math.sin(Math.PI * t) * bend;
            const jitter = i === steps ? 0 : 1;
            const px = sx + (x - sx) * e + nx * arc + (Math.random() - 0.5) * 2 * jitter;
            const py = sy + (y - sy) * e + ny * arc + (Math.random() - 0.5) * 2 * jitter;
            dispatchMouse(pointTarget(px, py) || fallbackEl, 'mousemove', px, py);
            if (durationMs > 0) await sleepUntil(t0 + durationMs * t);
            if (i % 4 === 0) assertCurrent();
        }
        lastPointer = [x, y];
    }

    // 部分滑块（腾讯 TJCaptcha 等）只监听 touch 事件，合成的 mouse/pointer 会被忽略
    function dispatchTouch(el, type, x, y) {
        const view = realView(el) || window;
        if (!view.TouchEvent || !view.Touch) return;
        try {
            const touch = new view.Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x + view.scrollX, pageY: y + view.scrollY });
            const list = type === 'touchend' ? [] : [touch];
            el.dispatchEvent(new view.TouchEvent(type, {
                bubbles: true, cancelable: true, composed: true,
                touches: list, targetTouches: list, changedTouches: [touch],
            }));
        } catch (e) { /* 不支持 Touch 构造器的浏览器忽略 */ }
    }

    function dragStep(handle, phase, x, y) {
        const mouse = {down: 'mousedown', move: 'mousemove', up: 'mouseup'}[phase];
        dispatchMouse(phase === 'down' ? handle : document, mouse, x, y);
        // touch 事件的 target 必须是按下时的元素
        dispatchTouch(handle, {down: 'touchstart', move: 'touchmove', up: 'touchend'}[phase], x, y);
    }

    function handleOffset(handle) {
        const r = handle.getBoundingClientRect();
        return r.left;
    }

    // correct(x)：拖到终点 x 后返回还差多少像素（拼图块实际位置与缺口的差），用于闭环修正；不提供则按距离直接松手
    function humanDrag(handle, startX, startY, distance, assertCurrent = () => {}, correct = null) {
        return new Promise((resolve, reject) => {
            assertCurrent();
            dragStep(handle, 'down', startX, startY);
            const total = Math.max(1, distance);
            const steps = 28;
            let i = 0, lastX = startX, lastY = startY;
            const guard = () => {
                try { assertCurrent(); return true; }
                catch (error) {
                    clearInterval(timer);
                    dragStep(handle, 'up', lastX, lastY);
                    reject(error);
                    return false;
                }
            };
            const timer = setInterval(() => {
                if (!guard()) return;
                i++;
                let progress;
                if (i <= steps - 4) {
                    // 先快后慢
                    progress = Math.min(1, Math.pow(i / (steps - 4), 0.7));
                } else {
                    // 超调后回拉
                    const back = i - (steps - 4);
                    progress = Math.min(1.012, 1.012 - back * 0.004);
                }
                const x = startX + total * progress;
                const y = startY + (Math.random() - 0.5) * 2;
                lastX = x; lastY = y;
                dragStep(handle, 'move', x, y);
                if (i >= steps) {
                    clearInterval(timer);
                    setTimeout(async () => {
                        if (!guard()) return;
                        let endX = startX + total;
                        dragStep(handle, 'move', endX, startY);
                        // 闭环修正：有的网站拼图块不与把手 1:1 跟随（如易盾前 20px 半速），按实际差值再挪几次
                        for (let k = 0; correct && k < 4; k++) {
                            await sleepMs(60);
                            if (!guard()) return;
                            const miss = correct(endX);
                            if (!Number.isFinite(miss) || Math.abs(miss) < 0.5) break;
                            const stepTo = endX + miss, from = endX;
                            for (let j = 1; j <= 4; j++) {
                                await sleepMs(15 + Math.random() * 15);
                                dragStep(handle, 'move', from + (stepTo - from) * j / 4, startY + (Math.random() - 0.5));
                            }
                            endX = stepTo;
                        }
                        await sleepMs(60 + Math.random() * 80);
                        if (!guard()) return;
                        dragStep(handle, 'move', endX, startY);
                        dragStep(handle, 'up', endX, startY);
                        resolve();
                    }, 80 + Math.random() * 120);
                }
            }, 30);
        });
    }

    async function solveSlider(cand, xRatio, localDistance, assertCurrent = () => {}, track = null) {
        assertCurrent();
        const imgRect = cand.area || cand.el.getBoundingClientRect();
        const handle = cand.handle;
        if (!handle) throw new Error('未识别到元素：滑块把手不在页面（可在「规则管理」检查）');
        const hr = handle.getBoundingClientRect();
        const startX = hr.left + hr.width / 2;
        const startY = hr.top + hr.height / 2;
        const targetAbsX = imgRect.left + xRatio * imgRect.width;
        let dist = Number.isFinite(localDistance) ? localDistance : targetAbsX - startX;
        dist = Math.max(0, dist);
        log('滑块拖动距离:', dist);
        const before = handleOffset(handle);
        let moved = 0;
        const watch = () => { if (handle.isConnected) moved = Math.max(moved, Math.abs(handleOffset(handle) - before)); };
        const observer = new MutationObserver(watch);
        observer.observe(handle, { attributes: true, attributeFilter: ['style', 'class'] });
        const poll = setInterval(watch, 30);
        // track：{ piece, offset, target } —— 拼图块元素、可见边缘偏移、缺口在视口里的左边缘
        let correct = null;
        if (track && track.piece) {
            const pieceStart = track.piece.getBoundingClientRect().left;
            correct = () => {
                const now = track.piece.getBoundingClientRect().left;
                if (Math.abs(now - pieceStart) < 2) return 0;          // 拼图块不跟随把手：不补偿，避免越拖越远
                const miss = track.target - (now + track.offset);
                return Math.abs(miss) > 30 ? 0 : miss;                  // 差太多说明不是跟随关系，不乱补
            };
        }
        try {
            await humanDrag(handle, startX, startY, dist, assertCurrent, correct);
        } finally {
            clearInterval(poll); observer.disconnect(); watch();
        }
        // 网站拖动后可能立即复位或换图；只看拖动过程中把手是否跟随
        if (dist > 8 && moved < Math.min(6, dist / 3)) {
            throw new Error('滑块把手没有跟随拖动（网站可能只接受真实鼠标事件），请手动拖动');
        }
    }

    // 坐标处最上层的页面元素（跳过脚本自己的悬浮按钮/提示等）
    function pointTarget(x, y) {
        let stack = [];
        try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { /* ignore */ }
        if (!stack.length) {
            const one = document.elementFromPoint && document.elementFromPoint(x, y);
            if (one) stack = [one];
        }
        return stack.find(el => !isOwnUi(el)) || null;
    }

    /* ======================================================
     * 点选：按坐标依次点击
     * ====================================================== */
    // 点选间隔（毫秒）：读设置，非法值回退默认，min > max 时互换
    function clickDelayRange() {
        const num = (v, d) => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 ? Math.min(n, 10000) : d;
        };
        let min = num(cfg.clickDelayMin, DEFAULT_CFG.clickDelayMin);
        let max = num(cfg.clickDelayMax, DEFAULT_CFG.clickDelayMax);
        if (min > max) [min, max] = [max, min];
        return { min, max };
    }

    function nextClickDelay() {
        const { min, max } = clickDelayRange();
        return Math.round(min + Math.random() * (max - min));
    }

    async function solveClick(cand, points, assertCurrent = () => {}) {
        if (!Array.isArray(points) || !points.length) throw new Error('未得到点击坐标');
        if (points.some(p => !p || ![p.x_ratio, p.y_ratio].every(v => Number.isFinite(v) && v >= 0 && v <= 1))) {
            throw new Error('点击坐标无效或超出图片范围，未执行点击');
        }
        const imgRect = cand.area || cand.el.getBoundingClientRect();
        lastPointer = null;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            // 相邻两次点击之间的总间隔 = 设定值（含移动轨迹、到位停顿、按压）；第一次点击不受间隔限制。
            // 自然耗时（轨迹 200~450ms、停顿 60~200ms、按压 50~120ms）超过设定间隔时按比例压缩，间隔 0 → 不等待
            const started = Date.now();
            const gap = i > 0 ? nextClickDelay() : null;
            let move = 200 + Math.random() * 250, settle = 60 + Math.random() * 140, press = 50 + Math.random() * 70;
            if (gap !== null) {
                const scale = Math.min(1, gap / (move + settle + press));
                move *= scale; settle *= scale; press *= scale;
            }
            assertCurrent();
            const x = imgRect.left + p.x_ratio * imgRect.width;
            const y = imgRect.top + p.y_ratio * imgRect.height;
            await movePointer(x, y, cand.el, assertCurrent, move);
            await sleepUntil(started + move + settle);                       // 到位后稍停
            if (gap !== null) await sleepUntil(started + gap - press);       // 补足设定间隔
            assertCurrent();
            const target = pointTarget(x, y) || cand.el;
            log('点选:', p.label, x.toFixed(0), y.toFixed(0));
            dispatchMouse(target, 'mousedown', x, y);
            await sleepUntil(Date.now() + press);                            // 按下到抬起
            dispatchMouse(target, 'mouseup', x, y);
            target.dispatchEvent(makeEvent('MouseEvent', target, 'click', Object.assign({
                bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 0, detail: 1,
            }, screenXY(x, y))));
        }
    }

    /* ======================================================
     * 按规则定位验证码元素
     * ====================================================== */
    function elementSignature(el) {
        return [
            el.id, el.className, el.alt, el.title, el.name, el.src, el.getAttribute('data-src') || '',
        ].filter(Boolean).join(' ').toLowerCase();
    }

    function findSliderHandle(imgEl) {
        let node = imgEl;
        for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
            if (!node.parentElement) continue;
            const els = node.parentElement.querySelectorAll('*');
            for (const el of els) {
                if (el === imgEl || !visible(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 16 || r.width > 90 || r.height < 10 || r.height > 90) continue;
                const sig = elementSignature(el);
                if (!/slid|drag|handle|btn|block|icon|button/.test(sig)) continue;
                if (getComputedStyle(el).cursor === 'pointer') return el;
            }
        }
        return null;
    }

    // 大图：可见判断要考虑「图片被裁剪只露一部分」的情况
    function queryVisibleImage(sel) {
        const all = queryAll(sel);
        if (all.length <= 1) return all[0] || null;
        let best = null, bestArea = 0;
        for (const el of all) {
            const src = findImageSource(el) || el;
            const area = rectArea(visibleRect(src)) || (visible(el) ? rectArea(rectOf(el)) : 0);
            if (area > bestArea) { best = el; bestArea = area; }
        }
        return best || all[0];
    }

    // 元素本身或其父元素可见（易盾的题目 span 在图标模式下是空的，但父容器可见）。
    // 元素自身或祖先被 display:none / visibility:hidden 隐藏时不算（易盾滑块页的 .yidun_tips__answer.hide）
    function hiddenByStyle(el) {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const st = getComputedStyle(n);
            if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return true;
        }
        return false;
    }
    function shownSelfOrParent(el) {
        if (!el || hiddenByStyle(el)) return false;
        return visible(el) || (el.getBoundingClientRect().width < 2 &&
            !!el.parentElement && el.parentElement !== document.body && visible(el.parentElement));
    }

    // 大图是否显示中：元素本身可见，或它实际显示的图片来源可见。
    // uni-app 的 <uni-image> 里 img 是 opacity:0，图片由同层背景 div 显示，选中 img 时不能当成已关闭
    function imageShown(imgEl) {
        if (!imgEl || !imgEl.isConnected) return false;
        if (visible(imgEl)) return true;
        const src = findImageSource(imgEl);
        const area = src && visibleRect(src);
        return !!(src && visible(src) && area && rectArea(area) > 100);
    }

    // 评估一条规则在当前页面是否适用：图不在 → null；配套元素不在 → missing
    function evalRule(rule) {
        const imgEl = queryVisibleImage(rule.img);
        if (!imgEl || !imageShown(imgEl)) return null;
        const src = findImageSource(imgEl);
        const cand = {
            type: rule.type,
            el: imgEl,
            input: queryVisible(rule.input, imgEl),
            handle: queryVisible(rule.handle, imgEl),
            hint: queryVisible(rule.hint, imgEl),
            rule,
            key: 'rule|' + rule.id + '|' + ((src && (src.src || bgUrlOf(src))) || cssPath(imgEl)),
        };
        let missing = false;
        let score = 0;
        if (rule.type === 'slider') {
            if (cand.handle && !visible(cand.handle)) cand.handle = null;
            if (!cand.handle && !rule.handle) cand.handle = findSliderHandle(imgEl);
            if (cand.handle) score += 2; else missing = true;
        } else if (rule.type === 'click') {
            if (rule.hint) {
                if (shownSelfOrParent(cand.hint)) score += 2; else missing = true;
            }
        } else if ((rule.type === 'text' || rule.type === 'math')) {
            if (cand.input && visible(cand.input)) score += 2; else missing = true;
        }
        score += typeWordsScore(rule.type, imgEl);
        return { cand, missing, score };
    }

    // 大图附近的提示文字：「拖动/滑块」偏向滑块，「点击/依次」偏向点选
    function typeWordsScore(type, imgEl) {
        let node = imgEl.parentElement || imgEl, text = '';
        for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
            text = (node.innerText || node.textContent || '').slice(0, 300);
            if (/拖动|滑动|滑块|拼图|drag|slide|点击|依次|按顺序|click/i.test(text)) break;
        }
        const slide = /拖动|滑动|滑块|拼图|drag|slide/i.test(text);
        const click = /点击|依次|按顺序|click/i.test(text);
        if (type === 'slider') return slide && !click ? 1 : 0;
        if (type === 'click') return click && !slide ? 1 : 0;
        return 0;
    }

    // 手动规则 → 候选：同一张图多条规则时只取最匹配的一条，不同的图各自出一个候选
    function candidatesFromRules(rules) {
        const groups = new Map();   // 图元素 -> 评估结果列表
        for (const rule of rules) {
            if (rule.enabled === false) continue;
            const r = evalRule(rule);
            if (!r) continue;
            if (!groups.has(r.cand.el)) groups.set(r.cand.el, []);
            groups.get(r.cand.el).push(r);
        }
        const list = [];
        list.ruleImageFound = groups.size > 0;   // 页面上有规则指定的图（即使这次没法用）
        // 同一个验证码：规则的大图元素互相包含（如易盾滑块规则选了外层 .yidun_panel、点选规则选了里面的 img），
        // 按同一组处理，否则会被当成两个验证码同时执行
        const merged = [];
        for (const [el, results] of groups) {
            const g = merged.find(m => m.els.some(x => x.contains(el) || el.contains(x)));
            if (g) { g.els.push(el); g.results.push(...results); }
            else merged.push({ els: [el], results: results.slice() });
        }
        for (const { results } of merged) {
            // 配套元素（题目 / 把手 / 输入框）设置了但不在：这条规则不适用，不出按钮、不执行。
            // 只有一条规则且是点选时例外（点选可以不用题目）
            const usable = results.filter(r => !r.missing);
            if (!usable.length) {
                if (results.length === 1 && results[0].cand.type === 'click' && !results[0].cand.rule.hint) list.push(results[0].cand);
                continue;
            }
            usable.sort((a, b) => b.score - a.score);
            const best = usable[0];
            // 同一个验证码有多条规则同样适用（同类型或不同类型都算）：不替用户猜，全部列为「待选」，
            // 各给一个按钮，由用户点选其一；待选目标不自动执行
            const tied = usable.filter(r => r.score === best.score);
            if (tied.length > 1) for (const r of tied) { r.cand.choice = true; list.push(r.cand); }
            else list.push(best.cand);
        }
        // 页面上同一类型有多个目标（不同大图）：同样只能由用户选择，不同时自动执行
        const byType = new Map();
        for (const c of list) byType.set(c.type, (byType.get(c.type) || 0) + 1);
        for (const c of list) if (byType.get(c.type) > 1) c.choice = true;
        // 按钮上显示规则在本站列表中的序号，与规则管理里的顺序一致
        const order = new Map(rules.map((r, i) => [r.id, i + 1]));
        for (const c of list) if (c.choice) c.ruleNo = order.get(c.rule.id);
        return list;
    }

    /* ======================================================
     * 识别主流程
     * ====================================================== */
    const processed = new Map();   // key -> 'ok' | 'fail'
    const running = new Set();
    const runningElements = new WeakSet();
    const targetStates = new Map();
    const autoSeen = new Map();
    const elementIds = new WeakMap();
    let nextElementId = 1;
    function targetId(cand) {
        if (!elementIds.has(cand.el)) elementIds.set(cand.el, nextElementId++);
        return (cand.rule ? cand.rule.id : cand.type) + ':' + elementIds.get(cand.el);
    }
    function challengeStamp(cand) {
        const src = findImageSource(cand.el) || cand.el;
        const hint = cand.hint && (findImageSource(cand.hint) || cand.hint);
        const fingerprint = el => {
            if(!el)return '';
            if(el.tagName==='CANVAS'){try{return el.toDataURL('image/png');}catch(e){return '';}}
            return el.src || bgUrlOf(el) || el.textContent;
        };
        return [fingerprint(src),fingerprint(hint)].join('|');
    }
    function paintButton(btn, cand) {
        const id = targetId(cand), state = targetStates.get(id);
        // 只有真正在执行的那条规则显示「识别中」；同一元素的其他待选按钮暂时禁用
        const current = running.has(cand.key) ? 'running' :
            state && state.stamp === challengeStamp(cand) ? state.state : 'idle';
        btn.dataset.state = current;
        btn.dataset.icrhTarget = id;
        btn.disabled = current === 'running' || runningElements.has(cand.el);
        btn.style.background = {idle:'#5e35b1',running:'#e68a00',success:'#238636',error:'#c62828'}[current];
        btn.style.color = '#fff';
        btn.textContent = ({idle:'识别',running:'识别中…',success:'已完成 · 重试',error:'失败 · 重试'})[current] +
            ' ' + (TYPE_LABEL[cand.type] || cand.type) + (cand.choice && cand.ruleNo ? ' · 规则' + cand.ruleNo : '');
    }
    function setTargetState(cand, state, stamp = challengeStamp(cand)) {
        const id = targetId(cand);
        targetStates.set(id, {state, stamp});
        for (const btn of document.querySelectorAll('[data-icrh-target]')) if (btn.dataset.icrhTarget === id) paintButton(btn,cand);
        repaintSiblingButtons(cand);
    }
    // 同一元素上其他规则的待选按钮：执行期间禁用，结束后恢复
    function repaintSiblingButtons(cand) {
        const panel = document.getElementById('icrh-fab');
        if (!panel) return;
        for (const other of getCandidates()) {
            if (other.el !== cand.el || targetId(other) === targetId(cand)) continue;
            for (const btn of panel.querySelectorAll('[data-icrh-target]')) if (btn.dataset.icrhTarget === targetId(other)) paintButton(btn, other);
        }
    }
    // 自动执行熔断：同一目标在不消失的情况下最多自动执行 AUTO_RUN_LIMIT 次。
    // 网站失败后自动换图会让指纹变化，若不限次数就会形成「失败→换图→再执行」循环并触发风控。
    const AUTO_RUN_LIMIT = 2;
    const autoRuns = new Map();

    // 滑块自动执行前等图片加载完成：大图和拼图块（img 要 complete，背景图要预加载成功），
    // 全部就绪后再稳定 400ms（易盾/腾讯换图时先换地址、图片随后才到）。手动点按钮不受影响。
    const IMAGE_SETTLE_MS = 400;
    const bgImageLoads = new Map();   // url -> 'loading' | 'ok' | 'error'
    const readySince = new Map();     // 目标 id + 指纹 -> 首次全部就绪时间
    function imageLoaded(el) {
        const src = el && (findImageSource(el) || el);
        if (!src) return false;
        if (src.tagName === 'IMG') return src.complete && src.naturalWidth > 0;
        if (src.tagName === 'CANVAS') return src.width > 0 && src.height > 0;
        const url = bgUrlOf(src);
        if (!url) return true;
        const st = bgImageLoads.get(url);
        if (st) return st === 'ok';
        bgImageLoads.set(url, 'loading');
        const im = new Image();
        im.onload = () => { bgImageLoads.set(url, im.naturalWidth > 0 ? 'ok' : 'error'); scheduleScan(); };
        im.onerror = () => bgImageLoads.set(url, 'error');
        im.src = url;
        return false;
    }
    function sliderImagesReady(cand, id, stamp) {
        const rule = cand.rule || {};
        const els = [cand.el, rule.piece ? queryVisibleImage(rule.piece) : null].filter(Boolean);
        const key = id + '|' + stamp;
        if (!els.every(imageLoaded)) { readySince.delete(key); return false; }
        if (!readySince.has(key)) {
            if (readySince.size > 50) readySince.clear();
            readySince.set(key, Date.now());
            setTimeout(scheduleScan, IMAGE_SETTLE_MS + 50);
            return false;
        }
        return Date.now() - readySince.get(key) >= IMAGE_SETTLE_MS;
    }
    function autoRunRules(list) {
        const present = new Set(list.map(targetId));
        for (const id of [...autoRuns.keys()]) if (!present.has(id)) autoRuns.delete(id);
        for (const cand of list) {
            if (!cand.rule || cand.rule.enabled === false) continue;
            if (cand.choice) continue;   // 多条规则待用户选择：不自动执行
            if (!(typeof cand.rule.autoExecute === 'boolean' ? cand.rule.autoExecute : cfg.autoExecute === true)) continue;
            const id=targetId(cand), stamp=challengeStamp(cand);
            if (!stamp.replace('|','') || autoSeen.get(id) === stamp || runningElements.has(cand.el)) continue;
            if (cand.type === 'slider' && !sliderImagesReady(cand, id, stamp)) continue;   // 图还没加载完，下次扫描再看
            autoSeen.set(id, stamp);
            const count = (autoRuns.get(id) || 0) + 1;
            autoRuns.set(id, count);
            if (count > AUTO_RUN_LIMIT) {
                if (count === AUTO_RUN_LIMIT + 1) toast('已连续自动执行 ' + AUTO_RUN_LIMIT + ' 次，暂停自动执行；可点按钮手动重试', 'warn', 6000);
                continue;
            }
            recognizeCandidate(cand);
        }
    }

    // 只识别已添加规则的验证码：没有规则的页面不显示按钮、不做任何事
    function getCandidates() {
        const rules = getHostRules();
        if (!rules.length) return [];
        return candidatesFromRules(rules);
    }

    async function recognizeCandidate(cand) {
        refreshCfg();
        if (runningElements.has(cand.el)) return;
        const stamp = challengeStamp(cand), ruleSnapshot = JSON.stringify(cand.rule || null);
        const assertCurrent = () => {
            const fresh = getCandidates().find(c => c.el === cand.el && c.type === cand.type &&
                c.input === cand.input && c.handle === cand.handle && c.hint === cand.hint &&
                JSON.stringify(c.rule || null) === ruleSnapshot);
            if (!imageShown(cand.el) || !fresh || challengeStamp(cand) !== stamp) {
                const error = new Error('验证码已换图或关闭，已丢弃旧结果，未执行操作');
                error.staleChallenge = true;
                throw error;
            }
        };
        let completed = false;
        running.add(cand.key);
        runningElements.add(cand.el);
        autoSeen.set(targetId(cand), stamp);
        setTargetState(cand, 'running', stamp);
        let stage = '';
        const label = { text: '文本', math: '计算题', slider: '滑块', click: '点选' }[cand.type] || cand.type;
        try {
            let answer = null, via = 'llm';
            const mode = backendFor(cand);
            const isText = cand.type === 'text' || cand.type === 'math';
            let dataUrl;
            log('识别引擎选择', cand.type, BACKEND_LABELS[mode]);
            if (mode === 'llm' && !cfg.apiKey) throw new Error('未配置大模型 API Key（当前为仅大模型，「设置 → 识别引擎」填写）');
            if (mode !== 'llm') {
                stage = 'local';
                try {
                    if (!localBase()) throw new Error('未配置本地识别服务地址（「设置 → 常用」填写）');
                    if (isText) {
                        dataUrl = await imageToDataURL(findImageSource(cand.el) || cand.el);
                        const text = await localText(dataUrl, cand);
                        if (looksLikeMath(text)) throw new Error('服务返回了未计算的算式，请升级 icr-server');
                        answer = {text};
                    } else if (cand.type === 'slider') {
                        answer = await localSlider(cand);
                        if (!answer) throw new Error('规则缺少滑块图片，本地无法计算缺口（可在规则里「编辑」补上）');
                    } else if (cand.type === 'click' && localClickMode(cand) === 'icon') {
                        cand.localKind = 'click';
                        answer = {points: await localClick(cand)};
                    } else if (cand.type === 'click' && localClickMode(cand) === 'text') {
                        cand.localKind = 'textclick';
                        const points = await localTextClick(cand, true);
                        if (!points) throw new Error('题目图片里没有可识别的汉字（规则指定为文字点选）');
                        answer = {points};
                    } else if (cand.type === 'click' && localClickMode(cand) === 'image') {
                        // 题目只有图片：先当文字图读，读不出汉字再按图标点选。
                        // 服务端没确认是文字（判定不是文字、旧版服务没有 /textclick、请求出错）一律改走图标点选
                        cand.localKind = 'textclick';
                        let points = null;
                        try { points = await localTextClick(cand, true); }
                        catch (e) { if (e.textConfirmed) throw e; log('题目图片按文字识别未成功，改按图标点选：', e.message); }
                        if (!points) { cand.localKind = 'click'; points = await localClick(cand); }
                        answer = {points};
                    } else if (cand.type === 'click' && cand.rule && cand.rule.localClick === 'off') {
                        throw new Error('规则设置为本地点选关闭，此题需要大模型');
                    } else {
                        throw new Error('题目既不是文字也没有图标图片，本地无法判断点选方式；可在规则里指定');
                    }
                    via = 'local';
                } catch (e) {
                    assertCurrent();
                    // 兼容旧版 localUrl 留空表示全部用大模型；仅本地不享受此例外。
                    if (mode === 'local' || localBase()) fallbackOrThrow(e, null, mode);
                }
            }
            assertCurrent();
            if (!answer) {
                stage = 'llm';
                if (isText) {
                    dataUrl = dataUrl || await imageToDataURL(findImageSource(cand.el) || cand.el);
                    answer = await askLLM(dataUrl, 'text', null);
                } else {
                    const shot = await captureVisible(cand.el);
                    cand.area = shot.rect;
                    const hint = cand.type === 'click' ? await readHint(cand.hint) : null;
                    answer = await askLLM(shot.dataUrl, cand.type, hint);
                    if (cand.type === 'click' && answer) {
                        const im = await loadImage(shot.dataUrl).catch(() => null);
                        answer.points = normalizeLlmPoints(answer.points, im && im.naturalWidth, im && im.naturalHeight);
                    }
                }
                via = 'llm';
            }

            assertCurrent();
            if (cand.type === 'text' || cand.type === 'math') {
                if (!cand.input) throw new Error('未识别到元素：验证码输入框不在页面（可在「规则管理」检查）');
                fillInput(cand.input, answer.text);
                processed.set(cand.key, 'ok');
                toast(engineName(via === 'local' ? (cand.localKind || cand.type) : cand.type, via) + ' 识别完成：已填入 ' + answer.text, 'ok');
            } else if (cand.type === 'slider') {
                const xr = Number(answer.x_ratio);
                if (!(xr > 0 && xr < 1)) throw new Error('缺口坐标异常：' + JSON.stringify(answer).slice(0, 80));
                await solveSlider(cand, xr, answer.distance, assertCurrent, answer.track);
                processed.set(cand.key, 'ok');
                toast(engineName(cand.type, via) + ' 拖动完成：已拖到缺口（' + (xr * 100).toFixed(1) + '%）', 'ok');
            } else {
                await solveClick(cand, answer.points, assertCurrent);
                processed.set(cand.key, 'ok');
                toast(engineName(via === 'local' ? (cand.localKind || cand.type) : cand.type, via) + ' 点选完成：已点击 ' + (answer.points ? answer.points.length : 0) + ' 处', 'ok');
            }
            completed = true;
        } catch (e) {
            if (e.staleChallenge) {
                targetStates.delete(targetId(cand));
                toast(e.message, 'warn');
                return;
            }
            setTargetState(cand, 'error', stamp);
            processed.set(cand.key, 'fail');
            const who = stage ? '（' + engineName(stage === 'local' ? (cand.localKind || cand.type) : cand.type, stage) + '）' : '';
            toast((TYPE_LABEL[cand.type] || label) + '失败' + who + '：' + (e.message || e), 'err', 6000);
            console.error('[ICR]', e);
        } finally {
            runningElements.delete(cand.el);
            repaintSiblingButtons(cand);
            if (completed) setTargetState(cand, 'success', stamp);
            running.delete(cand.key);
            const fresh = getCandidates().find(c => targetId(c) === targetId(cand));
            if (fresh) for (const btn of document.querySelectorAll('[data-icrh-target]')) {
                if (btn.dataset.icrhTarget === targetId(fresh)) paintButton(btn, fresh);
            }
            scheduleScan();
            updateFloatingButton();
        }
    }

    // quiet：没找到时不提示（用于 iframe 场景，由顶层统一提示）；返回本框架候选数量
    function recognizeAll(force, quiet) {
        const list = getCandidates();
        log('候选验证码:', list);
        if (!list.length) {
            if (!quiet) {
                toast(list.ruleImageFound
                    ? '未识别到元素：找到规则里的验证码图，但配套元素（滑块把手 / 题目 / 输入框）未显示，或多条规则无法确定用哪条。可在「规则管理」检查'
                    : '未设置规则：当前页面没有已添加规则的验证码。可在「设置 → 规则」添加', 'warn', 6000);
            }
            return 0;
        }
        let waiting = 0;
        for (const cand of list) {
            if (cand.choice) { waiting++; continue; }   // 多条规则待选：只能点对应按钮执行其一
            if (!force && processed.get(cand.key) === 'ok') continue;
            recognizeCandidate(cand);
        }
        if (waiting && !quiet) toast('有 ' + waiting + ' 条规则同时适用，请点右侧对应的按钮选择其一', 'warn', 6000);
        return list.length;
    }

    /* ======================================================
     * 扫描循环 + 悬浮按钮
     * ====================================================== */
    let scanTimer = null;
    function scheduleScan() {
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
            scanTimer = null;
            scan();
        }, 600);
    }

    function scan() {
        try {
            refreshCfg();
            const list = getCandidates();
            // 文本验证码：在输入框旁边保证有「识别」按钮
            for (const cand of list) {
                if ((cand.type === 'text' || cand.type === 'math') && cand.input && !cand.choice) ensureInlineButton(cand.input);
            }
            updateFloatingButton(list);
            autoRunRules(list);
        } catch (e) {
            log('扫描出错', e);
        }
    }

    /* ======================================================
     * 触发按钮：输入框旁的「🤖识别」+ 右下角悬浮按钮
     * ====================================================== */
    function ensureInlineButton(input) {
        if (!input || !input.parentNode) return;
        // 输入框后面已经挂了按钮就不再加
        let btn = input.nextElementSibling;
        while (btn) {
            if (btn.getAttribute && btn.getAttribute('data-icrh-btn')) {
                const cand=getCandidates().find(c=>c.input===input); if(cand) paintButton(btn,cand);
                return;
            }
            btn = btn.nextElementSibling;
        }
        btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-icrh-btn', '1');
        btn.textContent = '🤖识别';
        btn.setAttribute('style', [
            'display:inline-block', 'margin-left:4px', 'padding:3px 10px',
            'background:#5e35b1', 'color:#fff', 'border:none', 'border-radius:4px',
            'font-size:12px', 'cursor:pointer', 'vertical-align:middle',
            'font-family:system-ui,-apple-system,sans-serif', 'white-space:nowrap',
        ].join(';'));
        // 父元素是纵向 flex / grid（如 uni-app 的 .uni-input-wrapper）时，按钮会被排到输入框下方并撑满整行：
        // 父元素已定位就叠在输入框右侧，否则至少不拉伸
        const ps = getComputedStyle(input.parentNode);
        const stacked = (/flex/.test(ps.display) && /column/.test(ps.flexDirection)) || /grid/.test(ps.display);
        if (stacked && ps.position !== 'static') {
            Object.assign(btn.style, { position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)', margin: '0', zIndex: '1' });
        } else if (stacked) {
            Object.assign(btn.style, { alignSelf: 'flex-start', flex: 'none' });
        }
        btn.addEventListener('click', () => {
            const fresh = getCandidates().find(c => (c.type === 'text' || c.type === 'math') && c.input === input);
            if (fresh) recognizeCandidate(fresh);
            else toast('未识别到元素：验证码图片或输入框已不在页面', 'warn');
        });
        input.insertAdjacentElement('afterend', btn);
        const cand=getCandidates().find(c=>c.input===input); if(cand) paintButton(btn,cand);
    }

    /* ------------------------------------------------------
     * 悬浮按钮位置：不挡住页面上的按钮/链接/验证码图片
     * - 未手动拖动时，从多个候选位置里自动挑一个不压住可点击元素的
     * - 可拖动，松手后按域名记住位置；菜单可重置为自动
     * ------------------------------------------------------ */
    const FAB_POS_KEY = 'icrh_fab_pos_v1';
    const FAB_GAP = 8;
    const CLICKABLE_SEL = 'a[href],button,input,select,textarea,label,[role="button"],[role="link"],[onclick],[tabindex]';
    let fabAvoid = [];        // 当前验证码相关元素（大图、题目、把手），按钮不能压住
    let fabLayoutSig = '';

    function getSavedFabPos() {
        const all = GM_getValue(FAB_POS_KEY, {}) || {};
        return all[location.hostname] || null;
    }

    function setSavedFabPos(pos) {
        const all = GM_getValue(FAB_POS_KEY, {}) || {};
        if (pos) all[location.hostname] = pos;
        else delete all[location.hostname];
        GM_setValue(FAB_POS_KEY, all);
    }

    function moveFab(btn, left, top) {
        const r = btn.getBoundingClientRect();
        const maxL = Math.max(0, window.innerWidth - r.width - 2);
        const maxT = Math.max(0, window.innerHeight - r.height - 2);
        btn.style.left = Math.round(Math.min(Math.max(2, left), maxL)) + 'px';
        btn.style.top = Math.round(Math.min(Math.max(2, top), maxT)) + 'px';
    }

    // 某个采样点是否压住了需要点击/查看的东西
    function pointBlocked(x, y) {
        const el = pointTarget(x, y);
        if (!el || el === document.body || el === document.documentElement) return false;
        // 只算验证码元素本身及其内部；外层弹窗容器（包含验证码）不算，否则整个弹窗都没处放
        if (fabAvoid.some(a => a === el || a.contains(el))) return true;
        if (el.closest && el.closest(CLICKABLE_SEL)) return true;
        try { return getComputedStyle(el).cursor === 'pointer'; } catch (e) { return false; }
    }

    // 返回该矩形内被压住的采样点数，0 表示完全不挡
    function rectConflicts(left, top, w, h) {
        if (left < 0 || top < 0 || left + w > window.innerWidth || top + h > window.innerHeight) return 99;
        let n = 0;
        for (const fx of [0.05, 0.5, 0.95]) {
            for (const fy of [0.1, 0.5, 0.9]) {
                if (pointBlocked(left + w * fx, top + h * fy)) n++;
            }
        }
        return n;
    }

    function fabCandidates(w, h) {
        const W = window.innerWidth, H = window.innerHeight, g = FAB_GAP;
        const list = [];
        // 优先贴在验证码图片外侧（上方右对齐最自然，不会盖住底部的提交按钮）
        const img = fabAvoid[0];
        if (img && img.getBoundingClientRect) {
            const r = img.getBoundingClientRect();
            list.push([r.right - w, r.top - h - g], [r.left, r.top - h - g],
                [r.right + g, r.top], [r.left - w - g, r.top],
                [r.right + g, r.bottom - h], [r.left - w - g, r.bottom - h]);
        }
        list.push(
            [W - w - g, H - h - g], [g, H - h - g], [W - w - g, g], [g, g],
            [(W - w) / 2, H - h - g], [(W - w) / 2, g],
            [W - w - g, (H - h) / 2], [g, (H - h) / 2]);
        // 兜底：整个视口按网格扫一遍
        for (let y = g; y + h <= H - g; y += Math.max(h, 24)) {
            for (let x = W - w - g; x >= g; x -= Math.max(w / 2, 40)) list.push([x, y]);
        }
        return list;
    }

    function autoPlaceFab(btn) {
        const r = btn.getBoundingClientRect();
        // 先挪开，避免自己挡住采样（pointTarget 也会跳过自身，这里双保险）
        btn.style.visibility = 'hidden';
        let best = null;
        for (const [x, y] of fabCandidates(r.width, r.height)) {
            const score = rectConflicts(x, y, r.width, r.height);
            if (!best || score < best.score) best = { x, y, score };
            if (score === 0) break;
        }
        btn.style.visibility = '';
        if (best) moveFab(btn, best.x, best.y);
        log('识别按钮自动定位', best);
    }

    function layoutSignature() {
        const img = fabAvoid[0];
        const r = img && img.getBoundingClientRect ? img.getBoundingClientRect() : null;
        return [window.innerWidth, window.innerHeight]
            .concat(r ? [r.left, r.top, r.width, r.height].map(Math.round) : []).join(',');
    }

    function positionFab(btn, force) {
        const saved = getSavedFabPos();
        if (saved) {
            moveFab(btn, saved.left, saved.top);
            return;
        }
        const sig = layoutSignature();
        if (!force && sig === fabLayoutSig) {
            // 布局没变时，只有当前位置开始压住东西（如弹窗里新出现按钮）才重新找位置
            const r = btn.getBoundingClientRect();
            if (rectConflicts(r.left, r.top, r.width, r.height) === 0) return;
        }
        fabLayoutSig = sig;
        autoPlaceFab(btn);
    }

    function makeFabDraggable(btn) {
        let drag = null;
        btn.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            const r = btn.getBoundingClientRect();
            drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, pid: e.pointerId };
        });
        btn.addEventListener('pointermove', e => {
            if (!drag) return;
            const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
            // 真正拖动后才捕获指针：pointerdown 时就捕获会让 click 落到面板而不是里面的按钮，按钮点了没反应
            if (!drag.moved) { try { btn.setPointerCapture(drag.pid); } catch (err) { /* ignore */ } }
            drag.moved = true;
            btn.style.cursor = 'grabbing';
            moveFab(btn, drag.ox + dx, drag.oy + dy);
        });
        const end = () => {
            if (!drag) return;
            if (drag.moved) {
                const r = btn.getBoundingClientRect();
                setSavedFabPos({ left: Math.round(r.left), top: Math.round(r.top) });
                btn.dataset.dragged = '1';   // 吞掉拖动后紧跟的 click
                setTimeout(() => { delete btn.dataset.dragged; }, 0);
            }
            btn.style.cursor = 'pointer';
            drag = null;
        };
        btn.addEventListener('pointerup', end);
        btn.addEventListener('pointercancel', end);
    }

    function resetFabPosition() {
        setSavedFabPos(null);
        fabLayoutSig = '';
        const btn = document.getElementById('icrh-fab');
        if (btn) positionFab(btn, true);
        if (window.frames.length) postToFrames({ [MSG_KEY]: 'fab-reset' });
    }

    const savedOutline = new WeakMap();
    function highlightTarget(cand, on) {
        for (const el of [cand.el, cand.input, cand.handle, cand.hint]) {
            if (!el || !el.style) continue;
            if (on) {
                if (!savedOutline.has(el)) savedOutline.set(el, [el.style.outline, el.style.outlineOffset]);
                el.style.outline = '3px solid #ff9800';
                el.style.outlineOffset = '2px';
            } else if (savedOutline.has(el)) {
                [el.style.outline, el.style.outlineOffset] = savedOutline.get(el);
                savedOutline.delete(el);
            }
        }
    }

    function updateFloatingButton(list) {
        if (!Array.isArray(list)) list=getCandidates();
        let panel=document.getElementById('icrh-fab');
        const need=list.filter(c=>c.choice||!['text','math'].includes(c.type)||!c.input);
        if (!need.length) { if(panel)panel.remove(); fabLayoutSig=''; return; }
        fabAvoid=need.flatMap(c=>[c.el,c.hint,c.handle]).filter(Boolean);
        if (!panel) {
            panel=document.createElement('div');panel.id='icrh-fab';
            panel.style.cssText='position:fixed;left:0;top:0;z-index:2147483646;display:flex;flex-direction:column;gap:4px;padding:4px;background:#ede7f6;border-radius:10px;touch-action:none;cursor:grab;';
            panel.title='可拖动；多个验证码分别点击对应按钮';
            makeFabDraggable(panel);document.documentElement.appendChild(panel);
        }
        const signature=need.map(targetId).join(',');
        if (panel.dataset.targets !== signature) {
            panel.replaceChildren();panel.dataset.targets=signature;
            need.forEach((cand,i)=>{
                const btn=document.createElement('button');btn.type='button';
                btn.style.cssText='border:0;border-radius:8px;padding:5px 10px;cursor:pointer;font:12px/18px sans-serif;white-space:nowrap;';
                btn.title=(cand.choice?'多条规则适用，点此只执行这一条\n':'')+(TYPE_LABEL[cand.type]||cand.type)+(cand.ruleNo?' 规则'+cand.ruleNo:' '+(i+1))+'\n'+describeRule(cand.rule);
                // 悬停时高亮这条规则对应的元素，方便分辨要选哪个
                btn.addEventListener('mouseenter',()=>highlightTarget(cand,true));
                btn.addEventListener('mouseleave',()=>highlightTarget(cand,false));
                btn.addEventListener('click',()=>{
                    highlightTarget(cand,false);
                    if(panel.dataset.dragged)return;
                    const current=getCandidates().find(c=>targetId(c)===targetId(cand));
                    if(current)recognizeCandidate(current);
                });
                paintButton(btn,cand);panel.appendChild(btn);
            });
        } else {
            [...panel.children].forEach((btn,i)=>paintButton(btn,need[i]));
        }
        positionFab(panel,false);
    }

    /* ======================================================
     * 设置面板
     * ====================================================== */
    // 面板放在闭合 Shadow DOM 里：页面 JS 拿不到 shadowRoot 引用，无法读取 Key 等输入值
    let settingsShadow = null;
    let settingsHost = null;
    let settingsTab = 'common';

    // 设置 / 规则窗口在 Shadow DOM 里，键盘事件会冒泡到页面：GitHub 的 s、/ 等单键快捷键会把焦点抢到搜索框，
    // 导致输入到一半跳走。在宿主元素上截断键盘/输入事件（Esc 留给窗口自己处理）。
    function isolateKeyboard(host) {
        for (const type of ['keydown', 'keypress', 'keyup', 'input', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend']) {
            host.addEventListener(type, e => { e.stopPropagation(); }, false);
        }
    }

    // 规则编辑表单样式（设置页和规则管理两个 Shadow DOM 都要带）
    const RULE_EDIT_CSS = [
        '.icrh-edit{width:100%;box-sizing:border-box;margin-top:6px;padding:8px 10px;border:1px dashed #b39ddb;border-radius:6px;background:#faf8ff;}',
        '.icrh-edit-row{display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;}',
        '.icrh-edit-name{flex:none;width:96px;color:#555;white-space:nowrap;}',
        '.icrh-edit-row input{flex:1;min-width:0;width:auto;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font:12px ui-monospace,Consolas,monospace;color:#333;background:#fff;}',
        '.icrh-edit-st{flex:none;min-width:90px;font-size:11px;color:#999;}',
        '.icrh-edit-st.ok{color:#2e7d32;}.icrh-edit-st.warn{color:#ef6c00;}.icrh-edit-st.err{color:#c62828;}',
        '.icrh-edit-err{color:#c62828;font-size:12px;min-height:16px;}',
        '.icrh-edit-btns{display:flex;gap:8px;}',
        '.icrh-edit-btns button{border:0;border-radius:5px;padding:4px 12px;font-size:12px;cursor:pointer;}',
        '.icrh-edit-save{background:#5e35b1;color:#fff;}.icrh-edit-cancel{background:#eee;color:#555;}',
    ].join('\n');

    function closeSettings() {
        if (settingsHost) settingsHost.remove();
        settingsShadow = null;
        settingsHost = null;
    }

    function openSettings(initialTab) {
        if (!['common', 'engine', 'rules', 'advanced'].includes(initialTab)) initialTab = 'common';
        refreshCfg();
        if (settingsShadow) {
            settingsShadow.getElementById('icrh-settings-overlay').style.display = 'flex';
            return;
        }
        const styleText = [
            ':host{all:initial;}',
            '#icrh-settings-overlay{position:fixed;inset:0;background:rgba(15,10,30,.45);z-index:2147483647;',
            '  display:flex;align-items:center;justify-content:center;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;}',
            '#icrh-settings{background:#fff;color:#2b2b33;border-radius:12px;width:560px;max-width:94vw;height:620px;max-height:88vh;',
            '  display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;}',
            '.icrh-head{display:flex;align-items:center;gap:10px;padding:14px 18px 0;}',
            '.icrh-head h2{margin:0;font-size:16px;color:#4527a0;flex:1;}',
            '.icrh-x{border:0;background:none;font-size:20px;line-height:1;color:#888;cursor:pointer;padding:2px 6px;}',
            '.icrh-tabs{display:flex;gap:2px;padding:10px 14px 0;border-bottom:1px solid #ece8f7;}',
            '.icrh-tabs button{border:0;background:none;padding:8px 14px;font-size:13px;color:#666;cursor:pointer;',
            '  border-bottom:2px solid transparent;margin-bottom:-1px;}',
            '.icrh-tabs button[aria-selected="true"]{color:#4527a0;border-bottom-color:#5e35b1;font-weight:600;}',
            '.icrh-body{flex:1;overflow:auto;padding:4px 18px 14px;}',
            '[data-page][hidden]{display:none!important;}',
            '.icrh-card{border:1px solid #ece8f7;border-radius:10px;padding:10px 12px;margin-top:12px;}',
            '.icrh-card h3{margin:0 0 6px;font-size:13px;color:#4527a0;}',
            '.icrh-tip{font-size:12px;color:#8a8a99;margin:4px 0 0;}',
            'label.icrh-f{display:block;margin:8px 0 3px;font-weight:600;font-size:12.5px;color:#444;}',
            'label.icrh-f .icrh-normal{font-weight:normal;color:#999;}',
            'input[type=text],input[type=password],textarea,select{width:100%;box-sizing:border-box;padding:6px 9px;',
            '  border:1px solid #d6d1e6;border-radius:6px;font:13px/1.4 inherit;background:#fff;color:#222;}',
            'input:focus,textarea:focus,select:focus{outline:2px solid #b39ddb;border-color:#7e57c2;}',
            'textarea{resize:vertical;line-height:1.5;word-break:break-all;}',
            '.icrh-check{display:flex;align-items:flex-start;gap:8px;margin-top:8px;font-size:13px;cursor:pointer;}',
            '.icrh-check input{margin-top:3px;}',
            '.icrh-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;}',
            '.icrh-inline{display:flex;gap:8px;align-items:center;margin-top:8px;}',
            '.icrh-inline input{flex:1;}',
            '.icrh-status{font-size:12px;padding:2px 8px;border-radius:10px;background:#f2f0f7;color:#777;white-space:nowrap;}',
            '.icrh-status.ok{background:#e7f6ea;color:#2e7d32;}.icrh-status.err{background:#fdecea;color:#c62828;}',
            '.icrh-btn{border:0;border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer;background:#efecf7;color:#333;white-space:nowrap;}',
            '.icrh-btn.primary{background:#5e35b1;color:#fff;}.icrh-btn.danger{background:#fdecea;color:#c62828;}',
            '.icrh-footer{display:flex;gap:8px;align-items:center;padding:10px 18px;border-top:1px solid #ece8f7;background:#faf9fd;}',
            '.icrh-footer .icrh-dirty{flex:1;font-size:12px;color:#e65100;}',
            '.icrh-rule{border:1px solid #ece8f7;border-radius:8px;padding:8px 10px;margin-top:8px;}',
            '.icrh-rule.disabled{opacity:.55;}',
            '.icrh-rule-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
            '.icrh-type{padding:1px 8px;border-radius:10px;background:#5e35b1;color:#fff;font-size:12px;}',
            '.icrh-st{font-size:12px;padding:1px 6px;border-radius:4px;}',
            '.icrh-st.on{background:#e8f5e9;color:#2e7d32;}.icrh-st.off{background:#f5f5f5;color:#999;}.icrh-st.warn{background:#fff3e0;color:#ef6c00;}',
            '.icrh-desc{font-size:12px;color:#666;word-break:break-all;margin-top:4px;}',
            '.icrh-rule-ctl{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:12px;align-items:center;}',
            '.icrh-rule-ctl select{width:auto;padding:3px 6px;font-size:12px;}',
            '.icrh-empty{color:#999;font-size:13px;padding:14px 0;text-align:center;}',
            '.icrh-no{font-weight:600;color:#5e35b1;font-size:12px;}',
            RULE_EDIT_CSS,
        ].join('\n');

        settingsHost = document.createElement('div');
        settingsHost.id = 'icrh-settings-host';
        settingsShadow = settingsHost.attachShadow({ mode: 'closed' });
        isolateKeyboard(settingsHost);
        const style = document.createElement('style');
        style.textContent = styleText;
        settingsShadow.appendChild(style);

        const opt = (entries) => entries.map(([v, n]) => '<option value="' + v + '">' + n + '</option>').join('');
        const backendOpts = opt(Object.entries(BACKEND_LABELS));
        const overlay = document.createElement('div');
        overlay.id = 'icrh-settings-overlay';
        overlay.innerHTML = [
            '<div id="icrh-settings" role="dialog" aria-label="ICR 验证码助手设置">',
            ' <div class="icrh-head"><h2>⚙️ ICR 验证码助手</h2><button class="icrh-x" title="关闭">×</button></div>',
            ' <div class="icrh-tabs" role="tablist">',
            '  <button data-tab="common" role="tab">常用</button>',
            '  <button data-tab="engine" role="tab">识别引擎</button>',
            '  <button data-tab="rules" role="tab">规则</button>',
            '  <button data-tab="advanced" role="tab">高级</button>',
            ' </div>',
            ' <div class="icrh-body">',
            // —— 常用 ——
            '  <section data-page="common">',
            '   <div class="icrh-card"><h3>执行方式</h3>',
            '    <label class="icrh-check"><input type="checkbox" id="icrh-auto-execute"><span>已保存规则的验证码出现或换图后自动识别',
            '     <div class="icrh-tip">默认关闭。同一张图只自动执行一次；网站失败换图后最多再自动执行 1 次，之后需手动。从不自动提交。规则页可单条覆盖。</div></span></label>',
            '   </div>',
            '   <div class="icrh-card"><h3>本地识别服务 <span class="icrh-normal" style="font-weight:normal;color:#999">icr-server</span></h3>',
            '    <label class="icrh-f">服务地址</label>',
            '    <div class="icrh-inline"><input type="text" id="icrh-local-url" placeholder="http://127.0.0.1:8899">',
            '     <button class="icrh-btn icrh-test-local">测试本地服务</button></div>',
            '    <div class="icrh-inline" style="margin-top:6px"><span class="icrh-status" id="icrh-local-status">未检测</span></div>',
            '    <label class="icrh-f">Token <span class="icrh-normal">（服务端设置了 ICR_TOKEN 时填写）</span></label>',
            '    <input type="password" id="icrh-local-token" autocomplete="off">',
            '   </div>',
            '  </section>',
            // —— 识别引擎 ——
            '  <section data-page="engine" hidden>',
            '   <div class="icrh-card"><h3>引擎选择</h3>',
            '    <label class="icrh-f">全局默认</label><select id="icrh-backend">' + backendOpts + '</select>',
            '    <div class="icrh-tip">仅本地：失败即停止，绝不发送大模型。仅大模型：跳过本地。优先级：规则 &gt; 类型 &gt; 全局。</div>',
            '    <div class="icrh-grid">',
            ...Object.entries(BACKEND_TYPES).map(([type, name]) =>
                '<div><label class="icrh-f">' + name + '</label><select id="icrh-backend-' + type + '"><option value="inherit">跟随全局</option>' + backendOpts + '</select></div>'),
            '    </div>',
            '    <label class="icrh-check"><input type="checkbox" id="icrh-llm-fallback"><span>本地优先模式下，本地失败时改用大模型</span></label>',
            '   </div>',
            '   <div class="icrh-card"><h3>大模型接口 <span class="icrh-normal" style="font-weight:normal;color:#999">OpenAI 兼容多模态</span></h3>',
            '    <label class="icrh-f">API 地址 <span class="icrh-normal">（完整 chat/completions 地址）</span></label><input type="text" id="icrh-url">',
            '    <label class="icrh-f">API Key <span class="icrh-normal">（留空则只用本地）</span></label>',
            '    <div class="icrh-inline"><input type="password" id="icrh-key" autocomplete="off"><button class="icrh-btn icrh-test">测试连接</button></div>',
            '    <label class="icrh-f">模型名称</label><input type="text" id="icrh-model">',
            '    <div class="icrh-tip">使用大模型时验证码图片会发送给该服务商。</div>',
            '   </div>',
            '   <div class="icrh-card"><h3>点选</h3>',
            '    <label class="icrh-f">点击间隔（毫秒） <span class="icrh-normal">相邻点击间随机等待</span></label>',
            '    <div class="icrh-grid"><div><label class="icrh-f">最小</label><input type="text" id="icrh-delay-min" inputmode="numeric"></div>',
            '     <div><label class="icrh-f">最大</label><input type="text" id="icrh-delay-max" inputmode="numeric"></div></div>',
            '   </div>',
            '  </section>',
            // —— 规则 ——
            '  <section data-page="rules" hidden>',
            '   <div class="icrh-card"><h3>本站规则 <span class="icrh-normal" id="icrh-rules-host" style="font-weight:normal;color:#999"></span></h3>',
            '    <div id="icrh-rules-list"></div>',
            '    <div class="icrh-inline"><button class="icrh-btn primary icrh-add-rule">＋ 添加规则（右键选中）</button>',
            '     <button class="icrh-btn icrh-open-rules">管理全部站点 / iframe 规则</button></div>',
            '   </div>',
            '  </section>',
            // —— 高级 ——
            '  <section data-page="advanced" hidden>',
            '   <div class="icrh-card"><h3>模型参数</h3>',
            '    <div class="icrh-grid"><div><label class="icrh-f">temperature</label><input type="text" id="icrh-temp"></div>',
            '     <div><label class="icrh-f">max_tokens</label><input type="text" id="icrh-maxtok"></div></div>',
            '    <label class="icrh-f">额外请求头 <span class="icrh-normal">（JSON，可覆盖 Authorization）</span></label>',
            '    <input type="text" id="icrh-headers" placeholder=\'{"X-Token":"..."}\'>',
            '   </div>',
            '   <div class="icrh-card"><h3>提示词</h3>',
            '    <label class="icrh-f">文本 / 计算题</label><textarea id="icrh-prompt-text" rows="3"></textarea>',
            '    <label class="icrh-f">滑块 <span class="icrh-normal">需输出 {"x_ratio": 0~1}</span></label><textarea id="icrh-prompt-slider" rows="3"></textarea>',
            '    <label class="icrh-f">点选 <span class="icrh-normal">需输出 {"points":[...]}</span></label><textarea id="icrh-prompt-click" rows="3"></textarea>',
            '    <div class="icrh-inline"><button class="icrh-btn icrh-reset">恢复默认参数和提示词</button></div>',
            '   </div>',
            '   <div class="icrh-card"><h3>调试</h3>',
            '    <label class="icrh-check"><input type="checkbox" id="icrh-debug"><span>输出调试日志到控制台（不含 Key/Token）</span></label>',
            '   </div>',
            '  </section>',
            ' </div>',
            ' <div class="icrh-footer"><span class="icrh-dirty"></span>',
            '  <button class="icrh-btn icrh-close">关闭</button><button class="icrh-btn primary icrh-save">保存</button></div>',
            '</div>',
        ].join('');
        settingsShadow.appendChild(overlay);
        document.documentElement.appendChild(settingsHost);

        const $ = sel => overlay.querySelector(sel);
        // —— 标签页 ——
        const showTab = (name) => {
            overlay.querySelectorAll('[data-tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
            overlay.querySelectorAll('[data-page]').forEach(p => { p.hidden = p.dataset.page !== name; });
            settingsTab = name;
        };
        overlay.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
        showTab(initialTab);

        // —— 填值 ——
        $('#icrh-url').value = cfg.apiUrl;
        $('#icrh-key').value = cfg.apiKey;
        $('#icrh-model').value = cfg.model;
        $('#icrh-headers').value = cfg.extraHeaders || '';
        $('#icrh-temp').value = cfg.temperature;
        $('#icrh-maxtok').value = cfg.maxTokens;
        $('#icrh-prompt-text').value = cfg.promptText;
        $('#icrh-prompt-slider').value = cfg.promptSlider;
        $('#icrh-prompt-click').value = cfg.promptClick;
        $('#icrh-debug').checked = !!cfg.debug;
        $('#icrh-auto-execute').checked = cfg.autoExecute === true;
        $('#icrh-local-url').value = cfg.localUrl || '';
        $('#icrh-local-token').value = cfg.localToken || '';
        $('#icrh-llm-fallback').checked = cfg.llmFallback !== false;
        $('#icrh-backend').value = Object.hasOwn(BACKEND_LABELS, cfg.backend) ? cfg.backend : 'auto';
        for (const type of Object.keys(BACKEND_TYPES)) {
            const value = (cfg.backendByType || {})[type];
            $('#icrh-backend-' + type).value = Object.hasOwn(BACKEND_LABELS, value) ? value : 'inherit';
        }
        const delayNow = clickDelayRange();
        $('#icrh-delay-min').value = delayNow.min;
        $('#icrh-delay-max').value = delayNow.max;

        // —— 未保存提示 ——
        let dirty = false;
        const markDirty = () => { dirty = true; $('.icrh-dirty').textContent = '有未保存的修改'; };
        overlay.querySelectorAll('[data-page="common"],[data-page="engine"],[data-page="advanced"]').forEach(page => {
            page.addEventListener('input', markDirty);
            page.addEventListener('change', markDirty);
        });
        const requestClose = () => {
            if (dirty && !confirm('有未保存的修改，确定放弃？')) return;
            closeSettings();
        };
        overlay.addEventListener('click', e => { if (e.target === overlay) requestClose(); });
        $('.icrh-close').addEventListener('click', requestClose);
        $('.icrh-x').addEventListener('click', requestClose);

        // —— 规则页 ——
        $('#icrh-rules-host').textContent = location.hostname;
        renderSettingsRules($('#icrh-rules-list'));
        $('.icrh-add-rule').addEventListener('click', () => { closeSettings(); startPickFlow(); });
        $('.icrh-open-rules').addEventListener('click', () => { closeSettings(); openRuleManager(); });

        $('.icrh-reset').addEventListener('click', () => {
            for (const key of ['temperature', 'maxTokens', 'extraHeaders', 'promptText', 'promptSlider', 'promptClick',
                'clickDelayMin', 'clickDelayMax']) {
                cfg[key] = DEFAULT_CFG[key];
            }
            $('#icrh-delay-min').value = cfg.clickDelayMin;
            $('#icrh-delay-max').value = cfg.clickDelayMax;
            $('#icrh-headers').value = cfg.extraHeaders;
            $('#icrh-temp').value = cfg.temperature;
            $('#icrh-maxtok').value = cfg.maxTokens;
            $('#icrh-prompt-text').value = cfg.promptText;
            $('#icrh-prompt-slider').value = cfg.promptSlider;
            $('#icrh-prompt-click').value = cfg.promptClick;
            markDirty();
            toast('已恢复默认模型参数和提示词（点击「保存」生效）', 'info');
        });
        $('.icrh-save').addEventListener('click', () => {
            const extraHeaders = $('#icrh-headers').value.trim();
            if (extraHeaders) {
                try { JSON.parse(extraHeaders); } catch (e) {
                    showTab('advanced');
                    toast('「额外请求头」不是合法 JSON，未保存', 'err');
                    return;
                }
            }
            const dMin = $('#icrh-delay-min').value.trim();
            const dMax = $('#icrh-delay-max').value.trim();
            if ([dMin, dMax].some(v => v !== '' && !(Number(v) >= 0 && Number(v) <= 10000))) {
                showTab('engine');
                toast('点击间隔需填 0~10000 之间的毫秒数，未保存', 'err');
                return;
            }
            cfg.apiUrl = $('#icrh-url').value.trim() || DEFAULT_CFG.apiUrl;
            cfg.apiKey = $('#icrh-key').value.trim();
            cfg.model = $('#icrh-model').value.trim() || DEFAULT_CFG.model;
            cfg.extraHeaders = extraHeaders;
            cfg.temperature = parseFloat($('#icrh-temp').value);
            if (isNaN(cfg.temperature)) cfg.temperature = 0;
            cfg.maxTokens = parseInt($('#icrh-maxtok').value, 10);
            if (isNaN(cfg.maxTokens) || cfg.maxTokens < 1) cfg.maxTokens = 500;
            cfg.promptText = $('#icrh-prompt-text').value.trim() || DEFAULT_CFG.promptText;
            cfg.promptSlider = $('#icrh-prompt-slider').value.trim() || DEFAULT_CFG.promptSlider;
            cfg.promptClick = $('#icrh-prompt-click').value.trim() || DEFAULT_CFG.promptClick;
            cfg.debug = $('#icrh-debug').checked;
            cfg.autoExecute = $('#icrh-auto-execute').checked;
            cfg.localUrl = $('#icrh-local-url').value.trim();
            cfg.localToken = $('#icrh-local-token').value.trim();
            cfg.llmFallback = $('#icrh-llm-fallback').checked;
            cfg.backend = $('#icrh-backend').value;
            cfg.backendByType = Object.fromEntries(Object.keys(BACKEND_TYPES).map(type =>
                [type, $('#icrh-backend-' + type).value]));
            cfg.clickDelayMin = dMin === '' ? DEFAULT_CFG.clickDelayMin : Number(dMin);
            cfg.clickDelayMax = dMax === '' ? DEFAULT_CFG.clickDelayMax : Number(dMax);
            if (cfg.clickDelayMin > cfg.clickDelayMax) [cfg.clickDelayMin, cfg.clickDelayMax] = [cfg.clickDelayMax, cfg.clickDelayMin];
            saveCfg();
            dirty = false;
            toast('设置已保存', 'ok');
            closeSettings();
            scheduleScan();
        });
        overlay.querySelector('.icrh-test-local').addEventListener('click', async () => {
            const btn = overlay.querySelector('.icrh-test-local');
            const status = overlay.querySelector('#icrh-local-status');
            const setStatus = (text, cls) => { if (status) { status.textContent = text; status.className = 'icrh-status ' + cls; } };
            const old = { url: cfg.localUrl, token: cfg.localToken };
            cfg.localUrl = overlay.querySelector('#icrh-local-url').value.trim();
            cfg.localToken = overlay.querySelector('#icrh-local-token').value.trim();
            btn.textContent = '测试中…';
            setStatus('检测中…', '');
            try {
                // /health 不需要鉴权，带上 Token 时服务端会返回 auth_ok
                const h = await localApi('/health');
                if (!h || h.ok !== true) throw new Error('健康检查响应异常');
                if (h.auth_ok === false) throw new Error('Token 错误（服务端设置了 ICR_TOKEN，请填写相同的值）');
                if (h.auth_ok !== true) throw new Error('请升级并重启 icr_server.py，当前服务缺少鉴权状态');
                setStatus('可用 · ' + ((h && h.endpoints) || []).join(' '), 'ok');
                toast('本地服务可用：' + ((h && h.endpoints) || []).join(' '), 'ok');
            } catch (e) {
                setStatus('不可用：' + (e.message || e), 'err');
                toast('本地服务不可用：' + (e.message || e), 'err', 6000);
            } finally {
                cfg.localUrl = old.url; cfg.localToken = old.token;
                btn.textContent = '测试本地服务';
            }
        });
        overlay.querySelector('.icrh-test').addEventListener('click', async () => {
            const btn = overlay.querySelector('.icrh-test');
            btn.textContent = '测试中…';
            const oldUrl = cfg.apiUrl, oldKey = cfg.apiKey, oldModel = cfg.model;
            try {
                cfg.apiUrl = $('#icrh-url').value.trim();
                cfg.apiKey = $('#icrh-key').value.trim();
                cfg.model = $('#icrh-model').value.trim();
                const res = await llmChat({
                    model: cfg.model,
                    messages: [{ role: 'user', content: '请回复"ok"' }],
                    max_tokens: 5,
                });
                toast('大模型连接成功，返回：' + res, 'ok');
            } catch (e) {
                toast('大模型连接失败：' + (e.message || e), 'err', 6000);
            } finally {
                cfg.apiUrl = oldUrl; cfg.apiKey = oldKey; cfg.model = oldModel;
                btn.textContent = '测试连接';
            }
        });
    }

    // 设置「规则」页：本站规则，可直接启用/停用、选后端、选自动执行、删除。改动立即保存。
    // 点选规则的「本地点选」下拉：自动判断 / 图标点选 / 文字点选 / 关闭
    function localClickSelect(rule, onChange) {
        const label = document.createElement('label');
        label.textContent = '本地点选 ';
        label.title = '自动判断：题目是汉字用文字点选，题目是图标图片用图标点选';
        const select = document.createElement('select');
        select.setAttribute('data-rule-localclick', '');
        for (const [value, text] of Object.entries(LOCAL_CLICK_MODES)) {
            const o = document.createElement('option'); o.value = value; o.textContent = text; select.appendChild(o);
        }
        select.value = Object.hasOwn(LOCAL_CLICK_MODES, rule.localClick) ? rule.localClick : 'auto';
        select.addEventListener('change', () => onChange(select.value));
        label.appendChild(select);
        return label;
    }

    function renderSettingsRules(box) {
        box.textContent = '';
        const host = location.hostname;
        const rules = getHostRules(host);
        const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
        if (!rules.length) {
            box.appendChild(el('div', 'icrh-empty', '本站暂无规则。可点「添加规则」后右键选中验证码大图。'));
            return;
        }
        const update = (id, mutate, msg) => {
            const all = loadAllRules();
            const current = (all[host] || []).find(r => r.id === id);
            if (!current) return;
            mutate(current);
            saveAllRules(all);
            processed.clear();
            toast(msg, 'ok');
            renderSettingsRules(box);
            scheduleScan();
        };
        rules.forEach((rule, i) => {
            const row = el('div', 'icrh-rule' + (rule.enabled === false ? ' disabled' : ''));
            row.dataset.ruleId = rule.id;
            const head = el('div', 'icrh-rule-h');
            // 编号与悬浮按钮上的「规则N」一致（本站规则列表顺序）
            head.appendChild(el('span', 'icrh-no', '规则' + (i + 1)));
            head.appendChild(el('span', 'icrh-type', TYPE_LABEL[rule.type] || rule.type));
            const st = ruleStatusHere(rule);
            head.appendChild(el('span', 'icrh-st ' + st.cls, st.text));
            row.appendChild(head);
            row.appendChild(el('div', 'icrh-desc', describeRule(rule)));
            const ctl = el('div', 'icrh-rule-ctl');
            const tg = el('label', '');
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = rule.enabled !== false;
            cb.addEventListener('change', () => update(rule.id, r => { r.enabled = cb.checked; }, cb.checked ? '已启用规则' : '已停用规则'));
            tg.appendChild(cb); tg.appendChild(document.createTextNode(' 启用'));
            ctl.appendChild(tg);
            for (const [field, title, entries] of [
                ['backend', '后端', [['inherit', '跟随类型/全局'], ...Object.entries(BACKEND_LABELS)]],
                ['autoExecute', '自动', [['inherit', '跟随全局'], ['on', '自动执行'], ['off', '仅手动']]],
            ]) {
                const label = el('label', '', title + ' ');
                const select = document.createElement('select');
                select.setAttribute(field === 'backend' ? 'data-rule-backend' : 'data-rule-auto', '');
                for (const [value, text] of entries) {
                    const o = document.createElement('option'); o.value = value; o.textContent = text; select.appendChild(o);
                }
                select.value = field === 'backend' ? (Object.hasOwn(BACKEND_LABELS, rule.backend) ? rule.backend : 'inherit') :
                    (typeof rule.autoExecute === 'boolean' ? (rule.autoExecute ? 'on' : 'off') : 'inherit');
                select.addEventListener('change', () => update(rule.id, r => {
                    if (select.value === 'inherit') delete r[field];
                    else r[field] = field === 'backend' ? select.value : select.value === 'on';
                }, '规则执行设置已保存'));
                label.appendChild(select);
                ctl.appendChild(label);
            }
            if (rule.type === 'click') ctl.appendChild(localClickSelect(rule, v => update(rule.id, r => {
                if (v === 'auto') delete r.localClick; else r.localClick = v;
            }, '本地点选方式已保存')));
            const edit = el('button', 'icrh-btn', '编辑');
            edit.addEventListener('click', () => {
                if (row.querySelector('.icrh-edit')) return;
                row.appendChild(ruleEditForm(host, rule, () => {
                    processed.clear(); toast('规则' + (i + 1) + ' 已修改', 'ok'); renderSettingsRules(box); scheduleScan();
                }, () => renderSettingsRules(box)));
            });
            ctl.appendChild(edit);
            const del = el('button', 'icrh-btn danger', '删除');
            del.addEventListener('click', () => {
                if (!confirm('删除规则' + (i + 1) + '（' + (TYPE_LABEL[rule.type] || '') + '）？')) return;
                removeRule(host, rule.id); processed.clear(); toast('已删除规则', 'ok'); renderSettingsRules(box); scheduleScan();
            });
            ctl.appendChild(del);
            row.appendChild(ctl);
            box.appendChild(row);
        });
    }


    /* ======================================================
     * 手动添加本站规则：右键选中元素
     * - 左键保持页面原有行为（不会误触点选验证码、不会关闭弹窗）
     * - 按坐标取元素栈，穿透盖在图片上的透明遮罩
     * - 支持跨域 iframe 内的验证码：顶层把拾取指令下发到所有子框架，
     *   在哪个框架里右键，就在那个框架里生成规则（规则按该框架的域名保存）
     * ====================================================== */
    const TYPE_LABEL = { text: '文本验证码', math: '计算题', slider: '滑块验证码', click: '点选验证码' };
    const MSG_KEY = '__icrh_msg__';
    const PICK_STEPS = {
        text: [{ kind: 'image', label: '验证码图片' }, { kind: 'input', label: '验证码输入框' }],
        math: [{ kind: 'image', label: '计算题图片' }, { kind: 'input', label: '答案输入框' }],
        slider: [{ kind: 'image', label: '滑块背景大图' }, { kind: 'any', label: '滑块把手' },
            { kind: 'image', label: '可拖动的滑块图片（本地匹配用）', optional: true }],
        click: [
            { kind: 'image', label: '点选验证码大图' },
            { kind: 'any', label: '题目提示（如「请依次点击」后面的字/图）', optional: true },
        ],
    };
    const OWN_UI_IDS = ['icrh-pick-panel', 'icrh-pick-hl', 'icrh-toast-box', 'icrh-fab', 'icrh-settings-host', 'icrh-rules-host'];
    let picker = null;        // 当前框架内的拾取状态
    let pickToken = '';       // 顶层：当前拾取会话令牌，只接受带同一令牌的子框架回报

    const IS_TOP = (() => {
        try { return window.top === window; } catch (e) { return false; }
    })();

    function randomToken() {
        try {
            const a = new Uint32Array(4);
            crypto.getRandomValues(a);
            return Array.from(a, n => n.toString(36)).join('');
        } catch (e) {
            return Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
    }

    function postToFrames(msg) {
        for (let i = 0; i < window.frames.length; i++) {
            try { window.frames[i].postMessage(msg, '*'); } catch (e) { /* ignore */ }
        }
    }

    function postToTop(msg) {
        if (IS_TOP) {
            handleUpMessage(msg);
            return;
        }
        try { window.top.postMessage(msg, '*'); } catch (e) { /* ignore */ }
    }

    function isOwnUi(el) {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            if (OWN_UI_IDS.includes(n.id) || (n.getAttribute && n.getAttribute('data-icrh-btn'))) return true;
        }
        return false;
    }

    function isImageLike(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el === document.documentElement || el === document.body) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.height < 8) return false;
        // 铺满整个视口的一般是页面背景，不是验证码
        if (r.width * r.height >= 0.85 * window.innerWidth * window.innerHeight) return false;
        const tag = el.tagName;
        if (tag === 'IMG' || tag === 'CANVAS') return true;
        if (tag === 'INPUT' && (el.type || '').toLowerCase() === 'image') return true;
        return /url\(/.test(getComputedStyle(el).backgroundImage || '');
    }

    function isInputLike(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.tagName === 'TEXTAREA') return true;
        if (el.tagName !== 'INPUT') return false;
        const t = (el.type || 'text').toLowerCase();
        return !['password', 'hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(t);
    }

    // 鼠标下方可能盖着透明遮罩/提示层，按坐标取整个元素栈，找第一个符合类型的元素
    function resolvePickTarget(e, kind) {
        let stack = [];
        try { stack = document.elementsFromPoint(e.clientX, e.clientY) || []; } catch (err) { /* ignore */ }
        if (!stack.length && e.target && e.target.nodeType === 1) stack = [e.target];
        stack = stack.filter(el => !isOwnUi(el));
        if (kind === 'image') {
            const hit = stack.find(isImageLike);
            if (hit) return hit;
            // 图片设了 pointer-events:none 时命中的是外层容器：找容器里覆盖该点的图片
            for (const el of stack) {
                if (el === document.body || el === document.documentElement) break;
                const src = findImageSource(el);
                const vr = src && visibleRect(src);
                if (vr && e.clientX >= vr.left && e.clientX <= vr.right && e.clientY >= vr.top && e.clientY <= vr.bottom) {
                    return isImageLike(src) ? src : el;
                }
            }
        } else if (kind === 'input') {
            const hit = stack.find(isInputLike);
            if (hit) return hit;
        }
        const t = e.target;
        if (t && t.nodeType === 1 && t !== document.documentElement && !isOwnUi(t)) return t;
        return stack[0] || null;
    }

    function stepText(step) {
        return '请【右键】点击【' + step.label + '】' +
            (step.optional ? '（可选，按 Enter 跳过）' : '') + '（左键正常操作页面，Esc 取消）';
    }

    function showHighlight(hl, el) {
        if (!el) {
            hl.style.display = 'none';
            return;
        }
        const r = el.getBoundingClientRect();
        hl.style.display = 'block';
        hl.style.left = r.left + 'px';
        hl.style.top = r.top + 'px';
        hl.style.width = r.width + 'px';
        hl.style.height = r.height + 'px';
    }

    function startPicking(type, token) {
        stopPicking();
        const steps = PICK_STEPS[type];
        if (!steps) return;
        const hl = document.createElement('div');
        hl.id = 'icrh-pick-hl';
        hl.setAttribute('style', [
            'position:fixed', 'z-index:2147483646', 'pointer-events:none', 'display:none',
            'border:2px dashed #ff4081', 'background:rgba(255,64,129,.12)', 'box-sizing:border-box',
        ].join(';'));
        document.documentElement.appendChild(hl);

        const st = { type, token, steps, idx: 0, picked: [], hl, listeners: [] };
        const advance = () => {
            st.idx++;
            if (st.idx < steps.length) {
                postToTop({ [MSG_KEY]: 'progress', token, text: stepText(steps[st.idx]) });
            } else {
                finishPicking(st);
            }
        };
        // 右键的按下/抬起不交给页面，避免验证码把它当成一次作答
        const swallow = e => {
            if (e.button === 2) e.stopImmediatePropagation();
        };
        const onMove = e => showHighlight(hl, resolvePickTarget(e, steps[st.idx].kind));
        const onMenu = e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            const el = resolvePickTarget(e, steps[st.idx].kind);
            if (!el) return;
            st.picked[st.idx] = el;
            advance();
        };
        const onKey = e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                postToTop({ [MSG_KEY]: 'cancel', token });
            } else if (e.key === 'Enter' && steps[st.idx].optional && st.idx > 0) {
                // 只有在本框架已经选过前面步骤时才响应跳过
                e.preventDefault();
                e.stopImmediatePropagation();
                advance();
            }
        };
        st.listeners = [
            ['contextmenu', onMenu], ['mousedown', swallow], ['mouseup', swallow],
            ['pointerdown', swallow], ['pointerup', swallow], ['auxclick', swallow],
            ['mousemove', onMove], ['keydown', onKey],
        ];
        for (const [name, fn] of st.listeners) window.addEventListener(name, fn, true);
        picker = st;
    }

    function stopPicking() {
        if (!picker) return;
        for (const [name, fn] of picker.listeners) window.removeEventListener(name, fn, true);
        picker.hl.remove();
        picker = null;
    }

    function finishPicking(st) {
        stopPicking();
        const fail = text => postToTop({ [MSG_KEY]: 'cancel', token: st.token, text });
        const rule = { type: st.type, img: smartSelector(st.picked[0]) };
        if (queryVisibleImage(rule.img) !== st.picked[0]) return fail('图片选择器无法定位到所选元素，规则未保存');
        if ((st.type === 'text' || st.type === 'math')) {
            rule.input = smartSelector(st.picked[1]);
            if (!queryOne(rule.input)) return fail('输入框选择器无效，规则未保存');
        } else if (st.type === 'slider') {
            rule.handle = smartSelector(st.picked[1]);
            if (st.picked[2]) rule.piece = smartSelector(st.picked[2]);
        } else if (st.type === 'click' && st.picked[1]) {
            rule.hint = smartSelector(st.picked[1]);
        }
        const res = upsertRule(location.hostname, rule);
        processed.clear();
        log('已保存规则', location.hostname, res);
        postToTop({
            [MSG_KEY]: 'done', token: st.token,
            text: (res.updated ? '已更新规则' : '已添加规则') + '（' + location.hostname + '，共 ' + res.total + ' 条）: ' +
                TYPE_LABEL[st.type] + '\n' + describeRule(res.rule),
        });
        scan();
    }

    // 顶层：提示条 + 协调所有框架
    function setPickBar(text) {
        let bar = document.getElementById('icrh-pick-panel');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'icrh-pick-panel';
            bar.setAttribute('style', [
                'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
                'background:#5e35b1', 'color:#fff', 'padding:10px 16px', 'font-size:14px',
                'text-align:center', 'font-family:system-ui,-apple-system,sans-serif',
                'pointer-events:none',
            ].join(';'));
            document.documentElement.appendChild(bar);
        }
        bar.textContent = '📌 ' + text;
    }

    function beginPickAll(type) {
        endPickAll();
        pickToken = randomToken();
        setPickBar(stepText(PICK_STEPS[type][0]));
        startPicking(type, pickToken);
        postToFrames({ [MSG_KEY]: 'start', ptype: type, token: pickToken });
    }

    function endPickAll() {
        const bar = document.getElementById('icrh-pick-panel');
        if (bar) bar.remove();
        stopPicking();
        if (pickToken) postToFrames({ [MSG_KEY]: 'stop' });
        pickToken = '';
    }

    // 识别本框架，并下发给所有子框架（跨域 iframe 内的验证码由子框架自己处理）
    function recognizeEverywhere() {
        const hasFrames = window.frames.length > 0;
        const n = recognizeAll(true, hasFrames);
        if (hasFrames) {
            postToFrames({ [MSG_KEY]: 'recognize' });
            if (!n) toast('当前页面未发现验证码，已转交给内嵌框架（iframe）识别', 'info');
        }
    }

    // 子框架：只接受父框架下发的指令，并继续向下转发
    function handleDownMessage(msg) {
        switch (msg[MSG_KEY]) {
            case 'start': startPicking(msg.ptype, msg.token); break;
            case 'stop': stopPicking(); break;
            case 'recognize': recognizeAll(true, true); break;
            case 'fab-reset': resetFabPosition(); return;   // resetFabPosition 自己会继续下发
            default: return;
        }
        postToFrames(msg);
    }

    // 顶层：只接受当前拾取会话的回报
    function handleUpMessage(msg) {
        if (!pickToken || msg.token !== pickToken) return;
        const kind = msg[MSG_KEY];
        if (kind === 'progress') {
            setPickBar(String(msg.text || ''));
        } else if (kind === 'done' || kind === 'cancel') {
            endPickAll();
            if (msg.text) toast(String(msg.text), kind === 'done' ? 'ok' : 'err', 5000);
        }
    }

    function onFrameMessage(e) {
        const msg = e.data;
        if (!msg || typeof msg !== 'object' || typeof msg[MSG_KEY] !== 'string') return;
        if (IS_TOP) handleUpMessage(msg);
        else if (e.source === window.parent) handleDownMessage(msg);
    }

    function startPickFlow() {
        // 防止重复点击菜单叠加多个面板
        endPickAll();
        const typeChooser = document.createElement('div');
        typeChooser.id = 'icrh-pick-panel';
        typeChooser.setAttribute('style', [
            'position:fixed', 'top:14px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483647',
            'background:#fff', 'border-radius:8px', 'padding:12px 16px', 'box-shadow:0 4px 20px rgba(0,0,0,.3)',
            'font-size:13px', 'font-family:system-ui,-apple-system,sans-serif', 'text-align:center',
        ].join(';'));
        typeChooser.innerHTML =
            '<div style="font-weight:bold;margin-bottom:8px;color:#5e35b1">📌 添加规则 — 请选择验证码类型（同一网站可添加多条）</div>' +
            '<div style="display:flex;gap:8px">' +
            ['text', 'math', 'slider', 'click'].map(t =>
                '<button data-type="' + t + '" style="padding:6px 14px;border:none;border-radius:6px;' +
                'background:#5e35b1;color:#fff;cursor:pointer">' + TYPE_LABEL[t] + '</button>').join('') +
            '<button id="icrh-pick-cancel" style="padding:6px 14px;border:none;border-radius:6px;' +
            'background:#eee;cursor:pointer">取消</button></div>' +
            '<div style="margin-top:8px;color:#888;font-size:12px">选好类型后，用鼠标【右键】点击验证码元素（支持 iframe 内的验证码）</div>';
        document.documentElement.appendChild(typeChooser);

        typeChooser.querySelector('#icrh-pick-cancel').addEventListener('click', () => typeChooser.remove());
        typeChooser.querySelectorAll('button[data-type]').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.getAttribute('data-type');
                typeChooser.remove();
                beginPickAll(type);
            });
        });
    }

    /* ======================================================
     * 站点规则管理界面：一个域名可以有多条规则（如滑块 + 点选），
     * 每条可单独启用/停用/删除；也能管理 iframe 域名和其他站点的规则
     * ====================================================== */
    let ruleMgrHost = null;

    function closeRuleManager() {
        if (ruleMgrHost) ruleMgrHost.remove();
        ruleMgrHost = null;
    }

    // 当前页面里 iframe 的域名（跨域 iframe 的规则按它自己的域名保存）
    function frameHosts() {
        const hosts = [];
        const walk = (doc, depth) => {
            if (!doc || depth > 3) return;
            for (const f of doc.querySelectorAll('iframe, frame')) {
                try {
                    const u = new URL(f.getAttribute('src') || '', doc.location.href);
                    if (/^https?:$/.test(u.protocol)) hosts.push(u.hostname);
                } catch (e) { /* ignore */ }
                let inner = null;
                try { inner = f.contentDocument; } catch (e) { /* 跨域 */ }
                if (inner) {
                    try { hosts.push(inner.location.hostname); } catch (e) { /* ignore */ }
                    walk(inner, depth + 1);
                }
            }
        };
        walk(document, 0);
        return hosts.filter(Boolean);
    }

    // 每种类型可编辑的选择器（顺序即表单顺序）
    const RULE_FIELDS = {
        text: [['img', '验证码图片', true], ['input', '输入框', true]],
        math: [['img', '计算题图片', true], ['input', '答案输入框', true]],
        slider: [['img', '背景大图', true], ['handle', '滑块把手', true], ['piece', '滑块图片', false]],
        click: [['img', '点选大图', true], ['hint', '题目提示', false]],
    };

    function validSelector(sel) {
        try { document.createDocumentFragment().querySelector(sel); return true; } catch (e) { return false; }
    }

    // 某个选择器在当前页面的匹配情况（编辑时实时提示）
    function selectorStatus(sel) {
        if (!sel) return { text: '', cls: '' };
        if (!validSelector(sel)) return { text: '语法错误', cls: 'err' };
        const n = queryAll(sel).length;
        if (!n) return { text: '当前页未找到', cls: 'warn' };
        return { text: '匹配 ' + n + ' 个', cls: 'ok' };
    }

    // 规则编辑表单（设置「规则」页与规则管理共用）；保存成功调用 onSaved，取消调用 onCancel
    function ruleEditForm(host, rule, onSaved, onCancel) {
        const form = document.createElement('div');
        form.className = 'icrh-edit';
        const fields = RULE_FIELDS[rule.type] || [['img', '图片', true]];
        const inputs = {};
        const refresh = () => {
            const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
            for (const [k, i] of Object.entries(inputs)) {
                const st = selectorStatus(values[k]);
                const tag = i.parentElement.querySelector('.icrh-edit-st');
                tag.textContent = st.text;
                tag.className = 'icrh-edit-st ' + st.cls;
            }
        };
        for (const [key, label, required] of fields) {
            const row = document.createElement('label');
            row.className = 'icrh-edit-row';
            const name = document.createElement('span');
            name.className = 'icrh-edit-name';
            name.textContent = label + (required ? '' : '（可选）');
            const input = document.createElement('input');
            input.type = 'text';
            input.setAttribute('data-field', key);
            input.value = rule[key] || '';
            input.spellcheck = false;
            input.addEventListener('input', refresh);
            const st = document.createElement('span');
            st.className = 'icrh-edit-st';
            row.appendChild(name); row.appendChild(input); row.appendChild(st);
            form.appendChild(row);
            inputs[key] = input;
        }
        const err = document.createElement('div');
        err.className = 'icrh-edit-err';
        form.appendChild(err);
        const btns = document.createElement('div');
        btns.className = 'icrh-edit-btns';
        const save = document.createElement('button');
        save.className = 'icrh-edit-save';
        save.textContent = '保存修改';
        const cancel = document.createElement('button');
        cancel.className = 'icrh-edit-cancel';
        cancel.textContent = '取消';
        btns.appendChild(save); btns.appendChild(cancel);
        form.appendChild(btns);
        cancel.addEventListener('click', e => { e.preventDefault(); onCancel(); });
        save.addEventListener('click', e => {
            e.preventDefault();
            const values = {};
            for (const [key, label, required] of fields) {
                const v = inputs[key].value.trim();
                if (required && !v) { err.textContent = label + '不能为空'; return; }
                if (v && !validSelector(v)) { err.textContent = label + '：选择器语法错误'; return; }
                if (v.length > 500) { err.textContent = label + '：选择器太长'; return; }
                values[key] = v;
            }
            const saved = updateRuleSelectors(host, rule.id, values);
            if (!saved) { err.textContent = '规则已被删除'; return; }
            onSaved(saved);
        });
        refresh();
        return form;
    }

    function describeRule(rule) {
        const parts = ['图: ' + rule.img];
        if (rule.input) parts.push('输入框: ' + rule.input);
        if (rule.handle) parts.push('滑块: ' + rule.handle);
        if (rule.hint) parts.push('题目: ' + rule.hint);
        if (rule.piece) parts.push('滑块图片: ' + rule.piece);
        if (rule.length) parts.push('长度: ' + rule.length);
        if (rule.charset) parts.push('字符集: ' + rule.charset);
        if (rule.case) parts.push('大小写: ' + rule.case);
        return parts.join('  |  ');
    }

    // 选择器里含每次刷新都会变的内容（图片文件名、nth-of-type 长路径），换一组/重开弹窗后就失效
    function fragileSelector(sel) {
        if (!sel) return false;
        if (/\[src\*?=/.test(sel) && UNSTABLE_TOKEN.test(sel)) return true;
        return (sel.match(/:nth-of-type/g) || []).length >= 2;
    }

    function ruleStatusHere(rule) {
        const fragile = ['img', 'hint', 'handle', 'input'].some(k => fragileSelector(rule[k]));
        const r = evalRule(rule);
        if (!r) return { text: fragile ? '当前页未出现（选择器含随机内容，建议删除后重新添加）' : '当前页未出现', cls: 'off' };
        if (r.missing) return { text: '图在，配套元素未出现', cls: 'warn' };
        if (fragile) return { text: '可用，但选择器不稳定，建议重新添加', cls: 'warn' };
        return { text: '当前页可用', cls: 'on' };
    }

    function openRuleManager() {
        closeRuleManager();
        const styleText = [
            '.ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647;display:flex;',
            '  align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;}',
            '.box{background:#fff;color:#333;border-radius:10px;padding:18px 20px;width:620px;max-width:94vw;',
            '  max-height:86vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:13px;}',
            'h2{margin:0 0 4px;font-size:17px;color:#5e35b1;}',
            '.tip{color:#999;font-size:12px;margin-bottom:10px;}',
            '.host{margin-top:12px;border:1px solid #e0d7ff;border-radius:8px;overflow:hidden;}',
            '.host-h{display:flex;align-items:center;gap:8px;background:#f7f4ff;padding:6px 10px;font-weight:600;}',
            '.host-h .tag{font-weight:normal;color:#7c4dff;font-size:12px;}',
            '.host-h .sp{flex:1;}',
            '.empty{padding:8px 10px;color:#aaa;}',
            '.rule{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;padding:7px 10px;border-top:1px solid #f0ecff;}',
            '.rule.disabled .desc,.rule.disabled .type{opacity:.45;}',
            '.type{flex:none;padding:1px 8px;border-radius:10px;background:#5e35b1;color:#fff;font-size:12px;}',
            '.desc{flex:1;word-break:break-all;color:#555;line-height:1.5;}',
            '.st{flex:none;font-size:12px;padding:1px 6px;border-radius:4px;}',
            '.st.on{background:#e8f5e9;color:#2e7d32;}.st.off{background:#f5f5f5;color:#999;}.st.warn{background:#fff3e0;color:#ef6c00;}',
            '.execution{display:flex;gap:8px;flex-wrap:wrap;width:100%;}.execution select{padding:3px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#333;}',
            'button{border:none;border-radius:6px;cursor:pointer;font-size:13px;padding:4px 10px;}',
            '.del{background:#ffebee;color:#c62828;}.clear{background:#ffebee;color:#c62828;font-weight:normal;}',
            '.add{background:#5e35b1;color:#fff;padding:7px 14px;}.close{background:#eee;color:#555;padding:7px 14px;}',
            '.btns{display:flex;gap:10px;margin-top:16px;}',
            'details{margin-top:12px;}summary{cursor:pointer;color:#5e35b1;}',
            'label.tg{flex:none;display:flex;align-items:center;gap:3px;color:#666;font-size:12px;}',
            '.no{flex:none;font-weight:600;color:#5e35b1;font-size:12px;padding-top:1px;}',
            '.edit{background:#efecf7;color:#333;}.options{background:#efecf7;color:#333;}',
            RULE_EDIT_CSS,
        ].join('\n');

        ruleMgrHost = document.createElement('div');
        ruleMgrHost.id = 'icrh-rules-host';
        const shadow = ruleMgrHost.attachShadow({ mode: 'closed' });
        isolateKeyboard(ruleMgrHost);
        const style = document.createElement('style');
        style.textContent = styleText;
        shadow.appendChild(style);
        const overlay = document.createElement('div');
        overlay.className = 'ov';
        const box = document.createElement('div');
        box.className = 'box';
        overlay.appendChild(box);
        shadow.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) closeRuleManager(); });

        // 页面来源的字符串（选择器、域名）一律 textContent 写入
        const el = (tag, cls, text) => {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (text != null) n.textContent = text;
            return n;
        };
        const changed = (msg) => {
            processed.clear();
            if (msg) toast(msg, 'ok');
            render();
            scheduleScan();
        };

        function hostBlock(host, all, tag) {
            const rules = all[host] || [];
            const wrap = el('div', 'host');
            wrap.dataset.host = host;
            const head = el('div', 'host-h');
            head.appendChild(el('span', '', host));
            if (tag) head.appendChild(el('span', 'tag', tag));
            head.appendChild(el('span', 'sp'));
            head.appendChild(el('span', 'tag', rules.length + ' 条'));
            if (rules.length) {
                const clr = el('button', 'clear', '清空');
                clr.addEventListener('click', () => {
                    if (!confirm('删除 ' + host + ' 的全部 ' + rules.length + ' 条规则？')) return;
                    clearHostRules(host);
                    changed('已清空 ' + host + ' 的规则');
                });
                head.appendChild(clr);
            }
            wrap.appendChild(head);
            if (!rules.length) wrap.appendChild(el('div', 'empty', '暂无规则'));
            rules.forEach((rule, i) => {
                const row = el('div', 'rule' + (rule.enabled === false ? ' disabled' : ''));
                row.dataset.ruleId = rule.id;
                // 编号与悬浮按钮上的「规则N」一致
                row.appendChild(el('span', 'no', '规则' + (i + 1)));
                const tg = el('label', 'tg');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'toggle';
                cb.checked = rule.enabled !== false;
                cb.addEventListener('change', () => {
                    setRuleEnabled(host, rule.id, cb.checked);
                    changed((cb.checked ? '已启用' : '已停用') + '规则：' + (TYPE_LABEL[rule.type] || rule.type));
                });
                tg.appendChild(cb);
                tg.appendChild(document.createTextNode('启用'));
                row.appendChild(tg);
                row.appendChild(el('span', 'type', TYPE_LABEL[rule.type] || rule.type));
                row.appendChild(el('span', 'desc', describeRule(rule)));
                if (host === location.hostname) {
                    const st = ruleStatusHere(rule);
                    row.appendChild(el('span', 'st ' + st.cls, st.text));
                }
                const edit = el('button', 'edit', '编辑');
                edit.addEventListener('click', () => {
                    if (row.querySelector('.icrh-edit')) return;
                    row.appendChild(ruleEditForm(host, rule, () => changed('规则' + (i + 1) + ' 已修改'), () => render()));
                });
                row.appendChild(edit);
                const options = el('button', 'options', '本地选项');
                options.addEventListener('click', () => {
                    const keys = ['charset', 'length', 'case', 'mode', 'pieceStartRatio'];
                    const initial = Object.fromEntries(keys.filter(k => rule[k] !== undefined).map(k => [k, rule[k]]));
                    const raw = prompt('本地选项 JSON：charset=digits/letters/alnum；length=1~32；case=any/upper/lower；mode=auto/text。滑块可设 pieceStartRatio=0~1（选择器请点「编辑」修改）。留 {} 清空。', JSON.stringify(initial));
                    if (raw === null) return;
                    try {
                        const v = JSON.parse(raw);
                        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('必须为对象');
                        if (v.charset && !['digits','letters','alnum'].includes(v.charset)) throw new Error('字符集无效');
                        if (v.case && !['any','upper','lower'].includes(v.case)) throw new Error('大小写无效');
                        if (v.mode && !['auto','text'].includes(v.mode)) throw new Error('模式无效');
                        if (v.length !== undefined && (!Number.isInteger(v.length) || v.length < 1 || v.length > 32)) throw new Error('长度无效');
                        if (v.pieceStartRatio !== undefined && (!Number.isFinite(v.pieceStartRatio) || v.pieceStartRatio<0 || v.pieceStartRatio>1)) throw new Error('起始比例无效');
                        const all = loadAllRules();
                        const current = (all[host] || []).find(r => r.id === rule.id);
                        if (!current) throw new Error('规则已被删除');
                        keys.forEach(k => { delete current[k]; if (v[k] !== undefined) current[k]=v[k]; });
                        saveAllRules(all);
                        changed('本地选项已保存');
                    } catch (e) { toast('选项无效：' + e.message, 'err'); }
                });
                row.appendChild(options);
                const execution = el('div', 'execution');
                for (const [field, title, entries] of [
                    ['backend', '识别后端', [['inherit','跟随类型/全局'], ...Object.entries(BACKEND_LABELS)]],
                    ['autoExecute', '自动执行', [['inherit','跟随全局'],['on','自动执行'],['off','仅手动']]],
                ]) {
                    const label = el('label', '', title + ' ');
                    const select = document.createElement('select');
                    select.setAttribute(field === 'backend' ? 'data-rule-backend' : 'data-rule-auto', '');
                    for (const [value, text] of entries) {
                        const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
                    }
                    select.value = field === 'backend' ? (Object.hasOwn(BACKEND_LABELS, rule.backend) ? rule.backend : 'inherit') :
                        (typeof rule.autoExecute === 'boolean' ? (rule.autoExecute ? 'on' : 'off') : 'inherit');
                    select.addEventListener('change', () => {
                        const all = loadAllRules(), current = (all[host] || []).find(r => r.id === rule.id);
                        if (!current) return;
                        if (select.value === 'inherit') delete current[field];
                        else current[field] = field === 'backend' ? select.value : select.value === 'on';
                        saveAllRules(all); changed('规则执行设置已保存');
                    });
                    label.appendChild(select); execution.appendChild(label);
                }
                if (rule.type === 'click') execution.appendChild(localClickSelect(rule, v => {
                    const all = loadAllRules(), current = (all[host] || []).find(r => r.id === rule.id);
                    if (!current) return;
                    if (v === 'auto') delete current.localClick; else current.localClick = v;
                    saveAllRules(all); changed('本地点选方式已保存');
                }));
                row.appendChild(execution);
                const del = el('button', 'del', '删除');
                del.addEventListener('click', () => {
                    removeRule(host, rule.id);
                    changed('已删除规则' + (i + 1) + '：' + (TYPE_LABEL[rule.type] || rule.type) + '（' + host + '）');
                });
                row.appendChild(del);
                wrap.appendChild(row);
            });
            return wrap;
        }

        function render() {
            box.textContent = '';
            const all = loadAllRules();
            const here = location.hostname;
            const related = [here].concat(frameHosts()).filter((h, i, a) => a.indexOf(h) === i);
            box.appendChild(el('h2', '', '📋 站点规则管理'));
            box.appendChild(el('div', 'tip', '同一网站可以保存多条规则（如滑块 + 点选）。识别时按页面上当前出现的元素自动选用：' +
                '同一张图有多条规则时，优先用配套元素（滑块把手 / 题目 / 输入框）正在显示的那条；仍无法区分时，悬浮按钮按「规则N」编号让你选。'));
            related.forEach((h, i) => {
                if (i > 0 && !(all[h] || []).length) return;   // 没有规则的 iframe 域名不占位置
                box.appendChild(hostBlock(h, all, i === 0 ? '当前页面' : '内嵌框架'));
            });
            const others = Object.keys(all).filter(h => !related.includes(h)).sort();
            if (others.length) {
                const det = el('details');
                det.appendChild(el('summary', '', '其他站点（' + others.length + ' 个域名）'));
                for (const h of others) det.appendChild(hostBlock(h, all, ''));
                box.appendChild(det);
            }
            const btns = el('div', 'btns');
            const add = el('button', 'add', '＋ 添加规则（右键选中）');
            add.addEventListener('click', () => { closeRuleManager(); startPickFlow(); });
            const close = el('button', 'close', '关闭');
            close.addEventListener('click', closeRuleManager);
            btns.appendChild(add);
            btns.appendChild(close);
            box.appendChild(btns);
        }

        render();
        document.documentElement.appendChild(ruleMgrHost);
    }

    /* ======================================================
     * 菜单 & 快捷键 & 启动
     * ====================================================== */
    function registerMenus() {
        // 菜单回调会收到事件对象，不能直接作为 initialTab 传入
        GM_registerMenuCommand('⚙️ 设置', () => openSettings());
        GM_registerMenuCommand('📋 规则管理', () => openRuleManager());
        // 仅自动化测试使用：测试环境预先设置 window.__icrhTestHooks 才注册，正常使用不出现在菜单
        if (typeof window.__icrhTestHooks === 'object' && window.__icrhTestHooks) {
            GM_registerMenuCommand('__recognize', recognizeEverywhere);
            GM_registerMenuCommand('__pick', startPickFlow);
            GM_registerMenuCommand('__resetFab', resetFabPosition);
        }
    }

    // 快捷键：焦点在哪个框架就从哪个框架开始识别（含其子框架）
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && (e.code === 'KeyQ' || e.key === 'Q')) {
            e.preventDefault();
            recognizeEverywhere();
        }
    });

    function start() {
        // 菜单命令只在顶层页面注册，避免 iframe 多帧导致重复响应
        if (IS_TOP) registerMenus();
        window.addEventListener('message', onFrameMessage);
        // 扫描循环（启动后先扫一次，按钮尽快出现）
        scheduleScan();
        setInterval(scan, 1500);
        // 窗口尺寸变化后重新避让
        window.addEventListener('resize', () => { fabLayoutSig = ''; scheduleScan(); });
        // DOM 变化时增量扫描
        const mo = new MutationObserver(scheduleScan);
        mo.observe(document.documentElement, { childList: true, subtree: true });
        log('脚本已启动');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
