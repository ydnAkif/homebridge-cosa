import { getCurrentHumidity, getHome, setTargetHeatingState, setTargetTemperature } from '../api/home.js';
const TARGET_TEMPERATURE_DEBOUNCE_MS = 800;
const STATE_REFRESH_TTL_MS = 30000;
export class Thermostat {
    log;
    name;
    thermostatService;
    humidityService;
    informationService;
    hap;
    id;
    currentHeating = false;
    currentTemperature = 20;
    targetTemperature = 20;
    currentHumidity;
    lastStateRefreshAt = 0;
    stateRefreshPromise;
    pendingTargetTemperature;
    targetTemperatureUpdateTimer;
    constructor({ hap, log, id, name }) {
        this.name = name;
        this.log = log;
        this.hap = hap;
        this.id = id;
        this.thermostatService = new hap.Service.Thermostat(this.name);
        this.thermostatService
            .getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
            .setProps({
            validValues: [
                hap.Characteristic.CurrentHeatingCoolingState.OFF,
                hap.Characteristic.CurrentHeatingCoolingState.HEAT
            ]
        })
            .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));
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
            .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));
        this.thermostatService
            .getCharacteristic(hap.Characteristic.CurrentTemperature)
            .setProps({
            minStep: 0.1
        })
            .onGet(this.handleCurrentTemperatureGet.bind(this));
        this.thermostatService
            .getCharacteristic(hap.Characteristic.TargetTemperature)
            .setProps({
            minValue: 5,
            maxValue: 32,
            minStep: 0.1
        })
            .onGet(this.handleTargetTemperatureGet.bind(this))
            // @ts-expect-error - TODO
            .onSet(this.handleTargetTemperatureSet.bind(this));
        this.thermostatService
            .getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
            .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
            // @ts-expect-error - TODO
            .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));
        this.humidityService = new hap.Service.HumiditySensor(this.name);
        this.humidityService
            .getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
            .setProps({
            minStep: 1
        })
            .onGet(this.handleCurrentRelativeHumidityGet.bind(this));
        this.informationService = new hap.Service.AccessoryInformation()
            .setCharacteristic(hap.Characteristic.Manufacturer, 'Cosa')
            .setCharacteristic(hap.Characteristic.Model, 'v4');
        log.info('Thermostat finished initializing!');
        this.refreshStateIfNeeded(true);
    }
    identify() {
        this.log('Identified.');
    }
    getServices() {
        return [
            this.informationService,
            this.thermostatService,
            this.humidityService
        ];
    }
    refreshStateIfNeeded(forceRefresh = false) {
        if (!forceRefresh &&
            Date.now() - this.lastStateRefreshAt < STATE_REFRESH_TTL_MS) {
            return;
        }
        if (this.stateRefreshPromise !== undefined) {
            return;
        }
        this.stateRefreshPromise = this.refreshState().finally(() => {
            this.stateRefreshPromise = undefined;
        });
    }
    async refreshState() {
        const home = await getHome({
            homeId: this.id,
            forceRefresh: true
        });
        if (home === null) {
            return;
        }
        this.currentHeating = home.combiState === 'on';
        this.currentTemperature = home.temperature;
        this.targetTemperature = home.targetTemperature;
        this.currentHumidity = typeof home.humidity === 'number' && Number.isFinite(home.humidity) && home.humidity >= 0 && home.humidity <= 100 ? home.humidity : undefined;
        this.lastStateRefreshAt = Date.now();
        const currentHeatingState = this.currentHeating
            ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
            : this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
        const targetHeatingState = this.currentHeating
            ? this.hap.Characteristic.TargetHeatingCoolingState.HEAT
            : this.hap.Characteristic.TargetHeatingCoolingState.OFF;
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState, currentHeatingState);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState, targetHeatingState);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.currentTemperature);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.targetTemperature);
        this.humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, this.currentHumidity ?? new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
    /**
     * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
     */
    handleCurrentHeatingCoolingStateGet() {
        this.log.debug('Triggered GET CurrentHeatingCoolingState');
        this.refreshStateIfNeeded();
        const { OFF, HEAT } = this.hap.Characteristic.CurrentHeatingCoolingState;
        const currentValue = this.currentHeating ? HEAT : OFF;
        this.log.debug('Heating state is', this.currentHeating, currentValue);
        return currentValue;
    }
    /**
     * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
     */
    handleTargetHeatingCoolingStateGet() {
        this.log.debug('Triggered GET TargetHeatingCoolingState');
        this.refreshStateIfNeeded();
        const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState;
        const currentValue = this.currentHeating ? HEAT : OFF;
        this.log.debug('Target heating state is', this.currentHeating, currentValue);
        return currentValue;
    }
    /**
     * Handle requests to set the "Target Heating Cooling State" characteristic
     */
    handleTargetHeatingCoolingStateSet(value) {
        this.log.info('Triggered SET TargetHeatingCoolingState:', value);
        const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState;
        const targetState = value === OFF ? 'off' : 'on';
        if (value !== OFF && value !== HEAT) {
            this.log.debug('TargetHeatingCoolingState received non-OFF value, treating as on:', value);
        }
        this.currentHeating = targetState === 'on';
        this.lastStateRefreshAt = Date.now();
        this.log.info('Setting target heating state to', targetState);
        void setTargetHeatingState({
            homeId: this.id,
            targetState
        });
    }
    /**
     * Handle requests to get the current value of the "Current Temperature" characteristic
     */
    handleCurrentTemperatureGet() {
        this.log.debug('Triggered GET CurrentTemperature');
        this.refreshStateIfNeeded();
        this.log.debug('Current value is', this.currentTemperature);
        return this.currentTemperature;
    }
    /**
     * Handle requests to get the current value of the "Target Temperature" characteristic
     */
    handleTargetTemperatureGet() {
        this.log.debug('Triggered GET TargetTemperature');
        this.refreshStateIfNeeded();
        this.log.debug('Target temperature is', this.targetTemperature);
        return this.targetTemperature;
    }
    /**
     * Handle requests to set the "Target Temperature" characteristic
     */
    handleTargetTemperatureSet(value) {
        this.log.info('Triggered SET TargetTemperature:', value);
        this.targetTemperature = value;
        this.lastStateRefreshAt = Date.now();
        this.pendingTargetTemperature = value;
        if (this.targetTemperatureUpdateTimer !== undefined) {
            clearTimeout(this.targetTemperatureUpdateTimer);
        }
        this.targetTemperatureUpdateTimer = setTimeout(() => {
            void this.flushTargetTemperatureUpdate();
        }, TARGET_TEMPERATURE_DEBOUNCE_MS);
    }
    async flushTargetTemperatureUpdate() {
        const targetTemperature = this.pendingTargetTemperature;
        if (targetTemperature === undefined) {
            return;
        }
        this.pendingTargetTemperature = undefined;
        this.targetTemperatureUpdateTimer = undefined;
        this.log.info('Setting target temperature to', targetTemperature);
        await setTargetTemperature({
            homeId: this.id,
            targetTemperature
        });
    }
    /**
     * Handle requests to get the current value of the "Temperature Display Units" characteristic
     */
    handleTemperatureDisplayUnitsGet() {
        this.log.debug('Triggered GET TemperatureDisplayUnits');
        // set this to a valid value for TemperatureDisplayUnits
        const currentValue = this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS;
        this.log.debug('handleTemperatureDisplayUnitsGet', currentValue);
        return currentValue;
    }
    /**
     * Handle requests to set the "Temperature Display Units" characteristic
     */
    handleTemperatureDisplayUnitsSet(value) {
        this.log.debug('Triggered SET TemperatureDisplayUnits:', value);
    }
    async handleCurrentRelativeHumidityGet() {
        this.log.debug('Triggered GET CurrentRelativeHumidity');
        try {
            const currentValue = await getCurrentHumidity({ homeId: this.id });
            this.log.debug('Humidity is', currentValue);
            return currentValue;
        }
        catch {
            throw new this.hap.HapStatusError(-70402 /* this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
    }
}
//# sourceMappingURL=thermostat.js.map