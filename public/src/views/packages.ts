// ═══════════════════════════════════════════════════════════════
// PACKAGES VIEW — per-project pm package catalog
// ═══════════════════════════════════════════════════════════════
//
// Lists every pm package from the server-side catalog
// (src/services/package-catalog.ts, surfaced via
// GET /api/projects/:projectId/extensions) with install/enable/disable
// controls, the currently installed version, and an honest explanation for
// packages that need credentials or a backing service. Mutations go through
// the extensions routes, which validate the package name against the catalog
// before any pm command is spawned, and broadcast on the existing realtime bus
// so every collaborator on the project sees the change live.
//
// User-facing strings are wired into the i18n system (public/src/i18n.ts):
// the `packages.*` keys live in every shipped locale catalog, and the view
// re-renders translations on locale change via applyTranslations().

import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { t, applyTranslations } from '../i18n.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PackageRow {
  name: string;
  npmSpec: string;
  title: string;
  description: string;
  capabilities: string[];
  requiresService?: { name: string; optional?: boolean };
  requiresCredentials?: Array<{ label: string; envVars: string[]; optional?: boolean }>;
  installed: boolean;
  version: string | null;
  active: boolean;
  enabled: boolean;
  runtimeActive: boolean;
  activationStatus: string | null;
  managed: boolean;
  sourceKind: string | null;
}

let currentPackages: PackageRow[] = [];

/**
 * Monotonic token for in-flight package fetches.
 *
 * A fetch started for one project can resolve *after* the user switches
 * project or after a newer refresh, and would then paint stale cards into the
 * new container — cards whose action buttons submit against the *current*
 * project id. Each fetch captures the token it started with and discards its
 * own response if a newer fetch has begun since.
 */
let packagesFetchToken = 0;

export async function renderPackagesView(): Promise<void> {
  ensureActionsWired();
  const el = document.getElementById('content-packages');
  if (!el) return;
  if (!state.currentProject) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-text">${escHtml(t('packages.noProject'))}</div></div>`;
    return;
  }
  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="packages.title">Packages</div>
        <div class="page-subtitle">${escHtml(t('packages.subtitle', { project: state.currentProject.name }))}</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" id="packages-refresh" onclick="window.__app.renderPackagesView()">${escHtml(t('packages.refresh'))}</button>
      </div>
    </div>
    <div id="packages-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
  await fetchAndRenderPackages();
}

async function fetchAndRenderPackages(): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const target = document.getElementById('packages-content');
  if (!target) return;
  const token = ++packagesFetchToken;
  /** True when a newer fetch started, or the project changed, while awaiting. */
  const superseded = (): boolean => token !== packagesFetchToken || state.currentProject?.id !== pid;
  try {
    const data = await api('GET', `/projects/${pid}/extensions`);
    if (superseded()) return;
    const rows: PackageRow[] = (data as { packages?: PackageRow[] }).packages ?? [];
    currentPackages = rows;
    if (rows.length === 0) {
      target.innerHTML = `<div class="empty-state"><div class="empty-state-text">${escHtml(t('packages.empty'))}</div></div>`;
      return;
    }
    target.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
        ${rows.map((row) => renderPackageCard(row)).join('')}
      </div>`;
    applyTranslations(target);
  } catch (err: unknown) {
    if (superseded()) return;
    const msg = err instanceof Error ? err.message : String(err);
    target.innerHTML = `<div class="empty-state"><div class="empty-state-text">${escHtml(t('packages.loadError', { error: msg }))}</div></div>`;
  }
}

function renderPackageCard(row: PackageRow): string {
  const statusChip = row.installed
    ? `<span style="font-size:11px;color:var(--text-muted);background:var(--bg-input);padding:2px 8px;border-radius:4px">${escHtml(t('packages.installed'))}${row.version ? ' · ' + escHtml(t('packages.version', { version: row.version })) : ''}</span>`
    : `<span style="font-size:11px;color:var(--text-muted);background:var(--bg-input);padding:2px 8px;border-radius:4px">${escHtml(t('packages.notInstalled'))}</span>`;

  // Honest gating explanations — the UI must not promise a one-click install
  // for a package that needs a Neo4j instance or an API token.
  const serviceNote = row.requiresService
    ? row.requiresService.optional
      ? `<div class="pkg-req" style="font-size:12px;color:var(--text-secondary);margin-top:6px">⚠ ${escHtml(t('packages.requiresServiceOptional', { name: row.requiresService.name }))}</div>`
      : `<div class="pkg-req" style="font-size:12px;color:var(--text-secondary);margin-top:6px">⚠ ${escHtml(t('packages.requiresService', { name: row.requiresService.name }))}</div>`
    : '';
  const credNotes = (row.requiresCredentials ?? []).map((c) => {
    const label = c.optional ? t('packages.requiresCredentialsOptional') : t('packages.requiresCredentials');
    const envs = c.envVars.map((e) => `<code style="font-family:var(--font-mono);background:var(--bg-input);padding:1px 4px;border-radius:3px">${escHtml(e)}</code>`).join(' ');
    return `<div class="pkg-req" style="font-size:12px;color:var(--text-secondary);margin-top:4px">🔑 ${escHtml(label)} — ${escHtml(c.label)}<br><span style="color:var(--text-muted)">${escHtml(t('packages.envVars'))}: ${envs}</span></div>`;
  }).join('');

  const caps = row.capabilities.length
    ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px">${escHtml(t('packages.capabilities'))}: ${row.capabilities.map((c) => escHtml(c)).join(', ')}</div>`
    : '';

  // Action buttons. The name is read from the row's catalog `name`, never from
  // a raw DOM string — and the server validates it against the catalog again
  // before any pm command is spawned.
  let actions = '';
  if (!row.installed) {
    actions = `<button class="btn btn-primary btn-sm" style="width:100%" data-pkg-action="install" data-pkg-name="${escHtml(row.name)}">${escHtml(t('packages.install'))}</button>`;
  } else if (row.active && row.enabled) {
    actions = `
      <div style="display:flex;gap:6px">
        <button class="btn btn-secondary btn-sm" style="flex:1" data-pkg-action="deactivate" data-pkg-name="${escHtml(row.name)}">${escHtml(t('packages.deactivate'))}</button>
        <button class="btn btn-ghost btn-sm" style="flex:1" data-pkg-action="uninstall" data-pkg-name="${escHtml(row.name)}">${escHtml(t('packages.uninstall'))}</button>
      </div>`;
  } else {
    actions = `
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" style="flex:1" data-pkg-action="activate" data-pkg-name="${escHtml(row.name)}">${escHtml(t('packages.activate'))}</button>
        <button class="btn btn-ghost btn-sm" style="flex:1" data-pkg-action="uninstall" data-pkg-name="${escHtml(row.name)}">${escHtml(t('packages.uninstall'))}</button>
      </div>`;
  }

  return `
    <div class="card" style="cursor:default">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div class="card-title">${escHtml(row.title)}</div>
        ${statusChip}
      </div>
      <div class="card-body" style="padding-top:0">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.4">${escHtml(row.description)}</div>
        ${serviceNote}${credNotes}${caps}
        <div style="margin-top:12px">${actions}</div>
      </div>
    </div>`;
}

// Delegate clicks on package action buttons so each card stays simple and the
// handler resolves the action + name from data attributes, then calls the
// server-validated extensions route.
function wirePackageActions(root: HTMLElement): void {
  root.addEventListener('click', (ev: MouseEvent) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-pkg-action]');
    if (!btn) return;
    const action = btn.dataset['pkgAction'];
    const name = btn.dataset['pkgName'];
    if (!action || !name) return;
    void handlePackageAction(name, action, btn);
  });
}

async function handlePackageAction(name: string, action: string, btn: HTMLButtonElement): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const actionLabel: Record<string, string> = {
    install: t('packages.install'),
    activate: t('packages.activate'),
    deactivate: t('packages.deactivate'),
    uninstall: t('packages.uninstall'),
  };
  const original = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = '…';
  try {
    if (action === 'uninstall') {
      if (!window.confirm(t('packages.confirmUninstall', { name }))) {
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
    }
    const method = action === 'uninstall' ? 'DELETE' : 'POST';
    const suffix = action === 'uninstall' ? '' : `/${action}`;
    await api(method, `/projects/${pid}/extensions/${encodeURIComponent(name)}${suffix}`);
    toast(`${actionLabel[action] ?? action}: ${name}`, 'success');
    await fetchAndRenderPackages();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(t('packages.actionFailed', { action: actionLabel[action] ?? action, error: msg }), 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

// Wire the delegated action handler once the view container exists.
let actionsWired = false;
function ensureActionsWired(): void {
  if (actionsWired) return;
  const root = document.getElementById('content-packages');
  if (root) {
    wirePackageActions(root);
    actionsWired = true;
  }
}

/**
 * Called from the SSE handler in app.ts when an `extensions-changed` event
 * arrives, so every collaborator on the project sees package installs /
 * activates / deactivates / uninstalls live. Only re-renders when the Packages
 * view is active, matching how the graph view gates its live refresh.
 */
export function refreshPackagesOnSSE(evt: MessageEvent): void {
  if (state.currentView !== 'packages') return;
  try {
    const payload = JSON.parse(evt.data) as { userId?: string; name?: string; operation?: string };
    const myUserId = state.user?.id;
    if (payload.userId && payload.userId !== myUserId) {
      const op = payload.operation ?? 'updated';
      toast(t('packages.changedByOther', { name: payload.name ?? '', operation: op }), 'info');
    }
  } catch { /* ignore parse errors */ }
  void fetchAndRenderPackages();
}