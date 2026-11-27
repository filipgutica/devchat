import type { MessageView } from '@vercel/board'
import type { Page } from '@playwright/test'
import type { UiHost } from '../../scripts/ui-host.ts'
import { agent, expect, open, test } from './fixtures.ts'

/** The message rows of a list, by its accessible name. */
const rows = (page: Page, list: string) => page.getByRole('list', { name: list, exact: true }).locator('li.msg')
const composer = (page: Page, label: string) => page.getByRole('textbox', { name: label, exact: true })

/** Every live post the app wrote in a board channel. */
async function posts(host: UiHost, channel: 'todos' | 'work') {
  const all: MessageView[] = []
  for (let page = await host.owner.channel(channel).messages({ after: '0' }); page.messages.length > 0;
    page = await host.owner.channel(channel).messages({ after: page.cursor })) all.push(...page.messages)
  return all.filter((message) => !message.deleted)
}
const rootLabels = async (host: UiHost, rid: string) => (await host.owner.posted(`app:${rid}`)).labels

test('Needs you lists open and blocked questions first, then the threads the user answered', async ({ page, host }) => {
  await host.submit({ ...agent, rid: 'work-a', kind: 'work', channel: 'work', text: 'Ship the exporter.', repo: 'example/one' })
  await host.submit({ ...agent, rid: 'ask-a', root: 'work-a', kind: 'ask', text: 'Which port should it use?' })
  await host.submit({ ...agent, rid: 'work-b', kind: 'work', channel: 'work', text: 'Rotate the keys.' })
  await host.submit({ ...agent, rid: 'ask-b', root: 'work-b', kind: 'ask', block: 1, text: 'May I restart the service?' })
  await host.submit({ ...agent, rid: 'work-c', kind: 'work', channel: 'work', text: 'Fix the docs build.', repo: 'example/two' })
  await host.submit({ ...agent, rid: 'ask-c', root: 'work-c', kind: 'ask', text: 'Keep the old URL?' })
  await host.submit({ ...agent, rid: 'todo-d', kind: 'todo', channel: 'todos', text: 'A plain todo waits for no one.' })
  await host.pass()
  await open(page, host)
  // Answer C in its thread, so it moves to the second list.
  await page.getByRole('link', { name: 'Fix the docs build.' }).click()
  await composer(page, 'Answer laptop-claude').fill('Yes, keep it.')
  await composer(page, 'Answer laptop-claude').press('Enter')
  await expect(page.getByText('Waiting for the agent. Replies are saved to the board.')).toBeVisible()

  await expect(rows(page, 'Needs you')).toHaveCount(2)
  await expect(rows(page, 'Needs you').nth(0)).toContainText('Which port should it use?')
  await expect(rows(page, 'Needs you').nth(0)).toContainText('Asks you')
  await expect(rows(page, 'Needs you').nth(1)).toContainText('May I restart the service?')
  await expect(rows(page, 'Needs you').nth(1)).toContainText('Blocked on you')
  await expect(rows(page, 'You answered')).toHaveCount(1)
  await expect(rows(page, 'You answered').first()).toContainText('Yes, keep it.')
  await expect(rows(page, 'You answered').first()).toContainText('Waiting for the agent')
  // The answered list follows the open one, and a plain todo is in neither.
  const order = await page.locator('main ol.stream').evaluateAll((lists) => lists.map((list) => list.getAttribute('aria-label')))
  expect(order).toEqual(['Needs you', 'You answered'])
  await expect(page.getByText('A plain todo waits for no one.')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Needs you 2' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/\bseen\b/i)
})

test('A channel lists its own todos and work items, by tab; #global holds those with no repo', async ({ page, host }) => {
  await host.submit({ ...agent, rid: 'todo-g', kind: 'todo', channel: 'todos', text: 'Global todo.' })
  await host.submit({ ...agent, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Project todo.', repo: 'example/one' })
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Project work.', repo: 'example/one' })
  await host.submit({ ...agent, rid: 'work-g', kind: 'work', channel: 'work', text: 'Global work.' })
  await host.pass()
  await open(page, host, '#/global')

  const channels = page.getByRole('navigation', { name: 'Channels' })
  await expect(channels.getByRole('link')).toHaveText(['#global', '#one'])
  await expect(channels.getByRole('link', { name: '#global' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('tab')).toHaveText(['Todos', 'Work'])
  await expect(rows(page, 'Open todos in #global')).toHaveCount(1)
  await expect(rows(page, 'Open todos in #global')).toContainText('Global todo.')
  await page.getByRole('tab', { name: 'Work' }).click()
  await expect(rows(page, 'Open work items in #global')).toHaveText([/Global work\./])

  await channels.getByRole('link', { name: '#one' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('#one')
  await expect(rows(page, 'Open work items in #one')).toHaveText([/Project work\./])
  await page.getByRole('tab', { name: 'Todos' }).click()
  await expect(rows(page, 'Open todos in #one')).toHaveText([/Project todo\./])
})

test('The composer adds a todo or a work item to the channel in view, saved by the user', async ({ page, host }) => {
  await host.submit({ ...agent, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Makes the channel.', repo: 'example/one' })
  await host.pass()
  await open(page, host, '#/repo/example/one')

  await composer(page, 'New todo in #one').fill('Check the release notes.')
  await composer(page, 'New todo in #one').press('Enter')
  await expect(rows(page, 'Open todos in #one').filter({ hasText: 'Check the release notes.' })).toHaveCount(1)
  await expect(composer(page, 'New todo in #one')).toHaveValue('')
  await expect(composer(page, 'New todo in #one')).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'Saved to the board' })).toBeAttached()

  await page.getByRole('tab', { name: 'Work' }).click()
  await composer(page, 'New work item in #one').fill('Cut release 0.2.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(rows(page, 'Open work items in #one').filter({ hasText: 'Cut release 0.2.' })).toHaveCount(1)

  await page.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: '#global' }).click()
  await composer(page, 'New work item in #global').fill('Global item.')
  await composer(page, 'New work item in #global').press('Enter')
  await expect(rows(page, 'Open work items in #global')).toHaveCount(1)

  const todo = (await posts(host, 'todos')).find((post) => post.text === 'Check the release notes.')
  expect(todo?.labels).toMatchObject({ by: 'user', repo: 'example/one', status: 'open' })
  expect(todo?.labels.rid).toMatch(/^ui-[0-9a-f-]{36}$/)
  const work = await posts(host, 'work')
  expect(work.find((post) => post.text === 'Cut release 0.2.')?.labels).toMatchObject({ by: 'user', repo: 'example/one' })
  expect(work.find((post) => post.text === 'Global item.')?.labels.repo).toBeUndefined()
})

test('An answer goes under the work item with re set to the question the pane showed', async ({ page, host }) => {
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Ship the exporter.', repo: 'example/one' })
  // Another agent asks: the composer answers the agent whose question waits, not the root's author.
  await host.submit({ ...agent, by: 'desktop-codex', rid: 'ask-1', root: 'work-1', kind: 'ask', text: 'Which port?' })
  await host.pass()
  await open(page, host)
  await page.getByRole('link', { name: 'Ship the exporter.' }).click()

  const pane = page.getByRole('complementary', { name: /Thread/ })
  await expect(pane.getByRole('heading', { name: /Thread/ })).toBeFocused()
  await expect(pane.locator('.pane-head .badge.info')).toHaveText('Needs you')
  await expect(rows(page, 'Replies').first()).toContainText('Asks you')
  await composer(page, 'Answer desktop-codex').fill('Use 8443.')
  await composer(page, 'Answer desktop-codex').press('Enter')
  await expect(rows(page, 'Replies')).toHaveCount(2)
  await expect(pane.locator('.pane-head .badge')).toHaveCount(0)
  await expect(pane.getByText('Waiting for the agent. Replies are saved to the board.')).toBeVisible()

  const answer = (await posts(host, 'work')).find((post) => post.text === 'Use 8443.')
  expect(answer?.labels).toMatchObject({ by: 'user', kind: 'answer', re: 'ask-1' })
  expect(await rootLabels(host, 'work-1')).toMatchObject({ ask: 'answered', turn: answer?.labels.rid })
})

test('Resolve hides a thread from the default view; Show resolved lists it with who and when; a reply reopens it', async ({ page, host }) => {
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Ship the exporter.', repo: 'example/one' })
  await host.pass()
  await open(page, host, '#/repo/example/one?tab=work')
  await rows(page, 'Open work items in #one').getByRole('link', { name: 'Open thread' }).click()
  const pane = page.getByRole('complementary', { name: /Thread/ })
  await expect(rows(page, 'Open work items in #one').first()).toHaveAttribute('aria-current', 'true')

  await pane.getByRole('button', { name: 'Resolve' }).click()
  await expect(pane.locator('.pane-head .badge.success')).toHaveText('Done')
  await expect(pane.getByRole('button', { name: 'Resolve' })).toHaveCount(0)
  await expect(pane.getByRole('heading', { name: /Thread/ })).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'Thread resolved' })).toBeAttached()
  await expect(rows(page, 'Replies').first()).toContainText('Resolved the thread')
  await expect(page.getByText('No open work items in #one.')).toBeVisible()
  expect((await rootLabels(host, 'work-1')).status).toBe('done')

  await page.getByRole('switch', { name: 'Show resolved' }).click()
  const resolved = rows(page, 'Resolved work items in #one')
  await expect(resolved).toHaveCount(1)
  await expect(resolved.first()).toContainText('Resolved by You')
  await expect(resolved.first().locator('.msg-links time')).toHaveText(/^Today \d/)

  await composer(page, 'Reply to laptop-claude').fill('Reopening: the exporter drops a column.')
  await composer(page, 'Reply to laptop-claude').press('Enter')
  await expect(pane.getByRole('button', { name: 'Resolve' })).toBeVisible()
  await expect(page.getByText('No resolved work items in #one.')).toBeVisible()
  await page.getByRole('switch', { name: 'Show resolved' }).click()
  await expect(rows(page, 'Open work items in #one')).toHaveCount(1)
  expect((await rootLabels(host, 'work-1')).status).toBe('open')
})

test('Search finds a resolved thread', async ({ page, host }) => {
  await host.submit({ ...agent, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Feed the parrot.' })
  await host.submit({ ...agent, rid: 'done-1', root: 'todo-1', kind: 'done', text: '' })
  await host.submit({ ...agent, rid: 'todo-2', kind: 'todo', channel: 'todos', text: 'Walk the dog.' })
  await host.pass()
  await open(page, host, '#/global')
  await expect(page.getByText('Feed the parrot.')).toHaveCount(0)

  await page.getByRole('searchbox', { name: 'Search todos and work' }).fill('parrot')
  await page.getByRole('searchbox', { name: 'Search todos and work' }).press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search')
  await expect(page.getByText('1 thread matches “parrot”.')).toBeVisible()
  await expect(rows(page, 'Results for parrot')).toHaveCount(1)
  await expect(rows(page, 'Results for parrot').first()).toContainText('Feed the parrot.')
  await expect(rows(page, 'Results for parrot').first()).toContainText('Resolved by laptop-claude')
})

test('A retry after a dropped answer resends the same rid and body, and the board gets one post', async ({ page, host }) => {
  await open(page, host, '#/global')
  host.dropNextWriteResponse()
  await composer(page, 'New todo in #global').fill('Back up the photos.')
  await composer(page, 'New todo in #global').press('Enter')
  await expect(page.getByText("Not sent: devchat can't be reached. Your text is kept; retry when it's back.")).toBeVisible()
  await expect(composer(page, 'New todo in #global')).toHaveValue('Back up the photos.')
  await expect(composer(page, 'New todo in #global')).toHaveAttribute('aria-invalid', 'true')

  // Retry resends what was sent; a note typed meanwhile stays in the field.
  await composer(page, 'New todo in #global').fill('Back up the photos, and the videos.')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(rows(page, 'Open todos in #global')).toHaveCount(1)
  await expect(composer(page, 'New todo in #global')).toHaveValue('Back up the photos, and the videos.')
  expect((await posts(host, 'todos')).filter((post) => post.text === 'Back up the photos.')).toHaveLength(1)
  expect(host.writes).toHaveLength(2)
  expect(host.writes[1]).toBe(host.writes[0])
})

test('A changed text sent under a rid that already landed answers 409; the next send takes a new rid', async ({ page, host }) => {
  await open(page, host, '#/global')
  host.dropNextWriteResponse()
  await composer(page, 'New todo in #global').fill('First text.')
  await composer(page, 'New todo in #global').press('Enter')
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()

  await composer(page, 'New todo in #global').fill('Second text.')
  await composer(page, 'New todo in #global').press('Enter')
  await expect(page.getByText('Not saved: an earlier send of this message may already be on the board. Check the thread, then send again.')).toBeVisible()
  await expect(composer(page, 'New todo in #global')).toHaveValue('Second text.')
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)

  await composer(page, 'New todo in #global').press('Enter')
  await expect(rows(page, 'Open todos in #global')).toHaveCount(2)
  const rids = host.writes.map((body) => (JSON.parse(body) as { rid: string }).rid)
  expect(rids).toHaveLength(3)
  expect(rids[1]).toBe(rids[0])
  expect(rids[2]).not.toBe(rids[0])
  expect((await posts(host, 'todos')).map((post) => post.text).sort()).toEqual(['First text.', 'Second text.'])
})

test('Guarded text is refused with the guard\'s reason and never echoed, and nothing is saved', async ({ page, host }) => {
  await open(page, host, '#/global')
  await composer(page, 'New todo in #global').fill('Set api_key=hunter2secret on the box.')
  await composer(page, 'New todo in #global').press('Enter')
  const error = page.locator('.field-error')
  await expect(error).toHaveText('Not saved: the text guard refused this text (credential assignment). Remove that part and send again.')
  await expect(composer(page, 'New todo in #global')).toHaveValue('Set api_key=hunter2secret on the box.')
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  expect(await posts(host, 'todos')).toEqual([])
})

test.describe('without a guard', () => {
  test.use({ hostOptions: { guard: false } })
  test('every write is refused with 503 and the text is kept', async ({ page, host }) => {
    await open(page, host, '#/global')
    await composer(page, 'New todo in #global').fill('Check the logs.')
    await composer(page, 'New todo in #global').press('Enter')
    await expect(page.locator('.field-error')).toHaveText("Not saved: devchat's text guard isn't loaded, so it refuses every write until the host is fixed.")
    await expect(composer(page, 'New todo in #global')).toHaveValue('Check the logs.')
    expect(await posts(host, 'todos')).toEqual([])
  })
})

test('The page polls every 15 s; offline it says so, keeps what it shows, and disables sending', async ({ page, host }) => {
  await host.submit({ ...agent, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Already here.' })
  await host.pass()
  await page.clock.install()
  await open(page, host, '#/global')
  await expect(rows(page, 'Open todos in #global')).toHaveCount(1)

  await host.submit({ ...agent, rid: 'todo-2', kind: 'todo', channel: 'todos', text: 'Arrived later.' })
  await host.pass()
  await page.clock.runFor(14_000)
  await expect(rows(page, 'Open todos in #global')).toHaveCount(1)
  await page.clock.runFor(1_000)
  await expect(rows(page, 'Open todos in #global')).toHaveCount(2)

  await composer(page, 'New todo in #global').fill('Draft while offline.')
  host.setReachable(false)
  await page.clock.runFor(15_000)
  await expect(page.getByRole('status').filter({ hasText: "Offline: devchat can't be reached." })).toBeVisible()
  await expect(rows(page, 'Open todos in #global')).toHaveCount(2)
  await expect(composer(page, 'New todo in #global')).toBeDisabled()
  await expect(composer(page, 'New todo in #global')).toHaveValue('Draft while offline.')
  await expect(page.getByText("Offline: devchat can't be reached. Sending comes back when it can.")).toBeVisible()

  host.setReachable(true)
  await page.clock.runFor(15_000)
  await expect(page.getByText("Offline: devchat can't be reached.", { exact: false })).toHaveCount(0)
  await expect(composer(page, 'New todo in #global')).toBeEnabled()
})
