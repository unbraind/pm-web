// ═══════════════════════════════════════════════════════════════
// EXPORT / IMPORT VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
export async function renderExportView() {
    const el = document.getElementById('content-export');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Export &amp; Import</div><div class="page-subtitle">${escHtml(state.currentProject.name)}</div></div>
    </div>
    <div style="max-width:600px;display:flex;flex-direction:column;gap:16px">
      <div class="export-card">
        <div class="export-card-icon">📥</div>
        <div class="export-card-info">
          <div class="export-card-title">Export as JSON</div>
          <div class="export-card-desc">Download all items with full metadata, comments, and history</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.exportData('json')"><span>Export JSON</span></button>
      </div>
      <div class="export-card">
        <div class="export-card-icon">📊</div>
        <div class="export-card-info">
          <div class="export-card-title">Export as CSV</div>
          <div class="export-card-desc">Download items as a spreadsheet-compatible CSV file</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.exportData('csv')"><span>Export CSV</span></button>
      </div>
      <div class="export-card">
        <div class="export-card-icon">📋</div>
        <div class="export-card-info">
          <div class="export-card-title">Export as YAML</div>
          <div class="export-card-desc">Download items as a human-readable YAML file</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.exportData('yaml')"><span>Export YAML</span></button>
      </div>
      <hr class="section-divider">
      <div class="export-card">
        <div class="export-card-icon">📤</div>
        <div class="export-card-info">
          <div class="export-card-title">Import from JSON</div>
          <div class="export-card-desc">Upload a previously exported JSON file to restore items</div>
        </div>
        <label class="btn btn-secondary btn-sm" style="cursor:pointer">
          <span>Choose File</span>
          <input type="file" accept=".json" style="display:none" onchange="window.__app.importData(this.files[0])">
        </label>
      </div>
      <div id="export-status" style="display:none"></div>
    </div>`;
}
export async function exportData(format) {
    const statusEl = document.getElementById('export-status');
    if (!state.currentProject || !statusEl)
        return;
    statusEl.style.display = '';
    statusEl.innerHTML = '<div class="loading-state" style="padding:16px"><div class="loading-spinner"></div></div>';
    try {
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/list-all?limit=9999`);
        const items = data.items || [];
        if (items.length === 0) {
            statusEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">No items to export</div>';
            return;
        }
        let content, filename, mime;
        if (format === 'csv') {
            const headers = ['id', 'title', 'type', 'status', 'priority', 'tags', 'assignee', 'deadline', 'sprint', 'release', 'created_at', 'updated_at'];
            const rows = items.map((i) => headers.map((h) => {
                const val = h === 'tags' ? (i.tags || []).join(';') : String(i[h] || '');
                return `"${val.replace(/"/g, '""')}"`;
            }).join(','));
            content = headers.join(',') + '\n' + rows.join('\n');
            filename = `${state.currentProject.slug}-items.csv`;
            mime = 'text/csv';
        }
        else if (format === 'yaml') {
            // Minimal YAML serializer — no external dependency needed for this structure
            const yamlVal = (v, indent) => {
                const pad = '  '.repeat(indent);
                if (v === null || v === undefined)
                    return 'null';
                if (typeof v === 'boolean')
                    return v ? 'true' : 'false';
                if (typeof v === 'number')
                    return String(v);
                if (Array.isArray(v)) {
                    if (v.length === 0)
                        return '[]';
                    return '\n' + v.map((item) => `${pad}- ${yamlVal(item, indent + 1)}`).join('\n');
                }
                if (typeof v === 'object') {
                    const entries = Object.entries(v).filter(([, val]) => val !== null && val !== undefined);
                    if (entries.length === 0)
                        return '{}';
                    return '\n' + entries.map(([k, val]) => {
                        const valStr = yamlVal(val, indent + 1);
                        return valStr.startsWith('\n') ? `${pad}${k}:${valStr}` : `${pad}${k}: ${valStr}`;
                    }).join('\n');
                }
                // String: quote if contains special chars
                const str = String(v);
                if (str.includes('\n') || str.includes(':') || str.includes('#') || str.includes('"') || str.startsWith(' ') || str.endsWith(' ')) {
                    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
                }
                return str || '""';
            };
            const yamlItems = items.map((item) => {
                const fields = ['id', 'title', 'type', 'status', 'priority', 'tags', 'assignee', 'deadline', 'sprint', 'release', 'description', 'body', 'created_at', 'updated_at'];
                const lines = fields
                    .filter(f => item[f] !== null && item[f] !== undefined && item[f] !== '')
                    .map(f => {
                    const valStr = yamlVal(item[f], 1);
                    return valStr.startsWith('\n') ? `  ${f}:${valStr}` : `  ${f}: ${valStr}`;
                });
                return '- ' + lines.join('\n').trimStart();
            });
            const header = `# pm-web export\n# project: ${state.currentProject.name}\n# exported_at: ${new Date().toISOString()}\nitems:\n`;
            content = header + yamlItems.join('\n');
            filename = `${state.currentProject.slug}-items.yaml`;
            mime = 'text/yaml';
        }
        else {
            content = JSON.stringify({ exportedAt: new Date().toISOString(), project: state.currentProject.name, version: '1.0', items }, null, 2);
            filename = `${state.currentProject.slug}-items.json`;
            mime = 'application/json';
        }
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        statusEl.innerHTML = `<div style="color:var(--status-closed);font-size:13px;padding:12px">✓ Exported ${items.length} items as ${format.toUpperCase()}</div>`;
        toast(`Exported ${items.length} items`, 'success');
    }
    catch (err) {
        statusEl.innerHTML = `<div style="color:var(--status-blocked);font-size:13px;padding:12px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
}
export async function importData(file) {
    if (!file || !state.currentProject)
        return;
    const statusEl = document.getElementById('export-status');
    if (!statusEl)
        return;
    statusEl.style.display = '';
    statusEl.innerHTML = '<div class="loading-state" style="padding:16px"><div class="loading-spinner"></div></div>';
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        const rawItems = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
        if (rawItems.length === 0) {
            throw new Error('No items found in file');
        }
        if (rawItems.length > 500) {
            throw new Error(`File contains ${rawItems.length} items — maximum is 500 per import`);
        }
        const items = rawItems.map((item) => {
            const i = item;
            const mapped = {
                title: String(i['title'] || 'Imported item'),
                type: String(i['type'] || 'Task'),
                priority: String(i['priority'] || 3),
            };
            if (i['description'])
                mapped['description'] = String(i['description']);
            if (i['status'])
                mapped['status'] = String(i['status']);
            if (i['tags'])
                mapped['tags'] = Array.isArray(i['tags']) ? i['tags'].join(',') : String(i['tags']);
            if (i['deadline'])
                mapped['deadline'] = String(i['deadline']);
            if (i['assignee'])
                mapped['assignee'] = String(i['assignee']);
            if (i['sprint'])
                mapped['sprint'] = String(i['sprint']);
            if (i['release'])
                mapped['release'] = String(i['release']);
            if (i['body'])
                mapped['body'] = String(i['body']);
            return mapped;
        });
        const result = await api('POST', `/projects/${state.currentProject.id}/pm/import`, { items });
        const created = result.created?.length ?? 0;
        const failed = result.errors?.length ?? 0;
        statusEl.innerHTML = `<div style="padding:12px;font-size:13px"><span style="color:var(--status-closed)">✓ Imported ${created} items</span>${failed ? `<span style="color:var(--status-blocked);margin-left:12px">✗ ${failed} failed</span>` : ''}</div>`;
        toast(`Imported ${created} items`, 'success');
        if (window.__app?.loadItemsBadge)
            window.__app.loadItemsBadge();
    }
    catch (err) {
        statusEl.innerHTML = `<div style="color:var(--status-blocked);font-size:13px;padding:12px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
}
//# sourceMappingURL=export.js.map