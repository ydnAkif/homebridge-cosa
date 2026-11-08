import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../dist/api/index.js'
import { Thermostat } from '../dist/accessories/thermostat.js'
const home = {
  combiState: 'off',
  option: 'sleep',
  temperature: 19.5,
  targetTemperature: 20,
  humidity: 58.4
}
function fixture(id) {
  class Char {
    setProps() {
      return this
    }
    onGet(fn) {
      this.get = fn
      return this
    }
    onSet(fn) {
      this.set = fn
      return this
    }
    updateValue(value) {
      this.value = value
      return this
    }
  }
  class Service {
    constructor() {
      this.chars = new Map()
    }
    getCharacteristic(type) {
      if (!this.chars.has(type)) this.chars.set(type, new Char())
      return this.chars.get(type)
    }
    setCharacteristic() {
      return this
    }
    updateCharacteristic(type, value) {
      this.getCharacteristic(type).updateValue(value)
      return this
    }
  }
  class Offline extends Error {
    constructor(status) {
      super('offline')
      this.hapStatus = status
    }
  }
  const hap = {
    Service: {
      Thermostat: Service,
      HumiditySensor: Service,
      AccessoryInformation: Service
    },
    Characteristic: {
      CurrentHeatingCoolingState: { OFF: 0, HEAT: 1 },
      TargetHeatingCoolingState: { OFF: 0, HEAT: 1 },
      TemperatureDisplayUnits: { CELSIUS: 0 },
      CurrentTemperature: 'temperature',
      TargetTemperature: 'target',
      CurrentRelativeHumidity: 'humidity'
    },
    HapStatusError: Offline,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 }
  }
  const log = Object.assign(() => {}, { debug() {}, info() {} })
  return new Thermostat({ id, hap, log, name: 'fixture' })
}
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve()
}
test('first cold HomeKit read awaits its shared refresh and succeeds without requiring a second read', async () => {
  const post = api.post
  let finish,
    calls = 0,
    a
  try {
    api.post = () => {
      calls++
      return new Promise(
        (resolve) => (finish = () => resolve({ data: { endpoint: home } }))
      )
    }
    a = fixture('cold-first')
    const result = a.handleCurrentTemperatureGet()
    finish()
    assert.equal(await result, 19.5)
    assert.equal(calls, 1)
  } finally {
    a?.dispose()
    api.post = post
  }
})
test('periodic refresh keeps an unread thermostat fresh overnight and stops on shutdown', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1000000
  })
  const post = api.post
  let calls = 0,
    a
  try {
    api.post = async () => {
      calls++
      return { data: { endpoint: home } }
    }
    a = fixture('idle-refresh')
    await flush()
    assert.equal(calls, 1)
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(60000)
      await flush()
    }
    assert.equal(calls, 5)
    assert.equal(await a.handleCurrentTemperatureGet(), 19.5)
    a.dispose()
    t.mock.timers.tick(180000)
    await flush()
    assert.equal(calls, 5)
  } finally {
    a?.dispose()
    api.post = post
  }
})
test('humidity uses validated shared cache without a separate blocking cloud request', async () => {
  const post = api.post
  let calls = 0,
    a
  try {
    api.post = async () => {
      calls++
      return { data: { endpoint: home } }
    }
    a = fixture('cached-humidity')
    await flush()
    api.post = async () => {
      throw Error('unexpected network call')
    }
    assert.equal(await a.handleCurrentRelativeHumidityGet(), 58.4)
    assert.equal(calls, 1)
  } finally {
    a?.dispose()
    api.post = post
  }
})
test('scheduled heating remains enabled while the boiler is between heating cycles', async () => {
  const post = api.post
  let a
  try {
    api.post = async () => ({ data: { endpoint: home } })
    a = fixture('boiler-idle')
    await flush()
    assert.equal(await a.handleCurrentHeatingCoolingStateGet(), 0)
    assert.equal(await a.handleTargetHeatingCoolingStateGet(), 1)
  } finally {
    a?.dispose()
    api.post = post
  }
})
test('an unavailable cloud refresh has a two-second HomeKit deadline and never invents values', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1000000
  })
  const post = api.post
  let finish, a
  try {
    api.post = () =>
      new Promise(
        (resolve) => (finish = () => resolve({ data: { endpoint: home } }))
      )
    a = fixture('deadline')
    const failure = assert.rejects(
      a.handleCurrentTemperatureGet(),
      (e) => e.hapStatus === -70402
    )
    t.mock.timers.tick(2000)
    await failure
    finish()
    await flush()
    assert.equal(await a.handleCurrentTemperatureGet(), 19.5)
  } finally {
    a?.dispose()
    api.post = post
  }
})

test('boiler state loss invalidates only the heating characteristic and recovers without hiding current measurements', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 9000000
  })
  const original = api.defaults.adapter
  let a
  let reading = { ...home, combiState: 'on' }
  try {
    api.defaults.adapter = async (config) => ({
      data: { ok: 1, endpoint: reading },
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    })
    a = fixture('partial-state-transition')
    await flush()
    assert.equal(await a.handleCurrentHeatingCoolingStateGet(), 1)
    reading = { ...home, combiState: null, temperature: 21.2, humidity: 61 }
    t.mock.timers.tick(60000)
    await flush()
    await assert.rejects(
      a.handleCurrentHeatingCoolingStateGet(),
      (error) => error.hapStatus === -70402
    )
    assert.equal(await a.handleCurrentTemperatureGet(), 21.2)
    assert.equal(await a.handleCurrentRelativeHumidityGet(), 61)
    assert.equal(await a.handleTargetHeatingCoolingStateGet(), 1)
    const currentHeating = a
      .getServices()[1]
      .getCharacteristic(a.hap.Characteristic.CurrentHeatingCoolingState)
    assert.equal(currentHeating.value.hapStatus, -70402)
    reading = { ...home, combiState: 'off', temperature: 21.3 }
    t.mock.timers.tick(60000)
    await flush()
    assert.equal(await a.handleCurrentHeatingCoolingStateGet(), 0)
    assert.equal(currentHeating.value, 0)
  } finally {
    a?.dispose()
    api.defaults.adapter = original
  }
})
