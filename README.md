# icr-server

本机离线运行的验证码识别服务，配一个油猴（Tampermonkey）客户端「ICR 验证码助手」。

- **服务端**：FastAPI，识别数字字母、计算题、滑块缺口、图标点选、文字点选。不联网、不收费，默认只监听本机。
- **客户端**：油猴脚本，只处理你添加过规则的验证码。识别后只负责填写、点击或拖动，**不会自动提交**。本地识别没把握时，可以按设置改用你自己配置的多模态大模型。

> 请只在你有权操作的网站和账号上使用。识别结果不保证正确，网站也可能另有风控。

## 能做什么

| 类型 | 本地接口 | 说明 |
|---|---|---|
| 数字字母 | `/ocr` | 两个 ddddocr 模型交叉校验，可限定字符集、长度、大小写 |
| 计算题 | `/math` | OCR 后安全解析四则运算，必要时用 RapidOCR 复核 |
| 滑块 | `/slider` | 拼图块模板 / 形状匹配，支持 CSS 雪碧图；客户端拖动时按拼图块实际位置闭环修正 |
| 图标点选 | `/solve` | 按题目图标顺序在大图中定位 |
| 文字点选 | `/textclick` | 题目可以是文字，也可以是写着汉字的图片；检测字框后多角度、抠字识别，再做全局分配 |

所有识别都偏保守：分数低、候选冲突时返回 `ok: false`，不乱点乱填。

实测情况（以下都是手动联调结果，不是通过率统计）：
- **腾讯天御**官方体验页：图标点选、滑块、文字点选都实测通过过。文字点选在本地没把握时会放弃。同一 IP 短时间内验证太多，腾讯会返回 errorCode 12（风控）。
- **网易易盾**：只验证过两点：本地点选能把大图和题目图正确裁剪后送去识别；带鼠标轨迹的脚本点击在真实浏览器里能通过校验。本地识别本身还不行，图标点选和文字点选大多放弃。
- **天爱验证码（tianai-captcha）文字点选**：题目字能读出来，但字的位置大多没把握而放弃，建议配合大模型使用。

## 快速开始

### 1. 运行识别服务（三选一）

**Windows**：从 [Releases](../../releases) 下载 `icr-server-windows-x64.zip`，解压后双击 `icr-server.exe`。它会出现在托盘里，默认监听 `127.0.0.1:8899`。

- 托盘菜单：打开 API 文档、配置文件、日志目录，开机启动开关，退出。
- 开机启动默认关闭；勾选后才写入当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，不需要管理员权限。
- 配置和日志在 `%LOCALAPPDATA%\ICRServer\`，改完配置要重启程序。
- 自检：`icr-server.exe --self-test --self-test-output result.json`；不要托盘、只开 HTTP：`icr-server.exe --serve`。

**Python**（推荐 3.12）：

```sh
pip install -r requirements-icr.txt
python icr_server.py
```

**Docker**（linux/amd64）：

```sh
docker compose up -d        # 使用 ghcr.io/jiemo9527/icr-server:latest
# 或者本地构建
docker build -t icr-server:local .
```

容器以非 root 用户、只读根文件系统运行，默认只把端口绑定到宿主机的 `127.0.0.1:8899`。

### 2. 安装客户端

在 Tampermonkey 里安装 Release 附件中的 `icr-helper.user.js`（源码在 `client/icr-helper.user.js`）。在油猴菜单打开「⚙️ 设置」，确认本地服务地址是 `http://127.0.0.1:8899`，点「测试连接」。

### 3. 添加规则

客户端只识别添加过规则的验证码，没有规则的页面不显示按钮、什么也不做。

1. 打开验证码，在油猴菜单选「📋 规则管理 → 添加规则」，再选验证码类型。
2. 按页面顶部提示，**用鼠标右键**依次点选：大图，以及输入框、滑块把手、拼图块或题目（按类型不同）。右键不会被网站当成作答。
3. 保存后，页面右侧会出现识别按钮。规则有编号「规则N」，可以在「设置 → 规则」或「规则管理」里编辑选择器、停用或删除。

每条规则可以单独设置：

- **识别后端**：本地优先、仅本地、仅大模型。优先级为规则 > 验证码类型 > 全局。选「仅本地」时，图片绝不会发给大模型。
- **自动执行**：默认关闭。开启后，验证码出现或换图时自动识别；同一目标最多连续自动执行 2 次，防止"失败 → 换图 → 再执行"的循环。
- **本地点选方式**（点选规则才有）：自动判断、图标点选、文字点选、关闭（直接用大模型）。

同一个验证码有多条规则都适用、脚本判断不了该用哪条时，不会自动执行，而是按「规则N」列出按钮，让你选一个。

### 规则示例

| 网站 | 类型 | 大图 | 其他 |
|---|---|---|---|
| 腾讯天御（新版，主页面渲染） | 图标点选 | `.tencent-captcha-dy__verify-bg-img` | 题目 `.tencent-captcha-dy__header-answer` |
| 腾讯天御 | 文字点选 | 同上 | 题目 `.tencent-captcha-dy__header-text` |
| 腾讯天御 | 滑块 | 同上 | 把手 `.tencent-captcha-dy__slider-block`，拼图块 `.tencent-captcha-dy__fg-item` |
| 腾讯旧版 iframe | 图标点选 | `#slideBg` | 题目 `#instruction`（规则保存在验证码 iframe 的域名下） |
| 网易易盾 | 点选 | `img.yidun_bg-img` | 题目 `.yidun_tips__content`（文字）或 `.yidun_tips__answer`（图标） |
| 网易易盾 | 滑块 | `.yidun_bg-img` | 把手 `.yidun_slider`，拼图块 `img.yidun_jigsaw` |
| 天爱验证码 | 文字点选 | `#tianai-captcha-slider-bg-img` | 题目 `#tianai-captcha-tip-img` |

网站改版后选择器可能失效，重新添加规则即可。

## 安全与隐私

- 服务默认只监听 `127.0.0.1`，不要求 Token。如果要监听其他地址，**必须**设置 `ICR_TOKEN`，客户端请求时带上 `X-ICR-Token`。对外开放时请再加 HTTPS 和访问控制。
- 「仅本地」模式下，验证码图片不会离开本机。只有选了「本地优先」并开启大模型备选，或选了「仅大模型」时，图片才会发到你配置的大模型接口。
- 大模型的 API Key 只保存在油猴脚本的本地存储里，调试日志不会输出它。

## API

请求体中的图片都是 base64 或 data URL。设置了 Token 时，请求头要带 `X-ICR-Token`（或 `Authorization: Bearer <token>`）。

| 接口 | 主要参数 | 返回 |
|---|---|---|
| `GET /health` | — | `endpoints`、`auth_required`、`auth_ok` |
| `POST /ocr` | `image`、`charset`（digits/letters/alnum）、`length`、`case`、`mode` | `ok`、`text` |
| `POST /math` | `image` | `ok`、`text`（计算结果） |
| `POST /slider` | `bg`、`piece`，可选 `piece_crop=[x,y,w,h]`、`piece_scale` | `gap_left`、`width`、`piece_offset_left`、`piece_width` |
| `POST /solve` | `bg`、`sprite`（题目图标条） | `points`（原图坐标，按点击顺序）、`width`、`height` |
| `POST /textclick` | `bg`、`targets`（题目文字），或 `hint_image`（题目图片） | `points`、`targets`；题目图片不是文字时返回 `reason: "hint_not_text"` |

完整的接口文档：服务启动后访问 `http://127.0.0.1:8899/docs`。

环境变量：`ICR_HOST`、`ICR_PORT`（默认 `127.0.0.1` / `8899`）、`ICR_TOKEN`、`ICR_SAVE_DIR`（设置后保存每次请求的图片和结果，方便排查）。

## 开发

```sh
# 服务端测试
python -m unittest test_local_recognition test_icr_api test_desktop_app -v
# 客户端测试（Node 22+）
cd client && npm ci && npm test
```

- 构建 Windows EXE：在单独的虚拟环境里安装 `windows-build.lock.txt`，然后运行 `python build_windows.py`，再用 `python tools/windows_smoke.py` 自检。
- `tools/` 下是手动运行的联网联调脚本，不属于自动测试。浏览器路径用环境变量 `ICR_BROWSER` 指定；不设置时用 Playwright 自带的 Chromium。脚本把 GM 存储和 HTTP 换成了测试桥接，结果不等同于在 Tampermonkey 里实际安装运行。请不要高频循环提交真实验证码。
- 样本、截图等调试数据请放在 `reports/private/`，这个目录已被 Git 和 Docker 忽略。

贡献代码前请先阅读 [AGENTS.md](AGENTS.md)。

## 构建与发布

GitHub Actions（`.github/workflows/build.yml`）的流程：

- 推送 `main` 或提交 PR：在 Linux 和 Windows 上跑测试 → 构建 Windows EXE 并自检 → 构建 Docker 镜像，并在非 root、只读模式下验证。
- 推送 `v*` 标签：在上面基础上，全部通过后创建 GitHub Release，附带 ZIP、`SHA256SUMS.txt` 和油猴脚本。
- 发布 GHCR 镜像：在 Actions 页面手动运行，并勾选 `publish_image`。在 `main` 上运行时标记为 `latest`；在版本标签上运行时标记为该版本号和 `latest`。

## 许可证与致谢

本项目使用 [MIT](LICENSE) 许可证。第三方库和模型遵循各自的许可证。

- 图标点选识别 `ICR.py` 来自 [FalseHappiness/RainyunCheckIn](https://github.com/FalseHappiness/RainyunCheckIn)（MIT，见 `ICR_LICENSE.txt`）。
- 油猴客户端最初参考了 GreasyFork 脚本 [AI 验证码自动识别填写（多模态大模型版）](https://greasyfork.org/scripts/596363)，作者 [星空倒影](https://greasyfork.org/users/719003)（MIT）。
