# OpenWebAI

**Turn web-based AI chat into a local OpenAI-compatible API — for free.**

> 把网页版 AI 对话变成本地 OpenAI 兼容接口 —— 免费。

---

## TLDR

| What you get | 你能得到什么 |
|---|---|
| Local `http://localhost:3000/v1/chat/completions` API | 本地 OpenAI 兼容接口 |
| Works with any OpenAI client (ChatGPT-Next-Web, LobeChat, etc.) | 兼容所有 OpenAI 客户端 |
| Free access to DeepSeek (and more sites coming) | 免费使用 DeepSeek（更多站点开发中） |
| Human-like typing to avoid detection | 模拟真人打字，降低被检测风险 |
| Zero config — just run and use | 零配置 —— 开箱即用 |

## Quick Start / 快速上手

### Prerequisites / 前置要求

- **Node.js 20+**
- **Chrome browser installed** (used by Playwright)

### Install / 安装

```bash
git clone https://github.com/alphatok/openwebai.git
cd openwebai
npm install
npx playwright install chromium
```

### Run / 启动

```bash
npm run dev
```

Server starts at `http://localhost:3000`. A Chrome window will open automatically.

服务启动于 `http://localhost:3000`。会自动弹出 Chrome 窗口。

### Use / 使用

#### Test with curl:

```bash
# Health check
curl http://localhost:3000/health

# List models
curl http://localhost:3000/v1/models

# Chat (non-streaming)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"Hello!"}]}'
```

#### Use with any OpenAI client:

Set base URL to `http://localhost:3000/v1`, model to `deepseek`.

在任意 OpenAI 客户端中设置：
- **Base URL**: `http://localhost:3000/v1`
- **Model**: `deepseek`
- **API Key**: (leave empty / 留空)

## Architecture / 架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│   Client    │────▶│   Gateway    │────▶│   Queue     │────▶│    Driver    │
│ (OpenAI)    │◀────│  (Fastify)   │◀────│  (FIFO)     │◀────│  (Playwright)│
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
                                                                  │
                                                          ┌───────┴───────┐
                                                          │   Adapter     │
                                                          │  (DeepSeek)   │
                                                          └───────────────┘
```

**Modules:**

| Module | File | Description |
|--------|------|-------------|
| Gateway | `src/gateway/server.ts` | Fastify HTTP server, OpenAI-compatible API |
| Scheduler | `src/scheduler/queue.ts` | FIFO task queue, serial execution |
| Driver | `src/driver/cdp-driver.ts` | Playwright browser automation |
| Adapter | `src/adapters/` | Site-specific DOM interaction logic |
| Types | `src/types/` | Shared type definitions & contracts |

## Project Structure / 项目结构

```
openwebai/
├── src/
│   ├── index.ts              # Entry point
│   ├── types/                # Shared types (task, adapter, gateway)
│   ├── errors/               # Error system (AdapterError + HTTP mapping)
│   ├── adapters/
│   │   ├── base-adapter.ts   # Base class with typing delay, polling
│   │   └── deepseek/         # DeepSeek site adapter + config
│   ├── driver/
│   │   └── cdp-driver.ts     # Playwright CDP driver
│   ├── scheduler/
│   │   └── queue.ts          # FIFO task queue
│   └── gateway/
│       └── server.ts         # Fastify API server
├── package.json
├── tsconfig.json
└── README.md
```

## Supported Sites / 支持站点

| Site | Status | Notes |
|------|--------|-------|
| [DeepSeek](https://chat.deepseek.com) | ✅ MVP | DOM selectors may need update |

> Want to add a new site? Create an adapter in `src/adapters/{site}/` implementing `ISiteAdapter`.
>
> 想添加新站点？在 `src/adapters/{site}/` 下创建适配器实现 `ISiteAdapter` 接口即可。

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

**Q: Does it work with ChatGPT-Next-Web?**  
A: Yes. Set API address to `http://localhost:3000/v1`, model to `deepseek`.

**Q: Will I get banned?**  
A: Human-like typing with random delays reduces risk, but use at your own discretion.

**Q: Can I add more sites?**  
A: Yes! Implement `ISiteAdapter` interface and register it in `CDPDriver`.

**Q：兼容 ChatGPT-Next-Web 吗？**  
A：兼容。API 地址填 `http://localhost:3000/v1`，模型选 `deepseek`。

**Q：会被封号吗？**  
A：模拟真人打字可降低风险，但请自行评估使用风险。

**Q：可以添加更多站点吗？**  
A：可以！实现 `ISiteAdapter` 接口并在 `CDPDriver` 中注册即可。

## License

MIT
