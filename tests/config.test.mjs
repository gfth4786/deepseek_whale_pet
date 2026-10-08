/**
 * Configuration resolution: defaults, per-section merges, loud validation, and
 * the environment overrides a deployment can use.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

test('an empty config yields the frozen defaults', () => {
  const config = resolveConfig(undefined, {})
  assert.equal(config.port, DEFAULT_CONFIG.port)
  assert.equal(config.window.corner, 'bottom-right')
  assert.equal(config.voice.lang, 'zh-CN')
  assert.equal(config.tools.input, true)
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.window))
  assert.ok(Object.isFrozen(config.launcherArgs))
})

test('scalar and nested values merge over the defaults', () => {
  const config = resolveConfig({ port: 5000, voice: { rate: 1.5 }, window: { corner: 'top-left' } }, {})
  assert.equal(config.port, 5000)
  assert.equal(config.voice.rate, 1.5)
  // Keys the caller omitted keep their defaults.
  assert.equal(config.voice.pitch, DEFAULT_CONFIG.voice.pitch)
  assert.equal(config.window.corner, 'top-left')
  assert.equal(config.window.width, DEFAULT_CONFIG.window.width)
})

test('unknown keys and mistyped values fail loudly', () => {
  assert.throws(() => resolveConfig({ nope: 1 }, {}), ConfigError)
  assert.throws(() => resolveConfig({ port: 'abc' }, {}), ConfigError)
  assert.throws(() => resolveConfig({ voice: { rate: 'fast' } }, {}), ConfigError)
  assert.throws(() => resolveConfig({ voice: { nope: true } }, {}), ConfigError)
  assert.throws(() => resolveConfig({ window: 3 }, {}), ConfigError)
  assert.throws(() => resolveConfig('port', {}), ConfigError)
})

test('out-of-range numbers are clamped rather than rejected', () => {
  const config = resolveConfig({
    window: { width: 10, height: 99999, opacity: 3 },
    voice: { rate: 99, pitch: -4, volume: 9, maxChars: 1 },
    helperTimeoutMs: 1,
  }, {})
  assert.equal(config.window.width, 160)
  assert.equal(config.window.height, 1200)
  assert.equal(config.window.opacity, 1)
  assert.equal(config.voice.rate, 2)
  assert.equal(config.voice.pitch, 0.5)
  assert.equal(config.voice.volume, 1)
  assert.equal(config.voice.maxChars, 40)
  assert.equal(config.helperTimeoutMs, 1000)
})

test('the bridge may only bind a loopback address', () => {
  assert.throws(() => resolveConfig({ host: '0.0.0.0' }, {}), ConfigError)
  assert.equal(resolveConfig({ host: 'localhost' }, {}).host, 'localhost')
})

test('a pinned session requires an id', () => {
  assert.throws(() => resolveConfig({ session: { mode: 'pinned' } }, {}), ConfigError)
  const config = resolveConfig({ session: { mode: 'pinned', id: 'session-1' } }, {})
  assert.equal(config.session.id, 'session-1')
})

test('environment overrides apply only when the row is silent', () => {
  assert.equal(resolveConfig(undefined, { DSH_WHALE_PET_PORT: '6000' }).port, 6000)
  assert.equal(resolveConfig({ port: 1234 }, { DSH_WHALE_PET_PORT: '6000' }).port, 1234)
  assert.throws(() => resolveConfig(undefined, { DSH_WHALE_PET_PORT: 'nope' }), ConfigError)
  assert.equal(resolveConfig(undefined, { DSH_WHALE_PET_DISABLE: '1' }).enabled, false)
  assert.equal(resolveConfig(undefined, { DSH_WHALE_PET_AUTOLAUNCH: '0' }).autoLaunch, false)
})

test('launcher arguments must be strings', () => {
  assert.throws(() => resolveConfig({ launcherArgs: [1] }, {}), ConfigError)
  assert.deepEqual(resolveConfig({ launcherArgs: ['--flag'] }, {}).launcherArgs, ['--flag'])
})
