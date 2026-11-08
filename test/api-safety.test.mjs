import test from 'node:test'
import assert from 'node:assert/strict'
import { AxiosError } from 'axios'
import { api, setApiLogger } from '../dist/api/index.js'
import { login } from '../dist/api/auth.js'
import {
  getCurrentTemperature,
  getCurrentHeatingState,
  setTargetTemperature,
  setTargetHeatingState
} from '../dist/api/home.js'
import { Thermostat } from '../dist/accessories/thermostat.js'
const response = (config, data, status = 200) => ({
  data,
  status,
  statusText: 'fixture',
  headers: {},
  config
})
test('Axios authentication failures never log request credentials or response secrets', async () => {
  const adapter = api.defaults.adapter,
    logs = []
  setApiLogger((_level, message) => logs.push(message))
  try {
    api.defaults.adapter = async (config) => {
      throw new AxiosError(
        'password=secret-response',
        'ERR_BAD_REQUEST',
        config,
        {},
        response(config, { secret: 'secret-response' }, 401)
      )
    }
    assert.equal(
      await login({
        email: 'private-fixture-email',
        password: 'private-fixture-password'
      }),
      false
    )
    assert.equal(api.defaults.timeout, 15000)
    assert.doesNotMatch(
      logs.join(' '),
      /private-fixture|secret-response|password=/
    )
  } finally {
    api.defaults.adapter = adapter
  }
})
test('failed home reads reject temperature and heating state rather than fabricating measurements', async () => {
  const post = api.post
  try {
    api.post = async () => ({ data: {} })
    await assert.rejects(
      getCurrentTemperature({ homeId: 'bad-temp' }),
      /unavailable/
    )
    await assert.rejects(
      getCurrentHeatingState({ homeId: 'bad-heat' }),
      /unavailable/
    )
  } finally {
    api.post = post
  }
})
test('temperature writes preserve all other actual presets and report rejected writes', async () => {
  const post = api.post
  const writes = []
  let fail = false
  try {
    api.post = async (url, body) => {
      if (url.endsWith('getEndpoint'))
        return {
          data: {
            endpoint: {
              combiState: 'off',
              temperature: 20,
              targetTemperature: 22,
              homeTemperature: 22,
              awayTemperature: 17,
              sleepTemperature: 19,
              customTemperature: 21
            }
          }
        }
      writes.push(body)
      if (fail) throw Error('fixture rejection')
      return { data: {} }
    }
    await setTargetTemperature({ homeId: 'presets', targetTemperature: 23 })
    assert.deepEqual(writes[0].targetTemperatures, {
      home: 23,
      away: 17,
      sleep: 19,
      custom: 21
    })
    fail = true
    await assert.rejects(
      setTargetHeatingState({ homeId: 'write-fail', targetState: 'on' }),
      /write failed/
    )
  } finally {
    api.post = post
  }
})
test('missing presets never cause destructive default writes', async () => {
  const post = api.post
  let writes = 0
  try {
    api.post = async (url) => {
      if (!url.endsWith('getEndpoint')) writes++
      return {
        data: {
          endpoint: {
            combiState: 'off',
            temperature: 20,
            targetTemperature: 22
          }
        }
      }
    }
    await assert.rejects(
      setTargetTemperature({ homeId: 'no-presets', targetTemperature: 23 }),
      /presets unavailable/
    )
    assert.equal(writes, 0)
  } finally {
    api.post = post
  }
})
test('an expired session is renewed once for parallel reads, then failed authentication is bounded', async () => {
  const adapter = api.defaults.adapter
  let logins = 0
  try {
    api.defaults.adapter = async (config) => {
      if (config.url === '/users/login') {
        logins++
        return response(config, { authToken: 'fixture-' + logins })
      }
      if (config.headers.get('authToken') !== 'fixture-2')
        throw new AxiosError(
          'unauthorized',
          'ERR_BAD_REQUEST',
          config,
          {},
          response(config, {}, 401)
        )
      return response(config, { ok: true })
    }
    assert.equal(await login({ email: 'fixture', password: 'fixture' }), true)
    await Promise.all([api.get('/fixture1'), api.get('/fixture2')])
    assert.equal(logins, 2)
  } finally {
    api.defaults.adapter = adapter
  }
})
test('HomeKit cached reads reject missing or expired state and serve a recent valid reading', async () => {
  class Offline extends Error {
    constructor(code) {
      super()
      this.hapStatus = code
    }
  }
  const a = Object.assign(Object.create(Thermostat.prototype), {
    log: { debug() {} },
    hap: {
      HapStatusError: Offline,
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 }
    },
    lastStateRefreshAt: 0,
    refreshStateIfNeeded() {}
  })
  await assert.rejects(
    a.handleCurrentTemperatureGet(),
    (e) => e.hapStatus === -70402
  )
  a.lastStateRefreshAt = Date.now() - 121000
  a.currentTemperature = 22
  await assert.rejects(a.handleCurrentTemperatureGet())
  a.lastStateRefreshAt = Date.now()
  assert.equal(await a.handleCurrentTemperatureGet(), 22)
})
test('HomeKit mode write awaits cloud acknowledgment and returns communication failure on rejection', async () => {
  const post = api.post
  class Offline extends Error {
    constructor(code) {
      super()
      this.hapStatus = code
    }
  }
  const a = Object.assign(Object.create(Thermostat.prototype), {
    id: 'fixture',
    hap: {
      Characteristic: { TargetHeatingCoolingState: { OFF: 0, HEAT: 1 } },
      HapStatusError: Offline,
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 }
    },
    refreshStateIfNeeded() {}
  })
  try {
    api.post = async () => {
      throw Error('fixture rejection')
    }
    await assert.rejects(
      a.handleTargetHeatingCoolingStateSet(1),
      (e) => e.hapStatus === -70402
    )
  } finally {
    api.post = post
  }
})
