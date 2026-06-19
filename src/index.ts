import { createApp } from './gateway/server.js'

const PORT = Number(process.env.PORT) || 3000

async function main() {
  console.log('[openwebai] Starting...')

  // Assemble all modules
  const { app, driver } = await createApp()

  // Launch browser driver
  await driver.launch()

  // Start API server
  await app.listen({ host: '0.0.0.0', port: PORT })

  console.log(`[openwebai] Server running: http://localhost:${PORT}`)
  console.log('[openwebai] OpenAI-compatible API: POST /v1/chat/completions')
  console.log('[openwebai] Models list: GET /v1/models')
  console.log('[openwebai] Health check: GET /health')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[openwebai] Received ${signal}, shutting down...`)
    await app.close()
    await driver.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[openwebai] Startup failed:', err)
  process.exit(1)
})
