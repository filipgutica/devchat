import { test as base, expect, type Page } from '@playwright/test'
import { startUiHost, type UiHost } from '../../scripts/ui-host.ts'

type Fixtures = {
  /** A fresh local host with an empty board. */
  host: UiHost
  /** Options for the host, set per file or test with `test.use`. */
  hostOptions: Parameters<typeof startUiHost>[0]
}

export const test = base.extend<Fixtures>({
  hostOptions: [{}, { option: true }],
  host: async ({ hostOptions }, use) => {
    const host = await startUiHost(hostOptions)
    await use(host)
    await host.stop()
  },
  // Every test fails on a console error or a blocked resource, such as a Content-Security-Policy violation.
  page: async ({ page }, use) => {
    const problems: string[] = []
    page.on('console', (message) => {
      // A refused or dropped write, and a read while the host is down, log a failed request under
      // /api/ui/; a test causes those on purpose. Any other failed load, such as a missing asset, fails.
      const expected = message.location().url.includes('/api/ui/') && /Failed to load resource/.test(message.text())
      if (message.type() === 'error' && !expected) problems.push(`${message.text()} ${message.location().url}`)
    })
    page.on('pageerror', (error) => problems.push(error.message))
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (event) => console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`)))
    await use(page)
    expect(problems).toEqual([])
  },
})

export { expect }

export const agent = { v: 1, by: 'laptop-claude' } as const

/** Opens the UI at a hash route and waits for its first read. */
export async function open(page: Page, host: UiHost, hash = '#/needs-you') {
  await page.goto(`${host.url}${hash}`)
  // On a phone an open thread replaces the view, so its heading stands in for the view's.
  await expect(page.getByRole('heading', { level: 1 }).or(page.getByRole('heading', { name: /^Thread/ })).filter({ visible: true }).first()).toBeVisible()
}
