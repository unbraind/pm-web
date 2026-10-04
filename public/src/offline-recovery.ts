/**
 * Show preserved offline work and offer adoption only for records without an
 * owner. Clicking explicitly asserts that the listed work belongs to this
 * signed-in account. Account changes invalidate the callback in the bridge.
 */
export function showOfflineRecovery(
  blocked: unknown[],
  userId: string | null,
  adopt: (ids: number[], ownerId: string) => void,
): HTMLElement {
  const notice = document.createElement('div');
  notice.id = 'offline-recovery';
  notice.className = 'offline-recovery';
  notice.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:1000;max-width:min(460px,calc(100vw - 40px));max-height:60vh;overflow:auto;overflow-wrap:anywhere;padding:16px;border:1px solid var(--accent,#2dd4bf);border-radius:8px;background:var(--bg-card,#0f172a);color:var(--text-primary,#f1f5f9);box-shadow:0 4px 20px #0004';
  notice.setAttribute('role', 'status');
  const description = document.createElement('p');
  description.textContent = 'Some offline changes are blocked. Sign in to their original account to replay them. Unknown-owner changes can be adopted only if they are yours.';
  const list = document.createElement('ul');
  const unknownIds: number[] = [];
  for (const value of blocked) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as { id?: unknown; method?: unknown; path?: unknown; reason?: unknown };
    const item = document.createElement('li');
    item.textContent = `${String(record.method ?? '')} ${String(record.path ?? '')} (${String(record.reason ?? '')})`;
    list.append(item);
    if (record.reason === 'unknown-owner' && typeof record.id === 'number' && Number.isSafeInteger(record.id)) {
      unknownIds.push(record.id);
    }
  }
  notice.append(description, list);
  if (userId !== null && unknownIds.length > 0) {
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.textContent = 'These changes are mine — adopt for my signed-in account';
    button.onclick = () => { adopt(unknownIds, userId); };
    notice.append(button);
  }
  document.body.append(notice);
  return notice;
}
