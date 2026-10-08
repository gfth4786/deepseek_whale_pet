/**
 * Model-facing tools that act on the local Windows desktop: volume and media
 * transport, keyboard/mouse automation, notifications, and a read-only look at
 * what the user is doing.
 *
 * Every tool is a thin, validated wrapper over one PowerShell helper in
 * `src/win32/`. Tools return only their canonical JSON value; `output.render`
 * turns it into the one line the model reads.
 *
 * @module dsh-whale-pet/src/tools/pc
 */

import { runHelper } from '../win32/run.js'

/** Volume and media transport actions the helper implements. */
export const MEDIA_ACTIONS = Object.freeze([
  'volume-up', 'volume-down', 'set-volume', 'mute', 'unmute', 'toggle-mute',
  'play-pause', 'next', 'previous', 'stop',
])

/** Keyboard and mouse actions the helper implements. */
export const INPUT_ACTIONS = Object.freeze([
  'type', 'key', 'hotkey', 'move', 'click', 'double-click', 'right-click', 'scroll', 'position',
])

/** Actions that only read the desktop and never change it. */
const READ_ONLY_ACTIONS = new Set(['position'])

/** One text block, the only content shape these tools produce. */
const text = value => [{ type: 'text', text: value }]

/**
 * Ask the user before one tool class runs, when the deployment configured it.
 * @param ctx - the plugin context.
 * @param config - resolved plugin configuration.
 * @param kind - approval class key (`input`, `media`, `notify`, `window`).
 * @param reason - human-readable reason shown to the user.
 * @param exec - the tool execution context.
 * @returns completion once the request is approved.
 * @throws {Error} when approval is required and not granted.
 */
export async function requireApproval(ctx, config, kind, reason, exec) {
  if (config.approval[kind] !== true) return
  const approval = ctx.approval
  if (approval === undefined) {
    throw new Error(`该操作需要用户批准（${kind}），但当前部署没有可用的审批服务`)
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`用户未批准该操作（${String(outcome)}）`)
  }
}

/**
 * Render a volume/mute state as readable text.
 * @param value - the helper's value object.
 * @returns a bounded description.
 */
function describeVolume(value) {
  const parts = []
  if (typeof value.volume === 'number') parts.push(`音量 ${Math.round(value.volume)}%`)
  else parts.push('音量 未知')
  if (typeof value.muted === 'boolean') parts.push(value.muted ? '已静音' : '未静音')
  if (typeof value.via === 'string') parts.push(`(via ${value.via})`)
  return parts.join('，')
}

/**
 * Build every PC-control tool definition.
 * @param deps - plugin context, configuration, and logging.
 * @returns the tool definitions to register.
 */
export function pcTools(deps) {
  const { ctx, config, log } = deps
  const timeoutMs = config.helperTimeoutMs
  return [
    {
      name: 'pet_media',
      description: [
        '控制这台电脑的系统音量与媒体播放（鲸鱼娘替你动手）。',
        'action: volume-up/volume-down 按步进调音量；set-volume 设为绝对音量（0-100，用 level）；',
        'mute/unmute/toggle-mute 静音开关；play-pause/next/previous/stop 控制当前媒体。',
        '返回操作后的真实音量与静音状态。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...MEDIA_ACTIONS], description: '要执行的操作' },
          level: { type: 'number', description: 'set-volume 的目标音量，0-100' },
          steps: { type: 'number', description: 'volume-up/volume-down 的步数，默认 2' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`媒体控制完成：${describeVolume(value)}`),
      },
      async execute(args, exec) {
        const action = String(args?.action ?? '')
        if (!MEDIA_ACTIONS.includes(action)) throw new Error(`不支持的媒体操作：${action}`)
        await requireApproval(ctx, config, 'media', `控制电脑音量/媒体（${action}）`, exec)
        const value = await runHelper('media', {
          action,
          level: typeof args?.level === 'number' ? args.level : undefined,
          steps: typeof args?.steps === 'number' ? args.steps : undefined,
        }, { timeoutMs, signal: exec.signal })
        log(`pet_media ${action} -> ${JSON.stringify(value)}`)
        return value
      },
      presentCall: args => ({ card: 'generic', title: `媒体控制：${String(args?.action ?? '')}`, kind: 'other', rawInput: args }),
    },
    {
      name: 'pet_input',
      description: [
        '在这台电脑上模拟键盘与鼠标（鲸鱼娘替你动手）。',
        'type 输入文本（支持中文，走剪贴板粘贴）；key 按一个键（如 enter、esc、f5）；hotkey 按组合键（如 ctrl+shift+t）；',
        'move 移动到坐标；click/double-click/right-click 点击（可带 x/y 先移动）；scroll 滚轮（delta 正数向上）；position 只读取当前光标位置。',
        '用 dryRun=true 可以只预览将要执行的动作而不真的动鼠标键盘。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...INPUT_ACTIONS], description: '要执行的动作' },
          text: { type: 'string', description: 'type 时要输入的文本' },
          keys: { type: 'string', description: 'key/hotkey 的键名或组合键，如 enter、ctrl+s' },
          x: { type: 'number', description: '目标横坐标（屏幕像素）' },
          y: { type: 'number', description: '目标纵坐标（屏幕像素）' },
          delta: { type: 'number', description: 'scroll 的滚动量，正数向上' },
          dryRun: { type: 'boolean', description: '只预览不执行，默认 false' },
          restoreClipboard: { type: 'boolean', description: 'type 走剪贴板时是否恢复原剪贴板内容，默认 true' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          const position = value?.position
          const where = typeof position?.x === 'number' ? `，光标现在 (${position.x}, ${position.y})` : ''
          const prefix = value?.dryRun === true ? '（预演，未真正执行）' : ''
          return text(`${prefix}键鼠操作 ${String(args?.action ?? '')} 完成${where}`)
        },
      },
      async execute(args, exec) {
        const action = String(args?.action ?? '')
        if (!INPUT_ACTIONS.includes(action)) throw new Error(`不支持的键鼠操作：${action}`)
        const dryRun = args?.dryRun === true
        if (!dryRun && !READ_ONLY_ACTIONS.has(action)) {
          await requireApproval(ctx, config, 'input', `模拟键鼠操作（${action}）`, exec)
        }
        const value = await runHelper('input', {
          action,
          text: args?.text,
          keys: args?.keys,
          x: args?.x,
          y: args?.y,
          delta: args?.delta,
          dryRun,
          restoreClipboard: args?.restoreClipboard !== false,
        }, { timeoutMs, signal: exec.signal })
        log(`pet_input ${action} dryRun=${String(dryRun)}`)
        return value
      },
      presentCall: args => ({ card: 'generic', title: `键鼠操作：${String(args?.action ?? '')}`, kind: 'other', rawInput: args }),
    },
    {
      name: 'pet_notify',
      description: [
        '弹出一条系统通知，并可选地在鲸鱼娘头上显示一个气泡。',
        '适合长任务结束时提醒用户；bubble=true 时桌宠窗口同时显示气泡并朗读（若语音开启）。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '通知标题' },
          message: { type: 'string', description: '通知正文' },
          silent: { type: 'boolean', description: '是否静默（不播放系统提示音），默认 false' },
          bubble: { type: 'boolean', description: '是否同时在桌宠窗口显示气泡，默认 true' },
        },
        required: ['message'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`通知已发出（${String(value?.via ?? 'unknown')}${value?.bubble === true ? '，桌宠气泡已显示' : ''}）`),
      },
      async execute(args, exec) {
        const message = String(args?.message ?? '').trim()
        if (message.length === 0) throw new Error('通知正文不能为空')
        const title = String(args?.title ?? '鲸鱼娘').slice(0, 120)
        await requireApproval(ctx, config, 'notify', `发送系统通知：${title}`, exec)
        const bubble = args?.bubble !== false
        if (bubble) {
          deps.publish('notify', { title, message })
        }
        const value = await runHelper('notify', {
          title,
          message: message.slice(0, 800),
          silent: args?.silent === true,
        }, { timeoutMs, signal: exec.signal })
        return { ...value, bubble, title }
      },
      presentCall: args => ({ card: 'generic', title: `通知：${String(args?.title ?? '鲸鱼娘')}`, kind: 'other', rawInput: args }),
    },
    {
      name: 'pet_look',
      description: [
        '看一眼这台电脑现在的状态：前台窗口标题与进程、光标位置、屏幕分辨率、系统音量、用户空闲时长。',
        '只读操作，不会改动任何东西；适合鲸鱼娘“看看你在干嘛”或判断用户是否离开。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const lines = []
          lines.push(`前台窗口：${value?.activeWindowTitle ?? '未知'}（${value?.activeProcessName ?? '未知进程'}）`)
          lines.push(`光标：(${String(value?.cursorX ?? '?')}, ${String(value?.cursorY ?? '?')}) / 屏幕 ${String(value?.screenWidth ?? '?')}x${String(value?.screenHeight ?? '?')}`)
          lines.push(`音量：${typeof value?.volume === 'number' ? `${Math.round(value.volume)}%` : '未知'}${value?.muted === true ? '（已静音）' : ''}`)
          lines.push(`空闲：${typeof value?.idleSeconds === 'number' ? `${Math.round(value.idleSeconds)} 秒` : '未知'}`)
          return text(lines.join('\n'))
        },
      },
      async execute(_args, exec) {
        const value = await runHelper('context', {}, { timeoutMs, signal: exec.signal })
        return value
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: '看一眼桌面状态', kind: 'search', rawInput: {} }),
    },
  ]
}
