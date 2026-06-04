// ═══════════════════════════════════════════════════════════════
// ITEM FILTERS — URL-state (de)serialization
// ═══════════════════════════════════════════════════════════════
//
// Multi-dimension item filters (status / type / priority / sprint / release /
// assignee / tag) are mirrored into the URL query string so a filtered Items
// view is shareable and bookmarkable. These helpers are pure and dependency-
// free so they can be unit-tested without a DOM.
import type { ItemFilters } from './types.js';

export const EMPTY_FILTERS: ItemFilters = {
  status: '', type: '', priority: '', sprint: '', release: '', assignee: '', tag: '',
};

// Stable key order keeps generated URLs deterministic.
const FILTER_KEYS: (keyof ItemFilters)[] = [
  'status', 'type', 'priority', 'sprint', 'release', 'assignee', 'tag',
];

// Serialize active (non-empty) filters into a URLSearchParams. Empty values are
// omitted so the URL stays clean.
export function filtersToSearchParams(f: ItemFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = (f[key] ?? '').trim();
    if (value) params.set(key, value);
  }
  return params;
}

// Serialize filters to a query string (without the leading "?"), or "" when no
// filters are active.
export function filtersToQueryString(f: ItemFilters): string {
  return filtersToSearchParams(f).toString();
}

// Parse filters back out of a URLSearchParams (or query string). Unknown keys
// are ignored; missing keys default to empty.
export function filtersFromSearchParams(input: URLSearchParams | string): ItemFilters {
  const params = typeof input === 'string' ? new URLSearchParams(input) : input;
  const result: ItemFilters = { ...EMPTY_FILTERS };
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

// True when at least one dimension is set.
export function hasActiveFilters(f: ItemFilters): boolean {
  return FILTER_KEYS.some((key) => (f[key] ?? '').trim() !== '');
}
