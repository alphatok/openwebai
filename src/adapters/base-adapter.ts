import type { Page } from 'playwright'
import type { SiteConfig, ISiteAdapter } from '../types/adapter.js'
import { AdapterError } from '../errors/adapter-error.js'

/** 适配器公共基类 - 提供打字延迟、轮询、选择器检查等通用能力 */
export abstract class BaseAdapter implements ISiteAdapter {
  abstract readonly siteId: string
  abstract readonly config: SiteConfig

  protected page: Page | null = null
  private _ready = false

  /** 初始化页面 */
  async init(page: Page): Promise<void> {
    this.page = page
    await page.goto(this.config.url, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    // 验证关键选择器可用性
    await this.validateSelectors(page)
    this._ready = true
  }

  /** 是否已就绪（登录状态由子类判断） */
  isReady(): boolean {
    return this._ready
  }

  /** 模拟真人打字 - 随机延迟逐字符输入 */
  async typeWithHumanDelay(text: string): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', '页面未初始化', false)
    const [min, max] = this.config.behavior.typingDelayMs

    for (const char of text) {
      await this.page.keyboard.type(char, { delay: Math.floor(Math.random() * (max - min)) + min })
      // 偶尔停顿，更像真人
      if (Math.random() < 0.05) {
        await this.sleep(Math.floor(Math.random() * 100) + 50)
      }
    }
  }

  /** 轮询等待条件满足 */
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
    throw new AdapterError('TIMEOUT', `操作超时 (${timeoutMs}ms)`, true)
  }

  /** 选择器健康检查 - 启动时验证每个选择器是否有效 */
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
          console.warn(`[BaseAdapter] 选择器 ${name} ("${sel}") 在页面上未找到`)
        }
      } catch {
        console.warn(`[BaseAdapter] 选择器 ${name} ("${sel}") 检查异常`)
      }
    }
  }

  // === 子类必须实现的核心方法 ===
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
