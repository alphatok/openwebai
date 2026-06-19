import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import { WebSocketRelay } from '../../bridge/ws-relay.js'
import type { InterceptedData, CommandResponse } from '../../bridge/ws-relay.js'
import configJson from './config.json' with { type: 'json' }
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'

const TAG = '[DS]'

/**
 * DeepSeek site adapter — Chrome Extension + WebSocket Relay approach.
 *
 * Strategy:
 * 1. Chrome Extension (inject.js) intercepts EventSource/fetch on the DeepSeek page
 * 2. Data flows: inject.js → content.js → background.js → WebSocket → ws-relay → adapter
 * 3. Adapter accumulates SSE chunks and parses DeepSeek's SSE format
 * 4. No Playwright request interception or parallel fetch needed
 */
export class DeepSeekAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private capturedContent = ''
  private rawChunks: string[] = []
  private done = false
  private pendingCommandResponse: Map<string, (resp: CommandResponse) => void> = new Map()

  // Relay reference
  private relay: WebSocketRelay | null = null
  private onDataHandler: ((msg: InterceptedData) => void) | null = null
  private onCommandResponseHandler: ((resp: CommandResponse) => void) | null = null

  /** Attach the WebSocket relay to receive intercepted data */
  setRelay(relay: WebSocketRelay): void {
    console.log(`${TAG} setRelay() called, relay isClientConnected=${relay.isClientConnected()}`)
    this.relay = relay

    // Subscribe to relay data
    if (!this.onDataHandler) {
      this.onDataHandler = (msg: InterceptedData) => {
        console.log(`${TAG} onDataHandler triggered, msg type=${msg.type}, url=${msg.url?.slice(0, 60)}`)
        this.handleRelayData(msg)
      }
      this.relay.on('data', this.onDataHandler)
    }

    // Subscribe to command responses
    if (!this.onCommandResponseHandler) {
      this.onCommandResponseHandler = (resp: CommandResponse) => {
        console.log(`${TAG} onCommandResponseHandler triggered, requestId=${resp.requestId}, ok=${resp.ok}`)
        const resolver = this.pendingCommandResponse.get(resp.requestId)
        if (resolver) {
          this.pendingCommandResponse.delete(resp.requestId)
          resolver(resp)
        }
      }
      this.relay.on('command_response', this.onCommandResponseHandler)
    }
  }

  // Non-chat URLs to ignore (init/tracking APIs)
  private static readonly SKIP_URLS = [
    '/settings/report', '/pow_challenge', '/chat_session/create',
    '/user/', '/auth/', 'gator.volces.com', 'hif-dliq',
  ]

  /** Check if data chunk looks like SSE chat data */
  private looksLikeChatData(data: string): boolean {
    return data.includes('data:') && (
      data.includes('"choices"') ||
      data.includes('"delta"') ||
      data.includes('"content"') ||
      data.includes('"fragments"') ||
      data.includes('"response"') ||
      data.includes('"v":') ||
      data.includes('[DONE]')
    )
  }

  private logSessionId = Date.now().toString()
  private logFile = path.join(process.cwd(), `sse-log-${Date.now()}.txt`)

  private writeLog(tag: string, data: string): void {
    try {
      fs.appendFileSync(this.logFile, `[${tag}] ${data}\n`)
    } catch { /* ignore */ }
  }

  /** Process intercepted SSE/fetch data from the extension via relay */
  private handleRelayData(msg: InterceptedData): void {
    const url = msg.url || ''
    console.log(`${TAG} onDataHandler: type=${msg.type}, url=${url.slice(0, 80)}, len=${(msg.data||'').length}`)

    // Ignore non-DeepSeek URLs (absolute non-deepseek)
    if (url.startsWith('http') && !url.includes('deepseek.com')) {
      console.log(`${TAG} Skip: non-deepseek absolute url`)
      return
    }

    // Ignore known non-chat APIs
    if (DeepSeekAdapter.SKIP_URLS.some(p => url.includes(p))) {
      console.log(`${TAG} Skip: known non-chat url`)
      return
    }

    if (msg.type === 'sse_data') {
      console.log(`${TAG} SSE chunk (${(msg.data||'').length}b): ${(msg.data || '').slice(0, 100)}`)
      this.rawChunks.push(msg.data)
      this.tryParseContent()
    } else if (msg.type === 'fetch_data') {
      const data = msg.data || ''
      if (!data) return
      console.log(`${TAG} Fetch chunk (${data.length}b): ${data.slice(0, 100)}`)

      // Accept if looks like SSE chat data, or we already started collecting
      if (this.looksLikeChatData(data) || this.rawChunks.length > 0) {
        if (this.rawChunks.length === 0) {
          console.log(`${TAG} ✅ Chat stream started! url=${url.slice(0, 80)}`)
          this.chatStreamUrl = url
          this.logFile = path.join(process.cwd(), `sse-log-${Date.now()}.txt`)
          this.writeLog('SESSION', `Chat stream started: ${url}`)
        }
        this.writeLog('CHUNK', data)
        this.rawChunks.push(data)
        this.tryParseContent()
      } else {
        console.log(`${TAG} Skip: no SSE pattern in data`)
      }
    } else if (msg.type === 'fetch_done') {
      const isChatDone = !this.chatStreamUrl || url === this.chatStreamUrl || this.rawChunks.length > 0
      if (isChatDone && this.rawChunks.length > 0) {
        this.done = true
        console.log(`${TAG} ✅ Chat stream DONE, chunks=${this.rawChunks.length}, content=${this.capturedContent.length}`)
        this.tryParseContent()
      } else {
        console.log(`${TAG} Skip fetch_done (no chat data yet): url=${url.slice(0, 80)}`)
      }
    }
  }

  private chatStreamUrl = ''

  /** Re-parse accumulated chunks whenever new data arrives */
  private tryParseContent(): void {
    const fullBody = this.rawChunks.join('\n')
    this.capturedContent = this.parseDeepSeekSSE(fullBody)
  }

  /** Send a command to the browser and wait for response */
  private async sendCommand(cmd: string, data?: unknown, timeout = 10000): Promise<CommandResponse> {
    if (!this.relay) {
      throw new AdapterError('RELAY_NOT_SET', 'WebSocket relay not configured', false)
    }

    if (!this.relay.isClientConnected()) {
      throw new AdapterError('BROWSER_NOT_CONNECTED', 'Browser extension not connected', false)
    }

    const requestId = uuidv4()
    console.log(`${TAG} Sending command: ${cmd}, requestId=${requestId}`)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommandResponse.delete(requestId)
        reject(new AdapterError('COMMAND_TIMEOUT', `Command ${cmd} timed out after ${timeout}ms`, true))
      }, timeout)

      this.pendingCommandResponse.set(requestId, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })

      this.relay!.sendCommand(cmd, data, requestId)
    })
  }

  async inputText(prompt: string): Promise<void> {
    console.log(`${TAG} inputText: "${prompt.slice(0, 60)}"`)

    const resp = await this.sendCommand('input_text', prompt)
    if (!resp.ok) {
      throw new AdapterError('COMMAND_FAILED', `Input text failed: ${resp.error}`, false)
    }

    console.log(`${TAG} Typing done`)
  }

  async clickSubmit(): Promise<void> {
    this.capturedContent = ''
    this.rawChunks = []
    this.done = false
    this.chatStreamUrl = ''

    console.log(`${TAG} Submitting (Enter key)...`)

    const resp = await this.sendCommand('click_submit')
    if (!resp.ok) {
      throw new AdapterError('COMMAND_FAILED', `Click submit failed: ${resp.error}`, false)
    }

    console.log(`${TAG} Enter pressed — waiting for extension to intercept SSE`)
  }

  async waitForCompletion(): Promise<void> {
    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs
    const start = Date.now()

    console.log(`${TAG} waitForCompletion: waiting for extension SSE/fetch data...`)

    while (Date.now() - start < timeout) {
      // Stream finished → done
      if (this.done) {
        console.log(`${TAG} Stream done, content=${this.capturedContent.length} chars`)
        return
      }

      // Content is growing → wait for it to stabilize
      if (this.capturedContent.length > 0) {
        let prev = this.capturedContent.length
        let stable = 0

        while (stable < 3 && !this.done && Date.now() - start < timeout) {
          await this.sleep(interval)
          const curr = this.capturedContent.length
          if (curr === prev) {
            stable++
          } else {
            console.log(`${TAG} Content growing: ${prev}→${curr}`)
            stable = 0
            prev = curr
          }
        }

        if (this.done || stable >= 3) {
          console.log(`${TAG} Content stable at ${this.capturedContent.length} chars`)
          return
        }
      }

      const elapsed = Math.round((Date.now() - start) / 1000)
      if (elapsed % 5 === 0 && elapsed > 0) {
        console.log(`${TAG} Waiting... ${elapsed}s, chunks=${this.rawChunks.length}`)
      }

      await this.sleep(interval)
    }

    console.warn(`${TAG} TIMEOUT after ${timeout}ms. content=${this.capturedContent.length} chars`)
  }

  /** Parse DeepSeek SSE format from accumulated body */
  private parseDeepSeekSSE(body: string): string {
    const lines = body.split('\n')
    let accumulated = ''
    let lastFullContent = ''
    let lineCount = 0
    let dataLineCount = 0

    for (const line of lines) {
      lineCount++
      if (!line.startsWith('data: ')) continue
      dataLineCount++
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') continue

      try {
        const chunk = JSON.parse(jsonStr)
        const keys = Object.keys(chunk).join(',')

        // Format 1: {"v": "text"} — simple token
        if (typeof chunk.v === 'string') {
          accumulated += chunk.v
          this.writeLog('PARSE-F1', `v="${chunk.v}" accumulated=${accumulated.length}`)
          continue
        }

        // Format 2: {"p": "...", "o": "APPEND", "v": "text"}
        if (chunk.o === 'APPEND' && typeof chunk.v === 'string') {
          const p = String(chunk.p || '')
          this.writeLog('PARSE-F2', `p="${p}" o=APPEND v="${chunk.v}"`)
          if (p.includes('content') || p.includes('fragment') || p === '') {
            accumulated += chunk.v
          }
          continue
        }

        // Format 3: {"o": "BATCH", "v": [...]}
        if (chunk.o === 'BATCH' && Array.isArray(chunk.v)) {
          this.writeLog('PARSE-F3', `BATCH ops=${chunk.v.length}`)
          for (const op of chunk.v) {
            if (op.o === 'APPEND' && typeof op.v === 'string') {
              const p = String(op.p || '')
              if (p.includes('content') || p.includes('fragment') || p === '') {
                accumulated += op.v
              }
            }
          }
          continue
        }

        // Format 4: full response object
        const fragments = chunk?.v?.response?.fragments as Array<{ type: string; content: string }> | undefined
        if (fragments) {
          for (const f of fragments) {
            if ((f.type === 'RESPONSE' || f.type === 'TEXT') && f.content) {
              if (f.content.length > lastFullContent.length) {
                this.writeLog('PARSE-F4', `fragment type=${f.type} len=${f.content.length}`)
                lastFullContent = f.content
              }
            }
          }
          const rc = chunk?.v?.response?.content
          if (rc && typeof rc === 'string' && rc.length > lastFullContent.length) {
            lastFullContent = rc
          }
          continue
        }

        // OpenAI-style fallback
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta) { accumulated += delta; continue }
        if (typeof chunk.content === 'string') { accumulated += chunk.content; continue }

        // Unknown format — log for analysis
        this.writeLog('PARSE-UNKNOWN', `keys=${keys} json=${jsonStr.slice(0, 200)}`)

      } catch (e: unknown) {
        this.writeLog('PARSE-ERROR', `err=${e instanceof Error ? e.message : String(e)} line=${line.slice(0, 100)}`)
      }
    }

    const result = lastFullContent.length > accumulated.length ? lastFullContent : accumulated
    console.log(`${TAG} parseDeepSeekSSE: lines=${lineCount} dataLines=${dataLineCount} accumulated=${accumulated.length} full=${lastFullContent.length} → ${result.length} chars`)
    this.writeLog('RESULT', `accumulated=${accumulated.length} full=${lastFullContent.length} result=${result.length} preview="${result.slice(0, 100)}"`)
    if (result) console.log(`${TAG} Content preview: "${result.slice(0, 100)}"`)
    return result
  }

  async extractOutput(_prompt?: string): Promise<string> {
    const trimmed = this.capturedContent.trim()
    console.log(`${TAG} extractOutput: ${trimmed.length} chars → "${trimmed.slice(0, 100)}"`)
    return trimmed
  }

  isGenerating(): boolean {
    return !this.done && this.rawChunks.length > 0
  }

  hasCaptcha(): boolean {
    return false
  }

  /** Clean up relay listeners */
  destroy(): void {
    if (this.relay && this.onDataHandler) {
      this.relay.removeListener('data', this.onDataHandler)
      this.onDataHandler = null
    }
    if (this.relay && this.onCommandResponseHandler) {
      this.relay.removeListener('command_response', this.onCommandResponseHandler)
      this.onCommandResponseHandler = null
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
