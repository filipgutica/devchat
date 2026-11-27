import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, open, test } from './fixtures.ts'

// Screenshots for visual review: set DEVCHAT_SHOTS to the folder to write them to.
const folder = process.env.DEVCHAT_SHOTS
test.skip(!folder, 'set DEVCHAT_SHOTS to take screenshots')

const screens = [
  { name: 'needs-you', hash: '#/needs-you', ready: 'You answered' },
  { name: 'channel', hash: '#/repo/example/devchat?tab=work', ready: 'devchat: build the web UI' },
  { name: 'thread', hash: '#/repo/example/devchat?tab=work&thread=seed-work-1', ready: 'Should the composer keep a draft' },
]

test('Needs you, a channel, and the thread pane at phone and desktop width, light and dark', async ({ page, host }) => {
  await host.seed()
  await mkdir(folder!, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [width, height, label] of [[390, 844, 'phone'], [1280, 800, 'desktop']] as const) {
      await page.setViewportSize({ width, height })
      for (const screen of screens) {
        await open(page, host, screen.hash)
        await expect(page.getByText(screen.ready).first()).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        // Park the pointer on the page's edge, so no row shows its hover fill.
        await page.mouse.move(width - 1, height - 1)
        await page.screenshot({ path: join(folder!, `${screen.name}-${label}-${colorScheme}.png`), fullPage: label === 'phone' })
      }
    }
  }
})
