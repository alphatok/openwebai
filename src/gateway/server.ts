import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import path from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs'
import type { ChatRequest, AnthropicRequest } from '../types/task.js'
import { toHttpError } from '../errors/adapter-error.js'
import { AdapterError } from '../errors/adapter-error.js'
import { DeepSeekAdapter } from '../adapters/deepseek/adapter.js'
import { WebSocketRelay } from '../bridge/ws-relay.js'
import { v4 as uuidv4 } from 'uuid'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(__dirname, '../../web')

const API_KEY = 'test123456'

/** Verify Authorization / x-api-key header */
function verifyApiKey(request: FastifyRequest): boolean {
  const auth = request.headers.authorization
  if (auth) {
    const [scheme, token] = auth.split(' ')
    return scheme?.toLowerCase() === 'bearer' && token === API_KEY
  }
  const xApiKey = request.headers['x-api-key']
  return xApiKey === API_KEY
}

/** Execute a chat task via the adapter */
async function executeTask(adapter: DeepSeekAdapter, prompt: string): Promise<{ content?: string; error?: { code: string; message: string; recoverable: boolean } }> {
  const taskId = uuidv4()
  console.log(`[Gateway] Task ${taskId}: "${prompt.slice(0, 50)}..."`)

  try {
    await adapter.inputText(prompt)
    await adapter.clickSubmit()
    await adapter.waitForCompletion()
    const content = await adapter.extractOutput(prompt)

    console.log(`[Gateway] Task ${taskId} completed, reply length: ${content.length}`)
    return { content }
  } catch (err) {
    const error = err instanceof AdapterError ? err : new AdapterError('NETWORK', String(err), true)
    console.error(`[Gateway] Task ${taskId} failed:`, error.message)
    return {
      error: {
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
      },
    }
  }
}

/** Create API Gateway service */
export async function createGateway(adapter: DeepSeekAdapter, relay: WebSocketRelay) {
  const app = Fastify({ logger: false })

  // CORS
  await app.register(import('@fastify/cors'), {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })

  // Serve static files from web/
  await app.register(import('@fastify/static'), {
    root: WEB_ROOT,
    prefix: '/',
  })

  // Setup guide page
  app.get('/', (_req, reply) => {
    return reply.sendFile('index.html')
  })

  // Debug chat page
  app.get('/debug', (_req, reply) => {
    return reply.sendFile('debug.html')
  })

  // Health check
  app.get('/health', async () => ({ status: 'ok' }))

  // Debug: return latest SSE log file content
  app.get('/debug/sse-log', async (_req, reply) => {
    try {
      const files = fs.readdirSync(process.cwd())
        .filter(f => f.startsWith('sse-log-') && f.endsWith('.txt'))
        .sort()
        .reverse()
      if (files.length === 0) return reply.send({ lines: [] })
      const content = fs.readFileSync(path.join(process.cwd(), files[0]), 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      return reply.send({ file: files[0], lines })
    } catch {
      return reply.send({ lines: [] })
    }
  })

  // Debug: return latest raw-log file
  app.get('/debug/raw-log', async (_req, reply) => {
    try {
      const files = fs.readdirSync(process.cwd())
        .filter(f => f.startsWith('raw-log-') && f.endsWith('.txt'))
        .sort()
        .reverse()
      if (files.length === 0) return reply.send({ lines: [] })
      const content = fs.readFileSync(path.join(process.cwd(), files[0]), 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      return reply.send({ file: files[0], lines })
    } catch {
      return reply.send({ lines: [] })
    }
  })

  // OpenAI-compatible endpoint: /v1/chat/completions
  app.post('/v1/chat/completions', async (request, reply): Promise<void> => {
    const body = request.body as ChatRequest
    console.log('[Gateway] POST /v1/chat/completions', { model: body?.model, msgCount: body?.messages?.length })

    // API key verification
    if (!verifyApiKey(request)) {
      reply.code(401).send({ error: { message: 'Invalid API key', type: 'invalid_request_error' } })
      return
    }

    // Check extension connection (non-fatal: still try, useful for debug mode)
    if (!relay.isClientConnected()) {
      console.warn('[Gateway] Extension not connected — request will likely timeout')
      // Continue anyway — user may be in debug mode, testing, or relay may connect later
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

    const taskId = uuidv4()
    const prompt = lastMessage.content

    try {
      if (body.stream) {
        // Stream response - SSE
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)

        const result = await executeTask(adapter, prompt)

        if (result.content) {
          reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { content: result.content }, finish_reason: null }] })}\n\n`)
        }

        reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${taskId}`, object: 'chat.completion.chunk', model: body.model, choices: [{ delta: {}, finish_reason: result.error ? 'stop' : 'stop' }] })}\n\n`)
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
      } else {
        // Non-stream response
        const result = await executeTask(adapter, prompt)

        if (result.content !== undefined) {
          reply.send({
            id: `chatcmpl-${taskId}`,
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                message: { role: 'assistant', content: result.content },
                finish_reason: 'stop',
              },
            ],
          })
          return
        }

        // Error response
        if (result.error) {
          const httpErr = toHttpError(new AdapterError(
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

  // Anthropic Messages API: /v1/messages
  app.post('/v1/messages', async (request, reply): Promise<void> => {
    const body = request.body as AnthropicRequest
    console.log('[Gateway] POST /v1/messages', { model: body?.model, msgCount: body?.messages?.length })

    if (!verifyApiKey(request)) {
      reply.code(401).send({ error: { type: 'authentication_error', message: 'Invalid API key' } })
      return
    }

    if (!relay.isClientConnected()) {
      console.warn('[Gateway] Extension not connected — request will likely timeout')
    }

    if (!body.messages?.length) {
      reply.code(400).send({ error: { type: 'invalid_request_error', message: 'messages is required' } })
      return
    }

    // Extract last user message
    const lastMessage = body.messages[body.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'user') {
      reply.code(400).send({ error: { type: 'invalid_request_error', message: 'last message must be from user' } })
      return
    }

    // Extract text from Anthropic content (string or content blocks)
    let prompt = ''
    if (typeof lastMessage.content === 'string') {
      prompt = lastMessage.content
    } else if (Array.isArray(lastMessage.content)) {
      prompt = lastMessage.content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
    }

    if (!prompt) {
      reply.code(400).send({ error: { type: 'invalid_request_error', message: 'no text content in last user message' } })
      return
    }

    const taskId = uuidv4()

    // Build system prompt from body.system
    if (body.system) {
      prompt = `${body.system}\n\n${prompt}`
    }

    try {
      if (body.stream) {
        // SSE streaming (Anthropic format)
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        // message_start
        reply.raw.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${taskId}`, type: 'message', role: 'assistant', model: body.model || 'deepseek', content: [], stop_reason: null } })}\n\n`)

        // content_block_start
        reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)

        // ping
        reply.raw.write(`event: ping\ndata: {}\n\n`)

        const result = await executeTask(adapter, prompt)

        if (result.content) {
          // content_block_delta
          reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.content } })}\n\n`)
        }

        // content_block_stop
        reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)

        // message_delta
        reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: result.error ? 'error' : 'end_turn' }, usage: { output_tokens: result.content ? result.content.length : 0 } })}\n\n`)

        // message_stop
        reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
        reply.raw.end()
      } else {
        // Non-stream
        const result = await executeTask(adapter, prompt)

        if (result.content !== undefined) {
          reply.send({
            id: `msg_${taskId}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: result.content }],
            model: body.model || 'deepseek',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: result.content.length },
          })
          return
        }

        if (result.error) {
          reply.code(500).send({
            error: { type: 'api_error', message: result.error.message },
          })
          return
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (body.stream) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`)
        reply.raw.end()
      } else {
        reply.code(500).send({ error: { type: 'api_error', message } })
      }
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
        { id: 'chat', object: 'model', owned_by: 'openwebai' },
      ],
    }
  })

  return app
}

/** Create complete app */
export async function createApp() {
  // 1. Create WebSocket relay
  const relay = new WebSocketRelay(18765)
  await relay.start()

  // 2. Create adapter
  const adapter = new DeepSeekAdapter()
  adapter.setRelay(relay)

  // 3. Create gateway
  const app = await createGateway(adapter, relay)

  return { app, relay }
}
