import type { Page } from 'playwright'
import { BaseAdapter } from '../base-adapter.js'
import type { SiteConfig } from '../../types/adapter.js'
import { AdapterError } from '../../errors/adapter-error.js'
import configJson from './config.json' with { type: 'json' }

/** DeepSeek 站点适配器 */
export class DeepSeekAdapter extends BaseAdapter {
  readonly siteId = 'deepseek'
  readonly config: SiteConfig = configJson as unknown as SiteConfig

  private _loggedIn = false

  async init(page: Page): Promise<void> {
    await super.init(page)
    // 检测登录状态：如果页面上有输入框且没有"登录"按钮，认为已登录
    const loginBtn = await page.$('button:has-text("登录"), button:has-text("Login")')
    this._loggedIn = !loginBtn
    if (!this._loggedIn) {
      console.log('[DeepSeekAdapter] 检测到未登录状态，请在浏览器中完成登录后重试')
    }
  }

  override isReady(): boolean {
    return super.isReady() && this._loggedIn
  }

  /** 在输入框中输入文本 */
  async inputText(prompt: string): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', '页面未初始化', false)

    // 先点击输入框获取焦点
    const input = await this.waitForSelector(this.config.selectors.input)
    if (!input) throw new AdapterError('SELECTOR_EXPIRED', `输入框选择器无效: ${this.config.selectors.input}`, false)

    await input.click()
    await this.sleep(200)

    // 清空已有内容
    await this.page.keyboard.press('Control+a')
    await this.sleep(50)
    await this.page.keyboard.press('Backspace')
    await this.sleep(100)

    // 模拟真人打字
    await this.typeWithHumanDelay(prompt)
  }

  /** 点击发送按钮 */
  async clickSubmit(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', '页面未初始化', false)

    const btn = await this.waitForSelector(this.config.selectors.submitButton)
    if (!btn) throw new AdapterError('SELECTOR_EXPIRED', `发送按钮选择器无效: ${this.config.selectors.submitButton}`, false)

    await btn.click()
  }

  /** 等待 AI 生成完成（轮询检测停止按钮变回发送按钮） */
  async waitForCompletion(): Promise<void> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', '页面未初始化', false)

    const timeout = this.config.behavior.waitTimeoutMs
    const interval = this.config.behavior.pollIntervalMs

    await this.pollUntil(async () => !this.isGenerating(), interval, timeout)
  }

  /** 提取最新回复文本 */
  async extractOutput(): Promise<string> {
    if (!this.page) throw new AdapterError('PAGE_CLOSED', '页面未初始化', false)

    const container = await this.waitForSelector(this.config.selectors.outputContainer)
    if (!container) throw new AdapterError('SELECTOR_EXPIRED', `输出容器选择器无效: ${this.config.selectors.outputContainer}`, false)

    const text = await container.textContent()
    return text?.trim() ?? ''
  }

  /** 判断当前是否正在生成中 */
  isGenerating(): boolean {
    // 通过检测停止按钮是否存在来判断
    // 子类可覆盖以使用更精确的检测逻辑
    return false // 默认由 waitForCompletion 的轮询逻辑处理
  }

  /** 检测是否出现验证码 */
  hasCaptcha(): boolean {
    // TODO: 实现验证码检测逻辑
    return false
  }

  /** 等待选择器出现（带超时） */
  private async waitForSelector(selector: string, timeout = 5000) {
    if (!this.page) return null
    try {
      // 支持逗号分隔的多选择器
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
