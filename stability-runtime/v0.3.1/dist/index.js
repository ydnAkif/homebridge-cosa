import { PLATFORM_NAME } from './settings.js';
import { CosaPlatform } from './platform.js';
export default function (api) {
    const platformConstructor = CosaPlatform;
    api.registerPlatform(PLATFORM_NAME, platformConstructor);
}
//# sourceMappingURL=index.js.map