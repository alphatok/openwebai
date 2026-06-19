import type { Page, BrowserContext, Browser } from 'playwright'
import type { ISiteAdapter } from '../types/adapter.js'
import type { BrowserTask, TaskResult } from '../types/task.js'
import { AdapterError } from '../errors/adapter-error.js'

/** Managed Page wrapper with lifecycle tracking */
export class ManagedPage {
  private _alive = true

  constructor(public readonly page: Page) {
    // Listen for page close event
    page.on('close', () => {
      this._alive = false
    })
  }

  get alive(): boolean {
    return this._alive
  }

  /** Ensure page is alive, throw error otherwise */
  ensureAlive(): void {
    if (!this._alive) {
      throw new AdapterError('PAGE_CLOSED', 'Browser page closed', false)
    }
  }

  async close(): Promise<void> {
    this._alive = false
    await this.page.close().catch(() => {})
  }
}

/** CDP Browser Driver - controls Chrome via Playwright */
export class CDPDriver {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private managedPage: ManagedPage | null = null
  private adapters = new Map<string, ISiteAdapter>()

  /** Register a site adapter */
  registerAdapter(adapter: ISiteAdapter): void {
    this.adapters.set(adapter.siteId, adapter)
  }

  /** Get registered adapter by siteId */
  getAdapter(siteId: string): ISiteAdapter | undefined {
    return this.adapters.get(siteId)
  }

  /** Launch browser with persistent context (login state saved across sessions) */
  async launch(): Promise<void> {
    const { chromium } = await import('playwright')
    const path = await import('path')
    const os = await import('os')

    // Use persistent context so login state (cookies) is saved to disk
    const userDataDir = path.join(os.homedir(), '.openwebai', 'chrome-profile')

    this.context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    })

    // Persistent context provides pages directly
    const page = this.context.pages()[0] ?? await this.context.newPage()
    this.managedPage = new ManagedPage(page)

    // Navigate to first registered adapter's site if available
    const firstAdapter = this.adapters.values().next().value
    if (firstAdapter) {
      console.log(`[CDPDriver] Navigating to ${firstAdapter.config.url} ...`)
      console.log('[CDPDriver] >>> Please LOG IN if needed (login is remembered after first time) <<<')
      await page.goto(firstAdapter.config.url, { waitUntil: 'domcontentloaded' })
    }

    console.log('[CDPDriver] Browser launched (persistent profile)')
  }

  /** Execute task: complete a conversation on specified site */
  async execute(task: BrowserTask): Promise<TaskResult> {
    if (!this.managedPage) {
      throw new AdapterError('PAGE_CLOSED', 'Browser not started. Call launch() first.', false)
    }

    this.managedPage.ensureAlive()

    const adapter = this.adapters.get(task.siteId)
    if (!adapter) {
      return {
        taskId: task.taskId,
        status: 'failed',
        error: {
          code: 'SELECTOR_EXPIRED',
          message: `No adapter found for site: ${task.siteId}`,
          recoverable: false,
        },
      }
    }

    try {
      const page = this.managedPage.page

      // Ensure adapter is initialized with current page (idempotent)
      await adapter.init(page)

      // Navigate to target site if not already there
      const currentUrl = page.url()
      if (!currentUrl.includes(adapter.config.url.replace('https://', '').replace('http://', ''))) {
        await page.goto(adapter.config.url, { waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle')
      }

      // Execute the task — let operation fail naturally if not logged in
      // (selector errors will provide clear diagnostics)

      // Execute conversation flow
      console.log(`[CDPDriver] Executing task ${task.taskId}: "${task.prompt.slice(0, 50)}..."`)

      await adapter.inputText(task.prompt)       // Input text
      await adapter.clickSubmit()                 // Click send
      await adapter.waitForCompletion()           // Wait for completion
      const content = await adapter.extractOutput() // Extract reply

      console.log(`[CDPDriver] Task ${task.taskId} completed, reply length: ${content.length}`)

      return {
        taskId: task.taskId,
        status: 'completed',
        content,
      }
    } catch (err) {
      const error = err instanceof AdapterError ? err : new AdapterError('NETWORK', String(err), true)
      return {
        taskId: task.taskId,
        status: 'failed',
        error: {
          code: error.code,
          message: error.message,
          recoverable: error.recoverable,
        },
      }
    }
  }

  /** Close browser */
  async close(): Promise<void> {
    console.log('[CDPDriver] Closing browser...')
    if (this.managedPage) {
      await this.managedPage.close().catch(() => {})
      this.managedPage = null
    }
    if (this.context) {
      await this.context.close().catch(() => {})
      this.context = null
    }
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
    console.log('[CDPDriver] Browser closed')
  }
}
