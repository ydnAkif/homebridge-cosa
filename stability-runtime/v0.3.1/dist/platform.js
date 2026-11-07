import { loadHomesWithRetry } from './startup.js';
import { Thermostat } from './accessories/index.js';
import { login } from './api/auth.js';
import { getHomeList } from './api/home.js';
import { setApiLogger } from './api/index.js';
function isCosaConfig(config) {
    return (typeof config['email'] === 'string' &&
        config['email'].trim().length > 0 &&
        typeof config['password'] === 'string' &&
        config['password'].length > 0);
}
export class CosaPlatform {
    log;
    config;
    api;
    constructor(log, config, api) {
        if (!isCosaConfig(config)) {
            throw new Error('Cosa requires a non-empty email and password in its platform configuration.');
        }
        this.log = log;
        this.config = config;
        this.api = api;
        setApiLogger((level, message) => {
            switch (level) {
                case 'debug':
                    this.log.debug(message);
                    break;
                case 'info':
                    this.log.info(message);
                    break;
                case 'warn':
                    this.log.warn(message);
                    break;
                case 'error':
                    this.log.error(message);
                    break;
            }
        });
        // probably parse config or something here
        log.info('Cosa platform finished initializing!');
    }
    /*
     * This method is called to retrieve all accessories exposed by the platform.
     * The Platform can delay the response my invoking the callback at a later time,
     * it will delay the bridge startup though, so keep it to a minimum.
     * The set of exposed accessories CANNOT change over the lifetime of the plugin!
     */
    async accessories(register) {
        // this.log.debug(JSON.stringify(this.config))
        this.log.debug(`Cosa platform loaded for user: ${this.config.email}`);
        const { email, password } = this.config;
        let stopped = false;
        let timer;
        let releaseWait;
        this.api.on('shutdown', () => {
            stopped = true;
            if (timer !== undefined)
                clearTimeout(timer);
            releaseWait?.();
        });
        const homeList = await loadHomesWithRetry({
            login: async () => await login({ email, password }),
            getHomes: getHomeList,
            stopped: () => stopped,
            retry: () => {
                this.log.warn('Cosa is temporarily unavailable. Retrying in 30 seconds; preserving existing HomeKit accessories.');
            },
            wait: async () => {
                await new Promise((resolve) => {
                    releaseWait = resolve;
                    timer = setTimeout(resolve, 30000);
                });
            }
        });
        if (homeList === undefined)
            return;
        const devices = homeList.map((home) => {
            this.log.info(`Created device with name "${home.name}".`);
            const accessory = new Thermostat({
                hap: this.api.hap,
                log: this.log,
                id: home.id,
                name: home.name
            });
            const alias = this.config.accessoryNames?.[home.id] ??
                this.config.accessoryNames?.[home.name];
            if (typeof alias === 'string' && alias.trim().length > 0) {
                // Preserve the original static-platform UUID when the display name changes.
                Object.assign(accessory, { uuid_base: home.name, name: alias.trim() });
                for (const service of accessory.getServices()) {
                    service.setCharacteristic(this.api.hap.Characteristic.Name, alias.trim());
                    if (!(service instanceof this.api.hap.Service.AccessoryInformation)) {
                        service.addOptionalCharacteristic(this.api.hap.Characteristic.ConfiguredName);
                        service.setCharacteristic(this.api.hap.Characteristic.ConfiguredName, alias.trim());
                    }
                }
            }
            return accessory;
        });
        register(devices);
    }
}
//# sourceMappingURL=platform.js.map