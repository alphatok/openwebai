import type { Page } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/**
 * DeepSeek site adapter — passive SSE interception via CDP.
 * Uses Chrome DevTools Protocol to listen to network events without
 * interfering with the page's own request/response flow.
 */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  /** Captured SSE content from CDP network events */
  private capturedContent = ''
  /** CDP session for network monitoring */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cdpSession: any = null
  /** Request ID of the SSE stream we're tracking */
  private sseRequestId: string | null = null
  /** Whether CDP network monitoring is active */
  private monitorActive = false

  async init(page: Page): Promise<void> {
    await super.init(page)
  }

  /** Input text into the chat box */
  async inputText(prompt: string): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const input = await this.waitForSelector(this.config.selectors.input)
    if (!input) throw new AdapterError('SELECTOR_EXPIRED', `Invalid input selector: ${this.config.selectors.input}`, false)

    await input.click()
    await this.sleep(200)

    await this.page.keyboard.press('Control+a')
    await this.sleep(50)
    await this.page.keyboard.press('Backspace')
    await this.sleep(100)

    await this.typeWithHumanDelay(prompt)
  }

  /** Start CDP network monitoring, then click submit */
  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    this.capturedContent = ''
    this.sseRequestId = null

    await this.startCdpMonitoring()

    if (this.config.selectors.submitButton === 'Enter') {
      await this.page.keyboard.press('Enter')
    } else {
      const btn = await this.waitForSelector(this.config.selectors.submitButton)
      if (!btn) throw new AdapterError('SELECTOR_EXPIRED', `Invalid submit button selector: ${this.config.selectors.submitButton}`, false)
      await btn.click()
    }
  }

  /** Start passive CDP network monitoring — zero interference with page requests */
  private async startCdpMonitoring(): Promise<void> {
    if (!this.page || this.monitorActive) return
    this.monitorActive = true

    this.cdpSession = await this.page.context().newCDPSession(this.page)

    // Track which request ID is the SSE stream
    this.cdpSession.on('Network.responseReceived', (params: {
      requestId: string
      response: { url: string; headers: Record<string, string> }
    }) => {
      const url = params.response.url
      const contentType = params.response.headers?.['content-type']?.toLowerCase() || ''

      if (url.includes('deepseek.com') && url.includes('/chat/completion') && contentType.includes('event-stream')) {
        this.sseRequestId = params.requestId
        console.log(`[DeepSeekAdapter] CDP: tracking SSE stream requestId=${params.requestId} url=${url.slice(0, 80)}`)
      }
    })

    // Collect SSE data chunks as they arrive
    this.cdpSession.on('Network.dataReceived', (params: {
      requestId: string
      dataLength: number
      encodedDataLength: number
    }) => {
      if (params.requestId === this.sseRequestId) {
        // We can't get the raw bytes from this event alone.
        // Instead, we'll periodically read the response body via CDP.
      }
    })

    // When the SSE stream ends (loadingFinished), read the full body
    this.cdpSession.on('Network.loadingFinished', async (params: {
      requestId: string
      encodedDataLength: number
    }) => {
      if (params.requestId !== this.sseRequestId || !this.cdpSession) return

      console.log(`[DeepSeekAdapter] CDP: SSE stream finished, reading body...`)

      try {
        // Use CDP Network.getResponseBody to get the full SSE text
        const result = await this.cdpSession.send('Network.getResponseBody', {
          requestId: this.sseRequestId,
        })

        const body = 'body' in result ? result.body : ''
        const base64Encoded = 'base64Encoded' in result ? result.base64Encoded : false

        let sseText = body
        if (base64Encoded && typeof sseText === 'string') {
          sseText = Buffer.from(sseText, 'base64').toString('utf-8')
        }

        this.parseSSEBody(sseText)
        console.log(`[DeepSeekAdapter] CDP: captured ${this.capturedContent.length} chars`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[DeepSeekAdapter] CDP getResponseBody error: ${message}`)
      }
    })

    // Also handle loadingFailed as an edge case
    this.cdpSession.on('Network.loadingFailed', (params: {
      requestId: string
      errorText: string
    }) => {
      if (params.requestId === this.sseRequestId) {
        console.warn(`[DeepSeekAdapter] CDP: SSE stream failed: ${params.errorText}`)
      }
    })
  }

  /** Stop CDP monitoring */
  private async stopCdpMonitoring(): Promise<void> {
    if (!this.monitorActive) return
    this.monitorActive = false

    try {
      await this.cdpSession?.detach()
    } catch {
      // Ignore
    }
    this.cdpSession = null
    this.sseRequestId = null
  }

  /** Parse SSE (text/event-stream) body into capturedContent */
  private parseSSEBody(body: string): void {
    console.log(`[DeepSeekAdapter] Raw SSE body (${body.length} chars):\n${body.slice(0, 500)}\n---`)
    const lines = body.split('\n')
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6).trim()
        if (jsonStr === '[DONE]') continue

        try {
          const chunk = JSON.parse(jsonStr)
          const delta = chunk?.choices?.[0]?.delta?.content
          if (delta) {
            this.capturedContent += delta
            console.log(`[DeepSeekAdapter] delta: "${delta.slice(0, 60)}" (total: ${this.capturedContent.length})`)
          }
          const altContent = chunk?.content || chunk?.message?.content
          if (altContent && !delta) {
            this.capturedContent += altContent
          }
        } catch {
          // Ignore non-JSON
        }
      }
    }
  }

  /** Wait for generation to complete */
  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (this.capturedContent.length > 0) {
        let lastLen = this.capturedContent.length
        let stableCount = 0

        while (stableCount < 3 && Date.now() - startTime < timeout) {
          await this.sleep(interval)
          const currentLen = this.capturedContent.length
          if (currentLen === lastLen && currentLen > 0) {
            stableCount++
          } else {
            stableCount = 0
            lastLen = currentLen
          }
        }

        if (stableCount >= 3) {
          await this.stopCdpMonitoring()
          return
        }
      }

      await this.sleep(interval)
    }

    console.warn('[DeepSeekAdapter] waitForCompletion timed out')
    await this.stopCdpMonitoring()
  }

  /** Return captured content */
  async extractOutput(_prompt?: string): Promise<string> {
    return this.capturedContent.trim()
  }

  isGenerating(): boolean {
    return this.monitorActive && this.capturedContent.length > 0
  }

  hasCaptcha(): boolean {
    return false
  }

  private async waitForSelector(selector: string, timeout = 5000) {
    if (!this.page) return null
    try {
      const selectors = selector.split(',').map((s) => s.trim())
      for (const sel of selectors) {
        const el = await this.page.waitForSelector(sel, { timeout: timeout / selectors.length }).catch(() => null)
        if (el) return el
      }
      return null
    } catch {
      return null
    }
  }
}