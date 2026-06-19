import type { Page, Route } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/**
 * DeepSeek site adapter — transparent SSE proxy.
 * Intercepts only the chat completion SSE endpoint via page.route(),
 * reads the full response body, captures it, then fulfills back to page.
 * All other requests pass through untouched via route.continue().
 */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private capturedContent = ''
  private routeHandlerInstalled = false

  async init(page: Page): Promise<void> {
    await super.init(page)
    // Install interception once per session
    if (!this.routeHandlerInstalled) {
      await this.installRouteHandler(page)
      this.routeHandlerInstalled = true
    }
  }

  /** Install persistent route handler — only intercepts chat/completion SSE */
  private async installRouteHandler(page: Page): Promise<void> {
    await page.route('**/*', async (route: Route) => {
      const url = route.request().url()

      // Only intercept the chat/completion SSE endpoint
      if (url.includes('deepseek.com') && url.includes('/chat/completion')) {
        console.log(`[DeepSeekAdapter] Proxying SSE: ${url.slice(0, 80)}...`)

        try {
          // Fetch the real response (Playwright internally reads the full stream)
          const response = await route.fetch()
          const contentType = response.headers()['content-type'] || ''

          if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
            // Read full SSE body — .text() waits for stream completion
            const body = await response.text()
            this.parseSSEBody(body)
          }

          // Fulfill the page's request with the real response (a few ms delay at most)
          await route.fulfill({ response })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[DeepSeekAdapter] Proxy error: ${message}`)
          await route.continue().catch(() => {})
        }
      } else {
        // Pass through all other requests untouched
        await route.continue()
      }
    })

    console.log('[DeepSeekAdapter] Route handler installed (intercepting /chat/completion SSE only)')
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

  /** Parse SSE body, extracting delta.content from each data: line */
  private parseSSEBody(body: string): void {
    console.log(`[DeepSeekAdapter] Raw SSE body (${body.length} chars):\n${body.slice(0, 500)}\n---`)

    const lines = body.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') continue

      try {
        const chunk = JSON.parse(jsonStr)
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta) {
          this.capturedContent += delta
          console.log(`[DeepSeekAdapter] delta: "${delta.slice(0, 60)}" (total: ${this.capturedContent.length})`)
        }
        // Fallback for other JSON formats
        const alt = chunk?.content || chunk?.message?.content
        if (alt && !delta) this.capturedContent += alt
      } catch {
        // Non-JSON data line (e.g. pings), ignore
      }
    }

    console.log(`[DeepSeekAdapter] SSE capture done: ${this.capturedContent.length} chars total`)
  }

  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    // Since route interception reads the full SSE body synchronously,
    // by the time clickSubmit returns and we enter waitForCompletion,
    // the SSE body may already be captured (or still arriving).
    // We poll for content to arrive and stabilize.
    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs
    const start = Date.now()

    while (Date.now() - start < timeout) {
      if (this.capturedContent.length > 0) {
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

    console.warn('[DeepSeekAdapter] waitForCompletion timed out')
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