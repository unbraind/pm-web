// ═══════════════════════════════════════════════════════════════
// GRAPH VIEW — Obsidian-quality immersive knowledge & dependency graph
// ═══════════════════════════════════════════════════════════════
import { api } from '../api.js';
import { state } from '../state.js';
import type { GraphNode, GraphRelationship, ProjectGraph } from '../types.js';
import { escHtml } from '../utils.js';
import { GraphCanvas, type CanvasNode, type CanvasEdge, type LayoutMode } from './graph-canvas.js';

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
  colorMode: 'status' | 'type' | 'tag';
  depMode:   boolean;
  layout:    LayoutMode;
  edgeBundling: boolean;
};

// ── Module state ──────────────────────────────────────────────
let currentGraph: GraphResponse | null = null;
let selectedNodeId = '';
const canvasRef: { current: GraphCanvas | null } = { current: null };
let physicsLabel = 'Pause Physics';
let infoDrawerOpen = false;
let relDrawerOpen  = false;
let filterOpen     = false;

let filter: GraphFilter = {
  query:     '',
  kind:      'all',
  rel:       'all',
  direction: 'all',
  scope:     'all',
  depth:     '1',
  colorMode: 'status',
  depMode:   false,
  layout:    'force',
  edgeBundling: false,
};

let selectedItemCache: Record<string, unknown> | null = null;
let criticalPath: Set<string> = new Set();

const DEP_REL_TYPES = new Set(['DEPENDS_ON', 'BLOCKED_BY', 'BLOCKS']);

// ── Context menu ──────────────────────────────────────────────
let ctxMenuEl: HTMLDivElement | null = null;

function removeCtxMenu(): void {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}

function showCtxMenu(nodeId: string, x: number, y: number): void {
  removeCtxMenu();
  const graph = currentGraph?.graph || {};
  const nodes = graph.nodes || [];
  const byId  = new Map(nodes.map((n) => [n.id, n]));
  const node  = byId.get(nodeId);
  const isItem = node ? isItemNode(node) : false;

  const menu = document.createElement('div');
  menu.className = 'graph-ctx-menu';
  menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  menu.style.top  = `${Math.min(y, window.innerHeight - 160)}px`;

  const btn = (icon: string, label: string, action: () => void, danger = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'graph-ctx-item' + (danger ? ' danger' : '');
    b.innerHTML = `<span style="opacity:0.6;font-size:11px">${icon}</span>${escHtml(label)}`;
    b.addEventListener('click', () => { removeCtxMenu(); action(); });
    return b;
  };

  if (isItem) {
    menu.appendChild(btn('⊡', 'Open Item', () => (window as unknown as { __app: { openItemDetail(id: string): void } }).__app.openItemDetail(nodeId)));
    const sep1 = document.createElement('div'); sep1.className = 'graph-ctx-sep'; menu.appendChild(sep1);
  }
  menu.appendChild(btn('⊙', 'Select & Focus', () => {
    selectedNodeId = nodeId;
    filter = { ...filter, scope: 'focus' };
    canvasRef.current?.setSelected(nodeId);
    updateInfoPanel();
    syncCanvas();
    updateFilterToolbarState();
    if (!infoDrawerOpen) {
      infoDrawerOpen = true;
      document.getElementById('graph-info-drawer')?.classList.add('open');
      document.getElementById('graph-info-toggle')?.classList.add('active');
    }
  }));
  menu.appendChild(btn('⊕', 'Show Neighborhood', () => {
    selectedNodeId = nodeId;
    filter = { ...filter, scope: 'focus', depth: '1' };
    canvasRef.current?.setSelected(nodeId);
    updateInfoPanel();
    syncCanvas();
    updateFilterToolbarState();
  }));
  menu.appendChild(btn('⊛', 'Expand 2 Hops', () => {
    selectedNodeId = nodeId;
    filter = { ...filter, scope: 'focus', depth: '2' };
    canvasRef.current?.setSelected(nodeId);
    updateInfoPanel();
    syncCanvas();
    updateFilterToolbarState();
  }));
  const sep2 = document.createElement('div'); sep2.className = 'graph-ctx-sep'; menu.appendChild(sep2);
  menu.appendChild(btn('⊞', 'Copy ID', () => { void navigator.clipboard?.writeText(nodeId); }));

  document.body.appendChild(menu);
  ctxMenuEl = menu;

  const dismiss = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      removeCtxMenu();
      document.removeEventListener('mousedown', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

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
    const message = parsed.detail || parsed.title || parsed.code || '';
    return message.includes('does not expose command path "pm-graph"') ? '' : message;
  } catch {
    const message = raw.replace(/\s+/g, ' ').trim();
    return message.includes('does not expose command path "pm-graph"') ? '' : message;
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

function isDependencyRel(rel: GraphRelationship): boolean {
  return DEP_REL_TYPES.has(rel.type);
}

function blockingPair(rel: GraphRelationship): { blocked: string; blocker: string } | null {
  if (rel.type === 'BLOCKS') return { blocked: rel.to, blocker: rel.from };
  if (rel.type === 'DEPENDS_ON' || rel.type === 'BLOCKED_BY') return { blocked: rel.from, blocker: rel.to };
  return null;
}

function computeCriticalPath(rels: GraphRelationship[]): Set<string> {
  const depRels = rels.filter(isDependencyRel);
  if (!depRels.length) return new Set();

  const blockedBy = new Map<string, Set<string>>();
  const allIds = new Set<string>();
  for (const r of depRels) {
    const pair = blockingPair(r);
    if (!pair) continue;
    if (!blockedBy.has(pair.blocked)) blockedBy.set(pair.blocked, new Set());
    blockedBy.get(pair.blocked)!.add(pair.blocker);
    allIds.add(pair.blocked);
    allIds.add(pair.blocker);
  }

  const memo = new Map<string, string[]>();
  function longestPathFrom(id: string, seen = new Set<string>()): string[] {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return [id];
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const prereqs = [...(blockedBy.get(id) ?? new Set<string>())];
    if (!prereqs.length) {
      memo.set(id, [id]);
      return [id];
    }
    const bestPrereq = prereqs
      .map((prereq) => longestPathFrom(prereq, nextSeen))
      .sort((a, b) => b.length - a.length)[0] ?? [];
    const path = [id, ...bestPrereq];
    memo.set(id, path);
    return path;
  }

  const longest = [...allIds]
    .map((id) => longestPathFrom(id))
    .sort((a, b) => b.length - a.length)[0] ?? [];
  return longest.length < 2 ? new Set() : new Set(longest);
}

function blockerStats(rels: GraphRelationship[]): Map<string, { blockers: Set<string>; blocked: Set<string> }> {
  const stats = new Map<string, { blockers: Set<string>; blocked: Set<string> }>();
  const entry = (id: string) => {
    if (!stats.has(id)) stats.set(id, { blockers: new Set(), blocked: new Set() });
    return stats.get(id)!;
  };
  for (const rel of rels) {
    const pair = blockingPair(rel);
    if (!pair) continue;
    entry(pair.blocked).blockers.add(pair.blocker);
    entry(pair.blocker).blocked.add(pair.blocked);
  }
  return stats;
}

function visibleGraph(graph: ProjectGraph): { nodes: GraphNode[]; rels: GraphRelationship[]; connected: Set<string> } {
  const nodes = graph.nodes || [];
  let rels     = graph.relationships || [];
  const connected = new Set(rels.flatMap((r) => [r.from, r.to]));

  // Dep mode: restrict to dependency/block edges
  if (filter.depMode) {
    rels = rels.filter(isDependencyRel);
  }

  const focusIds = selectedNodeId && filter.scope === 'focus'
    ? expandedNeighborIds(selectedNodeId, rels, Number(filter.depth))
    : null;

  const q = filter.query.trim().toLowerCase();

  const depConnected = filter.depMode
    ? new Set(rels.flatMap((r) => [r.from, r.to]))
    : null;

  const nodeVisible = (n: GraphNode): boolean => {
    if (depConnected && !depConnected.has(n.id)) return false;
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
    tags:   Array.isArray(n.properties?.tags)
      ? (n.properties.tags as unknown[]).map(String)
      : [],
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
  const unlinked  = itemNodes.length - linked;
  const external  = new Set(
    rels.flatMap((r) => [r.from, r.to]).filter((id) => id.includes(':external') || id.startsWith('external:'))
  ).size;
  const top = Object.entries(relCounts).sort((a, b) => b[1] - a[1])[0];
  const topRelLabel = top?.[0]
    ? top[0].replace(/^HAS_/, '').replace(/_/g, ' ').slice(0, 8)
    : 'None';
  return `
    <div class="graph-coverage-grid">
      <div class="graph-coverage-card">
        <span>Linked</span>
        <strong>${linkedPct}%</strong>
        <div class="graph-coverage-bar"><div class="graph-coverage-fill" style="width:${linkedPct}%"></div></div>
        <em>${linked} of ${itemNodes.length} items</em>
      </div>
      <div class="graph-coverage-card">
        <span>External</span>
        <strong>${external}</strong>
        <em>Cross-project refs</em>
      </div>
      <div class="graph-coverage-card" title="${escHtml(top?.[0] || 'None')} (${top?.[1] ?? 0} edges)">
        <span>Top rel</span>
        <strong>${escHtml(topRelLabel)}</strong>
        <em>${top?.[1] ?? 0} edges</em>
      </div>
    </div>`;
}

function renderSelectedNode(
  node: GraphNode | undefined,
  rels: GraphRelationship[],
  byId: Map<string, GraphNode>,
  fullItem?: Record<string, unknown>,
): string {
  if (!node) return '<div class="graph-node-empty">Click any node in the graph to inspect it.</div>';

  const outgoing = rels.filter((r) => r.from === node.id);
  const incoming = rels.filter((r) => r.to   === node.id);
  const direct   = [...outgoing, ...incoming];
  const blocks = blockerStats(rels).get(node.id) ?? { blockers: new Set<string>(), blocked: new Set<string>() };

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
      ${blocks.blockers.size || blocks.blocked.size ? `
      <div class="graph-blocker-strip">
        <span><strong>${blocks.blockers.size}</strong> blockers</span>
        <span><strong>${blocks.blocked.size}</strong> blocked by this</span>
        ${criticalPath.has(node.id) ? '<span class="critical">critical path</span>' : ''}
      </div>` : ''}
      <div class="graph-property-grid">
        ${props.map(([l, v]) => `<div class="graph-property-row"><span>${escHtml(String(l))}</span><strong>${escHtml(String(v))}</strong></div>`).join('')}
      </div>
      ${tags.length > 0 ? `<div class="graph-tag-list">${tags.map((t) => `<button class="graph-tag-chip" data-graph-query="${escHtml(t)}">${escHtml(t)}</button>`).join('')}</div>` : ''}
      ${fullItem?.body ? `
  <div class="graph-panel-title graph-panel-title-spaced">Description</div>
  <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;max-height:120px;overflow-y:auto;padding:8px;background:rgba(15,23,42,0.5);border-radius:6px;border:1px solid rgba(148,163,184,0.1)">${escHtml(String(fullItem.body).slice(0,500))}${String(fullItem.body).length > 500 ? '…' : ''}</div>
` : ''}
      ${blocks.blockers.size || blocks.blocked.size ? `
      <div class="graph-panel-title graph-panel-title-spaced">Blockers</div>
      <div class="graph-blocker-list">
        ${[...blocks.blockers].slice(0, 8).map((id) => `<button class="graph-blocker-row blocker" data-graph-node-id="${escHtml(id)}"><span>Blocked by</span><strong>${escHtml(nodeTitle(byId.get(id) || { id }))}</strong></button>`).join('')}
        ${[...blocks.blocked].slice(0, 8).map((id) => `<button class="graph-blocker-row blocked" data-graph-node-id="${escHtml(id)}"><span>Blocks</span><strong>${escHtml(nodeTitle(byId.get(id) || { id }))}</strong></button>`).join('')}
      </div>` : ''}
      <div class="graph-panel-title graph-panel-title-spaced">Direct Relationships</div>
      ${direct.length === 0
        ? '<div class="graph-node-empty">No relationships.</div>'
        : direct.slice(0, 16).map((r) => {
            const otherId = r.from === node.id ? r.to : r.from;
            const other   = byId.get(otherId);
            const dir     = r.from === node.id ? '→' : '←';
            return `<button class="graph-neighbor" data-graph-node-id="${escHtml(otherId)}"><span class="graph-rel-badge">${escHtml(r.type)}</span> ${dir} <strong>${escHtml(nodeTitle(other || { id: otherId }))}</strong></button>`;
          }).join('') + (direct.length > 16 ? `<div class="graph-limit-note">+${direct.length - 16} more — use Focus scope to narrow</div>` : '')}
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

function renderBlockingInsights(nodes: GraphNode[], rels: GraphRelationship[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stats = blockerStats(rels);
  const rows = [...stats.entries()]
    .map(([id, value]) => ({ id, ...value, node: byId.get(id) }))
    .filter((row) => row.node && isItemNode(row.node) && (row.blockers.size || row.blocked.size))
    .sort((a, b) => b.blocked.size - a.blocked.size || b.blockers.size - a.blockers.size || nodeTitle(a.node!).localeCompare(nodeTitle(b.node!)))
    .slice(0, 8);
  if (!rows.length) return '<div class="graph-node-empty">No dependency blockers in this view.</div>';
  return rows.map((row) => `
    <button class="graph-insight-row${criticalPath.has(row.id) ? ' critical' : ''}" data-graph-node-id="${escHtml(row.id)}">
      <span><strong>${escHtml(nodeTitle(row.node!))}</strong><em>${escHtml(row.id)}</em></span>
      <b>${row.blocked.size}</b>
      <small>${row.blockers.size} blockers · ${row.blocked.size} items blocked${criticalPath.has(row.id) ? ' · critical path' : ''}</small>
    </button>`).join('');
}

function renderInfoPanel(data: GraphResponse, fullItem?: Record<string, unknown>): string {
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
    ${renderSelectedNode(selectedNode, rels, byId, fullItem)}
    <div class="graph-panel-title graph-panel-title-spaced">Neighborhood</div>
    ${renderPaths(selectedNode, rels, byId)}
    <div class="graph-panel-title graph-panel-title-spaced">Item Hubs</div>
    <div class="graph-insight-list">${renderHubs(nodes, rels)}</div>
    <div class="graph-panel-title graph-panel-title-spaced">Dependency Blockers</div>
    <div class="graph-insight-list">${renderBlockingInsights(nodes, rels)}</div>
    <div class="graph-panel-title graph-panel-title-spaced">Nodes by Type</div>
    <div class="graph-type-list">
      ${Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<div class="graph-type-row"><span>${escHtml(t)}</span><strong>${c}</strong></div>`).join('') || '<div class="graph-node-empty">No items.</div>'}
    </div>
    <div class="graph-panel-title graph-panel-title-spaced">Relationships by Type</div>
    <div class="graph-type-list">
      ${Object.entries(relCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<div class="graph-type-row"><span>${escHtml(t)}</span><strong>${c}</strong></div>`).join('') || '<div class="graph-node-empty">No relationships.</div>'}
    </div>`;
}

// ── Rel list (inside bottom drawer) ──────────────────────────

function renderRelList(data: GraphResponse): string {
  const graph = data.graph || {};
  const nodes = graph.nodes || [];
  const byId  = new Map(nodes.map((n) => [n.id, n]));
  const { rels: visRels } = visibleGraph(graph);

  if (!visRels.length) return '<div class="graph-node-empty" style="padding:14px 0">No relationships match current filters.</div>';

  // Add/Remove dependency buttons
  const editBtns = `
    <div class="graph-rel-edit-bar">
      <button class="btn btn-secondary btn-sm" id="graph-add-dep-btn">+ Add Dependency</button>
      <button class="btn btn-ghost btn-sm" id="graph-remove-dep-btn">− Remove Dependency</button>
    </div>`;

  const rows = visRels.slice(0, 100).map((r) => {
    const from = byId.get(r.from);
    const to   = byId.get(r.to);
    return `
      <button class="graph-rel-row" data-graph-from-id="${escHtml(r.from)}" data-graph-to-id="${escHtml(r.to)}" data-graph-rel-type="${escHtml(r.type)}">
        <div><div class="graph-rel-title">${escHtml(nodeTitle(from || { id: r.from }))}</div><div class="graph-rel-id">${escHtml(r.from)}</div></div>
        <div class="graph-rel-type">${escHtml(r.type)}</div>
        <div><div class="graph-rel-title">${escHtml(nodeTitle(to || { id: r.to }))}</div><div class="graph-rel-id">${escHtml(r.to)}</div></div>
      </button>`;
  }).join('');
  const limitNote = visRels.length > 100
    ? `<div class="graph-limit-note" style="padding:10px 0">Showing 100 of ${visRels.length} — use filters to narrow.</div>`
    : '';
  return editBtns + rows + limitNote;
}

// ── Immersive shell ───────────────────────────────────────────

function renderGraphShell(data: GraphResponse): string {
  const graph      = data.graph || {};
  const nodes      = graph.nodes || [];
  const rels       = graph.relationships || [];
  const itemNodes  = nodes.filter(isItemNode);
  const facetNodes = nodes.filter(isFacetNode);
  const connected  = new Set(rels.flatMap((r) => [r.from, r.to]));
  const isolated   = itemNodes.filter((n) => !connected.has(n.id)).length;
  const relCounts  = rels.reduce<Record<string, number>>((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {});
  const relOptions = Object.keys(relCounts).sort();
  const errText    = compactError(data.extensionError);
  const { rels: visRels } = visibleGraph(graph);
  const depRels    = rels.filter(isDependencyRel);

  return `
    <div class="graph-immersive-wrap">

      <!-- Canvas (fills entire wrap) -->
      <div class="graph-canvas-host" id="graph-canvas-host"></div>

      <!-- Top HUD bar -->
      <div class="graph-hud-top">
        <div class="graph-hud-left">
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="graph-hud-btn graph-back-btn" id="graph-back-btn" title="Exit graph view" style="padding:4px 9px;font-size:11px">← Back</button>
            <div class="graph-hud-title">
              ◎ Knowledge Graph
              <span class="graph-mode-chip${data.extensionAvailable ? ' neo4j' : ''}">
                ${data.extensionAvailable ? 'neo4j' : 'built-in'}
              </span>
            </div>
          </div>
          <div class="graph-hud-stats">
            <span><b>${itemNodes.length}</b> items</span>
            <span><b>${rels.length}</b> edges</span>
            <span><b>${facetNodes.length}</b> facets</span>
            ${isolated > 0 ? `<span class="graph-hud-warn"><b>${isolated}</b> unlinked</span>` : ''}
          </div>
        </div>
        <div class="graph-hud-center">
          <div class="graph-search-hud">
            <span class="graph-search-hud-icon">⌕</span>
            <input class="graph-search-hud-input" id="graph-filter-query" type="text" placeholder="Search nodes…" value="${escHtml(filter.query)}" autocomplete="off">
          </div>
        </div>
        <div class="graph-hud-right">
          <button class="graph-hud-btn" id="graph-refresh" title="Reload graph">↻</button>
          <button class="graph-hud-btn" id="graph-fit-btn" title="Fit all nodes in view">⊡ Fit</button>
          <button class="graph-hud-btn" id="graph-physics-btn">${physicsLabel}</button>
          <button class="graph-hud-btn" id="graph-export-png" title="Export graph as PNG image">⊡ PNG</button>
          <div class="graph-hud-select-wrap">
            <select class="graph-hud-select" id="graph-layout-select" title="Layout mode">
              <option value="force"${filter.layout === 'force' ? ' selected' : ''}>Force</option>
              <option value="hierarchical"${filter.layout === 'hierarchical' ? ' selected' : ''}>Hierarchy</option>
            </select>
          </div>
          <button class="graph-hud-btn${filter.edgeBundling ? ' active' : ''}" id="graph-bundle-btn" title="Toggle edge bundling">⌁ Bundle</button>
          <button class="graph-hud-btn${filterOpen ? ' active' : ''}" id="graph-filter-toggle" title="Toggle filters">⚙ Filters</button>
          <button class="graph-hud-btn${infoDrawerOpen ? ' active' : ''}" id="graph-info-toggle" title="Toggle info panel">⊞ Info</button>
          <button class="graph-hud-btn${relDrawerOpen ? ' active' : ''}" id="graph-rel-toggle" title="Show all relationships">⇄ Rels</button>
        </div>
      </div>

      <!-- Filter overlay (bottom-left) -->
      <div class="graph-filter-overlay${filterOpen ? ' open' : ''}" id="graph-filter-overlay">
        <div class="graph-filter-overlay-header">
          <span>Filters</span>
          <button class="graph-filter-close-btn" id="graph-filter-close">✕</button>
        </div>
        <div class="graph-filter-overlay-body">
          <div class="graph-filter-row">
            <label>Color by</label>
            <select id="graph-color-mode">
              <option value="status"${filter.colorMode==='status'?' selected':''}>Status</option>
              <option value="type"${filter.colorMode==='type'?' selected':''}>Node type</option>
              <option value="tag"${filter.colorMode==='tag'?' selected':''}>Tags (auto)</option>
            </select>
          </div>
          <button class="graph-dep-mode-btn${filter.depMode ? ' active' : ''}" id="graph-dep-mode-btn">
            <span>Dependency Graph</span>
            <strong>${filter.depMode ? 'On' : 'Off'}</strong>
          </button>
          <div class="graph-filter-note">${depRels.length} dependency/blocking edges · ${criticalPath.size} critical-path nodes</div>
          <div class="graph-filter-row">
            <label>Show</label>
            <select id="graph-filter-kind">
              ${[['all','All nodes'],['items','Items only'],['facets','Metadata only'],['external','External'],['unlinked','Unlinked']]
                .map(([v,l]) => `<option value="${v}"${filter.kind===v?' selected':''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="graph-filter-row">
            <label>Relation</label>
            <select id="graph-filter-rel">
              <option value="all">All types</option>
              ${relOptions.map((r) => `<option value="${escHtml(r)}"${filter.rel===r?' selected':''}>${escHtml(r)}</option>`).join('')}
            </select>
          </div>
          <div class="graph-filter-row">
            <label>Direction</label>
            <select id="graph-filter-direction" ${selectedNodeId ? '' : 'disabled'}>
              ${[['all','Any direction'],['connected','All connected'],['outgoing','Outgoing →'],['incoming','← Incoming']]
                .map(([v,l]) => `<option value="${v}"${filter.direction===v?' selected':''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="graph-filter-row">
            <label>Depth</label>
            <select id="graph-filter-depth" ${selectedNodeId && filter.scope==='focus' ? '' : 'disabled'}>
              <option value="1"${filter.depth==='1'?' selected':''}>1 hop</option>
              <option value="2"${filter.depth==='2'?' selected':''}>2 hops</option>
            </select>
          </div>
          <button class="graph-scope-btn" id="graph-scope-btn">
            ${filter.scope === 'focus' ? '⊙ Show All Nodes' : '⊕ Focus on Selected'}
          </button>
          ${errText ? `<div style="margin-top:8px;font-size:11px;color:#fb923c;line-height:1.4">⚠ ${escHtml(errText)}</div>` : ''}
        </div>
      </div>

      <!-- Legend HUD (bottom-center) -->
      <div class="graph-legend-hud" id="graph-legend-hud">
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

      <!-- Info drawer (right side) -->
      <div class="graph-info-drawer${infoDrawerOpen ? ' open' : ''}" id="graph-info-drawer">
        <div class="graph-info-drawer-header">
          <span class="graph-info-drawer-title">Graph Analysis</span>
          <button class="graph-hud-btn" id="graph-info-close" style="height:26px;padding:3px 8px;font-size:12px">✕</button>
        </div>
        <div class="graph-info-drawer-body" id="graph-info-panel">
          ${renderInfoPanel(data)}
        </div>
      </div>

      <!-- Relationship drawer (bottom) -->
      <div class="graph-rel-drawer${relDrawerOpen ? ' open' : ''}" id="graph-rel-drawer">
        <div class="graph-rel-drawer-header">
          <span>Relationships (${visRels.length})</span>
          <button class="graph-filter-close-btn" id="graph-rel-close">✕</button>
        </div>
        <div class="graph-rel-drawer-body">
          <div id="graph-rel-list">${renderRelList(data)}</div>
        </div>
      </div>

    </div>`;
}

// ── Canvas init / update ──────────────────────────────────────

async function fetchAndUpdateSelectedItem(nodeId: string): Promise<void> {
  if (!state.currentProject || !nodeId) return;
  // Only fetch for item-lane nodes (not facets)
  const graph = currentGraph?.graph || {};
  const node = (graph.nodes || []).find((n) => n.id === nodeId);
  if (!node || !isItemNode(node)) {
    selectedItemCache = null;
    return;
  }
  try {
    const result = await api('GET', `/projects/${state.currentProject.id}/pm/get/${encodeURIComponent(nodeId)}`) as Record<string, unknown>;
    selectedItemCache = result.item as Record<string, unknown> ?? result ?? null;
    // Re-render panel with the full item
    if (currentGraph) {
      const panel = document.getElementById('graph-info-panel');
      if (panel) panel.innerHTML = renderInfoPanel(currentGraph, selectedItemCache ?? undefined);
      bindInfoPanelEvents();
    }
  } catch {
    selectedItemCache = null;
  }
}

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
    colorMode:         filter.colorMode,
    colorTag:          '',
    criticalPathIds:   filter.depMode ? criticalPath : new Set(),
  });

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
  criticalPath = computeCriticalPath(rels);

  canvasRef.current = new GraphCanvas(host, {
    layout: filter.layout,
    edgeBundling: filter.edgeBundling,
    onSelectNode(id) {
      selectedNodeId = id || '';
      filter = { ...filter, direction: 'all' };
      updateInfoPanel();
      syncCanvas();
      updateFilterToolbarState();
      // Auto-open info drawer when node selected
      if (id && !infoDrawerOpen) {
        infoDrawerOpen = true;
        document.getElementById('graph-info-drawer')?.classList.add('open');
        document.getElementById('graph-info-toggle')?.classList.add('active');
      }
      if (id) void fetchAndUpdateSelectedItem(id);
      else selectedItemCache = null;
    },
    onOpenNode(id) {
      (window as unknown as { __app: { openItemDetail(id: string): void } }).__app.openItemDetail(id);
    },
    onContextMenu(id, x, y) { showCtxMenu(id, x, y); },
  });

  canvasRef.current.setData(toCanvasNodes(nodes, rels), toCanvasEdges(rels));
  syncCanvas();
}

// ── Panel / drawer updates ────────────────────────────────────

function updateInfoPanel(): void {
  if (!currentGraph) return;
  const panel = document.getElementById('graph-info-panel');
  if (panel) panel.innerHTML = renderInfoPanel(currentGraph, selectedItemCache ?? undefined);
  const relList = document.getElementById('graph-rel-list');
  if (relList) relList.innerHTML = renderRelList(currentGraph);
  bindInfoPanelEvents();
}

function updateFilterToolbarState(): void {
  const dirSel   = document.getElementById('graph-filter-direction') as HTMLSelectElement | null;
  const depthSel = document.getElementById('graph-filter-depth') as HTMLSelectElement | null;
  const scopeBtn = document.getElementById('graph-scope-btn');
  if (dirSel)   dirSel.disabled   = !selectedNodeId;
  if (depthSel) depthSel.disabled = !(selectedNodeId && filter.scope === 'focus');
  if (scopeBtn) scopeBtn.textContent = filter.scope === 'focus' ? '⊙ Show All Nodes' : '⊕ Focus on Selected';
}

// ── Legend update ─────────────────────────────────────────────

const TYPE_COLORS_MAP: Record<string, string> = {
  task:'#2dd4bf', feature:'#60a5fa', epic:'#a78bfa', bug:'#f87171',
  milestone:'#fbbf24', story:'#34d399', chore:'#94a3b8', release:'#38bdf8',
};
const TAG_PALETTE_JS = ['#2dd4bf','#60a5fa','#a78bfa','#f87171','#fbbf24','#34d399','#fb923c','#e879f9'];

function computeTagColorMap(nodes: GraphNode[]): Map<string, string> {
  const freq = new Map<string, number>();
  for (const n of nodes) {
    const tags = Array.isArray(n.properties?.tags) ? (n.properties.tags as unknown[]).map(String) : [];
    for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_PALETTE_JS.length).map(([t]) => t);
  return new Map(top.map((t, i) => [t, TAG_PALETTE_JS[i]]));
}

function updateLegend(): void {
  const legend = document.getElementById('graph-legend-hud');
  if (!legend) return;
  const nodes = currentGraph?.graph?.nodes ?? [];

  if (filter.colorMode === 'type') {
    const typeCounts = nodes.filter(isItemNode).reduce<Record<string, number>>((acc, n) => {
      const t = nodeType(n); acc[t] = (acc[t] || 0) + 1; return acc;
    }, {});
    const shown = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    legend.innerHTML = `
      <span><i class="legend-dot legend-facet"></i>Metadata</span>
      <span><i class="legend-dot legend-external"></i>External</span>
      <span class="legend-sep">·</span>
      ${shown.map(([t]) => {
        const c = TYPE_COLORS_MAP[t.toLowerCase()] ?? '#64748b';
        return `<span><i class="legend-dot" style="background:${c};box-shadow:0 0 4px ${c}66"></i>${escHtml(t)}</span>`;
      }).join('')}
    `;
  } else if (filter.colorMode === 'tag') {
    const tagMap = computeTagColorMap(nodes);
    legend.innerHTML = `
      <span><i class="legend-dot legend-facet"></i>Metadata</span>
      <span><i class="legend-dot legend-external"></i>External</span>
      <span class="legend-sep">·</span>
      ${[...tagMap.entries()].slice(0, 6).map(([t, c]) =>
        `<span><i class="legend-dot" style="background:${c};box-shadow:0 0 4px ${c}66"></i>#${escHtml(t)}</span>`
      ).join('')}
      ${tagMap.size === 0 ? '<span style="color:var(--text-muted);font-size:11px">No tags</span>' : ''}
    `;
  } else {
    legend.innerHTML = `
      <span><i class="legend-dot legend-item"></i>Item</span>
      <span><i class="legend-dot legend-facet"></i>Metadata</span>
      <span><i class="legend-dot legend-external"></i>External</span>
      <span class="legend-sep">·</span>
      <span><i class="legend-dot" style="background:#2dd4bf;box-shadow:0 0 4px #2dd4bf66"></i>open</span>
      <span><i class="legend-dot" style="background:#fb923c;box-shadow:0 0 4px #fb923c66"></i>in-progress</span>
      <span><i class="legend-dot" style="background:#f87171;box-shadow:0 0 4px #f8717166"></i>blocked</span>
      <span><i class="legend-dot" style="background:#64748b"></i>closed</span>
      <span><i class="legend-dot" style="background:#94a3b8"></i>draft</span>
    `;
  }
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
    updateFilterToolbarState();
    pushGraphState();
  });

  // Add Dependency button
  document.getElementById('graph-add-dep-btn')?.addEventListener('click', () => {
    showAddDependencyModal();
  });

  // Remove Dependency button
  document.getElementById('graph-remove-dep-btn')?.addEventListener('click', () => {
    showRemoveDependencyModal();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-graph-node-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedNodeId = btn.dataset.graphNodeId || '';
      canvasRef.current?.setSelected(selectedNodeId || null);
      updateInfoPanel();
      syncCanvas();
      updateFilterToolbarState();
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
      updateFilterToolbarState();
    });
  });
}

function bindHudEvents(): void {
  // Back button
  document.getElementById('graph-back-btn')?.addEventListener('click', () => {
    removeCtxMenu();
    (window as unknown as { __app: { showView(v: string): void } }).__app.showView('items');
  });

  // Refresh
  document.getElementById('graph-refresh')?.addEventListener('click', () => {
    canvasRef.current?.destroy();
    canvasRef.current = null;
    void renderGraphView();
  });

  // Fit view
  document.getElementById('graph-fit-btn')?.addEventListener('click', () => canvasRef.current?.fitView());

  // Physics toggle
  document.getElementById('graph-physics-btn')?.addEventListener('click', (e) => {
    const paused = canvasRef.current?.togglePhysics() ?? false;
    physicsLabel = paused ? 'Resume Physics' : 'Pause Physics';
    (e.target as HTMLButtonElement).textContent = physicsLabel;
  });

  // Export PNG
  document.getElementById('graph-export-png')?.addEventListener('click', () => {
    canvasRef.current?.exportPng();
  });

  // Layout selector
  document.getElementById('graph-layout-select')?.addEventListener('change', (e) => {
    const layout = (e.target as HTMLSelectElement).value as LayoutMode;
    filter = { ...filter, layout };
    canvasRef.current?.setLayout(layout);
    pushGraphState();
  });

  // Edge bundling toggle
  document.getElementById('graph-bundle-btn')?.addEventListener('click', () => {
    filter = { ...filter, edgeBundling: !filter.edgeBundling };
    canvasRef.current?.setEdgeBundling(filter.edgeBundling);
    document.getElementById('graph-bundle-btn')?.classList.toggle('active', filter.edgeBundling);
  });

  // Filter toggle
  document.getElementById('graph-filter-toggle')?.addEventListener('click', () => {
    filterOpen = !filterOpen;
    document.getElementById('graph-filter-overlay')?.classList.toggle('open', filterOpen);
    document.getElementById('graph-filter-toggle')?.classList.toggle('active', filterOpen);
  });
  document.getElementById('graph-filter-close')?.addEventListener('click', () => {
    filterOpen = false;
    document.getElementById('graph-filter-overlay')?.classList.remove('open');
    document.getElementById('graph-filter-toggle')?.classList.remove('active');
  });

  // Info drawer toggle
  document.getElementById('graph-info-toggle')?.addEventListener('click', () => {
    infoDrawerOpen = !infoDrawerOpen;
    document.getElementById('graph-info-drawer')?.classList.toggle('open', infoDrawerOpen);
    document.getElementById('graph-info-toggle')?.classList.toggle('active', infoDrawerOpen);
  });
  document.getElementById('graph-info-close')?.addEventListener('click', () => {
    infoDrawerOpen = false;
    document.getElementById('graph-info-drawer')?.classList.remove('open');
    document.getElementById('graph-info-toggle')?.classList.remove('active');
  });

  // Rel drawer toggle
  document.getElementById('graph-rel-toggle')?.addEventListener('click', () => {
    relDrawerOpen = !relDrawerOpen;
    document.getElementById('graph-rel-drawer')?.classList.toggle('open', relDrawerOpen);
    document.getElementById('graph-rel-toggle')?.classList.toggle('active', relDrawerOpen);
  });
  document.getElementById('graph-rel-close')?.addEventListener('click', () => {
    relDrawerOpen = false;
    document.getElementById('graph-rel-drawer')?.classList.remove('open');
    document.getElementById('graph-rel-toggle')?.classList.remove('active');
  });

  // Scope (focus) button
  document.getElementById('graph-scope-btn')?.addEventListener('click', () => {
    filter = { ...filter, scope: filter.scope === 'focus' ? 'all' : 'focus' };
    updateInfoPanel();
    syncCanvas();
    updateFilterToolbarState();
  });

  // Filter selects
  const onFilterChange = (id: string, key: keyof GraphFilter, getValue: (el: HTMLElement) => string) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      const val = getValue(e.target as HTMLElement) as GraphFilter[typeof key];
      filter = { ...filter, [key]: val };
      if (key === 'rel') {
        canvasRef.current?.setFilter({ highlightRelTypes: val !== 'all' ? new Set([val as string]) : new Set() });
      }
      updateInfoPanel();
      syncCanvas();
      updateFilterToolbarState();
    });
  };

  onFilterChange('graph-filter-kind',      'kind',      (el) => (el as HTMLSelectElement).value);
  onFilterChange('graph-filter-rel',       'rel',       (el) => (el as HTMLSelectElement).value);
  onFilterChange('graph-filter-direction', 'direction', (el) => (el as HTMLSelectElement).value);
  onFilterChange('graph-filter-depth',     'depth',     (el) => (el as HTMLSelectElement).value);

  // All filter changes push URL state
  const origFilterChange = onFilterChange;
  document.querySelectorAll('#graph-filter-overlay select').forEach((sel) => {
    sel.addEventListener('change', () => pushGraphState());
  });

  document.getElementById('graph-dep-mode-btn')?.addEventListener('click', () => {
    filter = {
      ...filter,
      depMode: !filter.depMode,
      rel: filter.depMode ? filter.rel : 'all',
      kind: filter.depMode ? filter.kind : 'items',
    };
    updateInfoPanel();
    syncCanvas();
    updateFilterToolbarState();
    const btn = document.getElementById('graph-dep-mode-btn');
    btn?.classList.toggle('active', filter.depMode);
    const strong = btn?.querySelector('strong');
    if (strong) strong.textContent = filter.depMode ? 'On' : 'Off';
  });

  document.getElementById('graph-color-mode')?.addEventListener('change', (e) => {
    filter = { ...filter, colorMode: (e.target as HTMLSelectElement).value as GraphFilter['colorMode'] };
    syncCanvas();
    updateLegend();
  });

  // Search input
  const queryInput = document.getElementById('graph-filter-query') as HTMLInputElement | null;
  queryInput?.addEventListener('input', (e) => {
    filter = { ...filter, query: (e.target as HTMLInputElement).value };
    updateInfoPanel();
    syncCanvas();
  });
}

// ── URL routing (pushState) ─────────────────────────────────

function pushGraphState(): void {
  if (!state.currentProject) return;
  const params = new URLSearchParams();
  params.set('project', state.currentProject.id);
  params.set('graph', '1');
  if (selectedNodeId) params.set('node', selectedNodeId);
  if (filter.scope === 'focus') params.set('scope', 'focus');
  if (filter.kind !== 'all') params.set('kind', filter.kind);
  if (filter.colorMode !== 'status') params.set('color', filter.colorMode);
  if (filter.depMode) params.set('dep', '1');
  if (filter.layout !== 'force') params.set('layout', filter.layout);
  const qs = params.toString();
  const url = qs ? `?${qs}` : window.location.pathname;
  history.replaceState(null, '', url);
}

let urlStateRestored = false;

function restoreGraphState(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('graph')) return;
  urlStateRestored = true;
  if (params.has('node')) selectedNodeId = params.get('node') || '';
  if (params.has('scope')) filter = { ...filter, scope: params.get('scope') as 'focus' | 'all' };
  if (params.has('kind')) filter = { ...filter, kind: (params.get('kind') || 'all') as GraphFilter['kind'] };
  if (params.has('color')) filter = { ...filter, colorMode: (params.get('color') || 'status') as GraphFilter['colorMode'] };
  if (params.has('dep')) filter = { ...filter, depMode: params.get('dep') === '1' };
  if (params.has('layout')) filter = { ...filter, layout: (params.get('layout') || 'force') as LayoutMode };
}

// ── Dependency editing modals ────────────────────────────────

function showAddDependencyModal(): void {
  if (!state.currentProject || !currentGraph) return;
  const graph = currentGraph.graph || {};
  const nodes = (graph.nodes || []).filter(isItemNode);
  const options = nodes.map((n) => `<option value="${escHtml(n.id)}">${escHtml(nodeTitle(n))} (${escHtml(n.id)})</option>`).join('');

  const html = `
    <div class="modal-backdrop" id="graph-add-dep-modal" style="display:flex">
      <div class="modal" style="max-width:440px">
        <div class="modal-header">
          <div class="modal-title">Add Dependency</div>
          <button class="modal-close" onclick="document.getElementById('graph-add-dep-modal')?.remove()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Source item</label>
            <select class="form-select" id="graph-dep-from">${options}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Depends on (target)</label>
            <select class="form-select" id="graph-dep-to">${options}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Relationship type</label>
            <select class="form-select" id="graph-dep-type">
              <option value="blocked_by">Blocked by / depends on</option>
              <option value="blocks">Blocks</option>
              <option value="parent">Parent</option>
              <option value="child">Child</option>
              <option value="related">Related</option>
            </select>
          </div>
          <div id="graph-dep-error" class="form-error" style="display:none"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="document.getElementById('graph-add-dep-modal')?.remove()">Cancel</button>
          <button class="btn btn-primary" id="graph-dep-submit">Add</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  if (selectedNodeId) {
    const fromSel = document.getElementById('graph-dep-from') as HTMLSelectElement | null;
    if (fromSel) fromSel.value = selectedNodeId;
  }

  document.getElementById('graph-dep-submit')?.addEventListener('click', async () => {
    const fromId = (document.getElementById('graph-dep-from') as HTMLSelectElement)?.value;
    const toId = (document.getElementById('graph-dep-to') as HTMLSelectElement)?.value;
    const relType = (document.getElementById('graph-dep-type') as HTMLSelectElement)?.value;
    const errEl = document.getElementById('graph-dep-error');

    if (!fromId || !toId || fromId === toId) {
      if (errEl) { errEl.textContent = 'Select two different items.'; errEl.style.display = ''; }
      return;
    }

    try {
      await api('POST', `/projects/${state.currentProject!.id}/pm/rel`, { from: fromId, to: toId, type: relType });
      document.getElementById('graph-add-dep-modal')?.remove();
      // Refresh graph
      canvasRef.current?.destroy();
      canvasRef.current = null;
      void renderGraphView();
    } catch (err: unknown) {
      if (errEl) { errEl.textContent = err instanceof Error ? err.message : String(err); errEl.style.display = ''; }
    }
  });
}

function showRemoveDependencyModal(): void {
  if (!state.currentProject || !currentGraph) return;
  const graph = currentGraph.graph || {};
  const rels = graph.relationships || [];
  const depRels = rels.filter(isDependencyRel);
  const allRels = rels.length > depRels.length ? rels : depRels;

  const options = allRels.map((r, i) => {
    const nodes = graph.nodes || [];
    const from = nodes.find((n) => n.id === r.from);
    const to = nodes.find((n) => n.id === r.to);
    return `<option value="${i}">${escHtml(r.type)}: ${escHtml(nodeTitle(from || { id: r.from }))} → ${escHtml(nodeTitle(to || { id: r.to }))}</option>`;
  }).join('');

  if (!allRels.length) {
    (window as unknown as { __app: { toast(msg: string, type: string): void } }).__app.toast('No relationships to remove', 'info');
    return;
  }

  const html = `
    <div class="modal-backdrop" id="graph-remove-dep-modal" style="display:flex">
      <div class="modal" style="max-width:440px">
        <div class="modal-header">
          <div class="modal-title">Remove Relationship</div>
          <button class="modal-close" onclick="document.getElementById('graph-remove-dep-modal')?.remove()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Select relationship to remove</label>
            <select class="form-select" id="graph-remove-dep-select" size="8" style="min-height:140px">${options}</select>
          </div>
          <div id="graph-remove-dep-error" class="form-error" style="display:none"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="document.getElementById('graph-remove-dep-modal')?.remove()">Cancel</button>
          <button class="btn btn-danger" id="graph-remove-dep-submit">Remove</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  document.getElementById('graph-remove-dep-submit')?.addEventListener('click', async () => {
    const selIdx = parseInt((document.getElementById('graph-remove-dep-select') as HTMLSelectElement)?.value ?? '-1', 10);
    const errEl = document.getElementById('graph-remove-dep-error');
    const rel = allRels[selIdx];

    if (!rel) {
      if (errEl) { errEl.textContent = 'Select a relationship.'; errEl.style.display = ''; }
      return;
    }

    try {
      await api('DELETE', `/projects/${state.currentProject!.id}/pm/rel`, { from: rel.from, to: rel.to, type: rel.type });
      document.getElementById('graph-remove-dep-modal')?.remove();
      // Refresh graph
      canvasRef.current?.destroy();
      canvasRef.current = null;
      void renderGraphView();
    } catch (err: unknown) {
      if (errEl) { errEl.textContent = err instanceof Error ? err.message : String(err); errEl.style.display = ''; }
    }
  });
}

// ── Main entry point ──────────────────────────────────────────

export async function renderGraphView(): Promise<void> {
  const el = document.getElementById('content-graph');
  if (!el) return;

  if (!state.currentProject) {
    canvasRef.current?.destroy();
    canvasRef.current = null;
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:14px">Select a project to view its knowledge graph.</div>';
    return;
  }

  canvasRef.current?.destroy();
  canvasRef.current = null;

  el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text-muted);font-size:13px"><div class="loading-spinner"></div>Loading graph…</div>';

  // Restore state from URL on first load
  restoreGraphState();

  try {
    currentGraph = await api('GET', `/projects/${state.currentProject.id}/pm/graph`) as GraphResponse;
    selectedItemCache = null;
    if (!urlStateRestored) {
      selectedNodeId = '';
      filter = { query: '', kind: 'all', rel: 'all', direction: 'all', scope: 'all', depth: '1', colorMode: 'status', depMode: false, layout: 'force', edgeBundling: false };
    }
    criticalPath = computeCriticalPath(currentGraph.graph?.relationships ?? []);

    el.innerHTML = renderGraphShell(currentGraph);
    bindHudEvents();
    bindInfoPanelEvents();
    initCanvas();

    // Restore selected node after canvas init
    if (selectedNodeId) {
      (canvasRef.current as any)?.setSelected(selectedNodeId);
      updateInfoPanel();
      syncCanvas();
      // Auto-open info drawer when node is restored from URL
      if (!infoDrawerOpen) {
        infoDrawerOpen = true;
        document.getElementById('graph-info-drawer')?.classList.add('open');
        document.getElementById('graph-info-toggle')?.classList.add('active');
      }
    }

    pushGraphState();
  } catch (err: unknown) {
    (canvasRef.current as GraphCanvas | null)?.destroy();
    canvasRef.current = null;
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px">Graph failed to load: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

/**
 * Lightweight refresh from SSE events — updates graph data in-place
 * without destroying zoom/pan state.
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
    // Silently ignore — user can hit Refresh manually
  }
}
