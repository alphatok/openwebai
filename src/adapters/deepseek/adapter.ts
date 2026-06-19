import type { Page } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/**
 * DeepSeek site adapter.
 * Strategy: observe the page's SSE request via page.on('request'),
 * then make a parallel Node.js fetch() to read the FULL SSE body.
 * The page's own request passes through untouched.
 */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private capturedContent = ''
  private sseUrl: string | null = null
  private sseBody: string | null = null
  private sseMethod = 'POST'
  private sseHeaders: Record<string, string> = {}
  private monitoring = false

  async init(page: Page): Promise<void> {
    await super.init(page)
    if (!this.monitoring) {
      this.observeRequests(page)
      this.monitoring = true
    }
  }

  /** Observe page.on('request') to capture the SSE URL + headers for parallel fetch */
  private observeRequests(page: Page): void {
    page.on('request', async (request) => {
      const url = request.url()
      if (!url.includes('deepseek.com') || !url.includes('/chat/completion')) return

      console.log(`[DeepSeekAdapter] Observed SSE request: ${url.slice(0, 80)}...`)

      const cookies = await page.context().cookies()
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

      this.sseUrl = url
      this.sseMethod = request.method()
      this.sseHeaders = {
        ...request.headers(),
        'Cookie': cookieStr,
        'Accept': 'text/event-stream',
      }
      this.sseBody = request.postData() || null
    })
  }

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

  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    this.capturedContent = ''

    if (this.config.selectors.submitButton === 'Enter') {
      await this.page.keyboard.press('Enter')
    } else {
      const btn = await this.waitForSelector(this.config.selectors.submitButton)
      if (!btn) throw new AdapterError('SELECTOR_EXPIRED', `Invalid submit button selector: ${this.config.selectors.submitButton}`, false)
      await btn.click()
    }
  }

  /** Parse DeepSeek-specific SSE format */
  private parseDeepSeekSSE(body: string): string {
    const lines = body.split('\n')
    let result = ''
    let lastFragmentContent = ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') continue

      try {
        const chunk = JSON.parse(jsonStr)

        // DeepSeek format: v.response.fragments[].content (type=RESPONSE)
        const fragments = chunk?.v?.response?.fragments as Array<{
          type: string
          content: string
        }> | undefined

        if (fragments) {
          for (const f of fragments) {
            if (f.type === 'RESPONSE' || f.type === 'TEXT') {
              // Only take the latest complete fragment
              lastFragmentContent = f.content || ''
            }
          }
        }

        // Fallback: check OpenAI-style format too
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta) result += delta
      } catch {
        // Non-JSON
      }
    }

    // Use the last complete fragment content, or accumulated deltas
    if (lastFragmentContent) return lastFragmentContent
    if (result) return result
    return ''
  }

  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const timeout = this.config.behavior.waitTimeoutMs
    const start = Date.now()

    // Wait a moment for the SSE URL to be observed (page.on('request') is async)
    while (!this.sseUrl && Date.now() - start < 5000) {
      await this.sleep(200)
    }

    if (!this.sseUrl) {
      // Fallback: use last known SSE URL attempt
      console.warn('[DeepSeekAdapter] SSE URL not observed after 5s - retrying with last request')
      // Try to find it from CDP
      if (this.page) {
        try {
          const cdp = await this.page.context().newCDPSession(this.page)
          const requests = await cdp.send('Network.getResponseBody', { requestId: '' }).catch(() => null)
          await cdp.detach()
          if (!requests) {
            // If all else fails, just wait with empty content check below
          }
        } catch { /* continue */ }
      }
    }

    if (this.sseUrl) {
      console.log(`[DeepSeekAdapter] Fetching SSE in parallel: ${this.sseUrl.slice(0, 80)}...`)

      try {
        const resp = await fetch(this.sseUrl, {
          method: this.sseMethod,
          headers: this.sseHeaders,
          body: this.sseBody || undefined,
        })

        const body = await resp.text()
        console.log(`[DeepSeekAdapter] Parallel fetch got ${body.length} chars`)

        this.capturedContent = this.parseDeepSeekSSE(body)
        console.log(`[DeepSeekAdapter] Parsed content: ${this.capturedContent.slice(0, 100)}...`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[DeepSeekAdapter] Parallel fetch error: ${msg}`)
      }
    }

    // Wait for content to arrive
    const interval = this.config.behavior.pollIntervalMs
    while (Date.now() - start < timeout) {
      if (this.capturedContent.length > 0) {
        // Content captured — wait for it to stabilize (in case some still arriving)
        let prev = this.capturedContent.length
        let stable = 0

        while (stable < 3 && Date.now() - start < timeout) {
          await this.sleep(interval)
          const curr = this.capturedContent.length
          if (curr === prev && curr > 0) { stable++ } else { stable = 0; prev = curr }
        }

        if (stable >= 3) return
      }

      await this.sleep(interval)
    }

    if (this.capturedContent.length === 0) {
      console.warn('[DeepSeekAdapter] waitForCompletion timed out with no content')
    }
  }

  async extractOutput(_prompt?: string): Promise<string> {
    return this.capturedContent.trim()
  }

  isGenerating(): boolean {
    return false
  }

  hasCaptcha(): boolean {
    return false
  }

  private async waitForSelector(selector: string, timeout = 5000) {
    if (!this.page) return null
    try {
      const sels = selector.split(',').map(s => s.trim())
      for (const sel of sels) {
        const el = await this.page.waitForSelector(sel, { timeout: timeout / sels.length }).catch(() => null)
        if (el) return el
      }
      return null
    } catch {
      return null
    }
  }
}