/** SSE 流式响应块 */
export interface StreamChunk {
  id: string
  choices: Array<{
    delta: { content?: string }
    finish_reason: 'stop' | null
  }>
}

/** OpenAI 兼容的 chat completion 响应 */
export interface ChatResponse {
  id: string
  object: 'chat.completion'
  model: string
  choices: Array<{
    message: { role: string; content: string }
    finish_reason: string
  }>
}
