import AxeBuilder from '@axe-core/playwright'
import { expect, open, test } from './fixtures.ts'

const screens = [
  { name: 'Needs you', hash: '#/needs-you', ready: 'You answered' },
  { name: 'a channel', hash: '#/repo/example/devchat?tab=work', ready: 'devchat: build the web UI' },
  { name: 'the thread pane', hash: '#/repo/example/devchat?tab=work&thread=seed-work-1', ready: 'Should the composer keep a draft' },
]

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Axe finds no WCAG 2.2 A or AA violation, and nothing scrolls sideways, in ${colorScheme}`, async ({ page, host }) => {
    await host.seed()
    await page.emulateMedia({ colorScheme })
    for (const screen of screens) {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 })
        await open(page, host, screen.hash)
        await expect(page.getByText(screen.ready).first()).toBeVisible()
        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']).analyze()
        expect(violations.map(({ id, nodes }) => `${screen.name} at ${width}px: ${id} ${nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${screen.name} at ${width}px`).toBe(true)
      }
    }
  })
}

test('The keyboard reaches every control in order, each with a visible focus ring', async ({ page, host }) => {
  await host.seed()
  await open(page, host, '#/repo/example/devchat?tab=work&thread=seed-work-1')
  await expect(page.getByText('Should the composer keep a draft').first()).toBeVisible()
  await page.locator('body').focus()
  const reached: string[] = []
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (!element || element === document.body) return null
      const style = getComputedStyle(element)
      // Fields show focus by their accent edge and inset line (components.md); the composer draws it on
      // its box. Light fields have no shadow at rest, so a shadow there is the focus line.
      const field = element.matches('input, textarea') ? element.closest('.composer-box') ?? element : null
      const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
      const edge = field ? getComputedStyle(field).boxShadow.includes('inset') : false
      const label = 'labels' in element && element.labels instanceof NodeList ? element.labels[0] : element.closest('label')
      const name = element.getAttribute('aria-label') ?? label?.textContent?.trim() ?? element.textContent?.trim() ?? ''
      return { name: `${element.getAttribute('role') ?? element.tagName.toLowerCase()}:${name}`, visible: ring || edge }
    })
    if (!focused) continue
    expect(focused.visible, `${focused.name} shows focus`).toBe(true)
    reached.push(focused.name)
  }
  for (const control of ['a:Skip to content', 'input:Search todos and work', 'a:Needs you2', 'a:#global', 'a:#devchat', 'tab:Work', 'switch:Show resolved',
    'textarea:New work item in #devchat', 'button:Send', 'separator:Resize thread panel', 'button:Resolve', 'button:Close thread', 'textarea:Answer desktop-claude']) {
    expect(reached.some((name) => name.startsWith(control)), `${control} in ${reached.join(' | ')}`).toBe(true)
  }
})
