"""离线识别引擎：保守采用，多模型冲突/不支持的输入返回备选建议。"""
import ast
import re
import threading
import time
from fractions import Fraction
from typing import Any

import cv2
import numpy as np

_MODELS = {}
_LOCK = threading.Lock()
_MATH_OCR = None
_MATH_LOCK = threading.Lock()
MIN_CONFIDENCE = 0.90  # 模型输出分数，不是经过校准的正确率


def _model(beta):
    if beta not in _MODELS:
        import ddddocr
        _MODELS[beta] = ddddocr.DdddOcr(show_ad=False, beta=beta)
    return _MODELS[beta]


def read_candidates(raw):
    """始终保留原图。只有原图都为空/低分时补充灰度增强，不以预处理覆盖原结果。"""
    def read(data, beta):
        result = _model(beta).classification(data, png_fix=True, probability=True)
        if not isinstance(result, dict):
            return str(result), 0.0
        return re.sub(r"\s+", "", result.get("text", "")), float(result.get("confidence", 0))

    with _LOCK:
        candidates = [read(raw, beta) for beta in (False, True)]
        if all(not text or score < MIN_CONFIDENCE for text, score in candidates):
            image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
            if image is not None and image.std() > 3:
                image = cv2.normalize(image, None, 0, 255, cv2.NORM_MINMAX)
                _, encoded = cv2.imencode('.png', image)
                candidates.extend(read(encoded.tobytes(), beta) for beta in (False, True))
        return candidates


def read_math_candidate(raw):
    """专门的数学 OCR 复核，CPU 离线运行；缺少可选依赖时保守退回备选。"""
    global _MATH_OCR
    with _MATH_LOCK:
        if _MATH_OCR is None:
            from rapidocr_onnxruntime import RapidOCR
            _MATH_OCR = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError('无法解码算式图片')
        # 单行验证码不需要整页文字检测，避免多线程过度争用和重复文字框。
        rows, _ = _MATH_OCR(image, use_det=False, use_cls=False)
    valid = []
    for text, score in rows or []:
        try:
            normalize_expression(text)
            valid.append((text, float(score)))
        except ValueError:
            pass
    return max(valid, key=lambda item: item[1]) if valid else ('', 0.0)


def normalize_expression(text):
    text = re.sub(r"\s+", "", text).translate(str.maketrans('＋－×÷＝？（）', '+-*/=?()'))
    text = text.replace('x', '*').replace('X', '*')
    text = re.sub(r'=\??$', '', text)
    if not text or len(text) > 48 or not re.fullmatch(r'[0-9+*/().-]+', text):
        raise ValueError('算式包含不支持的字符或长度超限')
    if '**' in text or '//' in text or not re.search(r'[+*/-]', text):
        raise ValueError('仅支持简单四则运算')
    return text


def calculate(text):
    expression = normalize_expression(text)
    try:
        tree = ast.parse(expression, mode='eval')
    except (SyntaxError, ValueError, RecursionError) as exc:
        raise ValueError('算式不完整') from exc
    if len(list(ast.walk(tree))) > 32:
        raise ValueError('算式过于复杂')

    def visit(node):
        if isinstance(node, ast.Constant) and type(node.value) is int:
            value = Fraction(node.value)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            left, right = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Add):
                value = left + right
            elif isinstance(node.op, ast.Sub):
                value = left - right
            elif isinstance(node.op, ast.Mult):
                value = left * right
            else:
                if right == 0:
                    raise ValueError('除零')
                value = left / right
        else:
            raise ValueError('不支持的运算')
        if abs(value) > 1_000_000:
            raise ValueError('数值超限')
        return value

    value = visit(tree.body)
    denominator = value.denominator
    for factor in (2, 5):
        while denominator % factor == 0:
            denominator //= factor
    if denominator != 1 or 1_000_000 % value.denominator:
        raise ValueError('不接受循环或超过六位的小数')
    return str(value.numerator) if value.denominator == 1 else f'{float(value):.6f}'.rstrip('0').rstrip('.')


def recognize_text(raw, charset='alnum', length=None, case='any', mode='auto'):
    started = time.perf_counter()
    result: dict[str, Any] = {'ok': False, 'text': '', 'kind': 'text', 'engine': 'ddddocr-dual',
              'reason': '', 'msg': '', 'fallback_suggested': True}
    candidates = read_candidates(raw)
    result['candidates'] = [{'text': text, 'score': round(score, 4)} for text, score in candidates]
    nonempty = [(text, score) for text, score in candidates if text]
    def fail(reason, message):
        result.update(reason=reason, msg=message, elapsed=round(time.perf_counter() - started, 3))
        return result
    if len(nonempty) < 2:
        return fail('empty_result', '两套模型未同时识别到内容')
    result['text'] = nonempty[0][0]
    # 自动模式只有 + - * / 或等号才判为算式；2x3 可是普通字符，不擅自变为乘法。
    is_math = mode == 'math' or (mode == 'auto' and any(re.search(r'[+*/=＝×÷]|\d-\d', text) for text, _ in nonempty))
    if is_math:
        # 问号经常被 ddddocr 认成数字。只在 RapidOCR 给出合法算式、且至少一个
        # ddddocr 的等号左侧完全相同时采用；不丢弃真实输入中的等号右侧再直接计算。
        try:
            strict_keys = [normalize_expression(text) for text, _ in nonempty]
        except ValueError:
            strict_keys = []
        if not strict_keys:
            try:
                math_text, math_score = read_math_candidate(raw)
                canonical = normalize_expression(math_text)
                corroborated = any(score >= MIN_CONFIDENCE and
                    normalize_expression(re.split('[=＝]', text)[0]) == canonical
                    for text, score in nonempty if re.search('[=＝]', text))
                if math_score >= MIN_CONFIDENCE and corroborated:
                    result.update(ok=True, kind='math', text=calculate(canonical), expression=canonical,
                                  engine='ddddocr+rapidocr+safe-math', reason='accepted',
                                  fallback_suggested=False, confidence=math_score,
                                  elapsed=round(time.perf_counter()-started, 3))
                    return result
            except (ValueError, ImportError, cv2.error):
                pass
    keys = []
    for text, score in nonempty:
        if is_math:
            try:
                keys.append(normalize_expression(text))
            except ValueError:
                return fail('invalid_expression', '算式不完整或有歧义')
        else:
            keys.append(text)
    if len(set(keys)) != 1:
        return fail('model_conflict', '模型结果冲突，建议大模型或人工确认')
    if min(score for _, score in nonempty) < MIN_CONFIDENCE:
        return fail('low_confidence', '模型分数较低，不自动采用')
    if is_math:
        try:
            result.update(text=calculate(keys[0]), kind='math', expression=keys[0], engine='ddddocr-dual+safe-math')
        except ValueError as exc:
            return fail('invalid_expression', str(exc))
    else:
        allowed = {'digits': r'[0-9]+', 'letters': r'[A-Za-z]+', 'alnum': r'[A-Za-z0-9]+'}.get(charset)
        text = keys[0]
        if not allowed or not re.fullmatch(allowed, text):
            return fail('charset_mismatch', '结果包含字符集以外的内容，不删字符、不强行纠正')
        if length and len(text) != length:
            return fail('length_mismatch', f'长度不符：期望 {length}，识别出 {len(text)}')
        if (case == 'upper' and any(c.islower() for c in text)) or (case == 'lower' and any(c.isupper() for c in text)):
            return fail('case_mismatch', '大小写不符合规则')
    result.update(ok=True, reason='accepted', fallback_suggested=False,
                  confidence=min(score for _, score in nonempty), elapsed=round(time.perf_counter() - started, 3))
    return result


def _match_shaded_gap(gray, mask, pad=4, bgr=None):
    """缺口为半透明暗色/亮色形状、滑块内容又与原位置不同（腾讯等）时，按形状轮廓定位。

    判据 A：|外环平均亮度 - 内部平均亮度|，适合暗色缺口。
    判据 B：轮廓线上的“近白像素比例 × 梯度强度”，适合带白描边的缺口。
    A 自身明显领先时直接采用；否则要求 B 明显领先且 A 的最高分落在同一位置附近。都不满足返回 None。
    """
    if mask is None or mask.sum() < 50:
        return None
    m = cv2.copyMakeBorder(mask, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    kernel = np.ones((2 * pad + 1, 2 * pad + 1), np.uint8)
    ring = (cv2.dilate(m, kernel) - m).astype(np.float32)
    inner = cv2.erode(m, np.ones((5, 5), np.uint8)).astype(np.float32)
    if ring.sum() < 20 or inner.sum() < 20 or m.shape[0] >= gray.shape[0] or m.shape[1] >= gray.shape[1]:
        return None
    g = gray.astype(np.float32)
    h, w = mask.shape

    def leader(scores):
        _, best, _, (x, y) = cv2.minMaxLoc(scores)
        rest = scores.copy()
        rest[max(0, y - h):y + h + 1, max(0, x - w):x + w + 1] = 0
        return x, y, float(best), float(rest.max())

    inside = cv2.matchTemplate(g, inner, cv2.TM_CCORR) / inner.sum()
    outside = cv2.matchTemplate(g, ring, cv2.TM_CCORR) / ring.sum()
    contrast = np.nan_to_num(np.abs(outside - inside), nan=0)
    ax, ay, a_best, a_second = leader(contrast)
    if a_best >= 25 and a_best >= a_second * 1.6:
        return ax + pad, ay + pad, a_best, a_best - a_second

    outline = cv2.morphologyEx(m, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)).astype(np.float32)
    if bgr is None or outline.sum() < 20:
        return None
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    white = ((hsv[:, :, 1] < 60) & (hsv[:, :, 2] > 190)).astype(np.float32)
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)
    magnitude = np.sqrt(gx * gx + gy * gy)
    on_white = cv2.matchTemplate(white, outline, cv2.TM_CCORR) / outline.sum()
    on_edge = cv2.matchTemplate(magnitude, outline, cv2.TM_CCORR) / outline.sum()
    combined = np.nan_to_num(on_white * on_edge, nan=0)
    bx, by, b_best, b_second = leader(combined)
    agree = abs(bx - ax) <= 6 and abs(by - ay) <= 6
    if b_best >= 60 and b_best >= b_second * 1.5 and agree and a_best >= 25:
        return bx + pad, by + pad, b_best, b_best - b_second
    return None


def match_slider(bg, piece=None):
    result: dict[str, Any] = {'ok': False, 'engine': 'opencv-slider', 'reason': '', 'msg': '', 'fallback_suggested': True,
              'width': int(bg.shape[1]), 'height': int(bg.shape[0])}
    def fail(message):
        result.update(reason='uncertain_match', msg=message)
        return result
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    if piece is not None:
        result['piece_width'] = int(piece.shape[1])
        offset = 0
        alpha_mask = None
        if piece.ndim == 3 and piece.shape[2] == 4:
            ys, xs = np.where(piece[:, :, 3] > 127)
            if not len(xs):
                return fail('滑块透明区域没有有效内容')
            offset = int(xs.min())
            alpha_mask = (piece[int(ys.min()):int(ys.max())+1, offset:int(xs.max())+1, 3] > 127).astype(np.uint8)
            piece = piece[int(ys.min()):int(ys.max())+1, offset:int(xs.max())+1, :3]
        if piece.ndim == 3:
            piece = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY)
        h, w = piece.shape
        if min(w, h) < 5 or w >= gray.shape[1] or h >= gray.shape[0] or piece.std() < 3 or gray.std() < 3:
            return fail('滑块尺寸或纹理不足')
        color_scores = cv2.matchTemplate(gray, piece, cv2.TM_CCOEFF_NORMED)
        edges = cv2.Canny(gray, 80, 160)
        template = cv2.Canny(piece, 80, 160)
        if np.count_nonzero(template) < 8:
            return fail('滑块边缘信息不足')
        edge_scores = cv2.matchTemplate(edges, template, cv2.TM_CCORR_NORMED)
        scores = np.nan_to_num(.5*color_scores + .5*edge_scores, nan=-1, posinf=-1, neginf=-1)
        _, best, _, (x, y) = cv2.minMaxLoc(scores)
        remaining = scores.copy()
        remaining[max(0,y-h//2):y+h//2+1, max(0,x-w//2):x+w//2+1] = -1
        second = float(remaining.max())
        if best < .65 or best-second < .04:
            shaded = _match_shaded_gap(gray, alpha_mask, bgr=bg if bg.ndim == 3 else None)
            if shaded is None:
                return fail('匹配分数低或存在多个相似位置')
            x, y, best, margin = shaded
            result.update(gap_left=x, gap_top=y, gap_width=w, gap_height=h, piece_offset_left=offset,
                          score=round(best, 2), margin=round(margin, 3), method='shaded-shape')
        else:
            result.update(gap_left=x, gap_top=y, gap_width=w, gap_height=h, piece_offset_left=offset,
                          score=round(best, 4), margin=round(best-second, 4), method='template')
    else:
        return fail('需要滑块图片，仅有缺口背景时交给大模型')
    result.update(ok=True, reason='accepted', fallback_suggested=False)
    return result


# ---------------------------------------------------------------- 文字点选
# 腾讯「请依次点击：驳 把 布」这类：在大图里找到题目中的汉字并按顺序返回中心坐标。
# 流程：ddddocr 检测文字框 → 合并被拆开的左右偏旁 → 每个框对目标字取识别概率
#       → 在所有「目标→框」排列里取联合概率最高的一组。
# 保守：框不够、任一目标几乎没有证据、或最优与次优分配差距太小时拒绝，交给大模型/人工。
TEXT_CLICK_MIN_PROB = 0.05      # 每个目标字在所选框上的最低概率
TEXT_CLICK_MIN_MARGIN = 2.0     # 最优与次优分配的 log 概率差
_DET = None
_DET_LOCK = threading.Lock()


def _flatten_alpha(img):
    """透明 PNG 铺到白底上（题目图常是透明底灰字）。"""
    if img is not None and img.ndim == 3 and img.shape[2] == 4:
        a = img[:, :, 3:4].astype(np.float32) / 255.0
        return (img[:, :, :3] * a + 255 * (1 - a)).astype(np.uint8)
    if img is not None and img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return img


HINT_MIN_CONFIDENCE = 0.90


def read_hint_chars(img):
    """题目是一张写着汉字的图片（天爱验证码等）：OCR 出目标字。
    图标条也常被 OCR 成「字」，所以要求严格：两模型字数一致、全部是汉字、2~6 个、主模型置信度高；
    不满足返回 ([], info)，调用方按图标点选处理。"""
    img = _flatten_alpha(img)
    info = {'texts': [], 'confidence': []}
    if img is None or img.size == 0:
        return [], info
    raw = cv2.imencode('.png', img)[1].tobytes()
    with _LOCK:
        rs = [_model(beta).classification(raw, probability=True) for beta in (True, False)]
    texts = [re.sub(r'\s+', '', str(r.get('text', ''))) if isinstance(r, dict) else '' for r in rs]
    confs = [float(r.get('confidence', 0)) if isinstance(r, dict) else 0.0 for r in rs]
    info.update(texts=texts, confidence=[round(c, 3) for c in confs])
    main, other = texts
    if not (2 <= len(main) <= 6) or not re.fullmatch(r'[\u4e00-\u9fff]+', main):
        return [], info
    if len(other) != len(main) or confs[0] < HINT_MIN_CONFIDENCE:
        return [], info
    # 两模型逐字比较：最多允许一个字不同（取主模型），再多说明不可靠
    if sum(a != b for a, b in zip(main, other)) > 1:
        return [], info
    return list(main), info


def parse_click_targets(text):
    """「请依次点击：驳 把 布」或「驳把布」→ ['驳','把','布']。只取汉字。"""
    text = str(text or '')
    if '：' in text or ':' in text:
        text = re.split(r'[：:]', text, maxsplit=1)[1]
    text = re.sub(r'请?(依次|按顺序)?点击', '', text)
    return re.findall(r'[\u4e00-\u9fff]', text)[:6]


def merge_char_boxes(boxes):
    """检测器常把左右结构的字拆成两个框（如「畴」→「田」+「寿」）。
    垂直方向大部分重叠、水平间隙很小、合并后仍接近方形的两个框合并为一个。"""
    import itertools
    boxes = [list(map(int, b)) for b in boxes if (b[2] - b[0]) >= 12 and (b[3] - b[1]) >= 12]
    changed = True
    while changed:
        changed = False
        for i, j in itertools.combinations(range(len(boxes)), 2):
            a, b = boxes[i], boxes[j]
            overlap = min(a[3], b[3]) - max(a[1], b[1])
            gap = max(a[0], b[0]) - min(a[2], b[2])
            u = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
            if overlap > 0.5 * min(a[3] - a[1], b[3] - b[1]) and gap < 10 and (u[2] - u[0]) <= 1.45 * (u[3] - u[1]):
                boxes[j] = u
                del boxes[i]
                changed = True
                break
    return boxes


def _detect_char_boxes(img):
    global _DET
    with _DET_LOCK:
        if _DET is None:
            import ddddocr
            _DET = ddddocr.DdddOcr(det=True, show_ad=False)
        raw = cv2.imencode('.png', img)[1].tobytes()
        return merge_char_boxes(_DET.detection(raw))


# 彩色、旋转的字（天爱、易盾文字点选）：除原图外再试「抠出字形」的黑白图，并在若干角度上识别
TEXT_CLICK_ANGLES = (-45, -30, -15, 15, 30, 45)


def _ink_mask(crop):
    """以框边缘的颜色作背景估计，离背景色远或饱和度高的像素当作字形，输出白底黑字。"""
    border = np.concatenate([crop[:2].reshape(-1, 3), crop[-2:].reshape(-1, 3),
                             crop[:, :2].reshape(-1, 3), crop[:, -2:].reshape(-1, 3)]).astype(np.float32)
    dist = np.linalg.norm(crop.astype(np.float32) - np.median(border, axis=0), axis=2)
    sat = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[:, :, 1].astype(np.float32)
    score = dist + sat * 0.8
    mask = (score > max(60.0, float(np.percentile(score, 75)))).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    out = np.full_like(crop, 255)
    out[mask > 0] = 0
    return out


def _rotate(img, angle):
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1)
    fill = tuple(int(v) for v in np.median(img.reshape(-1, 3), axis=0))
    return cv2.warpAffine(img, m, (w, h), borderValue=fill)


def _char_scores(box, img, targets):
    """该框对每个目标字的最高概率：原图与抠字图各自用两个 ddddocr 模型识别，
    快模型再在多个角度上识别（旋转的字），所有结果取最大。"""
    x1, y1, x2, y2 = box
    h, w = img.shape[:2]
    pad = 6
    crop = img[max(0, y1 - pad):min(h, y2 + pad), max(0, x1 - pad):min(w, x2 + pad)]
    best = {t: 0.0 for t in targets}

    def take(image, beta):
        r = _model(beta).classification(cv2.imencode('.png', image)[1].tobytes(), probability=True)
        if not isinstance(r, dict) or 'charset' not in r:
            return
        charset = r['charset']
        index = {c: k for k, c in enumerate(charset)}
        rows = np.asarray(r['probabilities'], dtype=np.float32).reshape(-1, len(charset))
        for t in targets:
            if t in index:
                best[t] = max(best[t], float(rows[:, index[t]].max()))

    with _LOCK:
        for variant in (crop, _ink_mask(crop)):
            for beta in (False, True):
                take(variant, beta)
            for angle in TEXT_CLICK_ANGLES:
                take(_rotate(variant, angle), False)
    return best


def solve_text_click(img, targets):
    import itertools
    h, w = img.shape[:2]
    result = {'ok': False, 'points': [], 'width': w, 'height': h, 'msg': '', 'method': 'det+ocr-assign'}
    if not targets:
        result['msg'] = '题目里没有可识别的文字'
        return result
    boxes = _detect_char_boxes(img)[:12]
    if len(boxes) < len(targets):
        result['msg'] = f'图中只检测到 {len(boxes)} 个文字，少于题目的 {len(targets)} 个'
        return result
    scores = [_char_scores(b, img, targets) for b in boxes]
    ranked = []
    for perm in itertools.permutations(range(len(boxes)), len(targets)):
        ranked.append((sum(float(np.log(scores[b][t] + 1e-6)) for t, b in zip(targets, perm)), perm))
    ranked.sort(key=lambda x: -x[0])
    best_score, best = ranked[0]
    margin = best_score - ranked[1][0] if len(ranked) > 1 else 99.0
    probs = [scores[b][t] for t, b in zip(targets, best)]
    result['confidence'] = [round(p, 3) for p in probs]
    result['margin'] = round(margin, 2)
    # 只允许一个字证据弱（由其余字排除法确定），且排列要明显领先
    weak = sum(p < TEXT_CLICK_MIN_PROB for p in probs)
    if weak > 1 or max(probs) < 0.3:
        result['msg'] = '文字识别把握不足：' + '、'.join(t for t, p in zip(targets, probs) if p < TEXT_CLICK_MIN_PROB)
        return result
    if margin < TEXT_CLICK_MIN_MARGIN:
        result['msg'] = '多种文字分配可能性接近，不确定'
        return result
    result['points'] = [[round((boxes[b][0] + boxes[b][2]) / 2, 1), round((boxes[b][1] + boxes[b][3]) / 2, 1)] for b in best]
    result['ok'] = True
    return result
