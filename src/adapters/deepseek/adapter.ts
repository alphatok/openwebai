import type { Page, Route } from 'playwright'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

const TAG = '[DS]' // Short tag for cleaner logs

/**
 * DeepSeek site adapter — transparent SSE proxy via TransformStream.
 * Intercepts chat/completion requests, pipes the response through a
 * TransformStream that copies each chunk for parsing while forwarding
 * the original data to the page seamlessly. Zero blocking.
 */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private sseBuffer = ''
  private capturedContent = ''
  private routeInstalled = false
  private streamEnded = false
  private chunkCount = 0
  /** Track all parsed json keys for debugging */
  private jsonKeysSeen = new Set<string>()

  async init(page: Page): Promise<void> {
    await super.init(page)
    if (!this.routeInstalled) {
      await this.installRouteHandler(page)
      this.routeInstalled = true
    }
  }

  private async installRouteHandler(page: Page): Promise<void> {
    await page.route('**/*', async (route: Route) => {
      const url = route.request().url()
      const method = route.request().method()

      // Only intercept chat/completion POST
      if (!url.includes('deepseek.com') || !url.includes('/chat/completion')) {
        await route.continue()
        return
      }

      console.log(`${TAG} ===== Intercepted SSE =====`)
      console.log(`${TAG} URL: ${url}`)
      console.log(`${TAG} Method: ${method}`)
      console.log(`${TAG} Content-Type: ${route.request().headers()['content-type'] || 'none'}`)

      const postData = route.request().postData()
      if (postData) {
        console.log(`${TAG} PostData (${postData.length} chars): ${postData.slice(0, 200)}`)
      }

      try {
        const response = await route.fetch()
        const respStatus = response.status()
        const respHeaders = response.headers()
        const respContentType = respHeaders['content-type'] || ''

        console.log(`${TAG} Response status: ${respStatus}`)
        console.log(`${TAG} Response content-type: ${respContentType}`)
        console.log(`${TAG} Response headers keys: ${Object.keys(respHeaders).join(', ')}`)

        const responseBody = response.body()

        if (!responseBody) {
          console.log(`${TAG} No response body — fulfilling with original response`)
          await route.fulfill({ response })
          return
        }

        console.log(`${TAG} Response body type: ${responseBody.constructor.name}`)
        console.log(`${TAG} Creating TransformStream for transparent proxy...`)

        // Create TransformStream to tee data: forward to page + parse for content
        const transformStream = new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk: Uint8Array, controller) => {
            this.chunkCount++
            const text = new TextDecoder().decode(chunk, { stream: true })
            console.log(`${TAG} [chunk #${this.chunkCount}] ${chunk.length} bytes: ${text.slice(0, 150)}${text.length > 150 ? '...' : ''}`)

            this.sseBuffer += text
            this.tryExtractContent()

            // Forward original data to page
            controller.enqueue(chunk)
          },
          flush: () => {
            console.log(`${TAG} ===== Stream flush =====`)
            console.log(`${TAG} Total chunks received: ${this.chunkCount}`)
            console.log(`${TAG} Final buffer length: ${this.sseBuffer.length}`)
            console.log(`${TAG} Final buffer preview: ${this.sseBuffer.slice(0, 300)}`)

            new TextDecoder().decode()
            if (this.sseBuffer) {
              this.tryExtractContent()
            }

            console.log(`${TAG} JSON keys seen during stream: ${[...this.jsonKeysSeen].join(', ')}`)
            console.log(`${TAG} Final capturedContent (${this.capturedContent.length} chars): ${this.capturedContent.slice(0, 200)}`)
            this.streamEnded = true
          },
        })

        // Pipe: response body → transform → readable
        const sourceReadable = responseBody as unknown as WebReadableStream<Uint8Array>
        sourceReadable.pipeTo(transformStream.writable).catch((err: Error) => {
          console.error(`${TAG} pipeTo error: ${err.message}`)
          this.streamEnded = true
        })

        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body: transformStream.readable as never,
        })

        console.log(`${TAG} Route fulfilled — SSE streaming to page`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`${TAG} Route error: ${msg}`)
        await route.continue().catch(() => {})
      }
    })

    console.log(`${TAG} Route handler installed (TransformStream proxy)`)
  }

  /**
   * Try to extract content from buffered SSE text.
   * Parses complete data: lines, accumulates content from fragments/delta.
   */
  private tryExtractContent(): void {
    const lines = this.sseBuffer.split('\n')
    const complete = this.sseBuffer.endsWith('\n')
      ? lines
      : lines.slice(0, -1)
    const leftover = this.sseBuffer.endsWith('\n') ? '' : (lines[lines.length - 1] || '')

    let parsedCount = 0

    for (const line of complete) {
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') {
        if (jsonStr === '[DONE]') console.log(`${TAG} Received [DONE] signal`)
        continue
      }

      try {
        const chunk = JSON.parse(jsonStr)
        parsedCount++

        // Log top-level keys for first chunk to help debug format
        if (this.jsonKeysSeen.size < 5) {
          const keys = Object.keys(chunk)
          for (const k of keys) {
            if (!this.jsonKeysSeen.has(k)) {
              this.jsonKeysSeen.add(k)
              console.log(`${TAG} JSON key: "${k}" → ${typeof chunk[k]}${Array.isArray(chunk[k]) ? `[${chunk[k].length}]` : ''}`)
            }
          }
        }

        // DeepSeek format: v.response.fragments[].content (type=RESPONSE)
        const fragments = chunk?.v?.response?.fragments as Array<{
          type: string
          content: string
        }> | undefined

        if (fragments) {
          for (const f of fragments) {
            if (f.type === 'RESPONSE' || f.type === 'TEXT') {
              if (f.content && f.content.length > this.capturedContent.length) {
                const prevLen = this.capturedContent.length
                this.capturedContent = f.content
                console.log(`${TAG} Fragment upgrade: ${prevLen}→${this.capturedContent.length} chars`)
                console.log(`${TAG} New content: ${this.capturedContent.slice(-80)}`)
              }
            }
          }
        }

        // Final complete message (non-incremental)
        const finalContent = chunk?.v?.response?.content || chunk?.content
        if (finalContent && typeof finalContent === 'string' && finalContent.length > this.capturedContent.length) {
          console.log(`${TAG} Final content field found: ${finalContent.length} chars`)
          this.capturedContent = finalContent
        }

        // Fallback: OpenAI-style delta.content
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta) {
          console.log(`${TAG} OpenAI delta: "${delta}"`)
          this.capturedContent += delta
        }
      } catch {
        // Non-JSON data line — log first few for debugging
        if (parsedCount === 0 && line.length < 200) {
          console.log(`${TAG} Non-JSON data line: ${line.slice(0, 100)}`)
        }
      }
    }

    this.sseBuffer = leftover
  }

  async inputText(prompt: string): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    console.log(`${TAG} inputText: "${prompt.slice(0, 60)}..."`)

    const input = await this.waitForSelector(this.config.selectors.input)
    if (!input) {
      console.error(`${TAG} Input selector "${this.config.selectors.input}" not found!`)
      throw new AdapterError('SELECTOR_EXPIRED', `Invalid input selector: ${this.config.selectors.input}`, false)
    }

    console.log(`${TAG} Input element found, clicking...`)
    await input.click()
    await this.sleep(200)
    await this.page.keyboard.press('Control+a')
    await this.sleep(50)
    await this.page.keyboard.press('Backspace')
    await this.sleep(100)
    console.log(`${TAG} Typing prompt with human delay...`)
    await this.typeWithHumanDelay(prompt)
    console.log(`${TAG} Typing done`)
  }

  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    this.capturedContent = ''
    this.sseBuffer = ''
    this.streamEnded = false
    this.chunkCount = 0
    this.jsonKeysSeen.clear()

    console.log(`${TAG} Submitting via: ${this.config.selectors.submitButton}`)

    if (this.config.selectors.submitButton === 'Enter') {
      await this.page.keyboard.press('Enter')
      console.log(`${TAG} Enter pressed — waiting for SSE interception...`)
    } else {
      const btn = await this.waitForSelector(this.config.selectors.submitButton)
      if (!btn) {
        console.error(`${TAG} Submit button selector "${this.config.selectors.submitButton}" not found!`)
        throw new AdapterError('SELECTOR_EXPIRED', `Invalid submit button selector: ${this.config.selectors.submitButton}`, false)
      }
      await btn.click()
      console.log(`${TAG} Submit button clicked — waiting for SSE interception...`)
    }
  }

  async waitForCompletion(): Promise<void> {
    console.log(`${TAG} waitForCompletion: streamEnded=${this.streamEnded}, capturedContent=${this.capturedContent.length} chars`)

    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs
    const start = Date.now()

    while (Date.now() - start < timeout) {
      if (this.streamEnded && this.capturedContent.length > 0) {
        console.log(`${TAG} Completion: stream ended with ${this.capturedContent.length} chars`)
        return
      }

      if (this.capturedContent.length > 0) {
        let prev = this.capturedContent.length
        let stable = 0

        while (stable < 3 && Date.now() - start < timeout) {
          await this.sleep(interval)
          const curr = this.capturedContent.length
          if (curr === prev && curr > 0) { stable++ } else {
            console.log(`${TAG} Content still changing: ${prev}→${curr} (stable reset)`)
            stable = 0; prev = curr
          }
          if (this.streamEnded) break
        }

        if (stable >= 3 || this.streamEnded) {
          console.log(`${TAG} Completion: content stable at ${this.capturedContent.length} chars (stable=${stable}, streamEnded=${this.streamEnded})`)
          return
        }
      } else {
        // Log waiting status every 5s
        if ((Date.now() - start) % 5000 < interval) {
          console.log(`${TAG} Waiting... (${Math.round((Date.now() - start) / 1000)}s elapsed, streamEnded=${this.streamEnded})`)
        }
      }

      await this.sleep(interval)
    }

    console.warn(`${TAG} waitForCompletion TIMEOUT after ${timeout}ms. streamEnded=${this.streamEnded}, capturedContent=${this.capturedContent.length} chars`)
    if (this.capturedContent.length === 0) {
      console.warn(`${TAG} Dumping sseBuffer for debugging (${this.sseBuffer.length} chars):`)
      console.warn(this.sseBuffer.slice(0, 1000))
    }
  }

  async extractOutput(_prompt?: string): Promise<string> {
    const trimmed = this.capturedContent.trim()
    console.log(`${TAG} extractOutput: returning ${trimmed.length} chars`)
    return trimmed
  }

  isGenerating(): boolean {
    return !this.streamEnded
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
      console.warn(`${TAG} No selector matched for: "${selector}" after ${timeout}ms`)
      return null
    } catch {
      return null
    }
  }
}