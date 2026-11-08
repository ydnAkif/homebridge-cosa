import test from 'node:test'
import assert from 'node:assert/strict'
import { api, setApiLogger } from '../dist/api/index.js'
import { getHome } from '../dist/api/home.js'
const home = {
  combiState: 'off',
  temperature: 21.8,
  targetTemperature: 21.5,
  humidity: 58
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
for (const scenario of ['application', 'schema', 'persistent']) {
  test(`getEndpoint ${scenario} response gets one bounded read retry and preserves real failures`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let calls = 0
    const original = api.defaults.adapter,
      logs = []
    setApiLogger((level, message) => logs.push({ level, message }))
    try {
      api.defaults.adapter = async (config) => {
        calls++
        const fail = calls === 1 || scenario === 'persistent'
        const data = fail
          ? scenario === 'schema'
            ? { ok: 1, endpoint: {} }
            : { ok: 0, code: 123 }
          : { ok: 1, endpoint: home }
        return { data, status: 200, statusText: 'OK', headers: {}, config }
      }
      const result = getHome({ homeId: 'read-recovery-' + scenario })
      await flush()
      assert.equal(calls, 1)
      t.mock.timers.tick(1000)
      await flush()
      const value = await result
      assert.equal(calls, 2)
      if (scenario === 'persistent') {
        assert.equal(value, null)
        assert.ok(
          logs.some(
            (l) => l.level === 'error' && l.message.includes('code 123')
          )
        )
      } else {
        assert.equal(value.temperature, 21.8)
        assert.ok(!logs.some((l) => l.level === 'error'))
      }
    } finally {
      api.defaults.adapter = original
    }
  })
}
test('application rejection diagnostic contains only a numeric code, never arbitrary server data', async () => {
  const original = api.defaults.adapter
  try {
    api.defaults.adapter = async (config) => ({
      data: {
        ok: false,
        code: 'private-fixture-password',
        password: 'private-fixture-password'
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    })
    await assert.rejects(
      api.post('/fixture-write'),
      (e) =>
        !e.message.includes('private-fixture-password') &&
        e.message.includes('unknown')
    )
  } finally {
    api.defaults.adapter = original
  }
})
