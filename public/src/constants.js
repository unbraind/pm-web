// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
export const TYPES = ['Task', 'Feature', 'Issue', 'Epic', 'Milestone', 'Decision', 'Chore', 'Event', 'Meeting', 'Reminder'];
export const STATUSES = ['draft', 'open', 'in_progress', 'blocked', 'closed', 'canceled'];
export const TYPE_ICONS = {
    Task: '✓', Feature: '★', Issue: '⚠', Epic: '◈',
    Milestone: '⚑', Decision: '⚖', Chore: '⚙', Event: '◷', Meeting: '◉', Reminder: '◉'
};
export const PRIORITY_LABELS = {
    1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Minimal'
};
export const VIEW_NAMES = [
    'projects', 'items', 'create', 'activity', 'search', 'stats', 'calendar',
    'context', 'graph', 'sharing', 'groups', 'health', 'dedupe', 'validate', 'settings',
    'github', 'export', 'normalize', 'shared', 'templates', 'comments-audit', 'config', 'guide',
    'admin'
];
//# sourceMappingURL=constants.js.map