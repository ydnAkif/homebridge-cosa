import { type API, type PlatformPluginConstructor } from 'homebridge'

import { PLATFORM_NAME } from './settings.js'
import { CosaPlatform } from './platform.js'

export default function (api: API): void {
  const platformConstructor: PlatformPluginConstructor = CosaPlatform
  api.registerPlatform(PLATFORM_NAME, platformConstructor)
}
