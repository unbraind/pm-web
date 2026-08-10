// ═══════════════════════════════════════════════════════════════
// AUTH VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { bootApp } from '../app.js';
import { t, translateError } from '../i18n.js';
import type { User } from '../types.js';

/**
 * Fetches the OIDC provider configuration and shows or hides the single
 * sign-on login button and divider based on whether it is enabled. Both
 * elements are hidden when the config request fails.
 */
async function configureOidcLogin(): Promise<void> {
  const button = document.getElementById('oidc-login') as HTMLButtonElement | null;
  const divider = document.getElementById('oidc-divider') as HTMLElement | null;
  if (!button) return;
  try {
    const config = await api('GET', '/auth/oidc/config') as { enabled: boolean; label: string };
    button.hidden = !config.enabled;
    if (divider) divider.hidden = !config.enabled;
    button.textContent = t('auth.oidc.template', { label: config.label });
  } catch {
    button.hidden = true;
    if (divider) divider.hidden = true;
  }
}

/**
 * Redirects the browser to the server endpoint that begins the single
 * sign-on authentication flow.
 */
export function startOidcLogin(): void {
  window.location.assign('/api/auth/oidc/start');
}

/**
 * Switches the authentication panel between login and register modes,
 * updating tab highlighting, the visible name field, and the translated
 * title, subtitle, and button labels.
 *
 * @param tab - 'login' or 'register'.
 */
export function switchAuthTab(tab: 'login' | 'register'): void {
  state.authTab = tab;
  document.getElementById('tab-login')?.classList.toggle('active', tab==='login');
  document.getElementById('tab-register')?.classList.toggle('active', tab==='register');
  const fieldName = document.getElementById('field-name') as HTMLElement | null;
  if (fieldName) fieldName.style.display = tab==='register' ? '' : 'none';
  const authTitle = document.getElementById('auth-title');
  if (authTitle) authTitle.textContent = tab==='login' ? t('auth.title.login') : t('auth.title.register');
  const authSub = document.getElementById('auth-sub');
  if (authSub) authSub.textContent = tab==='login' ? t('auth.sub.login') : t('auth.sub.register');
  const authBtnText = document.getElementById('auth-btn-text');
  if (authBtnText) authBtnText.textContent = tab==='login' ? t('auth.button.login') : t('auth.button.register');
  const authError = document.getElementById('auth-error') as HTMLElement | null;
  if (authError) authError.style.display = 'none';
}

/**
 * Handles the form submission: posts the entered credentials to either the
 * login or register endpoint depending on the active tab, stores the returned
 * user, and boots the application. Shows a translated error message on failure.
 *
 * @param e - form submit event.
 */
export async function submitAuth(e: Event): Promise<void> {
  e.preventDefault();
  const btn = document.getElementById('auth-submit') as HTMLButtonElement | null;
  const errEl = document.getElementById('auth-error') as HTMLElement | null;
  const emailEl = document.getElementById('auth-email') as HTMLInputElement | null;
  const passwordEl = document.getElementById('auth-password') as HTMLInputElement | null;
  const nameEl = document.getElementById('auth-name') as HTMLInputElement | null;

  if (!btn || !errEl || !emailEl || !passwordEl) return;

  const email = emailEl.value.trim();
  const password = passwordEl.value;
  const name = nameEl?.value.trim() || '';

  errEl.style.display = 'none';
  btn.disabled = true;
  const span = btn.querySelector('span');
  if (span) span.textContent = t('auth.loading');

  try {
    let data: { user: User };
    if (state.authTab === 'login') {
      data = await api('POST','/auth/login',{email,password});
    } else {
      data = await api('POST','/auth/register',{email,password,displayName:name||email.split('@')[0]});
    }
    state.user = data.user;
    await bootApp();
  } catch(err: unknown) {
    errEl.textContent = translateError(err instanceof Error ? err.message : String(err));
    errEl.style.display = 'block';
    btn.disabled = false;
    if (span) span.textContent = state.authTab==='login' ? t('auth.button.login') : t('auth.button.register');
  }
}

/**
 * Signs the current user out by calling the logout endpoint, clears local
 * state, and returns to the login screen.
 */
export async function logout(): Promise<void> {
  try { await api('POST','/auth/logout',{}); } catch(_) { /* ignore */ }
  state.user = null;
  state.projects = [];
  state.currentProject = null;
  showAuth();
}

/**
 * Displays the authentication screen, hides the main application view, and
 * refreshes the single sign-on button state.
 */
export function showAuth(): void {
  const authScreen = document.getElementById('auth-screen');
  const mainApp = document.getElementById('main-app');
  if (authScreen) authScreen.style.display = 'flex';
  if (mainApp) mainApp.style.display = 'none';
  void configureOidcLogin();
}
