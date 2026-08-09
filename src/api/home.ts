import { api, logApiError, logApiWarn } from './index.js'
import { z } from 'zod'

const HomeSchema = z.object({
  combiState: z.enum(['on', 'off']),
  temperature: z.number(),
  targetTemperature: z.number(),
  humidity: z.number().optional()
})

const HomeResponseSchema = z.object({
  endpoint: HomeSchema
})

const HomeListSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string()
  })
)

type HomeType = z.infer<typeof HomeSchema>
type HomeListType = z.infer<typeof HomeListSchema>

const HOME_CACHE_TTL_MS = 30_000
const READ_RETRY_COUNT = 2
const READ_RETRY_DELAY_MS = 1_000
const WRITE_RETRY_COUNT = 2
const WRITE_RETRY_DELAY_MS = 800

const homeCache = new Map<
  string,
  {
    value: HomeType
    fetchedAt: number
  }
>()
const inFlightHomeRequests = new Map<string, Promise<HomeType | null>>()

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const errorCode = (error as Error & { code?: string }).code

  return (
    error.message.includes('timeout') ||
    error.message.includes('socket hang up') ||
    errorCode === 'ECONNABORTED' ||
    errorCode === 'ECONNRESET' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'EAI_AGAIN'
  )
}

async function runWriteWithRetry({
  operation,
  context
}: {
  operation: () => Promise<void>
  context: string
}): Promise<void> {
  for (let attempt = 1; attempt <= WRITE_RETRY_COUNT; attempt++) {
    try {
      await operation()
      return
    } catch (error) {
      const isLastAttempt = attempt === WRITE_RETRY_COUNT

      if (!isLastAttempt && isRetryableNetworkError(error)) {
        logApiWarn(
          `${context} timed out on attempt ${attempt}/${WRITE_RETRY_COUNT}, retrying.`
        )
        await wait(WRITE_RETRY_DELAY_MS)
        continue
      }

      logApiError(
        `${context} failed on attempt ${attempt}/${WRITE_RETRY_COUNT}`,
        error
      )
      return
    }
  }
}

const HomeListResponseSchema = z.object({
  endpoints: HomeListSchema
})

export async function getHomeList(): Promise<HomeListType> {
  try {
    const response = await api.get('/endpoints/getEndpoints')

    const parsedResponse = HomeListResponseSchema.safeParse(response.data)

    if (parsedResponse.success) {
      return parsedResponse.data.endpoints
    }

    logApiWarn('getEndpoints response did not match expected schema.')

    return []
  } catch (error) {
    logApiError('getEndpoints request failed', error)

    return []
  }
}

export async function getHome({
  homeId,
  forceRefresh = false
}: {
  homeId: string
  forceRefresh?: boolean
}): Promise<HomeType | null> {
  if (!forceRefresh) {
    const cachedValue = homeCache.get(homeId)

    if (
      cachedValue !== undefined &&
      Date.now() - cachedValue.fetchedAt < HOME_CACHE_TTL_MS
    ) {
      return cachedValue.value
    }
  }

  const existingRequest = inFlightHomeRequests.get(homeId)

  if (existingRequest !== undefined) {
    return await existingRequest
  }

  const request = (async (): Promise<HomeType | null> => {
    for (let attempt = 1; attempt <= READ_RETRY_COUNT; attempt++) {
      try {
        const response = await api.post('/endpoints/getEndpoint', {
          endpoint: homeId
        })

        const parsedResponse = HomeResponseSchema.safeParse(response.data)

        if (parsedResponse.success) {
          homeCache.set(homeId, {
            value: parsedResponse.data.endpoint,
            fetchedAt: Date.now()
          })
          return parsedResponse.data.endpoint
        }

        logApiWarn(
          `getEndpoint response did not match expected schema for homeId=${homeId}.`
        )
        return null
      } catch (error) {
        const isLastAttempt = attempt === READ_RETRY_COUNT

        if (!isLastAttempt && isRetryableNetworkError(error)) {
          logApiWarn(
            `getEndpoint request for homeId=${homeId} failed on attempt ${attempt}/${READ_RETRY_COUNT}, retrying.`
          )
          await wait(READ_RETRY_DELAY_MS)
          continue
        }

        logApiError(
          `getEndpoint request failed for homeId=${homeId} on attempt ${attempt}/${READ_RETRY_COUNT}`,
          error
        )
        return null
      }
    }

    return null
  })()

  inFlightHomeRequests.set(homeId, request)

  try {
    return await request
  } finally {
    inFlightHomeRequests.delete(homeId)
  }
}

export async function getCurrentTemperature({
  homeId
}: {
  homeId: string
}): Promise<number> {
  const house = await getHome({
    homeId
  })

  if (house !== null) {
    return house.temperature
  }

  return 5
}

export async function getCurrentHeatingState({
  homeId
}: {
  homeId: string
}): Promise<boolean> {
  const house = await getHome({
    homeId
  })

  return house?.combiState === 'on'
}

export async function getTargetTemperature({
  homeId
}: {
  homeId: string
}): Promise<number> {
  const house = await getHome({
    homeId
  })

  if (house !== null) {
    return house.targetTemperature
  }

  return 5
}

export async function setTargetTemperature({
  homeId,
  targetTemperature
}: {
  homeId: string
  targetTemperature: number
}): Promise<void> {
  const cachedHome = homeCache.get(homeId)

  if (cachedHome !== undefined) {
    homeCache.set(homeId, {
      value: {
        ...cachedHome.value,
        targetTemperature
      },
      fetchedAt: Date.now()
    })
  }

  await runWriteWithRetry({
    context: `setTargetTemperatures request for homeId=${homeId}, targetTemperature=${targetTemperature}`,
    operation: async () => {
      await api.post(`/endpoints/setTargetTemperatures`, {
        endpoint: homeId,
        targetTemperatures: {
          home: targetTemperature,
          away: 5,
          sleep: 5,
          custom: 5
        }
      })
    }
  })
}

export async function setTargetHeatingState({
  homeId,
  targetState
}: {
  homeId: string
  targetState: string
}): Promise<void> {
  const cachedHome = homeCache.get(homeId)

  if (cachedHome !== undefined) {
    homeCache.set(homeId, {
      value: {
        ...cachedHome.value,
        combiState: targetState === 'off' ? 'off' : 'on'
      },
      fetchedAt: Date.now()
    })
  }

  await runWriteWithRetry({
    context: `setMode request for homeId=${homeId}, targetState=${targetState}`,
    operation: async () => {
      await api.post(`/endpoints/setMode`, {
        endpoint: homeId,
        mode: 'manual',
        option: targetState === 'off' ? 'frozen' : 'home'
      })
    }
  })
}

export async function getCurrentHumidity({
  homeId
}: {
  homeId: string
}): Promise<number> {
  const house = await getHome({
    homeId
  })

  if (house?.humidity !== undefined) {
    return house.humidity
  }

  return 0
}
