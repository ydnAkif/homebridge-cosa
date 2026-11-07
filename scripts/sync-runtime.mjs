import { cpSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(root + 'stability-runtime/v0.3.1/dist', { recursive: true })
cpSync(root + 'dist', root + 'stability-runtime/v0.3.1/dist', {
  recursive: true
})
