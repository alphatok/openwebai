import type { Page } from 'playwright'

/** 站点 DOM 选择器配置 */
export interface SiteConfig {
  url: string
  selectors: {
    input: string
    submitButton: string
    stopButton?: string
    outputContainer: string
    captchaIndicator?: string
  }
  behavior: {
    typingDelayMs: [number, number]
    waitTimeoutMs: number
    pollIntervalMs: number
  }
}

/** 站点适配器核心接口 - 所有站点必须实现 */
export interface ISiteAdapter {
  readonly siteId: string
  readonly config: SiteConfig

  init(page: Page): Promise<void>
  isReady(): boolean
  inputText(prompt: string): Promise<void>
  clickSubmit(): Promise<void>
  waitForCompletion(): Promise<void>
  extractOutput(): Promise<string>
  isGenerating(): boolean
  hasCaptcha(): boolean
}

/** 浏览器驱动接口 */
export interface IBrowserDriver {
  launch(): Promise<void>
  execute(task: BrowserTask): Promise<TaskResult>
  getAdapter(siteId: string): ISiteAdapter | undefined
  close(): Promise<void>
}

// 重新导出 task 类型以避免循环依赖
import type { BrowserTask, TaskResult } from './task.js'
export type { BrowserTask, TaskResult }
