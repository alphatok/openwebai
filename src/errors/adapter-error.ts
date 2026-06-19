import type { AdapterErrorCode } from '../types/task.js'

/** 适配器错误类 - 分类错误码 + 可恢复标记 */
export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

/** HTTP 错误响应格式 */
export interface HttpError {
  status: number
  body: {
    error: string
    recoverable?: boolean
  }
}

/** 将 AdapterError 映射为 HTTP 状态码和响应体 */
export function toHttpError(err: AdapterError): HttpError {
  switch (err.code) {
    case 'CAPTCHA':
      return { status: 409, body: { error: err.message, recoverable: true } }
    case 'AUTH_FAILED':
      return { status: 401, body: { error: err.message, recoverable: false } }
    case 'SELECTOR_EXPIRED':
      return { status: 503, body: { error: err.message, recoverable: false } }
    case 'TIMEOUT':
      return { status: 504, body: { error: err.message, recoverable: true } }
    case 'NETWORK':
      return { status: 502, body: { error: err.message, recoverable: true } }
    case 'PAGE_CLOSED':
      return { status: 500, body: { error: err.message, recoverable: false } }
    default:
      return { status: 500, body: { error: err.message } }
  }
}
