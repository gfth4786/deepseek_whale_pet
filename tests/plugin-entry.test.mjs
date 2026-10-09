/**
 * Plugin entry: what one `apply()` call registers, and that every tool
 * definition stays inside the harness's enforced JSON-Schema subset.
 *
 * The subset check mirrors `packages/core/tools/src/json-schema.ts`
 * (`type/oneOf/properties/required/additionalProperties/items/enum/const` plus
 * annotations). A stray `minimum` or `format` would make the real
 * `ctx.tools.register()` throw during activation, so it is caught here instead.
 *
 * Every test that activates the plugin disposes it in a `finally`: a failing
 * assertion must not leave the bridge listening, which would keep the test
 * process alive forever.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

/** Keywords the harness accepts, besides plain annotations. */
const ALLOWED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title',
])

/** A stand-in for the Cordis context the plugin entry touches. */
function fakeContext(agents = []) {
  const definitions = []
  const disposers = []
  return {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    agents: {
      get: id => agents.find(agent => agent.id === id),
      list: () => agents,
    },
    on: () => () => {},
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
    definitions,
    disposers,
  }
}

/**
 * Walk one schema and report every unsupported keyword.
 *
 * `properties` maps a name to a schema and `items` holds one, so both are
 * descended into as containers rather than inspected as schemas themselves.
 * @param schema - the schema node to check.
 * @param path - diagnostic path of this node.
 * @param found - accumulator.
 * @returns the collected violations.
 */
function unsupportedKeys(schema, path = 'schema', found = []) {
  if (schema === null || typeof schema !== 'object') return found
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => unsupportedKeys(entry, `${path}[${index}]`, found))
    return found
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') {
      if (value === null || typeof value !== 'object') {
        found.push(`${path}.properties is not an object`)
        continue
      }
      for (const [property, node] of Object.entries(value)) {
        unsupportedKeys(node, `${path}.properties.${property}`, found)
      }
      continue
    }
    if (key === 'items') {
      unsupportedKeys(value, `${path}.items`, found)
      continue
    }
    if (key === 'oneOf') {
      unsupportedKeys(value, `${path}.oneOf`, found)
      continue
    }
    if (!ALLOWED_KEYS.has(key)) found.push(`${path}.${key}`)
    if (key === 'type' && Array.isArray(value)) found.push(`${path}.type is a type array`)
  }
  return found
}

/** Activate the plugin, run the body, and always dispose it afterwards. */
async function withPlugin(config, body) {
  const ctx = fakeContext(config.agents)
  await apply(ctx, config.options)
  try {
    return await body(ctx)
  } finally {
    for (const dispose of ctx.disposers) await dispose()
  }
}

test('the plugin declares its identity and its service dependencies', () => {
  assert.equal(name, 'whale-pet')
  assert.deepEqual(inject, ['tools', 'agents'])
})

test('apply registers the whole tool set', async () => {
  await withPlugin({ options: { autoLaunch: false, port: 0 } }, async (ctx) => {
    const names = ctx.definitions.map(definition => definition.name).sort()
    assert.deepEqual(names, [
      'pet_input', 'pet_look', 'pet_media', 'pet_mood', 'pet_notify', 'pet_say', 'pet_window',
    ])
    assert.equal(ctx.disposers.length, 1, 'one teardown effect')
  })
})

test('every tool definition stays inside the enforced schema subset', async () => {
  await withPlugin({ options: { autoLaunch: false, port: 0 } }, async (ctx) => {
    for (const definition of ctx.definitions) {
      const label = definition.name
      assert.ok(definition.description.length > 0, `${label} has a description`)
      assert.equal(typeof definition.execute, 'function', `${label} has an execute`)
      assert.equal(definition.parameters.type, 'object', `${label} takes an object`)
      assert.equal(typeof definition.output, 'object', `${label} declares output`)
      assert.equal(typeof definition.output.render, 'function', `${label} renders output`)
      assert.equal(definition.output.schema.type, 'object', `${label} returns an object`)
      assert.deepEqual(unsupportedKeys(definition.parameters, `${label}.parameters`), [])
      assert.deepEqual(unsupportedKeys(definition.output.schema, `${label}.output.schema`), [])
    }
  })
})

test('the schema walker itself flags keywords the harness rejects', () => {
  assert.deepEqual(unsupportedKeys({ type: 'string' }), [])
  assert.deepEqual(unsupportedKeys({ type: 'object', properties: { a: { type: 'string' } } }), [])
  assert.deepEqual(
    unsupportedKeys({ type: 'number', minimum: 1 }),
    ['schema.minimum'],
  )
  assert.deepEqual(
    unsupportedKeys({ type: 'object', properties: { a: { type: 'string', format: 'date' } } }),
    ['schema.properties.a.format'],
  )
  assert.deepEqual(unsupportedKeys({ type: ['string', 'null'] }), ['schema.type is a type array'])
})

test('the teardown effect really stops the bridge', async () => {
  const ctx = fakeContext()
  await apply(ctx, { autoLaunch: false, port: 0 })
  assert.equal(ctx.disposers.length, 1)
  await ctx.disposers[0]()
  // A second dispose is a no-op rather than a crash.
  await ctx.disposers[0]()
})

test('tool classes can be switched off from config', async () => {
  await withPlugin({
    options: {
      autoLaunch: false,
      port: 0,
      tools: { media: false, input: false, notify: false, look: false, control: false, say: false },
    },
  }, async (ctx) => {
    assert.deepEqual(ctx.definitions, [])
  })
})

test('a disabled plugin registers nothing and starts nothing', async () => {
  const ctx = fakeContext()
  await apply(ctx, { enabled: false })
  assert.deepEqual(ctx.definitions, [])
  assert.equal(ctx.disposers.length, 0)
})

test('invalid configuration fails activation loudly', async () => {
  const ctx = fakeContext()
  await assert.rejects(() => apply(ctx, { port: 'not a port' }), /whale-pet config/)
  await assert.rejects(() => apply(ctx, { host: '0.0.0.0' }), /loopback/)
  assert.equal(ctx.disposers.length, 0, 'nothing was started')
})

test('pet tools reach the agent the pet is watching', async () => {
  const received = []
  const agent = { id: 'session-1', followup: message => received.push(message) }
  await withPlugin({ agents: [agent], options: { autoLaunch: false, port: 0 } }, async (ctx) => {
    const mood = ctx.definitions.find(definition => definition.name === 'pet_mood')
    const value = await mood.execute({ mood: 'happy' }, { signal: undefined })
    // No window is connected in this test, so the tool reports the offline
    // state instead of pretending the expression was delivered.
    assert.equal(value.mood, 'happy')
    assert.equal(value.windowOnline, false)

    const window = ctx.definitions.find(definition => definition.name === 'pet_window')
    const status = await window.execute({ action: 'status' }, { signal: undefined })
    assert.equal(status.running, false)
    assert.equal(status.clients, 0)
  })
})

test('a tool rejects an out-of-range action instead of guessing', async () => {
  await withPlugin({ options: { autoLaunch: false, port: 0 } }, async (ctx) => {
    const media = ctx.definitions.find(definition => definition.name === 'pet_media')
    await assert.rejects(() => media.execute({ action: 'explode' }, { signal: undefined }), /不支持的媒体操作/)
    const say = ctx.definitions.find(definition => definition.name === 'pet_say')
    await assert.rejects(() => say.execute({ text: '   ' }, { signal: undefined }), /不能为空/)
  })
})

test('tool results are lossless JSON', async () => {
  // The registry rejects a canonical value containing `undefined`, which is how
  // a status call first failed in a live session: a `let note` that stayed
  // undefined reached the model as an invalid tool output.
  await withPlugin({ options: { autoLaunch: false, port: 0 } }, async (ctx) => {
    const window = ctx.definitions.find(definition => definition.name === 'pet_window')
    const status = await window.execute({ action: 'status' }, { signal: undefined })
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status)

    const mood = ctx.definitions.find(definition => definition.name === 'pet_mood')
    const emote = await mood.execute({ mood: 'happy' }, { signal: undefined })
    assert.deepEqual(JSON.parse(JSON.stringify(emote)), emote)
  })
})
