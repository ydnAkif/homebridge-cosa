import test from 'node:test'
import assert from 'node:assert/strict'
import { requireHumidity } from '../dist/humidity.js'
import { CosaPlatform } from '../dist/platform.js'
import { api } from '../dist/api/index.js'
import { getCurrentHumidity } from '../dist/api/home.js'
import { Thermostat } from '../dist/accessories/thermostat.js'

test('missing, failed and malformed humidity is rejected; valid 0% is accepted', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 101, '0'])
    assert.throws(() => requireHumidity(value), /unavailable/)
  for (const value of [0, 45.5, 100])
    assert.equal(requireHumidity(value), value)
})
test('platform constructor validates generic PlatformConfig before narrowing', () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  for (const config of [
    { platform: 'Cosa' },
    { platform: 'Cosa', email: '', password: 'fixture' },
    { platform: 'Cosa', email: 'fixture', password: 3 }
  ])
    assert.throws(() => new CosaPlatform(log, config, {}), /email and password/)
  assert.doesNotThrow(
    () =>
      new CosaPlatform(
        log,
        { platform: 'Cosa', email: 'fixture', password: 'fixture' },
        {}
      )
  )
})
test('endpoint absence and failed getHome reject instead of returning zero', async () => {
  const post = api.post
  try {
    api.post = async () => ({
      data: {
        endpoint: { combiState: 'off', temperature: 20, targetTemperature: 23 }
      }
    })
    await assert.rejects(
      getCurrentHumidity({ homeId: 'fixture-missing' }),
      /unavailable/
    )
    api.post = async () => ({ data: {} })
    await assert.rejects(
      getCurrentHumidity({ homeId: 'fixture-failed' }),
      /unavailable/
    )
    api.post = async () => ({
      data: {
        endpoint: {
          combiState: 'off',
          temperature: 20,
          targetTemperature: 23,
          humidity: 0
        }
      }
    })
    assert.equal(await getCurrentHumidity({ homeId: 'fixture-zero' }), 0)
  } finally {
    api.post = post
  }
})
test('HomeKit humidity getter translates unavailable data to communication failure', async () => {
  const post = api.post
  class Offline extends Error {
    constructor(status) {
      super('offline')
      this.hapStatus = status
    }
  }
  try {
    api.post = async () => ({ data: {} })
    const accessory = Object.assign(Object.create(Thermostat.prototype), {
      id: 'fixture',
      log: { debug() {} },
      hap: {
        HapStatusError: Offline,
        HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 }
      }
    })
    await assert.rejects(
      accessory.handleCurrentRelativeHumidityGet(),
      (e) => e.hapStatus === -70402
    )
  } finally {
    api.post = post
  }
})
