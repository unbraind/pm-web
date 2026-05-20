// ═══════════════════════════════════════════════════════════════
// SEARCH VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { renderItemRow } from './items.js';
let searchTimer;
export function renderSearchView() {
    const el = document.getElementById('content-search');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    const modeOpts = [
        { val: 'hybrid', label: 'Hybrid', tip: 'Keyword + semantic (best)' },
        { val: 'semantic', label: 'Semantic', tip: 'Ollama qwen3 embeddings' },
        { val: 'keyword', label: 'Keyword', tip: 'Fast exact match' },
    ];
    el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Search</div><div class="page-subtitle">Search items in ${escHtml(state.currentProject.name)}</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
      <div style="display:flex;gap:4px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);padding:3px">
        ${modeOpts.map(m => `<button class="btn btn-sm" style="padding:4px 10px;border-radius:5px;font-size:12px;transition:var(--transition);${state.searchMode === m.val ? 'background:var(--bg-card);color:var(--text-primary)' : 'background:transparent;color:var(--text-muted)'}" onclick="window.__app.setSearchMode('${m.val}')" title="${m.tip}">${m.label}</button>`).join('')}
      </div>
      <button class="btn btn-secondary btn-sm" id="reindex-btn" onclick="window.__app.reindexProject()">⟳ Reindex</button>
      <span style="font-size:11px;color:var(--text-muted)">Semantic powered by Ollama qwen3</span>
    </div>
    <div class="search-box-wrap">
      <span class="search-icon">⌕</span>
      <input class="search-input" id="search-query" type="text" placeholder="Search items by title, description, tags…" value="${escHtml(state.searchQuery)}" oninput="window.__app.debouncedSearch()" onkeydown="if(event.key==='Enter')window.__app.doSearch()">
    </div>
    <div id="search-results">
      ${state.searchResults.length > 0 ? renderSearchResults() : '<div class="empty-state"><div class="empty-state-icon">⌕</div><div class="empty-state-text">Enter a query to search</div></div>'}
    </div>`;
    setTimeout(() => document.getElementById('search-query')?.focus(), 50);
}
export function setSearchMode(mode) {
    state.searchMode = mode;
    state.searchResults = [];
    renderSearchView();
    if (state.searchQuery)
        doSearch();
}
export async function reindexProject() {
    if (!state.currentProject)
        return;
    const btn = document.getElementById('reindex-btn');
    if (!btn)
        return;
    btn.disabled = true;
    btn.textContent = '⟳ Reindexing…';
    const mode = state.searchMode;
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/reindex`, { mode });
        toast(`Reindex complete (${mode})`, 'success');
    }
    catch (err) {
        toast(`Reindex failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    finally {
        btn.disabled = false;
        btn.textContent = '⟳ Reindex';
    }
}
export function debouncedSearch() {
    clearTimeout(searchTimer);
    state.searchQuery = document.getElementById('search-query')?.value || '';
    searchTimer = setTimeout(doSearch, 350);
}
export async function doSearch() {
    const query = (document.getElementById('search-query')?.value || '').trim();
    if (!query || !state.currentProject)
        return;
    state.searchQuery = query;
    const resultsEl = document.getElementById('search-results');
    if (resultsEl)
        resultsEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
    try {
        const data = await api('POST', `/projects/${state.currentProject.id}/pm/search`, { query, mode: state.searchMode });
        state.searchResults = data.results || data.items || [];
        if (resultsEl)
            resultsEl.innerHTML = state.searchResults.length === 0
                ? `<div class="empty-state"><div class="empty-state-text">No results for "${escHtml(query)}"</div></div>`
                : renderSearchResults();
    }
    catch (err) {
        if (resultsEl)
            resultsEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
function renderSearchResults() {
    if (!state.searchResults.length)
        return '';
    return `<div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${state.searchResults.length} result${state.searchResults.length !== 1 ? 's' : ''}</div>
    <div class="item-list">${state.searchResults.map(item => renderItemRow(item)).join('')}</div>`;
}
//# sourceMappingURL=search.js.map