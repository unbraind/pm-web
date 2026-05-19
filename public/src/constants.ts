// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
import type { ProjectSchema } from './types.js';

// Fallback values — kept in sync with pm CLI builtins for offline resilience.
// The live schema is fetched from /api/projects/:id/pm/schema per project
// and injected via state.schema; use getTypes()/getStatuses() everywhere.
export const FALLBACK_TYPES = [
  'Task','Feature','Issue','Epic','Milestone','Decision','Chore','Event','Meeting','Reminder','Plan'
] as const;

export const FALLBACK_STATUSES = ['draft','open','in_progress','blocked','closed','canceled'] as const;

// Back-compat aliases (avoid widespread refactors, prefer getTypes/getStatuses)
export const TYPES = FALLBACK_TYPES;
export const STATUSES = FALLBACK_STATUSES;

export function getTypes(schema?: ProjectSchema | null): string[] {
  return schema?.types?.length ? schema.types : [...FALLBACK_TYPES];
}

export function getStatuses(schema?: ProjectSchema | null): string[] {
  return schema?.statuses?.length ? schema.statuses : [...FALLBACK_STATUSES];
}

export const TYPE_ICONS: Record<string, string> = {
  Task:'✓', Feature:'★', Issue:'⚠', Epic:'◈',
  Milestone:'⚑', Decision:'⚖', Chore:'⚙', Event:'◷', Meeting:'◉', Reminder:'◉', Plan:'◧'
};

export const PRIORITY_LABELS: Record<number, string> = {
  1:'Critical', 2:'High', 3:'Medium', 4:'Low', 5:'Minimal'
};

export const VIEW_NAMES = [
  'projects','items','create','activity','search','stats','calendar',
  'context','graph','sharing','groups','health','dedupe','validate','settings',
  'github','export','normalize','shared','templates','comments-audit','config','guide',
  'admin'
] as const;
