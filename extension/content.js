// content.js - Runs in ISOLATED world
// inject.js is loaded by manifest as world:MAIN at document_start
// This script bridges MAIN world ↔ Service Worker via postMessage + chrome.runtime

const TAG = '[OpenWebAI-Content]'
console.log(TAG, '=== Content script starting (ISOLATED world) ===')
console.log(TAG, 'URL:', window.location.href)
console.log(TAG, 'readyState:', document.readyState)

// === Bridge: background → inject.js (via postMessage) ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(TAG, '<<< onMessage: action=' + message.action + (message.cmd ? ' cmd=' + message.cmd : '') + (message.requestId ? ' reqId=' + message.requestId?.slice(0, 8) : ''))

  if (message.action === 'ping') {
    console.log(TAG, 'ping: responding ok=true')
    sendResponse({ ok: true })
    return true
  }

  if (message.action === 'execute_command') {
    console.log(TAG, 'execute_command: forwarding to MAIN world via postMessage, cmd=' + message.cmd)

    const payload = {
      source: 'openwebai-content',
      action: 'execute_command',
      cmd: message.cmd,
      data: message.data,
      requestId: message.requestId,
    }
    window.postMessage(payload, window.location.origin || '*')
    console.log(TAG, 'postMessage sent, waiting for response...')

    let responded = false
    const handler = (e) => {
      if (e.source !== window) return
      if (!e.data || e.data.source !== 'openwebai-inject') return
      if (e.data.requestId !== message.requestId) return

      console.log(TAG, '✅ Got response from inject.js: ok=' + e.data.ok + (e.data.error ? ' error=' + e.data.error : '') + (e.data.data ? ' hasData=yes' : ''))
      responded = true
      window.removeEventListener('message', handler)
      sendResponse({ ok: e.data.ok, error: e.data.error, data: e.data.data })
    }
    window.addEventListener('message', handler)

    setTimeout(() => {
      if (!responded) {
        console.error(TAG, '❌ Command timed out (9s), cmd=' + message.cmd)
        window.removeEventListener('message', handler)
        sendResponse({ ok: false, error: 'Command timed out in content script bridge' })
      }
    }, 9000)

    return true
  }

  console.warn(TAG, 'onMessage: unhandled action:', message.action)
  return true
})

// === Bridge: inject.js → background ===
// De-duplicate: use a Set to avoid sending duplicate events (inject.js may be loaded twice)
const sentKeys = new Set()
window.addEventListener('message', (e) => {
  if (e.source !== window) return
  if (!e.data || e.data.source !== 'openwebai-inject') return

  const action = e.data.action
  if (action === 'sse_data' || action === 'fetch_data' || action === 'fetch_done') {
    // Deduplicate: same action + url + ts shouldn't be sent twice
    const key = action + '|' + e.data.url + '|' + e.data.ts + '|' + (e.data.data ? e.data.data.length : 0)
    if (sentKeys.has(key)) {
      console.log(TAG, '⚠️ Dedup: skipping duplicate message:', action)
      return
    }
    sentKeys.add(key)
    // Clean up old keys to prevent memory leak
    if (sentKeys.size > 200) sentKeys.clear()

    const dataLen = e.data.data ? e.data.data.length : 0
    console.log(TAG, '>>> Forwarding to background: action=' + action + ' len=' + dataLen)
    chrome.runtime.sendMessage({
      action: action,
      url: e.data.url,
      data: e.data.data,
      ts: e.data.ts,
    }).then(resp => {
      console.log(TAG, '✅ sendMessage(' + action + ') ack:', JSON.stringify(resp))
    }).catch(err => {
      console.warn(TAG, '❌ sendMessage(' + action + ') failed:', err.message)
    })
  }
})

console.log(TAG, '=== Content script ready ===')
