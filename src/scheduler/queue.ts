import type { CDPDriver } from '../driver/cdp-driver.js'
import type { BrowserTask, TaskResult } from '../types/task.js'
import { v4 as uuidv4 } from 'uuid'

/** 队列中的任务项（带回调） */
interface QueuedTask {
  task: BrowserTask
  resolve: (result: TaskResult) => void
  reject: (err: Error) => void
}

/** FIFO 任务调度器 - 串行执行浏览器任务 */
export class TaskQueue {
  private queue: QueuedTask[] = []
  private processing = false
  private driver: CDPDriver

  constructor(driver: CDPDriver) {
    this.driver = driver
  }

  /** 入队任务，返回 Promise 可等待结果 */
  enqueue(task: BrowserTask): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      this.queue.push({ task, resolve, reject })
      console.log(`[TaskQueue] 任务入队: ${task.taskId} (队列长度: ${this.queue.length})`)
      this.processNext()
    })
  }

  /** 消费队列中的下一个任务 */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return

    this.processing = true
    const item = this.queue.shift()!

    try {
      console.log(`[TaskQueue] 开始处理: ${item.task.taskId}`)
      const result = await this.driver.execute(item.task)
      item.resolve(result)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      item.reject(error)
    } finally {
      this.processing = false
      // 继续处理下一个
      this.processNext()
    }
  }

  /** 获取当前队列状态 */
  getStatus(): { queueLength: number; processing: boolean } {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
    }
  }

  /** 清空队列（用于取消） */
  clear(): void {
    for (const item of this.queue) {
      item.reject(new Error('任务已取消'))
    }
    this.queue = []
    console.log('[TaskQueue] 队列已清空')
  }
}

/** 创建带 taskId 的浏览器任务 */
export function createBrowserTask(siteId: string, prompt: string): BrowserTask {
  return {
    taskId: uuidv4(),
    siteId,
    prompt,
    priority: 0,
    createdAt: Date.now(),
  }
}
