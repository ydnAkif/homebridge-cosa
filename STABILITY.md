# Stability notes

## 2026-11-07 audit fixes

API timeout, shared reads, retries and safe logging are now maintained in TypeScript source, and runtime overrides are generated from it. Axios logs contain only HTTP status/error code, never request bodies or response data. A 401/403 triggers one shared session renewal, bounded by a cooldown. Startup retries back off to 15 minutes.

HomeKit reads reject missing or >120-second-old cached state; valid cached values can be returned while one background refresh runs. Writes await acknowledgment and propagate errors. Debounced temperature writes settle their HomeKit promises only after the cloud request completes. Other temperature presets are read and preserved rather than overwritten with 5 degrees. UUID base and service types remain unchanged. Source installs build through prepare.

## 2026-11-08 Cosa outage repair

The first read after inactivity now waits for the shared refresh for up to two seconds. A single 60-second background refresh keeps all characteristics current even without HomeKit reads; humidity uses the same validated cache. Timers and pending debounced writes are disposed on shutdown. Heating target state is independent of the boiler's instantaneous on/off cycle. Cosa HTTP-200 code-104 session errors are normalized into the existing bounded shared login renewal. Explicit application-level failures reject writes. Regression tests cover inactivity, first-read recovery, response deadlines, scheduled boiler idle, and the real Cosa session response format.

## 2026-11-08 intermittent endpoint responses

The three-hour running log contained intermittent rejected endpoint reads; 15 independent diagnostic samples were valid, so their exact historical backend error code remains unconfirmed. Application rejection errors now retain only a safe numeric code. Endpoint reads retry a rejected or schema-invalid response once before reporting permanent failure; write application failures are not replayed. Schema diagnostics list field paths without payload values. Recovered read attempts no longer produce a terminal error; persistent failure remains an unavailable reading. Four regression tests cover read recovery, permanent failure, schema failure and safe diagnostics.

## 2026-11-08 confirmed backend database failure

A separate live read captured code 100 with E_UNKNOWN and a MongoDB FailedToParse error: the Cosa backend sent an unsupported admin field in a database query. An immediate retry over a fresh TLS connection succeeded. This establishes a Cosa backend error, not a Pi resource or credential failure. The existing single read retry now uses a non-keepalive agent, so it cannot reuse the failed connection. This is a client mitigation, not a repair of Cosa's database server; persistent failures still reject and writes are unchanged. A fixed diagnostic category identifies this exact backend error without exposing the raw query, server message, account IDs or credentials. Terminal read errors no longer log the home ID.

## 2026-11-08 partial boiler-state responses

The running .7 process received two reads with an invalid or missing combiState during 14:35; subsequent reads recovered. The exact historical value was not retained. Missing, null, unknown or malformed boiler states now remain unavailable instead of rejecting independently valid temperature, target and humidity measurements. Only exact on/off values are mapped to HomeKit heating states; unavailable state raises communication failure for that characteristic, never a fabricated OFF. State loss is logged once per transition with only the received value type; raw values and account identifiers are excluded. Recovery resumes the actual heating state automatically. Core temperature fields remain strictly validated. The code-100 backend mitigation and write behavior are unchanged; Cosa's backend can still fail both bounded attempts.
