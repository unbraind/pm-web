// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
import type { ProjectSchema } from './types.js';

/** Item-type names kept in sync with the pm CLI builtins, used as the
 * offline fallback when the live project schema is unavailable. Prefer
 * `getTypes()` everywhere so the fetched schema wins when present. */
export const FALLBACK_TYPES = [
  'Task','Feature','Issue','Epic','Milestone','Decision','Chore','Event','Meeting','Reminder','Plan'
] as const;

/** Lifecycle status names kept in sync with the pm CLI builtins, used as the
 * offline fallback when the live project schema is unavailable. Prefer
 * `getStatuses()` everywhere so the fetched schema wins when present. */
export const FALLBACK_STATUSES = ['draft','open','in_progress','blocked','closed','canceled'] as const;

/** Back-compat alias for `FALLBACK_TYPES`, retained to avoid a widespread
 * refactor; new code should call `getTypes()` instead. */
export const TYPES = FALLBACK_TYPES;
/** Back-compat alias for `FALLBACK_STATUSES`, retained to avoid a widespread
 * refactor; new code should call `getStatuses()` instead. */
export const STATUSES = FALLBACK_STATUSES;

/** Return the item types for a project, preferring the live `schema.types`
 * when non-empty and falling back to the built-in `FALLBACK_TYPES`. */
export function getTypes(schema?: ProjectSchema | null): string[] {
  return schema?.types?.length ? schema.types : [...FALLBACK_TYPES];
}

/** Return the lifecycle statuses for a project, preferring the live
 * `schema.statuses` when non-empty and falling back to the built-in
 * `FALLBACK_STATUSES`. */
export function getStatuses(schema?: ProjectSchema | null): string[] {
  return schema?.statuses?.length ? schema.statuses : [...FALLBACK_STATUSES];
}

/** Map of item-type name to the single-character glyph shown in the UI for
 * that type. */
export const TYPE_ICONS: Record<string, string> = {
  Task:'✓', Feature:'★', Issue:'⚠', Epic:'◈',
  Milestone:'⚑', Decision:'⚖', Chore:'⚙', Event:'◷', Meeting:'◉', Reminder:'◉', Plan:'◧'
};

/** Map of numeric priority (0–4) to its human-readable label, used for
 * tooltips and accessibility text on priority indicators. */
export const PRIORITY_LABELS: Record<number, string> = {
  0:'Critical', 1:'High', 2:'Medium', 3:'Low', 4:'Minimal'
};

/** Fixed list of navigation view identifiers in display order; mirrors the
 * routing keys accepted by the SPA router. */
export const VIEW_NAMES = [
  'projects','items','create','activity','search','stats','calendar',
  'context','graph','sharing','groups','health','dedupe','validate','settings',
  'github','export','normalize','shared','templates','packages','comments-audit','config','guide',
  'admin','plan'
] as const;
