/** Active-project-only invalidations; no map entries are allocated for unwatched projects. */
const listeners = new Map<string, Set<() => void>>();

/** Register one active replay loop and release its callback when it stops or restarts. */
export function onMutationReadSignal(projectId: string, listener: () => void): () => void {
  let set = listeners.get(projectId);
  if (!set) { set = new Set(); listeners.set(projectId, set); }
  set.add(listener);
  return () => { set.delete(listener); if (set.size === 0) listeners.delete(projectId); };
}

/** Force the next poll after an HTTP write or a validated cross-instance notification. */
export function signalMutationRead(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener();
}
