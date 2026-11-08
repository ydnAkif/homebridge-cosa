import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../dist/api/index.js'
import { login } from '../dist/api/auth.js'
const response = (config, data) => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: {},
  config
})
test('HTTP 200/code104 renews one shared session, retries a write and stops on persistent rejection', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 })
  const adapter = api.defaults.adapter
  let logins = 0,
    writes = 0,
    alwaysExpired = false
  try {
    api.defaults.adapter = async (config) => {
      if (config.url === '/users/login') {
        logins++
        return response(config, { authToken: 'fixture-' + logins })
      }
      if (alwaysExpired || config.headers.get('authToken') !== 'fixture-2')
        return response(config, { ok: false, code: 104 })
      if (config.url === '/fixture-write') writes++
      return response(config, { ok: true })
    }
    assert.equal(await login({ email: 'fixture', password: 'fixture' }), true)
    await Promise.all([
      api.post('/fixture-write', {}),
      api.get('/fixture-read')
    ])
    assert.equal(logins, 2)
    assert.equal(writes, 1)
    t.mock.timers.tick(60001)
    alwaysExpired = true
    await assert.rejects(api.get('/persistent'))
    assert.equal(logins, 3)
  } finally {
    api.defaults.adapter = adapter
  }
})
test('HTTP 200 with explicit application failure is rejected rather than acknowledged as a successful write', async () => {
  const adapter = api.defaults.adapter
  try {
    api.defaults.adapter = async (config) =>
      response(config, { ok: false, code: 999 })
    await assert.rejects(api.post('/bad-write', {}), /rejected/)
  } finally {
    api.defaults.adapter = adapter
  }
})
