import type { Page } from 'playwright'

/** Site DOM selector configuration */
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

/** Core site adapter interface - all sites must implement this */
export interface ISiteAdapter {
  readonly siteId: string
  readonly config: SiteConfig

  init(page: Page): Promise<void>
  isReady(): boolean | Promise<boolean>
  inputText(prompt: string): Promise<void>
  clickSubmit(): Promise<void>
  waitForCompletion(): Promise<void>
  extractOutput(): Promise<string>
  isGenerating(): boolean
  hasCaptcha(): boolean
}

/** Browser driver interface */
export interface IBrowserDriver {
  launch(): Promise<void>
  execute(task: BrowserTask): Promise<TaskResult>
  getAdapter(siteId: string): ISiteAdapter | undefined
  close(): Promise<void>
}

// Re-export task types to avoid circular dependency
import type { BrowserTask, TaskResult } from './task.js'
export type { BrowserTask, TaskResult }
