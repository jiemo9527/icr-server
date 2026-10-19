"""天爱文字点选样本评测：题目图 OCR → solve_text_click，输出每个样本的题目字、识别结果与点位，
并画出标注图（reports/private/tianai/eval/NN.jpg）供人工逐张核对。调参用的样本不计入通过率。
用法：tianai_eval.py [样本目录] [输出目录]"""
import glob
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import local_recognition as lr  # noqa: E402

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'reports/private/tianai/samples'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'reports/private/tianai/eval'
OUT.mkdir(parents=True, exist_ok=True)
rows = []
for f in sorted(glob.glob(str(SRC / '*-bg.png'))):
    n = os.path.basename(f)[:2]
    bg = cv2.imread(f)
    tip = cv2.imread(f.replace('-bg.png', '-tip.png'), cv2.IMREAD_UNCHANGED)
    t0 = time.perf_counter()
    targets, hint_info = lr.read_hint_chars(tip) if hasattr(lr, 'read_hint_chars') else ([], {})
    r = lr.solve_text_click(bg, targets) if targets else {'ok': False, 'msg': 'no targets', 'points': []}
    el = time.perf_counter() - t0
    img = bg.copy()
    for k, (x, y) in enumerate(r.get('points') or []):
        cv2.circle(img, (int(x), int(y)), 16, (0, 0, 255), 3)
        cv2.putText(img, str(k + 1), (int(x) - 8, int(y) + 8), 0, .9, (0, 0, 255), 3)
    t = tip
    if t.ndim == 3 and t.shape[2] == 4:
        a = t[:, :, 3:4] / 255.0; t = (t[:, :, :3] * a + 255 * (1 - a)).astype(np.uint8)
    t = cv2.resize(t, (int(t.shape[1] * 60 / t.shape[0]), 60))
    top = np.full((70, img.shape[1], 3), 255, np.uint8); top[5:65, :min(img.shape[1], t.shape[1])] = t[:, :img.shape[1]]
    cv2.putText(top, ''.join(targets).encode('unicode_escape').decode()[:0], (0, 0), 0, 1, (0, 0, 0), 1)
    cv2.imwrite(str(OUT / f'{n}.jpg'), np.vstack([top, img]), [cv2.IMWRITE_JPEG_QUALITY, 90])
    row = {'n': n, 'targets': ''.join(targets), 'hint': hint_info, 'ok': r.get('ok'), 'msg': r.get('msg'),
           'conf': r.get('confidence'), 'margin': r.get('margin'), 'points': r.get('points'), 's': round(el, 2)}
    rows.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)
(OUT / 'result.json').write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding='utf-8')
print('answered', sum(1 for r in rows if r['ok']), '/', len(rows))
