/**
 * Download the MamboTTS release package (client + the fine-tuned 曼波 weights).
 *
 * The release zip is the only place the two fine-tuned model files live
 * (`manbo_e8_s168.pth`, `manbo-e10.ckpt`); everything else the voice needs is
 * either in the repository (`models/refer.wav`, `engine_contract.py`) or in the
 * GPT-SoVITS engine package the installer fetches separately.
 *
 * Resumable on purpose: 213 MB over a corporate link can be interrupted, and
 * re-downloading from zero each time is what makes setups like this painful.
 *
 * Usage: node scripts/mambotts/download-release.mjs [--dest=<dir>]
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RELEASE_URL = 'https://github.com/Tsukimisaka/MamboTTS/releases/download/v1.2.1/MamboTTS-v1.2.1-full.zip'
const args = Object.fromEntries(
  process.argv.slice(2).filter(arg => arg.startsWith('--')).map((arg) => {
    const eq = arg.indexOf('=')
    return eq === -1 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)]
  }),
)
const destDir = typeof args.dest === 'string' ? args.dest : join(ROOT, '.setup', 'downloads')
const target = join(destDir, RELEASE_URL.split('/').pop())

mkdirSync(destDir, { recursive: true })
const already = existsSync(target) ? statSync(target).size : 0
const headers = { 'user-agent': 'dsh-whale-pet-setup' }
if (already > 0) headers.range = `bytes=${already}-`

console.log(`[release] ${already > 0 ? `resuming at ${(already / 1024 / 1024).toFixed(1)} MB` : 'starting'} -> ${target}`)
const response = await fetch(RELEASE_URL, { headers, redirect: 'follow' })
if (!response.ok && response.status !== 206) {
  console.error(`[release] HTTP ${response.status}`)
  process.exit(1)
}
if (already > 0 && response.status !== 206) {
  console.log('[release] server ignored the range request; restarting from zero')
  rmSync(target, { force: true })
}
const total = Number(response.headers.get('content-length') ?? 0) + (response.status === 206 ? already : 0)
const out = createWriteStream(target, { flags: response.status === 206 ? 'a' : 'w' })
let written = response.status === 206 ? already : 0
let lastReport = 0
const source = Readable.fromWeb(response.body)
source.on('data', (chunk) => {
  written += chunk.length
  const now = Date.now()
  if (now - lastReport > 2000) {
    lastReport = now
    const percent = total === 0 ? '?' : `${((written / total) * 100).toFixed(1)}%`
    console.log(`[release] ${(written / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB (${percent})`)
  }
})
await pipeline(source, out)
console.log(`[release] done: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`)

// Verify the outer size when GitHub told us the expected total.
if (total > 0 && statSync(target).size !== total) {
  console.error(`[release] size mismatch: ${statSync(target).size} != ${total}`)
  process.exit(1)
}
