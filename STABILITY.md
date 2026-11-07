# Stability notes

## 2026-11-07 audit fixes

API timeout, shared reads, retries and safe logging are now maintained in TypeScript source, and runtime overrides are generated from it. Axios logs contain only HTTP status/error code, never request bodies or response data. A 401/403 triggers one shared session renewal, bounded by a cooldown. Startup retries back off to 15 minutes.

HomeKit reads reject missing or >120-second-old cached state; valid cached values can be returned while one background refresh runs. Writes await acknowledgment and propagate errors. Debounced temperature writes settle their HomeKit promises only after the cloud request completes. Other temperature presets are read and preserved rather than overwritten with 5 degrees. UUID base and service types remain unchanged. Source installs build through prepare.
