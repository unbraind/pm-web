const localEdits = new Map<string, { until: number }>();

/** Bound local-echo suppression to item mutations, including older author-only watcher events. */
export function noteOwnItemEdit(path: string, now = Date.now()): (() => void) | undefined {
  const match = /\/projects\/([^/]+)\/pm\/(?:update|close|delete|comments|notes|append|learnings|claim|release|start-task|pause-task)\/([^/?]+)/.exec(path);
  if (!match) return;
  for (const [key, marker] of localEdits) if (marker.until <= now) localEdits.delete(key);
  const key = `${match[1]}:${match[2]}`;
  const marker = { until: now + 5000 };
  localEdits.set(key, marker);
  return () => {
    if (localEdits.get(key) === marker) localEdits.delete(key);
  };
}

/** A trusted different user id takes precedence over this short legacy-echo window. */
export function isRecentOwnItemEdit(projectId: string, itemId: string, now = Date.now()): boolean {
  return (localEdits.get(`${projectId}:${encodeURIComponent(itemId)}`)?.until || 0) > now;
}
