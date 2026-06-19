import type { Page } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/** DeepSeek site adapter */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  // Login status is checked dynamically on every request (not cached)

  async init(page: Page): Promise<void> {
    await super.init(page)
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

  /** Click submit/send button or press Enter */
  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    // If submitButton is "Enter", use keyboard shortcut
    if (this.config.selectors.submitButton === 'Enter') {
      await this.page.keyboard.press('Enter')
      return
    }

    // Otherwise, try to find and click the button
    const btn = await this.waitForSelector(this.config.selectors.submitButton)
    if (!btn) throw new AdapterError('SELECTOR_EXPIRED', `Invalid submit button selector: ${this.config.selectors.submitButton}`, false)

    await btn.click()
  }

  /** Wait for AI generation to complete */
  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs

    // Wait for output container to appear first
    await this.waitForSelector(this.config.selectors.outputContainer, 10000)

    // Poll until generation stops (page content stabilizes)
    let lastLength = 0
    let stableCount = 0
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const container = await this.page.$(this.config.selectors.outputContainer)
      if (container) {
        const text = await container.textContent().catch(() => '')
        const currentLength = text?.length ?? 0

        if (currentLength === lastLength && currentLength > 0) {
          stableCount++
          // Content unchanged for 3 consecutive polls = generation complete
          if (stableCount >= 3) return
        } else {
          stableCount = 0
          lastLength = currentLength
        }
      }

      await this.sleep(interval)
    }

    // Timeout is acceptable — return whatever we have
    console.warn('[DeepSeekAdapter] waitForCompletion timed out, returning current content')
  }

  /** Extract latest response text */
  async extractOutput(): Promise<string> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    // Try each output selector
    const selectors = this.config.selectors.outputContainer.split(',').map(s => s.trim())

    for (const sel of selectors) {
      const containers = await this.page.$$(sel)
      if (containers.length > 0) {
        // Use the last matching container (most recent response)
        const last = containers[containers.length - 1]!
        const text = await last.textContent().catch(() => '')
        if (text && text.trim().length > 0) {
          return text.trim()
        }
      }
    }

    // Fallback: try to get any visible text from the page
    console.warn('[DeepSeekAdapter] No output container found, attempting fallback extraction')
    const bodyText = await this.page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document
      const allElements = doc.querySelectorAll('div, section, article')
      let maxLen = 0
      let result = ''
      for (const el of allElements) {
        const text = el.textContent?.trim() ?? ''
        // Heuristic: response is usually > 20 chars and not the whole page
        if (text.length > 20 && text.length < 5000 && text.length > maxLen) {
          maxLen = text.length
          result = text
        }
      }
      return result
    })

    return bodyText || ''
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
