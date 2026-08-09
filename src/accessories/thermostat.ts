import { type HAP, type Logging, type Service } from 'homebridge'

import {
  getHome,
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
  private currentHumidity = 0
  private lastStateRefreshAt = 0
  private stateRefreshPromise: Promise<void> | undefined
  private pendingTargetTemperature: number | undefined
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
      // @ts-expect-error - TODO
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this))

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
      // @ts-expect-error - TODO
      .onSet(this.handleTargetTemperatureSet.bind(this))

    this.thermostatService
      .getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      // @ts-expect-error - TODO
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this))

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

    this.stateRefreshPromise = this.refreshState().finally(() => {
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
    this.currentHumidity = home.humidity ?? 0
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
    this.humidityService.updateCharacteristic(
      this.hap.Characteristic.CurrentRelativeHumidity,
      this.currentHumidity
    )
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  handleCurrentHeatingCoolingStateGet(): number {
    this.log.debug('Triggered GET CurrentHeatingCoolingState')
    this.refreshStateIfNeeded()

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
    this.refreshStateIfNeeded()

    const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState

    const currentValue = this.currentHeating ? HEAT : OFF

    this.log.debug('Target heating state is', this.currentHeating, currentValue)

    return currentValue
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value: number): void {
    this.log.info('Triggered SET TargetHeatingCoolingState:', value)

    const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState
    const targetState = value === OFF ? 'off' : 'on'

    if (value !== OFF && value !== HEAT) {
      this.log.debug(
        'TargetHeatingCoolingState received non-OFF value, treating as on:',
        value
      )
    }

    this.currentHeating = targetState === 'on'
    this.lastStateRefreshAt = Date.now()
    this.log.info('Setting target heating state to', targetState)

    void setTargetHeatingState({
      homeId: this.id,
      targetState
    })
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet(): number {
    this.log.debug('Triggered GET CurrentTemperature')
    this.refreshStateIfNeeded()

    this.log.debug('Current value is', this.currentTemperature)

    return this.currentTemperature
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet(): number {
    this.log.debug('Triggered GET TargetTemperature')
    this.refreshStateIfNeeded()

    this.log.debug('Target temperature is', this.targetTemperature)

    return this.targetTemperature
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  handleTargetTemperatureSet(value: number): void {
    this.log.info('Triggered SET TargetTemperature:', value)

    this.targetTemperature = value
    this.lastStateRefreshAt = Date.now()
    this.pendingTargetTemperature = value

    if (this.targetTemperatureUpdateTimer !== undefined) {
      clearTimeout(this.targetTemperatureUpdateTimer)
    }

    this.targetTemperatureUpdateTimer = setTimeout(() => {
      void this.flushTargetTemperatureUpdate()
    }, TARGET_TEMPERATURE_DEBOUNCE_MS)
  }

  private async flushTargetTemperatureUpdate(): Promise<void> {
    const targetTemperature = this.pendingTargetTemperature

    if (targetTemperature === undefined) {
      return
    }

    this.pendingTargetTemperature = undefined
    this.targetTemperatureUpdateTimer = undefined
    this.log.info('Setting target temperature to', targetTemperature)

    await setTargetTemperature({
      homeId: this.id,
      targetTemperature
    })
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

  handleCurrentRelativeHumidityGet(): number {
    this.log.debug('Triggered GET CurrentRelativeHumidity')
    this.refreshStateIfNeeded()

    this.log.debug('Humidity is', this.currentHumidity)

    return this.currentHumidity
  }
}
