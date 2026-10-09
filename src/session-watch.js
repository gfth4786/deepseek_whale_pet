/**
 * Watches DSH sessions and feeds the pet window.
 *
 * The pet is a passive listener on the conversation: it learns what the agent
 * said, when a turn is running, and which tools fired, then turns that into
 * speech and expressions. It is also the pet's way back in — the user's typed or
 * spoken line becomes an ordinary user message on the target agent.
 *
 * Nothing here writes Session state except {@link SessionWatcher.sendUserText},
 * which appends a normal user message through the public `Agent.followup()`
 * path, exactly as the harness's own reminder producer does.
 *
 * @module dsh-whale-pet/src/session-watch
 */

import { randomUUID as uuid } from 'node:crypto'
import { textOfContent, toUtterances } from './speech.js'

/** Longest tool name echoed into a pet status line. */
const TOOL_LABEL_MAX = 40

/**
 * Observe agents and mirror them onto the bridge.
 */
export class SessionWatcher {
  #lastSessionId
  /** Tool names by call id, because `tool/result` does not repeat the name. */
  #callNames = new Map()
  #running = new Set()

  /**
   * @param options - the plugin context, configuration, and bridge.
   * @param options.ctx - the Cordis context the plugin was applied with.
   * @param options.config - resolved plugin configuration.
   * @param options.bridge - the pet bridge to publish onto.
   * @param options.log - debug log sink.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.bridge = options.bridge
    this.log = options.log ?? (() => {})
    this.lastReply = ''
  }

  /**
   * Subscribe to session and agent events. Every registration is an effect of
   * the plugin fiber, so unloading the plugin detaches all of them.
   */
  attach() {
    this.ctx.on('session/event', (session, event) => {
      // Only sessions that currently own an Agent are interesting; a replay or a
      // disposed session would otherwise steal the "active" slot.
      if (this.ctx.agents.get(session.id) === undefined) return
      this.#lastSessionId = session.id
      try {
        this.#onEvent(session.id, event)
      } catch (error) {
        this.log(`session event handling failed: ${error?.stack ?? error}`)
      }
    })
  }

  /**
   * Translate one durable event into pet state.
   * @param sessionId - the session that produced the event.
   * @param event - the durable session event.
   */
  #onEvent(sessionId, event) {
    switch (event?.type) {
      case 'turn/start': {
        this.#running.add(sessionId)
        this.bridge.publish('status', { state: 'thinking', sessionId, turn: event.data?.turn })
        break
      }
      case 'turn/end': {
        this.#running.delete(sessionId)
        this.bridge.publish('status', { state: 'idle', sessionId, turn: event.data?.turn })
        break
      }
      case 'assistant/message': {
        this.#onAssistantMessage(sessionId, event)
        break
      }
      case 'tool/call': {
        const name = typeof event.data?.name === 'string' ? event.data.name : 'tool'
        if (typeof event.data?.callId === 'string') this.#callNames.set(event.data.callId, name)
        this.bridge.publish('tool', { phase: 'start', name, sessionId, label: toolLabel(name) })
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.callId
        const name = (typeof callId === 'string' ? this.#callNames.get(callId) : undefined) ?? 'tool'
        if (typeof callId === 'string') this.#callNames.delete(callId)
        this.bridge.publish('tool', {
          phase: 'end',
          name,
          sessionId,
          isError: event.data?.message?.isError === true,
          label: toolLabel(name),
        })
        break
      }
      default:
        break
    }
  }

  /**
   * Publish one settled assistant reply as speech.
   * @param sessionId - the session that produced the reply.
   * @param event - the `assistant/message` event.
   */
  #onAssistantMessage(sessionId, event) {
    const voice = this.config.voice
    if (!voice.enabled || !voice.speakReplies) return
    const text = textOfContent(event.data?.message?.content)
    if (text.length === 0) return
    this.lastReply = text
    const utterances = toUtterances(text, voice.maxChars)
    this.bridge.publish('reply', {
      sessionId,
      turn: event.data?.turn,
      step: event.data?.step,
      interrupted: event.data?.interrupted === true,
      text,
      utterances,
      speak: utterances.length > 0,
    })
  }

  /**
   * Resolve the agent the pet speaks to and speaks for.
   * @returns the target agent, or undefined when the pet has no conversation.
   */
  targetAgent() {
    const mode = this.config.session.mode
    if (mode === 'none') return undefined
    if (mode === 'pinned') return this.ctx.agents.get(this.config.session.id)
    if (this.#lastSessionId !== undefined) {
      const active = this.ctx.agents.get(this.#lastSessionId)
      if (active !== undefined) return active
    }
    const agents = this.ctx.agents.list()
    // `session.mode: active` before anything has happened yet: adopt the first
    // live agent so the very first pet message already has somewhere to land.
    return agents.length > 0 ? agents[0] : undefined
  }

  /**
   * Append the user's line to the target agent as an ordinary user message.
   *
   * The message object is built by hand instead of importing
   * `@deepseek-ai/dsh-llm#createUserMessage`: the plugin ships as plain ESM with
   * no build step and no runtime dependency on a second copy of the harness
   * packages. The field shape is identical to what `createUserMessage` produces
   * (`{ role: 'user', content, source, id: randomUUID() }`); the only difference
   * is that this object is not deep-frozen, which nothing on the follow-up path
   * requires.
   * @param text - the user's text.
   * @param source - provenance tag recorded on the publish, not on the message.
   * @returns a receipt describing where the message landed.
   * @throws {Error} when the pet has no target conversation.
   */
  sendUserText(text, source = 'user') {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed.length === 0) throw new Error('the message is empty')
    const agent = this.targetAgent()
    if (agent === undefined) {
      throw new Error('no active DSH session to talk to — open a conversation first')
    }
    const message = {
      id: uuid(),
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      source: { kind: 'user' },
    }
    agent.followup(message)
    this.#lastSessionId = agent.id
    this.bridge.publish('user', { sessionId: agent.id, text: trimmed, via: source })
    return { sessionId: agent.id, messageId: message.id }
  }

  /**
   * The snapshot the pet window reads on connect.
   * @returns session and voice facts the renderer needs before its first event.
   */
  snapshot() {
    const agent = this.targetAgent()
    const voice = this.config.voice
    return {
      sessionId: agent?.id ?? null,
      lastReply: this.lastReply,
      running: agent !== undefined && this.#running.has(agent.id),
      voice: {
        enabled: voice.enabled,
        // `browser` synthesizes in the window; `http` asks the host for a clip.
        engine: voice.engine,
        lang: voice.lang,
        voice: voice.voice,
        rate: voice.rate,
        pitch: voice.pitch,
        volume: voice.volume,
        // The window chunks provider requests itself, so it needs the budget.
        maxChars: voice.maxChars,
        // Empty means "synthesize the reply"; a path boots the window in effect
        // mode and every reply plays that clip instead.
        effectFile: voice.effectFile,
      },
      asr: {
        enabled: this.config.asr.enabled,
        lang: this.config.asr.lang,
        engine: this.config.asr.engine,
        // The window enforces its own recording cap, so it needs the value.
        maxSeconds: this.config.asr.maxSeconds,
      },
      window: this.config.window,
      now: new Date().toISOString(),
    }
  }
}

/**
 * Human-readable label for one tool name, used in the pet's status line.
 * @param name - the registered tool name.
 * @returns a bounded label.
 */
export function toolLabel(name) {
  const text = typeof name === 'string' && name.length > 0 ? name : 'tool'
  return text.length <= TOOL_LABEL_MAX ? text : `${text.slice(0, TOOL_LABEL_MAX)}…`
}
