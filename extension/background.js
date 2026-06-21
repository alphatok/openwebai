// background.js - MV3 Service Worker
// Maintains WebSocket connection to local relay server

const RELAY_URL = 'ws://localhost:18765'
const RECONNECT_DELAY = 2000
const KEEPALIVE_ALARM = 'openwebai-keepalive'
const TAG = '[OpenWebAI-BG]'

console.log(TAG, '=== Service Worker starting ===')
console.log(TAG, 'RELAY_URL:', RELAY_URL)

let ws = null
let reconnectTimer = null
let pendingMessages = []
let connectAttempt = 0

// === Keep Service Worker alive via alarms ===
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 })
console.log(TAG, 'Alarm created:', KEEPALIVE_ALARM)

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log(TAG, 'Alarm fired:', alarm.name, 'ws state:', ws ? ws.readyState : 'null')
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log(TAG, 'Alarm: WS not connected (state=' + (ws ? ws.readyState : 'null') + '), reconnecting...')
      connect()
    } else {
      try {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
        console.log(TAG, 'Alarm: ping sent')
      } catch (e) {
        console.warn(TAG, 'Alarm: ping failed:', e.message)
      }
    }
  }
})

function connect() {
  console.log(TAG, 'connect() called, current ws state:', ws ? ws.readyState : 'null')

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log(TAG, 'connect() skipped: already open/connecting (state=' + ws.readyState + ')')
    return
  }

  connectAttempt++
  console.log(TAG, `Connecting to relay (attempt ${connectAttempt}):`, RELAY_URL)

  try {
    ws = new WebSocket(RELAY_URL)
    console.log(TAG, 'WebSocket created, initial state:', ws.readyState)
  } catch (e) {
    console.error(TAG, 'WebSocket create FAILED:', e.message)
    ws = null
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    console.log(TAG, `✅ Connected to relay (attempt ${connectAttempt})`)
    connectAttempt = 0
    const queued = pendingMessages.length
    console.log(TAG, 'Flushing pending messages:', queued)
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift()
      try {
        ws.send(JSON.stringify(msg))
      } catch (e) {
        console.error(TAG, 'Failed to flush message:', e.message)
      }
    }
    if (queued > 0) console.log(TAG, 'Pending messages flushed')
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === 'ping') {
        // Response with pong
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        return
      }
      if (data.type === 'pong') {
        // Keep-alive acknowledgement from relay
        console.log(TAG, '<<< Received pong from relay')
        return
      }
      
      console.log(TAG, '<<< Received from relay: type=' + data.type + (data.cmd ? ' cmd=' + data.cmd : '') + (data.requestId ? ' reqId=' + data.requestId.slice(0, 8) : ''))
      
      if (data.type === 'command') {
        handleCommandFromRelay(data)
      }
    } catch (e) {
      console.warn(TAG, 'Failed to parse relay message:', event.data?.slice(0, 100))
    }
  }

  ws.onclose = (e) => {
    console.log(TAG, `❌ Disconnected from relay (code=${e.code} reason="${e.reason || 'none'}")`)
    ws = null
    scheduleReconnect()
  }

  ws.onerror = (e) => {
    console.warn(TAG, 'WebSocket error event (type=' + e.type + ')')
    // Note: onerror is always followed by onclose, don't set ws=null here
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    console.log(TAG, 'scheduleReconnect: already scheduled, skipping')
    return
  }
  console.log(TAG, `scheduleReconnect: will retry in ${RECONNECT_DELAY}ms`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    console.log(TAG, 'Reconnect timer fired, calling connect()')
    connect()
  }, RECONNECT_DELAY)
}

function sendToRelay(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message))
    } catch (e) {
      console.error(TAG, 'sendToRelay failed:', e.message)
      if (pendingMessages.length < 500) pendingMessages.push(message)
    }
  } else {
    const state = ws ? ws.readyState : 'null'
    console.warn(TAG, `sendToRelay: WS not ready (state=${state}), queuing message type=${message.type}`)
    if (pendingMessages.length < 500) pendingMessages.push(message)
    connect()
  }
}

const DEEPSEEK_URL_PATTERNS = [
  'https://chat.deepseek.com/*',
  'https://www.deepseek.com/*',
]

async function findDeepSeekTab() {
  console.log(TAG, 'findDeepSeekTab: querying tabs...')
  const tabs = await chrome.tabs.query({ url: DEEPSEEK_URL_PATTERNS })
  console.log(TAG, 'findDeepSeekTab: found', tabs.length, 'matching tabs')
  if (tabs.length > 0) {
    console.log(TAG, 'Using tab:', tabs[0].id, tabs[0].url)
    return tabs[0]
  }
  console.warn(TAG, 'findDeepSeekTab: no DeepSeek tab found')
  return null
}

async function ensureContentScript(tabId, tabUrl) {
  console.log(TAG, `ensureContentScript: checking tab ${tabId}`)

  // First try ping
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { action: 'ping' })
    console.log(TAG, 'ensureContentScript: ping response:', JSON.stringify(resp))
    if (resp && resp.ok) {
      console.log(TAG, 'ensureContentScript: content script already running')
      return true
    }
  } catch (e) {
    console.warn(TAG, 'ensureContentScript: ping failed, will inject:', e.message)
  }

  // Inject content.js via scripting API (no page reload needed)
  console.log(TAG, 'ensureContentScript: injecting content.js into tab', tabId)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })
    console.log(TAG, 'ensureContentScript: content.js injected, waiting 500ms...')
    await new Promise(r => setTimeout(r, 500))

    // Verify
    const resp = await chrome.tabs.sendMessage(tabId, { action: 'ping' })
    console.log(TAG, 'ensureContentScript: post-inject ping:', JSON.stringify(resp))
    if (resp && resp.ok) {
      console.log(TAG, 'ensureContentScript: content script ready after inject')
      return true
    }
    console.error(TAG, 'ensureContentScript: still not ready after inject')
    return false
  } catch (err) {
    console.error(TAG, 'ensureContentScript: injection failed:', err.message)
    return false
  }
}

async function openDeepSeekTab() {
  console.log(TAG, 'openDeepSeekTab: creating new tab https://chat.deepseek.com')
  const tab = await chrome.tabs.create({ url: 'https://chat.deepseek.com', active: true })
  console.log(TAG, 'openDeepSeekTab: tab created, id=' + tab.id + ', waiting for load...')
  // Wait for the tab to finish loading
  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    // Timeout fallback: proceed after 10s even if not fully loaded
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 10000)
  })
  console.log(TAG, 'openDeepSeekTab: tab loaded, id=' + tab.id)
  // Re-query to get the final tab object (URL may have changed after redirects)
  const freshTab = await chrome.tabs.get(tab.id)
  return freshTab
}

// Find an existing localhost:3000 tab
async function findDashboardTab() {
  const tabs = await chrome.tabs.query({ url: 'http://localhost:3000/*' })
  if (tabs.length > 0) {
    console.log(TAG, 'findDashboardTab: found tab id=' + tabs[0].id + ' url=' + tabs[0].url)
    return tabs[0]
  }
  return null
}

// Open or focus the localhost:3000 dashboard
async function openDashboardTab() {
  let tab = await findDashboardTab()
  if (tab) {
    // Focus existing tab
    console.log(TAG, 'openDashboardTab: focusing existing tab id=' + tab.id)
    await chrome.tabs.update(tab.id, { active: true })
    // Also focus the window
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true })
    }
    return tab
  }
  // Create new tab
  console.log(TAG, 'openDashboardTab: creating new tab http://localhost:3000/')
  tab = await chrome.tabs.create({ url: 'http://localhost:3000/', active: true })
  return tab
}

async function handleCommandFromRelay(data) {
  console.log(TAG, '>>> handleCommandFromRelay: cmd=' + data.cmd + ' reqId=' + data.requestId?.slice(0, 8))

  // Special commands handled directly by background.js (no content script needed)
  if (data.cmd === 'open_dashboard') {
    try {
      const tab = await openDashboardTab()
      sendToRelay({ type: 'command_response', requestId: data.requestId, ok: true, data: { tabId: tab.id, url: tab.url } })
    } catch (err) {
      sendToRelay({ type: 'command_response', requestId: data.requestId, ok: false, error: err.message })
    }
    return
  }

  try {
    let tab = await findDeepSeekTab()
    if (!tab) {
      console.log(TAG, 'handleCommandFromRelay: no DeepSeek tab, auto-opening...')
      tab = await openDeepSeekTab()
      if (!tab) {
        console.error(TAG, 'handleCommandFromRelay: failed to open DeepSeek tab')
        sendToRelay({ type: 'command_response', requestId: data.requestId, ok: false, error: 'Failed to open https://chat.deepseek.com' })
        return
      }
    }

    console.log(TAG, 'handleCommandFromRelay: ensuring content script on tab', tab.id)
    const ready = await ensureContentScript(tab.id, tab.url)
    if (!ready) {
      console.error(TAG, 'handleCommandFromRelay: content script not ready')
      sendToRelay({ type: 'command_response', requestId: data.requestId, ok: false, error: 'Content script not responding. Refresh the DeepSeek page.' })
      return
    }

    console.log(TAG, 'handleCommandFromRelay: sending to tab', tab.id, 'cmd:', data.cmd)
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'execute_command',
      cmd: data.cmd,
      data: data.data,
      requestId: data.requestId,
    })

    console.log(TAG, 'handleCommandFromRelay: tab response:', JSON.stringify(response))
    sendToRelay({
      type: 'command_response',
      requestId: data.requestId,
      ok: response?.ok ?? false,
      error: response?.error,
      data: response?.data,
    })
    console.log(TAG, 'handleCommandFromRelay: response forwarded to relay, ok=' + (response?.ok ?? false))
  } catch (err) {
    console.error(TAG, 'handleCommandFromRelay ERROR:', err.message)
    sendToRelay({ type: 'command_response', requestId: data.requestId, ok: false, error: err.message })
  }
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabInfo = sender.tab ? `tab=${sender.tab.id}` : 'no-tab'
  console.log(TAG, '<<< onMessage: action=' + message.action + ' from ' + tabInfo)

  if (message.action === 'ping') {
    const state = ws ? ws.readyState : -1
    console.log(TAG, 'onMessage ping: ws state=' + state)
    sendResponse({ ok: true, wsState: state })
    return true
  }

  if (message.action === 'sse_data' || message.action === 'fetch_data' || message.action === 'fetch_done') {
    const dataLen = message.data ? message.data.length : 0
    console.log(TAG, `onMessage ${message.action}: url=${message.url?.slice(0, 60)} len=${dataLen}`)
    sendToRelay({
      type: message.action,
      url: message.url,
      data: message.data || '',
      ts: message.ts,
      tabId: sender.tab?.id,
    })
    sendResponse({ ok: true })
    return true
  }

  console.warn(TAG, 'onMessage: unhandled action:', message.action)
  return true
})

// Initial connect
console.log(TAG, 'Calling initial connect()...')
connect()

console.log(TAG, '=== Service Worker ready ===')
