# icr-server：本地离线验证码识别服务（FastAPI）
#   GET  /health     连通性与鉴权状态
#   POST /ocr        数字字母验证码；POST /math 计算题
#   POST /slider     滑块缺口
#   POST /solve      图标点选（ICR.py，OpenCV）
#   POST /textclick  文字点选（题目可为文字或图片）
# 配套客户端：client/icr-helper.user.js（油猴脚本，按规则识别，本地优先、可选大模型备选）
#
# 依赖: pip install -r requirements-icr.txt
# 运行: python icr_server.py            （默认 127.0.0.1:8899）
# 环境变量:
#   ICR_HOST / ICR_PORT  监听地址，默认 127.0.0.1 / 8899
#   ICR_TOKEN            设置后客户端必须带请求头 X-ICR-Token（或 Authorization: Bearer <token>）；非本机监听必须设置
#   ICR_SAVE_DIR         设置后把每次请求的图片和结果存到该目录，方便排查识别失败的样本

import base64
import json
import logging
import os
import time
import uuid
from typing import Literal, Optional

import cv2
import numpy as np
import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import ICR
import local_recognition

TOKEN = os.getenv("ICR_TOKEN", "").strip()
SAVE_DIR = os.getenv("ICR_SAVE_DIR", "").strip()
# 两个图标的识别结果靠得这么近，说明匹配到了同一处，提交只会白白增加风控分
MIN_POINT_DISTANCE = 30

app = FastAPI(title="icr-server 本地验证码识别", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class OcrRequest(BaseModel):
    image: Optional[str] = None  # 验证码图片：base64 或 data URL
    image_url: Optional[str] = None
    charset: Literal['digits', 'letters', 'alnum'] = 'alnum'
    length: Optional[int] = Field(None, ge=1, le=32)
    case: Literal['any', 'upper', 'lower'] = 'any'
    mode: Literal['auto', 'text', 'math'] = 'auto'


class SolveRequest(BaseModel):
    bg: Optional[str] = None  # 背景图：base64 或 data URL
    sprite: Optional[str] = None  # "请依次点击"图标条：base64 或 data URL
    bg_url: Optional[str] = None  # 也可以只给图片地址，由服务端下载
    sprite_url: Optional[str] = None


def decode_image(data: Optional[str], url: Optional[str], name: str):
    try:
        if data:
            if data.startswith("data:"):
                data = data.split(",", 1)[1]
            if len(data) > 12_000_000:
                raise ValueError('图片过大')
            raw = base64.b64decode(data, validate=True)
        elif url:
            resp = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            raw = resp.content
        else:
            raise HTTPException(400, f"缺少 {name}")
        if not raw or len(raw) > 8_000_000:
            raise ValueError('空图片或图片过大')
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None or max(img.shape[:2]) > 4096:
            raise ValueError('无法解码或尺寸过大')
        return raw, img
    except (ValueError, cv2.error, requests.RequestException) as exc:
        raise HTTPException(400, f"{name} 图片解码失败: {exc}") from exc


def check_token(token: Optional[str], authorization: Optional[str]):
    if not TOKEN:
        return
    if authorization and authorization.lower().startswith("bearer "):
        token = token or authorization[7:].strip()
    if token != TOKEN:
        raise HTTPException(401, "token 错误")


def save_sample(bg_raw, sprite_raw, result, kind="solve"):
    try:
        os.makedirs(SAVE_DIR, exist_ok=True)
        name = time.strftime("%Y%m%d_%H%M%S_") + kind + "_" + uuid.uuid4().hex[:6]
        with open(os.path.join(SAVE_DIR, name + "_bg.jpg"), "wb") as f:
            f.write(bg_raw)
        if sprite_raw:
            with open(os.path.join(SAVE_DIR, name + "_sprite.jpg"), "wb") as f:
                f.write(sprite_raw)
        with open(os.path.join(SAVE_DIR, name + ".json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
    except Exception as e:
        logging.getLogger(__name__).warning('保存样本失败: %s', e)


@app.get("/health")
def health(x_icr_token: Optional[str] = Header(None),
           authorization: Optional[str] = Header(None)):
    # 不要求鉴权（方便探活）；带了 Token 时顺带告诉客户端对不对，没设 ICR_TOKEN 时恒为 True
    try:
        check_token(x_icr_token, authorization)
        auth = True
    except HTTPException:
        auth = False
    return {"ok": True, "endpoints": ["/solve", "/ocr", "/math", "/slider", "/textclick"], "auth_required": bool(TOKEN), "auth_ok": auth}


@app.post("/ocr")
def ocr(req: OcrRequest,
        x_icr_token: Optional[str] = Header(None),
        authorization: Optional[str] = Header(None)):
    check_token(x_icr_token, authorization)
    raw, _ = decode_image(req.image, req.image_url, "image")
    start = time.time()
    result = {"ok": False, "text": "", "msg": ""}
    try:
        result = local_recognition.recognize_text(raw, charset=req.charset, length=req.length,
                                                  case=req.case, mode=req.mode)
    except Exception as exc:
        result = {"ok": False, "text": "", "reason": "engine_error", "fallback_suggested": True,
                  "msg": f"识别异常: {exc}"}
    result["elapsed"] = round(time.time() - start, 3)
    logging.getLogger(__name__).info('[ocr] ok=%s text=%r %s %ss', result['ok'], result['text'], result['msg'], result['elapsed'])
    if SAVE_DIR:
        save_sample(raw, None, result, "ocr")
    return result


@app.post('/math')
def math_ocr(req: OcrRequest,
             x_icr_token: Optional[str] = Header(None),
             authorization: Optional[str] = Header(None)):
    return ocr(req.model_copy(update={'mode': 'math'}), x_icr_token, authorization)


class SliderRequest(BaseModel):
    bg: str
    piece: Optional[str] = None
    piece_crop: Optional[tuple[int, int, int, int]] = None
    piece_scale: float = Field(1.0, ge=0.1, le=10.0)


@app.post('/slider')
def slider(req: SliderRequest,
           x_icr_token: Optional[str] = Header(None),
           authorization: Optional[str] = Header(None)):
    check_token(x_icr_token, authorization)
    _, bg = decode_image(req.bg, None, 'bg')
    piece = None
    if req.piece:
        raw, _ = decode_image(req.piece, None, 'piece')
        piece = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_UNCHANGED)
        if req.piece_crop:
            x,y,w,h=req.piece_crop
            if x<0 or y<0 or min(w,h)<5 or x+w>piece.shape[1] or y+h>piece.shape[0]:
                raise HTTPException(400,'滑块裁剪范围超出图片')
            piece=piece[y:y+h,x:x+w]
        if req.piece_scale != 1:
            w=max(1,round(piece.shape[1]*req.piece_scale));h=max(1,round(piece.shape[0]*req.piece_scale))
            if max(w,h)>4096:raise HTTPException(400,'缩放尺寸超限')
            piece=cv2.resize(piece,(w,h),interpolation=cv2.INTER_LINEAR)
    started = time.perf_counter()
    result = local_recognition.match_slider(bg, piece=piece)
    result['elapsed'] = round(time.perf_counter() - started, 3)
    return result


class TextClickRequest(BaseModel):
    bg: str
    targets: str = Field('', max_length=200)  # 题目文字，如「请依次点击：驳 把 布」
    hint_image: Optional[str] = None           # 题目是图片（天爱验证码「请依次点击:」后面的字图）时传图片


@app.post('/textclick')
def textclick(req: TextClickRequest,
              x_icr_token: Optional[str] = Header(None),
              authorization: Optional[str] = Header(None)):
    """文字点选（腾讯「请依次点击：驳 把 布」）：返回按题目顺序的原图坐标；不确定时 ok=false。"""
    check_token(x_icr_token, authorization)
    bg_raw, bg = decode_image(req.bg, None, 'bg')
    targets = local_recognition.parse_click_targets(req.targets)
    hint_info = None
    if not targets and req.hint_image:
        raw, _ = decode_image(req.hint_image, None, 'hint_image')
        hint = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_UNCHANGED)
        targets, hint_info = local_recognition.read_hint_chars(hint)
        if not targets:
            # 题目图不是可靠的文字（多半是图标）：告诉客户端改走图标点选
            return {'ok': False, 'points': [], 'width': bg.shape[1], 'height': bg.shape[0], 'reason': 'hint_not_text',
                    'msg': '题目图片里没有可靠识别的汉字', 'hint': hint_info, 'targets': []}
    if not targets:
        raise HTTPException(400, '题目里没有可识别的汉字')
    started = time.perf_counter()
    try:
        result = local_recognition.solve_text_click(bg, targets)
    except Exception as exc:
        result = {'ok': False, 'points': [], 'width': bg.shape[1], 'height': bg.shape[0], 'msg': f'识别异常: {exc}'}
    result['targets'] = targets
    if hint_info is not None:
        result['hint'] = hint_info
    result['elapsed'] = round(time.perf_counter() - started, 3)
    logging.getLogger(__name__).info('[textclick] ok=%s targets=%s points=%s %s %ss', result['ok'], ''.join(targets),
                                     result['points'], result.get('msg', ''), result['elapsed'])
    if SAVE_DIR:
        save_sample(bg_raw, None, result, 'textclick')
    return result


# 同步函数，FastAPI 会放进线程池跑，OpenCV 计算不阻塞事件循环
@app.post("/solve")
def solve(req: SolveRequest,
          x_icr_token: Optional[str] = Header(None),
          authorization: Optional[str] = Header(None)):
    check_token(x_icr_token, authorization)
    bg_raw, bg_img = decode_image(req.bg, req.bg_url, "bg")
    sprite_raw, sprite_img = decode_image(req.sprite, req.sprite_url, "sprite")

    start = time.time()
    result = {"ok": False, "points": [], "width": bg_img.shape[1], "height": bg_img.shape[0], "msg": ""}
    try:
        matches = ICR.main(bg_img, sprite_img)
        points = [[round(x, 1), round(y, 1)] for x, y in ICR.convert_matches_to_positions(matches)]
        result["points"] = points
        result["similarity"] = [round(m["similarity"], 1) for m in matches]
        if not points:
            result["msg"] = "未识别到图标"
        elif any(abs(a[0] - b[0]) < MIN_POINT_DISTANCE and abs(a[1] - b[1]) < MIN_POINT_DISTANCE
                 for i, a in enumerate(points) for b in points[i + 1:]):
            result["msg"] = "多个图标匹配到同一处"
        else:
            result["ok"] = True
    except Exception as e:
        result["msg"] = f"识别异常: {e}"
    result["elapsed"] = round(time.time() - start, 3)

    logging.getLogger(__name__).info('[solve] ok=%s points=%s %s %ss', result['ok'], result['points'], result['msg'], result['elapsed'])
    if SAVE_DIR:
        save_sample(bg_raw, sprite_raw, result)
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("ICR_HOST", "127.0.0.1"), port=int(os.getenv("ICR_PORT", "8899")))
