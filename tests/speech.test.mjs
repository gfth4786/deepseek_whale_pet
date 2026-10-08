/**
 * Speech preparation: what the pet is willing to say out loud.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanForSpeech, splitSentences, textOfContent, toUtterances } from '../src/speech.js'

test('fenced code is dropped and announced once', () => {
  const text = cleanForSpeech([
    '先看这段代码：',
    '```js',
    'const a = 1',
    '```',
    '然后再继续。',
  ].join('\n'))
  assert.ok(text.includes('先看这段代码'))
  assert.ok(text.includes('然后再继续'))
  assert.ok(text.includes('代码块'))
  assert.ok(!text.includes('const a = 1'))
})

test('links keep their label, urls and emoji disappear', () => {
  const text = cleanForSpeech('见 [文档](https://example.com/a/b) 和 https://example.com 还有 🐳 表情。')
  assert.ok(text.includes('文档'))
  assert.ok(!text.includes('http'))
  assert.ok(!text.includes('🐳'))
})

test('short inline code is kept, long inline code is summarised', () => {
  assert.ok(cleanForSpeech('运行 `npm test` 即可。').includes('npm test'))
  assert.ok(cleanForSpeech(`看 \`${'x'.repeat(60)}\` 这段`).includes('略过'))
})

test('structural noise is removed', () => {
  const text = cleanForSpeech([
    '# 标题',
    '',
    '| a | b |',
    '| - | - |',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '---',
    '',
    '正文。',
  ].join('\n'))
  assert.ok(text.includes('标题'))
  assert.ok(text.includes('第一项'))
  assert.ok(text.includes('正文'))
  assert.ok(!text.includes('|'))
  assert.ok(!text.includes('---'))
})

test('empty and non-string input yields nothing to say', () => {
  assert.equal(cleanForSpeech(''), '')
  assert.equal(cleanForSpeech(undefined), '')
  assert.equal(cleanForSpeech('   \n  '), '')
})

test('sentences split at terminators and respect the limit', () => {
  const chunks = splitSentences('第一句。第二句！第三句？', 4)
  assert.deepEqual(chunks, ['第一句。', '第二句！', '第三句？'])
  assert.ok(chunks.every(chunk => chunk.length <= 4))
})

test('a short paragraph stays one utterance', () => {
  assert.deepEqual(splitSentences('你好呀，今天过得怎么样？', 240), ['你好呀，今天过得怎么样？'])
})

test('an over-long sentence is cut at a natural break', () => {
  const long = `${'呀'.repeat(30)}，${'嘿'.repeat(30)}，${'哈'.repeat(30)}`
  const chunks = splitSentences(long, 40)
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every(chunk => chunk.length <= 40))
  assert.equal(chunks.join('').replace(/[\s，]/gu, '').length, long.replace(/[，]/gu, '').length)
})

test('toUtterances runs cleaning and splitting together', () => {
  const chunks = toUtterances('**你好**！\n\n```\ncode\n```\n结束。', 240)
  assert.equal(chunks.length >= 1, true)
  assert.ok(chunks.join('').includes('你好'))
  assert.ok(!chunks.join('').includes('code'))
})

test('textOfContent reads text blocks and ignores the rest', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOfContent(undefined), '')
  assert.equal(textOfContent([{ type: 'text', text: 5 }]), '')
})
