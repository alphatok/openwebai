import Fastify from 'fastify'
import type { ChatRequest } from '../types/task.js'
import { toHttpError } from '../errors/adapter-error.js'
import { TaskQueue, createBrowserTask } from '../scheduler/queue.js'
import { CDPDriver } from '../driver/cdp-driver.js'
import { DeepSeekAdapter } from '../adapters/deepseek/adapter.js'

/** 创建 API Gateway 服务 */
export async function createGateway(queue: TaskQueue) {
  const app = Fastify({ logger: false })

  // CORS
  await app.register(import('@fastify/cors'), {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })

  // 健康检查
  app.get('/health', async () => ({ status: 'ok' }))

  // OpenAI 兼容接口: /v1/chat/completions
  app.post('/v1/chat/completions', async (request, reply): Promise<void> => {
    const body = request.body as ChatRequest

    // 参数校验
    if (!body.model) {
      reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } })
      return
    }
    if (!body.messages?.length) {
      reply.code(400).send({ error: { message: 'messages is required', type: 'invalid_request_error' } })
      return
    }

    // 提取最后一条用户消息作为 prompt
    const lastMessage = body.messages[body.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'user') {
      reply.code(400).send({ error: { message: 'last message must be from user', type: 'invalid_request_error' } })
      return
    }

    // 构造浏览器任务
    const task = createBrowserTask(body.model, lastMessage.content)

    try {
      if (body.stream) {
        // 流式响应 - SSE
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        // 发送 task ID
        reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${task.taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)

        // 入队并等待结果
        const result = await queue.enqueue(task)

        if (result.status === 'completed' && result.content) {
          // 一次性发送完整内容（MVP 简化：非真正流式）
          reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${task.taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { content: result.content }, finish_reason: null }] })}\n\n`)
        }

        // 结束
        reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${task.taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
      } else {
        // 非流式响应
        const result = await queue.enqueue(task)

        if (result.status === 'completed') {
          reply.send({
            id: `chatcmpl-${task.taskId}`,
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                message: { role: 'assistant', content: result.content ?? '' },
                finish_reason: 'stop',
              },
            ],
          })
          return
        }

        // 错误响应
        if (result.error) {
          const httpErr = toHttpError(new (await import('../errors/adapter-error.js')).AdapterError(
            result.error.code as never,
            result.error.message,
            result.error.recoverable,
          ))
          reply.code(httpErr.status).send(httpErr.body)
          return
        }

        reply.code(500).send({ error: { message: '任务执行失败', type: 'server_error' } })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply.code(500).send({ error: { message, type: 'server_error' } })
    }
  })

  // 列出可用模型
  app.get('/v1/models', async () => ({
    object: 'list',
    data: [
      { id: 'deepseek', object: 'model', owned_by: 'openwebai' },
    ],
  }))

  return app
}

/** 创建完整的 Gateway + Driver + Queue 实例 */
export async function createApp() {
  // 1. 创建驱动
  const driver = new CDPDriver()
  driver.registerAdapter(new DeepSeekAdapter())

  // 2. 创建调度器
  const queue = new TaskQueue(driver)

  // 3. 创建网关
  const app = await createGateway(queue)

  return { app, driver, queue }
}
