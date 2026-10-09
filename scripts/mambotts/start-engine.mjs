/**
 * Start the local 曼波 speech engine (GPT-SoVITS) without its GUI.
 *
 * MamboTTS ships a PySide6 client that starts this engine for you, but a desktop
 * pet needs a background service, not a window. This launcher runs the engine
 * package's own bundled runtime directly, which is exactly what
 * `run_engine.py` does — minus the window and the hard requirement on the
 * fine-tuned weights:
 *
 *   fine-tuned   manbo_e8_s168.pth + manbo-e10.ckpt present → load them (best
 *                quality, the voice the project was built around);
 *   zero-shot    weights missing → load only the reference clip, which the
 *                engine clones from at request time. Same timbre family, no
 *                213 MB GitHub download in the way.
 *
 * The service is the standard GPT-SoVITS API on 127.0.0.1:9880:
 *   GET  /control  → JSON (health probe; anything else on the port is not us)
 *   POST /         → {"text", "text_language", "refer_wav_path", "prompt_text",
 *                     "prompt_language", "speed", "cut_punc"} → WAV bytes
 *
 * Usage:
 *   node scripts/mambotts/start-engine.mjs [--check] [--port=9880]
 *                                          [--root=F:\project\MamboTTS]
 *                                          [--zero-shot]
 */

import { existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).filter(arg => arg.startsWith('--')).map((arg) => {
    const eq = arg.indexOf('=')
    return eq === -1 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)]
  }),
)

/** MamboTTS checkout: engine package, reference clip, and the manbo weights. */
const ROOT = resolve(typeof args.root === 'string' ? args.root : 'F:\\project\\MamboTTS')
const ENGINE = join(ROOT, 'GPT-SoVITS')
const HOST = typeof args.host === 'string' ? args.host : '127.0.0.1'
const PORT = Number(args.port ?? 9880)

/** The voice this launcher exists for; names come from engine_contract.py. */
const VOICE = {
  sovits: join(ROOT, 'models', 'manbo_e8_s168.pth'),
  gpt: join(ROOT, 'models', 'manbo-e10.ckpt'),
  reference: join(ROOT, 'models', 'refer.wav'),
  // Must match models/refer.wav word for word, or cloning degrades silently.
  referenceText: '大家好，欢迎来到我的频道，今天给大家分享一个有趣的内容',
}

/**
 * The engine package's own v2Pro base models.
 *
 * Without an explicit `-s/-g` the engine falls back to its v1 defaults, which
 * clone noticeably worse. These are the models the package was built around, so
 * zero-shot uses them until the fine-tuned 曼波 weights show up.
 */
const PRETRAINED = {
  sovits: join(ENGINE, 'GPT_SoVITS', 'pretrained_models', 'v2Pro', 's2Gv2Pro.pth'),
  gpt: join(ENGINE, 'GPT_SoVITS', 'pretrained_models', 's1v3.ckpt'),
}

const paths = {
  python: join(ENGINE, 'runtime', 'python.exe'),
  api: join(ENGINE, 'api.py'),
}

/** Report every missing piece instead of failing one path at a time. */
const missing = Object.entries({
  '引擎目录 (engine package)': ENGINE,
  '内置 Python runtime': paths.python,
  '引擎入口 api.py': paths.api,
  '参考音频 refer.wav': VOICE.reference,
}).filter(([, path]) => !existsSync(path))

if (missing.length > 0) {
  for (const [label, path] of missing) console.error(`[engine] 缺少 ${label}: ${path}`)
  console.error('[engine] 先跑安装器：python install_cli.py general（在 MamboTTS 目录下）')
  process.exit(2)
}

const hasFineTuned = existsSync(VOICE.sovits) && existsSync(VOICE.gpt)
const hasPretrained = existsSync(PRETRAINED.sovits) && existsSync(PRETRAINED.gpt)
const fineTuned = hasFineTuned && args['zero-shot'] !== true
// Best available voice: the fine-tuned 曼波 weights, else the v2Pro base models.
const weights = fineTuned
  ? { sovits: VOICE.sovits, gpt: VOICE.gpt, mode: 'fine-tuned' }
  : (hasPretrained ? { ...PRETRAINED, mode: 'zero-shot (v2Pro)' } : { mode: 'zero-shot (engine defaults)' })

if (args.check === true) {
  console.log(JSON.stringify({
    engine: ENGINE,
    python: paths.python,
    api: paths.api,
    reference: VOICE.reference,
    referenceBytes: statSync(VOICE.reference).size,
    fineTunedWeights: hasFineTuned,
    pretrainedV2Pro: hasPretrained,
    mode: weights.mode,
    sovits: weights.sovits ?? null,
    gpt: weights.gpt ?? null,
  }, null, 2))
  process.exit(0)
}

/** Health probe: the engine answers JSON on /control, nothing else here does. */
async function probe(timeoutMs = 2000) {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/control`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.json()
    return true
  } catch {
    return false
  }
}

if (await probe(1500)) {
  console.log(`[engine] 已在运行：http://${HOST}:${PORT}`)
  process.exit(0)
}

const argv = [
  paths.api,
  '-a', HOST,
  '-p', String(PORT),
  '-dr', VOICE.reference,
  '-dt', VOICE.referenceText,
  '-dl', 'zh',
]
if (weights.sovits !== undefined) argv.push('-s', weights.sovits, '-g', weights.gpt)

console.log(`[engine] 模式：${weights.mode}`)
if (!fineTuned) {
  console.log('[engine] models/manbo_e8_s168.pth + manbo-e10.ckpt 到位后重启本脚本会自动切到微调曼波音色')
}
console.log(`[engine] 启动：${paths.python} api.py -a ${HOST} -p ${PORT}`)

const child = spawn(paths.python, argv, {
  cwd: ENGINE,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.on('data', chunk => process.stdout.write(`[engine] ${chunk}`))
child.stderr.on('data', chunk => process.stderr.write(`[engine] ${chunk}`))
child.on('exit', (code) => {
  console.error(`[engine] 引擎退出，代码 ${String(code)}`)
  process.exit(code ?? 1)
})

// Loading the models takes 10-30s on first start; report when it answers.
const deadline = Date.now() + 180000
let ready = false
while (Date.now() < deadline && !ready) {
  await new Promise(resolve => setTimeout(resolve, 2000))
  ready = await probe(3000)
  if (ready) {
    console.log(`[engine] READY http://${HOST}:${PORT} （${weights.mode}）`)
  }
}
if (!ready) {
  console.error('[engine] 180 秒内没有就绪，请检查上面的引擎输出')
  child.kill()
  process.exit(1)
}

// Keep the launcher alive as the service's supervisor.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill())
}
