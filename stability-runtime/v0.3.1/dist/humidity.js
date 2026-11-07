export function requireHumidity(value) {
    if (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 100) {
        throw new Error('Cosa humidity reading is unavailable');
    }
    return value;
}
//# sourceMappingURL=humidity.js.map