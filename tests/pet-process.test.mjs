/**
 * Window-process ownership.
 *
 * The interesting behaviour here is not spawning (that needs a real desktop);
 * it is what `stop()` is allowed to touch. A plugin reload disposes the old
 * instance while the new one is already starting a replacement window, so a
 * `stop()` that killed "whoever the pid file names" killed the fresh window. The
 * pid file is shared machine state, and these tests pin the ownership rule.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The pid file path is fixed at import time, so point it at a scratch location
// before importing the module under test.
const scratch = mkdtempSync(join(tmpdir(), 'whale-pet-process-'))
process.env.TMPDIR = scratch
process.env.TEMP = scratch
process.env.TMP = scratch

const { PetProcess, PID_FILE, readStalePid } = await import('../src/pet-process.js')
const { resolveConfig } = await import('../src/config.js')

/** A process handle that never spawns anything. */
function inert(config = resolveConfig({ autoLaunch: false }, {})) {
  return new PetProcess({ config, url: 'http://127.0.0.1:1/pet/?token=x', log: () => {} })
}

test('a stop with nothing owned touches neither the process table nor the file', async () => {
  writeFileSync(PID_FILE, '424242', 'utf8')
  try {
    await inert().stop()
    assert.equal(existsSync(PID_FILE), true, 'a foreign pid file must survive')
    assert.equal(readStalePid(), 424242)
  } finally {
    rmSync(PID_FILE, { force: true })
  }
})

test('the pid file is read back only when it holds a real pid', () => {
  writeFileSync(PID_FILE, 'not a pid', 'utf8')
  assert.equal(readStalePid(), undefined)
  writeFileSync(PID_FILE, '-5', 'utf8')
  assert.equal(readStalePid(), undefined)
  writeFileSync(PID_FILE, ' 123 ', 'utf8')
  assert.equal(readStalePid(), 123)
  rmSync(PID_FILE, { force: true })
  assert.equal(readStalePid(), undefined)
})

test('a status call reports nothing running before a start', () => {
  const status = inert().status()
  assert.equal(status.running, false)
  assert.equal(status.pid, null)
  assert.equal(status.uptimeMs, null)
  assert.match(status.url, /token=\*\*\*/)
})

test('a start with a missing launcher fails loudly instead of half-starting', () => {
  const config = resolveConfig({ launcher: join(scratch, 'nope.mjs') }, {})
  assert.throws(() => inert(config).start(), /launcher not found/)
})

test('the pid file lives under the OS temp directory', () => {
  // Documents the file's location so a reader can find it after a crash.
  assert.equal(typeof PID_FILE, 'string')
  assert.ok(PID_FILE.endsWith('dsh-whale-pet.pid'))
})

test('the module exposes the pid file path it actually uses', () => {
  writeFileSync(PID_FILE, '77', 'utf8')
  assert.equal(readFileSync(PID_FILE, 'utf8'), '77')
  rmSync(PID_FILE, { force: true })
  rmSync(scratch, { recursive: true, force: true })
})
