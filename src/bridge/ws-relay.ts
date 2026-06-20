import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'

const TAG = '[WSRelay]'

export interface InterceptedData {
  type: 'sse_data' | 'fetch_data' | 'fetch_done' | 'ping'
  url: string
  data: string
  ts: number
  tabId?: number
}

export interface CommandResponse {
  type: 'command_response'
  requestId: string
  ok: boolean
  error?: string
  data?: unknown
  url?: string
  title?: string
}

/**
 * WebSocket Relay Server - bidirectional bridge
 * Extension connects here and:
 * - Forwards intercepted SSE/fetch data from DeepSeek page
 * - Receives commands from Node.js (input_text, click_submit, etc.)
 */
export class WebSocketRelay extends EventEmitter {
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private port: number

  constructor(port = 18765) {
    super()
    this.port = port
  }

  /** Start relay server */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port })

      this.wss.on('connection', (ws, req) => {
        console.log(`${TAG} Extension connected from ${req.socket.remoteAddress}`)
        this.client = ws

        ws.on('message', (raw) => {
          const rawStr = raw.toString()
          try {
            const msg = JSON.parse(rawStr)

            if (msg.type === 'ping') return

            if (msg.type === 'sse_data' || msg.type === 'fetch_data' || msg.type === 'fetch_done') {
              console.log(`${TAG} Data: type=${msg.type}, url=${msg.url?.slice(0, 60)}, len=${msg.data?.length || 0}`)
              this.emit('data', msg as InterceptedData)
            } else if (msg.type === 'command_response') {
              console.log(`${TAG} Command response: requestId=${msg.requestId}, ok=${msg.ok}`)
              this.emit('command_response', msg as CommandResponse)
            }
          } catch (err) {
            console.warn(`${TAG} Parse error:`, rawStr.slice(0, 100))
          }
        })

        ws.on('close', () => {
          console.log(`${TAG} Extension disconnected`)
          this.client = null
          this.emit('disconnect')
        })

        ws.on('error', (err) => {
          console.warn(`${TAG} WebSocket error:`, err.message)
          this.client = null
          this.emit('disconnect')
        })
      })

      this.wss.on('listening', () => {
        console.log(`${TAG} Listening on ws://localhost:${this.port}`)
        resolve()
      })

      this.wss.on('error', (err) => {
        console.error(`${TAG} Server error:`, err.message)
        reject(err)
      })
    })
  }

  /** Whether extension client is connected */
  isClientConnected(): boolean {
    return this.client?.readyState === WebSocket.OPEN
  }

  /** Send a command to the extension (input_text, click_submit, etc.) */
  sendCommand(cmd: string, data: unknown, requestId: string): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({ type: 'command', cmd, data, requestId })
      this.client.send(msg)
      console.log(`${TAG} Sent command: ${cmd} (requestId=${requestId})`)
    } else {
      console.warn(`${TAG} Cannot send command: extension not connected`)
    }
  }

  /** Stop relay server */
  async stop(): Promise<void> {
    if (this.client) {
      this.client.close()
      this.client = null
    }
    if (this.wss) {
      return new Promise((resolve) => {
        this.wss!.close(() => {
          this.wss = null
          console.log(`${TAG} Stopped`)
          resolve()
        })
      })
    }
  }
}
