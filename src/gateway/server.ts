import Fastify from 'fastify'
import type { ChatRequest } from '../types/task.js'
import { toHttpError } from '../errors/adapter-error.js'
import { TaskQueue, createBrowserTask } from '../scheduler/queue.js'
import { CDPDriver } from '../driver/cdp-driver.js'
import { DeepSeekAdapter } from '../adapters/deepseek/adapter.js'

/** Built-in setup guide HTML */
const SETUP_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenWebAI - Setup Guide</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    max-width: 720px; margin: 40px auto; padding: 24px;
    line-height: 1.7;
  }
  h1 { color: #fff; font-size: 28px; margin-bottom: 4px; }
  .subtitle { color: #888; margin-bottom: 32px; }
  .status-bar {
    background: #1a1a2e; border-radius: 8px; padding: 16px 20px;
    margin-bottom: 32px; display: flex; align-items: center; gap: 12px;
    border-left: 4px solid #4ade80;
  }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #4ade80; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .step {
    background: #141422; border-radius: 10px; padding: 20px 24px; margin-bottom: 16px;
    border: 1px solid #222; transition: border-color 0.2s;
  }
  .step:hover { border-color: #333; }
  .step-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 50%;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: #fff; font-weight: 700; font-size: 14px; margin-right: 12px;
  }
  .step h3 { display: inline; color: #fff; font-size: 16px; }
  .step p { margin-top: 10px; color: #aaa; padding-left: 40px; }
  code {
    background: #1e1e3a; padding: 2px 8px; border-radius: 4px;
    color: #c084fc; font-size: 13px; font-family: 'Cascadia Code', 'Fira Code', monospace;
  }
  pre {
    background: #0d0d1a; border: 1px solid #222; border-radius: 8px;
    padding: 16px; overflow-x: auto; margin-top: 10px;
  }
  pre code { background: none; padding: 0; color: #4ade80; }
  .btn {
    display: inline-block; padding: 10px 24px; border-radius: 8px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: #fff; text-decoration: none; font-weight: 600;
    cursor: pointer; border: none; font-size: 14px; margin-top: 8px;
    transition: opacity 0.2s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .test-result {
    margin-top: 12px; padding: 12px 16px; border-radius: 6px;
    display: none; font-size: 13px;
  }
  .test-result.ok { display: block; background: #0d2a1a; color: #4ade80; border: 1px solid #1a4a2e; }
  .test-result.err { display: block; background: #2a0d0d; color: #f87171; border: 1spx solid #4a1a1a; }
  .api-section { margin-top: 32px; }
  .api-section h2 { color: #fff; font-size: 18px; margin-bottom: 16px; }
  .api-card {
    background: #141422; border-radius: 8px; padding: 16px 20px;
    margin-bottom: 12px; border: 1px solid #222;
  }
  .api-card h4 { color: #c084fc; margin-bottom: 6px; }
  .api-card p { color: #888; font-size: 13px; }
  .footer { text-align: center; color: #444; margin-top: 48px; font-size: 12px; }
</style>
</head>
<body>
<h1>OpenWebAI</h1>
<p class="subtitle">Turn web AI chat into local OpenAI-compatible API</p>

<div class="status-bar">
  <div class="status-dot"></div>
  <span>Server running at <code>http://localhost:3000</code></span>
</div>

<!-- Step 1 -->
<div class="step">
  <span class="step-num">1</span>
  <h3>Log in to DeepSeek</h3>
  <p>A Chrome window should have opened with <code>chat.deepseek.com</code>.<br>
     Log in with your account. The adapter will detect your login status.</p>
</div>

<!-- Step 2 -->
<div class="step">
  <span class="step-num">2</span>
  <h3>Test the connection</h3>
  <p>Click below to send a test message. If selectors are outdated, see Step 3.</p>
  <button class="btn" id="testBtn" onclick="runTest()">Run Test</button>
  <div id="testResult" class="test-result"></div>
</div>

<!-- Step 3 -->
<div class="step">
  <span class="step-num">3</span>
  <h3>Connect your AI client (optional)</h3>
  <p>Use any OpenAI-compatible client by setting:</p>
  <pre><code>Base URL: http://localhost:3000/v1
Model:     deepseek
API Key:    (leave empty)</code></pre>
  <p style="padding-left:40px;margin-top:8px;">
    Works with: ChatGPT-Next-Web, LobeChat, Continue, Cursor, etc.
  </p>
</div>

<!-- Step 4 -->
<div class="step">
  <span class="step-num">4</span>
  <h3>Use via curl / API</h3>
  <pre><code># Health check
curl http://localhost:3000/health

# Chat (non-streaming)
curl -X POST http://localhost:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek","messages":[{"role":"user","content":"Hello!"}]}'</code></pre>
</div>

<!-- API Reference -->
<div class="api-section">
  <h2>API Endpoints</h2>
  <div class="api-card">
    <h4>GET /health</h4>
    <p>Health check - returns {"status":"ok"}</p>
  </div>
  <div class="api-card">
    <h4>GET /v1/models</h4>
    <p>List available models (OpenAI-compatible)</p>
  </div>
  <div class="api-card">
    <h4>POST /v1/chat/completions</h4>
    <p>Chat completion (OpenAI-compatible). Supports stream:true for SSE.</p>
  </div>
</div>

<div class="footer">
  OpenWebAI v0.1.0 &mdash; <a href="https://github.com/alphatok/openwebai" style="color:#666">GitHub</a>
</div>

<script>
async function runTest() {
  const btn = document.getElementById('testBtn');
  const result = document.getElementById('testResult');
  btn.disabled = true;
  btn.textContent = 'Testing...';
  result.className = 'test-result';
  result.textContent = 'Sending test request...';

  try {
    const resp = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek',
        messages: [{ role: 'user', content: 'Say hi in one word.' }]
      })
    });
    const data = await resp.json();

    if (data.choices && data.choices[0]) {
      result.className = 'test-result ok';
      result.textContent = 'Success! Reply: "' + data.choices[0].message.content + '"';
    } else if (data.error) {
      result.className = 'test-result err';
      result.textContent = 'Error: ' + data.error +
        (data.recoverable ? ' (recoverable)' : '');
    } else {
      result.className = 'test-result err';
      result.textContent = 'Unexpected response: ' + JSON.stringify(data).slice(0, 200);
    }
  } catch(e) {
    result.className = 'test-result err';
    result.textContent = 'Request failed: ' + e.message;
  }

  btn.disabled = false;
  btn.textContent = 'Run Test';
}
</script>
</body>
</html>`

/** Create API Gateway service */
export async function createGateway(queue: TaskQueue) {
  const app = Fastify({ logger: false })

  // CORS
  await app.register(import('@fastify/cors'), {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })

  // Setup guide page (root)
  app.get('/', (_req, reply) => {
    reply.type('text/html').send(SETUP_PAGE_HTML)
  })

  // Health check
  app.get('/health', async () => ({ status: 'ok' }))

  // OpenAI-compatible endpoint: /v1/chat/completions
  app.post('/v1/chat/completions', async (request, reply): Promise<void> => {
    const body = request.body as ChatRequest

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
  app.get('/v1/models', async () => ({
    object: 'list',
    data: [
      { id: 'deepseek', object: 'model', owned_by: 'openwebai' },
    ],
  }))

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
