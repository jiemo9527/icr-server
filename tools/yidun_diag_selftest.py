"""自检诊断油猴脚本 tools/yidun-click-diag.user.js：注入易盾嵌入式文字点选页，右键标 3 个点 → 点按钮，
确认：右键不触发易盾点击标记、按钮能派发点击（易盾出现 1/2/3 标记）、校验结果被记录到面板。
（自动化浏览器里结果会是失败，这里只验证诊断脚本本身能工作。）"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from _browser import launch_kwargs  # noqa: E402
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SRC = (ROOT / 'tools/yidun-click-diag.user.js').read_text(encoding='utf-8')
OUT = ROOT / 'reports/private/yidun'
with sync_playwright() as p:
    b = p.chromium.launch(**launch_kwargs(), headless=True)
    pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    pg.goto('https://dun.163.com/trial/picture-click', wait_until='domcontentloaded', timeout=40000)
    pg.wait_for_timeout(4000)
    pg.locator('.tcapt-tabs__tab', has_text='嵌入式').first.click(); pg.wait_for_timeout(5000)
    pg.evaluate(SRC)
    box = pg.locator('.yidun_bg-img').filter(visible=True).first.bounding_box()
    for x, y in [(60, 50), (160, 90), (260, 60)]:
        pg.mouse.click(box['x'] + x, box['y'] + y, button='right'); pg.wait_for_timeout(300)
    marks_yidun = pg.evaluate("document.querySelectorAll('.yidun_bg-img ~ * [class*=point], .yidun_bgimg [class*=point]').length")
    pg.locator('.yidun_panel').filter(visible=True).first.screenshot(path=str(OUT / 'diag-marked.png'))
    pg.get_by_text('按标记顺序点击').click()
    pg.wait_for_timeout(2600)
    pg.locator('.yidun_panel').filter(visible=True).first.screenshot(path=str(OUT / 'diag-clicked.png'))
    pg.wait_for_timeout(4000)
    print('yidun marks after right-click:', marks_yidun)
    print('LOG', pg.evaluate("[...document.querySelectorAll('#dg-log div')].map(d=>d.textContent)"))
    b.close()
