import {
  type CharacteristicValue,
  type HAP,
  type Logging,
  type Service
} from 'homebridge'

import {
  getHome,
  getCurrentHumidity,
  setTargetHeatingState,
  setTargetTemperature
} from '../api/home.js'

const TARGET_TEMPERATURE_DEBOUNCE_MS = 800
const STATE_REFRESH_TTL_MS = 30_000

export class Thermostat {
  private readonly log: Logging
  private readonly name: string

  private readonly thermostatService: Service
  private readonly humidityService: Service
  private readonly informationService: Service
  private readonly hap: HAP

  private readonly id: string

  private currentHeating = false
  private currentTemperature = 20
  private targetTemperature = 20
  private currentHumidity: number | undefined
  private lastStateRefreshAt = 0
  private stateRefreshPromise: Promise<void> | undefined
  private pendingTargetTemperature: number | undefined
  private readonly pendingWrites: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }> = []

  private targetTemperatureUpdateTimer:
    | ReturnType<typeof setTimeout>
    | undefined

  constructor({
    hap,
    log,
    id,
    name
  }: {
    hap: HAP
    log: Logging
    id: string
    name: string
  }) {
    this.name = name
    this.log = log
    this.hap = hap
    this.id = id

    this.thermostatService = new hap.Service.Thermostat(this.name)

    this.thermostatService
      .getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .setProps({
        validValues: [
          hap.Characteristic.CurrentHeatingCoolingState.OFF,
          hap.Characteristic.CurrentHeatingCoolingState.HEAT
        ]
      })
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this))

    this.thermostatService
      .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          hap.Characteristic.TargetHeatingCoolingState.OFF,
          hap.Characteristic.TargetHeatingCoolingState.HEAT
        ]
      })
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(async (value: CharacteristicValue) => {
        await this.handleTargetHeatingCoolingStateSet(Number(value))
      })

    this.thermostatService
      .getCharacteristic(hap.Characteristic.CurrentTemperature)
      .setProps({
        minStep: 0.1
      })
      .onGet(this.handleCurrentTemperatureGet.bind(this))

    this.thermostatService
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .setProps({
        minValue: 5,
        maxValue: 32,
        minStep: 0.1
      })
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(async (value: CharacteristicValue) => {
        await this.handleTargetTemperatureSet(Number(value))
      })

    this.thermostatService
      .getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet((value: CharacteristicValue) => {
        this.handleTemperatureDisplayUnitsSet(Number(value))
      })

    this.humidityService = new hap.Service.HumiditySensor(this.name)
    this.humidityService
      .getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
      .setProps({
        minStep: 1
      })
      .onGet(this.handleCurrentRelativeHumidityGet.bind(this))

    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Cosa')
      .setCharacteristic(hap.Characteristic.Model, 'v4')

    log.info('Thermostat finished initializing!')
    this.refreshStateIfNeeded(true)
  }

  identify(): void {
    this.log('Identified.')
  }

  getServices(): Service[] {
    return [
      this.informationService,
      this.thermostatService,
      this.humidityService
    ]
  }

  private refreshStateIfNeeded(forceRefresh = false): void {
    if (
      !forceRefresh &&
      Date.now() - this.lastStateRefreshAt < STATE_REFRESH_TTL_MS
    ) {
      return
    }

    if (this.stateRefreshPromise !== undefined) {
      return
    }

    this.stateRefreshPromise = this.refreshState()
      .catch(() => undefined)
      .finally(() => {
        this.stateRefreshPromise = undefined
      })
  }

  private async refreshState(): Promise<void> {
    const home = await getHome({
      homeId: this.id,
      forceRefresh: true
    })

    if (home === null) {
      return
    }

    this.currentHeating = home.combiState === 'on'
    this.currentTemperature = home.temperature
    this.targetTemperature = home.targetTemperature
    this.currentHumidity = home.humidity
    this.lastStateRefreshAt = Date.now()

    const currentHeatingState = this.currentHeating
      ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
      : this.hap.Characteristic.CurrentHeatingCoolingState.OFF
    const targetHeatingState = this.currentHeating
      ? this.hap.Characteristic.TargetHeatingCoolingState.HEAT
      : this.hap.Characteristic.TargetHeatingCoolingState.OFF

    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.CurrentHeatingCoolingState,
      currentHeatingState
    )
    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.TargetHeatingCoolingState,
      targetHeatingState
    )
    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.CurrentTemperature,
      this.currentTemperature
    )
    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.TargetTemperature,
      this.targetTemperature
    )
    const humidity = this.humidityService.getCharacteristic(
      this.hap.Characteristic.CurrentRelativeHumidity
    )
    if (this.currentHumidity === undefined)
      humidity.updateValue(this.communicationError())
    else humidity.updateValue(this.currentHumidity)
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  private communicationError(): Error {
    return new this.hap.HapStatusError(
      this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
    )
  }

  private requireFreshState(): void {
    this.refreshStateIfNeeded()
    if (
      this.lastStateRefreshAt === 0 ||
      Date.now() - this.lastStateRefreshAt > 120_000
    ) {
      throw this.communicationError()
    }
  }

  handleCurrentHeatingCoolingStateGet(): number {
    this.log.debug('Triggered GET CurrentHeatingCoolingState')
    this.requireFreshState()

    const { OFF, HEAT } = this.hap.Characteristic.CurrentHeatingCoolingState

    const currentValue = this.currentHeating ? HEAT : OFF

    this.log.debug('Heating state is', this.currentHeating, currentValue)

    return currentValue
  }

  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateGet(): number {
    this.log.debug('Triggered GET TargetHeatingCoolingState')
    this.requireFreshState()

    const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState

    const currentValue = this.currentHeating ? HEAT : OFF

    this.log.debug('Target heating state is', this.currentHeating, currentValue)

    return currentValue
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  async handleTargetHeatingCoolingStateSet(value: number): Promise<void> {
    const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState
    if (value !== OFF && value !== HEAT)
      throw new this.hap.HapStatusError(
        this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST
      )
    try {
      await setTargetHeatingState({
        homeId: this.id,
        targetState: value === OFF ? 'off' : 'on'
      })
      this.lastStateRefreshAt = 0
      this.refreshStateIfNeeded(true)
    } catch {
      throw this.communicationError()
    }
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet(): number {
    this.log.debug('Triggered GET CurrentTemperature')
    this.requireFreshState()

    this.log.debug('Current value is', this.currentTemperature)

    return this.currentTemperature
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet(): number {
    this.log.debug('Triggered GET TargetTemperature')
    this.requireFreshState()

    this.log.debug('Target temperature is', this.targetTemperature)

    return this.targetTemperature
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  async handleTargetTemperatureSet(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 5 || value > 32)
      throw new this.hap.HapStatusError(
        this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST
      )
    this.pendingTargetTemperature = value
    if (this.targetTemperatureUpdateTimer !== undefined)
      clearTimeout(this.targetTemperatureUpdateTimer)
    await new Promise<void>((resolve, reject) => {
      this.pendingWrites.push({ resolve, reject })
      this.targetTemperatureUpdateTimer = setTimeout(() => {
        void this.flushTargetTemperatureUpdate()
      }, TARGET_TEMPERATURE_DEBOUNCE_MS)
    })
  }

  private async flushTargetTemperatureUpdate(): Promise<void> {
    const targetTemperature = this.pendingTargetTemperature
    const waiters = this.pendingWrites.splice(0)
    this.pendingTargetTemperature = undefined
    this.targetTemperatureUpdateTimer = undefined
    if (targetTemperature === undefined) return
    try {
      await setTargetTemperature({ homeId: this.id, targetTemperature })
      this.lastStateRefreshAt = 0
      this.refreshStateIfNeeded(true)
      waiters.forEach(({ resolve }) => {
        resolve()
      })
    } catch {
      waiters.forEach(({ reject }) => {
        reject(this.communicationError())
      })
    }
  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet(): number {
    this.log.debug('Triggered GET TemperatureDisplayUnits')

    // set this to a valid value for TemperatureDisplayUnits
    const currentValue = this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
    this.log.debug('handleTemperatureDisplayUnitsGet', currentValue)

    return currentValue
  }

  /**
   * Handle requests to set the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsSet(value: number): void {
    this.log.debug('Triggered SET TemperatureDisplayUnits:', value)
  }

  async handleCurrentRelativeHumidityGet(): Promise<number> {
    try {
      return await getCurrentHumidity({ homeId: this.id })
    } catch {
      throw this.communicationError()
    }
  }
}
