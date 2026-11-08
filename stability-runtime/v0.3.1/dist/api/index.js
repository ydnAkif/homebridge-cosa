import axios, { AxiosError } from 'axios';
const API_BASE_URL = 'https://kiwi.cosa.com.tr/api';
const API_TIMEOUT_MS = 15_000;
let apiLogger;
export function setApiLogger(logger) {
    apiLogger = logger;
}
function getErrorMessage(error) {
    if (axios.isAxiosError(error)) {
        return `HTTP ${error.response?.status ?? error.code ?? 'network error'}`;
    }
    return error instanceof Error ? error.message : 'Unknown API error';
}
export function logApiError(context, error) {
    const message = `[Cosa API] ${context}: ${getErrorMessage(error)}`;
    if (apiLogger !== undefined) {
        apiLogger('error', message);
        return;
    }
    // eslint-disable-next-line no-console
    console.error(message);
}
export function logApiWarn(message) {
    const formattedMessage = `[Cosa API] ${message}`;
    if (apiLogger !== undefined) {
        apiLogger('warn', formattedMessage);
        return;
    }
    // eslint-disable-next-line no-console
    console.warn(formattedMessage);
}
export const api = axios.create({
    baseURL: API_BASE_URL,
    timeout: API_TIMEOUT_MS,
    headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
    }
});
export class CosaApiError extends Error {
    constructor(code, backendDatabaseFailure = false) {
        const safeCode = typeof code === 'number' && Number.isFinite(code)
            ? String(code)
            : typeof code === 'string' && /^-?\d{1,8}$/.test(code)
                ? code
                : 'unknown';
        super(`Cosa API rejected the request (code ${safeCode})${backendDatabaseFailure ? ': backend database query failed' : ''}`);
        this.name = 'CosaApiError';
    }
}
// Cosa reports an expired token as HTTP 200 with code 104.
// Normalize it before the shared auth retry interceptor, without logging its body.
api.interceptors.response.use((response) => {
    const data = response.data;
    if (typeof data === 'object' &&
        data !== null &&
        'code' in data &&
        String(data.code) === '104' &&
        response.config.url !== '/users/login') {
        throw new AxiosError('Cosa session expired', 'ERR_BAD_RESPONSE', response.config, response.request, { ...response, status: 401 });
    }
    if (typeof data === 'object' &&
        data !== null &&
        'ok' in data &&
        (data.ok === false || data.ok === 0)) {
        const details = 'error' in data ? data.error : undefined;
        const raw = typeof details === 'object' && details !== null && 'raw' in details
            ? details.raw
            : undefined;
        const backendDatabaseFailure = 'code' in data &&
            String(data.code) === '100' &&
            typeof raw === 'object' &&
            raw !== null &&
            'name' in raw &&
            raw.name === 'MongoError' &&
            'code' in raw &&
            raw.code === 9;
        // Only emit a fixed category. Never copy server messages or database queries.
        throw new CosaApiError('code' in data ? data.code : undefined, backendDatabaseFailure);
    }
    return response;
});
let refreshSession;
let sessionRefresh;
let nextSessionAttempt = 0;
export function setSessionRefresh(refresh) {
    refreshSession = refresh;
}
api.interceptors.response.use((response) => response, async (error) => {
    if (!axios.isAxiosError(error) || error.config === undefined)
        throw error;
    const config = error.config;
    if (![401, 403].includes(error.response?.status ?? 0) ||
        config.url === '/users/login' ||
        config.sessionRetried === true ||
        refreshSession === undefined)
        throw error;
    config.sessionRetried = true;
    if (sessionRefresh === undefined) {
        if (Date.now() < nextSessionAttempt)
            throw new Error('Cosa authentication temporarily unavailable');
        nextSessionAttempt = Date.now() + 60_000;
        sessionRefresh = refreshSession().finally(() => {
            sessionRefresh = undefined;
        });
    }
    if (!(await sessionRefresh))
        throw new Error('Cosa session renewal failed');
    config.headers.set('authToken', api.defaults.headers.common['authToken']);
    return await api.request(config);
});
//# sourceMappingURL=index.js.map