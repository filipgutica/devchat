import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { z } from 'zod'
import { guardReason } from '../src/server/guard.ts'

const fixture = z.array(z.object({ name: z.string(), text: z.string(), general: z.boolean() }).passthrough())
  .parse(JSON.parse(await readFile(new URL('../fixtures/guard.json', import.meta.url), 'utf8')))

test('the server guard matches fixtures/guard.json (general), the contract it shares with the plugin guard', () => {
  assert.ok(fixture.length > 0)
  for (const { name, text, general } of fixture) {
    assert.equal(guardReason(text) === null, general, `${name}: ${guardReason(text) ?? 'passes'}`)
  }
})
