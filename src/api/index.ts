import axios from 'axios'

const API_BASE_URL = 'https://kiwi.cosa.com.tr/api'
const API_TIMEOUT_MS = 15_000

type ApiLogLevel = 'debug' | 'info' | 'warn' | 'error'
type ApiLogger = (level: ApiLogLevel, message: string) => void

let apiLogger: ApiLogger | undefined

export function setApiLogger(logger: ApiLogger): void {
  apiLogger = logger
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function logApiError(context: string, error: unknown): void {
  const message = `[Cosa API] ${context}: ${getErrorMessage(error)}`

  if (apiLogger !== undefined) {
    apiLogger('error', message)
    return
  }

  // eslint-disable-next-line no-console
  console.error(message)
}

export function logApiWarn(message: string): void {
  const formattedMessage = `[Cosa API] ${message}`

  if (apiLogger !== undefined) {
    apiLogger('warn', formattedMessage)
    return
  }

  // eslint-disable-next-line no-console
  console.warn(formattedMessage)
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
})
