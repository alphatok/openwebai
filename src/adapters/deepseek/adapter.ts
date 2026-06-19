import type { Page, Route } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/** DeepSeek site adapter — intercepts SSE stream via Node.js fetch for full capture */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  /** Captured SSE content from network interception */
  private capturedContent = ''
  /** Whether route interception is active */
  private routeActive = false

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

    // Clear existing content
    await this.page.keyboard.press('Control+a')
    await this.sleep(50)
    await this.page.keyboard.press('Backspace')
    await this.sleep(100)

    await this.typeWithHumanDelay(prompt)
  }

  /** Set up SSE interception and click submit */
  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    // Reset capture state
    this.capturedContent = ''

    // Set up route interception to capture the SSE stream
    await this.setupRouteInterception()

    // Click submit or press Enter
    if (this.config.selectors.submitButton === 'Enter') {
      await this.page.keyboard.press('Enter')
    } else {
      const btn = await this.waitForSelector(this.config.selectors.submitButton)
      if (!btn) throw new AdapterError('SELECTOR_EXPIRED', `Invalid submit button selector: ${this.config.selectors.submitButton}`, false)
      await btn.click()
    }
  }

  /** Setup Playwright route interception — captures SSE via external fetch */
  private async setupRouteInterception(): Promise<void> {
    if (!this.page || this.routeActive) return
    this.routeActive = true

    await this.page.route('**/*', async (route: Route) => {
      const url = route.request().url()

      // Only intercept DeepSeek chat API calls
      if (this.isChatApiUrl(url)) {
        const reqHeaders = route.request().headers()
        const postData = route.request().postData()

        // Abort page's request — we'll proxy it ourselves to capture the full SSE
        await route.abort()

        console.log(`[DeepSeekAdapter] Proxying SSE request: ${url.slice(0, 80)}...`)

        try {
          // Build cookie header from browser context for auth
          const cookies = await this.page!.context().cookies()
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

          // Merge headers, add cookie
          const headers: Record<string, string> = {
            ...reqHeaders,
            'Cookie': cookieStr,
            'Accept': 'text/event-stream',
          }

          // Make our own fetch — Node.js fetch reads the full SSE body
          const resp = await fetch(url, {
            method: route.request().method(),
            headers,
            body: postData || undefined,
          })

          // response.text() on Node.js fetch waits for the full SSE stream to end
          const body = await resp.text()
          this.parseSSEBody(body)

          // Get response headers
          const respHeaders: Record<string, string> = {}
          resp.headers.forEach((value, key) => {
            respHeaders[key] = value
          })

          // Fulfill the page's request with the captured response
          await route.fulfill({
            status: resp.status,
            headers: respHeaders,
            body,
          })

          console.log(`[DeepSeekAdapter] SSE captured: ${this.capturedContent.slice(0, 100)}...`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[DeepSeekAdapter] Proxy error: ${message}`)
          await route.fulfill({ status: 500, body: '{}' })
        }
      } else {
        await route.continue()
      }
    })
  }

  /** Check if URL is a DeepSeek chat API endpoint */
  private isChatApiUrl(url: string): boolean {
    return url.includes('deepseek.com') &&
      (url.includes('/chat') || url.includes('/completion') || url.includes('/stream') || url.includes('/v1/') || url.includes('/api/'))
  }

  /** Parse SSE (text/event-stream) body into capturedContent */
  private parseSSEBody(body: string): void {
    console.log(`[DeepSeekAdapter] Raw SSE body (${body.length} chars):\n${body.slice(0, 500)}\n---`)
    const lines = body.split('\n')
    for (const line of lines) {
      // SSE format: "data: {...json...}"
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6).trim()
        if (jsonStr === '[DONE]') continue

        try {
          const chunk = JSON.parse(jsonStr)
          // DeepSeek chunks typically have: chunk.choices[0].delta.content
          const delta = chunk?.choices?.[0]?.delta?.content
          if (delta) {
            this.capturedContent += delta
            console.log(`[DeepSeekAdapter] delta: "${delta.slice(0, 60)}" (total: ${this.capturedContent.length})`)
          }
          // Some APIs use different format: chunk.content or chunk.message.content
          const altContent = chunk?.content || chunk?.message?.content
          if (altContent && !delta) {
            this.capturedContent += altContent
          }
        } catch {
          // Ignore non-JSON data lines
        }
      }
    }
  }

  /** Wait for AI generation to complete (SSE stream finished) */
  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs
    const startTime = Date.now()

    // Wait for content to start arriving, then stabilize
    while (Date.now() - startTime < timeout) {
      if (this.capturedContent.length > 0) {
        // Content is arriving — wait for it to stop growing
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
          // Clean up route interception
          await this.removeRouteInterception()
          return
        }
      }

      await this.sleep(interval)
    }

    // Timeout — clean up and return whatever we have
    console.warn('[DeepSeekAdapter] waitForCompletion timed out, returning partial content')
    await this.removeRouteInterception()
  }

  /** Remove route interception to avoid interfering with subsequent requests */
  private async removeRouteInterception(): Promise<void> {
    if (!this.page || !this.routeActive) return
    try {
      await this.page.unrouteAll({ behavior: 'ignoreErrors' })
    } catch {
      // Ignore errors when removing routes
    }
    this.routeActive = false
  }

  /** Return captured SSE content */
  async extractOutput(_prompt?: string): Promise<string> {
    return this.capturedContent.trim()
  }

  /** Check if AI is currently generating */
  isGenerating(): boolean {
    return this.routeActive && this.capturedContent.length > 0
  }

  /** Check if captcha appeared */
  hasCaptcha(): boolean {
    return false
  }

  /** Wait for selector to appear (with timeout) */
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