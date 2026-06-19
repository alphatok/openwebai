import type { Page } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

const TAG = '[DS]'

/**
 * DeepSeek site adapter.
 *
 * Strategy:
 * 1. page.on('request') to capture SSE request params (URL, headers, body)  
 * 2. Submit via Enter key → page handles its own SSE naturally  
 * 3. In parallel, Node.js fetch() hits the same SSE endpoint with same cookies  
 * 4. Read full body, parse, extract content
 *
 * Zero interference with page rendering.
 */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private capturedContent = ''
  private monitoring = false
  
  /** Captured SSE request params */
  private reqUrl = ''
  private reqHeaders: Record<string, string> = {}
  private reqBody: string | null = null

  async init(page: Page): Promise<void> {
    await super.init(page)
    if (!this.monitoring) {
      this.observeRequests(page)
      this.monitoring = true
    }
  }

  /** Passively observe page requests to capture SSE params */
  private observeRequests(page: Page): void {
    page.on('request', async (request) => {
      const url = request.url()
      if (!url.includes('deepseek.com') || !url.includes('/chat/completion')) return

      console.log(`${TAG} Observed SSE request: ${url.slice(0, 80)}...`)

      // Capture cookies for auth
      const cookies = await page.context().cookies()
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

      this.reqUrl = url
      this.reqHeaders = {
        ...request.headers(),
        'Cookie': cookieStr,
        'Accept': 'text/event-stream',
      }
      this.reqBody = request.postData() || null
      
      console.log(`${TAG} Request params captured (body=${this.reqBody?.length || 0} chars)`)
    })
  }

  async inputText(prompt: string): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    console.log(`${TAG} inputText: "${prompt.slice(0, 60)}"`)

    const input = await this.waitForSelector(this.config.selectors.input)
    if (!input) throw new AdapterError('SELECTOR_EXPIRED', `Invalid input selector: ${this.config.selectors.input}`, false)

    console.log(`${TAG} Input found, typing...`)
    await input.click()
    await this.sleep(200)
    await this.page.keyboard.press('Control+a')
    await this.sleep(50)
    await this.page.keyboard.press('Backspace')
    await this.sleep(100)
    await this.typeWithHumanDelay(prompt)
    console.log(`${TAG} Typing done`)
  }

  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    this.capturedContent = ''

    console.log(`${TAG} Submitting (Enter key)...`)

    if (this.config.selectors.submitButton === 'Enter') {
      await this.page.keyboard.press('Enter')
      console.log(`${TAG} Enter pressed — page handles its own SSE`)
    } else {
      const btn = await this.waitForSelector(this.config.selectors.submitButton)
      if (!btn) throw new AdapterError('SELECTOR_EXPIRED', `Invalid submit button selector: ${this.config.selectors.submitButton}`, false)
      await btn.click()
    }
  }

  async waitForCompletion(): Promise<void> {
    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs
    const start = Date.now()

    console.log(`${TAG} waitForCompletion: waiting for SSE params...`)

    // Wait for request params to be captured
    while (!this.reqUrl && Date.now() - start < 8000) {
      await this.sleep(200)
    }

    if (!this.reqUrl) {
      console.warn(`${TAG} SSE request params not captured after 8s`)
      // Still wait for content
    } else {
      console.log(`${TAG} Request params available — starting parallel fetch`)
      
      // Start parallel fetch in background
      this.doParallelFetch().catch(err => {
        console.error(`${TAG} Parallel fetch error: ${err.message}`)
      })
    }

    // Wait for content to arrive
    while (Date.now() - start < timeout) {
      if (this.capturedContent.length > 0) {
        let prev = this.capturedContent.length
        let stable = 0

        while (stable < 3 && Date.now() - start < timeout) {
          await this.sleep(interval)
          const curr = this.capturedContent.length
          if (curr === prev && curr > 0) { stable++ } else {
            console.log(`${TAG} Content changing: ${prev}→${curr}`)
            stable = 0; prev = curr
          }
        }

        if (stable >= 3) {
          console.log(`${TAG} Content stable at ${this.capturedContent.length} chars`)
          return
        }
      }

      if ((Date.now() - start) % 5000 < interval) {
        console.log(`${TAG} Waiting... ${Math.round((Date.now() - start) / 1000)}s`)
      }

      await this.sleep(interval)
    }

    console.warn(`${TAG} TIMEOUT after ${timeout}ms. content=${this.capturedContent.length} chars`)
  }

  /** Make parallel Node.js fetch() to read full SSE body */
  private async doParallelFetch(): Promise<void> {
    console.log(`${TAG} Parallel fetch: ${this.reqUrl.slice(0, 80)}...`)
    const t0 = Date.now()

    try {
      const resp = await fetch(this.reqUrl, {
        method: 'POST',
        headers: this.reqHeaders,
        body: this.reqBody || undefined,
      })

      console.log(`${TAG} Parallel fetch status: ${resp.status}, ct: ${resp.headers.get('content-type')}`)

      const body = await resp.text()
      console.log(`${TAG} Parallel fetch got ${body.length} chars in ${Date.now() - t0}ms`)
      console.log(`${TAG} Body head (500): ${body.slice(0, 500)}`)
      console.log(`${TAG} Body tail (500): ${body.slice(-500)}`)

      this.capturedContent = this.parseDeepSeekSSE(body)
      console.log(`${TAG} Parsed: ${this.capturedContent.length} chars → "${this.capturedContent.slice(0, 200)}"`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${TAG} Parallel fetch error: ${msg}`)
    }
  }

  /** Parse DeepSeek SSE format */
  private parseDeepSeekSSE(body: string): string {
    const lines = body.split('\n')
    let result = ''
    let lastFragmentContent = ''

    const jsonKeysSeen = new Set<string>()

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') {
        if (jsonStr === '[DONE]') console.log(`${TAG} [DONE] signal`)
        continue
      }

      try {
        const chunk = JSON.parse(jsonStr)

        // Log top-level keys for first few chunks
        if (jsonKeysSeen.size < 10) {
          for (const k of Object.keys(chunk)) {
            if (!jsonKeysSeen.has(k)) {
              jsonKeysSeen.add(k)
              const v = chunk[k]
              console.log(`${TAG} JSON key "${k}": ${typeof v}${typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v || {}).join(',')}}`) : `=${String(v).slice(0, 60)}`}`)
            }
          }
        }

        // DeepSeek: v.response.fragments[].content (type=RESPONSE)
        const fragments = chunk?.v?.response?.fragments as Array<{ type: string; content: string }> | undefined
        if (fragments) {
          for (const f of fragments) {
            if ((f.type === 'RESPONSE' || f.type === 'TEXT') && f.content) {
              if (f.content.length > lastFragmentContent.length) {
                console.log(`${TAG} Fragment ${f.type}: ${lastFragmentContent.length}→${f.content.length}`)
                lastFragmentContent = f.content
              }
            }
            if (f.type && f.type !== 'RESPONSE' && f.type !== 'TEXT' && f.content) {
              console.log(`${TAG} Fragment "${f.type}": "${f.content.slice(0, 80)}"`)
            }
          }
        }

        // Final content in v.response.content
        const responseContent = chunk?.v?.response?.content
        if (responseContent && typeof responseContent === 'string' && responseContent.length > lastFragmentContent.length) {
          console.log(`${TAG} v.response.content: ${responseContent.length} chars`)
          lastFragmentContent = responseContent
        }

        // OpenAI fallback
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta) {
          console.log(`${TAG} OpenAI delta: "${delta.slice(0, 60)}"`)
          result += delta
        }

        if (chunk.content && typeof chunk.content === 'string') {
          result += chunk.content
        }
      } catch {
        // Non-JSON
      }
    }

    console.log(`${TAG} Parse done: keys={${[...jsonKeysSeen].join(',')}}, fragment=${lastFragmentContent.length}ch, delta=${result.length}ch`)

    if (lastFragmentContent) return lastFragmentContent
    if (result) return result
    return ''
  }

  async extractOutput(_prompt?: string): Promise<string> {
    const trimmed = this.capturedContent.trim()
    console.log(`${TAG} extractOutput: ${trimmed.length} chars → "${trimmed.slice(0, 100)}"`)
    return trimmed
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
        if (el) {
          console.log(`${TAG} Selector matched: "${sel}"`)
          return el
        }
      }
      console.warn(`${TAG} No selector matched: "${selector}" after ${timeout}ms`)
      return null
    } catch {
      return null
    }
  }
}