import type { AdapterErrorCode } from '../types/task.js'

/** Adapter error class with error codes and recoverable flag */
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

/** HTTP error response format */
export interface HttpError {
  status: number
  body: {
    error: string
    recoverable?: boolean
  }
}

/** Map AdapterError to HTTP status code and response body */
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
