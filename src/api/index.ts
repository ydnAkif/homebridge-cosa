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
  if (axios.isAxiosError(error)) {
    return `HTTP ${error.response?.status ?? error.code ?? 'network error'}`
  }
  return error instanceof Error ? error.message : 'Unknown API error'
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

let refreshSession: (() => Promise<boolean>) | undefined
let sessionRefresh: Promise<boolean> | undefined
let nextSessionAttempt = 0
export function setSessionRefresh(refresh: () => Promise<boolean>): void {
  refreshSession = refresh
}
api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || error.config === undefined) throw error
    const config = error.config as typeof error.config & {
      sessionRetried?: boolean
    }
    if (
      ![401, 403].includes(error.response?.status ?? 0) ||
      config.url === '/users/login' ||
      config.sessionRetried === true ||
      refreshSession === undefined
    )
      throw error
    config.sessionRetried = true
    if (sessionRefresh === undefined) {
      if (Date.now() < nextSessionAttempt)
        throw new Error('Cosa authentication temporarily unavailable')
      nextSessionAttempt = Date.now() + 60_000
      sessionRefresh = refreshSession().finally(() => {
        sessionRefresh = undefined
      })
    }
    if (!(await sessionRefresh)) throw new Error('Cosa session renewal failed')
    config.headers.set('authToken', api.defaults.headers.common['authToken'])
    return await api.request(config)
  }
)
