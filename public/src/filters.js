export const EMPTY_FILTERS = {
    status: '', type: '', priority: '', sprint: '', release: '', assignee: '', tag: '',
};
// Stable key order keeps generated URLs deterministic.
const FILTER_KEYS = [
    'status', 'type', 'priority', 'sprint', 'release', 'assignee', 'tag',
];
// Serialize active (non-empty) filters into a URLSearchParams. Empty values are
// omitted so the URL stays clean.
export function filtersToSearchParams(f) {
    const params = new URLSearchParams();
    for (const key of FILTER_KEYS) {
        const value = (f[key] ?? '').trim();
        if (value)
            params.set(key, value);
    }
    return params;
}
// Serialize filters to a query string (without the leading "?"), or "" when no
// filters are active.
export function filtersToQueryString(f) {
    return filtersToSearchParams(f).toString();
}
// Parse filters back out of a URLSearchParams (or query string). Unknown keys
// are ignored; missing keys default to empty.
export function filtersFromSearchParams(input) {
    const params = typeof input === 'string' ? new URLSearchParams(input) : input;
    const result = { ...EMPTY_FILTERS };
    for (const key of FILTER_KEYS) {
        const value = params.get(key);
        if (value !== null)
            result[key] = value;
    }
    return result;
}
// True when at least one dimension is set.
export function hasActiveFilters(f) {
    return FILTER_KEYS.some((key) => (f[key] ?? '').trim() !== '');
}
//# sourceMappingURL=filters.js.map