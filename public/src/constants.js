// Fallback values — kept in sync with pm CLI builtins for offline resilience.
// The live schema is fetched from /api/projects/:id/pm/schema per project
// and injected via state.schema; use getTypes()/getStatuses() everywhere.
export const FALLBACK_TYPES = [
    'Task', 'Feature', 'Issue', 'Epic', 'Milestone', 'Decision', 'Chore', 'Event', 'Meeting', 'Reminder', 'Plan'
];
export const FALLBACK_STATUSES = ['draft', 'open', 'in_progress', 'blocked', 'closed', 'canceled'];
// Back-compat aliases (avoid widespread refactors, prefer getTypes/getStatuses)
export const TYPES = FALLBACK_TYPES;
export const STATUSES = FALLBACK_STATUSES;
export function getTypes(schema) {
    return schema?.types?.length ? schema.types : [...FALLBACK_TYPES];
}
export function getStatuses(schema) {
    return schema?.statuses?.length ? schema.statuses : [...FALLBACK_STATUSES];
}
export const TYPE_ICONS = {
    Task: '✓', Feature: '★', Issue: '⚠', Epic: '◈',
    Milestone: '⚑', Decision: '⚖', Chore: '⚙', Event: '◷', Meeting: '◉', Reminder: '◉', Plan: '◧'
};
export const PRIORITY_LABELS = {
    0: 'Critical', 1: 'High', 2: 'Medium', 3: 'Low', 4: 'Minimal'
};
export const VIEW_NAMES = [
    'projects', 'items', 'create', 'activity', 'search', 'stats', 'calendar',
    'context', 'graph', 'sharing', 'groups', 'health', 'dedupe', 'validate', 'settings',
    'github', 'export', 'normalize', 'shared', 'templates', 'comments-audit', 'config', 'guide',
    'admin', 'plan'
];
//# sourceMappingURL=constants.js.map