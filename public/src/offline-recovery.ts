/**
 * Show preserved offline work and offer adoption only for records without an
 * owner. Unknown outcomes and repeated failures require explicit owner action;
 * retry warns that a new request can duplicate an earlier unknown commit.
 * Account changes invalidate callbacks in the bridge. Dismissal preserves work.
 */
export function showOfflineRecovery(
  blocked: unknown[],
  userId: string | null,
  adopt: (ids: number[], ownerId: string) => void,
  actions: { recover: (id: number, ownerId: string, action: 'retry-new' | 'discard') => void; dismiss: () => void },
): HTMLElement {
  const notice = document.createElement('div');
  notice.id = 'offline-recovery';
  notice.className = 'offline-recovery';
  notice.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:1000;max-width:min(460px,calc(100vw - 40px));max-height:60vh;overflow:auto;overflow-wrap:anywhere;padding:16px;border:1px solid var(--accent,#2dd4bf);border-radius:8px;background:var(--bg-card,#0f172a);color:var(--text-primary,#f1f5f9);box-shadow:0 4px 20px #0004';
  notice.setAttribute('role', 'status');
  const description = document.createElement('p');
  description.textContent = 'Some offline changes need attention. Later changes in the same workspace wait; independent workspaces can continue. Review the original result before retrying an unknown outcome, as a new request may duplicate a committed change. Sign in to the original account; adopt unknown-owner changes only if they are yours.';
  const list = document.createElement('ul');
  const unknownIds: number[] = [];
  for (const value of blocked) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as { id?: unknown; method?: unknown; path?: unknown; reason?: unknown; ownerId?: unknown };
    const item = document.createElement('li');
    item.textContent = `${String(record.method ?? '')} ${String(record.path ?? '')} (${String(record.reason ?? '')})`;
    list.append(item);
    if (record.reason === 'unknown-owner' && typeof record.id === 'number' && Number.isSafeInteger(record.id)) {
      unknownIds.push(record.id);
    }
    if ((record.reason === 'outcome-unknown' || record.reason === 'repeated-5xx')
      && typeof record.id === 'number' && Number.isSafeInteger(record.id) && userId !== null && record.ownerId === userId) {
      const id = record.id;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-primary';
      retry.textContent = 'Retry as a new request';
      retry.onclick = () => {
        if (confirm('The original request may already have committed. Retrying with a new key can duplicate it. Retry as a new request?')) {
          actions.recover(id, userId, 'retry-new');
        }
      };
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'btn';
      discard.textContent = 'Discard';
      discard.onclick = () => { actions.recover(id, userId, 'discard'); };
      item.append(retry, discard);
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
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss offline recovery notice');
  dismiss.onclick = () => { notice.remove(); actions.dismiss(); };
  notice.append(dismiss);
  document.body.append(notice);
  return notice;
}
