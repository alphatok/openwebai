/**
 * Debug script: dump DeepSeek page structure AFTER a chat message.
 * Run while openwebai is running and a conversation exists:
 *   npx tsx scripts/debug-selectors.ts
 */
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222')
  const contexts = browser.contexts()

  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url()
      if (!url.includes('deepseek') || url === 'about:blank') continue

      console.log(`[debug] URL: ${url}`)
      console.log(`[debug] Title: ${await page.title()}\n`)

      // ============== 1. ALL large text blocks (likely responses) ==============
      console.log('=== LARGE TEXT BLOCKS (>20 chars) ===')
      const bigTexts = await page.evaluate(() => {
        const all = document.querySelectorAll('div, section, article, p, span')
        const results: { tag: string; class: string; text: string }[] = []
        for (const el of all) {
          const text = (el as HTMLElement).textContent?.trim() ?? ''
          if (text.length > 20) {
            results.push({
              tag: el.tagName,
              class: el.className.slice(0, 150),
              text: text.slice(0, 200),
            })
          }
        }
        return results
      })
      console.log(JSON.stringify(bigTexts, null, 2))
      console.log('')

      // ============== 2. ALL markdown-like containers ==============
      console.log('=== MARKDOWN-LIKE CLASSES ===')
      const mdEls = await page.evaluate(() => {
        const all = document.querySelectorAll('[class*="markdown" i], [class*="message" i], [class*="response" i], [class*="reply" i], [class*="chat" i], [class*="conversation" i], [class*="output" i]')
        return Array.from(all).slice(0, 30).map((el, i) => ({
          index: i,
          tag: el.tagName,
          class: el.className.slice(0, 200),
          text: (el as HTMLElement).textContent?.trim().slice(0, 120) ?? '',
        }))
      })
      console.log(JSON.stringify(mdEls, null, 2))
      console.log('')

      // ============== 3. Find text that contains the actual response ==============
      // Look for text that doesn't look like UI (buttons, labels, etc.)
      console.log('=== RESPONSE CANDIDATES (text > 40 chars, not button/label text) ===')
      const responseTexts = await page.evaluate(() => {
        const results: { tag: string; class: string; id: string; text: string; parentClass: string }[] = []
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
        let node: Text | null
        while ((node = walker.nextNode() as Text | null)) {
          const text = node.textContent?.trim() ?? ''
          if (text.length > 40) {
            const parent = node.parentElement
            if (parent && !['SCRIPT', 'STYLE', 'BUTTON'].includes(parent.tagName)) {
              results.push({
                tag: parent.tagName,
                class: parent.className.slice(0, 200),
                id: parent.id,
                text: text.slice(0, 300),
                parentClass: parent.parentElement?.className?.slice(0, 100) ?? '',
              })
            }
          }
        }
        return results
      })
      console.log(JSON.stringify(responseTexts, null, 2))
      console.log('')

      // ============== 4. div.ds-markdown or similar ==============
      console.log('=== DS-MARKDOWN ELEMENTS ===')
      const ds = await page.evaluate(() => {
        const all = document.querySelectorAll('[class*="ds-"], [class*="markdown"]')
        return Array.from(all).slice(0, 20).map((el, i) => ({
          index: i,
          tag: el.tagName,
          class: el.className.slice(0, 200),
          text: (el as HTMLElement).textContent?.trim().slice(0, 100) ?? '',
        }))
      })
      console.log(JSON.stringify(ds, null, 2))
      console.log('')

      // ============== 5. All elements that contain "-9" (the bogus response) ==============
      console.log('=== ELEMENTS CONTAINING "-9" ===')
      const minusNine = await page.evaluate(() => {
        const all = document.querySelectorAll('*')
        const results: { tag: string; class: string; text: string }[] = []
        for (const el of all) {
          if ((el as HTMLElement).textContent?.trim() === '-9' && el.children.length === 0) {
            results.push({
              tag: el.tagName,
              class: el.className.slice(0, 150),
              text: (el as HTMLElement).textContent?.trim() ?? '',
            })
          }
        }
        return results
      })
      console.log(JSON.stringify(minusNine, null, 2))
    }
  }

  await browser.close()
}

main().catch(err => {
  console.error('[debug] Error:', err)
  process.exit(1)
})