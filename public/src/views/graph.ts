// ═══════════════════════════════════════════════════════════════
// GRAPH VIEW — Knowledge & dependency graph with force canvas
// ═══════════════════════════════════════════════════════════════
import { api } from '../api.js';
import { state } from '../state.js';
import type { GraphNode, GraphRelationship, ProjectGraph } from '../types.js';
import { escHtml } from '../utils.js';
import { GraphCanvas, type CanvasNode, type CanvasEdge } from './graph-canvas.js';

type GraphResponse = {
  graph?: ProjectGraph;
  extensionAvailable?: boolean;
  extensionError?: string;
};

type GraphFilter = {
  query:     string;
  kind:      'all' | 'items' | 'facets' | 'external' | 'unlinked';
  rel:       string;
  direction: 'all' | 'incoming' | 'outgoing' | 'connected';
  scope:     'all' | 'focus';
  depth:     '1' | '2';
};

// ── Module state ──────────────────────────────────────────────
let currentGraph: GraphResponse | null = null;
let selectedNodeId = '';
// Object wrapper prevents TypeScript from narrowing via assignment tracking
const canvasRef: { current: GraphCanvas | null } = { current: null };
let physicsLabel = 'Pause Physics';

let filter: GraphFilter = {
  query:     '',
  kind:      'all',
  rel:       'all',
  direction: 'all',
  scope:     'all',
  depth:     '1',
};

// ── Node helpers ──────────────────────────────────────────────
function nodeTitle(node: GraphNode): string {
  return String(node.properties?.title || node.id);
}

function nodeType(node: GraphNode): string {
  return String(
    node.properties?.kind
    || node.properties?.type
    || node.labels?.find((l) => l !== 'PmItem' && l !== 'PmFacet')
    || 'Item',
  );
}

function nodeStatus(node: GraphNode): string {
  return String(node.properties?.status || 'unknown');
}

function isItemNode(node: GraphNode): boolean {
  return Boolean(node.labels?.includes('PmItem') || !node.id.includes(':'));
}

function isFacetNode(node: GraphNode): boolean {
  return Boolean(node.labels?.includes('PmFacet'));
}

function nodeLane(node: GraphNode): CanvasNode['lane'] {
  if (isFacetNode(node)) return 'facet';
  if (node.labels?.includes('ExternalPmItem')) return 'external';
  return 'item';
}

function compactError(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { title?: string; detail?: string; code?: string };
    return parsed.detail || parsed.title || parsed.code || '';
  } catch {
    return raw.replace(/\s+/g, ' ').trim();
  }
}

// ── Graph data processing ─────────────────────────────────────

function directNeighborIds(nodeId: string, rels: GraphRelationship[]): Set<string> {
  const ids = new Set<string>([nodeId]);
  for (const r of rels) {
    if (r.from === nodeId) ids.add(r.to);
    if (r.to   === nodeId) ids.add(r.from);
  }
  return ids;
}

function expandedNeighborIds(nodeId: string, rels: GraphRelationship[], depth: number): Set<string> {
  const ids = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const r of rels) {
      if (frontier.has(r.from) && !ids.has(r.to))   next.add(r.to);
      if (frontier.has(r.to)   && !ids.has(r.from)) next.add(r.from);
    }
    for (const id of next) ids.add(id);
    frontier = next;
    if (!frontier.size) break;
  }
  return ids;
}

function degreeMap(rels: GraphRelationship[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rels) {
    m.set(r.from, (m.get(r.from) || 0) + 1);
    m.set(r.to,   (m.get(r.to)   || 0) + 1);
  }
  return m;
}

function visibleGraph(graph: ProjectGraph): { nodes: GraphNode[]; rels: GraphRelationship[]; connected: Set<string> } {
  const nodes = graph.nodes || [];
  const rels   = graph.relationships || [];
  const connected = new Set(rels.flatMap((r) => [r.from, r.to]));

  const focusIds = selectedNodeId && filter.scope === 'focus'
    ? expandedNeighborIds(selectedNodeId, rels, Number(filter.depth))
    : null;

  const q = filter.query.trim().toLowerCase();

  const nodeVisible = (n: GraphNode): boolean => {
    if (focusIds && !focusIds.has(n.id)) return false;
    if (filter.kind === 'items'    && !isItemNode(n))                          return false;
    if (filter.kind === 'facets'   && !isFacetNode(n))                        return false;
    if (filter.kind === 'external' && !n.labels?.includes('ExternalPmItem'))  return false;
    if (filter.kind === 'unlinked' && (!isItemNode(n) || connected.has(n.id))) return false;
    if (!q) return true;
    const hay = [n.id, nodeTitle(n), nodeType(n), nodeStatus(n),
      (n.properties?.tags as string[] | undefined)?.join(' ') || ''].join(' ').toLowerCase();
    return hay.includes(q);
  };

  const visNodes = nodes.filter(nodeVisible);
  const visIds   = new Set(visNodes.map((n) => n.id));

  const visRels = rels.filter((r) => {
    if (!visIds.has(r.from) || !visIds.has(r.to)) return false;
    if (filter.rel !== 'all' && r.type !== filter.rel) return false;
    if (!selectedNodeId || filter.direction === 'all') return true;
    if (filter.direction === 'incoming') return r.to   === selectedNodeId;
    if (filter.direction === 'outgoing') return r.from === selectedNodeId;
    return r.from === selectedNodeId || r.to === selectedNodeId;
  });

  return { nodes: visNodes, rels: visRels, connected };
}

// ── Canvas data conversion ────────────────────────────────────

function toCanvasNodes(nodes: GraphNode[], rels: GraphRelationship[]): CanvasNode[] {
  const deg = degreeMap(rels);
  return nodes.map((n) => ({
    id:     n.id,
    label:  nodeTitle(n),
    type:   nodeType(n),
    status: nodeStatus(n),
    lane:   nodeLane(n),
    degree: deg.get(n.id) || 0,
  }));
}

function toCanvasEdges(rels: GraphRelationship[]): CanvasEdge[] {
  return rels.map((r) => ({ from: r.from, to: r.to, type: r.type }));
}

// ── Info panel rendering ──────────────────────────────────────

function renderCoverage(
  itemNodes: GraphNode[],
  rels: GraphRelationship[],
  connected: Set<string>,
  relCounts: Record<string, number>,
): string {
  const linked    = itemNodes.filter((n) => connected.has(n.id)).length;
  const linkedPct = itemNodes.length > 0 ? Math.round((linked / itemNodes.length) * 100) : 0;
  const external  = new Set(
    rels.flatMap((r) => [r.from, r.to]).filter((id) => id.includes(':external') || id.startsWith('external:'))
  ).size;
  const top = Object.entries(relCounts).sort((a, b) => b[1] - a[1])[0];
  return `
    <div class="graph-coverage-grid">
      <div class="graph-coverage-card"><span>Linked</span><strong>${linkedPct}%</strong><em>${linked} of ${itemNodes.length} items</em></div>
      <div class="graph-coverage-card"><span>External refs</span><strong>${external}</strong><em>Cross-project</em></div>
      <div class="graph-coverage-card"><span>Top relation</span><strong>${escHtml(top?.[0] || 'None')}</strong><em>${top?.[1] ?? 0} edges</em></div>
    </div>`;
}

function renderSelectedNode(
  node: GraphNode | undefined,
  rels: GraphRelationship[],
  byId: Map<string, GraphNode>,
): string {
  if (!node) return '<div class="graph-node-empty">Click any node in the graph to inspect it.</div>';

  const outgoing = rels.filter((r) => r.from === node.id);
  const incoming = rels.filter((r) => r.to   === node.id);
  const direct   = [...outgoing, ...incoming];

  const props = [
    ['Status',   nodeStatus(node)],
    ['Type',     nodeType(node)],
    ['Priority', node.properties?.priority ?? ''],
    ['Assignee', node.properties?.assignee ?? ''],
    ['Sprint',   node.properties?.sprint   ?? ''],
    ['Release',  node.properties?.release  ?? ''],
    ['Deadline', node.properties?.deadline ?? ''],
    ['Updated',  node.properties?.updated_at ?? ''],
  ].filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');

  const tags = Array.isArray(node.properties?.tags)
    ? (node.properties.tags as unknown[]).map(String).filter(Boolean) : [];

  return `
    <div class="graph-selected">
      <div class="graph-selected-title">${escHtml(nodeTitle(node))}</div>
      <div class="graph-selected-meta">${escHtml(node.id)} · ${escHtml(nodeType(node))} · ${escHtml(nodeStatus(node))}</div>
      <div class="graph-selected-actions">
        ${isItemNode(node) ? `<button class="btn btn-secondary btn-sm" id="graph-open-selected">Open Item</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="graph-clear-selected">Clear</button>
      </div>
      <div class="graph-selected-counts"><span>${outgoing.length} outgoing</span><span>${incoming.length} incoming</span></div>
      <div class="graph-property-grid">
        ${props.map(([l, v]) => `<div class="graph-property-row"><span>${escHtml(String(l))}</span><strong>${escHtml(String(v))}</strong></div>`).join('')}
      </div>
      ${tags.length > 0 ? `<div class="graph-tag-list">${tags.map((t) => `<button class="graph-tag-chip" data-graph-query="${escHtml(t)}">${escHtml(t)}</button>`).join('')}</div>` : ''}
      <div class="graph-panel-title graph-panel-title-spaced">Direct Relationships</div>
      ${direct.length === 0
        ? '<div class="graph-node-empty">No relationships.</div>'
        : direct.slice(0, 14).map((r) => {
            const otherId = r.from === node.id ? r.to : r.from;
            const other   = byId.get(otherId);
            const dir     = r.from === node.id ? '→' : '←';
            return `<button class="graph-neighbor" data-graph-node-id="${escHtml(otherId)}"><span class="graph-rel-badge">${escHtml(r.type)}</span> ${dir} <strong>${escHtml(nodeTitle(other || { id: otherId }))}</strong></button>`;
          }).join('') + (direct.length > 14 ? `<div class="graph-limit-note">+${direct.length - 14} more — use Neighborhood for full view</div>` : '')}
    </div>`;
}

function renderPaths(
  node: GraphNode | undefined,
  rels: GraphRelationship[],
  byId: Map<string, GraphNode>,
): string {
  if (!node) return '<div class="graph-node-empty">Select a node to explore paths.</div>';
  const oneHop = directNeighborIds(node.id, rels);
  oneHop.delete(node.id);
  const twoHop = expandedNeighborIds(node.id, rels, 2);
  for (const id of oneHop) twoHop.delete(id);
  twoHop.delete(node.id);

  const chips = (ids: Set<string>) =>
    Array.from(ids).slice(0, 10).map((id) => {
      const t = byId.get(id);
      return `<button class="graph-path-chip" data-graph-node-id="${escHtml(id)}">${escHtml(nodeTitle(t || { id }))}</button>`;
    }).join('');

  return `
    <div class="graph-path-section"><div class="graph-path-label">One hop (${oneHop.size})</div><div class="graph-path-chips">${chips(oneHop) || '<span>None.</span>'}</div></div>
    <div class="graph-path-section"><div class="graph-path-label">Two hops (${twoHop.size})</div><div class="graph-path-chips">${chips(twoHop) || '<span>None.</span>'}</div></div>`;
}

function renderHubs(nodes: GraphNode[], rels: GraphRelationship[]): string {
  const deg = degreeMap(rels);
  const hubs = nodes.filter(isItemNode)
    .map((n) => ({ n, d: deg.get(n.id) || 0, out: rels.filter((r) => r.from === n.id).length, inn: rels.filter((r) => r.to === n.id).length }))
    .filter((e) => e.d > 0)
    .sort((a, b) => b.d - a.d || nodeTitle(a.n).localeCompare(nodeTitle(b.n)))
    .slice(0, 8);
  if (!hubs.length) return '<div class="graph-node-empty">No linked item hubs yet.</div>';
  return hubs.map((e) => `
    <button class="graph-insight-row" data-graph-node-id="${escHtml(e.n.id)}">
      <span><strong>${escHtml(nodeTitle(e.n))}</strong><em>${escHtml(e.n.id)}</em></span>
      <b>${e.d}</b>
      <small>${e.out}↑ ${e.inn}↓</small>
    </button>`).join('');
}

function renderInfoPanel(data: GraphResponse): string {
  const graph     = data.graph || {};
  const nodes     = graph.nodes || [];
  const rels      = graph.relationships || [];
  const byId      = new Map(nodes.map((n) => [n.id, n]));
  const connected = new Set(rels.flatMap((r) => [r.from, r.to]));
  const itemNodes = nodes.filter(isItemNode);
  const relCounts = rels.reduce<Record<string, number>>((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {});
  const selectedNode = selectedNodeId ? byId.get(selectedNodeId) : undefined;

  const typeCounts = nodes.reduce<Record<string, number>>((acc, n) => {
    const t = nodeType(n); acc[t] = (acc[t] || 0) + 1; return acc;
  }, {});

  return `
    <div class="graph-panel-title">Graph Coverage</div>
    ${renderCoverage(itemNodes, rels, connected, relCounts)}
    <div class="graph-panel-title graph-panel-title-spaced">Selected Node</div>
    ${renderSelectedNode(selectedNode, rels, byId)}
    <div class="graph-panel-title graph-panel-title-spaced">Neighborhood</div>
    ${renderPaths(selectedNode, rels, byId)}
    <div class="graph-panel-title graph-panel-title-spaced">Item Hubs</div>
    <div class="graph-insight-list">${renderHubs(nodes, rels)}</div>
    <div class="graph-panel-title graph-panel-title-spaced">Nodes by Type</div>
    <div class="graph-type-list">
      ${Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<div class="graph-type-row"><span>${escHtml(t)}</span><strong>${c}</strong></div>`).join('') || '<div class="graph-node-empty">No items.</div>'}
    </div>
    <div class="graph-panel-title graph-panel-title-spaced">Relationships by Type</div>
    <div class="graph-type-list">
      ${Object.entries(relCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<div class="graph-type-row"><span>${escHtml(t)}</span><strong>${c}</strong></div>`).join('') || '<div class="graph-node-empty">No relationships.</div>'}
    </div>`;
}

// ── Full graph HTML (static shell + canvas host) ──────────────

function renderGraphShell(data: GraphResponse): string {
  const graph     = data.graph || {};
  const nodes     = graph.nodes || [];
  const rels      = graph.relationships || [];
  const itemNodes = nodes.filter(isItemNode);
  const facetNodes = nodes.filter(isFacetNode);
  const connected = new Set(rels.flatMap((r) => [r.from, r.to]));
  const isolated  = itemNodes.filter((n) => !connected.has(n.id)).length;
  const relCounts = rels.reduce<Record<string, number>>((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {});
  const relOptions = Object.keys(relCounts).sort();
  const errText = compactError(data.extensionError);

  return `
    <div class="view-header">
      <div>
        <h1>Knowledge Graph</h1>
        <p class="view-subtitle">Interactive force-directed graph of dependencies, hierarchy, and metadata${data.extensionAvailable ? ' — powered by pm-graph + Neo4j' : ' — built-in fallback mode'}.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="graph-refresh" title="Reload graph data">↻ Refresh</button>
        <button class="btn btn-ghost btn-sm" id="graph-fit-btn" title="Fit all nodes in view">⊡ Fit</button>
        <button class="btn btn-secondary btn-sm" id="graph-physics-btn">${physicsLabel}</button>
      </div>
    </div>

    <div class="graph-status ${data.extensionAvailable ? 'graph-status-ok' : ''}">
      <div>
        <div class="graph-status-title">${data.extensionAvailable ? '✓ pm-graph (Neo4j)' : 'Built-in graph fallback'}</div>
        <div class="graph-status-text">
          ${data.extensionAvailable
            ? 'Data synced via pm-graph extension. Relationships auto-refresh on project changes.'
            : 'Graph derived from pm list-all — dependencies, parent links, tags, sprint, release, and assignee metadata.'}
          ${errText ? `<br><span class="graph-status-warning">⚠ ${escHtml(errText)}</span>` : ''}
        </div>
      </div>
      <code>${escHtml(graph.source || 'pm-web')}</code>
    </div>

    <div class="graph-stats">
      <div class="stat-card"><div class="stat-value">${itemNodes.length}</div><div class="stat-label">Items</div></div>
      <div class="stat-card"><div class="stat-value">${rels.length}</div><div class="stat-label">Relationships</div></div>
      <div class="stat-card"><div class="stat-value">${facetNodes.length}</div><div class="stat-label">Metadata nodes</div></div>
      <div class="stat-card"><div class="stat-value">${isolated}</div><div class="stat-label">Unlinked</div></div>
    </div>

    <div class="graph-toolbar" id="graph-toolbar">
      <div class="search-box-wrap graph-search">
        <span class="search-icon">⌕</span>
        <input class="search-input" id="graph-filter-query" type="text" placeholder="Search nodes…" value="${escHtml(filter.query)}">
      </div>
      <select class="form-select graph-filter-select" id="graph-filter-kind">
        ${[['all','All nodes'],['items','Items only'],['facets','Metadata only'],['external','External'],['unlinked','Unlinked']]
          .map(([v,l]) => `<option value="${v}"${filter.kind===v?' selected':''}>${l}</option>`).join('')}
      </select>
      <select class="form-select graph-filter-select" id="graph-filter-rel">
        <option value="all">All rel. types</option>
        ${relOptions.map((r) => `<option value="${escHtml(r)}"${filter.rel===r?' selected':''}>${escHtml(r)}</option>`).join('')}
      </select>
      <select class="form-select graph-filter-select" id="graph-filter-direction" ${selectedNodeId ? '' : 'disabled'}>
        ${[['all','Any direction'],['connected','All connected'],['outgoing','Outgoing →'],['incoming','← Incoming']]
          .map(([v,l]) => `<option value="${v}"${filter.direction===v?' selected':''}>${l}</option>`).join('')}
      </select>
      <select class="form-select graph-filter-select" id="graph-filter-depth" ${selectedNodeId && filter.scope==='focus' ? '' : 'disabled'}>
        <option value="1"${filter.depth==='1'?' selected':''}>1 hop</option>
        <option value="2"${filter.depth==='2'?' selected':''}>2 hops</option>
      </select>
      <button class="btn btn-ghost btn-sm graph-focus-btn" id="graph-scope-btn">
        ${filter.scope === 'focus' ? '⊙ Show All' : '⊕ Focus'}
      </button>
    </div>

    <div class="graph-layout">
      <section class="graph-panel graph-panel-canvas">
        <div class="graph-canvas-header">
          <div class="graph-panel-title" style="margin-bottom:0">Knowledge Graph</div>
          <div class="graph-canvas-hint">Click canvas to focus keyboard · Tab: next · ↑↓→: neighbors · F: fit · Dbl-click: open</div>
        </div>
        <div class="graph-canvas-host" id="graph-canvas-host"></div>
        <div class="graph-legend">
          <span><i class="legend-dot legend-item"></i>Item</span>
          <span><i class="legend-dot legend-facet"></i>Metadata</span>
          <span><i class="legend-dot legend-external"></i>External</span>
          <span class="legend-sep">·</span>
          <span><i class="legend-dot" style="background:#2dd4bf;box-shadow:0 0 4px #2dd4bf66"></i>open</span>
          <span><i class="legend-dot" style="background:#fb923c;box-shadow:0 0 4px #fb923c66"></i>in-progress</span>
          <span><i class="legend-dot" style="background:#f87171;box-shadow:0 0 4px #f8717166"></i>blocked</span>
          <span><i class="legend-dot" style="background:#64748b"></i>closed</span>
          <span><i class="legend-dot" style="background:#94a3b8"></i>draft</span>
        </div>
      </section>
      <section class="graph-panel" id="graph-info-panel">
        ${renderInfoPanel(data)}
      </section>
    </div>

    <section class="graph-panel graph-relationship-panel">
      <div class="graph-panel-title">All Visible Relationships</div>
      <div id="graph-rel-list">${renderRelList(data)}</div>
    </section>`;
}

function renderRelList(data: GraphResponse): string {
  const graph = data.graph || {};
  const nodes = graph.nodes || [];
  const byId  = new Map(nodes.map((n) => [n.id, n]));
  const { rels: visRels } = visibleGraph(graph);

  if (!visRels.length) return '<div class="empty-state"><div class="empty-state-text">No relationships match current filters.</div></div>';
  const rows = visRels.slice(0, 80).map((r) => {
    const from = byId.get(r.from);
    const to   = byId.get(r.to);
    return `
      <button class="graph-rel-row" data-graph-from-id="${escHtml(r.from)}" data-graph-to-id="${escHtml(r.to)}" data-graph-rel-type="${escHtml(r.type)}">
        <div><div class="graph-rel-title">${escHtml(nodeTitle(from || { id: r.from }))}</div><div class="graph-rel-id">${escHtml(r.from)}</div></div>
        <div class="graph-rel-type">${escHtml(r.type)}</div>
        <div><div class="graph-rel-title">${escHtml(nodeTitle(to || { id: r.to }))}</div><div class="graph-rel-id">${escHtml(r.to)}</div></div>
      </button>`;
  }).join('');
  const limitNote = visRels.length > 80
    ? `<div class="graph-limit-note">Showing 80 of ${visRels.length} relationships — use filters to narrow results.</div>`
    : '';
  return rows + limitNote;
}

// ── Canvas init / update ──────────────────────────────────────

function syncCanvas(): void {
  if (!canvasRef.current || !currentGraph) return;
  const graph   = currentGraph.graph || {};
  const { nodes: visNodes } = visibleGraph(graph);
  const visIds  = new Set(visNodes.map((n) => n.id));
  const useAll  = filter.kind === 'all' && !filter.query && filter.scope === 'all';

  canvasRef.current.setFilter({
    visibleNodeIds:    useAll ? null : visIds,
    selectedId:        selectedNodeId || null,
    query:             filter.query,
    highlightRelTypes: filter.rel !== 'all' ? new Set([filter.rel]) : new Set(),
  });

  // Fly to first search match
  if (filter.query && !selectedNodeId) {
    const q     = filter.query.toLowerCase();
    const match = visNodes.find(
      (n) => nodeTitle(n).toLowerCase().includes(q) || n.id.toLowerCase().includes(q),
    );
    if (match) canvasRef.current.jumpToNode(match.id);
  }
}

function initCanvas(): void {
  const host = document.getElementById('graph-canvas-host') as HTMLElement | null;
  if (!host || !currentGraph) return;

  canvasRef.current?.destroy();
  canvasRef.current = null;

  const graph = currentGraph.graph || {};
  const nodes = graph.nodes || [];
  const rels  = graph.relationships || [];

  canvasRef.current = new GraphCanvas(host, {
    onSelectNode(id) {
      selectedNodeId = id || '';
      filter = { ...filter, direction: 'all' };
      updateInfoPanel();
      syncCanvas();
    },
    onOpenNode(id) {
      (window as unknown as { __app: { openItemDetail(id: string): void } }).__app.openItemDetail(id);
    },
  });

  canvasRef.current.setData(toCanvasNodes(nodes, rels), toCanvasEdges(rels));
  syncCanvas();
}

// ── Panel update (no canvas teardown) ────────────────────────

function updateInfoPanel(): void {
  if (!currentGraph) return;
  const panel = document.getElementById('graph-info-panel');
  if (panel) panel.innerHTML = renderInfoPanel(currentGraph);
  const relList = document.getElementById('graph-rel-list');
  if (relList) relList.innerHTML = renderRelList(currentGraph);
  bindInfoPanelEvents();
  updateToolbarState();
}

function updateToolbarState(): void {
  const dirSel  = document.getElementById('graph-filter-direction') as HTMLSelectElement | null;
  const depthSel = document.getElementById('graph-filter-depth') as HTMLSelectElement | null;
  const scopeBtn = document.getElementById('graph-scope-btn');
  if (dirSel)   dirSel.disabled   = !selectedNodeId;
  if (depthSel) depthSel.disabled = !(selectedNodeId && filter.scope === 'focus');
  if (scopeBtn) scopeBtn.textContent = filter.scope === 'focus' ? 'Show All' : 'Focus Neighbors';
}

// ── Event bindings ────────────────────────────────────────────

function bindInfoPanelEvents(): void {
  document.getElementById('graph-open-selected')?.addEventListener('click', () => {
    if (selectedNodeId) (window as unknown as { __app: { openItemDetail(id: string): void } }).__app.openItemDetail(selectedNodeId);
  });
  document.getElementById('graph-clear-selected')?.addEventListener('click', () => {
    selectedNodeId = '';
    filter = { ...filter, scope: 'all', direction: 'all' };
    canvasRef.current?.setSelected(null);
    updateInfoPanel();
    syncCanvas();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-graph-node-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedNodeId = btn.dataset.graphNodeId || '';
      canvasRef.current?.setSelected(selectedNodeId || null);
      updateInfoPanel();
      syncCanvas();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-graph-query]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = { ...filter, query: btn.dataset.graphQuery || '' };
      const inp = document.getElementById('graph-filter-query') as HTMLInputElement | null;
      if (inp) inp.value = filter.query;
      updateInfoPanel();
      syncCanvas();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-graph-from-id][data-graph-to-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const toId = btn.dataset.graphToId || '';
      selectedNodeId = toId;
      canvasRef.current?.setSelected(toId);
      updateInfoPanel();
      syncCanvas();
    });
  });
}

function bindToolbarEvents(): void {
  document.getElementById('graph-refresh')?.addEventListener('click', () => {
    canvasRef.current?.destroy();
    canvasRef.current = null;
    void renderGraphView();
  });

  document.getElementById('graph-fit-btn')?.addEventListener('click', () => canvasRef.current?.fitView());

  document.getElementById('graph-physics-btn')?.addEventListener('click', (e) => {
    const paused = canvasRef.current?.togglePhysics() ?? false;
    physicsLabel = paused ? 'Resume Physics' : 'Pause Physics';
    (e.target as HTMLButtonElement).textContent = physicsLabel;
  });

  document.getElementById('graph-scope-btn')?.addEventListener('click', () => {
    filter = { ...filter, scope: filter.scope === 'focus' ? 'all' : 'focus' };
    updateInfoPanel();
    syncCanvas();
  });

  const onFilterChange = (id: string, key: keyof GraphFilter, getValue: (el: HTMLElement) => string) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      const val = getValue(e.target as HTMLElement) as GraphFilter[typeof key];
      filter = { ...filter, [key]: val };
      if (key === 'rel') {
        canvasRef.current?.setFilter({ highlightRelTypes: val !== 'all' ? new Set([val as string]) : new Set() });
      }
      updateInfoPanel();
      syncCanvas();
    });
  };

  onFilterChange('graph-filter-kind',      'kind',      (el) => (el as HTMLSelectElement).value);
  onFilterChange('graph-filter-rel',       'rel',       (el) => (el as HTMLSelectElement).value);
  onFilterChange('graph-filter-direction', 'direction', (el) => (el as HTMLSelectElement).value);
  onFilterChange('graph-filter-depth',     'depth',     (el) => (el as HTMLSelectElement).value);

  const queryInput = document.getElementById('graph-filter-query') as HTMLInputElement | null;
  queryInput?.addEventListener('input', (e) => {
    filter = { ...filter, query: (e.target as HTMLInputElement).value };
    updateInfoPanel();
    syncCanvas();
  });
}

// ── Main entry point ──────────────────────────────────────────

export async function renderGraphView(): Promise<void> {
  const el = document.getElementById('content-graph');
  if (!el) return;

  if (!state.currentProject) {
    canvasRef.current?.destroy();
    canvasRef.current = null;
    el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Select a project to view its knowledge graph.</div></div>';
    return;
  }

  // Destroy existing canvas before wiping innerHTML
  canvasRef.current?.destroy();
  canvasRef.current = null;

  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div style="margin-top:12px;color:var(--text-muted);font-size:13px">Loading graph data…</div></div>';

  try {
    currentGraph = await api('GET', `/projects/${state.currentProject.id}/pm/graph`) as GraphResponse;
    selectedNodeId = '';
    filter = { query: '', kind: 'all', rel: 'all', direction: 'all', scope: 'all', depth: '1' };

    el.innerHTML = renderGraphShell(currentGraph);
    bindToolbarEvents();
    bindInfoPanelEvents();
    initCanvas();
  } catch (err: unknown) {
    const c = canvasRef.current as GraphCanvas | null;
    c?.destroy();
    canvasRef.current = null;
    el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Graph failed to load: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

/**
 * Lightweight refresh used by SSE item events — re-fetches graph data and
 * updates the canvas in-place without destroying zoom/pan state.
 * Falls back to a full renderGraphView if the canvas isn't initialized yet.
 */
export async function refreshGraphData(): Promise<void> {
  if (!state.currentProject || !canvasRef.current) {
    return renderGraphView();
  }
  try {
    const data = await api('GET', `/projects/${state.currentProject.id}/pm/graph`) as GraphResponse;
    currentGraph = data;
    const graph = data.graph || {};
    const nodes = graph.nodes || [];
    const rels  = graph.relationships || [];
    canvasRef.current.setData(toCanvasNodes(nodes, rels), toCanvasEdges(rels));
    updateInfoPanel();
    syncCanvas();
  } catch {
    // Silently ignore — the user can hit Refresh manually
  }
}
