/**
 * The sidebar catalogue loader: parsing the documented YAML subset, validating
 * entries, and falling back to defaults when the file is missing or malformed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePetConfig, loadPetConfig } from '../src/pet-config.js'

test('a well-formed config parses actions and voices', () => {
  const parsed = parsePetConfig([
    'actions:',
    '  - id: eat_token',
    '    name: 吃 token',
    '    folder: assets/whale/eat_token',
    '  - id: idle',
    '    name: 发呆',
    '    folder: assets/whale/idle',
    'voices:',
    '  - id: mambo',
    '    name: 曼波',
    '    voice: 曼波',
    '    lang: zh-CN',
  ].join('\n'))
  assert.deepEqual(parsed.actions, [
    { id: 'eat_token', name: '吃 token', folder: 'assets/whale/eat_token' },
    { id: 'idle', name: '发呆', folder: 'assets/whale/idle' },
  ])
  assert.deepEqual(parsed.voices, [
    { id: 'mambo', name: '曼波', kind: 'tts', voice: '曼波', lang: 'zh-CN', file: '' },
  ])
})

test('an effect voice keeps its clip and defaults to tts otherwise', () => {
  const parsed = parsePetConfig([
    'actions:',
    '  - id: idle',
    '    name: 发呆',
    '    folder: assets/whale/idle',
    'voices:',
    '  - id: mambo',
    '    name: 曼波',
    '    kind: effect',
    '    file: assets/audio/manbo.mp3',
    '  - id: huihui',
    '    name: 慧慧',
    '    voice: Huihui',
  ].join('\n'))
  assert.deepEqual(parsed.voices, [
    { id: 'mambo', name: '曼波', kind: 'effect', voice: '', lang: 'zh-CN', file: 'assets/audio/manbo.mp3' },
    { id: 'huihui', name: '慧慧', kind: 'tts', voice: 'Huihui', lang: 'zh-CN', file: '' },
  ])
})

test('an effect voice without a clip is dropped, not silently muted', () => {
  const parsed = parsePetConfig([
    'actions:',
    '  - id: idle',
    '    name: 发呆',
    '    folder: assets/whale/idle',
    'voices:',
    '  - id: broken',
    '    name: 缺文件',
    '    kind: effect',
    '  - id: ok',
    '    name: 正常音效',
    '    kind: effect',
    '    file: assets/audio/ok.wav',
  ].join('\n'))
  assert.deepEqual(parsed.voices.map(entry => entry.id), ['ok'])
})

test('comments and quoted values are handled', () => {
  const parsed = parsePetConfig([
    '# 注释行',
    'actions:',
    '  - id: happy',
    '    name: "开心"',
    '    folder: \'assets/whale/happy\'',
  ].join('\n'))
  assert.equal(parsed.actions[0].name, '开心')
  assert.equal(parsed.actions[0].folder, 'assets/whale/happy')
})

test('a missing voices section yields an empty list', () => {
  const parsed = parsePetConfig('actions:\n  - id: idle\n    name: 发呆\n    folder: assets/whale/idle\n')
  assert.deepEqual(parsed.voices, [])
})

test('entries missing required fields are dropped', () => {
  const parsed = parsePetConfig([
    'actions:',
    '  - id: idle',
    '    name: 发呆',
    '    folder: assets/whale/idle',
    '  - id: broken',
    '    name: 缺目录', // no folder → dropped
  ].join('\n'))
  assert.equal(parsed.actions.length, 1)
  assert.equal(parsed.actions[0].id, 'idle')
})

test('no usable action throws', () => {
  assert.throws(() => parsePetConfig('actions:\n  - id: broken\n'), /没有可用的动作/)
})

test('a missing file falls back to the built-in defaults', async () => {
  const warnings = []
  const result = await loadPetConfig(message => warnings.push(message), join(tmpdir(), 'no-such-config.yml'))
  assert.equal(result.actions.length, 6)
  assert.deepEqual(result.voices, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /未找到或不可读/)
})

test('a malformed file falls back to the built-in defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-pet-config-'))
  const file = join(dir, 'config.yml')
  await writeFile(file, 'not:\n  - valid: yaml\n  - items without a section', 'utf8')
  const warnings = []
  const result = await loadPetConfig(message => warnings.push(message), file)
  assert.equal(result.actions.length, 6)
  assert.deepEqual(result.voices, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /解析失败/)
})

test('the shipped config.yml parses into the six actions plus the 曼波 voice', async () => {
  const result = await loadPetConfig()
  assert.deepEqual(result.actions.map(action => action.id), [
    'eat_token', 'working', 'idle', 'happy', 'sleepy', 'surprised',
  ])
  assert.equal(result.actions[0].name, '吃 token')
  assert.ok(result.voices.length >= 1)
  assert.equal(result.voices[0].name, '曼波')
  // 曼波 ships as a named voice, not as a fixed clip: the timbre comes from
  // `voice.engine` (the window's synthesizer, or an HTTP voice model). An
  // `effect` entry would need a local audio file that this repository has none of.
  assert.equal(result.voices[0].kind, 'tts')
  assert.equal(result.voices[0].voice, '曼波')
})
