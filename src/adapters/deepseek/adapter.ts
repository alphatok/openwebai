import type { Page } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/** DeepSeek site adapter */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private _loggedIn = false

  async init(page: Page): Promise<void> {
    await super.init(page)
    // Detect login status: if no login button found, assume logged in
    const loginBtn = await page.$('button:has-text("登录"), button:has-text("Login")')
    this._loggedIn = !loginBtn
    if (!this._loggedIn) {
      console.log('[DeepSeekAdapter] Not logged in. Please log in browser first.')
    }
  }

  override isReady(): boolean {
    return super.isReady() && this._loggedIn
  }

  /** Input text into the chat box */
  async inputText(prompt: string): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    // Click input box to focus
    const input = await this.waitForSelector(this.config.selectors.input)
    if (!input) throw new AdapterError('SELECTOR_EXPIRED', `Invalid input selector: ${this.config.selectors.input}`, false)

    await input.click()
    await this.sleep(200)

    // Clear existing content
    await this.page.keyboard.press('Control+a')
    await this.sleep(50)
    await this.page.keyboard.press('Backspace')
    await this.sleep(100)

    // Type with human-like delay
    await this.typeWithHumanDelay(prompt)
  }

  /** Click submit/send button */
  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const btn = await this.waitForSelector(this.config.selectors.submitButton)
    if (!btn) throw new AdapterError('SELECTOR_EXPIRED', `Invalid submit button selector: ${this.config.selectors.submitButton}`, false)

    await btn.click()
  }

  /** Wait for AI generation to complete */
  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs

    await this.pollUntil(async () => !this.isGenerating(), interval, timeout)
  }

  /** Extract latest response text */
  async extractOutput(): Promise<string> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const container = await this.waitForSelector(this.config.selectors.outputContainer)
    if (!container) throw new AdapterError('SELECTOR_EXPIRED', `Invalid output container selector: ${this.config.selectors.outputContainer}`, false)

    const text = await container.textContent()
    return text?.trim() ?? ''
  }

  /** Check if AI is currently generating */
  isGenerating(): boolean {
    // Subclass can override for more precise detection logic
    return false // Default: handled by waitForCompletion polling
  }

  /** Check if captcha appeared */
  hasCaptcha(): boolean {
    // TODO: Implement captcha detection logic
    return false
  }

  /** Wait for selector to appear (with timeout) */
  private async waitForSelector(selector: string, timeout = 5000) {
    if (!this.page) return null
    try {
      // Support comma-separated multiple selectors
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
