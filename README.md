# dsh-whale-pet · DeepSeek 鲸鱼娘桌宠

一个跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）上的桌宠插件：
**独立置顶桌面窗口**里的鲸鱼娘，会**说话**（TTS）、能**听你说话**（语音输入），并且可以
**操作你的电脑**——调音量、控制媒体、模拟键鼠、发系统通知。

她不是一张贴图：窗口是一个独立的 Electron 进程，通过回环桥接挂在 DSH 上，所以你正在聊天的那条会话里
发生了什么，她都能看见——模型在思考她会歪头，工具在跑她会冒汗，回答结束了她会把话念给你听。

![桌宠窗口](tests/artifacts/pet-window.png)

## 特性

- **独立置顶窗口**：Electron 无边框 / 透明 / 总在最前，可拖拽、可穿透点击留白、托盘菜单可显示隐藏；
  没装 Electron 时自动退回 Edge/Chrome 的 `--app` 独立窗口（并尽力置顶）。
- **语音播报**：把模型的回复清洗成可朗读的句子（自动丢掉代码块、链接、emoji），按句排队朗读；
  窗口不在线时会退回 Windows 系统语音合成。
- **语音输入**：优先用浏览器语音识别，不可用时（Electron 常见）自动落到离线 Windows SAPI 识别；
  识别结果直接作为一条用户消息进入你正在用的会话。
- **电脑操作**：7 个模型工具——音量与媒体、键鼠自动化、系统通知、桌面快照，以及驱动桌宠自身的说话 /
  表情 / 窗口控制。
- **形象可替换**：内置手绘 SVG 鲸鱼娘（6 种表情 + CSS 动画），把 PNG 丢进
  `pet/assets/whale/png/` 即可整体替换，不用改代码。
- **零构建、零运行时依赖**：宿主半边是纯 ESM JavaScript，直接作为 DSH bundle 行加载；
  唯一的开发依赖是 Electron（仅用于窗口）。

## 快速开始

```powershell
# 1) 装窗口依赖（只为了独立窗口；不装也能用浏览器回退）
cd F:\project\dsh-plugin\whale-pet
pnpm install

# 2) 安装进 DSH 的 profile
dsh plugin --profile web add F:\project\dsh-plugin\whale-pet

# 3) 重启 DSH，鲸鱼娘会自己出来
dsh --profile web
```

不想动 profile？用开发 overlay 起一个独立实例（端口 3081，不影响你正在用的界面）：

```powershell
cd <deepseek-harness 检出目录>
pnpm dsh web --patch F:\project\dsh-plugin\whale-pet\tests\fixtures\dev-patch.yml --port 3081 --no-open
```

更多安装方式、无窗口模式和故障排查见 [docs/install.md](docs/install.md)。

## 她会怎么用

启动后：

- 点一下鲸鱼娘 → 打开输入框，直接打字给她；内容会送进你当前活跃的会话。
- 点麦克风 → 说话，识别完成后自动发送（再点一次结束录音）。
- 右键 → 菜单：静音朗读、重念上一句、总在最前、隐藏窗口、退出桌宠。
- 托盘图标 → 显示 / 隐藏 / 置顶 / 退出（仅 Electron 且有图标时）。
- 模型侧则会自己调用这些工具：

| 工具 | 作用 |
| --- | --- |
| `pet_media` | 系统音量（增减、设定值、静音开关）与媒体播放控制（播放/暂停、上下曲、停止） |
| `pet_input` | 键盘鼠标自动化：输入文本（中文走剪贴板）、按键、组合键、移动、点击、滚轮；支持 `dryRun` 预演 |
| `pet_notify` | 系统通知 + 桌宠气泡（可选朗读） |
| `pet_look` | 只读快照：前台窗口与进程、光标位置、屏幕尺寸、音量、空闲时长 |
| `pet_say` | 让鲸鱼娘说出指定的话（TTS + 气泡） |
| `pet_mood` | 切换表情：idle / happy / thinking / working / sleepy / surprised |
| `pet_window` | 显示、隐藏、切换、重启、关闭窗口，切换总在最前，查看状态 |

参数、返回值与示例见 [docs/tools.md](docs/tools.md)。

## 目录结构

```
whale-pet/
├── index.js                 DSH 插件入口（注册桥接、工具、窗口）
├── cordis.patch.yml         bundle 层：一行 host 插件，配置全在这里
├── src/
│   ├── config.js            配置默认值与校验（配置错误直接让插件加载失败）
│   ├── bridge.js            回环 HTTP + SSE 桥接，并托管桌宠页面
│   ├── session-watch.js     会话事件 → 桌宠行为；用户输入 → 会话
│   ├── speech.js            Markdown → 可朗读文本（纯函数）
│   ├── pet-process.js       窗口进程生命周期
│   ├── tools/               7 个模型工具的原始 ToolDefinition
│   └── win32/               PowerShell 助手 + 调用器（JSON over stdio）
├── pet/                     Electron 外壳 + 渲染层 + 形象资源
├── scripts/                 启动器、自检脚本
├── tests/                   101 个单元/集成测试 + 测试用 overlay
└── docs/                    安装、架构、配置、工具、语音、开发
```

## 语音

- **播报**：浏览器 `speechSynthesis`，语言默认 `zh-CN`，可按名字指定音色；回复先被清洗再按句朗读，
  代码块只念一句“（代码块，略过）”。窗口离线时用 Windows PowerShell 5.1 的 System.Speech 兜底。
- **输入**：优先 Web Speech API（Chrome/Edge 可用）；Electron 里通常没有它，于是自动录音 →
  16 kHz 单声道 PCM16 WAV → 宿主侧 Windows SAPI 离线识别。SAPI 需要系统装了对应语言的识别器，
  没装会返回结构化错误而不是崩掉。

细节、限制与选型建议见 [docs/voice.md](docs/voice.md)。

## 换形象

- 默认形象是 `pet/assets/whale/whale-girl.svg`：一个 `viewBox="0 0 300 300"` 的自包含 SVG，
  用固定 id（`whale-eye-l`、`whale-fin-r`、`whale-tail` …）暴露可动画部件，用
  `exp-idle` / `exp-happy` / … 六个分组承载表情；`[data-mood]` 决定显示哪一个。
- 想换成自己的立绘：把 `idle.png`（以及可选的 `happy.png`、`thinking.png`、`working.png`、
  `sleepy.png`、`surprised.png`）放进 `pet/assets/whale/png/`，窗口启动时会自动改用 PNG，
  缺失的表情回退到 `idle.png`。

契约细节见 [pet/assets/whale/README.md](pet/assets/whale/README.md)。

## 安全与权限

- 桥接**只绑定回环地址**，每次启动生成随机 token；token 通过 `<script type="application/json">`
  注入页面（因此页面可以用严格 CSP，不需要内联脚本豁免），并且桥接不发送任何 CORS 头，
  所以你自己浏览器里的其他页面读不到它。
- 所有 PowerShell 助手都是本包内固定的、经过审查的脚本，参数以 JSON 走 stdin；
  **绝不拼接模型给的命令行**。宿主侧直接 `spawn`，不经过 DSH 的 shell 沙箱——
  插件作者就是这里的策略边界，这也是为什么助手脚本是白名单式的。
- `approval` 配置可以要求在执行某一类工具前弹审批（`media` / `input` / `notify` / `window`），
  默认全关：桌宠是替你动手的，默认不该每次都打断你。键鼠自动化支持 `dryRun` 先预演。
- 系统级破坏性操作（关机、格式化之类）**不在**这套工具里，这是刻意的。

## 已知限制

- 只支持 Windows：助手脚本依赖 Win32 / Core Audio / SAPI。宿主半边本身是跨平台的，
  但除 `pet_say` 的系统语音兜底外，PC 控制工具在非 Windows 上会以结构化错误失败。
- Linux/macOS 上窗口仍可运行（Electron），但 PC 控制工具不可用。
- 语音识别依赖系统识别器；缺失时只有浏览器语音识别一条路（Electron 里通常没有）。
- 媒体传输键（播放/暂停、上下曲）无法在不劫持播放的情况下验证结果，因此只按一次、
  不做读回确认；音量与静音则会读回真实状态。
- 通知的 `shown: true` 只代表“已提交给系统”，免打扰/通知设置仍可能把它丢掉。
- 桌宠窗口是独立进程：DSH 被强杀时窗口会留下，用托盘“退出桌宠”或 `pet_window quit` 关掉。

## 测试

```powershell
cd F:\project\dsh-plugin\whale-pet
node --test            # 101 个测试
node scripts/selftest-window.mjs --shot=tests/artifacts/pet-window.png   # 渲染自检截图
```

测试覆盖：配置校验、语音文本清洗与分句、桥接（静态资源 / token / SSE / 各 API / 路径穿越）、
会话事件映射与目标会话选择、插件入口（工具集合与 JSON Schema 白名单）、启动器参数与外壳发现、
以及全部 PowerShell 助手的 JSON 协议（键鼠类一律 dry-run）。

## 文档

- [安装与卸载](docs/install.md)
- [架构与数据流](docs/architecture.md)
- [配置参考](docs/configuration.md)
- [工具参考](docs/tools.md)
- [语音能力](docs/voice.md)
- [开发与验证](docs/development.md)

## 许可

MIT
