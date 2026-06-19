/** Task status enum */
export const TaskStatus = {
  Queued: 'queued',
  Typing: 'typing',
  Generating: 'generating',
  Completed: 'completed',
  Failed: 'failed',
  Interrupted: 'interrupted',
} as const

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

/** OpenAI-compatible message format */
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Request received by Gateway (OpenAI format) */
export interface ChatRequest {
  model: string
  messages: Message[]
  stream?: boolean
  temperature?: number
}

/** Anthropic Messages API request */
export interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  system?: string
}

/** Anthropic message (content can be string or content blocks) */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; source?: unknown }>
}

/** Task result returned by Scheduler */
export interface TaskResult {
  taskId: string
  status: TaskStatus
  content?: string
  error?: AdapterErrorInfo
}

/** Serializable error info */
export interface AdapterErrorInfo {
  code: AdapterErrorCode
  message: string
  recoverable: boolean
}

/** Adapter error codes */
export type AdapterErrorCode =
  | 'CAPTCHA'
  | 'TIMEOUT'
  | 'SELECTOR_EXPIRED'
  | 'AUTH_FAILED'
  | 'NETWORK'
  | 'PAGE_CLOSED'
  | 'RELAY_NOT_SET'
  | 'BROWSER_NOT_CONNECTED'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_FAILED'

/** Browser task (internal use by scheduler) */
export interface BrowserTask {
  taskId: string
  siteId: string
  prompt: string
  priority: number
  createdAt: number
}
