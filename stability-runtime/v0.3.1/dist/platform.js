import { Thermostat } from './accessories/index.js';
import { login } from './api/auth.js';
import { getHomeList } from './api/home.js';
import { setApiLogger } from './api/index.js';
export class CosaPlatform {
    log;
    config;
    api;
    constructor(log, config, api) {
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
        this.log.debug(`Cosa platform loaded for user: ${this.config.email}`);
        const { email, password } = this.config;
        const loggedIn = await login({
            email,
            password
        });
        if (!loggedIn) {
            this.log.error('Unable to login. Check your email and password.');
            register([]);
            return;
        }
        const homeList = await getHomeList();
        if (homeList.length === 0) {
            this.log.error('A home in Cosa is not available to register the thermostat.');
            register([]);
            return;
        }
        const devices = homeList.map((home) => {
            this.log.info(`Created device with name "${home.name}".`);
            const accessory = new Thermostat({
                hap: this.api.hap,
                log: this.log,
                id: home.id,
                name: home.name
            });
            const alias = this.config.accessoryNames?.[home.id] ?? this.config.accessoryNames?.[home.name];
            if (typeof alias === 'string' && alias.trim()) {
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