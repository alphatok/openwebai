// inject.js - Runs in page's MAIN world
// Intercepts EventSource and fetch streams on DeepSeek page
// Communicates with content.js (ISOLATED world) via window.postMessage

// Guard: prevent double-injection
if (window.__openwebai_installed__) {
  console.log('[OpenWebAI-Inject] Already installed, skipping re-injection')
} else {
window.__openwebai_installed__ = true

const TAG = '[OpenWebAI-Inject]'
console.log(TAG, '=== Script starting ===')
console.log(TAG, 'URL:', window.location.href)

// === Listen for commands from content.js (ISOLATED world) ===
window.addEventListener('message', (e) => {
  if (e.source !== window) return
  if (!e.data || e.data.source !== 'openwebai-content') return
  if (e.data.action !== 'execute_command') return

  const { cmd, data, requestId } = e.data
  console.log(TAG, '>>> Received command:', cmd, 'requestId:', requestId)

  try {
    if (cmd === 'input_text') {
      handleInputText(data)
      sendResponse(requestId, { ok: true })
    } else if (cmd === 'click_submit') {
      handleClickSubmit().then(() => {
        sendResponse(requestId, { ok: true })
      }).catch(err => {
        sendResponse(requestId, { ok: false, error: err.message })
      })
      return // async, don't fall through
    } else if (cmd === 'get_page_info') {
      sendResponse(requestId, {
        ok: true,
        url: window.location.href,
        title: document.title,
      })
    } else if (cmd === 'list_sessions') {
      handleListSessions(data, requestId)
      return // async
    } else if (cmd === 'delete_session') {
      handleDeleteSession(data, requestId)
      return // async
    } else if (cmd === 'new_session') {
      handleNewSession(data, requestId)
      return // async
    } else if (cmd === 'get_session_messages') {
      handleGetSessionMessages(data, requestId)
      return // async
    } else {
      sendResponse(requestId, { ok: false, error: 'Unknown command: ' + cmd })
    }
  } catch (err) {
    console.error(TAG, 'Command error:', err)
    sendResponse(requestId, { ok: false, error: err.message })
  }
})

function sendResponse(requestId, data) {
  console.log(TAG, 'Sending response:', requestId, JSON.stringify(data).slice(0, 100))
  window.postMessage({
    source: 'openwebai-inject',
    requestId: requestId,
    ...data,
  }, window.location.origin)
}

function setReactInputValue(input, text) {
  const reactPropsKey = Object.keys(input).find(k => k.startsWith('__reactProps'))
  console.log(TAG, 'React props key:', reactPropsKey)

  // Step 1: Native setter — tells React the DOM value changed
  const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set
  nativeSetter.call(input, text)
  console.log(TAG, 'Native setter done, value:', input.value.slice(0, 30))

  // Step 2: InputEvent (React 17+ listens on root for this)
  input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  }))

  // Step 3: change event
  input.dispatchEvent(new Event('change', { bubbles: true }))

  // Step 4: Call React's onChange prop directly if available
  if (reactPropsKey) {
    const props = input[reactPropsKey]
    if (props && typeof props.onChange === 'function') {
      console.log(TAG, 'Calling React onChange prop directly')
      const fakeEvent = {
        target: input,
        currentTarget: input,
        type: 'change',
        bubbles: true,
        nativeEvent: new Event('change'),
        preventDefault: () => {},
        stopPropagation: () => {},
        persist: () => {},
      }
      try { props.onChange(fakeEvent) } catch(e) { console.warn(TAG, 'props.onChange failed:', e.message) }
    }
  }

  console.log(TAG, 'setReactInputValue done')
}

function handleInputText(text) {
  console.log(TAG, 'handleInputText called, text:', text.slice(0, 50))

  const selectors = [
    "textarea[placeholder='Message DeepSeek']",
    'textarea',
    '[contenteditable="true"]',
    'div[role="textbox"]',
  ]
  let input = null
  for (const sel of selectors) {
    input = document.querySelector(sel)
    if (input) {
      console.log(TAG, 'Found input with selector:', sel, 'tag:', input.tagName)
      break
    }
  }

  if (!input) {
    const all = document.querySelectorAll('textarea, [contenteditable]')
    console.log(TAG, 'No input found. All textarea/contenteditable:', all.length)
    all.forEach((el, i) => console.log(TAG, '  [' + i + '] tag=' + el.tagName + ' placeholder=' + (el.placeholder||'') + ' class=' + el.className.slice(0, 50)))
    throw new Error('Input element not found')
  }

  input.focus()
  console.log(TAG, 'Input focused')

  setReactInputValue(input, text)
  console.log(TAG, 'Text input done, value:', input.value.slice(0, 50))
}

async function handleClickSubmit() {
  console.log(TAG, 'handleClickSubmit called')

  // Wait up to 3s for a send button to become enabled
  const btn = await waitForSendButton(3000)
  if (btn) {
    console.log(TAG, 'Clicking send button:', btn.outerHTML.slice(0, 100))
    btn.click()
    console.log(TAG, 'Send button clicked')
    return
  }

  // Fallback: Enter key on textarea
  console.log(TAG, 'No enabled send button found, trying Enter key...')
  const input = document.querySelector("textarea[placeholder='Message DeepSeek']") || document.querySelector('textarea')
  if (input) {
    input.focus()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
    input.dispatchEvent(enterEvent)
    console.log(TAG, 'Enter key dispatched')
  } else {
    throw new Error('No send button or textarea found')
  }
}

function waitForSendButton(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now()

    function check() {
      const allBtns = Array.from(document.querySelectorAll('button'))

      // Try specific selectors first
      const specificSelectors = [
        'button[aria-label*="send" i]',
        'button[aria-label*="发送" i]',
        'button[class*="send"]',
        '[data-testid="send-button"]',
      ]
      for (const sel of specificSelectors) {
        const b = document.querySelector(sel)
        if (b && !b.disabled) {
          console.log(TAG, 'Found enabled send button via:', sel)
          return resolve(b)
        }
      }

      // DeepSeek has no class/aria on buttons — find last enabled submit button
      // (The send button is always the last submit button on the page)
      const submitBtns = allBtns.filter(b => b.type === 'submit' && !b.disabled)
      console.log(TAG, `waitForSendButton: ${submitBtns.length} enabled submit buttons (total ${allBtns.length})`)

      if (submitBtns.length > 0) {
        const sendBtn = submitBtns[submitBtns.length - 1]
        console.log(TAG, 'Using last enabled submit button, html:', sendBtn.outerHTML.slice(0, 80))
        return resolve(sendBtn)
      }

      if (Date.now() - start >= timeoutMs) {
        console.warn(TAG, 'waitForSendButton: timeout after', timeoutMs, 'ms')
        return resolve(null)
      }

      setTimeout(check, 200)
    }

    check()
  })
}

// === Session management commands ===

async function handleListSessions(data, requestId) {
  const limit = data?.limit || 10
  console.log(TAG, 'listSessions: limit=' + limit)
  try {
    // 1. Try API first
    const resp = await fetch('/api/v0/chat/history?limit=' + limit, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    })
    
    if (resp.ok) {
      const json = await resp.json()
      const biz = json?.data?.biz_data
      const list = Array.isArray(biz)
        ? biz
        : Array.isArray(biz?.list)
          ? biz.list
          : Array.isArray(json?.data?.list)
            ? json.data.list
            : null

      if (list) {
        console.log(TAG, 'listSessions: got from API')
        sendResponse(requestId, { ok: true, data: { data: { biz_data: list.slice(0, limit) } } })
        return
      }
    }
  } catch (e) {
    console.warn(TAG, 'listSessions API failed, trying DOM extraction:', e.message)
  }

  // 2. Fallback to DOM extraction (Robustness / Automation logic)
  try {
    const anchors = Array.from(document.querySelectorAll('a'))
      .filter(a => typeof a.href === 'string' && a.href.includes('/a/chat/s/'))

    const seen = new Set()
    const sessions = []
    for (const a of anchors) {
      try {
        const u = new URL(a.href)
        const parts = u.pathname.split('/').filter(Boolean)
        const id = parts[parts.length - 1]
        if (!id || seen.has(id)) continue
        seen.add(id)
        const title = (a.innerText || '').trim() || (a.getAttribute('title') || '').trim() || 'Untitled'
        sessions.push({ id, title, url: a.href })
        if (sessions.length >= limit) break
      } catch {
        // ignore invalid URL
      }
    }

    if (sessions.length > 0) {
      console.log(TAG, 'listSessions: got from DOM extraction')
      sendResponse(requestId, { 
        ok: true, 
        data: { 
          data: { 
            biz_data: sessions.map(s => ({ id: s.id, title: s.title })) 
          } 
        } 
      })
      return
    }
  } catch (e) {
    console.error(TAG, 'listSessions DOM extraction error:', e.message)
  }

  sendResponse(requestId, { ok: false, error: 'Failed to fetch session list via API or DOM' })
}

function pickFirstString(obj, paths) {
  for (const p of paths) {
    let cur = obj
    const parts = p.split('.')
    let ok = true
    for (const key of parts) {
      if (!cur || typeof cur !== 'object' || !(key in cur)) {
        ok = false
        break
      }
      cur = cur[key]
    }
    if (!ok) continue
    if (typeof cur === 'string' && cur.trim()) return cur.trim()
  }
  return null
}

async function handleDeleteSession(data, requestId) {
  const sessionId = data?.sessionId
  if (!sessionId) {
    sendResponse(requestId, { ok: false, error: 'sessionId is required' })
    return
  }
  console.log(TAG, 'deleteSession: id=' + sessionId)
  try {
    const resp = await fetch('/api/v0/chat/delete_session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_session_id: sessionId }),
    })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const json = await resp.json()
    console.log(TAG, 'deleteSession: done')
    sendResponse(requestId, { ok: true, data: json })
  } catch (e) {
    console.warn(TAG, 'deleteSession API failed, trying DOM automation:', e.message)
    try {
      const safeId = (window.CSS && typeof CSS.escape === 'function')
        ? CSS.escape(sessionId)
        : String(sessionId).replace(/[^\w-]/g, '\\$&')
      const link = document.querySelector(`a[href*="/a/chat/s/${safeId}"]`)
      if (link) {
        link.scrollIntoView({ block: 'center' })
        link.click()
        await new Promise(r => setTimeout(r, 600))
      }

      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'))
      const menuBtn = candidates.find(el => {
        const t = (el.innerText || '').trim()
        const aria = (el.getAttribute('aria-label') || '').trim()
        return t === '⋯' || t === '...' || /more/i.test(aria) || /更多/.test(aria) || /menu/i.test(aria) || /菜单/.test(aria)
      })

      if (menuBtn) {
        menuBtn.click()
        await new Promise(r => setTimeout(r, 300))
      }

      const items = Array.from(document.querySelectorAll('button, div[role="menuitem"], div[role="button"]'))
      const del = items.find(el => {
        const t = (el.innerText || '').trim()
        return /^delete$/i.test(t) || t === '删除' || t === '移至回收站' || /删除/.test(t)
      })

      if (del) {
        del.click()
        await new Promise(r => setTimeout(r, 200))
      }

      const confirms = Array.from(document.querySelectorAll('button, div[role="button"]'))
      const confirmBtn = confirms.find(el => {
        const t = (el.innerText || '').trim()
        return /^delete$/i.test(t) || t === '删除' || t === '确认' || t === '确定'
      })

      if (confirmBtn) {
        confirmBtn.click()
        sendResponse(requestId, { ok: true, data: { status: 'deleted_via_dom' } })
        return
      }
    } catch (e2) {
      console.error(TAG, 'deleteSession DOM automation error:', e2.message)
    }

    sendResponse(requestId, { ok: false, error: e.message })
  }
}

async function handleNewSession(data, requestId) {
  console.log(TAG, 'newSession: creating...')
  try {
    // 1. Try API first
    const resp = await fetch('/api/v0/chat/create_session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    
    if (resp.ok) {
      const json = await resp.json()
      const newId = pickFirstString(json, [
        'data.biz_data.id',
        'data.biz_data.chat_session_id',
        'data.id',
        'data.chat_session_id',
        'biz_data.id',
        'biz_data.chat_session_id',
        'id',
        'chat_session_id',
      ])
      if (newId) {
        console.log(TAG, 'newSession: created id=' + newId)
        sendResponse(requestId, { ok: true, data: { ...json, __openwebai: { sessionId: newId } } })
        setTimeout(() => {
          try {
            window.location.assign('/a/chat/s/' + encodeURIComponent(newId))
          } catch {}
        }, 50)
        return
      }
    }
  } catch (e) {
    console.warn(TAG, 'newSession API failed, trying DOM click:', e.message)
  }

  // 2. Fallback to DOM click (Robustness / Automation logic)
  try {
    const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], span[role="button"], div, span'))
    const newChatBtn = candidates.find(el => {
      const t = (el.innerText || '').trim()
      const aria = (el.getAttribute('aria-label') || '').trim()
      if (!t && !aria) return false
      return (
        t === 'New chat' ||
        t === 'New Chat' ||
        t === '新对话' ||
        t === '新聊天' ||
        t === '新建对话' ||
        /new\s*chat/i.test(aria) ||
        /新(对话|聊天)/.test(aria)
      )
    })
    
    if (newChatBtn) {
      console.log(TAG, 'newSession: clicking "New chat" button')
      newChatBtn.click()
      sendResponse(requestId, { ok: true, data: { status: 'clicked' } })
      return
    }
  } catch (e) {
    console.error(TAG, 'newSession DOM click error:', e.message)
  }

  sendResponse(requestId, { ok: false, error: 'Failed to create new session via API or DOM' })
}

async function handleGetSessionMessages(data, requestId) {
  const sessionId = data?.sessionId
  if (!sessionId) {
    sendResponse(requestId, { ok: false, error: 'sessionId is required' })
    return
  }
  console.log(TAG, 'getSessionMessages: id=' + sessionId)
  try {
    const resp = await fetch('/api/v0/chat/get_messages?chat_session_id=' + sessionId, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const json = await resp.json()
    console.log(TAG, 'getSessionMessages: got messages')
    sendResponse(requestId, { ok: true, data: json })
  } catch (e) {
    console.error(TAG, 'getSessionMessages error:', e.message)
    sendResponse(requestId, { ok: false, error: e.message })
  }
}

// === SSE/fetch interception ===
const OriginalEventSource = window.EventSource
console.log(TAG, 'EventSource exists:', !!OriginalEventSource)

if (OriginalEventSource) {
  function PatchedEventSource(url, options) {
    const es = new OriginalEventSource(url, options)
    if (url.includes('deepseek.com') || url.includes('/chat/') || url.includes('/sse')) {
      const origAddEL = es.addEventListener.bind(es)
      es.addEventListener = function (type, listener, opts) {
        if (type === 'message') {
          const wrapped = function (event) {
            dispatch('sse_data', url, event.data)
            listener.call(es, event)
          }
          origAddEL(type, wrapped, opts)
        } else {
          origAddEL(type, listener, opts)
        }
      }
    }
    return es
  }
  PatchedEventSource.CONNECTING = OriginalEventSource.CONNECTING
  PatchedEventSource.OPEN = OriginalEventSource.OPEN
  PatchedEventSource.CLOSED = OriginalEventSource.CLOSED
  PatchedEventSource.prototype = OriginalEventSource.prototype
  window.EventSource = PatchedEventSource
}

const originalFetch = window.fetch
console.log(TAG, 'fetch patched, original:', typeof originalFetch)

window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  const method = (init?.method || (input?.method) || 'GET').toUpperCase()

  // Log only POST for reduced noise, but intercept ALL posts (backend filters)
  if (method === 'POST') {
    console.log(TAG, `fetch: ${method} ${url.slice(0, 120)}`)

    return originalFetch.call(this, input, init).then(function (response) {
      const ct = response.headers.get('content-type') || ''
      console.log(TAG, 'Response:', response.status, ct, url.slice(0, 80))

      if (response.body) {
        const cloned = response.clone()
        const reader = cloned.body.getReader()
        const decoder = new TextDecoder()
        let chunkCount = 0

        ;(async function readStream() {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                console.log(TAG, 'Stream ended, total chunks:', chunkCount, url.slice(0, 80))
                dispatch('fetch_done', url, '')
                break
              }
              chunkCount++
              const chunk = decoder.decode(value, { stream: true })
              if (chunkCount <= 5 || chunkCount % 10 === 0) {
                console.log(TAG, `Chunk #${chunkCount} (${chunk.length}b):`, chunk.slice(0, 150))
              }
              dispatch('fetch_data', url, chunk)
            }
          } catch (e) {
            console.warn(TAG, 'Stream read error:', e.message)
          }
        })()
      } else {
        console.warn(TAG, 'Response has no body:', url.slice(0, 80))
      }
      return response
    }).catch(function (err) {
      console.warn(TAG, 'fetch error:', err.message)
      throw err
    })
  }

  return originalFetch.call(this, input, init)
}

function dispatch(action, url, data) {
  window.postMessage({
    source: 'openwebai-inject',
    action: action,
    url: url,
    data: data,
    ts: Date.now(),
  }, window.location.origin)
}

// === XHR interception (fallback) ===
const OriginalXHR = window.XMLHttpRequest
function PatchedXHR() {
  const xhr = new OriginalXHR()
  let xhrUrl = ''
  let xhrMethod = ''

  const origOpen = xhr.open.bind(xhr)
  xhr.open = function (method, url, ...rest) {
    xhrUrl = url
    xhrMethod = method.toUpperCase()
    // Only log POST for reduced noise
    if (xhrMethod === 'POST') {
      console.log(TAG, `XHR open: ${xhrMethod} ${String(url).slice(0, 120)}`)
    }
    return origOpen(method, url, ...rest)
  }

  const origSend = xhr.send.bind(xhr)
  xhr.send = function (body) {
    // Intercept ALL POST responses, backend will filter
    if (xhrMethod === 'POST') {
      let lastLen = 0
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState === 3 || xhr.readyState === 4) {
          const full = xhr.responseText || ''
          if (full.length > lastLen) {
            const newChunk = full.slice(lastLen)
            lastLen = full.length
            console.log(TAG, `XHR chunk (state=${xhr.readyState}, newLen=${newChunk.length}):`, newChunk.slice(0, 150))
            dispatch('fetch_data', xhrUrl, newChunk)
          }
        }
        if (xhr.readyState === 4) {
          console.log(TAG, 'XHR done:', xhrUrl, 'total:', lastLen)
          dispatch('fetch_done', xhrUrl, '')
        }
      })
    }
    return origSend(body)
  }
  return xhr
}
PatchedXHR.prototype = OriginalXHR.prototype
window.XMLHttpRequest = PatchedXHR
console.log(TAG, 'XHR patched')

console.log(TAG, '=== All interceptors installed ===')

} // end of double-injection guard
