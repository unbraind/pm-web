// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

export const TYPES = ['Task','Feature','Issue','Epic','Milestone','Decision','Chore','Event','Meeting','Reminder'] as const;

export const STATUSES = ['draft','open','in_progress','blocked','closed','canceled'] as const;

export const TYPE_ICONS: Record<string, string> = {
  Task:'✓', Feature:'★', Issue:'⚠', Epic:'◈',
  Milestone:'⚑', Decision:'⚖', Chore:'⚙', Event:'◷', Meeting:'◉', Reminder:'◉'
};

export const PRIORITY_LABELS: Record<number, string> = {
  1:'Critical', 2:'High', 3:'Medium', 4:'Low', 5:'Minimal'
};

export const VIEW_NAMES = [
  'projects','items','create','activity','search','stats','calendar',
  'context','graph','sharing','groups','health','dedupe','validate','settings',
  'github','export','normalize','shared','templates','comments-audit','config','guide'
] as const;
