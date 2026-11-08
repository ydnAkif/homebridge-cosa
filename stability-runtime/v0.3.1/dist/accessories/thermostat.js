import { getHome, setTargetHeatingState, setTargetTemperature } from '../api/home.js';
const TARGET_TEMPERATURE_DEBOUNCE_MS = 800;
const STATE_REFRESH_TTL_MS = 30_000;
export class Thermostat {
    log;
    name;
    thermostatService;
    humidityService;
    informationService;
    hap;
    id;
    currentHeating = false;
    targetHeating = false;
    stopped = false;
    refreshTimer;
    currentTemperature = 20;
    targetTemperature = 20;
    currentHumidity;
    lastStateRefreshAt = 0;
    stateRefreshPromise;
    pendingTargetTemperature;
    pendingWrites = [];
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
            .onSet(async (value) => {
            await this.handleTargetHeatingCoolingStateSet(Number(value));
        });
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
            .onSet(async (value) => {
            await this.handleTargetTemperatureSet(Number(value));
        });
        this.thermostatService
            .getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
            .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
            .onSet((value) => {
            this.handleTemperatureDisplayUnitsSet(Number(value));
        });
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
        this.refreshTimer = setInterval(() => {
            this.refreshStateIfNeeded(true);
        }, 60000);
        this.refreshTimer.unref();
    }
    dispose() {
        this.stopped = true;
        clearInterval(this.refreshTimer);
        if (this.targetTemperatureUpdateTimer !== undefined)
            clearTimeout(this.targetTemperatureUpdateTimer);
        this.pendingWrites.splice(0).forEach(({ reject }) => {
            reject(this.communicationError());
        });
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
        if (this.stopped)
            return;
        if (!forceRefresh &&
            Date.now() - this.lastStateRefreshAt < STATE_REFRESH_TTL_MS) {
            return;
        }
        if (this.stateRefreshPromise !== undefined) {
            return;
        }
        this.stateRefreshPromise = this.refreshState()
            .catch(() => undefined)
            .finally(() => {
            this.stateRefreshPromise = undefined;
        });
    }
    async refreshState() {
        const home = await getHome({
            homeId: this.id,
            forceRefresh: true
        });
        if (home === null || this.stopped) {
            return;
        }
        this.currentHeating = home.combiState === 'on';
        this.targetHeating =
            home.option === 'frozen' ? false : home.targetTemperature > 5;
        this.currentTemperature = home.temperature;
        this.targetTemperature = home.targetTemperature;
        this.currentHumidity = home.humidity;
        this.lastStateRefreshAt = Date.now();
        const currentHeatingState = this.currentHeating
            ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
            : this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
        const targetHeatingState = this.targetHeating
            ? this.hap.Characteristic.TargetHeatingCoolingState.HEAT
            : this.hap.Characteristic.TargetHeatingCoolingState.OFF;
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState, currentHeatingState);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState, targetHeatingState);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.currentTemperature);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.targetTemperature);
        const humidity = this.humidityService.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity);
        if (this.currentHumidity === undefined)
            humidity.updateValue(this.communicationError());
        else
            humidity.updateValue(this.currentHumidity);
    }
    /**
     * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
     */
    communicationError() {
        return new this.hap.HapStatusError(-70402 /* this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
    }
    async requireFreshState() {
        this.refreshStateIfNeeded();
        if (this.lastStateRefreshAt > 0 &&
            Date.now() - this.lastStateRefreshAt <= 120000)
            return;
        // A stale cache must not fail the very read that starts its refresh.
        let deadline;
        try {
            await Promise.race([
                this.stateRefreshPromise,
                new Promise((resolve) => {
                    deadline = setTimeout(resolve, 2000);
                })
            ]);
        }
        finally {
            if (deadline !== undefined)
                clearTimeout(deadline);
        }
        if (this.lastStateRefreshAt === 0 ||
            Date.now() - this.lastStateRefreshAt > 120000)
            throw this.communicationError();
    }
    async handleCurrentHeatingCoolingStateGet() {
        this.log.debug('Triggered GET CurrentHeatingCoolingState');
        await this.requireFreshState();
        const { OFF, HEAT } = this.hap.Characteristic.CurrentHeatingCoolingState;
        const currentValue = this.currentHeating ? HEAT : OFF;
        this.log.debug('Heating state is', this.currentHeating, currentValue);
        return currentValue;
    }
    /**
     * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
     */
    async handleTargetHeatingCoolingStateGet() {
        this.log.debug('Triggered GET TargetHeatingCoolingState');
        await this.requireFreshState();
        const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState;
        const currentValue = this.targetHeating ? HEAT : OFF;
        this.log.debug('Target heating state is', this.currentHeating, currentValue);
        return currentValue;
    }
    /**
     * Handle requests to set the "Target Heating Cooling State" characteristic
     */
    async handleTargetHeatingCoolingStateSet(value) {
        const { OFF, HEAT } = this.hap.Characteristic.TargetHeatingCoolingState;
        if (value !== OFF && value !== HEAT)
            throw new this.hap.HapStatusError(-70410 /* this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST */);
        try {
            await setTargetHeatingState({
                homeId: this.id,
                targetState: value === OFF ? 'off' : 'on'
            });
            this.lastStateRefreshAt = 0;
            this.refreshStateIfNeeded(true);
        }
        catch {
            throw this.communicationError();
        }
    }
    /**
     * Handle requests to get the current value of the "Current Temperature" characteristic
     */
    async handleCurrentTemperatureGet() {
        this.log.debug('Triggered GET CurrentTemperature');
        await this.requireFreshState();
        this.log.debug('Current value is', this.currentTemperature);
        return this.currentTemperature;
    }
    /**
     * Handle requests to get the current value of the "Target Temperature" characteristic
     */
    async handleTargetTemperatureGet() {
        this.log.debug('Triggered GET TargetTemperature');
        await this.requireFreshState();
        this.log.debug('Target temperature is', this.targetTemperature);
        return this.targetTemperature;
    }
    /**
     * Handle requests to set the "Target Temperature" characteristic
     */
    async handleTargetTemperatureSet(value) {
        if (!Number.isFinite(value) || value < 5 || value > 32)
            throw new this.hap.HapStatusError(-70410 /* this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST */);
        this.pendingTargetTemperature = value;
        if (this.targetTemperatureUpdateTimer !== undefined)
            clearTimeout(this.targetTemperatureUpdateTimer);
        await new Promise((resolve, reject) => {
            this.pendingWrites.push({ resolve, reject });
            this.targetTemperatureUpdateTimer = setTimeout(() => {
                void this.flushTargetTemperatureUpdate();
            }, TARGET_TEMPERATURE_DEBOUNCE_MS);
        });
    }
    async flushTargetTemperatureUpdate() {
        const targetTemperature = this.pendingTargetTemperature;
        const waiters = this.pendingWrites.splice(0);
        this.pendingTargetTemperature = undefined;
        this.targetTemperatureUpdateTimer = undefined;
        if (targetTemperature === undefined)
            return;
        try {
            await setTargetTemperature({ homeId: this.id, targetTemperature });
            this.lastStateRefreshAt = 0;
            this.refreshStateIfNeeded(true);
            waiters.forEach(({ resolve }) => {
                resolve();
            });
        }
        catch {
            waiters.forEach(({ reject }) => {
                reject(this.communicationError());
            });
        }
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
        await this.requireFreshState();
        if (typeof this.currentHumidity !== 'number' ||
            !Number.isFinite(this.currentHumidity) ||
            this.currentHumidity < 0 ||
            this.currentHumidity > 100)
            throw this.communicationError();
        return this.currentHumidity;
    }
}
//# sourceMappingURL=thermostat.js.map