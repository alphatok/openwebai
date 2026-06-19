import { createApp } from './gateway/server.js'
import { exec } from 'child_process'

const PORT = Number(process.env.PORT) || 3000

async function main() {
  console.log('[openwebai] Starting...')

  // Create app with relay
  const { app, relay } = await createApp()

  // Start API server
  await app.listen({ host: '0.0.0.0', port: PORT })

  console.log(`[openwebai] Server running: http://localhost:${PORT}`)
  console.log('[openwebai] OpenAI-compatible API: POST /v1/chat/completions')
  console.log('[openwebai] Models list: GET /v1/models')
  console.log('[openwebai] Setup guide: http://localhost:${PORT}/')
  console.log('[openwebai] WebSocket relay: ws://localhost:18765')
  console.log('[openwebai] Chrome extension: extension/ (load unpacked in chrome://extensions)')
  console.log('')
  console.log('[openwebai] Waiting for browser extension connection...')
  console.log('[openwebai] >>> Please open DeepSeek in Chrome and ensure extension is loaded <<<')

  // Auto-open setup guide page
  try {
    const url = `http://localhost:${PORT}`
    const platform = process.platform
    if (platform === 'win32') {
      exec(`start ${url}`)
    } else if (platform === 'darwin') {
      exec(`open ${url}`)
    } else {
      exec(`xdg-open ${url}`)
    }
  } catch {
    console.warn('[openwebai] Could not auto-open browser, please open manually:')
    console.warn(`         http://localhost:${PORT}`)
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[openwebai] Received ${signal}, shutting down...`)
    await relay.stop()
    await app.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[openwebai] Startup failed:', err)
  process.exit(1)
})
