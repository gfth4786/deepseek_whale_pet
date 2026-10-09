# 曼波音色：本地 TTS 服务 + 插件接法

桌宠默认用窗口自带的语音合成（系统里装了什么音色就用什么）。想要**曼波音色朗读 AI 回复**，
就要在中间放一个本地 TTS 服务，插件通过 `voice.engine: http` 把回复交给它念。

这套链路是：

```
DSH 回复 → 桌宠窗口 → 桥接 /api/tts（宿主进程，带 token） → 本地 GPT-SoVITS 引擎 127.0.0.1:9880 → WAV → 窗口播放
```

密钥/服务地址只存在于宿主进程，窗口看不到。

## 1. 服务端：MamboTTS（现成的曼波 GPT-SoVITS 模型）

[MamboTTS](https://github.com/Tsukimisaka/MamboTTS) 是 GPT-SoVITS 的 Windows 客户端 + 启动器，
**自带微调好的曼波模型**（`manbo_e8_s168.pth` + `manbo-e10.ckpt`）和参考音频（`models/refer.wav`，MIT 许可）。

```powershell
# 1) 取仓库（小，1.2MB）
git clone --depth 1 https://github.com/Tsukimisaka/MamboTTS.git F:\project\MamboTTS
cd F:\project\MamboTTS

# 2) 装依赖（只有安装器需要 requests；GUI 用的 PySide6 不需要）
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple requests

# 3) 下载并解压 GPT-SoVITS 整合包（7.62GB，ModelScope 约 25MB/s，含 SHA256 校验）
#    这一步用的是项目自带的安装器，只是去掉了界面
python -X utf8 install_cli.py general      # RTX 30/40 系用 general；50 系用 nvidia50
```

> 安装器会在 `F:\project\MamboTTS\GPT-SoVITS` 落下引擎（含内置 Python runtime 与预训练模型），
> 整合包缓存留在 `engine_temp\`（约 7.6GB，装好后可以删）。
>
> **注意**：`install_cli.py` 是本仓库加的**无界面包装**（`scripts/mambotts/` 里有对应说明）。
> 直接用 Python 3.14 跑它时如果控制台是 GBK，会因为项目日志里的 `✓` 报
> `'gbk' codec can't encode character`——加 `-X utf8`（或设 `PYTHONIOENCODING=utf-8`）即可。
> 这一步在网络中断后可以重复执行：已下载的包会被识别并跳过。

```powershell
# 4) 启动引擎（无界面，加载曼波模型，监听 127.0.0.1:9880）
node F:\project\dsh-plugin\whale-pet\scripts\mambotts\start-engine.mjs
# [engine] 模式：微调曼波权重
# [engine] READY http://127.0.0.1:9880 （fine-tuned）
```

两种模式自动选择：

| 情况 | 模式 | 说明 |
| --- | --- | --- |
| `models\manbo_e8_s168.pth` + `manbo-e10.ckpt` 在位 | **微调** | 项目原本的曼波音色，质量最好 |
| 只有 `models\refer.wav` | **零样本 (v2Pro)** | 用包内 v2Pro 基座模型 + 参考音频现场克隆，仍是曼波音色 |
| v2Pro 基座也不在 | 零样本 (引擎默认 v1) | 兜底，音色还原度更差 |

微调权重只随 GitHub Release 发布（`MamboTTS-v1.2.1-full.zip`，213MB，国内直连实测约 20KB/s、
约两小时）。先用零样本跑通即可；权重下好后一条命令升级：

```powershell
# 断点续传下载（可随时中断，重跑接著下）
node F:\project\dsh-plugin\whale-pet\scripts\mambotts\download-release.mjs
# 从发布包里取出两个权重，放进 F:\project\MamboTTS\models\
node F:\project\dsh-plugin\whale-pet\scripts\mambotts\install-weights.mjs
# 重启引擎（会自动切到微调模式）
node F:\project\dsh-plugin\whale-pet\scripts\mambotts\start-engine.mjs --check   # 先确认模式
node F:\project\dsh-plugin\whale-pet\scripts\mambotts\start-engine.mjs
```

`install-weights.mjs` 会在包没下完时直接拒绝（怕提取出半个文件），装好后把
`manbo_e8_s168.pth`（81.1MB）与 `manbo-e10.ckpt`（148.1MB）落到 `models\`。

`start-engine.mjs` 会在启动时打印当前模式：

```
[engine] 模式：fine-tuned
[engine] READY http://127.0.0.1:9880 （fine-tuned）
```

### 实测性能与自检

```powershell
# 合成一句话并量化结果（时长 / 峰值 / RMS / 实时率）
node F:\project\dsh-plugin\whale-pet\scripts\mambotts\tts-probe.mjs --text='你好，我是曼波。'
# { "ok": true, "seconds": 7.06, "elapsedMs": 1782, "realtimeFactor": 0.25, "peak": 0.627, ... }
```

RTX 3060 + v2Pro 上约 **4 倍实时**（1.8 秒生成 7 秒音频）。
`tests/mambo-engine.test.mjs` 会在这条链路真的可用时，用**插件自己的 provider 代码**
打真实引擎并检查音频不是静音——引擎没启动时自动跳过，所以不影响常规 `node --test`。

### 端到端自检（不改动正式 profile）

想在不碰正式实例的前提下验一遍"**真 AI 回复 → 曼波朗读**"，用一个一次性的 headless profile：

```powershell
cd F:\project\deepseek-harness
# 1) 建一个只装桌宠的临时 profile
node --import tsx/esm apps/cli/src/bin.ts plugin --profile headless add F:\project\dsh-plugin\whale-pet
# 2) 跑一次真任务，让它调用桌宠工具说话
node --import tsx/esm apps/cli/src/bin.ts --profile headless `
  --patch F:\project\dsh-plugin\whale-pet\.setup\mambo-scratch-patch.yml `
  '调用 pet_say 工具，说一句「你好，我是曼波」，然后用一句话回复我。'
# 3) 验完就卸掉，避免以后每次 headless 都自动拉起一个桌宠
node --import tsx/esm apps/cli/src/bin.ts plugin --profile headless remove dsh-whale-pet
```

成功的标志是宿主日志里出现这两行（`tts` 那一行是宿主真的打到引擎了）：

```
[whale-pet] tts POST http://127.0.0.1:9880/ -> 119084B audio/wav
[whale-pet] pet window event: tts (surprised)
```

临时 patch 里有两点是故意与正式配置不同的：桥接端口用 4599（避开正在运行的桌宠的 4571），
桌宠窗口带一个独立 `--user-data-dir`（否则会被正在运行的窗口的单实例锁直接掐掉）。

## 2. 插件侧配置

`voice.http` 直接对上引擎的接口（`POST http://127.0.0.1:9880/`）：

```yaml
- id: whale-pet
  config:
    voice:
      engine: http
      http:
        url: http://127.0.0.1:9880/
        method: POST
        headers:
          content-type: application/json
        # {{text}} 由插件做 JSON 转义后填入；其余字段是引擎要的参考音频与语种
        body: >-
          {"text":"{{text}}","text_language":"zh","speed":1.0,
           "cut_punc":"，。？！；：、…,.;?!",
           "refer_wav_path":"F:/project/MamboTTS/models/refer.wav",
           "prompt_text":"大家好，欢迎来到我的频道，今天给大家分享一个有趣的内容",
           "prompt_language":"zh"}
        format: wav
        timeoutMs: 60000
        cacheEntries: 64
```

要点：

- `refer_wav_path` 与 `prompt_text` **必须成对且一字不差**（文本对不上会静默劣化音色）。
- 引擎首次收到请求时会加载模型，所以 `timeoutMs` 给足（60s）；之后的请求通常 0.3–2s。
- 同样的文本会命中插件的内存缓存，重复回复不再往返。
- 引擎没启动时，窗口会提示"语音合成失败"并回报宿主日志，**不会卡死**。
- 改完 profile 的 patch 文件即热生效，**不用重启 DSH**：桌宠那一行会重新 apply，
  桥接与窗口自动重启。用 `GET /api/state?token=…` 看 `voice.engine` 就能确认切没切过去
  （token 在桌宠窗口的命令行里，`--url=http://127.0.0.1:<port>/pet/?token=…`）。

## 3. 播放（可选）

```powershell
# 用系统默认播放器试听
Start-Process F:\project\dsh-plugin\whale-pet\.setup\mambo-demo-finetuned.wav
```

## 4. 让引擎跟着开机可用（可选）

`start-engine.mjs` 是个常驻进程。想省事可以放进登录启动项，或者用计划任务在登录时
以隐藏窗口方式运行：

```powershell
schtasks /create /tn "MamboTTS Engine" /sc onlogon /rl highest ^
  /tr "node F:\project\dsh-plugin\whale-pet\scripts\mambotts\start-engine.mjs"
```

## 5. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `语音合成失败：HTTP 502` | 引擎没起来。跑 `start-engine.mjs --check`，再照它的输出补安装 |
| `语音合成失败：failed`（连不上） | 端口 9880 上没有引擎。注意本机若开着 Clash 之类的代理，**回环流量可能被劫持**，给它加 `127.0.0.1` 直连白名单 |
| 第一句很慢 | 引擎在加载模型（首次 10–30 秒，单句合成首字也要 1–6 秒），之后约 0.3–1 秒/句 |
| 音色不像曼波 | 看 `start-engine.mjs` 打印的模式；若是 `zero-shot`，说明 `models\` 里缺微调权重 |
| 想换回系统语音 | 把 `voice.engine` 改回 `browser` |

### 实测数字（RTX 3060）

| 模式 | 单句 2.7–7 秒音频的合成耗时 | 实时率 |
| --- | --- | --- |
| 零样本 (v2Pro) | 约 1.8 秒 / 7.1 秒音频 | 0.25 |
| 微调曼波 (v2) | 约 1.0 秒 / 2.7 秒音频（预热后） | 0.36 |
| 微调曼波（冷启动首句） | 约 6.4 秒 | 0.91 |

微调模式音色更饱满（同一句话的 RMS 0.148 对比零样本 0.121），代价是比 v2Pro 基座稍慢一点。

## 6. 桌面 GUI（可选）

MamboTTS 自带 PySide6 界面（`MamboTTS.bat`，需 `pip install PySide6`），能试听、调语速、看历史。
桌宠只要服务端，不需要它；两者可以同时存在——只要 9880 端口只被一个进程占着。
