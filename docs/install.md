# 安装与卸载

鲸鱼娘桌宠由两半组成：DSH 宿主里的插件（[`../index.js`](../index.js) + `src/`，纯 ESM、无构建步骤）和独立的桌面窗口进程（`pet/`，由 [`../scripts/launch-pet.mjs`](../scripts/launch-pet.mjs) 启动）。两半只通过回环桥接通信，可以分开安装、分开崩溃。

## 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11 | 电脑操作工具依赖 Win32 / Core Audio / SAPI。宿主半边本身跨平台，但非 Windows 上除 `pet_say` 的系统语音兜底外，PC 工具都会以结构化错误失败。 |
| Node.js | `package.json` 的 `engines` 要求 `^22.19.0` 或 `>=24.0.0` | 宿主半边与启动器都用 `node` 运行，没有构建步骤。 |
| pnpm | 任意近期版本 | `pnpm install` 装窗口依赖；`dsh plugin` 也是在 profile 目录里转发给 pnpm。 |
| Electron | `devDependencies.electron@44.0.0` | 只用于独立窗口。缺失时会退回 Edge/Chrome 的 `--app` 窗口（见下）。 |
| PowerShell | Windows PowerShell 5.1（系统自带）即可；PowerShell 7（`pwsh`）可选 | 5.1 是硬需求：`notify.ps1` 的 WinRT toast 投影、`speak.ps1` 与 `asr.ps1` 的 `System.Speech` 都是 .NET Framework 组件，PowerShell 7 不能加载。`media.ps1` / `input.ps1` / `context.ps1` 两个宿主都能跑，装了 `pwsh` 会优先用它。 |
| DSH | 已安装的 `dsh` CLI（方式 A），或一个 DSH 检出目录（方式 B） | 方式 A 用 `dsh plugin`，方式 B 用 `pnpm dsh web --patch`。 |

窗口依赖的安装：

```powershell
cd F:\project\dsh-plugin\whale-pet
pnpm install
```

- [`../pnpm-workspace.yaml`](../pnpm-workspace.yaml) 声明了 `onlyBuiltDependencies: [electron]`。pnpm 默认拦截依赖的构建脚本，没有这一行 Electron 的 postinstall 不会执行，`node_modules/electron/dist/` 里就没有 `electron.exe`，窗口会静默退到浏览器回退。
- **npm 源与 Electron 二进制是两条路**：`electron` 包本身从 npm 源下载（本机 `%USERPROFILE%\.npmrc` 里配置的是内网镜像 `https://pkgs.d.xiaomi.net/artifactory/api/npm/mi-npm/`），而真正的 150 MB 二进制由该包的 postinstall 从网络另行下载，仓库里没有配置任何镜像（当前环境中 `ELECTRON_MIRROR` 未设置）。如果二进制下载失败，`pnpm install` 本身不会报错式失败，但 `node_modules/electron/dist/` 会是空的——此时要么配好 Electron 的镜像环境变量后重跑 `pnpm install`，要么用 `DSH_WHALE_PET_ELECTRON` 指向机器上已有的 `electron.exe`（`ELECTRON_OVERRIDE_DIST_PATH` 也被识别，见 [`../scripts/launch-pet.mjs`](../scripts/launch-pet.mjs) 的 `resolveElectron`）。
- 启动器**只查约定路径**（`node_modules/electron/dist/electron.exe`、`DSH_WHALE_PET_ELECTRON`、`ELECTRON_OVERRIDE_DIST_PATH`），不 `require('electron')`：那个包的入口在 `dist/` 缺失时会顺手下载二进制，属于不该在启动路径上发生的副作用。

## 方式 A：安装进 profile

```powershell
# 1) 装窗口依赖（不装也能跑，只是没有独立窗口）
cd F:\project\dsh-plugin\whale-pet
pnpm install

# 2) 把包链接进 web profile，并登记它的 bundle 层
dsh plugin --profile web add F:\project\dsh-plugin\whale-pet

# 3) 重启 DSH（当前进程不会热加载这一层）
dsh --profile web
```

`dsh plugin --profile <name> <args...>` 在 `$DSH_HOME/profiles/<name>` 目录里转发给 pnpm，因此 checkout 是以链接方式安装的，保留自己的 `node_modules`。因为 [`../package.json`](../package.json) 声明了：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

包名会被追加进 profile manifest 的 `dsh.profile.bundles` 列表。**这一层在 DSH 启动时生效**：启动时按顺序组合各 bundle 层的 patch，再叠加 profile 自己的 `cordis.patch.yml`，最后是命令行上的 `--patch` 覆盖。所以：

- 已经在跑的 DSH 不会因为 `add` 就多出一只鲸鱼娘，必须重启。
- 后应用的层**替换**目标行的整个 `config`，不做逐键深合并。这就是 [`../cordis.patch.yml`](../cordis.patch.yml) 把每个键都写全的原因；你要改其中一个键，得在自己的 patch 里把整块 `config` 重述一遍（[`configuration.md`](configuration.md) 有可直接复制的片段）。
- 不启动也能验证这一层：`dsh --profile web --dump-config`，输出里应出现 `# == dsh-whale-pet` 段落与 `id: whale-pet` 那一行。

## 方式 B：开发用 overlay

不想动 profile 时，用一个 overlay 从工作副本直接加载插件。仓库里附带的 [`../tests/fixtures/dev-patch.yml`](../tests/fixtures/dev-patch.yml) 内容如下：

```yaml
# Development overlay: load the whale-pet plugin straight from this working copy.
#
#   cd <deepseek-harness checkout>
#   pnpm dsh web --patch <this file> --port 3081 --no-open
#
# The row names the plugin's entry module by absolute path, so the plugin runs
# without being installed into a profile. `autoLaunch` is on, exactly as in a
# real profile: the DSH process starts the pet window and owns its lifetime.
# For a headless check, start the server with `DSH_WHALE_PET_AUTOLAUNCH=0`.
- insert:
    - id: whale-pet-dev
      name: 'F:/project/dsh-plugin/whale-pet/index.js'
      config:
        autoLaunch: true
        port: 4599
        # A fixed token so a manually launched window (and the health probes in
        # the development notes) can reach the bridge. Never do this in a real
        # profile: the default is a fresh random token per boot.
        token: 'whale-pet-dev-token'
        debug: true
```

```powershell
cd F:\project\deepseek-harness
pnpm dsh web --patch F:\project\dsh-plugin\whale-pet\tests\fixtures\dev-patch.yml --port 3081 --no-open
```

要点：

- 行里的 `name` 是 `index.js` 的绝对路径，所以**插件自带的 `cordis.patch.yml` 不参与**（它只是 bundle 层的入口）。overlay 行没写的键一律回落到 [`../src/config.js`](../src/config.js) 的 `DEFAULT_CONFIG`，因此上面这份只改端口、token、`autoLaunch` 与 `debug`。
- overlay 的端口 4599 与 Web UI 的 3081 互不影响：前者是桌宠桥接，后者是 DSH Web。
- 无窗口模式（只验桥接与工具）：

```powershell
$env:DSH_WHALE_PET_AUTOLAUNCH = '0'
pnpm dsh web --patch F:\project\dsh-plugin\whale-pet\tests\fixtures\dev-patch.yml --port 3081 --no-open
```

`DSH_WHALE_PET_AUTOLAUNCH=0` 是直接覆盖，即使行里写了 `autoLaunch: true` 也会被关掉（而 `DSH_WHALE_PET_PORT` 只在行里没写 `port` 时才生效）。窗口不会启动，但桥接、SSE 和 7 个工具照常工作；需要看窗口时再手动：

```powershell
node F:\project\dsh-plugin\whale-pet\scripts\launch-pet.mjs --url="http://127.0.0.1:4599/pet/?token=whale-pet-dev-token"
```

## 卸载与彻底清理

```powershell
# 1) 先关窗口，免得留下一个连不上桥接的孤儿进程
#    托盘图标 → 退出桌宠；或让模型调 pet_window quit
#    或用插件写的 pid 文件（taskkill /T 连同 Electron 子进程一起结束）
taskkill /pid (Get-Content "$env:TEMP\dsh-whale-pet.pid") /T /F

# 2) 从 profile 移除：依赖与 bundle 层一起消失
dsh plugin --profile web remove dsh-whale-pet
```

残留物清点（都在本机，删掉不会有副作用）：

| 路径 | 是什么 | 说明 |
| --- | --- | --- |
| `$DSH_HOME/profiles/web/` | profile 的 `package.json`（`dsh.profile.bundles`）与链接依赖 | `dsh plugin remove` 会处理。整个 profile 目录被删掉后，`dsh --profile web` 会报“profile does not exist”并提示用 `dsh plugin --profile web add <package>` 重建，不会静默初始化。 |
| `F:\project\dsh-plugin\whale-pet\node_modules\` | Electron 等开发依赖 | 由 `pnpm install` 生成。 |
| `F:\project\dsh-plugin\whale-pet\.electron-cache\` | 仓库 `.gitignore` 里预留的 Electron 下载缓存目录 | **当前代码不写这个目录**，只有你手动把 Electron 缓存指到这里时它才存在；不存在就无需处理。 |
| `%TEMP%\dsh-whale-pet.pid` | 窗口进程的 pid 文件 | 由 [`../src/pet-process.js`](../src/pet-process.js) 写入，正常关窗时删除；DSH 被强杀时会留下。 |
| `%TEMP%\dsh-whale-pet-browser\` | 浏览器回退窗口的 `--user-data-dir` | 由启动器创建。 |
| `%TEMP%\dsh-whale-pet-asr-*.wav` | 离线识别用的临时 WAV | `asr.ps1` 在 `finally` 里删除；进程被强杀时可能残留。 |

如果你只是想让插件“装而不动”，不用卸载：在行的 `config` 里设 `enabled: false`（或设 `DSH_WHALE_PET_DISABLE=1`），插件会加载但桥接、工具、窗口全都不启动。

## 故障排查

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 窗口不出来 | `enabled`/`autoLaunch` 被关；Electron 缺失；`launcher` 路径不存在 | 打开 `config.debug: true`，宿主日志里会有 `[whale-pet] ready — bridge http://127.0.0.1:<port> …`；若看到 `pet window not started: …` 或 `launcher not found`，按提示解决。手动跑一次 `node scripts/launch-pet.mjs --url=…` 可直接看到启动器 stderr；`DSH_WHALE_PET_WINDOW_DEBUG=1` 会把 Electron/浏览器的控制台输出接到启动器上。 |
| 桥接端口被占 | 4571 已被别的进程占用 | 桥接不会失败：日志会打印 `bridge port 4571 is in use; asking the OS for a free port`，随后用系统分配的端口。窗口 URL 用的是实际端口；手动开窗口时要读日志里 `ready —` 那一行的端口，不要猜。 |
| 没有声音 | `voice.enabled` / `voice.speakReplies` 关着；窗口菜单里点了“静音朗读”；系统没装中文语音 | 先看 `voice` 配置，再看窗口右键菜单的静音项（它只影响当前窗口会话）。若宿主回复进了气泡但没朗读，检查系统/浏览器是否有对应语言的语音；环境完全没有 `speechSynthesis` 时窗口会弹“此环境没有语音合成能力”。窗口离线时 `pet_say` 走系统语音兜底。 |
| 语音输入不可用 | Electron 通常没有 Web Speech 识别；SAPI 识别器未安装；麦克风被拒；`asr.enabled: false` | 默认会自动落到 SAPI（录音 → 16 kHz 单声道 PCM16 WAV → `/api/asr` → `asr.ps1`）。缺识别器时返回 `NO_RECOGNIZER`，窗口上显示“识别失败：…”。需要安装对应语言的 Windows 语音识别语言包；`asr.enabled: false` 时点麦克风提示“语音输入已关闭”。 |
| 工具调用失败 | 助手脚本缺失/解释器找不到/超时/参数非法 | 错误里带 `HelperError` 的 code：`HELPER_MISSING`、`HELPER_SPAWN_FAILED`、`HELPER_TIMEOUT`、`HELPER_REFUSED`、`HELPER_NO_OUTPUT`、`HELPER_BAD_OUTPUT`。确认 PowerShell 可执行、`DSH_WHALE_PET_PWSH` / `DSH_WHALE_PET_WINDOWS_PWSH` 指向真实存在的解释器，必要时调大 `helperTimeoutMs`（1000–120000）。非 Windows 上 PC 工具必然失败，这是设计如此。 |
| 没装 Electron | `node_modules/electron/dist` 不存在 | 启动器打印 `whale-pet: Electron is unavailable; opening an Edge/Chrome app window instead.` 并改用 `msedge.exe` / `chrome.exe` 的 `--app=<url>`，user-data 放在 `%TEMP%\dsh-whale-pet-browser`，并用 [`../scripts/topmost.ps1`](../scripts/topmost.ps1) 轮询把窗口顶到最前。代价是窗口不透明、带标题栏，且 `pet_window` 的 hide/topmost/quit 在页面侧不可用（页面会提示“此窗口不支持…”）。两者都找不到时启动器退出码为 3。 |
