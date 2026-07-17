// ═══════════════════════════════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/modals.js';
import { t, translateError, localeDate, getLocale, SUPPORTED_LOCALES, type SupportedLocale } from '../i18n.js';

function avatarInitial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}

function avatarBg(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) { hash = (hash * 31 + seed.charCodeAt(i)) >>> 0; }
  const hue = hash % 360;
  return `hsl(${hue},55%,45%)`;
}

export function renderSettingsView(): void {
  const el = document.getElementById('content-settings');
  if (!el) return;
  const u = state.user || ({} as any);
  const createdInfo = u.created_at
    ? `<span style="display:block;margin-top:4px;font-size:12px;color:var(--text-muted)">${escHtml(t('settings.accountCreated', { date: localeDate(u.created_at, { year: 'numeric', month: 'long', day: 'numeric' }) }))}</span>`
    : '';
  const currentLocale = getLocale();
  const langOptions = SUPPORTED_LOCALES.map((loc) => {
    const label = loc === 'en' ? t('settings.languageEn') : loc === 'de' ? t('settings.languageDe') : t('settings.languageEs');
    return `<option value="${loc}"${loc === currentLocale ? ' selected' : ''}>${escHtml(label)}</option>`;
  }).join('');
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">${escHtml(t('settings.title'))}</div><div class="page-subtitle">${escHtml(t('settings.subtitle'))}</div></div>
    </div>
    <div style="max-width:560px;display:flex;flex-direction:column;gap:20px">
      <div class="card">
        <div class="card-header"><div class="card-title">${escHtml(t('settings.language'))}</div></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label" for="settings-language">${escHtml(t('settings.language'))}</label>
            <select class="form-input" id="settings-language" onchange="window.__app.changeLanguage(this.value)" aria-label="${escHtml(t('settings.language'))}">
              ${langOptions}
            </select>
            <div style="font-size:12px;color:var(--text-muted);margin-top:6px">${escHtml(t('settings.languageHint'))}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">${escHtml(t('settings.profile'))}</div></div>
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
            <div style="width:64px;height:64px;border-radius:50%;background:${avatarBg(u.email||u.display_name||'?')};display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;flex-shrink:0;user-select:none" aria-hidden="true">${escHtml(avatarInitial(u.display_name||u.email||'?'))}</div>
            <div>
              <div style="font-weight:600;font-size:16px">${escHtml(u.display_name||u.email||'')}</div>
              <div style="font-size:13px;color:var(--text-muted)">${escHtml(u.email||'')}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-display-name">${escHtml(t('settings.displayName'))}</label>
            <input class="form-input" id="settings-display-name" type="text" value="${escHtml(u.display_name||u.email||'')}" placeholder="${escHtml(t('settings.displayNamePlaceholder'))}" aria-label="${escHtml(t('settings.displayName'))}">
          </div>
          <div class="form-group">
            <label class="form-label">${escHtml(t('settings.email'))}</label>
            <input class="form-input" type="text" value="${escHtml(u.email||'')}" disabled style="opacity:0.6;cursor:not-allowed" aria-label="${escHtml(t('settings.emailReadonly'))}">
            ${createdInfo}
          </div>
          <div class="form-error" id="settings-profile-error" style="display:none" role="alert"></div>
          <button class="btn btn-primary btn-sm" id="settings-profile-btn" onclick="window.__app.saveProfile()" aria-label="${escHtml(t('settings.saveProfile'))}"><span>${escHtml(t('settings.saveProfile'))}</span></button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">${escHtml(t('settings.changePassword'))}</div></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label" for="settings-current-pw">${escHtml(t('settings.currentPassword'))}</label>
            <input class="form-input" id="settings-current-pw" type="password" placeholder="${escHtml(t('settings.currentPasswordPlaceholder'))}" autocomplete="current-password" aria-label="${escHtml(t('settings.currentPassword'))}">
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-new-pw">${escHtml(t('settings.newPassword'))}</label>
            <input class="form-input" id="settings-new-pw" type="password" placeholder="${escHtml(t('settings.newPasswordPlaceholder'))}" autocomplete="new-password" aria-label="${escHtml(t('settings.newPassword'))}">
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-confirm-pw">${escHtml(t('settings.confirmPassword'))}</label>
            <input class="form-input" id="settings-confirm-pw" type="password" placeholder="${escHtml(t('settings.confirmPasswordPlaceholder'))}" autocomplete="new-password" aria-label="${escHtml(t('settings.confirmPassword'))}">
          </div>
          <div class="form-error" id="settings-pw-error" style="display:none" role="alert"></div>
          <button class="btn btn-primary btn-sm" id="settings-pw-btn" onclick="window.__app.changePassword()" aria-label="${escHtml(t('settings.changePassword'))}"><span>${escHtml(t('settings.changePassword'))}</span></button>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">${escHtml(t('settings.githubToken'))}</div>
          ${u.has_github_token ? `<span style="font-size:12px;color:var(--status-closed)">${escHtml(t('settings.tokenConfigured'))}</span>` : `<span style="font-size:12px;color:var(--text-muted)">${escHtml(t('settings.tokenNotSet'))}</span>`}
        </div>
        <div class="card-body">
          <div style="margin-bottom:12px;padding:10px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--text-secondary)">
            <strong style="color:var(--text-primary)">${escHtml(t('settings.howToGet'))}</strong>
            <ol style="margin-top:6px;padding-left:18px;line-height:1.8">
              <li>${escHtml(t('settings.tokenStep1'))}</li>
              <li>${escHtml(t('settings.tokenStep2'))}</li>
              <li>${escHtml(t('settings.tokenStep3'))}</li>
            </ol>
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-github-token">${escHtml(t('settings.tokenLabel'))}</label>
            <input class="form-input" id="settings-github-token" type="password" placeholder="${escHtml(u.has_github_token ? t('settings.tokenPlaceholder.keep') : t('settings.tokenPlaceholder.set'))}" autocomplete="off" aria-label="${escHtml(t('settings.tokenLabel'))}">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('settings.tokenHint')}</div>
          </div>
          <div class="form-error" id="settings-github-error" style="display:none" role="alert"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" id="settings-github-btn" onclick="window.__app.saveGitHubToken()" aria-label="${escHtml(t('settings.saveToken'))}"><span>${escHtml(t('settings.saveToken'))}</span></button>
            ${u.has_github_token ? `<button class="btn btn-danger btn-sm" onclick="window.__app.clearGitHubToken()" aria-label="${escHtml(t('settings.clearToken'))}">${escHtml(t('settings.clearToken'))}</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

export async function saveProfile(): Promise<void> {
  const displayName = (document.getElementById('settings-display-name') as HTMLInputElement | null)?.value?.trim() || '';
  const errEl = document.getElementById('settings-profile-error') as HTMLElement | null;
  const btn = document.getElementById('settings-profile-btn') as HTMLButtonElement | null;
  if (!displayName) { if (errEl) { errEl.textContent = t('settings.displayNameEmpty'); errEl.style.display = 'block'; } return; }
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = t('settings.saving'); }
  try {
    const data = await api('PATCH','/auth/profile',{displayName});
    if ((data as any).user) {
      state.user = { ...state.user!, ...(data as any).user };
    } else {
      state.user!.display_name = displayName;
    }
    const u = state.user!;
    const initials = (u.display_name||u.email||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl) avatarEl.textContent = initials;
    const nameEl = document.getElementById('user-name-display');
    if (nameEl) nameEl.textContent = u.display_name||u.email;
    toast(t('settings.profileSaved'),'success');
    renderSettingsView();
  } catch(err: unknown) {
    if (errEl) { errEl.textContent = translateError(err instanceof Error ? err.message : String(err)); errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = t('settings.saveProfile'); }
  }
}

export async function changePassword(): Promise<void> {
  const currentPassword = (document.getElementById('settings-current-pw') as HTMLInputElement | null)?.value || '';
  const newPassword = (document.getElementById('settings-new-pw') as HTMLInputElement | null)?.value || '';
  const confirmPassword = (document.getElementById('settings-confirm-pw') as HTMLInputElement | null)?.value || '';
  const errEl = document.getElementById('settings-pw-error') as HTMLElement | null;
  const btn = document.getElementById('settings-pw-btn') as HTMLButtonElement | null;
  if (errEl) errEl.style.display = 'none';
  if (!currentPassword || !newPassword || !confirmPassword) { if (errEl) { errEl.textContent = t('settings.allFieldsRequired'); errEl.style.display = 'block'; } return; }
  if (newPassword !== confirmPassword) { if (errEl) { errEl.textContent = t('settings.passwordsDoNotMatch'); errEl.style.display = 'block'; } return; }
  if (newPassword.length < 6) { if (errEl) { errEl.textContent = t('settings.passwordTooShort'); errEl.style.display = 'block'; } return; }
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = t('settings.changing'); }
  try {
    await api('POST','/auth/change-password',{currentPassword,newPassword});
    toast(t('settings.passwordChanged'),'success');
    const curEl = document.getElementById('settings-current-pw') as HTMLInputElement | null;
    const newEl = document.getElementById('settings-new-pw') as HTMLInputElement | null;
    const confEl = document.getElementById('settings-confirm-pw') as HTMLInputElement | null;
    if (curEl) curEl.value = '';
    if (newEl) newEl.value = '';
    if (confEl) confEl.value = '';
  } catch(err: unknown) {
    if (errEl) { errEl.textContent = translateError(err instanceof Error ? err.message : String(err)); errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = t('settings.changePassword'); }
  }
}

export async function saveGitHubToken(): Promise<void> {
  const token = (document.getElementById('settings-github-token') as HTMLInputElement | null)?.value?.trim() || '';
  const errEl = document.getElementById('settings-github-error') as HTMLElement | null;
  const btn = document.getElementById('settings-github-btn') as HTMLButtonElement | null;
  if (!token) { if (errEl) { errEl.textContent = t('settings.tokenEmpty'); errEl.style.display = 'block'; } return; }
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = t('settings.saving'); }
  try {
    const data = await api('PATCH','/auth/github-token',{token});
    state.user!.has_github_token = (data as any).hasToken !== undefined ? (data as any).hasToken : true;
    toast(t('settings.tokenSaved'),'success');
    renderSettingsView();
  } catch(err: unknown) {
    if (errEl) { errEl.textContent = translateError(err instanceof Error ? err.message : String(err)); errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = t('settings.saveToken'); }
  }
}

export function clearGitHubToken(): void {
  confirmDialog(t('settings.clearTokenTitle'), t('settings.clearTokenBody'), async () => {
    try {
      const data = await api('PATCH','/auth/github-token',{token:''});
      state.user!.has_github_token = false;
      toast(t('settings.tokenCleared'),'success');
      renderSettingsView();
    } catch(err: unknown) {
      toast(translateError(err instanceof Error ? err.message : String(err)),'error');
    }
  }, false, { cancel: t('dialog.cancel'), confirm: t('dialog.confirm') });
}

// Re-export so type-only re-exports stay usable if extended later.
export type { SupportedLocale };