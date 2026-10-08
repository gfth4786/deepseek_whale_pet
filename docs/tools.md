# 工具参考

7 个模型面向的工具，定义在 [`../src/tools/pc.js`](../src/tools/pc.js)（`pet_media`、`pet_input`、`pet_notify`、`pet_look`）与 [`../src/tools/pet.js`](../src/tools/pet.js)（`pet_say`、`pet_mood`、`pet_window`）。每个工具都是「校验 + 调用一个助手脚本（或桥接事件）」的薄包装：`execute` 只返回规范 JSON 值，模型真正读到的是 `output.render(args, value)` 渲染出的文本。关掉某一类的开关见 [`configuration.md`](configuration.md) 的 `tools`。

通用约定：

- 参数对象一律 `additionalProperties: false`，多给字段会被 harness 拒绝；`action` 类枚举外的值会在 `execute` 里抛错（不会静默猜）。
- 错误以抛异常的形式回到模型，消息是中文（例如 `不支持的媒体操作：explode`）。
- 需要审批的调用在 `execute` 最前面拦一次，未批准就抛错，助手脚本根本不会启动。

## `pet_media`

控制这台电脑的系统音量与媒体播放。

| 参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | `volume-up` `volume-down` `set-volume` `mute` `unmute` `toggle-mute` `play-pause` `next` `previous` `stop` | 要执行的操作。 |
| `level` | number | 否 | 0–100 | 仅 `set-volume` 使用；缺了会由助手返回 `BAD_INPUT`。 |
| `steps` | number | 否 | 1–50 | 仅 `volume-up` / `volume-down` 使用，默认 2；每步 2%。 |

返回值（助手 `media.ps1` 的 `value`）：`{action, volume, muted, via, mechanism}`。`volume` 是操作后读回的真实百分比（读不到为 `null`），`muted` 同为真实状态，`via` 为 `core-audio` 或 `media-keys`，`mechanism` 只在走了虚拟媒体键时是 `sendkeys` / `sendinput`，否则为 `null`。渲染成一行：`媒体控制完成：音量 42%，未静音，(via core-audio)`。

**模型会怎么调**：用户说“把声音调小一点，顺便暂停音乐” → 模型依次调用 `pet_media {action:'volume-down', steps:3}` 与 `pet_media {action:'play-pause'}`。

注意：

- `set-volume` 依赖 Core Audio（`IAudioEndpointVolume`）；机器上拿不到时返回 `CORE_AUDIO_UNAVAILABLE`，不会退回按键模拟。
- 音量类操作会读回真实状态；`play-pause` / `next` / `previous` / `stop` 无法在不劫持播放的前提下验证，因此**只按一次、不做读回确认**（`mechanism` 也不会带 `windows` 之类的验证信息）。
- 工具没有暴露 `dryRun`，虽然助手脚本本身支持预演（只有直接跑 `media.ps1` 才会走到那条分支）。
- `approval.media: true` 时每次调用都先弹审批。

## `pet_input`

在这台电脑上模拟键盘与鼠标。

| 参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | `type` `key` `hotkey` `move` `click` `double-click` `right-click` `scroll` `position` | 要执行的动作。 |
| `text` | string | 否 | 任意文本 | `type` 要输入的文本；`type` 缺文本会报 `BAD_INPUT`。 |
| `keys` | string | 否 | 如 `enter`、`f5`、`ctrl+s` | `key` / `hotkey` 的键名或组合键。 |
| `x` / `y` | number | 否 | 屏幕像素 | `move` 必填；`click` 系带上则先移动再点。 |
| `delta` | number | 否 | 非 0，绝对值 ≤ 100 | `scroll` 的滚动量，正数向上（乘以 120 作为滚轮单位）。 |
| `dryRun` | boolean | 否 | 默认 `false` | 只报告将会做什么，不动鼠标键盘、不改剪贴板。 |
| `restoreClipboard` | boolean | 否 | 默认 `true` | `type` 走剪贴板粘贴时，是否把原剪贴板内容放回去。工具侧把“未提供”规范化为 `true`（`args?.restoreClipboard !== false`）。 |

返回值按动作不同（`input.ps1`）：

| `action` | 返回字段 |
| --- | --- |
| `position` | `{action:'position', dryRun, position:{x,y}}` |
| `type` | `{action, dryRun, length, unicode, method, position, restored?}`，`method` 为 `sendkeys` 或 `clipboard` |
| `key` / `hotkey` | `{action,dryRun,keys,sendKeys,position}`（预演分支额外带 `windows`） |
| `move` | `{action,dryRun,moved,position,from}` |
| `click` / `double-click` / `right-click` | `{action,dryRun,clicked,clicks,button,moveFirst,position}` |
| `scroll` | `{action,dryRun,scrolled,delta,notches,direction,position}` |

渲染成一行，例如：`（预演，未真正执行）键鼠操作 click 完成，光标现在 (960, 540)`。

**模型会怎么调**：用户说“帮我在搜索框里打‘今天的天气’，然后回车” → `pet_input {action:'type', text:'今天的天气'}` + `pet_input {action:'key', keys:'enter'}`；拿不准坐标时先 `pet_input {action:'position'}` 或 `pet_look` 再 `move`/`click`。

注意：

- `dryRun: true` 与只读的 `position` **跳过审批**；其它动作在 `approval.input: true` 时先问用户。
- 中文等非 ASCII 走剪贴板：读取原剪贴板 → `Set-Clipboard` → `Ctrl+V` → 按 `restoreClipboard` 放回（原内容读不到时 `restored` 为 `false`）。纯 ASCII 走 `SendKeys` 并对其语法字符加花括号转义。
- 键名表：`enter`/`return`、`tab`、`esc`、`space`、方向键、`home`/`end`、`pageup`/`pagedown`、`delete`、`backspace`、`insert`、`f1`–`f12`、单字母与数字，修饰键 `ctrl`/`shift`/`alt`/`win`。`win` 组合键由助手先按下 `VK_LWIN` 再走 SendKeys。
- 一个 `hotkey` 只能有一个非修饰键；`ctrl` 这种“只有修饰键”会报错并列出支持的键名。

## `pet_notify`

弹出一条 Windows 系统通知，并可选地在鲸鱼娘头上显示气泡。

| 参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `message` | string | 是 | 非空 | 通知正文；去空白后为空会抛错。送给助手前截到 800 字符。 |
| `title` | string | 否 | 默认 `鲸鱼娘` | 通知标题，截到 120 字符。 |
| `silent` | boolean | 否 | 默认 `false` | 静默通知（不播系统提示音）。 |
| `bubble` | boolean | 否 | 默认 `true` | 是否同时推一个桌宠气泡（窗口在线时还会朗读该正文）。 |

返回值：助手值 `{shown, via, reason?}` 加上工具补的 `{bubble, title}`，即 `{shown:true, via:'toast'|'balloon', reason?, bubble, title}`。渲染：`通知已发出（toast，桌宠气泡已显示）`。

**模型会怎么调**：用户说“跑完测试叫我” → 长任务结束时 `pet_notify {title:'测试完成', message:'12 个用例全部通过', silent:false}`。

注意：

- 气泡事件（`notify`）在调用助手**之前**推送，所以即使系统通知被免打扰吞掉，桌宠也会先冒泡并朗读。
- 主路径是 Windows PowerShell 5.1 子进程里的 WinRT toast（标题/正文/静默/AppId 走环境变量传入，不进命令行）；失败则回落到 `NotifyIcon` 气泡，此时 `via: 'balloon'` 且 `reason` 说明原因。
- `shown: true` 只代表“已提交给系统”，系统的通知设置仍可能把它丢掉。
- `approval.notify: true` 时先审批。

## `pet_look`

只读地看一眼这台电脑现在的状态：前台窗口标题与进程、光标位置、屏幕分辨率、系统音量、用户空闲时长。

- 参数：无（`properties: {}`）。
- 返回值（`context.ps1`）：`{activeWindowTitle, activeProcessName, cursorX, cursorY, screenWidth, screenHeight, volume, muted, idleSeconds, time}`；任何单项读不到就是 `null`（`idleSeconds` 为 `null` 表示取不到，不是 0）。
- 渲染为四行文本，例如 `前台窗口：文档 - Word（WINWORD）`、`光标：(960, 540) / 屏幕 2560x1440`、`音量：42%`、`空闲：7 秒`。
- 声明了 `isConcurrencySafe: () => true`，是唯一可与其他工具并行的只读工具。
- 不受审批约束，也不改任何系统状态。

**模型会怎么调**：用户说“看看我在干嘛” → `pet_look {}`，再据此说“你在 Word 里写东西，已经 7 分钟没动了”。

## `pet_say`

让鲸鱼娘说出指定的话（TTS 朗读）并在头上显示气泡。

| 参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | string | 是 | 非空 | 要说的话，截到 600 字符。 |
| `mood` | string | 否 | `idle` `happy` `thinking` `working` `sleepy` `surprised` | 说话时的表情，默认 `happy`；非法值静默回落到 `happy`。 |

返回值：`{spoken, via, mood}`，`via` 为 `window` 或 `system-tts`。渲染：`鲸鱼娘说：“……”（window）`。

**模型会怎么调**：用户说“让她跟我说晚安” → `pet_say {text:'晚安，早点休息呀', mood:'sleepy'}`。

注意：

- 窗口在线（至少一个 SSE 连接）时只推桥接事件：`delivered === true` 就直接返回，不做其它事；窗口负责气泡、朗读与 6 秒表情。
- **窗口离线时退回系统语音合成**：`speak.ps1` 用 Windows PowerShell 5.1 的 `System.Speech` 朗读（沿用 `voice.rate` 与 `voice.volume`，忽略 `pitch` 与 `mood`）。此时 `via: 'system-tts'`。若 `voice.enabled: false` 且窗口离线，直接抛“语音已关闭，且桌宠窗口不在线”。
- 长文本不适合它：气泡最多显示 400 字符以上就直接整段铺出，朗读也只是一次 `Speak`；长内容用 `pet_notify`。
- 不需要审批。

## `pet_mood`

切换鲸鱼娘的表情。

| 参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `mood` | string | 是 | 同 `pet_say` 的六种 | 目标表情；非法值静默回落到 `idle`。 |
| `durationMs` | number | 否 | 钳制 0–600000 | 保持时长（毫秒）；省略或 0 表示一直保持。 |

返回值：`{mood, durationMs, windowOnline}`，`durationMs` 为 `null` 表示持续。渲染：`鲸鱼娘现在是「开心」`，窗口离线时追加 `（桌宠窗口不在线，回到窗口时会生效）`。

注意：

- 纯桥接事件，不调用任何助手脚本，也不需要审批。
- `windowOnline` 就是 `bridge.publish()` 的返回值（当前是否有连接的窗口）。桥接会保留最近 60 条事件并在新窗口连接时重放，所以离线时发出的表情**确实**会在窗口连上时生效；计时从窗口收到那一刻开始。

## `pet_window`

管理桌宠窗口本身。

| 参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | `show` `hide` `toggle` `restart` `quit` `status` `topmost-on` `topmost-off` | 要执行的窗口操作。 |

返回值：`{action, running, pid, clients, note?}`——`running`/`pid` 来自 `PetProcess`（跟踪的是启动器进程），`clients` 是桥接的 SSE 连接数。渲染：`桌宠窗口：show → 运行中=true, 连接数=1（已启动 pid 1234）`。

各动作的实际行为：

| `action` | 行为 |
| --- | --- |
| `status` | 只读状态，不审批、不发事件。 |
| `show` / `toggle` | 窗口进程没在跑就先启动启动器（`note` 记 `已启动 pid …`）；否则向渲染层发 `window` 事件。 |
| `hide` | 只发 `window` 事件，由 Electron 侧隐藏窗口（进程与托盘仍在）。 |
| `topmost-on` / `topmost-off` | 发 `window` 事件，由 Electron 调用 `setAlwaysOnTop`。 |
| `restart` | `petProcess.stop()`（`taskkill /T /F`）后重新 `start()`，`note` 是 `pid …` 或 `未能启动`。 |
| `quit` | 停掉窗口进程树，`note` 为 `已关闭窗口进程`；即使当前没有跟踪的子进程，也会按 `%TEMP%\dsh-whale-pet.pid` 里残留的 pid 收尾。 |

**模型会怎么调**：用户说“她挡住我看视频了” → `pet_window {action:'hide'}`；用户说“让她回来” → `pet_window {action:'show'}`。

注意：

- 除 `status` 外都需要 `config.approval.window` 为 `true` 时的用户批准。
- `hide` / `topmost-*` / `toggle` 依赖 Electron 的 preload 桥（`whalePetWindow`）。用 Edge/Chrome 回退窗口时页面会提示“此窗口不支持「hide」”，但动作仍算执行成功（返回值里 `running`/`clients` 照旧）。
- `running` 看的是启动器进程：窗口自己崩了但启动器还在时短瞬间可能仍报 `true`；`clients`（SSE 连接数）才是“窗口真的连上桥接了吗”的可靠指标。
