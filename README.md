# OpenWebAI

**Turn web-based AI chat into a local OpenAI-compatible & Anthropic-compatible API — for free.**

> 把网页版 AI 对话变成本地 OpenAI / Anthropic 兼容接口 —— 免费。

---

## TLDR

| What you get | 你能得到什么 |
|---|---|
| Local `http://localhost:3000/v1/chat/completions` (OpenAI format) | 本地 OpenAI 兼容接口 |
| Local `http://localhost:3000/v1/messages` (Anthropic format) | 本地 Anthropic 兼容接口 |
| Works with any OpenAI/Anthropic client (ChatGPT-Next-Web, LobeChat, Cursor, etc.) | 兼容所有主流 AI 客户端 |
| Free access to DeepSeek (and more sites coming) | 免费使用 DeepSeek（更多站点开发中） |
| Chrome Extension interceptor — no Playwright bot detection | Chrome 插件拦截 — 反检测更强 |
| Real-time SSE streaming passthrough | 实时流式透传 |

## Quick Start / 快速上手

### Prerequisites / 前置要求

- **Node.js 20+**
- **Chrome browser** (or any Chromium-based browser)
- **DeepSeek account** (logged in at https://chat.deepseek.com)

### Install / 安装

```bash
git clone https://github.com/alphatok/openwebai.git
cd openwebai
npm install
```

### Setup / 设置

**Step 1: Load Chrome Extension**

打开 Chrome → `chrome://extensions` → 开启"开发者模式" → "加载已解压的扩展程序" → 选择 `extension/` 文件夹

Open Chrome → `chrome://extensions` → Enable "Developer mode" → "Load unpacked" → select the `extension/` folder

**Step 2: Start Server**

```bash
npm run dev
```

Server starts at `http://localhost:3000`. A setup wizard page opens automatically.

服务启动于 `http://localhost:3000`。会自动打开设置向导页面。

**Step 3: Open DeepSeek**

Navigate to `https://chat.deepseek.com` in the same Chrome browser where the extension is loaded. The extension will show a status indicator.

在已加载扩展的 Chrome 中打开 `https://chat.deepseek.com`。扩展会显示连接状态。

### Use / 使用

#### Test with curl:

```bash
# Health check
curl http://localhost:3000/health

# List models
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer test123456"

# Chat (OpenAI format)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test123456" \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"Hello!"}]}'

# Chat (Anthropic format)
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test123456" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"chat","messages":[{"role":"user","content":"Hello!"}],"max_tokens":1024}'

# Streaming (OpenAI format)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test123456" \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"Hello!"}],"stream":true}'

# Streaming (Anthropic format)
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test123456" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"chat","messages":[{"role":"user","content":"Hello!"}],"max_tokens":1024,"stream":true}'
```

#### Use with any AI client:

**OpenAI 客户端 (ChatGPT-Next-Web / LobeChat / Chatbox):**

- Base URL: `http://localhost:3000/v1`
- Model: `deepseek`
- API Key: `test123456`

**Anthropic 客户端 (Cursor / Claude Code):**

- Base URL: `http://localhost:3000/v1`
- Model: `chat`
- API Key: `test123456`
- Anthropic Version: `2023-06-01`

## Architecture / 架构

```
┌──────────────┐       ┌──────────────┐       ┌──────────────────┐
│   AI Client  │──────▶│   Gateway    │──────▶│  DeepSeekAdapter │
│ (OpenAI/     │◀──────│  (Fastify)   │◀──────│  (SSE Parser)    │
│  Anthropic)  │       │              │       └────────┬─────────┘
└──────────────┘       └──────────────┘                │
                                                       │ WebSocket
                                               ┌───────┴────────┐
                                               │  WS Relay      │
                                               │  (ws://18765)  │
                                               └───────┬────────┘
                                                       │
┌──────────────────────────────────────────────────────┴────────┐
│  Chrome Extension (DeepSeek page)                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────────┐             │
│  │ inject.js │───▶│content.js│───▶│ background.js│──▶ WebSocket│
│  │(MAIN world)│   │(ISOLATED) │   │ (service wrkr)│            │
│  └──────────┘    └──────────┘    └──────────────┘             │
│  Intercepts: EventSource / fetch() on deepseek.com             │
└───────────────────────────────────────────────────────────────┘
```

**Flow / 数据流：**

1. AI client sends request → Gateway (OpenAI or Anthropic endpoint)
2. Gateway sends command via WebSocket → Chrome Extension types text & submits
3. Chrome Extension intercepts DeepSeek's SSE/fetch responses
4. SSE chunks flow: Extension → WebSocket → DeepSeekAdapter → parsed into text
5. Gateway formats response in OpenAI or Anthropic format → sent to client

**Modules / 模块：**

| Module | File | Description |
|--------|------|-------------|
| Gateway | `src/gateway/server.ts` | Fastify HTTP server, OpenAI + Anthropic compatible API |
| Adapter | `src/adapters/deepseek/adapter.ts` | DeepSeek SSE protocol parser (F1/F2/F3/F4/BATCH) |
| WS Relay | `src/bridge/ws-relay.ts` | WebSocket bridge between Extension and Node.js |
| Extension | `extension/` | Chrome Extension intercepting SSE/fetch traffic |
| WebUI | `web/` | Setup wizard & debug dashboard |
| Types | `src/types/` | Shared TypeScript type definitions |
| Errors | `src/errors/` | Structured error system with HTTP mapping |

## Project Structure / 项目结构

```
openwebai/
├── src/
│   ├── index.ts                  # Entry point — creates relay + gateway
│   ├── types/                    # TypeScript interfaces
│   │   ├── index.ts              # Barrel export
│   │   ├── task.ts               # ChatRequest, AnthropicRequest, TaskResult
│   │   ├── adapter.ts            # SiteConfig, ISiteAdapter
│   │   └── gateway.ts            # StreamChunk, ChatResponse
│   ├── errors/                   # Error system
│   │   ├── index.ts              # AdapterError codes
│   │   └── adapter-error.ts      # AdapterError → HTTP error mapping
│   ├── adapters/
│   │   └── deepseek/             # DeepSeek site adapter
│   │       ├── adapter.ts        # SSE parsing (F1/F2/F3/F4/BATCH), cmd relay
│   │       └── config.json       # Site selectors & behavior config
│   ├── bridge/
│   │   └── ws-relay.ts           # WebSocket relay (ws://localhost:18765)
│   └── gateway/
│       └── server.ts             # Fastify server (OpenAI + Anthropic endpoints)
├── extension/                    # Chrome Extension
│   ├── manifest.json             # MV3 manifest (deepseek.com permissions)
│   ├── inject.js                 # Injected into MAIN world — intercepts SSE/fetch
│   ├── content.js                # ISOLATED world — bridges inject ↔ background
│   └── background.js             # Service worker — WebSocket client to relay
├── web/                          # Built-in Web UI
│   ├── index.html                # Setup wizard / quick start guide
│   ├── debug.html                # Live SSE monitoring dashboard
│   ├── app.js                    # Debug dashboard logic (i18n-aware)
│   └── styles.css                # Shared styles
├── docs/
│   └── deepseek-sse-protocol-analysis.md  # SSE protocol deep-dive
├── scripts/                      # Dev utilities
├── package.json
├── tsconfig.json
└── README.md
```

## API Reference / API 参考

### OpenAI Compatible (`/v1/chat/completions`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model name (e.g., `deepseek`) |
| `messages` | array | Yes | Chat messages (system/user/assistant) |
| `stream` | boolean | No | Enable SSE streaming |
| `temperature` | number | No | Sampling temperature (ignored) |

**Response:**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "deepseek",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 128,
    "total_tokens": 140
  }
}
```

### Anthropic Compatible (`/v1/messages`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model ID (e.g., `chat`) |
| `messages` | array | Yes | Messages (user/assistant only) |
| `max_tokens` | number | **Yes** | Maximum tokens to generate |
| `system` | string | No | System prompt (top-level, not in messages) |
| `stream` | boolean | No | Enable SSE streaming |
| `stop_sequences` | array | No | Custom stop sequences |
| `temperature` | number | No | Sampling temperature |
| `top_k` | number | No | Top-K sampling |

**Headers:**

| Header | Required | Value |
|--------|----------|-------|
| `x-api-key` | Yes | `test123456` |
| `anthropic-version` | Yes | `2023-06-01` or `2023-01-01` |

**Response:**

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }],
  "model": "chat",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 12, "output_tokens": 128 }
}
```

### Debug Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /debug/sse-log` | Latest parsed SSE log content |
| `GET /debug/raw-log` | Latest raw intercepted data |
| `GET /debug` | Live debug dashboard (Web UI) |
| `GET /health` | Health check |

## DeepSeek SSE Protocol / DeepSeek 流式协议

DeepSeek uses a custom SSE protocol with 5 event types:

| Type | Purpose | Example |
|------|---------|---------|
| F1 | Incremental token | `{"v":"text"}` |
| F2 | Path-based patch | `{"p":"path","o":"APPEND","v":"text"}` |
| F3 | Batch operations | `{"o":"BATCH","v":[...]}` |
| F4 | Response snapshot | `{"v":{"response":{"fragments":[...]}}}` |

Control events: `completion`, `ready`, `update_session`, `FINISHED`

For full protocol details, see [docs/deepseek-sse-protocol-analysis.md](docs/deepseek-sse-protocol-analysis.md).

> 详细的协议分析见 [docs/deepseek-sse-protocol-analysis.md](docs/deepseek-sse-protocol-analysis.md)。

## How It Works / 工作原理

1. **Chrome Extension** injects into the DeepSeek page and monkey-patches `EventSource` / `window.fetch` to intercept all SSE and XHR traffic
2. **WebSocket Relay** (`ws://localhost:18765`) bridges the Extension with Node.js — forwarding intercepted data and receiving commands
3. **DeepSeekAdapter** parses DeepSeek's proprietary SSE protocol (F1/F2/F3/F4/BATCH) and reconstructs the full assistant response
4. **Gateway** exposes both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) compatible endpoints with full SSE streaming support

Key advantages over Playwright-based approaches:
- No browser automation bot detection
- Native SSE interception (no polling)
- Real-time streaming with minimal latency
- No additional CPU/memory overhead from headless browser

## Supported Sites / 支持站点

| Site | Status | Notes |
|------|--------|-------|
| [DeepSeek](https://chat.deepseek.com) | ✅ Stable | Chrome Extension interception |

> Want to add a new site? Create an adapter in `src/adapters/{site}/`, implement the pattern in `DeepSeekAdapter`, and add a corresponding Chrome Extension content script.
>
> 想添加新站点？在 `src/adapters/{site}/` 下创建适配器，参考 `DeepSeekAdapter` 实现，并添加对应的 Chrome 扩展内容脚本。

## Configuration / 配置

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3000` | API server port |

### API Key

Default API key is `test123456`. Modify `API_KEY` in `src/gateway/server.ts` to change it.

默认 API Key 为 `test123456`。修改 `src/gateway/server.ts` 中的 `API_KEY` 即可更换。

### DeepSeek Site Config

See `src/adapters/deepseek/config.json` for DOM selectors and behavior tuning (typing delay, timeouts, polling intervals).

站点配置见 `src/adapters/deepseek/config.json`，可调整 DOM 选择器、打字延迟、超时等参数。

## Logs / 日志

Debug logs are stored in `logs/` directory (gitignored):

| File | Content |
|------|---------|
| `sse-log-*.txt` | Parsed SSE events with tags (F1/F2/F3/F4/BATCH) |
| `raw-log-*.txt` | Unfiltered raw intercepted data |

You can also view logs via the debug dashboard at `http://localhost:3000/debug`.

也可以通过 `http://localhost:3000/debug` 调试面板实时查看日志。

## Development / 开发

```bash
# Dev mode with hot reload
npm run dev

# Build
npm run build

# Lint
npm run lint

# Format
npm run format
```

## FAQ

**Q: Does it work with ChatGPT-Next-Web? / 兼容 ChatGPT-Next-Web 吗？**  
A: Yes. Set API address to `http://localhost:3000/v1`, model to `deepseek`, API key to `test123456`.

**Q: Does it work with Cursor? / 兼容 Cursor 吗？**  
A: Yes. Use Anthropic format (`/v1/messages`) with model `chat`, API key `test123456`.

**Q: Will I get banned? / 会被封号吗？**  
A: Using Chrome Extension interception (not headless browser automation) significantly reduces detection risk, but use at your own discretion.

**Q: Can I add more sites? / 可以添加更多站点吗？**  
A: Yes! Implement the adapter interface in `src/adapters/{site}/` and add a Chrome Extension content script for that site.

**Q: Why WebSocket relay instead of Playwright? / 为什么用 WebSocket 而不是 Playwright？**  
A: Chrome Extension directly intercepts SSE/fetch traffic in the real browser, avoiding bot detection while providing true real-time streaming. Playwright was the initial approach but was replaced for better reliability.

**Q: How do I change the API key? / 如何更换 API Key？**  
A: Edit `API_KEY` constant in `src/gateway/server.ts`.

**Q: What if the extension doesn't connect? / 扩展连接不上怎么办？**  
A: Check the WebSocket relay status at `http://localhost:3000/health`. Make sure no firewall is blocking port `18765`, and that the extension is loaded and active on `chat.deepseek.com`.

## License

MIT