# Stability notes

## 2026-11-07 audit fixes

API timeout, shared reads, retries and safe logging are now maintained in TypeScript source, and runtime overrides are generated from it. Axios logs contain only HTTP status/error code, never request bodies or response data. A 401/403 triggers one shared session renewal, bounded by a cooldown. Startup retries back off to 15 minutes.

HomeKit reads reject missing or >120-second-old cached state; valid cached values can be returned while one background refresh runs. Writes await acknowledgment and propagate errors. Debounced temperature writes settle their HomeKit promises only after the cloud request completes. Other temperature presets are read and preserved rather than overwritten with 5 degrees. UUID base and service types remain unchanged. Source installs build through prepare.

## 2026-11-08 Cosa outage repair

The first read after inactivity now waits for the shared refresh for up to two seconds. A single 60-second background refresh keeps all characteristics current even without HomeKit reads; humidity uses the same validated cache. Timers and pending debounced writes are disposed on shutdown. Heating target state is independent of the boiler's instantaneous on/off cycle. Cosa HTTP-200 code-104 session errors are normalized into the existing bounded shared login renewal. Explicit application-level failures reject writes. Regression tests cover inactivity, first-read recovery, response deadlines, scheduled boiler idle, and the real Cosa session response format.

## 2026-11-08 intermittent endpoint responses

The three-hour running log contained intermittent rejected endpoint reads; 15 independent diagnostic samples were valid, so their exact historical backend error code remains unconfirmed. Application rejection errors now retain only a safe numeric code. Endpoint reads retry a rejected or schema-invalid response once before reporting permanent failure; write application failures are not replayed. Schema diagnostics list field paths without payload values. Recovered read attempts no longer produce a terminal error; persistent failure remains an unavailable reading. Four regression tests cover read recovery, permanent failure, schema failure and safe diagnostics.
