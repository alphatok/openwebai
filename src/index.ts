import { createApp } from './gateway/server.js'
import { exec } from 'child_process'
import path from 'path'
import os from 'os'
import fs from 'fs'

const PORT = Number(process.env.PORT) || 3000

/**
 * Auto-open browser only if not already opened in this dev session.
 * Uses a marker file in OS temp dir to avoid duplicate tabs on tsx watch restarts.
 */
function autoOpenBrowser(url: string): void {
  const markerPath = path.join(os.tmpdir(), '.openwebai-opened')

  // Check if already opened (marker exists and is not stale)
  try {
    const stat = fs.statSync(markerPath)
    const ageMin = (Date.now() - stat.mtimeMs) / 60000
    if (ageMin < 30) {
      console.log(`[openwebai] Browser already open: ${url} (skipping re-open)`)
      return
    }
    // Marker stale (>30 min), treat as not opened
    fs.unlinkSync(markerPath)
  } catch {
    // No marker file — first time
  }

  try {
    const platform = process.platform
    if (platform === 'win32') {
      exec(`start ${url}`)
    } else if (platform === 'darwin') {
      exec(`open ${url}`)
    } else {
      exec(`xdg-open ${url}`)
    }
    // Create marker
    fs.writeFileSync(markerPath, String(process.pid))
    console.log(`[openwebai] Browser opened: ${url}`)
  } catch {
    console.warn('[openwebai] Could not auto-open browser, please open manually:')
    console.warn(`         ${url}`)
  }
}

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

  // Auto-open setup guide page (skip if already open)
  autoOpenBrowser(`http://localhost:${PORT}`)

  const cleanupMarker = () => {
    try { fs.unlinkSync(path.join(os.tmpdir(), '.openwebai-opened')) } catch { /* ignore */ }
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[openwebai] Received ${signal}, shutting down...`)
    cleanupMarker()
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
