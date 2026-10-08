# 配置参考

所有配置都写在插件行的 `config` 块里。默认值与校验全在 [`../src/config.js`](../src/config.js)：插件**不导出 Schemastery `Config`**，行配置以未经校验的原样传进来，在这里逐项检查；非法值会让插件加载失败并给出指名到键的错误（`whale-pet config: …`）。

三层来源，优先级从低到高：代码里的 `DEFAULT_CONFIG` → 插件 bundle 层 [`../cordis.patch.yml`](../cordis.patch.yml)（目前逐项复述默认值）→ 你 profile 里 `- id: whale-pet` 的覆盖行或 `--patch` overlay。**后一层替换目标行的整个 `config` 值，不逐键合并**，所以覆盖时最好把关心的键都写出来。

## 顶层键

| 键 | 类型 | 默认 | 取值 | 影响 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | `true` / `false` | 总开关。`false` 时 `apply()` 直接返回：不起桥接、不注册工具、不开窗口，日志一行 `disabled by config; …`。 |
| `host` | string | `'127.0.0.1'` | 只允许 `127.0.0.1` / `localhost` / `::1` | 桥接绑定地址。其它值报错（不允许绑定到可路由地址）。 |
| `port` | number | `4571` | 整数 0–65535；非整数或越界报错 | 桥接端口。`0` 让系统分配。配置的端口被占用时**不失败**，改为向系统要一个空闲端口并在日志里说明；实际端口看 `ready —` 那行。 |
| `token` | string | `''` | 任意字符串 | 桥接 API 的共享密钥。空字符串时每次启动用 `randomBytes(16)` 现生成一个十六进制 token。固定 token 只适合开发（能手工拼窗口 URL / curl 探活）。 |
| `autoLaunch` | boolean | `true` | `true` / `false` | 启动时是否拉起桌宠窗口。`false` 时桥接与工具照常工作，可手动跑启动器。 |
| `launcher` | string | `''` | 绝对路径或空 | 自定义启动器。空则用 `scripts/launch-pet.mjs`；路径不存在时启动失败并记录 `launcher not found at …`（不会拖垮插件）。 |
| `launcherArgs` | string[] | `[]` | 字符串数组，元素非字符串报错 | 追加到启动器命令行末尾（在 `--url` / `--hidden` / `--no-topmost` 之后）。 |
| `stopOnUnload` | boolean | `true` | `true` / `false` | 插件卸载时是否停掉窗口进程（Windows 上 `taskkill /pid <launcher pid> /T /F`）。桥接无论如何都会关。 |
| `helperTimeoutMs` | number | `20000` | 有限数，**钳制**到 1000–120000 | 每个 PowerShell 助手的超时；也作为 ASR 超时的下限（取 `max(helperTimeoutMs, asr.maxSeconds * 1000)`）。 |
| `debug` | boolean | `false` | `true` / `false` | 打开后日志除进 Cordis logger 外**还写 stderr**（`[whale-pet] …`），并包含桥接与转发事件的细节。排查“我的鲸鱼娘去哪了”时的第一开关。 |

## `window`

窗口几何由宿主序列化成 `DSH_WHALE_PET_WINDOW`（JSON）交给启动器与 Electron。注意：快照 `/api/state` 里虽带 `window`，但渲染层目前不读它；**几何只走环境变量这一条路**（由插件写入子进程，覆盖你外部设置的同一变量）。

| 键 | 类型 | 默认 | 取值 | 影响 |
| --- | --- | --- | --- | --- |
| `width` | number | `320` | 钳制 160–1200 | 窗口宽（像素）。Electron `BrowserWindow` 与浏览器回退的 `--window-size` 都用它。 |
| `height` | number | `420` | 钳制 160–1200 | 窗口高（像素）。 |
| `margin` | number | `24` | 钳制 0–400 | 窗口与工作区角落的距离（像素）。 |
| `corner` | string | `'bottom-right'` | `bottom-right` \| `bottom-left` \| `top-right` \| `top-left`，其它值报错 | 贴着屏幕的哪个角。Electron 用主显示器 workArea 计算，浏览器回退用 `--window-position`。 |
| `alwaysOnTop` | boolean | `true` | `true` / `false` | `false` 时向启动器传 `--no-topmost`；Electron 侧不再强制置顶，浏览器回退也不启动 `scripts/topmost.ps1` 看门进程。 |
| `opacity` | number | `1` | 钳制 0.2–1 | 仅 Electron 生效（`setOpacity`，小于 1 时应用）；浏览器回退窗口始终不透明。 |
| `startHidden` | boolean | `false` | `true` / `false` | 向启动器传 `--hidden`，Electron 窗口先不显示（可被 `pet_window show` 或托盘唤出）。浏览器回退不支持该参数。 |

## `voice`

TTS 设置随快照下发到窗口（`{enabled, lang, voice, rate, pitch, volume}`），`maxChars` 等只在宿主侧使用。详见 [`voice.md`](voice.md)。

| 键 | 类型 | 默认 | 取值 | 影响 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | boolean | 总开关。`false` 时宿主不发 `reply` 语音；窗口不朗读；`pet_say` 在窗口离线时直接报错“语音已关闭，且桌宠窗口不在线”。 |
| `lang` | string | `'zh-CN'` | BCP-47 标签 | 交给 `SpeechSynthesisUtterance.lang`；选音时取其语言前缀（`zh`）匹配。SAPI 兜底路径不传 lang（`speak.ps1` 的选音用 `lang` 前缀，当前调用方没传该字段）。 |
| `voice` | string | `''` | 语音名片段或空 | 非空时按名字大小写不敏感的子串匹配优先选音；匹配不到再按语言选。 |
| `rate` | number | `1.05` | 钳制 0.5–2 | 语速。SAPI 兜底时线性映射到 `-10..10`：`round((rate-1)*8)`。 |
| `pitch` | number | `1.25` | 钳制 0.5–2 | 音高（仅浏览器合成器有；SAPI 路径忽略）。 |
| `volume` | number | `1` | 钳制 0–1 | 音量。SAPI 兜底时映射到 `0..100`。 |
| `maxChars` | number | `240` | 钳制 40–2000 | 单条朗读文本上限：`src/speech.js` 按句切分，超长句在逗号/空格处硬切。 |
| `speakReplies` | boolean | `true` | boolean | 是否朗读模型结算后的回复（`assistant/message`）。`false` 时窗口只显示气泡。 |

## `asr`

| 键 | 类型 | 默认 | 取值 | 影响 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | boolean | `false` 时 `/api/asr` 直接回 `{ok:false,error:'语音识别已在配置中关闭'}`，窗口侧点麦克风提示“语音输入已关闭”。 |
| `lang` | string | `'zh-CN'` | BCP-47 标签 | 识别语言：快照下发给窗口，作为 Web Speech 的 `lang` 与录音请求里的 `lang`；`asr.ps1` 用它挑识别器（取前缀匹配，匹配不到用第一个已安装的）。 |
| `engine` | string | `'auto'` | `auto` \| `webspeech` \| `sapi`，其它值报错 | `auto`：窗口有 Web Speech 就用它，否则录音走 SAPI。`webspeech`：没有 Web Speech 时**不**回退，提示“这个窗口没有浏览器语音识别”。`sapi`：一律录音走 SAPI。 |
| `maxSeconds` | number | `20` | 钳制 3–120 | 单次录音上限：快照下发给窗口，窗口用它作为自动停止的时限（`pet/pet.js` 的 `asr.maxSeconds`）；宿主侧也用它抬高助手超时预算（见 `helperTimeoutMs`）。 |

## `session`

| 键 | 类型 | 默认 | 取值 | 影响 |
| --- | --- | --- | --- | --- |
| `mode` | string | `'active'` | `active` \| `pinned` \| `none`，其它值报错 | 桌宠盯着/对着哪条会话：`active` 跟随最近活跃的会话（还没有事件时取第一个活着的 agent）；`pinned` 固定到 `id`；`none` 只观察、窗口发消息会失败。 |
| `id` | string | `''` | 会话 id | 仅 `pinned` 使用；`pinned` 且去空白后为空时报错 `session.id is required when session.mode is pinned`。 |

## `approval`

| 键 | 类型 | 默认 | 影响 |
| --- | --- | --- | --- |
| `input` | boolean | `false` | `pet_input` 的动作（除只读的 `position` 与 `dryRun: true`）执行前请求用户批准。 |
| `media` | boolean | `false` | `pet_media` 的每次调用前请求批准。 |
| `notify` | boolean | `false` | `pet_notify`（含桌宠气泡）发出前请求批准。 |
| `window` | boolean | `false` | `pet_window` 除 `status` 外的动作执行前请求批准。 |

批准走 `ctx.approval.request({agent, toolName, callId, reason, signal})`，只有 `'allowed-once'` 放行，其它结果抛错；部署里没有审批服务时抛“当前部署没有可用的审批服务”。`pet_look`、`pet_say`、`pet_mood` 不受审批约束。

## `tools`

每个键控制一类工具的注册；关掉的工具在 `apply()` 时就被跳过（而不是注册后拒绝调用）。`pet_say` 与 `pet_mood` 共用 `say`，`pet_window` 对应 `control`。

| 键 | 类型 | 默认 | 覆盖的工具 |
| --- | --- | --- | --- |
| `media` | boolean | `true` | `pet_media` |
| `input` | boolean | `true` | `pet_input` |
| `notify` | boolean | `true` | `pet_notify` |
| `look` | boolean | `true` | `pet_look` |
| `control` | boolean | `true` | `pet_window` |
| `say` | boolean | `true` | `pet_say`、`pet_mood` |

四个 PC 类工具全关时，连 `pcTools()` 都不会被构造；`say` 与 `control` 全关时同理跳过 `petTools()`。

## 环境变量

| 变量 | 读取位置 | 行为 |
| --- | --- | --- |
| `DSH_WHALE_PET_PORT` | [`../src/config.js`](../src/config.js) | 覆盖桥接端口，**仅当行里没有写 `port`**。必须是 0–65535 的整数，否则报错。 |
| `DSH_WHALE_PET_DISABLE` | [`../src/config.js`](../src/config.js) | 等于 `'1'` 时把 `enabled` 置为 `false`（无条件覆盖行里的值）。 |
| `DSH_WHALE_PET_AUTOLAUNCH` | [`../src/config.js`](../src/config.js) | 等于 `'0'` 时把 `autoLaunch` 置为 `false`（无条件覆盖，行里写 `true` 也会被关掉）。无窗口模式就靠它。 |
| `DSH_WHALE_PET_PWSH` | [`../src/win32/run.js`](../src/win32/run.js)、[`../scripts/launch-pet.mjs`](../scripts/launch-pet.mjs) | 指定跑助手脚本的解释器（如 `pwsh`）。默认顺序：本变量 → `PATH` 上的 `pwsh` → `C:\Program Files\PowerShell\7\pwsh.exe` → `PATH` 上的 `powershell` → Windows PowerShell 5.1。浏览器回退时，它也是置顶看门进程的解释器。 |
| `DSH_WHALE_PET_WINDOWS_PWSH` | [`../src/win32/run.js`](../src/win32/run.js) | 指定 Windows PowerShell 5.1 的路径（`notify` 的 WinRT toast、`speak` 与 `asr` 的 `System.Speech` 必须跑在 5.1 上）。默认取 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。被 pin 的解释器若以 `ENOENT` 启动失败，`runHelper` 会用另一侧的解释器重试一次。 |
| `DSH_WHALE_PET_ELECTRON` | [`../scripts/launch-pet.mjs`](../scripts/launch-pet.mjs) | 直接指定 `electron.exe` 的绝对路径，优先于 `node_modules/electron/dist`。（`ELECTRON_OVERRIDE_DIST_PATH` 也被识别，取该目录下的 `electron.exe` / `electron`。） |
| `DSH_WHALE_PET_WINDOW` | [`../scripts/launch-pet.mjs`](../scripts/launch-pet.mjs)、[`../pet/electron-main.cjs`](../pet/electron-main.cjs) | 窗口几何的 JSON（`{width,height,margin,corner,alwaysOnTop,opacity}`）。**由插件自己写入子进程环境**，所以外部设置它只对“手工运行启动器”有效；解析失败时静默回落到默认值，绝不因此启动失败。 |
| `DSH_WHALE_PET_WINDOW_DEBUG` | [`../scripts/launch-pet.mjs`](../scripts/launch-pet.mjs) | 等于 `'1'` 时不吞掉窗口进程的 stdio，把 Electron/浏览器的控制台输出接到启动器上（日志里还有一行 `[whale-pet window] …` 来自渲染层的 `pet:log`）。 |

## 可直接复制的片段

三种场景都写成 `- id: whale-pet` 的行覆盖（放在 profile 的 `$DSH_HOME/profiles/web/cordis.patch.yml`，或 overlay 文件里）。**只写要改的键是允许的**：未列出的键回落到 `src/config.js` 的默认值，而当前包内 layer 与这些默认值逐项相同。若将来包内 layer 改过某个键，你就必须把整块 `config` 重述，否则会被默认值悄悄改回去。

### 改端口 + 固定会话

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: whale-pet
  config:
    port: 4600            # 0 = 让系统分配；被占用时会自动换端口
    session:
      mode: pinned
      id: session-你的会话-id   # mode: pinned 时必填，空字符串会让插件加载失败
```

### 静音只留媒体控制

```yaml
- id: whale-pet
  config:
    voice:
      enabled: false       # 宿主不下发朗读，窗口也不朗读
    tools:
      media: true
      input: false         # 关掉键鼠自动化
      notify: false
      look: true
      control: true
      say: false            # pet_say 与 pet_mood 一起关掉
```

### 启用输入审批

```yaml
- id: whale-pet
  config:
    approval:
      input: true          # 每次 pet_input（除 position / dryRun）都先问一次
      media: false
      notify: false
      window: false
```

未装进 profile、用 overlay 起测试实例时，行是**新增**的，可以只写关心的键（`name` 用 `index.js` 的绝对路径，见 [`install.md`](install.md) 的方式 B）。
