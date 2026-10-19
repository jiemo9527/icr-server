"""离线评估：腾讯文字点选。det 框 → 合并被拆开的偏旁 → 每框对目标字取概率 → 全局最优分配。"""
import base64
import glob
import itertools
import json

import cv2
import ddddocr
import numpy as np

det = ddddocr.DdddOcr(det=True, show_ad=False)
models = [ddddocr.DdddOcr(show_ad=False, beta=True), ddddocr.DdddOcr(show_ad=False)]


def merge(boxes):
    boxes = [list(b) for b in boxes if (b[2] - b[0]) >= 12 and (b[3] - b[1]) >= 12]
    changed = True
    while changed:
        changed = False
        for i, j in itertools.combinations(range(len(boxes)), 2):
            a, b = boxes[i], boxes[j]
            vo = min(a[3], b[3]) - max(a[1], b[1])
            gap = max(a[0], b[0]) - min(a[2], b[2])
            u = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
            if vo > 0.5 * min(a[3] - a[1], b[3] - b[1]) and gap < 10 and (u[2] - u[0]) <= 1.45 * (u[3] - u[1]):
                boxes[j] = u; del boxes[i]; changed = True; break
    return boxes


def char_scores(crop, targets):
    buf = cv2.imencode('.png', crop)[1].tobytes()
    best = {t: 0.0 for t in targets}
    for m in models:
        r = m.classification(buf, probability=True)
        cs = r['charset']
        idx = {c: i for i, c in enumerate(cs)}
        rows = np.array(r['probabilities']).reshape(-1, len(cs))
        for t in targets:
            if t in idx:
                best[t] = max(best[t], float(rows[:, idx[t]].max()))
    return best


files = sorted(glob.glob('reports/private/textclick-samples/*.json'))
for f in files:
    d = json.load(open(f, encoding='utf-8'))
    raw = base64.b64decode(d['image'].split(',', 1)[1])
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    targets = d['hint'].split('：')[1].split('请')[0].split()
    boxes = merge(det.detection(raw))
    S = [char_scores(img[max(0, y1 - 3):y2 + 3, max(0, x1 - 3):x2 + 3], targets) for (x1, y1, x2, y2) in boxes]
    best, second = None, None
    for perm in itertools.permutations(range(len(boxes)), len(targets)):
        sc = sum(np.log(S[b][t] + 1e-6) for t, b in zip(targets, perm))
        if best is None or sc > best[0]:
            second, best = best, (sc, perm)
        elif second is None or sc > second[0]:
            second = (sc, perm)
    print(f[-7:], targets, len(boxes), [{t: round(s[t], 3) for t in targets} for s in S],
          'pick', [boxes[b] for b in best[1]] if best else None,
          'margin', round(best[0] - second[0], 2) if best and second else None)


if __name__ == '__main__':
    pass
