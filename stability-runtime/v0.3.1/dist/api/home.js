import { api, CosaApiError, logApiError, logApiWarn } from './index.js';
import { requireHumidity } from '../humidity.js';
import { z } from 'zod';
const HomeSchema = z.object({
    combiState: z.enum(['on', 'off']),
    option: z.string().optional(),
    temperature: z.number().finite(),
    targetTemperature: z.number().finite(),
    homeTemperature: z.number().finite().optional(),
    awayTemperature: z.number().finite().optional(),
    sleepTemperature: z.number().finite().optional(),
    customTemperature: z.number().finite().optional(),
    humidity: z.number().optional()
});
const HomeResponseSchema = z.object({
    endpoint: HomeSchema
});
const HomeListSchema = z.array(z.object({
    id: z.string(),
    name: z.string()
}));
class EndpointResponseError extends Error {
    constructor(fields) {
        super(`Invalid Cosa endpoint fields: ${fields.join(', ')}`);
        this.name = 'EndpointResponseError';
    }
}
const HOME_CACHE_TTL_MS = 30_000;
const READ_RETRY_COUNT = 2;
const READ_RETRY_DELAY_MS = 1_000;
const WRITE_RETRY_COUNT = 2;
const WRITE_RETRY_DELAY_MS = 800;
const homeCache = new Map();
const inFlightHomeRequests = new Map();
async function wait(ms) {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function isRetryableNetworkError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    const errorCode = error.code;
    return (error.message.includes('timeout') ||
        error.message.includes('socket hang up') ||
        errorCode === 'ECONNABORTED' ||
        errorCode === 'ECONNRESET' ||
        errorCode === 'ETIMEDOUT' ||
        errorCode === 'EAI_AGAIN');
}
async function runWriteWithRetry({ operation, context }) {
    for (let attempt = 1; attempt <= WRITE_RETRY_COUNT; attempt++) {
        try {
            await operation();
            return;
        }
        catch (error) {
            const isLastAttempt = attempt === WRITE_RETRY_COUNT;
            if (!isLastAttempt && isRetryableNetworkError(error)) {
                logApiWarn(`${context} timed out on attempt ${attempt}/${WRITE_RETRY_COUNT}, retrying.`);
                await wait(WRITE_RETRY_DELAY_MS);
                continue;
            }
            logApiError(`${context} failed on attempt ${attempt}/${WRITE_RETRY_COUNT}`, error);
            throw new Error('Cosa write failed');
        }
    }
}
const HomeListResponseSchema = z.object({
    endpoints: HomeListSchema
});
export async function getHomeList() {
    try {
        const response = await api.get('/endpoints/getEndpoints');
        const parsedResponse = HomeListResponseSchema.safeParse(response.data);
        if (parsedResponse.success) {
            return parsedResponse.data.endpoints;
        }
        logApiWarn('getEndpoints response did not match expected schema.');
        return [];
    }
    catch (error) {
        logApiError('getEndpoints request failed', error);
        return [];
    }
}
export async function getHome({ homeId, forceRefresh = false }) {
    if (!forceRefresh) {
        const cachedValue = homeCache.get(homeId);
        if (cachedValue !== undefined &&
            Date.now() - cachedValue.fetchedAt < HOME_CACHE_TTL_MS) {
            return cachedValue.value;
        }
    }
    const existingRequest = inFlightHomeRequests.get(homeId);
    if (existingRequest !== undefined) {
        return await existingRequest;
    }
    const request = (async () => {
        for (let attempt = 1; attempt <= READ_RETRY_COUNT; attempt++) {
            try {
                const response = await api.post('/endpoints/getEndpoint', {
                    endpoint: homeId
                });
                const parsedResponse = HomeResponseSchema.safeParse(response.data);
                if (parsedResponse.success) {
                    homeCache.set(homeId, {
                        value: parsedResponse.data.endpoint,
                        fetchedAt: Date.now()
                    });
                    return parsedResponse.data.endpoint;
                }
                throw new EndpointResponseError(parsedResponse.error.issues.map((issue) => issue.path.join('.')));
            }
            catch (error) {
                const isLastAttempt = attempt === READ_RETRY_COUNT;
                // This is a read-only operation: retry a rejected or incomplete response
                // once before treating the cloud read as unavailable. Writes keep their
                // stricter retry policy and are never replayed for application errors.
                if (!isLastAttempt &&
                    (isRetryableNetworkError(error) ||
                        error instanceof CosaApiError ||
                        error instanceof EndpointResponseError)) {
                    const reason = error instanceof CosaApiError ||
                        error instanceof EndpointResponseError
                        ? error.message
                        : 'temporary network error';
                    logApiWarn(`getEndpoint: ${reason}; retrying once.`);
                    await wait(READ_RETRY_DELAY_MS);
                    continue;
                }
                logApiError(`getEndpoint request failed for homeId=${homeId} on attempt ${attempt}/${READ_RETRY_COUNT}`, error);
                return null;
            }
        }
        return null;
    })();
    inFlightHomeRequests.set(homeId, request);
    try {
        return await request;
    }
    finally {
        inFlightHomeRequests.delete(homeId);
    }
}
export async function getCurrentTemperature({ homeId }) {
    const house = await getHome({
        homeId
    });
    if (house !== null) {
        return house.temperature;
    }
    throw new Error('Cosa measurement unavailable');
}
export async function getCurrentHeatingState({ homeId }) {
    const house = await getHome({
        homeId
    });
    if (house === null)
        throw new Error('Cosa state unavailable');
    return house.combiState === 'on';
}
export async function getTargetTemperature({ homeId }) {
    const house = await getHome({
        homeId
    });
    if (house !== null) {
        return house.targetTemperature;
    }
    throw new Error('Cosa measurement unavailable');
}
export async function setTargetTemperature({ homeId, targetTemperature }) {
    // Read the device's other presets instead of resetting them to 5 degrees.
    const home = await getHome({ homeId, forceRefresh: true });
    if (home === null ||
        [
            home.homeTemperature,
            home.awayTemperature,
            home.sleepTemperature,
            home.customTemperature
        ].some((value) => value === undefined)) {
        throw new Error('Cosa target presets unavailable; refusing to overwrite them');
    }
    await runWriteWithRetry({
        context: `setTargetTemperatures request for homeId=${homeId}, targetTemperature=${targetTemperature}`,
        operation: async () => {
            await api.post(`/endpoints/setTargetTemperatures`, {
                endpoint: homeId,
                targetTemperatures: {
                    away: home.awayTemperature,
                    sleep: home.sleepTemperature,
                    custom: home.customTemperature,
                    home: targetTemperature
                }
            });
        }
    });
    homeCache.delete(homeId);
}
export async function setTargetHeatingState({ homeId, targetState }) {
    await runWriteWithRetry({
        context: `setMode request for homeId=${homeId}, targetState=${targetState}`,
        operation: async () => {
            await api.post(`/endpoints/setMode`, {
                endpoint: homeId,
                mode: 'manual',
                option: targetState === 'off' ? 'frozen' : 'home'
            });
        }
    });
    homeCache.delete(homeId);
}
export async function getCurrentHumidity({ homeId }) {
    return requireHumidity((await getHome({ homeId }))?.humidity);
}
//# sourceMappingURL=home.js.map