/**
 * Turning model output into something worth saying out loud.
 *
 * A settled assistant reply is Markdown aimed at a reader: fenced code, inline
 * code, tables, links, and file paths. Spoken verbatim it is noise, so this
 * module strips what cannot be voiced, keeps the prose, and splits the result
 * into utterance-sized chunks. Pure functions only — the pet renderer receives
 * the chunks and owns the actual synthesizer.
 *
 * @module dsh-whale-pet/src/speech
 */

/** Opening or closing fence of a fenced code block. */
const FENCE = /^\s*(?:```|~~~)/
/** Markdown link: `[label](target)` keeps the label. */
const LINK = /\[([^\]]*)\]\(([^)]*)\)/gu
/** Bare URL, which a synthesizer would spell out character by character. */
const URL = /\bhttps?:\/\/\S+/gu
/** Inline code span. */
const INLINE_CODE = /`([^`]*)`/gu
/** Leading Markdown block markers: headings, quotes, list bullets, task boxes. */
const BLOCK_MARKER = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/u
/** Emphasis and strikethrough runs. */
const EMPHASIS = /(\*\*|__|\*|_|~~)/gu
/** Emoji and pictographs, which a synthesizer either skips or mispronounces. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu
/** A run of three or more identical punctuation marks. */
const PUNCT_RUN = /([。！？!?.,；;：:])\1{2,}/gu

/** One line that carries no speech: a table row, a rule, or a bare path list. */
const NOISE_LINE = /^\s*(?:\|.*\||[-=]{3,}|\.{3,})\s*$/u

/**
 * Strip everything from Markdown that cannot be voiced, keeping sentences.
 * @param markdown - raw assistant text.
 * @returns plain prose with fenced code and structural noise removed.
 */
export function cleanForSpeech(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return ''
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const kept = []
  let inFence = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence
      // A fenced block is announced once so the listener knows something was skipped.
      if (!inFence && kept[kept.length - 1] !== '\u0000CODE') kept.push('\u0000CODE')
      continue
    }
    if (inFence) continue
    if (NOISE_LINE.test(line)) continue
    kept.push(line.replace(BLOCK_MARKER, ''))
  }
  const joined = kept.join('\n')
  const withoutCodeRuns = joined
    // Collapse a run of skipped code blocks into a single spoken note.
    .replace(/(?:\u0000CODE\n?)+/gu, '（代码块，略过）')
  const plain = withoutCodeRuns
    .replace(LINK, '$1')
    .replace(URL, '')
    .replace(INLINE_CODE, (_match, code) => (code.length <= 24 ? ` ${code} ` : '（代码，略过）'))
    .replace(EMPHASIS, '')
    .replace(EMOJI, '')
    .replace(PUNCT_RUN, '$1')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{2,}/gu, '\n')
  return plain
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
    .trim()
}

/**
 * Split prose into utterance-sized chunks at sentence boundaries.
 *
 * A chunk never ends mid-sentence unless that single sentence already exceeds
 * the limit, in which case it is cut at the last comma or whitespace before the
 * limit. Whitespace inside a sentence is preserved.
 * @param text - prose already cleaned by {@link cleanForSpeech}.
 * @param maxChars - hard upper bound for one chunk.
 * @returns ordered, non-empty chunks.
 */
export function splitSentences(text, maxChars) {
  // Anything below a few characters cannot hold a sentence; the floor keeps a
  // nonsensical caller from producing one chunk per character.
  const limit = Number.isFinite(maxChars) && maxChars >= 4 ? Math.floor(maxChars) : 240
  if (typeof text !== 'string' || text.trim().length === 0) return []
  const chunks = []
  let current = ''
  // A terminator keeps its own character; the newline after prose is a boundary too.
  const parts = text.split(/(?<=[。！？!?；;])\s*|\n+/u).filter(part => part.trim().length > 0)
  for (const raw of parts) {
    const piece = raw.trim()
    if (piece.length === 0) continue
    if (current.length === 0) {
      if (piece.length <= limit) {
        current = piece
        continue
      }
      chunks.push(...hardSplit(piece, limit))
      continue
    }
    if (current.length + piece.length + 1 <= limit) {
      current = `${current}${piece}`
      continue
    }
    chunks.push(current)
    current = ''
    if (piece.length <= limit) {
      current = piece
    } else {
      const pieces = hardSplit(piece, limit)
      chunks.push(...pieces.slice(0, -1))
      current = pieces[pieces.length - 1] ?? ''
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks.filter(chunk => chunk.length > 0)
}

/**
 * Cut one over-long sentence at a natural break, never exceeding the limit.
 * @param text - the sentence to cut.
 * @param limit - maximum chunk length.
 * @returns one or more chunks whose concatenation preserves every character.
 */
function hardSplit(text, limit) {
  const out = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const breakAt = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf('、'),
      window.lastIndexOf(','),
      window.lastIndexOf(' '),
    )
    const cut = breakAt > limit * 0.5 ? breakAt + 1 : limit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) out.push(rest)
  return out.filter(chunk => chunk.length > 0)
}

/**
 * Prepare one assistant reply for the synthesizer.
 * @param markdown - raw assistant text.
 * @param maxChars - per-utterance character budget.
 * @returns ordered utterance chunks; empty when the reply has nothing to say.
 */
export function toUtterances(markdown, maxChars) {
  return splitSentences(cleanForSpeech(markdown), maxChars)
}

/**
 * Collect the visible text of one assembled assistant message content array.
 * @param content - the message's content blocks.
 * @returns concatenated text blocks, ignoring non-text blocks.
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (isPlainTextBlock(block)) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Whether one content block is a plain text block.
 * @param block - candidate block.
 * @returns true for `{ type: 'text', text }`.
 */
function isPlainTextBlock(block) {
  return typeof block === 'object'
    && block !== null
    && block.type === 'text'
    && typeof block.text === 'string'
}
