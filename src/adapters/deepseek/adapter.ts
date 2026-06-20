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
    '/settings/report', 'pow_challenge', '/chat_session/create',
    '/user/', '/auth/', 'gator.volces.com', 'hif-dliq',
  ]

  private logDir = path.join(process.cwd(), 'logs')
  private logFile = path.join(this.logDir, `sse-log-${Date.now()}.txt`)
  private rawLogFile = path.join(this.logDir, `raw-log-${Date.now()}.txt`)

  // Incremental parsing state: track how many rawChunks have been parsed
  private parsedChunkIndex = 0
  private baseline = ''          // F4 snapshot content (基线)
  private incremental = ''       // F1/F2 accumulated tokens (增量)

  constructor() {
    this.cleanupOldLogs('sse-log-', 10)
    this.cleanupOldLogs('raw-log-', 10)
  }

  /** Remove old log files, keeping only the most recent `max` files with the given prefix */
  private cleanupOldLogs(prefix: string, max: number): void {
    try {
      if (!fs.existsSync(this.logDir)) return
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.txt'))
        .map(f => ({ name: f, path: path.join(this.logDir, f), mtime: fs.statSync(path.join(this.logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const file of files.slice(max)) {
        fs.unlinkSync(file.path)
        console.log(`${TAG} Cleaned old log: ${file.name}`)
      }
    } catch { /* ignore */ }
  }

  private writeLog(tag: string, data: string): void {
    try {
      if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true })
      fs.appendFileSync(this.logFile, `[${tag}] ${data}\n`)
    } catch { /* ignore */ }
  }

  /** Write raw intercepted data — no filtering */
  private writeRawLog(entry: string): void {
    try {
      if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true })
      fs.appendFileSync(this.rawLogFile, entry)
    } catch { /* ignore */ }
  }

  /** Process intercepted SSE/fetch data from the extension via relay */
  private handleRelayData(msg: InterceptedData): void {
    const url = msg.url || ''
    console.log(`${TAG} onDataHandler: type=${msg.type}, url=${url.slice(0, 80)}, len=${(msg.data||'').length}`)

    // === Write RAW log (before any filtering) ===
    const ts = new Date().toISOString()
    const dataStr = msg.data || ''
    this.writeRawLog(
      `[${ts}] ${msg.type} | ${url}\n` +
      (dataStr ? dataStr + '\n' : '') +
      (msg.type === 'fetch_done' ? '---\n' : '')
    )

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

      // Accept ALL POST response data (inject.js already removed frontend filtering)
      if (this.rawChunks.length === 0) {
        console.log(`${TAG} ✅ Chat stream started! url=${url.slice(0, 80)}`)
        this.chatStreamUrl = url
        this.logFile = path.join(this.logDir, `sse-log-${Date.now()}.txt`)
        this.writeLog('SESSION', `Chat stream started: ${url}`)
      }
      this.writeLog('CHUNK', `[${url}] ${data.slice(0, 300)}`)
      this.rawChunks.push(data)
      this.tryParseContent()
    } else if (msg.type === 'fetch_done') {
      // Only mark done when this URL matches the active chat stream
      if (url === this.chatStreamUrl && this.rawChunks.length > 0) {
        this.done = true
        console.log(`${TAG} ✅ Chat stream DONE, chunks=${this.rawChunks.length}, content=${this.capturedContent.length}`)
        this.tryParseContent()
      } else {
        console.log(`${TAG} Skip fetch_done (no chat data yet): url=${url.slice(0, 80)}`)
      }
    }
  }

  private chatStreamUrl = ''

  /** Snapshot of content after completion — protects against concurrent relay data overwriting */
  private completedContent = ''

  /** Streaming callback — called with full content whenever it changes */
  private streamCallback: ((fullContent: string) => void) | null = null

  /** Register a callback that fires whenever new content is parsed (for real-time streaming) */
  setStreamCallback(cb: ((fullContent: string) => void) | null): void {
    this.streamCallback = cb
  }

  /** Re-parse accumulated chunks whenever new data arrives (incremental) */
  private tryParseContent(): void {
    // Only parse newly arrived rawChunks, append their text to this.incremental
    if (this.parsedChunkIndex < this.rawChunks.length) {
      const newChunks = this.rawChunks.slice(this.parsedChunkIndex)
      this.parsedChunkIndex = this.rawChunks.length
      this.parseNewChunks(newChunks)
    }
    this.capturedContent = this.baseline + this.incremental
    // Notify streaming callback if content changed
    if (this.streamCallback && this.capturedContent.length > 0) {
      this.streamCallback(this.capturedContent)
    }
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
    this.parsedChunkIndex = 0
    this.baseline = ''
    this.incremental = ''
    this.completedContent = ''
    // Note: streamCallback is NOT reset here — it's managed by the gateway

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
        this.completedContent = this.capturedContent
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
          this.completedContent = this.capturedContent
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

    this.completedContent = this.capturedContent
    console.warn(`${TAG} TIMEOUT after ${timeout}ms. content=${this.capturedContent.length} chars`)
  }

  /** Incrementally parse new chunks only — appends to this.baseline / this.incremental */
  private parseNewChunks(chunks: string[]): void {
    const body = chunks.join('\n')
    const lines = body.split('\n')
    let dataLineCount = 0

    const isStatusKeyword = (s: string): boolean => {
      const statusWords = ['FINISHED', 'DONE', 'WIP', 'STARTED', 'PAUSED', 'TERMINATED', 'ABORTED', 'CANCELED']
      return statusWords.includes(s.trim().toUpperCase())
    }

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      dataLineCount++
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') continue

      try {
        const chunk = JSON.parse(jsonStr)
        const keys = Object.keys(chunk)

        // Skip metadata: request_message_id, click_behavior, etc.
        if (keys.includes('request_message_id') || keys.includes('click_behavior') || keys.includes('auto_resume')) {
          continue
        }

        // F4: response snapshot — set baseline from fragments
        const fragments = chunk?.v?.response?.fragments as Array<{ type: string; content: string }> | undefined
        if (fragments) {
          for (const f of fragments) {
            if ((f.type === 'RESPONSE' || f.type === 'TEXT') && f.content) {
              if (f.content.length > this.baseline.length) {
                this.writeLog('PARSE-F4', `fragment type=${f.type} len=${f.content.length}`)
                this.baseline = f.content
              }
            }
          }
          const rc = chunk?.v?.response?.content
          if (rc && typeof rc === 'string' && rc.length > this.baseline.length) {
            this.baseline = rc
          }
          continue
        }

        // F2: path-based patch — only APPEND on content path
        if (chunk.o === 'APPEND' && typeof chunk.v === 'string') {
          const p = String(chunk.p || '')
          this.writeLog('PARSE-F2', `p="${p}" o=APPEND v="${chunk.v.slice(0,20)}"`)
          if (p.includes('content') || p.includes('fragment') || p === '') {
            this.incremental += chunk.v
          }
          continue
        }

        // F2b: SET on status path — skip (not content)
        if (chunk.o === 'SET') {
          continue
        }

        // F3: BATCH ops — only extract APPEND on content paths
        if (chunk.o === 'BATCH' && Array.isArray(chunk.v)) {
          this.writeLog('PARSE-F3', `BATCH ops=${chunk.v.length}`)
          for (const op of chunk.v) {
            if (op.o === 'SET') continue
            if (op.o === 'APPEND' && typeof op.v === 'string') {
              const p = String(op.p || '')
              if (p.includes('content') || p.includes('fragment') || p === '') {
                this.incremental += op.v
              }
            }
            // F3b: APPEND with fragment array — e.g. [{"type":"RESPONSE","content":"今天"}]
            if (op.o === 'APPEND' && Array.isArray(op.v)) {
              for (const frag of op.v) {
                if (frag && typeof frag === 'object' && frag.content) {
                  if (frag.content.length > this.baseline.length) {
                    this.writeLog('PARSE-F3b', `fragment type=${frag.type} content="${frag.content.slice(0, 30)}" len=${frag.content.length}`)
                    this.baseline = frag.content
                  }
                }
              }
            }
          }
          continue
        }

        // F1: simple token {"v": "text"} — most common
        if (typeof chunk.v === 'string' && !chunk.o && !chunk.p && !isStatusKeyword(chunk.v)) {
          this.incremental += chunk.v
          this.writeLog('PARSE-F1', `v="${chunk.v.length > 5 ? chunk.v.slice(0, 30) + '...' : chunk.v}" accumulated=${this.baseline.length + this.incremental.length}`)
          continue
        }

        // Skip keepalive / status keywords
        if (chunk.updated_at !== undefined) continue
        if (typeof chunk.v === 'string' && isStatusKeyword(chunk.v)) continue

        // OpenAI-style fallback
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta) { this.incremental += delta; continue }
        if (typeof chunk.content === 'string') { this.incremental += chunk.content; continue }

        this.writeLog('PARSE-SKIP', `keys=${keys.join(',')} (non-content)`)

      } catch (e: unknown) {
        this.writeLog('PARSE-ERROR', `err=${e instanceof Error ? e.message : String(e)} line=${line.slice(0, 100)}`)
      }
    }

    const total = this.baseline.length + this.incremental.length
    this.writeLog('RESULT', `baseline=${this.baseline.length} incremental=${this.incremental.length} total=${total}`)
    if (total > 0) console.log(`${TAG} parseChunks: +${dataLineCount} dataLines → total=${total} chars, preview="${(this.baseline + this.incremental).slice(0, 80)}"`)
  }

  async extractOutput(_prompt?: string): Promise<string> {
    // Use the snapshot from waitForCompletion to avoid concurrent relay data overwriting
    const content = this.completedContent || this.capturedContent
    const trimmed = content.trim()
    console.log(`${TAG} extractOutput: capturedContent=${this.capturedContent.length} completedContent=${this.completedContent.length} → ${trimmed.length} chars → "${trimmed.slice(0, 100)}"`)
    return trimmed
  }

  isGenerating(): boolean {
    return !this.done && this.rawChunks.length > 0
  }

  hasCaptcha(): boolean {
    return false
  }

  // === Session management commands ===

  /** Ensure the localhost:3000 dashboard tab is open (handled by background.js) */
  async ensureDashboard(): Promise<void> {
    console.log(`${TAG} ensureDashboard: checking/opening localhost:3000`)
    const resp = await this.sendCommand('open_dashboard', {}, 10000)
    if (!resp.ok) {
      console.warn(`${TAG} ensureDashboard: failed - ${resp.error}`)
    }
  }

  /** List recent chat sessions */
  async listSessions(limit = 10): Promise<unknown> {
    console.log(`${TAG} listSessions: limit=${limit}`)
    const resp = await this.sendCommand('list_sessions', { limit }, 15000)
    if (!resp.ok) throw new AdapterError('COMMAND_FAILED', resp.error || 'List sessions failed', true)
    return resp.data
  }

  /** Delete a chat session by ID */
  async deleteSession(sessionId: string): Promise<unknown> {
    console.log(`${TAG} deleteSession: id=${sessionId}`)
    const resp = await this.sendCommand('delete_session', { sessionId }, 10000)
    if (!resp.ok) throw new AdapterError('COMMAND_FAILED', resp.error || 'Delete session failed', true)
    return resp.data
  }

  /** Create a new chat session */
  async newSession(): Promise<unknown> {
    console.log(`${TAG} newSession`)
    const resp = await this.sendCommand('new_session', {}, 15000)
    if (!resp.ok) throw new AdapterError('COMMAND_FAILED', resp.error || 'New session failed', true)
    return resp.data
  }

  /** Get messages from a specific session */
  async getSessionMessages(sessionId: string): Promise<unknown> {
    console.log(`${TAG} getSessionMessages: id=${sessionId}`)
    const resp = await this.sendCommand('get_session_messages', { sessionId }, 15000)
    if (!resp.ok) throw new AdapterError('COMMAND_FAILED', resp.error || 'Get session messages failed', true)
    return resp.data
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
