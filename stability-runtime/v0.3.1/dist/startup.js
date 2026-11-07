export async function loadHomesWithRetry(deps) {
    while (!deps.stopped()) {
        try {
            if (await deps.login()) {
                const homes = await deps.getHomes();
                if (!deps.stopped() && homes.length > 0)
                    return homes;
            }
        }
        catch {
            // Transport failures are retried without exposing credentials or an empty bridge.
        }
        if (deps.stopped())
            return;
        deps.retry();
        await deps.wait();
    }
    return undefined;
}
//# sourceMappingURL=startup.js.map