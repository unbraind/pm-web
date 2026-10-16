import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { state } from '../state.js';

/** Provider capability exposed by the project extensions response. */
export interface MaintenanceCapability {
  available: boolean;
  provider: string;
  hint: string;
  installAction?: { method: 'POST'; url: string };
}

/** Render the unavailable state with package management restricted by the server. */
export function renderMaintenanceRequirement(capability: MaintenanceCapability): string {
  return `<div role="status"><button class="btn btn-secondary btn-sm" disabled>Requires ${escHtml(capability.provider)}</button>
    <p>${escHtml(capability.hint)}</p>${capability.installAction
      ? '<button class="btn btn-primary btn-sm" onclick="window.__app.showView(\'packages\')">Install / enable in Packages</button>' : ''}</div>`;
}

/** Gate a view's action on fresh project capabilities and retain a disabled state on read failure. */
export async function requireMaintenanceCapability(target: HTMLElement, action: 'normalize' | 'comments-audit' | 'reindex'): Promise<boolean> {
  const pid = state.currentProject?.id;
  if (!pid) return false;
  try {
    const data = await api<{ maintenance: Record<string, MaintenanceCapability>; canManagePackages: boolean }>('GET', `/projects/${pid}/extensions`);
    if (state.currentProject?.id !== pid || document.getElementById(target.id) !== target) return false;
    const capability = data.maintenance[action];
    if (!capability.available) {
      target.innerHTML = renderMaintenanceRequirement(capability);
      return false;
    }
    if (action !== 'comments-audit' && !data.canManagePackages) {
      target.innerHTML = '<div role="status">This action requires project edit permission.</div>';
      return false;
    }
    return true;
  } catch (error: unknown) {
    if (state.currentProject?.id === pid && document.getElementById(target.id) === target) {
      target.innerHTML = `<div role="status">Cannot check provider availability: ${escHtml(error instanceof Error ? error.message : String(error))}</div>`;
    }
    return false;
  }
}
