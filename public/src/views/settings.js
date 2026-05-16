// ═══════════════════════════════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/modals.js';
function avatarInitial(name) {
    return (name.trim()[0] || '?').toUpperCase();
}
function avatarBg(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const hue = hash % 360;
    return `hsl(${hue},55%,45%)`;
}
export function renderSettingsView() {
    const el = document.getElementById('content-settings');
    if (!el)
        return;
    const u = state.user || {};
    const createdInfo = u.created_at
        ? `<span style="display:block;margin-top:4px;font-size:12px;color:var(--text-muted)">Account created ${new Date(u.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>`
        : '';
    el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Settings</div><div class="page-subtitle">Manage your profile and account</div></div>
    </div>
    <div style="max-width:560px;display:flex;flex-direction:column;gap:20px">
      <div class="card">
        <div class="card-header"><div class="card-title">Profile</div></div>
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
            <div style="width:64px;height:64px;border-radius:50%;background:${avatarBg(u.email || u.display_name || '?')};display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;flex-shrink:0;user-select:none" aria-hidden="true">${escHtml(avatarInitial(u.display_name || u.email || '?'))}</div>
            <div>
              <div style="font-weight:600;font-size:16px">${escHtml(u.display_name || u.email || '')}</div>
              <div style="font-size:13px;color:var(--text-muted)">${escHtml(u.email || '')}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-display-name">Display Name</label>
            <input class="form-input" id="settings-display-name" type="text" value="${escHtml(u.display_name || u.email || '')}" placeholder="Your display name" aria-label="Display name">
          </div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" type="text" value="${escHtml(u.email || '')}" disabled style="opacity:0.6;cursor:not-allowed" aria-label="Email address (read only)">
            ${createdInfo}
          </div>
          <div class="form-error" id="settings-profile-error" style="display:none" role="alert"></div>
          <button class="btn btn-primary btn-sm" id="settings-profile-btn" onclick="window.__app.saveProfile()" aria-label="Save profile changes"><span>Save Profile</span></button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Change Password</div></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label" for="settings-current-pw">Current Password</label>
            <input class="form-input" id="settings-current-pw" type="password" placeholder="Current password" autocomplete="current-password" aria-label="Current password">
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-new-pw">New Password</label>
            <input class="form-input" id="settings-new-pw" type="password" placeholder="New password" autocomplete="new-password" aria-label="New password">
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-confirm-pw">Confirm New Password</label>
            <input class="form-input" id="settings-confirm-pw" type="password" placeholder="Confirm new password" autocomplete="new-password" aria-label="Confirm new password">
          </div>
          <div class="form-error" id="settings-pw-error" style="display:none" role="alert"></div>
          <button class="btn btn-primary btn-sm" id="settings-pw-btn" onclick="window.__app.changePassword()" aria-label="Change password"><span>Change Password</span></button>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">GitHub Token</div>
          ${u.has_github_token ? `<span style="font-size:12px;color:var(--status-closed)">✓ Token configured</span>` : `<span style="font-size:12px;color:var(--text-muted)">No token set</span>`}
        </div>
        <div class="card-body">
          <div style="margin-bottom:12px;padding:10px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--text-secondary)">
            <strong style="color:var(--text-primary)">How to get a token:</strong>
            <ol style="margin-top:6px;padding-left:18px;line-height:1.8">
              <li>Go to GitHub → Settings → Developer settings → Personal access tokens</li>
              <li>Generate a new token with <code style="font-family:monospace;background:var(--bg-base);padding:0 3px;border-radius:3px">repo</code> scope</li>
              <li>Paste the token below and click Save</li>
            </ol>
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-github-token">Personal Access Token (PAT)</label>
            <input class="form-input" id="settings-github-token" type="password" placeholder="${u.has_github_token ? 'Leave blank to keep current token' : 'ghp_…'}" autocomplete="off" aria-label="GitHub personal access token">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Used for GitHub integration. Needs <code style="font-family:monospace;background:var(--bg-input);padding:0 3px;border-radius:3px">repo</code> scope.</div>
          </div>
          <div class="form-error" id="settings-github-error" style="display:none" role="alert"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" id="settings-github-btn" onclick="window.__app.saveGitHubToken()" aria-label="Save GitHub token"><span>Save Token</span></button>
            ${u.has_github_token ? `<button class="btn btn-danger btn-sm" onclick="window.__app.clearGitHubToken()" aria-label="Clear GitHub token">Clear Token</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}
export async function saveProfile() {
    const displayName = document.getElementById('settings-display-name')?.value?.trim() || '';
    const errEl = document.getElementById('settings-profile-error');
    const btn = document.getElementById('settings-profile-btn');
    if (!displayName) {
        if (errEl) {
            errEl.textContent = 'Display name cannot be empty';
            errEl.style.display = 'block';
        }
        return;
    }
    if (errEl)
        errEl.style.display = 'none';
    if (btn) {
        btn.disabled = true;
        const sp = btn.querySelector('span');
        if (sp)
            sp.textContent = 'Saving…';
    }
    try {
        const data = await api('PATCH', '/auth/profile', { displayName });
        if (data.user) {
            state.user = { ...state.user, ...data.user };
        }
        else {
            state.user.display_name = displayName;
        }
        const u = state.user;
        const initials = (u.display_name || u.email || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const avatarEl = document.getElementById('user-avatar');
        if (avatarEl)
            avatarEl.textContent = initials;
        const nameEl = document.getElementById('user-name-display');
        if (nameEl)
            nameEl.textContent = u.display_name || u.email;
        toast('Profile saved', 'success');
        renderSettingsView();
    }
    catch (err) {
        if (errEl) {
            errEl.textContent = err instanceof Error ? err.message : String(err);
            errEl.style.display = 'block';
        }
    }
    finally {
        if (btn) {
            btn.disabled = false;
            const sp = btn.querySelector('span');
            if (sp)
                sp.textContent = 'Save Profile';
        }
    }
}
export async function changePassword() {
    const currentPassword = document.getElementById('settings-current-pw')?.value || '';
    const newPassword = document.getElementById('settings-new-pw')?.value || '';
    const confirmPassword = document.getElementById('settings-confirm-pw')?.value || '';
    const errEl = document.getElementById('settings-pw-error');
    const btn = document.getElementById('settings-pw-btn');
    if (errEl)
        errEl.style.display = 'none';
    if (!currentPassword || !newPassword || !confirmPassword) {
        if (errEl) {
            errEl.textContent = 'All fields are required';
            errEl.style.display = 'block';
        }
        return;
    }
    if (newPassword !== confirmPassword) {
        if (errEl) {
            errEl.textContent = 'New passwords do not match';
            errEl.style.display = 'block';
        }
        return;
    }
    if (newPassword.length < 6) {
        if (errEl) {
            errEl.textContent = 'New password must be at least 6 characters';
            errEl.style.display = 'block';
        }
        return;
    }
    if (btn) {
        btn.disabled = true;
        const sp = btn.querySelector('span');
        if (sp)
            sp.textContent = 'Changing…';
    }
    try {
        await api('POST', '/auth/change-password', { currentPassword, newPassword });
        toast('Password changed successfully', 'success');
        const curEl = document.getElementById('settings-current-pw');
        const newEl = document.getElementById('settings-new-pw');
        const confEl = document.getElementById('settings-confirm-pw');
        if (curEl)
            curEl.value = '';
        if (newEl)
            newEl.value = '';
        if (confEl)
            confEl.value = '';
    }
    catch (err) {
        if (errEl) {
            errEl.textContent = err instanceof Error ? err.message : String(err);
            errEl.style.display = 'block';
        }
    }
    finally {
        if (btn) {
            btn.disabled = false;
            const sp = btn.querySelector('span');
            if (sp)
                sp.textContent = 'Change Password';
        }
    }
}
export async function saveGitHubToken() {
    const token = document.getElementById('settings-github-token')?.value?.trim() || '';
    const errEl = document.getElementById('settings-github-error');
    const btn = document.getElementById('settings-github-btn');
    if (!token) {
        if (errEl) {
            errEl.textContent = 'Please enter a token';
            errEl.style.display = 'block';
        }
        return;
    }
    if (errEl)
        errEl.style.display = 'none';
    if (btn) {
        btn.disabled = true;
        const sp = btn.querySelector('span');
        if (sp)
            sp.textContent = 'Saving…';
    }
    try {
        const data = await api('PATCH', '/auth/github-token', { token });
        state.user.has_github_token = data.hasToken !== undefined ? data.hasToken : true;
        toast('GitHub token saved', 'success');
        renderSettingsView();
    }
    catch (err) {
        if (errEl) {
            errEl.textContent = err instanceof Error ? err.message : String(err);
            errEl.style.display = 'block';
        }
    }
    finally {
        if (btn) {
            btn.disabled = false;
            const sp = btn.querySelector('span');
            if (sp)
                sp.textContent = 'Save Token';
        }
    }
}
export function clearGitHubToken() {
    confirmDialog('Clear GitHub Token?', 'Your GitHub integration will stop working.', async () => {
        try {
            const data = await api('PATCH', '/auth/github-token', { token: '' });
            state.user.has_github_token = false;
            toast('GitHub token cleared', 'success');
            renderSettingsView();
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
    });
}
//# sourceMappingURL=settings.js.map