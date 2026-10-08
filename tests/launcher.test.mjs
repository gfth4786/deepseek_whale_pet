/**
 * The window launcher: argument parsing, geometry handoff, and shell discovery.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBrowser, parseArgs, resolveElectron, windowSpec } from '../scripts/launch-pet.mjs'

test('parses --key=value, --key value, and bare flags', () => {
  assert.deepEqual(parseArgs(['--url=http://x/pet/', '--selftest']), {
    url: 'http://x/pet/',
    selftest: true,
  })
  assert.deepEqual(parseArgs(['--url', 'http://x/pet/', '--shot', 'a.png']), {
    url: 'http://x/pet/',
    shot: 'a.png',
  })
  assert.deepEqual(parseArgs(['--hidden', '--no-topmost']), { hidden: true, 'no-topmost': true })
  assert.deepEqual(parseArgs(['positional', '--flag']), { flag: true })
})

test('the window spec falls back to the documented defaults', () => {
  const spec = windowSpec({})
  assert.equal(spec.width, 320)
  assert.equal(spec.height, 420)
  assert.equal(spec.corner, 'bottom-right')
  assert.equal(spec.alwaysOnTop, true)
})

test('the window spec comes from the plugin environment', () => {
  const spec = windowSpec({ DSH_WHALE_PET_WINDOW: JSON.stringify({ width: 400, corner: 'top-left' }) })
  assert.equal(spec.width, 400)
  assert.equal(spec.corner, 'top-left')
  // Keys the plugin omitted keep their defaults.
  assert.equal(spec.height, 420)
})

test('a malformed window spec never breaks the launch', () => {
  const spec = windowSpec({ DSH_WHALE_PET_WINDOW: '{not json' })
  assert.equal(spec.width, 320)
})

test('electron is resolved from an installed dist directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'whale-launch-'))
  assert.equal(resolveElectron(base), undefined)
  const dist = join(base, 'node_modules', 'electron', 'dist')
  mkdirSync(dist, { recursive: true })
  const exe = join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron')
  writeFileSync(exe, '')
  assert.equal(resolveElectron(base), exe)
})

test('the electron path can be overridden from the environment', () => {
  const base = mkdtempSync(join(tmpdir(), 'whale-launch-'))
  const exe = join(base, 'custom-electron.exe')
  writeFileSync(exe, '')
  const previous = process.env.DSH_WHALE_PET_ELECTRON
  process.env.DSH_WHALE_PET_ELECTRON = exe
  try {
    assert.equal(resolveElectron(base), exe)
  } finally {
    if (previous === undefined) delete process.env.DSH_WHALE_PET_ELECTRON
    else process.env.DSH_WHALE_PET_ELECTRON = previous
  }
})

test('browser discovery only ever names a file that exists', () => {
  const browser = findBrowser()
  if (browser !== undefined) assert.ok(existsSync(browser))
})
