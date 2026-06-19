/**
 * Debug script: dump DeepSeek page selectors via CDP.
 * First, make sure openwebai is running, then:
 *   npx tsx scripts/debug-selectors.ts
 */
import { chromium } from 'playwright'

async function main() {
  // Connect via CDP to the already-running Chrome
  console.log('[debug] Connecting to running Chrome via CDP...')

  const browser = await chromium.connectOverCDP('http://localhost:9222')
  const contexts = browser.contexts()
  console.log(`[debug] Found ${contexts.length} context(s)`)

  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url()
      console.log(`[debug] Page: ${url}`)

      if (!url.includes('deepseek')) {
        continue
      }

      console.log(`[debug] === Analyzing DeepSeek page ===`)
      console.log(`[debug] Title: ${await page.title()}`)
      console.log('')

      // Dump all textareas
      console.log('=== TEXTAREAS ===')
      const textareas = await page.$$eval('textarea', els =>
        els.map((el, i) => ({
          index: i,
          placeholder: el.getAttribute('placeholder'),
          dataTestId: el.getAttribute('data-testid'),
          id: el.id,
          className: el.className.slice(0, 120),
          ariaLabel: el.getAttribute('aria-label'),
        }))
      )
      console.log(JSON.stringify(textareas, null, 2))
      console.log('')

      // Dump contenteditable
      console.log('=== CONTENTEDITABLE ===')
      const editables = await page.$$eval('[contenteditable="true"]', els =>
        els.map((el, i) => ({
          index: i,
          tagName: el.tagName,
          className: el.className.slice(0, 120),
          id: el.id,
          ariaLabel: el.getAttribute('aria-label'),
          dataTestId: el.getAttribute('data-testid'),
        }))
      )
      console.log(JSON.stringify(editables, null, 2))
      console.log('')

      // Dump all buttons
      console.log('=== BUTTONS (first 30) ===')
      const buttons = await page.$$eval('button', els =>
        els.slice(0, 30).map((el, i) => ({
          index: i,
          text: el.textContent?.trim().slice(0, 40),
          className: el.className.slice(0, 100),
          ariaLabel: el.getAttribute('aria-label'),
          dataTestId: el.getAttribute('data-testid'),
          svg: el.querySelector('svg') ? true : false,
        }))
      )
      console.log(JSON.stringify(buttons, null, 2))
      console.log('')

      // Dump input-like elements
      console.log('=== INPUT-LIKE (input, [role="textbox"]) ===')
      const inputs = await page.$$eval('input, [role="textbox"]', els =>
        els.map((el, i) => ({
          index: i,
          tagName: el.tagName,
          type: el.getAttribute('type'),
          placeholder: el.getAttribute('placeholder'),
          className: el.className.slice(0, 100),
          ariaLabel: el.getAttribute('aria-label'),
          dataTestId: el.getAttribute('data-testid'),
          contentEditable: el.getAttribute('contenteditable'),
        }))
      )
      console.log(JSON.stringify(inputs, null, 2))
      console.log('')

      // Dump send-related
      console.log('=== SEND/SUBMIT ELEMENTS ===')
      const sendEls = await page.$$eval('[class*="send" i], [class*="submit" i], [aria-label*="send" i], [aria-label*="发送"], [data-testid*="send" i]', els =>
        els.map((el, i) => ({
          index: i,
          tagName: el.tagName,
          text: el.textContent?.trim().slice(0, 40),
          className: el.className.slice(0, 120),
          ariaLabel: el.getAttribute('aria-label'),
          dataTestId: el.getAttribute('data-testid'),
        }))
      )
      console.log(JSON.stringify(sendEls, null, 2))
      console.log('')

      // Dump markdown/output
      console.log('=== MARKDOWN/OUTPUT CONTAINERS (first 10) ===')
      const outputs = await page.$$eval('.markdown-body, [class*="markdown"], [class*="message-content"], [class*="assistant"]', els =>
        els.slice(0, 10).map((el, i) => ({
          index: i,
          tagName: el.tagName,
          className: el.className.slice(0, 120),
          text: el.textContent?.slice(0, 60),
        }))
      )
      console.log(JSON.stringify(outputs, null, 2))
    }
  }

  await browser.close()
}

main().catch(err => {
  console.error('[debug] Error:', err)
  process.exit(1)
})
