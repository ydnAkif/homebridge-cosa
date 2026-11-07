import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHomesWithRetry } from '../dist/startup.js'

test('failed logins are retried and never return an empty accessory list', async () => {
  let attempts = 0,
    retries = 0
  const homes = [{ id: 'fixture', name: 'Thermostat' }]
  const result = await loadHomesWithRetry({
    login: async () => ++attempts >= 3,
    getHomes: async () => homes,
    stopped: () => false,
    retry: () => retries++,
    wait: async () => {}
  })
  assert.equal(result, homes)
  assert.equal(attempts, 3)
  assert.equal(retries, 2)
})
test('temporary empty home lists and transport failures cannot publish an empty bridge', async () => {
  let attempts = 0
  const homes = [{ id: 'fixture' }]
  const result = await loadHomesWithRetry({
    login: async () => true,
    getHomes: async () => {
      attempts++
      if (attempts === 1) throw Error('network')
      return attempts === 2 ? [] : homes
    },
    stopped: () => false,
    retry: () => {},
    wait: async () => {}
  })
  assert.equal(result, homes)
  assert.equal(attempts, 3)
})
test('shutdown while waiting exits without registering empty accessories', async () => {
  let stopped = false
  const result = await loadHomesWithRetry({
    login: async () => false,
    getHomes: async () => {
      throw Error('not reached')
    },
    stopped: () => stopped,
    retry: () => {},
    wait: async () => {
      stopped = true
    }
  })
  assert.equal(result, undefined)
})
