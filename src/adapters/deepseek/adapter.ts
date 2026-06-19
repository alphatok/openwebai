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
  async extractOutput(prompt?: string): Promise<string> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', 'Page not initialized', false)

    // Strategy: don't rely on fragile CSS selectors.
    // Get all visible text from the page, subtract the prompt,
    // and return the largest text block that's new.

    const fullText = await this.page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document
      // Get text from all non-hidden block elements
      const nodes = doc.body.querySelectorAll('div, section, article, p, span, pre, code')
      const texts: { text: string; depth: number }[] = []

      for (const el of nodes) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const style = (globalThis as any).getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        if (el.offsetParent === null && el !== doc.body) continue

        const text = (el.textContent ?? '').trim()
        // Filter out very short text (UI labels) and very long text (entire page)
        if (text.length > 10 && text.length < 20000) {
          // Calculate nesting depth as heuristic for specificity
          let depth = 0
          let parent = el.parentElement
          while (parent && parent !== doc.body) { depth++; parent = parent.parentElement }
          texts.push({ text, depth })
        }
      }

      // Sort by depth descending (deepest = most specific = likely response)
      texts.sort((a, b) => b.depth - a.depth)
      return texts.slice(0, 5).map(t => t.text)
    })

    if (fullText.length === 0) return ''

    // If we have the prompt, subtract it to find the response
    if (prompt) {
      for (const block of fullText) {
        const cleaned = block.replace(prompt, '').trim()
        if (cleaned.length > 0) return cleaned
      }
    }

    // Return the deepest/largest text block
    return fullText[0] ?? ''
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
