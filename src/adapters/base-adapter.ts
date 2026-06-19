import type { Page } from 'playwright'
import type { SiteConfig, ISiteAdapter } from '../types/adapter.js'
import { AdapterError } from '../errors/adapter-error.js'

/** Base adapter class - provides typing delay, polling, selector validation */
export abstract class BaseAdapter implements ISiteAdapter {
  abstract readonly siteId: string
  abstract readonly config: SiteConfig

  protected page: Page | null = null
  private _ready = false

  /** Initialize the page */
  async init(page: Page): Promise<void> {
    this.page = page
    await page.goto(this.config.url, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    // Validate key selectors availability
    await this.validateSelectors(page)
    this._ready = true
  }

  /** Whether adapter is ready (login status determined by subclass) */
  isReady(): boolean {
    return this._ready
  }

  /** Simulate human typing with random delays per character */
  async typeWithHumanDelay(text: string): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)
    const [min, max] = this.config.behavior.typingDelayMs

    for (const char of text) {
      await this.page.keyboard.type(char, { delay: Math.floor(Math.random() * (max - min)) + min })
      // Occasional pause to mimic human behavior
      if (Math.random() < 0.05) {
        await this.sleep(Math.floor(Math.random() * 100) + 50)
      }
    }
  }

  /** Poll until condition is met */
  async pollUntil(
    conditionFn: () => Promise<boolean>,
    intervalMs: number,
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await conditionFn()) return
      await this.sleep(intervalMs)
    }
    throw new AdapterError('TIMEOUT', `Operation timed out (${timeoutMs}ms)`, true)
  }

  /** Selector health check - validate each selector at startup */
  async validateSelectors(page: Page): Promise<void> {
    const { selectors } = this.config
    const checks: Array<[string, string]> = [
      ['input', selectors.input],
      ['submitButton', selectors.submitButton],
      ['outputContainer', selectors.outputContainer],
    ]
    for (const [name, sel] of checks) {
      try {
        const el = await page.$(sel)
        if (!el && !sel.includes(',')) {
          console.warn(`[BaseAdapter] Selector ${name} ("${sel}") not found on page`)
        }
      } catch {
        console.warn(`[BaseAdapter] Selector ${name} ("${sel}") check failed`)
      }
    }
  }

  // === Core methods that subclasses must implement ===
  abstract inputText(prompt: string): Promise<void>
  abstract clickSubmit(): Promise<void>
  abstract waitForCompletion(): Promise<void>
  abstract extractOutput(): Promise<string>
  abstract isGenerating(): boolean
  abstract hasCaptcha(): boolean

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
