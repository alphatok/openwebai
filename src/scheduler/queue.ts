import type { CDPDriver } from '../driver/cdp-driver.js'
import type { BrowserTask, TaskResult } from '../types/task.js'
import { v4 as uuidv4 } from 'uuid'

/** Queued task item with callbacks */
interface QueuedTask {
  task: BrowserTask
  resolve: (result: TaskResult) => void
  reject: (err: Error) => void
}

/** FIFO Task Scheduler - serial execution of browser tasks */
export class TaskQueue {
  private queue: QueuedTask[] = []
  private processing = false
  private driver: CDPDriver

  constructor(driver: CDPDriver) {
    this.driver = driver
  }

  /** Enqueue task, returns Promise that resolves with result */
  enqueue(task: BrowserTask): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      this.queue.push({ task, resolve, reject })
      console.log(`[TaskQueue] Task enqueued: ${task.taskId} (queue length: ${this.queue.length})`)
      this.processNext()
    })
  }

  /** Process next task in queue */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return

    this.processing = true
    const item = this.queue.shift()!

    try {
      console.log(`[TaskQueue] Processing: ${item.task.taskId}`)
      const result = await this.driver.execute(item.task)
      item.resolve(result)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      item.reject(error)
    } finally {
      this.processing = false
      // Process next task
      this.processNext()
    }
  }

  /** Get current queue status */
  getStatus(): { queueLength: number; processing: boolean } {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
    }
  }

  /** Clear queue (for cancellation) */
  clear(): void {
    for (const item of this.queue) {
      item.reject(new Error('Task cancelled'))
    }
    this.queue = []
    console.log('[TaskQueue] Queue cleared')
  }
}

/** Create a browser task with generated taskId */
export function createBrowserTask(siteId: string, prompt: string): BrowserTask {
  return {
    taskId: uuidv4(),
    siteId,
    prompt,
    priority: 0,
    createdAt: Date.now(),
  }
}
