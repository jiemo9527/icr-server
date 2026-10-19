"""联调工具共用：浏览器可执行文件路径。

设置环境变量 ICR_BROWSER 指向本机 Chromium 内核浏览器（Chrome / Edge / Thorium 等）；
不设置时使用 Playwright 自带的 Chromium（需先 `python -m playwright install chromium`）。"""
import os

BROWSER = os.environ.get('ICR_BROWSER') or None


def launch_kwargs(**extra):
    """chromium.launch(**launch_kwargs(headless=True)) 用。"""
    kw = dict(extra)
    if BROWSER:
        kw['executable_path'] = BROWSER
    return kw
