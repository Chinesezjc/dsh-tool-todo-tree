/**
 * Scripted LLM adapter for the integration test.
 *
 * Vendored rather than imported: the harness keeps this helper in
 * `packages/core/agent-loop/tests/`, and a published npm package ships only
 * `lib/`, so no released artifact exposes it. This copy carries just the three
 * pieces the integration spec drives — scripted text, scripted tool calls, and
 * the adapter itself — and drops the abort/max-tokens scaffolding that belongs
 * to the agent-loop's own suites.
 */
import type { GenerateOptions, LlmModelReasoningInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** One scripted assistant turn that only emits text. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * One scripted assistant turn that calls a tool, optionally preceded by text.
 * The arguments arrive as two deltas so the accumulator's join is exercised
 * rather than bypassed by a single whole-JSON chunk.
 * @param rawCallId - the call id the model reports.
 * @param name - the tool name to call.
 * @param args - the arguments object, serialized into the stream.
 * @param text - optional assistant text emitted before the call.
 * @returns the chunk sequence for one turn.
 */
export function toolCallResponse(rawCallId: string, name: string, args: object, text?: string): StreamChunk[] {
  const callId = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  const chunks: StreamChunk[] = []
  let index = 0
  if (text) {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index, id: callId, argumentsDelta: argumentsJson.slice(5) },
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** Mock adapter driven by a script: each model call consumes the next entry. */
export class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(
    private script: (StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]))[],
    private readonly reasoning?: LlmModelReasoningInfo,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
