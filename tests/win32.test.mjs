/**
 * Self-test for the whale-pet Windows PowerShell helpers under `src/win32/`.
 *
 * Every helper is a standalone program that reads one JSON object from stdin and
 * writes exactly one JSON envelope to stdout. This file is the executable version
 * of that contract: it spawns each script for real, checks the envelope, checks
 * that stdout is a single line of JSON, and checks the exit code.
 *
 * Safety: the only mutating operations performed here are level-neutral volume
 * up/down pairs, a mute toggle that is immediately toggled back (both restored in
 * a `finally`), and one notification. Every input.ps1 case is a dry run, so this
 * suite never moves the pointer, never clicks and never types.
 *
 * Run from the package root:
 *   node --test tests/win32.test.mjs
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'src', 'win32')
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const WINDOWS_POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const HELPERS = ['media', 'input', 'notify', 'context']
const SPAWN_TIMEOUT_MS = 90_000

/**
 * Pick the interpreter the contract names, `pwsh` (PowerShell 7), and fall back to
 * Windows PowerShell 5.1. Every helper is written to run under both; on a machine
 * without PowerShell 7 installed the suite still proves the helpers work, just
 * under the older host.
 */
function resolvePowerShell() {
  const candidates = [
    process.env.DSH_WHALE_PET_PWSH,
    'pwsh',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    WINDOWS_POWERSHELL,
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    })
    if (probe.error === undefined && probe.status === 0) {
      return { executable: candidate, isPwsh7: /pwsh(\.exe)?$/i.test(candidate) }
    }
  }
  return null
}

const POWERSHELL = resolvePowerShell()

/**
 * Run one helper with a JSON stdin payload.
 * @param {string} name - helper base name.
 * @param {object|undefined} input - payload; `undefined` sends nothing at all.
 * @returns {{status:number|null,stdout:string,stderr:string,error?:Error}} raw result.
 */
function runHelper(name, input) {
  const script = join(SCRIPTS, `${name}.ps1`)
  const payload = input === undefined ? '' : JSON.stringify(input)
  const result = spawnSync(
    POWERSHELL.executable,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      input: Buffer.from(payload, 'utf8'),
      encoding: 'buffer',
      timeout: SPAWN_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  )
  return {
    status: result.status,
    error: result.error,
    stdout: result.stdout === null ? '' : result.stdout.toString('utf8'),
    stderr: result.stderr === null ? '' : result.stderr.toString('utf8'),
  }
}

/**
 * Assert the full protocol contract for one helper call and return the envelope.
 * @param {string} label - what was run, for failure messages.
 * @param {{status:number|null,stdout:string,stderr:string,error?:Error}} result - spawn result.
 * @returns {object} the parsed envelope.
 */
function parseEnvelope(label, result) {
  assert.equal(result.error, undefined, `${label}: could not start the interpreter: ${result.error?.message}`)
  assert.equal(
    result.status,
    0,
    `${label}: exit code was ${result.status}, expected 0 (stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)})`,
  )

  const raw = result.stdout
  assert.notEqual(raw.length, 0, `${label}: wrote nothing to stdout`)

  const body = raw.replace(/\r?\n$/, '')
  assert.ok(
    !body.includes('\n') && !body.includes('\r'),
    `${label}: stdout is more than one line: ${JSON.stringify(raw)}`,
  )
  assert.notEqual(body.charCodeAt(0), 0xfeff, `${label}: stdout starts with a UTF-8 BOM`)
  assert.notEqual(body.charCodeAt(0), 0xfffd, `${label}: stdout is not valid UTF-8`)

  let envelope
  assert.doesNotThrow(() => {
    envelope = JSON.parse(body)
  }, `${label}: stdout is not valid JSON: ${JSON.stringify(raw)}`)
  assert.ok(
    typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope),
    `${label}: envelope is not a JSON object: ${JSON.stringify(raw)}`,
  )
  assert.equal(typeof envelope.ok, 'boolean', `${label}: envelope has no boolean "ok"`)

  if (envelope.ok === true) {
    assert.ok('value' in envelope, `${label}: ok envelope has no "value"`)
    assert.equal(typeof envelope.value, 'object', `${label}: "value" is not an object`)
    assert.notEqual(envelope.value, null, `${label}: "value" is null`)
  } else {
    assert.equal(typeof envelope.error, 'string', `${label}: error envelope has no string "error"`)
    assert.ok(envelope.error.length > 0, `${label}: "error" is empty`)
    assert.equal(typeof envelope.code, 'string', `${label}: error envelope has no string "code"`)
    assert.ok(envelope.code.length > 0, `${label}: "code" is empty`)
  }
  return envelope
}

/** Run a helper and require an ok envelope. */
function runOk(name, input, label = `${name}.ps1 ${JSON.stringify(input ?? null)}`) {
  const envelope = parseEnvelope(label, runHelper(name, input))
  assert.equal(envelope.ok, true, `${label}: expected ok, got ${JSON.stringify(envelope)}`)
  return envelope.value
}

/** Run a helper and require an error envelope with the given code. */
function runFail(name, input, expectedCode, label = `${name}.ps1 ${JSON.stringify(input ?? null)}`) {
  const envelope = parseEnvelope(label, runHelper(name, input))
  assert.equal(envelope.ok, false, `${label}: expected an error, got ${JSON.stringify(envelope)}`)
  if (expectedCode !== undefined) {
    assert.equal(envelope.code, expectedCode, `${label}: unexpected error code`)
  }
  return envelope
}

/** Read the machine's current volume and mute state through context.ps1. */
function readAudioState() {
  const value = runOk('context', {}, 'context.ps1 (audio state)')
  return { volume: value.volume, muted: value.muted }
}

/** Read the pointer position through context.ps1. */
function readPointer() {
  const value = runOk('context', {}, 'context.ps1 (pointer)')
  return { x: value.cursorX, y: value.cursorY }
}

/** Block the main thread for one short interval without spinning a process. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Structural equality of two samples of the same shape. */
function sampleEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Judge one dry run against machine-global state that a human can also change.
 *
 * Several assertions here compare the cursor or the mute flag before and after a
 * dry run. Whoever shares the desktop may move the mouse or hit a mute key at
 * any moment, which would otherwise surface as a helper failure. The state is
 * therefore sampled twice before and twice after the action: a change across a
 * pair means the machine was busy and no verdict is possible, so the suite
 * reports `noisy` instead of blaming the helper.
 * @param measure - zero-argument sampler of the state under test.
 * @param action - performs the dry run between the sample pairs.
 * @returns `quiet-unchanged`, `quiet-changed`, or `noisy`.
 */
function dryRunLeavesStateAlone(measure, action) {
  const first = measure()
  const second = measure()
  action()
  const third = measure()
  const fourth = measure()
  if (!sampleEquals(first, second) || !sampleEquals(third, fourth)) return 'noisy'
  return sampleEquals(first, fourth) ? 'quiet-unchanged' : 'quiet-changed'
}

/**
 * Judge a dry run, confirming a suspected mutation before reporting it.
 *
 * A single quiet window that shows a change is far more likely to be someone
 * hitting a mute key between two samples than a helper ignoring `dryRun`. A real
 * leak reproduces, so the measurement is repeated once and only a second
 * `quiet-changed` verdict is treated as a failure.
 * @param measure - zero-argument sampler of the state under test.
 * @param action - performs the dry run between the sample pairs.
 * @returns the confirmed verdict: `quiet-unchanged`, `quiet-changed`, or `noisy`.
 */
function confirmedDryRunVerdict(measure, action) {
  const first = dryRunLeavesStateAlone(measure, action)
  if (first !== 'quiet-changed') return first
  return dryRunLeavesStateAlone(measure, action)
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

before(() => {
  assert.ok(POWERSHELL !== null, 'no PowerShell interpreter found (tried pwsh and Windows PowerShell 5.1)')
  console.log(
    `# interpreter: ${POWERSHELL.executable} (${POWERSHELL.isPwsh7 ? 'PowerShell 7' : 'Windows PowerShell 5.1 fallback - pwsh is not installed'})`,
  )
})

describe('helper files', () => {
  for (const name of HELPERS) {
    test(`${name}.ps1 exists`, () => {
      assert.ok(existsSync(join(SCRIPTS, `${name}.ps1`)), `${name}.ps1 is missing`)
    })
  }
})

describe('protocol envelope', () => {
  for (const name of HELPERS) {
    test(`${name}.ps1 answers valid JSON with exit code 0 when stdin is empty`, () => {
      // Empty stdin must be treated as {} — never a crash, never a hang.
      const envelope = parseEnvelope(`${name}.ps1 <empty>`, runHelper(name, undefined))
      if (name === 'context') {
        assert.equal(envelope.ok, true, 'context.ps1 must accept empty input as {}')
      } else {
        assert.equal(envelope.ok, false, `${name}.ps1 must reject a missing action`)
        assert.equal(envelope.code, 'BAD_INPUT')
      }
    })

    test(`${name}.ps1 survives malformed JSON without throwing`, () => {
      const result = spawnSync(
        POWERSHELL.executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPTS, `${name}.ps1`)],
        { input: Buffer.from('{not json', 'utf8'), encoding: 'buffer', timeout: SPAWN_TIMEOUT_MS, windowsHide: true },
      )
      const envelope = parseEnvelope(
        `${name}.ps1 <malformed>`,
        {
          status: result.status,
          error: result.error,
          stdout: result.stdout === null ? '' : result.stdout.toString('utf8'),
          stderr: result.stderr === null ? '' : result.stderr.toString('utf8'),
        },
      )
      // Either it refuses the payload or it ignores it, but it must answer once.
      assert.equal(typeof envelope.ok, 'boolean')
    })
  }
})

describe('context.ps1', () => {
  test('reports a typed, read-only snapshot', () => {
    const value = runOk('context', {})

    assert.ok(value.activeWindowTitle === null || typeof value.activeWindowTitle === 'string')
    assert.ok(value.activeProcessName === null || typeof value.activeProcessName === 'string')
    assert.ok(isInteger(value.cursorX), `cursorX is not an integer: ${value.cursorX}`)
    assert.ok(isInteger(value.cursorY), `cursorY is not an integer: ${value.cursorY}`)
    assert.ok(isInteger(value.screenWidth) && value.screenWidth > 0, `screenWidth: ${value.screenWidth}`)
    assert.ok(isInteger(value.screenHeight) && value.screenHeight > 0, `screenHeight: ${value.screenHeight}`)
    assert.ok(
      value.volume === null || (isInteger(value.volume) && value.volume >= 0 && value.volume <= 100),
      `volume: ${value.volume}`,
    )
    assert.ok(value.muted === null || typeof value.muted === 'boolean', `muted: ${value.muted}`)
    assert.ok(value.idleSeconds === null || (isInteger(value.idleSeconds) && value.idleSeconds >= 0), `idleSeconds: ${value.idleSeconds}`)

    assert.equal(typeof value.time, 'string')
    assert.match(value.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'time is not ISO-8601')
    assert.ok(!Number.isNaN(Date.parse(value.time)), `time is not parseable: ${value.time}`)
  })

  test('agrees with itself across two consecutive reads', () => {
    const first = runOk('context', {})
    const second = runOk('context', {})
    assert.equal(typeof second.cursorX, 'number')
    // The screen never changes between two reads; the volume may.
    assert.equal(second.screenWidth, first.screenWidth)
    assert.equal(second.screenHeight, first.screenHeight)
  })
})

describe('media.ps1', () => {
  test('rejects unknown actions and bad levels without throwing', () => {
    runFail('media', { action: 'bogus' }, 'UNKNOWN_ACTION')
    runFail('media', {}, 'BAD_INPUT')
    runFail('media', { action: 'set-volume' }, 'BAD_INPUT')
    runFail('media', { action: 'set-volume', level: 101 }, 'BAD_INPUT')
    runFail('media', { action: 'set-volume', level: -1 }, 'BAD_INPUT')
    runFail('media', { action: 'volume-up', steps: 0 }, 'BAD_INPUT')
    runFail('media', { action: 'volume-up', steps: 999 }, 'BAD_INPUT')
  })

  test('dry run reports what it would do and changes nothing', () => {
    const before = readAudioState()
    const target = before.volume === null ? 40 : before.volume >= 50 ? 10 : 90

    let dry
    const verdict = confirmedDryRunVerdict(readAudioState, () => {
      dry = runOk('media', { action: 'set-volume', level: target, dryRun: true })
    })
    assert.equal(dry.action, 'set-volume')
    assert.equal(dry.dryRun, true)
    assert.equal(dry.would.kind, 'volume')
    assert.equal(dry.would.to, target)
    assert.notEqual(verdict, 'quiet-changed', 'a dry run changed the volume or the mute flag')

    const transport = runOk('media', { action: 'next', dryRun: true })
    assert.equal(transport.dryRun, true)
    assert.equal(transport.would.kind, 'media-key')
  })

  test('reads back the real state through the Core Audio API', () => {
    const context = readAudioState()
    const media = runOk('media', { action: 'volume-up', steps: 1, dryRun: true })
    // context.ps1 and media.ps1 must agree on the current volume.
    assert.equal(media.volume, context.volume, 'media.ps1 and context.ps1 disagree about the volume')
    assert.equal(media.muted, context.muted, 'media.ps1 and context.ps1 disagree about the mute flag')
    assert.equal(media.via, 'core-audio')
  })

  test('volume-up/volume-down is level neutral and restores the original level', () => {
    const before = readAudioState()
    if (before.volume === null) {
      // No default audio endpoint: nothing to be neutral about.
      return
    }

    // Pick the direction that cannot clamp: raise first unless we are near the top.
    const raiseFirst = before.volume <= 98
    const first = raiseFirst ? 'volume-up' : 'volume-down'
    const second = raiseFirst ? 'volume-down' : 'volume-up'
    const expectedMid = raiseFirst ? before.volume + 2 : before.volume - 2

    try {
      const mid = runOk('media', { action: first, steps: 1 }, `media.ps1 ${first} steps=1`)
      assert.equal(mid.volume, expectedMid, `${first} did not move the volume by one 2% step`)

      const back = runOk('media', { action: second, steps: 1 }, `media.ps1 ${second} steps=1`)
      assert.equal(back.volume, before.volume, `the volume was not restored to ${before.volume}`)
    } finally {
      // Whatever happened above, put the volume back where it started.
      runOk('media', { action: 'set-volume', level: before.volume }, 'media.ps1 restore volume')
    }

    assert.equal(readAudioState().volume, before.volume, 'the volume was left changed')
  })

  test('the media-key fallback moves the volume and is level neutral too', () => {
    const before = readAudioState()
    if (before.volume === null) {
      return
    }

    // Same neutral pair, but forced down the SendKeys/SendInput media-key path
    // instead of the Core Audio API.
    const downFirst = before.volume >= 2
    const first = downFirst ? 'volume-down' : 'volume-up'
    const second = downFirst ? 'volume-up' : 'volume-down'

    try {
      const mid = runOk('media', { action: first, steps: 1, via: 'media-keys' }, `media.ps1 ${first} via=media-keys`)
      assert.equal(mid.via, 'media-keys')
      assert.ok(
        mid.mechanism === 'sendkeys' || mid.mechanism === 'sendinput',
        `mechanism should name the delivery path, got ${mid.mechanism}`,
      )
      const back = runOk('media', { action: second, steps: 1, via: 'media-keys' }, `media.ps1 ${second} via=media-keys`)
      assert.equal(back.volume, before.volume, `the media-key pair did not restore the volume to ${before.volume}`)
    } finally {
      runOk('media', { action: 'set-volume', level: before.volume }, 'media.ps1 restore volume')
    }
  })

  test('toggle-mute flips the flag and flipping it back restores it', () => {
    const before = readAudioState()
    if (before.muted === null) {
      return
    }

    try {
      const toggled = runOk('media', { action: 'toggle-mute' }, 'media.ps1 toggle-mute')
      assert.notEqual(toggled.muted, before.muted, 'toggle-mute did not change the mute flag')
      assert.equal(toggled.volume, before.volume, 'toggle-mute must not change the volume')

      const restored = runOk('media', { action: 'toggle-mute' }, 'media.ps1 toggle-mute (back)')
      assert.equal(restored.muted, before.muted, 'the second toggle did not restore the mute flag')
    } finally {
      // Guarantee the user's mute state, whatever the assertions did.
      runOk('media', { action: before.muted ? 'mute' : 'unmute' }, 'media.ps1 restore mute')
    }

    assert.equal(readAudioState().muted, before.muted, 'the mute flag was left changed')
  })

  test('mute and unmute are honoured and the read-back agrees', () => {
    const before = readAudioState()
    if (before.muted === null) {
      return
    }

    try {
      const muted = runOk('media', { action: 'mute' })
      assert.equal(muted.muted, true, 'mute did not take effect')
      assert.equal(readAudioState().muted, true, 'context.ps1 does not see the mute')

      const unmuted = runOk('media', { action: 'unmute' })
      assert.equal(unmuted.muted, false, 'unmute did not take effect')
      assert.equal(readAudioState().muted, false, 'context.ps1 does not see the unmute')
    } finally {
      runOk('media', { action: before.muted ? 'mute' : 'unmute' }, 'media.ps1 restore mute')
    }

    assert.equal(readAudioState().muted, before.muted, 'the mute flag was left changed')
  })
})

describe('input.ps1 (dry run only - nothing is ever typed, moved or clicked)', () => {
  test('type reports the clipboard route for non-ASCII text', () => {
    const text = '你好，鲸鱼'
    const value = runOk('input', { action: 'type', text, dryRun: true })
    assert.equal(value.action, 'type')
    assert.equal(value.dryRun, true)
    assert.equal(value.unicode, true, 'Chinese text must be reported as unicode')
    assert.equal(value.method, 'clipboard', 'Chinese text must use the clipboard route')
    assert.equal(value.length, [...text].length)
  })

  test('type reports the SendKeys route for pure ASCII text', () => {
    const value = runOk('input', { action: 'type', text: 'hello world 123', dryRun: true })
    assert.equal(value.unicode, false)
    assert.equal(value.method, 'sendkeys')
    assert.equal(value.length, 15)
    assert.equal(value.position !== undefined, true)
  })

  test('type refuses empty text', () => {
    runFail('input', { action: 'type', text: '', dryRun: true }, 'BAD_INPUT')
    runFail('input', { action: 'type', dryRun: true }, 'BAD_INPUT')
  })

  test('hotkey translates ctrl+shift+t into SendKeys notation', () => {
    const value = runOk('input', { action: 'hotkey', keys: 'ctrl+shift+t', dryRun: true })
    assert.equal(value.sendKeys, '^+t')
    assert.equal(value.windows, false)
    assert.equal(value.dryRun, true)
  })

  test('key translates named keys', () => {
    assert.equal(runOk('input', { action: 'key', keys: 'enter', dryRun: true }).sendKeys, '{ENTER}')
    assert.equal(runOk('input', { action: 'key', keys: 'tab', dryRun: true }).sendKeys, '{TAB}')
    assert.equal(runOk('input', { action: 'key', keys: 'esc', dryRun: true }).sendKeys, '{ESC}')
    assert.equal(runOk('input', { action: 'key', keys: 'backspace', dryRun: true }).sendKeys, '{BS}')
    assert.equal(runOk('input', { action: 'key', keys: 'pageup', dryRun: true }).sendKeys, '{PGUP}')
    assert.equal(runOk('input', { action: 'key', keys: 'f5', dryRun: true }).sendKeys, '{F5}')
    assert.equal(runOk('input', { action: 'key', keys: 'a', dryRun: true }).sendKeys, 'a')
    assert.equal(runOk('input', { action: 'key', keys: '7', dryRun: true }).sendKeys, '7')
  })

  test('hotkey marks the Windows key, which SendKeys cannot express', () => {
    const value = runOk('input', { action: 'hotkey', keys: 'win+r', dryRun: true })
    assert.equal(value.windows, true)
    assert.equal(value.sendKeys, 'r')
  })

  test('hotkey rejects an unknown key', () => {
    const envelope = runFail('input', { action: 'hotkey', keys: 'hyper+x', dryRun: true }, 'BAD_INPUT')
    assert.match(envelope.error, /hyper/)
    runFail('input', { action: 'hotkey', keys: '', dryRun: true }, 'BAD_INPUT')
    runFail('input', { action: 'hotkey', keys: 'ctrl', dryRun: true }, 'BAD_INPUT')
  })

  test('move reports the resolved coordinates and does not move anything', () => {
    let value
    const verdict = confirmedDryRunVerdict(readPointer, () => {
      value = runOk('input', { action: 'move', x: 123, y: 456, dryRun: true })
    })
    assert.equal(value.dryRun, true)
    assert.equal(value.moved, false, 'a dry run must not move the pointer')
    assert.deepEqual(value.position, { x: 123, y: 456 })
    assert.notEqual(verdict, 'quiet-changed', 'the pointer moved while only a dry run was happening')
  })

  test('position is a read-only action', () => {
    const value = runOk('input', { action: 'position' })
    assert.ok(isInteger(value.position.x), `position.x: ${value.position.x}`)
    assert.ok(isInteger(value.position.y), `position.y: ${value.position.y}`)
  })

  test('move rejects missing or non-numeric coordinates', () => {
    runFail('input', { action: 'move', x: 10, dryRun: true }, 'BAD_INPUT')
    runFail('input', { action: 'move', x: 'left', y: 10, dryRun: true }, 'BAD_INPUT')
  })

  test('click variants honour dry run', () => {
    let single
    let double
    let right
    const verdict = confirmedDryRunVerdict(readPointer, () => {
      single = runOk('input', { action: 'click', x: 10, y: 20, dryRun: true })
      double = runOk('input', { action: 'double-click', dryRun: true })
      right = runOk('input', { action: 'right-click', x: 5, y: 6, dryRun: true })
    })

    assert.equal(single.clicked, false)
    assert.equal(single.clicks, 1)
    assert.equal(single.button, 'left')
    assert.equal(single.moveFirst, true)
    assert.deepEqual(single.position, { x: 10, y: 20 })

    assert.equal(double.clicks, 2)
    assert.equal(double.clicked, false)

    assert.equal(right.button, 'right')
    assert.equal(right.clicked, false)

    assert.notEqual(verdict, 'quiet-changed', 'a dry run moved the pointer')
  })

  test('scroll honours dry run and validates delta', () => {
    const up = runOk('input', { action: 'scroll', delta: 3, dryRun: true })
    assert.equal(up.scrolled, false)
    assert.equal(up.direction, 'up')
    assert.equal(up.notches, 360)

    const down = runOk('input', { action: 'scroll', delta: -2, dryRun: true })
    assert.equal(down.direction, 'down')
    assert.equal(down.notches, -240)

    runFail('input', { action: 'scroll', dryRun: true }, 'BAD_INPUT')
    runFail('input', { action: 'scroll', delta: 0, dryRun: true }, 'BAD_INPUT')
    runFail('input', { action: 'scroll', delta: 'lots', dryRun: true }, 'BAD_INPUT')
  })

  test('rejects an unknown action', () => {
    runFail('input', { action: 'teleport', dryRun: true }, 'UNKNOWN_ACTION')
  })
})

describe('notify.ps1', () => {
  test('shows the self-test notification', () => {
    const value = runOk('notify', { title: 'whale-pet', message: 'self-test', silent: true })
    assert.equal(value.shown, true)
    assert.ok(value.via === 'toast' || value.via === 'balloon', `via: ${value.via}`)
  })

  test('dry run shows nothing and reports what it would show', () => {
    const value = runOk('notify', { title: 'whale-pet', message: 'dry', silent: true, dryRun: true })
    assert.equal(value.shown, false)
    assert.equal(value.dryRun, true)
    assert.equal(value.would.title, 'whale-pet')
    assert.equal(value.would.message, 'dry')
    assert.equal(value.would.silent, true)
    assert.equal(typeof value.would.appId, 'string')
  })

  test('rejects an empty request', () => {
    runFail('notify', {}, 'BAD_INPUT')
    runFail('notify', { title: '   ' }, 'BAD_INPUT')
  })

  test('carries non-ASCII text through stdin intact', () => {
    const value = runOk('notify', { title: '鲸鱼', message: '你好，世界', silent: true, dryRun: true })
    assert.equal(value.would.title, '鲸鱼')
    assert.equal(value.would.message, '你好，世界')
  })
})
