/**
 * i18n translations for the setup guide page.
 */
const translations = {
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
    api_messages: 'Messages API (Anthropic-compatible). Supports stream:true for SSE.',
    testing: 'Testing...',
    sending: 'Sending test request...',
    success: 'Success! Reply: ',
    error: 'Error: ',
    unexpected: 'Unexpected response: ',
    failed: 'Request failed: ',
    step2_debug: '🔍 Debug Panel',
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
    api_messages: '\u6d88\u606f API\uff08Anthropic \u517c\u5bb9\uff09\u3002\u652f\u6301 stream:true \u6d41\u5f0f\u54cd\u5e94\u3002',
    testing: '\u6d4b\u8bd5\u4e2d...',
    sending: '\u6b63\u5728\u53d1\u9001\u6d4b\u8bd5\u8bf7\u6c42...',
    success: '\u6210\u529f\uff01\u56de\u590d\uff1a',
    error: '\u9519\u8bef\uff1a',
    unexpected: '\u672a\u77e5\u54cd\u5e94\uff1a',
    failed: '\u8bf7\u6c42\u5931\u8d25\uff1a',
    step2_debug: '🔍 调试面板',
  },
}

/**
 * Language controller - handles i18n switching and auto-detection.
 */
const LangController = {
  current: 'en',

  /** Apply translations to all [data-i18n] elements */
  apply(lang) {
    const t = translations[lang]
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n')
      if (key && t[key] !== undefined) {
        el.innerHTML = t[key]
      }
    })
  },

  /** Switch language, persist, and update UI */
  set(lang) {
    this.current = lang
    localStorage.setItem('openwebai-lang', lang)
    document.getElementById('btnEn').className = lang === 'en' ? 'active' : ''
    document.getElementById('btnZh').className = lang === 'zh' ? 'active' : ''
    document.documentElement.lang = lang
    this.apply(lang)
  },

  /** Default to Chinese, but load saved preference if any */
  autoDetect() {
    const saved = localStorage.getItem('openwebai-lang')
    if (saved === 'en' || saved === 'zh') {
      this.set(saved)
    } else {
      this.set('zh')
    }
  },

  /** Get current translations */
  t() {
    return translations[this.current]
  },
}

/**
 * Connection test module - sends test request and displays result.
 */
const ConnectionTest = {
  async run() {
    const btn = document.getElementById('testBtn')
    const result = document.getElementById('testResult')
    const tr = LangController.t()

    btn.disabled = true
    btn.textContent = tr.testing
    result.className = 'test-result'
    result.textContent = tr.sending

    try {
      const resp = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test123456' },
        body: JSON.stringify({
          model: 'deepseek',
          messages: [{ role: 'user', content: 'Say hi in one word.' }],
        }),
      })
      const data = await resp.json()

      if (data.choices && data.choices[0]) {
        result.className = 'test-result ok'
        result.textContent = tr.success + '"' + data.choices[0].message.content + '"'
      } else if (data.error) {
        result.className = 'test-result err'
        result.textContent = tr.error + (data.error.message || data.error)
      } else {
        result.className = 'test-result err'
        result.textContent = tr.unexpected + JSON.stringify(data).slice(0, 200)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.className = 'test-result err'
      result.textContent = tr.failed + msg
    }

    btn.disabled = false
    btn.textContent = tr.step2_btn
  },
}

// Expose to inline onclick handlers
window.setLang = (lang) => LangController.set(lang)
window.runTest = () => ConnectionTest.run()

// Init
LangController.autoDetect()
