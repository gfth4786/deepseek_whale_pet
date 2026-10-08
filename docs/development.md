# 开发与验证

## 目录结构

```
whale-pet/
├── index.js                 插件入口：resolveConfig → PetBridge → SessionWatcher → PetProcess → 7 个工具
├── cordis.patch.yml         bundle 层：一行 host 插件，配置键全在这里
├── package.json             dsh.bundle.patch 指向上面那份；仅 devDependency: electron
├── pnpm-workspace.yaml      onlyBuiltDependencies: [electron]（否则 postinstall 不跑）
├── src/
│   ├── config.js            默认值、逐键校验、环境变量覆盖（无 Schemastery Config）
│   ├── bridge.js            回环 HTTP + SSE；托管 pet/ 静态资源并注入启动数据
│   ├── session-watch.js     session/event → 桥接事件；用户输入 → agent.followup
│   ├── speech.js            Markdown → 可朗读文本（纯函数，无副作用）
│   ├── pet-process.js       窗口进程生命周期（start / stop / status、pid 文件）
│   ├── tools/pc.js          pet_media / pet_input / pet_notify / pet_look
│   ├── tools/pet.js         pet_say / pet_mood / pet_window
│   └── win32/               6 个 .ps1 助手 + run.js（JSON over stdio 的调用器）
├── pet/
│   ├── electron-main.cjs    Electron 外壳：无边框透明窗口、托盘、置顶、窗口 IPC
│   ├── preload.cjs          contextBridge 暴露 whalePetWindow
│   ├── index.html           严格 CSP + <!--WHALE_PET_BOOT--> 占位符
│   ├── pet.css              形象、气泡、菜单、[data-mood] 表情切换
│   ├── pet.js               渲染层：SSE、TTS、录音识别、窗口命令
│   └── assets/whale/        whale-girl.svg、whale-badge.svg、preview.png、png/（可放 PNG 立绘）
├── scripts/
│   ├── launch-pet.mjs       启动器/监督进程；Electron 优先，Edge/Chrome --app 兜底
│   ├── selftest-window.mjs  临时桥接 + 窗口 + 截图 + 一行 JSON
│   └── topmost.ps1          浏览器回退时的置顶看门进程
├── tests/                   7 个测试文件 + fixtures/dev-patch.yml + artifacts/
└── docs/                    本目录
```

## 跑测试

```powershell
cd F:\project\dsh-plugin\whale-pet
node --test                                # 默认发现：101 个测试
node --test "tests/*.test.mjs"             # 等价的显式 glob
node --test tests/win32.test.mjs           # 只跑一个文件（38 个）
```

> `package.json` 里的 `test` 脚本就是 `node --test`（默认发现）。早前写过 `node --test tests/`，那在当前 Node（v24.21.0）上**会失败**：命令行里的目录参数没有被展开，Node 反过来把 `tests` 当模块 `require`，报 `Cannot find module …\tests`。用上面的写法即可。

各文件覆盖什么：

| 文件 | 覆盖 |
| --- | --- |
| `tests/config.test.mjs` | 空配置得到冻结的默认值；标量/嵌套覆盖；未知键与类型错误大声失败；越界数值被钳制；host 只允许回环；`pinned` 必须有 `session.id`；环境变量覆盖的优先级；`launcherArgs` 元素类型。 |
| `tests/speech.test.mjs` | 围栏代码只念一次「（代码块，略过）」；链接留 label、URL/emoji 删除；短行内代码保留、长的概述；结构噪声清理；空输入；按终止符分句与上限；超长句自然断点；`toUtterances` 组合；`textOfContent` 只取文本块。 |
| `tests/bridge.test.mjs` | 页面带 boot 数据返回、页面里没有可执行内联脚本；静态资源 MIME；未知资源与路径穿越被拒；缺 token / 错 token 403、header token 可用；`/api/message` 到达宿主 sink、空文本 400、宿主失败以 `ok:false` 值返回；`/api/client`；`/api/asr` 可选、解码后字节正确送达；SSE 推送与迟到客户端的事件重放；无窗口时 `publish` 返回 `false`；端口被占时回落到系统分配端口；`petUrl` 带 token。 |
| `tests/session-watch.test.mjs` | 只订阅一次；结算回复变成 `reply` 与分句；没有 Agent 的会话被忽略；纯代码回复不朗读；`voice` 关闭时抑制；`turn/` 与 `tool/` 事件驱动状态；监听器抛错不影响后续；目标会话选择（最近活跃、无事件时取第一个、`pinned` / `none`）；空行被拒且不追加消息；快照内容；工具标签截断。 |
| `tests/plugin-entry.test.mjs` | `name` / `inject`；`apply` 注册的工具集合与唯一的 teardown effect；每个工具定义都落在 harness 强制的 JSON Schema 白名单内（镜像 `packages/core/tools/src/json-schema.ts`，并自带走查测试）；teardown 真的关掉桥接且可重复调用；按 `tools.*` 关类；`enabled: false` 什么都不注册；非法配置让加载失败；`pet_mood` / `pet_window` 在无窗口时的返回值；越界 action 抛错。 |
| `tests/launcher.test.mjs` | `--key=value` / `--key value` / 裸 flag 解析；`DSH_WHALE_PET_WINDOW` 的默认值、合并与坏 JSON 回落；`resolveElectron` 从 `dist/` 与 `DSH_WHALE_PET_ELECTRON` 解析；`findBrowser` 只返回存在的文件。 |
| `tests/win32.test.mjs` | 6 个助手的完整 stdio 协议：文件存在、空 stdin / 坏 JSON 也输出单行 JSON 且退出码 0、信封形状（`ok` 布尔 + `value` 对象或 `error`+`code` 字符串）、无 BOM；`context.ps1` 的类型化只读快照与两次读数自洽；`media.ps1` 的非法参数、预演、真实读回、音量增减的“电平中性”与还原、媒体键回退、静音翻转与还原；`input.ps1` **全部为 dry run**（不移动、不点击、不输入）；`notify.ps1` 的真实通知、预演、空请求、非 ASCII 透传。 |

**这个套件会真的碰系统状态**，因此在一个正在被使用的桌面上可能偶发失败（本仓库验证时就遇到过两次，重跑即过）：

- `input.ps1` 的 dry-run 用例会前后各读一次光标位置并断言指针没动——你在这几十毫秒里动一下鼠标就会失败（`the pointer moved during a dry run`）。
- `toggle-mute flips the flag…` 断言翻转静音不改变音量，别的程序（或音量键、驱动）在这期间改了音量也会失败。

## 窗口渲染自检

[`../scripts/selftest-window.mjs`](../scripts/selftest-window.mjs) 起一个临时桥接（随机端口、token `selftest`），让启动器用 `--selftest --shot=<path>` 打开窗口，等渲染层 `pet:ready` 后截图并打印一行 JSON：

```powershell
node scripts/selftest-window.mjs --shot=tests/artifacts/pet-window.png
# 成功：{"ok":true,"value":{"shot":"…","bytes":{"width":320,"height":420},"url":"http://127.0.0.1:PORT/pet/?token=***","ready":true}}
# 没装 Electron：{"ok":false,"error":"Electron is not installed; nothing to render"}，退出码 1
```

- 默认输出到 `tests/artifacts/pet-window.png`（该文件被 `.gitignore` 特意排除在忽略之外，因为 README 引用它）。
- 截图在 `pet:ready` 之后等 1200 ms 让动画帧落定；20 秒内没 ready 会以 `ok:false` 结束。
- `value.size` 是 `image.getSize()` 返回的 `{width, height}` 对象，即截图像素尺寸。
- `--mood=happy` 只把该值写进报告（`result.value.mood`），**不会**改变截图内容；`--keep` 保留临时桥接不关（默认自检结束后关闭）。
- 没装 Electron 时它不会退回浏览器窗口：浏览器回退模式下启动器会往 stderr 写“selftest is only meaningful with Electron; no screenshot was taken”。

## 起一个测试实例

```powershell
cd F:\project\deepseek-harness
pnpm dsh web --patch F:\project\dsh-plugin\whale-pet\tests\fixtures\dev-patch.yml --port 3081 --no-open
```

overlay 里的行 `id: whale-pet-dev`、`debug: true`、桥接端口 4599、固定 token `whale-pet-dev-token`。无窗口模式加 `$env:DSH_WHALE_PET_AUTOLAUNCH = '0'`。

### 验证桥接

`debug: true` 时 stderr 会先出现 ready 行，然后是逐条请求日志。桥接本身可以直接探：

```powershell
# 没有 token → 403 {"ok":false,"error":"invalid whale-pet bridge token"}
Invoke-RestMethod 'http://127.0.0.1:4599/api/state'

# 带 token → 快照；clients 就是当前连着的窗口数
Invoke-RestMethod 'http://127.0.0.1:4599/api/state?token=whale-pet-dev-token' |
  ConvertTo-Json -Depth 4

# 走 SSE 看宿主推送（Ctrl+C 结束）
curl.exe -N 'http://127.0.0.1:4599/api/events?token=whale-pet-dev-token'
```

`clients` 为 0 表示没有窗口连上（无窗口模式、窗口崩了，或窗口还停在启动阶段）。往会话里发一句话也可以直接打接口验证：

```powershell
Invoke-RestMethod 'http://127.0.0.1:4599/api/message?token=whale-pet-dev-token' -Method Post `
  -ContentType 'application/json' -Body '{"text":"在吗","source":"text"}'
# -> {"ok":true,"value":{"sessionId":"…","messageId":"…"}}
```

### 验证工具注册

看启动日志的那一行（`debug: true` 才保证你能在 stderr 上看到）：

```
[whale-pet] ready — bridge http://127.0.0.1:4599 (token from config), tools: pet_media, pet_input, pet_notify, pet_look, pet_say, pet_mood, pet_window
```

- `tools:` 后面就是真正注册成功的工具名，顺序与 `pcTools()` → `petTools()` 一致。少了谁，就去查 [`../src/config.js`](../src/config.js) 里对应的 `tools.*` 开关（`pet_say` 与 `pet_mood` 共用 `say`，`pet_window` 对应 `control`）。
- `(token from config)` 表示行里给了固定 token；空 token 时这里写 `(token generated)`，端口被占用时前面还会有一行 `bridge port 4599 is in use; …`。
- 没有 debug 时这行只进 Cordis logger，宿主没有挂日志导出器就看不到——这也是 `debug` 存在的理由。

## 换形象

### SVG 的 id 契约与表情分组

形象是 [`../pet/assets/whale/whale-girl.svg`](../pet/assets/whale/whale-girl.svg)（`viewBox="0 0 300 300"`），渲染层把它 **inline** 进 DOM（不是 `<img>`），所以 CSS 能按 id 驱动单个部件。契约与调色板见 [`../pet/assets/whale/README.md`](../pet/assets/whale/README.md)；渲染层依赖两点：

- 被动画的组：`whale-eye-l` / `whale-eye-r`（眨眼）、`whale-fin-l` / `whale-fin-r` / `whale-tail`（摆动）、`whale-root` 等。CSS 用 `transform-box: fill-box`，所以这些组自身不能带 `rotate()` / `scale()` / `matrix()`。
- 六个表情组 `exp-idle` / `exp-happy` / `exp-thinking` / `exp-working` / `exp-sleepy` / `exp-surprised` 直接挂在 `whale-root` 下，**只画与 idle 的差异**。`mountCharacter()` 会先删掉它们身上的内联 `style`，再由 [`../pet/pet.css`](../pet/pet.css) 接管显示：

```css
#character [id^="exp-"] { display: none }
#app[data-mood="happy"] #exp-happy { display: inline }
/* …thinking / working / sleepy / surprised 同理 */
```

心情是 `#app` 上的一个属性（`[data-mood="…"]`），同一个开关同时决定表情组、PNG 立绘、以及 `happy`/`thinking`/`working`/`sleepy`/`surprised` 各自的动画。`pet.js` 的 `setMood(mood, durationMs)` 负责写属性并在到点后回 `idle`。

### PNG 替换

把图丢进 `pet/assets/whale/png/`（相对本目录的 `png/` 子目录）即可整体替换矢量形象，文件名就是心情名：

```
pet/assets/whale/png/idle.png
pet/assets/whale/png/happy.png      thinking.png  working.png  sleepy.png  surprised.png
pet/assets/whale/png/tray.png       可选的托盘图标（找不到时试 icon.png）
```

- 启动时 `mountPngArtwork()` 对六个心情各发一次 `HEAD /pet/assets/whale/png/<mood>.png`；**只要有一张存在**就给 `#character` 加上 `character--png`（CSS 借此隐藏 SVG），并为六个心情各插一个 `<img class="character__png" data-mood="…">`。
- 缺哪个心情就用 `idle.png` 顶替；连 `idle.png` 都没有时用已存在的第一张。`.character__png` 默认 `display: none`，只有 `#app[data-mood="…"] .character__png[data-mood="…"]` 匹配的那张显示。
- 偶数张都不存在 → 继续用 SVG。SVG 也加载失败时，`pet.js` 会插一个内置的占位鲸鱼（`PLACEHOLDER_WHALE`），窗口不会空着。
- 托盘图标是另一个路径：`pet/electron-main.cjs` 的 `iconPath('tray') ?? iconPath('icon')`，即 `png/tray.png` 或 `png/icon.png`，都没有就不建托盘。

## 新增一个工具

1. **写定义**：放在 [`../src/tools/pc.js`](../src/tools/pc.js)（操作电脑）或 [`../src/tools/pet.js`](../src/tools/pet.js)（操作桌宠）的返回数组里。需要新的系统动作就在 [`../src/win32/`](../src/win32/run.js) 加一个 `.ps1`（stdin 一个 JSON、stdout 恰好一行 `{"ok":…,"value":…}` 信封），再用 `runHelper('名字', 入参, {timeoutMs, signal})` 调用。
2. **保持 schema 白名单**：`parameters` 只能用 `type` / `properties` / `required` / `additionalProperties` / `enum` / `items` / `oneOf` / `const`（外加 `description` / `title`），不能用 `minimum`、`format`、类型数组等——harness 在 `ctx.tools.register()` 时会拒绝。
3. **接进注册**：在 [`../index.js`](../index.js) 的 `toolEnabled()` 里为新工具名加一个 case，映射到某个 `config.tools.*`（新类就给 [`../src/config.js`](../src/config.js) 的 `DEFAULT_CONFIG.tools` 加键，并在 `apply()` 的分组条件里带上它）；否则它永远是 `default: true` 全开。要改默认开关，也要同步 [`../cordis.patch.yml`](../cordis.patch.yml)，因为 bundle 层逐项复述了这些默认值。
4. **同步更新测试**：
   - `tests/plugin-entry.test.mjs` 的 `apply registers the whole tool set` 里的名字数组（排序后比较），以及需要时的 `tool classes can be switched off from config`。
   - 同一个文件里的 schema 白名单走查会自动覆盖新定义——只要 `description`、`execute`、`output.schema`、`output.render` 都在。
   - 新助手脚本要加进 `tests/win32.test.mjs` 顶部的 `HELPERS` 数组（协议测试会遍历它），并按需补充针对该脚本的用例；`speak.ps1` / `asr.ps1` 目前不在 `HELPERS` 里，只有被单独针对时才测。
   - 需要审批就调 `requireApproval(ctx, config, 'input'|'media'|'notify'|'window', 原因, exec)`；只读工具可以声明 `isConcurrencySafe: () => true`。
5. **跑一遍**：`node --test` + `node scripts/selftest-window.mjs`，再用 dev overlay 起来确认 ready 行里出现了新工具名。
