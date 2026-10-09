/**
 * Session mirroring: which events become speech, which become expressions, and
 * how a line from the pet reaches an agent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionWatcher, toolLabel } from '../src/session-watch.js'
import { resolveConfig } from '../src/config.js'

/** A stand-in for the parts of the Cordis context this module touches. */
function fakeContext(agents = []) {
  const listeners = []
  const registry = new Map(agents.map(agent => [agent.id, agent]))
  return {
    agents: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
    },
    on: (name, handler) => {
      listeners.push({ name, handler })
      return () => {}
    },
    emit: (name, ...args) => {
      for (const listener of listeners) {
        if (listener.name === name) listener.handler(...args)
      }
    },
    registered: () => listeners.length,
  }
}

/** A stand-in agent recording what the pet sends it. */
function fakeAgent(id) {
  return { id, received: [], followup(message) { this.received.push(message) } }
}

/** A bridge stand-in that records every published event. */
function fakeBridge() {
  const events = []
  return {
    events,
    publish: (type, payload) => {
      events.push({ type, ...payload })
      return true
    },
  }
}

/** Build a watcher over the fake context. */
function harness({ agents = [], config = resolveConfig(undefined, {}) } = {}) {
  const ctx = fakeContext(agents)
  const bridge = fakeBridge()
  const watcher = new SessionWatcher({ ctx, config, bridge, log: () => {} })
  watcher.attach()
  return { ctx, bridge, watcher, agents }
}

test('the watcher subscribes exactly once', () => {
  const { ctx } = harness()
  assert.equal(ctx.registered(), 1)
})

test('a settled assistant reply becomes speech', () => {
  const agent = fakeAgent('session-1')
  const { ctx, bridge } = harness({ agents: [agent] })
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好呀，我是鲸鱼娘。' }] } },
  })
  const reply = bridge.events.find(event => event.type === 'reply')
  assert.ok(reply !== undefined)
  assert.equal(reply.text, '你好呀，我是鲸鱼娘。')
  assert.deepEqual(reply.utterances, ['你好呀，我是鲸鱼娘。'])
  assert.equal(reply.speak, true)
})

test('events from a session without an agent are ignored', () => {
  const { ctx, bridge } = harness({ agents: [fakeAgent('session-1')] })
  ctx.emit('session/event', { id: 'gone' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '不该被念出来' }] } },
  })
  assert.equal(bridge.events.length, 0)
})

test('code-only replies are not spoken', () => {
  const agent = fakeAgent('session-1')
  const { ctx, bridge } = harness({ agents: [agent] })
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '```js\nconst a = 1\n```' }] } },
  })
  const reply = bridge.events.find(event => event.type === 'reply')
  // The prose around the fence may still be announced, but the code never is.
  assert.ok(reply === undefined || !reply.utterances.join('').includes('const a = 1'))
})

test('voice disabled suppresses replies', () => {
  const agent = fakeAgent('session-1')
  const config = resolveConfig({ voice: { enabled: false } }, {})
  const { ctx, bridge } = harness({ agents: [agent], config })
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '安静' }] } },
  })
  assert.equal(bridge.events.length, 0)
})

test('turn and tool events drive the pet state', () => {
  const agent = fakeAgent('session-1')
  const { ctx, bridge } = harness({ agents: [agent] })
  ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'session-1' }, { type: 'tool/call', data: { callId: 'c1', name: 'pwsh' } })
  ctx.emit('session/event', { id: 'session-1' }, { type: 'tool/result', data: { message: { callId: 'c1', isError: false } } })
  ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } })
  assert.deepEqual(bridge.events.map(event => event.type), ['status', 'tool', 'tool', 'status'])
  assert.equal(bridge.events[1].label, 'pwsh')
  assert.equal(bridge.events[2].name, 'pwsh')
  assert.equal(bridge.events[2].isError, false)
  assert.equal(bridge.events[0].state, 'thinking')
  assert.equal(bridge.events[3].state, 'idle')
})

test('a thrown listener never breaks event handling', () => {
  const agent = fakeAgent('session-1')
  const { ctx } = harness({ agents: [agent] })
  // A malformed event must be contained by the watcher's own guard.
  ctx.emit('session/event', { id: 'session-1' }, { type: 'tool/call', data: undefined })
})

test('the pet talks to the most recently active session', () => {
  const first = fakeAgent('session-1')
  const second = fakeAgent('session-2')
  const { ctx, watcher } = harness({ agents: [first, second] })
  ctx.emit('session/event', { id: 'session-2' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(watcher.targetAgent(), second)
  const receipt = watcher.sendUserText('帮我把音量调小一点', 'voice')
  assert.equal(receipt.sessionId, 'session-2')
  assert.equal(second.received.length, 1)
  const message = second.received[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: '帮我把音量调小一点' }])
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(typeof message.id, 'string')
})

test('without any prior event the first live agent is adopted', () => {
  const agent = fakeAgent('session-1')
  const { watcher } = harness({ agents: [agent] })
  assert.equal(watcher.targetAgent(), agent)
})

test('pinned and disabled session modes', () => {
  const first = fakeAgent('session-1')
  const second = fakeAgent('session-2')
  const pinned = harness({
    agents: [first, second],
    config: resolveConfig({ session: { mode: 'pinned', id: 'session-2' } }, {}),
  })
  assert.equal(pinned.watcher.targetAgent(), second)
  const disabled = harness({ agents: [first], config: resolveConfig({ session: { mode: 'none' } }, {}) })
  assert.equal(disabled.watcher.targetAgent(), undefined)
  assert.throws(() => disabled.watcher.sendUserText('在吗'), /no active DSH session/)
})

test('an empty line is refused and no message is appended', () => {
  const agent = fakeAgent('session-1')
  const { watcher } = harness({ agents: [agent] })
  assert.throws(() => watcher.sendUserText('   '), /empty/)
  assert.equal(agent.received.length, 0)
})

test('the snapshot describes the session and the voice settings', () => {
  const agent = fakeAgent('session-1')
  const { ctx, watcher } = harness({ agents: [agent] })
  ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
  const snapshot = watcher.snapshot()
  assert.equal(snapshot.sessionId, 'session-1')
  assert.equal(snapshot.running, true)
  assert.equal(snapshot.voice.lang, 'zh-CN')
  assert.equal(typeof snapshot.now, 'string')
})

test('the snapshot carries everything the window needs to pick a voice', () => {
  // The window cannot read the plugin config; these four fields are the whole
  // contract behind `voice.engine: http` and `voice.effectFile`.
  const config = resolveConfig({
    voice: {
      engine: 'http',
      effectFile: 'assets/audio/x.wav',
      maxChars: 120,
      http: { url: 'http://127.0.0.1:9880/' },
    },
  }, {})
  const voice = harness({ config }).watcher.snapshot().voice
  assert.equal(voice.engine, 'http')
  assert.equal(voice.effectFile, 'assets/audio/x.wav')
  assert.equal(voice.maxChars, 120)
  assert.equal(voice.enabled, true)
  // Defaults stay put when the deployment configures nothing.
  const plain = harness({}).watcher.snapshot().voice
  assert.equal(plain.engine, 'browser')
  assert.equal(plain.effectFile, '')
  assert.equal(typeof plain.maxChars, 'number')
})

test('tool labels are bounded', () => {
  assert.equal(toolLabel('pwsh'), 'pwsh')
  assert.equal(toolLabel('').length, 4)
  assert.ok(toolLabel('x'.repeat(120)).length <= 41)
})
