/**
 * Install the fine-tuned 曼波 weights from the MamboTTS release package.
 *
 * The two files that make the voice *the* 曼波 voice — `manbo_e8_s168.pth` and
 * `manbo-e10.ckpt` — ship only inside the GitHub release zip, which is slow
 * enough from some networks that it is worth downloading once, separately, and
 * resuming. This finds them wherever the archive keeps them and puts them where
 * the engine launcher looks:
 *
 *   F:\project\MamboTTS\models\{manbo_e8_s168.pth,manbo-e10.ckpt}
 *
 * `start-engine.mjs` then picks them up automatically on its next start and
 * switches from zero-shot cloning to the fine-tuned model.
 *
 * Usage: node scripts/mambotts/install-weights.mjs [--zip=<path>] [--root=F:\project\MamboTTS]
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const args = Object.fromEntries(
  process.argv.slice(2).filter(arg => arg.startsWith('--')).map((arg) => {
    const eq = arg.indexOf('=')
    return eq === -1 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)]
  }),
)

const ROOT = resolve(typeof args.root === 'string' ? args.root : 'F:\\project\\MamboTTS')
const MODELS = join(ROOT, 'models')
const zip = typeof args.zip === 'string'
  ? resolve(args.zip)
  : resolve(import.meta.dirname, '..', '..', '.setup', 'downloads', 'MamboTTS-v1.2.1-full.zip')

/** The two files that constitute the fine-tuned voice. */
const WANTED = ['manbo_e8_s168.pth', 'manbo-e10.ckpt']

if (!existsSync(zip)) {
  console.error(`[weights] 没有找到发布包：${zip}`)
  console.error('[weights] 先运行：node scripts/mambotts/download-release.mjs')
  process.exit(2)
}
const sizeMb = statSync(zip).size / 1024 / 1024
console.log(`[weights] 发布包 ${zip} (${sizeMb.toFixed(1)} MB)`)
if (sizeMb < 200) {
  console.error('[weights] 文件明显不完整（发布包约 212.8 MB），等下载完成后再运行')
  process.exit(2)
}

/** Walk a directory tree and collect every file with one of the wanted names. */
function findFiles(directory, wanted) {
  const found = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (wanted.includes(entry.name)) found.set(entry.name, path)
    }
  }
  walk(directory)
  return found
}

const staging = join(tmpdir(), `mambotts-release-${Date.now()}`)
mkdirSync(staging, { recursive: true })
try {
  console.log('[weights] 解压发布包（只为了取出两个权重文件）…')
  // bsdtar ships with Windows 10+ and reads zip archives, so no dependency here.
  const extracted = spawnSync('tar', ['-xf', zip, '-C', staging], { stdio: 'inherit', shell: false })
  if (extracted.status !== 0) {
    console.error(`[weights] 解压失败（tar 退出码 ${String(extracted.status)}）`)
    process.exit(1)
  }

  const found = findFiles(staging, WANTED)
  const missing = WANTED.filter(name => !found.has(name))
  if (missing.length > 0) {
    console.error(`[weights] 发布包里没有找到：${missing.join(', ')}`)
    console.error('[weights] 可能是上游改了包结构，请手工确认后把权重放进 ' + MODELS)
    process.exit(1)
  }

  mkdirSync(MODELS, { recursive: true })
  for (const name of WANTED) {
    const target = join(MODELS, name)
    copyFileSync(found.get(name), target)
    console.log(`[weights] ${name} -> ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`)
  }
  console.log('[weights] 完成。重启引擎即可切到微调曼波音色：')
  console.log('  node scripts/mambotts/start-engine.mjs')
} finally {
  rmSync(staging, { recursive: true, force: true })
}
