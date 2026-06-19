/** SSE stream response chunk */
export interface StreamChunk {
  id: string
  choices: Array<{
    delta: { content?: string }
    finish_reason: 'stop' | null
  }>
}

/** OpenAI-compatible chat completion response */
export interface ChatResponse {
  id: string
  object: 'chat.completion'
  model: string
  choices: Array<{
    message: { role: string; content: string }
    finish_reason: string
  }>
}
