# 语音能力

语音分两条独立的路：**说**（TTS，把回复念出来）与**听**（ASR，把你说的话变成一条用户消息）。两条都由桌宠窗口发起或执行，宿主只负责清洗文本、调度与离线兜底。

## TTS 一：窗口里的浏览器合成器

窗口在线时，朗读完全发生在渲染层 [`../pet/pet.js`](../pet/pet.js)：

- 触发点有三个：`reply`（模型结算的回复，念 `utterances` 用 `。` 连接后的文本）、`say`（`pet_say` 的原话）、`notify`（`pet_notify` 的正文）。
- `speak()` 先看两个闸门：`voice.enabled` 与窗口内的“静音朗读”开关（右键菜单 → `hush()` 清空队列并 `speechSynthesis.cancel()`）。任一关闭就整句丢掉。
- 环境里没有 `speechSynthesis` 时弹提示“此环境没有语音合成能力”，不抛错。
- 队列一次只念一条；`onstart` 把状态切成 `speaking`（状态药丸“说话中”），`onend` / `onerror` 恢复之前的状态再念下一条。

`SpeechSynthesisUtterance` 的取值来自 `/api/state` 下发的 `voice`：`lang`、`rate`、`pitch`、`volume` 直接用；`voice`（音色名）交给选音函数。

**选音顺序**（`pickVoice()`）：

1. 声音列表为空时先 `getVoices()`；Chromium 是异步填充的，所以页面同时监听 `voiceschanged` 事件刷新缓存。列表仍为空则返回 `null`，此时完全由 `utterance.lang` 决定（交给系统默认音色）。
2. 配置里 `voice.voice` 非空 → 取**第一个名字（大小写不敏感）包含该片段**的声音。
3. 否则按语言前缀匹配：把 `voice.lang` 取 `-` 前的部分（`zh-CN` → `zh`），找第一个语言标签以它开头的声音（先按 `_` 归一化后的标签比，再按原始标签比）。
4. 都不匹配 → `null`，回落系统默认。

也就是说 `rate` / `pitch` 只在浏览器合成器路径生效；SAPI 兜底只看 `rate` 与 `volume`（映射见下）。

## TTS 二：回复如何被清洗成可朗读文本

清洗发生在**宿主侧**（[`../src/speech.js`](../src/speech.js)，纯函数），窗口收到的已经是切好的句子数组。`toUtterances(markdown, maxChars)` = `cleanForSpeech` + `splitSentences`：

- 围栏代码块（``` / ~~~）整段丢弃，但连续多个代码块合并成一句「（代码块，略过）」，让听众知道有东西被跳过。
- 结构性噪声整行丢弃：表格行（`|…|`）、分隔线（`---` / `===`）、省略号行。
- 行首标记剥掉：`#` 标题、`>` 引用、`-`/`*`/`+` 列表、`- [x]` 任务框、`1.` / `1)` 编号。
- 链接 `[label](url)` 只留 label；裸 URL 直接删除（否则合成器会逐字符拼读）。
- 行内代码：不长于 24 字符的原样保留（两侧补空格），更长的替换成「（代码，略过）」。
- 强调符（`**`、`__`、`*`、`_`、`~~`）删除；emoji 与图形符号（多个 Unicode 区段）删除；连续 3 个以上相同标点压成一个；多空格与空行压缩。
- 分句：按 `。！？!?；;`（保留终止符）与换行切开，逐句累加到不超过 `voice.maxChars`；单句本身就超限时，退到最后一个 `，` / `、` / `,` / 空格处硬切（断点必须落在窗口后半段，否则按上限直接切）。切分不丢字符。
- 清洗后为空（例如整条回复只有代码）时 `speak: false`，窗口只显示气泡不出声。

## TTS 三：窗口离线时的系统语音

`pet_say` 在桥接没有连接时（`bridge.publish('say', …) === false`）退回 [`../src/win32/speak.ps1`](../src/win32/speak.ps1)：

- 必须跑在 **Windows PowerShell 5.1**（`System.Speech` 是 .NET Framework 程序集，PowerShell 7 加载不了），所以工具显式传 `executable: WINDOWS_POWERSHELL`。
- 选音：`voice` 配置的名字片段优先，其次 `lang` 前缀匹配已启用的语音，再不行取第一个；都没有就用系统默认。
- 语速：`Rate = clamp(round((rate - 1) * 8), -10, 10)`（System.Speech 的取值是 -10..10）。音量：`Volume = clamp(round(volume * 100), 0, 100)`。
- 返回 `{spoken: true, voice, engine: 'system-speech'}`；文本为空返回 `BAD_INPUT`，加载 `System.Speech` 失败返回 `SPEAK_FAILED`。
- `config.voice.enabled: false` 且窗口离线时 `pet_say` 直接抛错，不做兜底。

## ASR 一：优先 Web Speech API

点麦克风后 `startListening()` 的分支（[`../pet/pet.js`](../pet/pet.js)）：

- 已经在录音 → 再点一次表示结束。
- `asr.enabled: false` → 提示“语音输入已关闭”。
- `asr.engine !== 'sapi'` 且存在 `SpeechRecognition` / `webkitSpeechRecognition` → 走浏览器识别：`lang = asr.lang`、非连续、不要中间结果、只取一个候选；成功后把 transcript 当作 `source: 'voice'` 的用户消息发给宿主。
- 权限被拒（`not-allowed` / `service-not-allowed`）→ 自动改走录音路径；其它错误弹提示。
- `asr.engine: 'webspeech'` 且环境没有该 API → **不**回退，提示“这个窗口没有浏览器语音识别”。

## ASR 二：录音 → 16 kHz 单声道 PCM16 WAV → SAPI

默认（`engine: 'auto'` 且没有 Web Speech，Electron 里常见）走这条路：

1. `getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}})`，`MediaRecorder` 收集数据块；渲染层用快照下发的 `asr.maxSeconds` 作为自动停止时限（默认 20 秒）。
2. 停止后用 `AudioContext.decodeAudioData` 解码，再用 `OfflineAudioContext(1, frames, 16000)` 重采样成 16 kHz 单声道，手写 44 字节 WAV 头编成 PCM16（`encodeWav`）。
3. base64 后 `POST /api/asr {audioBase64, lang}`。
4. 宿主 [`../index.js`](../index.js) 的 `transcribe()` 检查：`asr.enabled`、音频非空、不超过 **8 MiB**；然后 `runHelper('asr', {audioBase64, lang}, {executable: WINDOWS_POWERSHELL, timeoutMs: max(helperTimeoutMs, asr.maxSeconds * 1000)})`。
5. [`../src/win32/asr.ps1`](../src/win32/asr.ps1) 把字节写成临时 WAV，用 `System.Speech.Recognition.SpeechRecognitionEngine`（先按 `lang` 前缀挑已安装识别器，否则用第一个）+ `DictationGrammar` 识别一次，返回 `{text, confidence, engine:'sapi', culture, heard}`；没听清时 `text: ''`、`heard: false`。临时文件在 `finally` 里删除。
6. 识别结果非空就作为 `source: 'voice'` 的用户消息进入当前目标会话；为空时窗口提示“没听清，再说一次？”。

## 真实限制

| 限制 | 说明 |
| --- | --- |
| SAPI 需要语言包 | 没有任何已安装识别器时返回 `NO_RECOGNIZER`（“no Windows speech recognizer is installed”）。要识别中文，得装对应语言的 Windows 语音识别语言包；装的是别的语言时，脚本会退用第一个识别器，结果基本不可用。 |
| 录音长度 | 窗口在 `asr.maxSeconds` 秒后自动停止（快照下发，钳制 3–120）；宿主侧超时是 `max(helperTimeoutMs, asr.maxSeconds * 1000)`，音频上限 8 MiB。 |
| 只识别一次 | SAPI 路径只调用一次 `Recognize()`，没有连续识别、没有中间结果；一句话说完再说下一句要重新点麦克风。 |
| 输入格式固定 | 助手把字节直接写进 `.wav` 再 `SetInputToWaveFile`，所以只接受 WAV；渲染层已经做了 16 kHz 单声道 PCM16 的归一化，第三方直接调 `/api/asr` 时必须自己保证这个格式。 |
| 离线可用性 | SAPI 路径完全离线。Web Speech 由浏览器/系统实现，Chrome 家族通常需要联网，但本仓库没有验证其具体行为，因此 `engine: 'auto'` 在浏览器窗口里可能表现为“能用但依赖网络”。 |
| 权限 | 麦克风被系统或用户拒绝时，录音路径提示“麦克风不可用：…”，Web Speech 路径提示“麦克风被拒绝，改用本地识别”后也会落到录音路径。 |

## 我该选哪条路

| 你的情况 | 建议 |
| --- | --- |
| 想让她用好的音色念回复 | 保持窗口在线：`voice.enabled: true`、`speakReplies: true`，再按名字指定 `voice`（如系统里某个中文女声），必要时用 `rate` / `pitch` 调口音。 |
| 窗口经常不在（无窗口模式、只用工具） | 接受 `pet_say` 的 SAPI 兜底：设置 `rate` / `volume`，别指望 `pitch` 与表情；长内容改用 `pet_notify`。 |
| 想要逐字流式朗读 | 当前不支持：回复只在 `assistant/message` 结算时整段下发后朗读。 |
| 用 Chrome/Edge 的 `--app` 窗口 | 有 Web Speech，`engine: 'auto'` 会优先用它；想强制本机识别就设 `engine: 'sapi'`。 |
| 用 Electron 窗口 | Electron 一般没有 Web Speech 识别，`auto` 会自动落到 SAPI；确保装了中文识别语言包。 |
| 只想打字、完全不要麦克风 | `asr.enabled: false`。 |
| 只想看气泡、不想出声 | `voice.enabled: false`（或窗口右键“静音朗读”只静当前窗口）。 |
