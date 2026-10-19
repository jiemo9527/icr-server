# AGENTS.md

给在本仓库工作的编码代理（以及人类贡献者）的约定。改代码前先读完。

## 项目结构

- `icr_server.py`：FastAPI 服务，负责接口、鉴权和图片解码。
- `local_recognition.py`：识别算法（OCR、计算题、滑块、文字点选），全部离线。
- `ICR.py`：图标点选，来自 FalseHappiness/RainyunCheckIn（MIT）。修改时保留文件头的来源和许可说明。
- `desktop_app.py` / `build_windows.py`：Windows 托盘程序与 PyInstaller 打包。
- `client/icr-helper.user.js`：油猴客户端「ICR 验证码助手」，单文件、无构建步骤；`client/*.test.js` 是 node:test + jsdom 测试。
- `tools/`：手动运行的联网联调脚本，不属于自动测试。浏览器路径从 `tools/_browser.py` 读取（环境变量 `ICR_BROWSER`）。
- `.github/workflows/build.yml`：测试 → Windows EXE → 容器验证 → Release；GHCR 镜像只在手动触发并勾选 `publish_image` 时发布。

## 必须遵守的产品约束

- **客户端只按规则工作**：不要加回内置站点识别或"自动判断验证码类型"的逻辑。没有规则的页面不显示 UI，也不发请求。
- **不自动提交**：只填写、点击、拖动，不点「确定 / 登录」之类的提交按钮。
- **自动执行要有上限**：默认关闭；同一目标连续自动执行最多 `AUTO_RUN_LIMIT`（2）次。同一个验证码有多条规则都适用、无法判断时，不自动执行，交给用户按「规则N」按钮选择。
- **「仅本地」是隐私边界**：缺地址、不支持、识别失败时都不能把图片发给大模型；「仅大模型」不能先请求本地服务。优先级为规则 > 类型 > 全局。
- **识别保守**：OCR 结果非空不等于正确。分数低、两模型冲突、分配不明确时返回 `ok: false`，不要为了提高作答率去放宽阈值。
- **网络默认安全**：默认 `127.0.0.1:8899`、不要求 Token；非本机监听必须有 Token。不要引入未鉴权的对外服务。
- 已移除的功能不要加回：滑块「完整背景」（full）、旧前缀 `aics`。

## 客户端实现要点

- 页面内的识别用 `captureVisible(el, { native: true })` 按可见区域、原图分辨率裁剪（易盾的大图和题目条都是同一张雪碧图被裁切显示）；大模型路径会放大图片。
- 规则大图选中空白或跨域 canvas 时，`findImageSource` 会改用同位置的图片。
- 点击前会模拟鼠标移动轨迹（`movePointer`）。等待时间用墙钟截止时间（`sleepUntil`），不要每步 `sleep` 累加：Windows 计时器精度约 15.6ms，误差会累积。
- 滑块拖动同时派发 mouse 和 touch 事件；本地滑块按拼图块的实际位置闭环修正（易盾的拼图块不跟把手 1:1 移动）。
- 设置和规则窗口在 Shadow DOM 里，宿主元素必须 `isolateKeyboard`，否则网页的单键快捷键会抢走焦点。
- 存储键：`icrh_config_v1`、`icrh_site_rules_v2`；测试钩子只在 `window.__icrhTestHooks` 存在时注册。

## 测试与验证

```sh
python -m unittest test_local_recognition test_icr_api test_desktop_app -v
cd client && npm ci && npm test
```

- 先写会失败的测试，再改代码。客户端测试跑两遍，以排除计时类的偶发失败。
- jsdom 跨窗口对象做 `deepEqual` 时，先 `JSON.parse(JSON.stringify(x))`。
- 走大模型路径的测试要在配置里写 `localUrl: ''`，否则会先请求默认的本地地址。
- 联网联调（`tools/*_live.py`、`tencent_repeat.py` 等）用的是测试 GM 桥接，不能当成 Tampermonkey 实际安装的结果；也不要高频提交真实验证码。
- 调参用过的样本不能算进通过率，要用新样本复测。真实站点通过率、样本准确率和桥接模拟结果，要分开说明。

## 隐私与仓库卫生

- 不要提交密钥、Token、个人路径、账号、真实站点的登录数据或验证码样本。样本和截图放在 `reports/private/`（已被忽略）。
- 示例和测试用 `example.com` 之类的域名，不写真实用户站点。
- 日志和调试输出不打印 API Key。

## 版本与发布

- 版本号写在 `client/icr-helper.user.js` 的 `@version` 和 `icr_server.py` 的 `FastAPI(version=...)`，两处同步修改。
- 打 `v*` 标签触发 Release。发布说明的开头来自 `.github/release-credits.md`，后面接自动生成的变更列表。
