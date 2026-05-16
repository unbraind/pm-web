// ═══════════════════════════════════════════════════════════════
// CONFIG VIEW — Project configuration editor
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
export async function renderConfigView() {
    const el = document.getElementById('content-config');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Project Config</div>
        <div class="page-subtitle">Configure pm CLI settings for this project</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderConfigView()">↺ Refresh</button>
      </div>
    </div>
    <div class="loading-state"><div class="loading-spinner"></div></div>`;
    try {
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/config`);
        renderConfigData(el, data);
    }
    catch (err) {
        el.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Project Config</div>
          <div class="page-subtitle">Configure pm CLI settings for this project</div>
        </div>
      </div>
      <div class="empty-state">
        <div class="empty-state-text">Failed to load config</div>
        <div class="empty-state-sub">${escHtml(err instanceof Error ? err.message : String(err))}</div>
      </div>`;
    }
}
function renderConfigData(el, data) {
    const { keys } = data;
    // Group keys into categories
    const simpleKeys = keys.filter(k => k.value_kind === 'string' || k.value_kind === 'enum');
    const arrayKeys = keys.filter(k => k.value_kind === 'string_array');
    const objectKeys = keys.filter(k => k.value_kind === 'object');
    function renderArrayField(k) {
        const arr = Array.isArray(k.value) ? k.value : [];
        const items = arr.map((item, i) => `
      <div class="config-array-item" id="config-arr-${escHtml(k.key)}-${i}" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <input class="form-input" style="flex:1" type="text" value="${escHtml(item)}" data-key="${escHtml(k.key)}" data-idx="${i}">
        <button class="btn btn-danger btn-sm" style="padding:4px 8px;flex-shrink:0" onclick="window.__app.configRemoveArrayItem('${escHtml(k.key)}',${i})">✕</button>
      </div>`).join('');
        return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          <div class="card-title">${escHtml(k.key.replace(/_/g, ' '))}</div>
          <div style="font-size:11px;color:var(--text-muted)">${escHtml(k.summary)}</div>
        </div>
        <div class="card-body">
          <div id="config-arr-${escHtml(k.key)}-container">${items || '<div style="color:var(--text-muted);font-size:13px;margin-bottom:8px">No items yet</div>'}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <input class="form-input" id="config-arr-${escHtml(k.key)}-new" type="text" placeholder="Add item…" style="flex:1"
              onkeydown="if(event.key==='Enter'){event.preventDefault();window.__app.configAddArrayItem('${escHtml(k.key)}');}">
            <button class="btn btn-secondary btn-sm" onclick="window.__app.configAddArrayItem('${escHtml(k.key)}')">Add</button>
            <button class="btn btn-primary btn-sm" onclick="window.__app.configSaveArray('${escHtml(k.key)}')">Save</button>
          </div>
        </div>
      </div>`;
    }
    function renderSimpleField(k) {
        const val = k.value !== null && k.value !== undefined ? String(k.value) : '';
        return `
      <div class="form-group">
        <label class="form-label" title="${escHtml(k.summary)}">${escHtml(k.key.replace(/_/g, ' '))}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="form-input" id="config-field-${escHtml(k.key)}" type="text" value="${escHtml(val)}"
            placeholder="${escHtml(k.summary)}" style="flex:1"
            onkeydown="if(event.key==='Enter'){event.preventDefault();window.__app.configSaveSimple('${escHtml(k.key)}');}">
          <button class="btn btn-primary btn-sm" onclick="window.__app.configSaveSimple('${escHtml(k.key)}')">Save</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px">${escHtml(k.summary)}</div>
      </div>`;
    }
    function renderObjectField(k) {
        const val = k.value !== null && k.value !== undefined ? JSON.stringify(k.value, null, 2) : '{}';
        return `
      <div class="form-group">
        <label class="form-label">${escHtml(k.key.replace(/_/g, ' '))}</label>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${escHtml(k.summary)}</div>
        <textarea class="form-input" id="config-field-${escHtml(k.key)}" style="font-family:monospace;font-size:12px;min-height:120px;resize:vertical">${escHtml(val)}</textarea>
        <div style="margin-top:6px">
          <button class="btn btn-primary btn-sm" onclick="window.__app.configSaveObject('${escHtml(k.key)}')">Save</button>
        </div>
      </div>`;
    }
    el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Project Config</div>
        <div class="page-subtitle">Configure pm CLI settings for ${escHtml(state.currentProject?.name || '')}</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderConfigView()">↺ Refresh</button>
      </div>
    </div>

    ${arrayKeys.length > 0 ? `
    <div style="margin-bottom:24px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">List Settings</div>
      ${arrayKeys.map(renderArrayField).join('')}
    </div>` : ''}

    ${simpleKeys.length > 0 ? `
    <div class="card" style="margin-bottom:24px">
      <div class="card-header"><div class="card-title">Simple Settings</div></div>
      <div class="card-body">
        ${simpleKeys.map(renderSimpleField).join('')}
      </div>
    </div>` : ''}

    ${objectKeys.length > 0 ? `
    <div class="card" style="margin-bottom:24px">
      <div class="card-header"><div class="card-title">Object Settings</div></div>
      <div class="card-body">
        ${objectKeys.map(renderObjectField).join('')}
      </div>
    </div>` : ''}

    ${data.settings_path ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Settings path: <code style="font-family:monospace;background:var(--bg-input);padding:1px 4px;border-radius:3px">${escHtml(data.settings_path)}</code></div>` : ''}
  `;
    // Store the current keys in DOM for mutation use
    el.__configKeys = keys;
}
// ─── Array field helpers ───────────────────────────────────────
export function configAddArrayItem(key) {
    const inputEl = document.getElementById(`config-arr-${key}-new`);
    const val = inputEl?.value?.trim();
    if (!val)
        return;
    const container = document.getElementById(`config-arr-${key}-container`);
    if (!container)
        return;
    // Count existing items
    const existing = container.querySelectorAll('[data-key]');
    const idx = existing.length;
    // Remove "no items" message if present
    const noItems = container.querySelector('div');
    if (noItems && noItems.textContent?.includes('No items yet'))
        noItems.remove();
    const div = document.createElement('div');
    div.className = 'config-array-item';
    div.id = `config-arr-${key}-${idx}`;
    div.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
    div.innerHTML = `
    <input class="form-input" style="flex:1" type="text" value="${escHtml(val)}" data-key="${escHtml(key)}" data-idx="${idx}">
    <button class="btn btn-danger btn-sm" style="padding:4px 8px;flex-shrink:0" onclick="window.__app.configRemoveArrayItem('${escHtml(key)}',${idx})">✕</button>
  `;
    container.appendChild(div);
    if (inputEl)
        inputEl.value = '';
}
export function configRemoveArrayItem(key, idx) {
    const container = document.getElementById(`config-arr-${key}-container`);
    if (!container)
        return;
    const items = container.querySelectorAll('[data-key]');
    if (items[idx]) {
        items[idx].closest('.config-array-item')?.remove();
    }
    // Show "no items" if empty
    if (container.querySelectorAll('[data-key]').length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;margin-bottom:8px">No items yet</div>';
    }
}
export async function configSaveArray(key) {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const container = document.getElementById(`config-arr-${key}-container`);
    if (!container)
        return;
    const inputs = container.querySelectorAll('input[data-key]');
    const values = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);
    try {
        await api('PATCH', `/projects/${pid}/pm/config/${encodeURIComponent(key)}`, { value: values });
        toast(`Saved ${key.replace(/_/g, ' ')}`, 'success');
    }
    catch (err) {
        toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}
export async function configSaveSimple(key) {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const inputEl = document.getElementById(`config-field-${key}`);
    const value = inputEl?.value?.trim() ?? '';
    try {
        await api('PATCH', `/projects/${pid}/pm/config/${encodeURIComponent(key)}`, { value });
        toast(`Saved ${key.replace(/_/g, ' ')}`, 'success');
    }
    catch (err) {
        toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}
export async function configSaveObject(key) {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const textEl = document.getElementById(`config-field-${key}`);
    const raw = textEl?.value?.trim() ?? '';
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        toast('Invalid JSON — please check the format', 'error');
        return;
    }
    try {
        await api('PATCH', `/projects/${pid}/pm/config/${encodeURIComponent(key)}`, { value: parsed });
        toast(`Saved ${key.replace(/_/g, ' ')}`, 'success');
    }
    catch (err) {
        toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}
//# sourceMappingURL=config.js.map