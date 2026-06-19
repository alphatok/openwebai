/** 任务状态枚举 */
export const TaskStatus = {
  Queued: 'queued',
  Typing: 'typing',
  Generating: 'generating',
  Completed: 'completed',
  Failed: 'failed',
  Interrupted: 'interrupted',
} as const

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

/** OpenAI 兼容的消息格式 */
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Gateway 收到的请求 */
export interface ChatRequest {
  model: string
  messages: Message[]
  stream?: boolean
  temperature?: number
}

/** 调度器返回的任务结果 */
export interface TaskResult {
  taskId: string
  status: TaskStatus
  content?: string
  error?: AdapterErrorInfo
}

/** 错误信息（可序列化） */
export interface AdapterErrorInfo {
  code: AdapterErrorCode
  message: string
  recoverable: boolean
}

/** 适配器错误码 */
export type AdapterErrorCode =
  | 'CAPTCHA'
  | 'TIMEOUT'
  | 'SELECTOR_EXPIRED'
  | 'AUTH_FAILED'
  | 'NETWORK'
  | 'PAGE_CLOSED'

/** 浏览器任务（调度器内部使用） */
export interface BrowserTask {
  taskId: string
  siteId: string
  prompt: string
  priority: number
  createdAt: number
}
