/**
 * Model-facing tools that drive the pet itself: make it speak, change its
 * expression, and show/hide/restart its window.
 *
 * These tools talk to the window over the bridge; the one exception is
 * `pet_say`, which falls back to the system speech synthesizer when no window is
 * connected so a headless deployment can still be heard.
 *
 * @module dsh-whale-pet/src/tools/pet
 */

import { WINDOWS_POWERSHELL, runHelper } from '../win32/run.js'
import { requireApproval } from './pc.js'

/** Expressions the character art provides. */
export const MOODS = Object.freeze(['idle', 'happy', 'thinking', 'working', 'sleepy', 'surprised'])

/** Window commands understood by the renderer and the launcher. */
export const WINDOW_ACTIONS = Object.freeze([
  'show', 'hide', 'toggle', 'restart', 'quit', 'status', 'topmost-on', 'topmost-off',
])

/** One text block, the only content shape these tools produce. */
const text = value => [{ type: 'text', text: value }]

/** Human-readable Chinese name of one mood, for tool results. */
const MOOD_LABEL = Object.freeze({
  idle: '发呆',
  happy: '开心',
  thinking: '思考',
  working: '干活',
  sleepy: '困了',
  surprised: '惊讶',
})

/**
 * Build every pet-control tool definition.
 * @param deps - plugin context, configuration, publishing, and the window handle.
 * @returns the tool definitions to register.
 */
export function petTools(deps) {
  const { ctx, config, log, publish, bridge, petProcess } = deps
  const timeoutMs = config.helperTimeoutMs
  return [
    {
      name: 'pet_say',
      description: [
        '让鲸鱼娘说出这句话（TTS 朗读），并在她头上显示气泡。',
        '桌宠窗口在线时由窗口朗读；窗口不在时退回系统语音合成，仍然能听见。',
        '适合短句提醒；长文本建议用 pet_notify。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要说的话' },
          mood: { type: 'string', enum: [...MOODS], description: '说话时的表情，默认 happy' },
        },
        required: ['text'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`鲸鱼娘说：“${String(value?.spoken ?? '')}”（${String(value?.via ?? 'unknown')}）`),
      },
      async execute(args, exec) {
        const line = String(args?.text ?? '').trim()
        if (line.length === 0) throw new Error('要说的话不能为空')
        const spoken = line.slice(0, 600)
        const mood = MOODS.includes(args?.mood) ? args.mood : 'happy'
        const delivered = publish('say', { text: spoken, mood })
        if (delivered) return { spoken, via: 'window', mood }
        if (!config.voice.enabled) throw new Error('语音已关闭，且桌宠窗口不在线')
        await runHelper('speak', { text: spoken, rate: config.voice.rate, volume: config.voice.volume }, {
          timeoutMs,
          signal: exec.signal,
          executable: WINDOWS_POWERSHELL,
        })
        log('pet_say fell back to the system synthesizer')
        return { spoken, via: 'system-tts', mood }
      },
      presentCall: args => ({ card: 'generic', title: `让鲸鱼娘说：${String(args?.text ?? '').slice(0, 40)}`, kind: 'other', rawInput: args }),
    },
    {
      name: 'pet_mood',
      description: [
        '切换鲸鱼娘的表情：idle 发呆、happy 开心、thinking 思考、working 干活、sleepy 困了、surprised 惊讶。',
        '可以指定持续时间（毫秒），到点自动回到 idle。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mood: { type: 'string', enum: [...MOODS], description: '目标表情' },
          durationMs: { type: 'number', description: '保持时长（毫秒），省略表示一直保持' },
        },
        required: ['mood'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`鲸鱼娘现在是「${MOOD_LABEL[value?.mood] ?? String(value?.mood)}」${value?.windowOnline === true ? '' : '（桌宠窗口不在线，回到窗口时会生效）'}`),
      },
      async execute(args) {
        const mood = MOODS.includes(args?.mood) ? args.mood : 'idle'
        const durationMs = typeof args?.durationMs === 'number' ? Math.max(0, Math.min(args.durationMs, 600000)) : undefined
        const windowOnline = publish('mood', { mood, durationMs })
        return { mood, durationMs: durationMs ?? null, windowOnline }
      },
      presentCall: args => ({ card: 'generic', title: `切换表情：${String(args?.mood ?? '')}`, kind: 'other', rawInput: args }),
    },
    {
      name: 'pet_window',
      description: [
        '管理桌宠窗口：show 显示、hide 隐藏、toggle 切换、restart 重启窗口、quit 关闭窗口、',
        'topmost-on/topmost-off 切换总在最前、status 查看窗口与桥接状态。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...WINDOW_ACTIONS], description: '要执行的窗口操作' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`桌宠窗口：${String(value?.action ?? '')} → 运行中=${String(value?.running === true)}, 连接数=${String(value?.clients ?? 0)}${value?.note == null ? '' : `（${String(value.note)}）`}`),
      },
      async execute(args, exec) {
        const action = String(args?.action ?? '')
        if (!WINDOW_ACTIONS.includes(action)) throw new Error(`不支持的窗口操作：${action}`)
        if (action !== 'status') {
          await requireApproval(ctx, config, 'window', `桌宠窗口操作（${action}）`, exec)
        }
        // Every branch must produce lossless JSON: an `undefined` field fails the
        // registry's output validation, which is how a status call first broke.
        let note = null
        if (action === 'restart') {
          await petProcess.stop()
          const pid = petProcess.start()
          note = pid === undefined ? '未能启动' : `pid ${pid}`
        } else if (action === 'quit') {
          await petProcess.stop()
          note = '已关闭窗口进程'
        } else if (action === 'show' || action === 'hide' || action === 'toggle' || action === 'topmost-on' || action === 'topmost-off') {
          if (!petProcess.running && (action === 'show' || action === 'toggle')) {
            const pid = petProcess.start()
            note = pid === undefined ? '窗口已在运行' : `已启动 pid ${pid}`
          } else {
            note = '已下发给窗口'
            publish('window', { action })
          }
        }
        const status = petProcess.status()
        return { action, running: status.running, pid: status.pid, clients: bridge.clientCount, note }
      },
      presentCall: args => ({ card: 'generic', title: `桌宠窗口：${String(args?.action ?? '')}`, kind: 'other', rawInput: args }),
    },
  ]
}
