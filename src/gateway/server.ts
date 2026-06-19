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
  .lang-toggle {
    float: right; margin-top: -36px; margin-bottom: 12px;
  }
  .lang-toggle button {
    background: #1a1a2e; color: #888; border: 1px solid #333;
    padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 13px;
    transition: all 0.2s;
  }
  .lang-toggle button:hover { color: #fff; border-color: #6366f1; }
  .lang-toggle button.active { color: #fff; background: #6366f1; border-color: #6366f1; }
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
  .test-result.err { display: block; background: #2a0d0d; color: #f87171; border: 1px solid #4a1a1a; }
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
<p class="subtitle" data-i18n="subtitle">Turn web AI chat into local OpenAI-compatible API</p>

<div class="lang-toggle">
  <button id="btnEn" class="active" onclick="setLang('en')">EN</button>
  <button id="btnZh" onclick="setLang('zh')">中文</button>
</div>

<div class="status-bar">
  <div class="status-dot"></div>
  <span data-i18n="status">Server running at <code>http://localhost:3000</code></span>
</div>

<!-- Step 1 -->
<div class="step">
  <span class="step-num">1</span>
  <h3 data-i18n="step1_title">Log in to DeepSeek</h3>
  <p data-i18n="step1_desc">A Chrome window should have opened with <code>chat.deepseek.com</code>.<br>
     Log in with your account. Login state is saved across sessions.</p>
</div>

<!-- Step 2 -->
<div class="step">
  <span class="step-num">2</span>
  <h3 data-i18n="step2_title">Test the connection</h3>
  <p data-i18n="step2_desc">Click below to send a test message to DeepSeek.</p>
  <button class="btn" id="testBtn" onclick="runTest()" data-i18n="step2_btn">Run Test</button>
  <div id="testResult" class="test-result"></div>
</div>

<!-- Step 3 -->
<div class="step">
  <span class="step-num">3</span>
  <h3 data-i18n="step3_title">Connect your AI client (optional)</h3>
  <p data-i18n="step3_desc">Use any OpenAI-compatible client by setting:</p>
  <pre><code>Base URL: http://localhost:3000/v1
Model:     deepseek
API Key:    (leave empty)</code></pre>
  <p style="padding-left:40px;margin-top:8px;" data-i18n="step3_clients">
    Works with: ChatGPT-Next-Web, LobeChat, Continue, Cursor, etc.
  </p>
</div>

<!-- Step 4 -->
<div class="step">
  <span class="step-num">4</span>
  <h3 data-i18n="step4_title">Use via curl / API</h3>
  <pre><code># Health check
curl http://localhost:3000/health

# Chat (non-streaming)
curl -X POST http://localhost:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek","messages":[{"role":"user","content":"Hello!"}]}'</code></pre>
</div>

<!-- API Reference -->
<div class="api-section">
  <h2 data-i18n="api_title">API Endpoints</h2>
  <div class="api-card">
    <h4>GET /health</h4>
    <p data-i18n="api_health">Health check - returns {"status":"ok"}</p>
  </div>
  <div class="api-card">
    <h4>GET /v1/models</h4>
    <p data-i18n="api_models">List available models (OpenAI-compatible)</p>
  </div>
  <div class="api-card">
    <h4>POST /v1/chat/completions</h4>
    <p data-i18n="api_chat">Chat completion (OpenAI-compatible). Supports stream:true for SSE.</p>
  </div>
</div>

<div class="footer">
  OpenWebAI v0.1.0 &mdash; <a href="https://github.com/alphatok/openwebai" style="color:#666">GitHub</a>
</div>

<script>
const i18n = {
  en: {
    subtitle: 'Turn web AI chat into local OpenAI-compatible API',
    status: 'Server running at <code>http://localhost:3000</code>',
    step1_title: 'Log in to DeepSeek',
    step1_desc: 'A Chrome window should have opened with <code>chat.deepseek.com</code>.<br>Log in with your account. Login state is saved across sessions.',
    step2_title: 'Test the connection',
    step2_desc: 'Click below to send a test message to DeepSeek.',
    step2_btn: 'Run Test',
    step3_title: 'Connect your AI client (optional)',
    step3_desc: 'Use any OpenAI-compatible client by setting:',
    step3_clients: 'Works with: ChatGPT-Next-Web, LobeChat, Continue, Cursor, etc.',
    step4_title: 'Use via curl / API',
    api_title: 'API Endpoints',
    api_health: 'Health check - returns {"status":"ok"}',
    api_models: 'List available models (OpenAI-compatible)',
    api_chat: 'Chat completion (OpenAI-compatible). Supports stream:true for SSE.',
    testing: 'Testing...',
    sending: 'Sending test request...',
    success: 'Success! Reply: ',
    error: 'Error: ',
    unexpected: 'Unexpected response: ',
    failed: 'Request failed: ',
  },
  zh: {
    subtitle: '\u628a\u7f51\u9875\u7248 AI \u5bf9\u8bdd\u53d8\u6210\u672c\u5730 OpenAI \u517c\u5bb9\u63a5\u53e3',
    status: '\u670d\u52a1\u5df2\u542f\u52a8\uff1a<code>http://localhost:3000</code>',
    step1_title: '\u767b\u5f55 DeepSeek',
    step1_desc: 'Chrome \u6d4f\u89c8\u5668\u5e94\u5df2\u6253\u5f00 <code>chat.deepseek.com</code>\u3002<br>\u8bf7\u5728\u6d4f\u89c8\u5668\u4e2d\u767b\u5f55\u4f60\u7684\u8d26\u53f7\uff0c\u767b\u5f55\u72b6\u6001\u4f1a\u81ea\u52a8\u4fdd\u5b58\u3002',
    step2_title: '\u6d4b\u8bd5\u8fde\u63a5',
    step2_desc: '\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\uff0c\u53d1\u9001\u4e00\u6761\u6d4b\u8bd5\u6d88\u606f\u7ed9 DeepSeek\u3002',
    step2_btn: '\u8fd0\u884c\u6d4b\u8bd5',
    step3_title: '\u63a5\u5165 AI \u5ba2\u6237\u7aef\uff08\u53ef\u9009\uff09',
    step3_desc: '\u5728\u4efb\u4f55 OpenAI \u517c\u5bb9\u5ba2\u6237\u7aef\u4e2d\u8bbe\u7f6e\uff1a',
    step3_clients: '\u517c\u5bb9\uff1aChatGPT-Next-Web\u3001LobeChat\u3001Continue\u3001Cursor \u7b49',
    step4_title: '\u4f7f\u7528 curl / API',
    api_title: 'API \u63a5\u53e3',
    api_health: '\u5065\u5eb7\u68c0\u67e5 - \u8fd4\u56de {"status":"ok"}',
    api_models: '\u5217\u51fa\u53ef\u7528\u6a21\u578b\uff08OpenAI \u517c\u5bb9\uff09',
    api_chat: '\u5bf9\u8bdd\u8865\u5168\uff08OpenAI \u517c\u5bb9\uff09\u3002\u652f\u6301 stream:true \u6d41\u5f0f\u54cd\u5e94\u3002',
    testing: '\u6d4b\u8bd5\u4e2d...',
    sending: '\u6b63\u5728\u53d1\u9001\u6d4b\u8bd5\u8bf7\u6c42...',
    success: '\u6210\u529f\uff01\u56de\u590d\uff1a',
    error: '\u9519\u8bef\uff1a',
    unexpected: '\u672a\u77e5\u54cd\u5e94\uff1a',
    failed: '\u8bf7\u6c42\u5931\u8d25\uff1a',
  }
};

let currentLang = 'en';

function setLang(lang) {
  currentLang = lang;
  document.getElementById('btnEn').className = lang === 'en' ? 'active' : '';
  document.getElementById('btnZh').className = lang === 'zh' ? 'active' : '';
  document.documentElement.lang = lang;

  const t = i18n[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (t[key] !== undefined) el.innerHTML = t[key];
  });
}

// Auto-detect language
if (navigator.language.startsWith('zh')) setLang('zh');

async function runTest() {
  const btn = document.getElementById('testBtn');
  const result = document.getElementById('testResult');
  const t = i18n[currentLang];
  btn.disabled = true;
  btn.textContent = t.testing;
  result.className = 'test-result';
  result.textContent = t.sending;

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
      result.textContent = t.success + '"' + data.choices[0].message.content + '"';
    } else if (data.error) {
      result.className = 'test-result err';
      result.textContent = t.error + (data.error.message || data.error);
    } else {
      result.className = 'test-result err';
      result.textContent = t.unexpected + JSON.stringify(data).slice(0, 200);
    }
  } catch(e) {
    result.className = 'test-result err';
    result.textContent = t.failed + e.message;
  }

  btn.disabled = false;
  btn.textContent = t.step2_btn;
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
