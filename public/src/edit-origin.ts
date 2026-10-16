const localEdits = new Map<string, number>();

/** Bound local-echo suppression to item mutations, including older author-only watcher events. */
export function noteOwnItemEdit(path: string, now = Date.now()): void {
  const match = /\/projects\/([^/]+)\/pm\/(?:update|close|delete|comments|notes|append|learnings|claim|release|start-task|pause-task)\/([^/?]+)/.exec(path);
  if (!match) return;
  for (const [key, until] of localEdits) if (until <= now) localEdits.delete(key);
  localEdits.set(`${match[1]}:${match[2]}`, now + 5000);
}

/** A trusted different user id takes precedence over this short legacy-echo window. */
export function isRecentOwnItemEdit(projectId: string, itemId: string, now = Date.now()): boolean {
  return (localEdits.get(`${projectId}:${encodeURIComponent(itemId)}`) || 0) > now;
}
