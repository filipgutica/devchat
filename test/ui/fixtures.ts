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
    page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
    page.on('pageerror', (error) => problems.push(error.message))
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (event) => console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`)))
    await use(page)
    expect(problems.filter((problem) => !expectedErrors.some((pattern) => pattern.test(problem)))).toEqual([])
  },
})

/** Errors a test causes on purpose: a dropped connection and the app's refusals show in the console. */
const expectedErrors = [/Failed to load resource/, /net::ERR_/]

export { expect }

export const agent = { v: 1, by: 'laptop-claude' } as const

/** Opens the UI at a hash route and waits for its first read. */
export async function open(page: Page, host: UiHost, hash = '#/needs-you') {
  await page.goto(`${host.url}${hash}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}
