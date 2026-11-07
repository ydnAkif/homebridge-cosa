export function requireHumidity(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new Error('Cosa humidity reading is unavailable')
  }
  return value
}
