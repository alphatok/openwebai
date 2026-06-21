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

export interface RelayStatus {
  connected: boolean
  lastSeen: number | null
}

/**
 * WebSocket Relay Server - bidirectional bridge
 */
export class WebSocketRelay extends EventEmitter {
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private port: number
  private lastSeen: number | null = null
  private pingInterval: NodeJS.Timeout | null = null

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
        this.lastSeen = Date.now()

        ws.on('message', (raw) => {
          const rawStr = raw.toString()
          try {
            const msg = JSON.parse(rawStr)

            if (msg.type === 'ping') {
              this.lastSeen = Date.now()
              // pong
              ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
              return
            }

            if (msg.type === 'pong') {
              this.lastSeen = Date.now()
              return
            }

            if (msg.type === 'sse_data' || msg.type === 'fetch_data' || msg.type === 'fetch_done') {
              this.lastSeen = Date.now()
              console.log(`${TAG} Data: type=${msg.type}, url=${msg.url?.slice(0, 60)}, len=${msg.data?.length || 0}`)
              this.emit('data', msg as InterceptedData)
            } else if (msg.type === 'command_response') {
              this.lastSeen = Date.now()
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

      // Setup heartbeat interval (check every 5s)
      this.pingInterval = setInterval(() => {
        if (this.client?.readyState === WebSocket.OPEN) {
          this.client.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
        }
      }, 5000)

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

  /** Get current relay status */
  getStatus(): RelayStatus {
    const isConnected = this.client?.readyState === WebSocket.OPEN
    const stale = this.lastSeen && (Date.now() - this.lastSeen > 90000)
    return {
      connected: isConnected && !stale,
      lastSeen: this.lastSeen,
    }
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
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
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
