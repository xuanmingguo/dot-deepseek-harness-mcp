import type { NativeHistoryRecord } from './native-control-facade.js'

/** Original native text blocks only; array positions remain native block indices. */
export function historyText(record: NativeHistoryRecord): { role: 'user' | 'assistant'; eventType: 'user/message' | 'assistant/message'; blocks: (string | null)[] } | null {
  const event = record.event
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return null
  const eventType = event.type
  const role = eventType === 'user/message' ? 'user' : 'assistant'
  if (!isRecord(event.data)) return null
  const data = event.data
  const message = isRecord(data.message) ? data.message : undefined
  if (role === 'user' && [data.source, message?.source].some(source => isRecord(source) && source.kind === 'plugin')) return null
  const content = message?.content ?? data.content
  const blocks = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : null)
      : content === undefined && typeof data.text === 'string' ? [data.text] : []
  return { role, eventType, blocks }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
