import type { Page, BrowserContext, Browser } from 'playwright'
import type { ISiteAdapter } from '../types/adapter.js'
import type { BrowserTask, TaskResult } from '../types/task.js'
import { AdapterError } from '../errors/adapter-error.js'

/** 带生命周期管理的 Page 包装器 */
export class ManagedPage {
  private _alive = true

  constructor(public readonly page: Page) {
    // 监听 page 关闭事件
    page.on('close', () => {
      this._alive = false
    })
  }

  get alive(): boolean {
    return this._alive
  }

  /** 确保页面存活，否则抛出明确错误 */
  ensureAlive(): void {
    if (!this._alive) {
      throw new AdapterError('PAGE_CLOSED', '浏览器页面已关闭', false)
    }
  }

  async close(): Promise<void> {
    this._alive = false
    await this.page.close().catch(() => {})
  }
}

/** CDP 浏览器驱动 - 通过 Playwright 操控 Chrome */
export class CDPDriver {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private managedPage: ManagedPage | null = null
  private adapters = new Map<string, ISiteAdapter>()

  /** 注册站点适配器 */
  registerAdapter(adapter: ISiteAdapter): void {
    this.adapters.set(adapter.siteId, adapter)
  }

  /** 获取已注册的适配器 */
  getAdapter(siteId: string): ISiteAdapter | undefined {
    return this.adapters.get(siteId)
  }

  /** 启动浏览器（使用用户本地 Chrome） */
  async launch(): Promise<void> {
    const { chromium } = await import('playwright')
    this.browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    })
    this.context = await this.browser.newContext()
    const page = await this.context.newPage()
    this.managedPage = new ManagedPage(page)

    console.log('[CDPDriver] 浏览器已启动')
  }

  /** 执行任务：在指定站点上完成一次对话 */
  async execute(task: BrowserTask): Promise<TaskResult> {
    if (!this.managedPage) {
      throw new AdapterError('PAGE_CLOSED', '浏览器未启动，请先调用 launch()', false)
    }

    this.managedPage.ensureAlive()

    const adapter = this.adapters.get(task.siteId)
    if (!adapter) {
      return {
        taskId: task.taskId,
        status: 'failed',
        error: {
          code: 'SELECTOR_EXPIRED',
          message: `未找到站点适配器: ${task.siteId}`,
          recoverable: false,
        },
      }
    }

    try {
      // 初始化适配器（如果尚未初始化）
      const page = this.managedPage.page

      // 如果当前页面不在目标站点，导航过去
      const currentUrl = page.url()
      if (!currentUrl.includes(adapter.config.url.replace('https://', '').replace('http://', ''))) {
        await adapter.init(page)
      }

      // 检查是否就绪（已登录）
      if (!adapter.isReady()) {
        return {
          taskId: task.taskId,
          status: 'failed',
          error: {
            code: 'AUTH_FAILED',
            message: `${adapter.siteId} 未登录，请在浏览器中完成登录`,
            recoverable: true,
          },
        }
      }

      // 执行对话流程
      console.log(`[CDPDriver] 开始执行任务 ${task.taskId}: "${task.prompt.slice(0, 50)}..."`)

      await adapter.inputText(task.prompt)       // 输入文本
      await adapter.clickSubmit()                 // 点击发送
      await adapter.waitForCompletion()           // 等待生成完成
      const content = await adapter.extractOutput() // 提取回复

      console.log(`[CDPDriver] 任务 ${task.taskId} 完成，回复长度: ${content.length}`)

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

  /** 关闭浏览器 */
  async close(): Promise<void> {
    console.log('[CDPDriver] 正在关闭浏览器...')
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
    console.log('[CDPDriver] 浏览器已关闭')
  }
}
