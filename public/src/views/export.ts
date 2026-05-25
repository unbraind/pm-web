// ═══════════════════════════════════════════════════════════════
// EXPORT / IMPORT VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';

export async function renderExportView(): Promise<void> {
  const el = document.getElementById('content-export');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Export &amp; Import</div><div class="page-subtitle">${escHtml(state.currentProject.name)}</div></div>
    </div>
    <div style="max-width:600px;display:flex;flex-direction:column;gap:16px">
      <div class="export-card">
        <div class="export-card-icon">📥</div>
        <div class="export-card-info">
          <div class="export-card-title">Export as JSON</div>
          <div class="export-card-desc">Download all items with full metadata, body, tags, and all available fields</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.exportData('json')"><span>Export JSON</span></button>
      </div>
      <div class="export-card">
        <div class="export-card-icon">📊</div>
        <div class="export-card-info">
          <div class="export-card-title">Export as CSV</div>
          <div class="export-card-desc">Download items as a spreadsheet-compatible CSV file (includes body, parent, estimate)</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.exportData('csv')"><span>Export CSV</span></button>
      </div>
      <div class="export-card">
        <div class="export-card-icon">📋</div>
        <div class="export-card-info">
          <div class="export-card-title">Export as YAML</div>
          <div class="export-card-desc">Download items as a human-readable YAML file with all available fields</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.exportData('yaml')"><span>Export YAML</span></button>
      </div>
      <hr class="section-divider">
      <div class="export-card">
        <div class="export-card-icon">📤</div>
        <div class="export-card-info">
          <div class="export-card-title">Import from JSON or YAML</div>
          <div class="export-card-desc">Upload a previously exported JSON or YAML file to add items to this project (max 500 items)</div>
        </div>
        <label class="btn btn-secondary btn-sm" style="cursor:pointer">
          <span>Choose File</span>
          <input type="file" accept=".json,.yaml,.yml" style="display:none" onchange="window.__app.importData(this.files[0])">
        </label>
      </div>
      <div id="export-status" style="display:none"></div>
    </div>`;
}

export async function exportData(format: string): Promise<void> {
  const statusEl = document.getElementById('export-status');
  if (!state.currentProject || !statusEl) return;
  statusEl.style.display = '';
  statusEl.innerHTML = '<div class="loading-state" style="padding:16px"><div class="loading-spinner"></div></div>';
  try {
    // Use server-side export endpoint which fetches --full --include-body data
    const projectId = state.currentProject.id;
    const slug = state.currentProject.slug;
    const exportedAt = new Date().toISOString();

    if (format === 'csv') {
      // Fetch via the dedicated server-side export endpoint for CSV
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/pm/export?format=csv`, {
        credentials: 'include',
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Export failed' })) as { error?: string };
        throw new Error(err.error || `Export failed (${resp.status})`);
      }
      const content = await resp.text();
      const lineCount = content.split('\n').length - 1; // subtract header
      downloadFile(content, `${slug}-items.csv`, 'text/csv');
      statusEl.innerHTML = `<div style="color:var(--status-closed);font-size:13px;padding:12px">✓ Exported ${lineCount} items as CSV</div>`;
      toast(`Exported ${lineCount} items as CSV`, 'success');
      return;
    }

    // For JSON/YAML: fetch from list-all with all fields, then format client-side
    const data = await api('GET', `/projects/${projectId}/pm/list-all?limit=9999`);
    const items = (data as { items?: unknown[] }).items || [];
    if (items.length === 0) { statusEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">No items to export</div>'; return; }

    let content: string, filename: string, mime: string;

    if (format === 'yaml') {
      // YAML serializer — no external dependency needed for this structure
      const yamlVal = (v: unknown, indent: number): string => {
        const pad = '  '.repeat(indent);
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return String(v);
        if (Array.isArray(v)) {
          if (v.length === 0) return '[]';
          return '\n' + v.map((item) => `${pad}- ${yamlVal(item, indent + 1)}`).join('\n');
        }
        if (typeof v === 'object') {
          const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== null && val !== undefined);
          if (entries.length === 0) return '{}';
          return '\n' + entries.map(([k, val]) => {
            const valStr = yamlVal(val, indent + 1);
            return valStr.startsWith('\n') ? `${pad}${k}:${valStr}` : `${pad}${k}: ${valStr}`;
          }).join('\n');
        }
        // String: quote if contains special chars
        const str = String(v);
        if (str.includes('\n') || str.includes(':') || str.includes('#') || str.includes('"') || str.startsWith(' ') || str.endsWith(' ')) {
          return `"${str.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n')}"`;
        }
        return str || '""';
      };
      const yamlItems = items.map((item) => {
        const itemObj = item as Record<string, unknown>;
        const fields = Object.keys(itemObj).filter(f => itemObj[f] !== null && itemObj[f] !== undefined && itemObj[f] !== '');
        const lines: string[] = fields.map(f => {
          const valStr = yamlVal(itemObj[f], 1);
          return valStr.startsWith('\n') ? `  ${f}:${valStr}` : `  ${f}: ${valStr}`;
        });
        return '- ' + lines.join('\n').trimStart();
      });
      const header = `# pm-web export\n# project: ${state.currentProject.name}\n# exported_at: ${exportedAt}\n# version: "2.0"\nitems:\n`;
      content = header + yamlItems.join('\n');
      filename = `${slug}-items.yaml`;
      mime = 'text/yaml';
    } else {
      content = JSON.stringify({ exportedAt, project: state.currentProject.name, version: '2.0', items }, null, 2);
      filename = `${slug}-items.json`;
      mime = 'application/json';
    }
    downloadFile(content, filename, mime);
    statusEl.innerHTML = `<div style="color:var(--status-closed);font-size:13px;padding:12px">✓ Exported ${items.length} items as ${format.toUpperCase()}</div>`;
    toast(`Exported ${items.length} items`, 'success');
  } catch(err: unknown) {
    statusEl.innerHTML = `<div style="color:var(--status-blocked);font-size:13px;padding:12px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function downloadFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Parse a minimal YAML items list into an array of objects
// Handles the pm-web export YAML format (flat key: value under "- " list items)
function parseYamlItems(text: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  // Strip comment lines and find items block
  const lines = text.split('\n');
  let inItems = false;
  let current: Record<string, unknown> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = line.trimEnd();

    // Skip comments and empty lines before items block
    if (!inItems) {
      if (stripped.match(/^items\s*:/)) { inItems = true; }
      continue;
    }

    // List item start
    if (stripped.match(/^- /)) {
      if (current) items.push(current);
      current = {};
      const rest = stripped.slice(2).trim();
      if (rest) {
        const colonIdx = rest.indexOf(':');
        if (colonIdx > 0) {
          const k = rest.slice(0, colonIdx).trim();
          const v = rest.slice(colonIdx + 1).trim();
          current[k] = parseYamlValue(v);
        }
      }
    } else if (current && stripped.match(/^  [a-zA-Z_]/)) {
      // Continuation key under current item
      const inner = stripped.slice(2);
      const colonIdx = inner.indexOf(':');
      if (colonIdx > 0) {
        const k = inner.slice(0, colonIdx).trim();
        const v = inner.slice(colonIdx + 1).trim();
        if (v) {
          current[k] = parseYamlValue(v);
        }
      }
    }
  }
  if (current) items.push(current);
  return items;
}

function parseYamlValue(v: string): unknown {
  if (!v || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  // Quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  // Inline list
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  }
  return v;
}

export async function importData(file: File): Promise<void> {
  if (!file || !state.currentProject) return;
  const statusEl = document.getElementById('export-status');
  if (!statusEl) return;
  statusEl.style.display = '';
  statusEl.innerHTML = '<div class="loading-state" style="padding:16px"><div class="loading-spinner"></div></div>';
  try {
    const text = await file.text();
    const name = file.name.toLowerCase();
    let rawItems: unknown[] = [];

    if (name.endsWith('.yaml') || name.endsWith('.yml')) {
      rawItems = parseYamlItems(text);
      if (rawItems.length === 0) throw new Error('No items found in YAML file. Make sure the file has an "items:" list.');
    } else {
      // JSON
      const data = JSON.parse(text) as unknown;
      rawItems = Array.isArray(data) ? data : (Array.isArray((data as { items?: unknown[] }).items) ? (data as { items: unknown[] }).items : []);
      if (rawItems.length === 0) throw new Error('No items found in JSON file');
    }

    if (rawItems.length > 500) { throw new Error(`File contains ${rawItems.length} items — maximum is 500 per import`); }

    const items = rawItems.map((item: unknown) => {
      const i = item as Record<string, unknown>;
      const mapped: Record<string, string> = {
        title: String(i['title'] || 'Imported item'),
        type: String(i['type'] || 'Task'),
        priority: String(i['priority'] || 3),
      };
      if (i['description']) mapped['description'] = String(i['description']);
      if (i['status']) mapped['status'] = String(i['status']);
      if (i['tags']) mapped['tags'] = Array.isArray(i['tags']) ? (i['tags'] as string[]).join(',') : String(i['tags']);
      if (i['deadline']) mapped['deadline'] = String(i['deadline']);
      if (i['assignee']) mapped['assignee'] = String(i['assignee']);
      if (i['sprint']) mapped['sprint'] = String(i['sprint']);
      if (i['release']) mapped['release'] = String(i['release']);
      if (i['body']) mapped['body'] = String(i['body']);
      if (i['parent']) mapped['parent'] = String(i['parent']);
      if (i['estimate']) mapped['estimate'] = String(i['estimate']);
      return mapped;
    });

    const result = await api('POST', `/projects/${state.currentProject.id}/pm/import`, { items }) as { created?: string[]; errors?: string[]; total?: number };
    const created = result.created?.length ?? 0;
    const failed = result.errors?.length ?? 0;
    statusEl.innerHTML = `<div style="padding:12px;font-size:13px"><span style="color:var(--status-closed)">✓ Imported ${created} items</span>${failed ? `<span style="color:var(--status-blocked);margin-left:12px">✗ ${failed} failed</span>` : ''}</div>`;
    toast(`Imported ${created} items`, 'success');
    if ((window as unknown as { __app?: { loadItemsBadge?: () => void } }).__app?.loadItemsBadge) {
      (window as unknown as { __app: { loadItemsBadge: () => void } }).__app.loadItemsBadge();
    }
  } catch(err: unknown) {
    statusEl.innerHTML = `<div style="color:var(--status-blocked);font-size:13px;padding:12px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}
