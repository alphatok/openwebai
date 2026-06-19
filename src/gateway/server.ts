import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ChatRequest } from '../types/task.js'
import { toHttpError } from '../errors/adapter-error.js'
import { TaskQueue, createBrowserTask } from '../scheduler/queue.js'
import { CDPDriver } from '../driver/cdp-driver.js'
import { DeepSeekAdapter } from '../adapters/deepseek/adapter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(__dirname, '../../web')

const API_KEY = 'test123456'

/** Verify Authorization header */
function verifyApiKey(request: FastifyRequest): boolean {
  const auth = request.headers.authorization
  if (!auth) return false
  const [scheme, token] = auth.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token === API_KEY
}

/** Create API Gateway service */
export async function createGateway(queue: TaskQueue) {
  const app = Fastify({ logger: false })

  // CORS
  await app.register(import('@fastify/cors'), {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })

  // Serve static files from web/ (CSS, JS, etc.)
  await app.register(import('@fastify/static'), {
    root: WEB_ROOT,
    prefix: '/',
  })

  // Setup guide page (root) - serve index.html
  app.get('/', (_req, reply) => {
    return reply.sendFile('index.html')
  })

  // Debug chat page
  app.get('/debug', (_req, reply) => {
    return reply.sendFile('debug.html')
  })

  // Health check
  app.get('/health', async () => ({ status: 'ok' }))

  // OpenAI-compatible endpoint: /v1/chat/completions
  app.post('/v1/chat/completions', async (request, reply): Promise<void> => {
    const body = request.body as ChatRequest
    console.log('[Gateway] POST /v1/chat/completions', { model: body?.model, msgCount: body?.messages?.length })

    // API key verification
    if (!verifyApiKey(request)) {
      reply.code(401).send({ error: { message: 'Invalid API key', type: 'invalid_request_error' } })
      return
    }

    // Parameter validation
    if (!body.model) {
      reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } })
      return
    }
    if (!body.messages?.length) {
      reply.code(400).send({ error: { message: 'messages is required', type: 'invalid_request_error' } })
      return
    }

    // Extract last user message as prompt
    const lastMessage = body.messages[body.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'user') {
      reply.code(400).send({ error: { message: 'last message must be from user', type: 'invalid_request_error' } })
      return
    }

    // Build browser task
    const task = createBrowserTask(body.model, lastMessage.content)

    try {
      if (body.stream) {
        // Stream response - SSE
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        // Send task ID
        reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${task.taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)

        // Enqueue and wait for result
        const result = await queue.enqueue(task)

        if (result.status === 'completed' && result.content) {
          // Send full content at once (MVP simplification: not true streaming)
          reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${task.taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { content: result.content }, finish_reason: null }] })}\n\n`)
        }

        // End stream
        reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${task.taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
      } else {
        // Non-stream response
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

        // Error response
        if (result.error) {
          const httpErr = toHttpError(new (await import('../errors/adapter-error.js')).AdapterError(
            result.error.code as never,
            result.error.message,
            result.error.recoverable,
          ))
          reply.code(httpErr.status).send(httpErr.body)
          return
        }

        reply.code(500).send({ error: { message: 'Task execution failed', type: 'server_error' } })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply.code(500).send({ error: { message, type: 'server_error' } })
    }
  })

  // List available models
  app.get('/v1/models', async (request, reply) => {
    if (!verifyApiKey(request)) {
      reply.code(401).send({ error: { message: 'Invalid API key', type: 'invalid_request_error' } })
      return
    }

    return {
      object: 'list',
      data: [
        { id: 'deepseek', object: 'model', owned_by: 'openwebai' },
      ],
    }
  })

  return app
}

/** Create complete Gateway + Driver + Queue instance */
export async function createApp() {
  // 1. Create driver
  const driver = new CDPDriver()
  driver.registerAdapter(new DeepSeekAdapter())

  // 2. Create scheduler
  const queue = new TaskQueue(driver)

  // 3. Create gateway
  const app = await createGateway(queue)

  return { app, driver, queue }
}
