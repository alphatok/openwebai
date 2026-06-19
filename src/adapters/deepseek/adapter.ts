import type { Page, Route } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/**
 * DeepSeek site adapter.
 * Uses page.route() to intercept SSE chat/completion requests.
 * Reads the full SSE stream via ReadableStream reader (waits for stream end),
 * captures content, then fulfills back to page seamlessly.
 */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private capturedContent = ''
  private routeInstalled = false

  async init(page: Page): Promise<void> {
    await super.init(page)
    if (!this.routeInstalled) {
      await this.installRouteHandler(page)
      this.routeInstalled = true
    }
  }

  /** Install route handler — intercept SSE, pass through everything else */
  private async installRouteHandler(page: Page): Promise<void> {
    await page.route('**/*', async (route: Route) => {
      const url = route.request().url()

      // Only intercept chat/completion SSE endpoint
      if (!url.includes('deepseek.com') || !url.includes('/chat/completion')) {
        await route.continue()
        return
      }

      console.log(`[DeepSeekAdapter] Intercepted SSE: ${url.slice(0, 80)}...`)

      try {
        const response = await route.fetch()
        const contentType = response.headers()['content-type'] || ''

        if (contentType.includes('text/event-stream')) {
          // Read the full SSE body via stream reader — waits for stream end
          const body = await this.readStreamFully(response)
          const bodyText = new TextDecoder().decode(body)
          console.log(`[DeepSeekAdapter] SSE stream complete: ${bodyText.length} chars`)

          // Parse before fulfilling
          this.capturedContent = this.parseDeepSeekSSE(bodyText)
          console.log(`[DeepSeekAdapter] Parsed content: ${this.capturedContent.slice(0, 100)}...`)

          // Fulfill back to page — page gets the full response
          await route.fulfill({
            status: response.status(),
            headers: response.headers(),
            body: bodyText,
          })
        } else {
          // Not SSE — just fulfill through
          await route.fulfill({ response })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[DeepSeekAdapter] Route error: ${msg}`)
        await route.continue().catch(() => {})
      }
    })

    console.log('[DeepSeekAdapter] Route handler installed')
  }

  /**
   * Read a response body stream fully until the stream ends.
   * Playwright's response.text() only returns the first chunk for SSE,
   * but response.body() returns a ReadableStream that we can drain completely.
   */
  private async readStreamFully(response: Awaited<ReturnType<Route['fetch']>>): Promise<Uint8Array> {
    try {
      // response.body() returns a readable stream, or buffer, or null
      const body = await response.body()
      return body
    } catch {
      // Fallback: try .text() and re-encode
      const text = await response.text()
      return new TextEncoder().encode(text)
    }
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
              lastFragmentContent = f.content || ''
            }
          }
        }

        // Fallback: OpenAI-style
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta) result += delta
      } catch {
        // Non-JSON
      }
    }

    if (lastFragmentContent) return lastFragmentContent
    if (result) return result
    return ''
  }

  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs
    const start = Date.now()

    // Wait for content to arrive and stabilize
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