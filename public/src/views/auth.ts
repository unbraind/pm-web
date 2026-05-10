// ═══════════════════════════════════════════════════════════════
// AUTH VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { bootApp } from '../app.js';
import type { User } from '../types.js';

export function switchAuthTab(tab: 'login' | 'register'): void {
  state.authTab = tab;
  document.getElementById('tab-login')?.classList.toggle('active', tab==='login');
  document.getElementById('tab-register')?.classList.toggle('active', tab==='register');
  const fieldName = document.getElementById('field-name') as HTMLElement | null;
  if (fieldName) fieldName.style.display = tab==='register' ? '' : 'none';
  const authTitle = document.getElementById('auth-title');
  if (authTitle) authTitle.textContent = tab==='login' ? 'Welcome back' : 'Create account';
  const authSub = document.getElementById('auth-sub');
  if (authSub) authSub.textContent = tab==='login' ? 'Sign in to your account to continue' : 'Join pm-web and start managing projects';
  const authBtnText = document.getElementById('auth-btn-text');
  if (authBtnText) authBtnText.textContent = tab==='login' ? 'Sign In' : 'Create Account';
  const authError = document.getElementById('auth-error') as HTMLElement | null;
  if (authError) authError.style.display = 'none';
}

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
  if (span) span.textContent = 'Please wait…';

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
    errEl.textContent = err instanceof Error ? err.message : String(err);
    errEl.style.display = 'block';
    btn.disabled = false;
    if (span) span.textContent = state.authTab==='login' ? 'Sign In' : 'Create Account';
  }
}

export async function logout(): Promise<void> {
  try { await api('POST','/auth/logout',{}); } catch(_) { /* ignore */ }
  state.user = null;
  state.projects = [];
  state.currentProject = null;
  showAuth();
}

export function showAuth(): void {
  const authScreen = document.getElementById('auth-screen');
  const mainApp = document.getElementById('main-app');
  if (authScreen) authScreen.style.display = 'flex';
  if (mainApp) mainApp.style.display = 'none';
}
