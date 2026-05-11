import { api } from '../api.js';
import { state } from '../state.js';
import type { GraphNode, GraphRelationship, ProjectGraph } from '../types.js';
import { escHtml } from '../utils.js';

type GraphResponse = {
  graph?: ProjectGraph;
  extensionAvailable?: boolean;
  extensionError?: string;
};

type PositionedNode = GraphNode & {
  x: number;
  y: number;
  degree: number;
  lane: 'item' | 'facet' | 'external';
};

type GraphFilter = {
  query: string;
  kind: 'all' | 'items' | 'facets' | 'external' | 'unlinked';
  rel: string;
  direction: 'all' | 'incoming' | 'outgoing' | 'connected';
  layout: 'topology' | 'status' | 'type' | 'activity';
  scope: 'all' | 'focus';
  depth: '1' | '2';
  density: 'comfortable' | 'compact';
};

let currentGraph: GraphResponse | null = null;
let selectedNodeId = '';
let filter: GraphFilter = {
  query: '',
  kind: 'all',
  rel: 'all',
  direction: 'all',
  layout: 'topology',
  scope: 'all',
  depth: '1',
  density: 'comfortable',
};

function nodeTitle(node: GraphNode): string {
  return String(node.properties?.title || node.id);
}

function nodeType(node: GraphNode): string {
  return String(node.properties?.kind || node.properties?.type || node.labels?.find((label) => label !== 'PmItem' && label !== 'PmFacet') || 'Item');
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

function nodeLane(node: GraphNode): PositionedNode['lane'] {
  if (isFacetNode(node)) return 'facet';
  if (node.labels?.includes('ExternalPmItem')) return 'external';
  return 'item';
}

function relationshipCounts(relationships: GraphRelationship[]): Record<string, number> {
  return relationships.reduce<Record<string, number>>((acc, rel) => {
    acc[rel.type] = (acc[rel.type] || 0) + 1;
    return acc;
  }, {});
}

function lastUpdatedBucket(node: GraphNode): string {
  const raw = node.properties?.updated_at || node.properties?.created_at;
  if (typeof raw !== 'string') return 'No date';
  const time = new Date(raw).getTime();
  if (Number.isNaN(time)) return 'No date';
  const ageDays = (Date.now() - time) / 86_400_000;
  if (ageDays <= 7) return 'Last 7 days';
  if (ageDays <= 30) return 'Last 30 days';
  if (ageDays <= 90) return 'Last 90 days';
  return 'Older';
}

function graphBucket(node: GraphNode): string {
  if (filter.layout === 'status') {
    if (!isItemNode(node)) return nodeLane(node) === 'facet' ? 'Metadata' : 'External';
    return nodeStatus(node);
  }
  if (filter.layout === 'type') {
    return nodeType(node);
  }
  if (filter.layout === 'activity') {
    if (!isItemNode(node)) return nodeLane(node) === 'facet' ? 'Metadata' : 'External';
    return lastUpdatedBucket(node);
  }
  return nodeLane(node) === 'facet' ? 'Metadata' : nodeLane(node) === 'external' ? 'External' : 'Items';
}

function directNeighborIds(nodeId: string, relationships: GraphRelationship[]): Set<string> {
  const ids = new Set<string>([nodeId]);
  for (const rel of relationships) {
    if (rel.from === nodeId) ids.add(rel.to);
    if (rel.to === nodeId) ids.add(rel.from);
  }
  return ids;
}

function expandedNeighborIds(nodeId: string, relationships: GraphRelationship[], depth: number): Set<string> {
  const ids = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const rel of relationships) {
      if (frontier.has(rel.from) && !ids.has(rel.to)) next.add(rel.to);
      if (frontier.has(rel.to) && !ids.has(rel.from)) next.add(rel.from);
    }
    for (const id of next) ids.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }
  return ids;
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

function degreeMap(relationships: GraphRelationship[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const rel of relationships) {
    map.set(rel.from, (map.get(rel.from) || 0) + 1);
    map.set(rel.to, (map.get(rel.to) || 0) + 1);
  }
  return map;
}

function visibleGraph(graph: ProjectGraph): { nodes: GraphNode[]; relationships: GraphRelationship[]; connected: Set<string> } {
  const nodes = graph.nodes || [];
  const relationships = graph.relationships || [];
  const connected = new Set(relationships.flatMap((rel) => [rel.from, rel.to]));
  const focusIds = selectedNodeId && filter.scope === 'focus'
    ? expandedNeighborIds(selectedNodeId, relationships, Number(filter.depth))
    : null;
  const q = filter.query.trim().toLowerCase();

  const nodeMatches = (node: GraphNode): boolean => {
    if (focusIds && !focusIds.has(node.id)) return false;
    if (filter.kind === 'items' && !isItemNode(node)) return false;
    if (filter.kind === 'facets' && !isFacetNode(node)) return false;
    if (filter.kind === 'external' && !node.labels?.includes('ExternalPmItem')) return false;
    if (filter.kind === 'unlinked' && (!isItemNode(node) || connected.has(node.id))) return false;
    if (!q) return true;
    const haystack = [
      node.id,
      nodeTitle(node),
      nodeType(node),
      nodeStatus(node),
      (node.properties?.tags as string[] | undefined)?.join(' ') || '',
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  };

  const visibleNodes = nodes.filter(nodeMatches);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleRels = relationships.filter((rel) => {
    if (!visibleIds.has(rel.from) || !visibleIds.has(rel.to)) return false;
    if (filter.rel !== 'all' && rel.type !== filter.rel) return false;
    if (!selectedNodeId || filter.direction === 'all') return true;
    if (filter.direction === 'incoming') return rel.to === selectedNodeId;
    if (filter.direction === 'outgoing') return rel.from === selectedNodeId;
    return rel.from === selectedNodeId || rel.to === selectedNodeId;
  });

  return { nodes: visibleNodes, relationships: visibleRels, connected };
}

function positionNodes(nodes: GraphNode[], relationships: GraphRelationship[]): PositionedNode[] {
  const degrees = degreeMap(relationships);
  const ranked = [...nodes]
    .sort((a, b) => (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0) || nodeTitle(a).localeCompare(nodeTitle(b)))
    .slice(0, 64);

  const groups = new Map<string, GraphNode[]>();
  for (const node of ranked) {
    const key = graphBucket(node);
    groups.set(key, [...(groups.get(key) || []), node]);
  }
  const entries = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const groupCount = Math.max(entries.length, 1);

  return entries.flatMap(([_, groupNodes], groupIndex) => {
    const count = Math.max(groupNodes.length, 1);
    const groupCenterX = groupCount === 1 ? 50 : 24 + (groupIndex / (groupCount - 1)) * 52;
    const maxRows = 6;
    const columns = Math.max(1, Math.ceil(count / maxRows));
    const rows = Math.ceil(count / columns);
    const columnGap = Math.min(22, Math.max(18, 48 / Math.max(columns, 1)));
    return groupNodes.map((node, index) => {
      const column = Math.floor(index / rows);
      const row = index % rows;
      const jitter = Math.sin((index + 1) * 2.1 + groupIndex) * 1.6;
      return {
        ...node,
        x: Math.max(7, Math.min(93, groupCenterX + (column - (columns - 1) / 2) * columnGap + jitter)),
        y: 12 + ((row + 1) / (rows + 1)) * 76,
        degree: degrees.get(node.id) || 0,
        lane: nodeLane(node),
      };
    });
  });
}

function renderGraphMap(nodes: GraphNode[], relationships: GraphRelationship[]): string {
  const positioned = positionNodes(nodes, relationships);
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const selectedNeighbors = new Set<string>();
  if (selectedNodeId) {
    for (const rel of relationships) {
      if (rel.from === selectedNodeId) selectedNeighbors.add(rel.to);
      if (rel.to === selectedNodeId) selectedNeighbors.add(rel.from);
    }
  }

  const visibleRelationships = relationships
    .filter((rel) => byId.has(rel.from) && byId.has(rel.to))
    .slice(0, 160);

  if (positioned.length === 0) {
    return '<div class="empty-state"><div class="empty-state-text">No graph nodes match the current filters.</div></div>';
  }

  const buckets = Array.from(new Set(positioned.map(graphBucket))).slice(0, 8);

  return `
    <div class="graph-map graph-map-${filter.density}" aria-label="Knowledge graph map">
      <div class="graph-map-bands" aria-hidden="true">
        ${buckets.map((bucket, index) => `
          <div class="graph-map-band" style="left:${((index + 0.5) / buckets.length * 100).toFixed(2)}%">
            <span>${escHtml(bucket)}</span>
          </div>
        `).join('')}
      </div>
      <svg class="graph-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${visibleRelationships.map((rel) => {
          const from = byId.get(rel.from)!;
          const to = byId.get(rel.to)!;
          const highlighted = selectedNodeId && (rel.from === selectedNodeId || rel.to === selectedNodeId);
          return `<line class="${highlighted ? 'is-highlighted' : ''}" x1="${from.x.toFixed(2)}" y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" />`;
        }).join('')}
      </svg>
      ${positioned.map((node) => {
        const active = node.id === selectedNodeId;
        const related = selectedNeighbors.has(node.id);
        return `
          <button
            class="graph-map-node graph-map-node-${node.lane}${active ? ' is-active' : ''}${related ? ' is-related' : ''}"
            style="left:${node.x.toFixed(2)}%;top:${node.y.toFixed(2)}%"
            data-graph-node-id="${escHtml(node.id)}"
            title="${escHtml(nodeTitle(node))}"
          >
            <span>${escHtml(nodeTitle(node))}</span>
            <em>${escHtml(nodeType(node))}${node.degree ? ` · ${node.degree}` : ''}</em>
          </button>`;
      }).join('')}
    </div>
    <div class="graph-legend">
      <span><i class="legend-dot legend-item"></i>Items</span>
      <span><i class="legend-dot legend-facet"></i>Metadata</span>
      <span><i class="legend-dot legend-external"></i>External refs</span>
      <span><i class="legend-line"></i>Relationship</span>
    </div>
    ${nodes.length > positioned.length ? `<div class="graph-limit-note">Showing the ${positioned.length} most connected nodes out of ${nodes.length} matching nodes.</div>` : ''}`;
}

function renderRelationship(rel: GraphRelationship, nodesById: Map<string, GraphNode>): string {
  const from = nodesById.get(rel.from);
  const to = nodesById.get(rel.to);
  return `
    <button class="graph-rel-row" data-graph-rel-type="${escHtml(rel.type)}" data-graph-from-id="${escHtml(rel.from)}" data-graph-to-id="${escHtml(rel.to)}">
      <div>
        <div class="graph-rel-title">${escHtml(nodeTitle(from || { id: rel.from }))}</div>
        <div class="graph-rel-id">${escHtml(rel.from)}</div>
      </div>
      <div class="graph-rel-type">${escHtml(rel.type)}</div>
      <div>
        <div class="graph-rel-title">${escHtml(nodeTitle(to || { id: rel.to }))}</div>
        <div class="graph-rel-id">${escHtml(rel.to)}</div>
      </div>
    </button>`;
}

function renderHubList(nodes: GraphNode[], relationships: GraphRelationship[]): string {
  const degrees = degreeMap(relationships);
  const hubs = nodes
    .filter(isItemNode)
    .map((node) => ({
      node,
      degree: degrees.get(node.id) || 0,
      incoming: relationships.filter((rel) => rel.to === node.id).length,
      outgoing: relationships.filter((rel) => rel.from === node.id).length,
    }))
    .filter((entry) => entry.degree > 0)
    .sort((a, b) => b.degree - a.degree || nodeTitle(a.node).localeCompare(nodeTitle(b.node)))
    .slice(0, 8);

  if (hubs.length === 0) return '<div class="graph-node-empty">No connected item hubs yet.</div>';
  return hubs.map((entry) => `
    <button class="graph-insight-row" data-graph-node-id="${escHtml(entry.node.id)}">
      <span>
        <strong>${escHtml(nodeTitle(entry.node))}</strong>
        <em>${escHtml(entry.node.id)}</em>
      </span>
      <b>${entry.degree}</b>
      <small>${entry.outgoing} out · ${entry.incoming} in</small>
    </button>
  `).join('');
}

function renderCoverageSummary(
  itemNodes: GraphNode[],
  relationships: GraphRelationship[],
  connected: Set<string>,
  relCounts: Record<string, number>,
): string {
  const linkedItems = itemNodes.filter((node) => connected.has(node.id)).length;
  const linkedPct = itemNodes.length > 0 ? Math.round((linkedItems / itemNodes.length) * 100) : 0;
  const externalRefs = new Set(
    relationships
      .flatMap((rel) => [rel.from, rel.to])
      .filter((id) => id.includes(':external') || id.startsWith('external:'))
  ).size;
  const dominantRel = Object.entries(relCounts).sort((a, b) => b[1] - a[1])[0];

  return `
    <div class="graph-coverage-grid">
      <div class="graph-coverage-card">
        <span>Linked items</span>
        <strong>${linkedPct}%</strong>
        <em>${linkedItems} of ${itemNodes.length}</em>
      </div>
      <div class="graph-coverage-card">
        <span>External refs</span>
        <strong>${externalRefs}</strong>
        <em>Referenced outside this project</em>
      </div>
      <div class="graph-coverage-card">
        <span>Top relationship</span>
        <strong>${escHtml(dominantRel?.[0] || 'None')}</strong>
        <em>${dominantRel?.[1] ?? 0} edges</em>
      </div>
    </div>`;
}

function renderPathHints(node: GraphNode | undefined, relationships: GraphRelationship[], nodesById: Map<string, GraphNode>): string {
  if (!node) return '<div class="graph-node-empty">Select a node to see one-hop and two-hop paths.</div>';
  const oneHop = directNeighborIds(node.id, relationships);
  oneHop.delete(node.id);
  const twoHop = expandedNeighborIds(node.id, relationships, 2);
  for (const id of oneHop) twoHop.delete(id);
  twoHop.delete(node.id);

  const renderIds = (ids: Set<string>) => Array.from(ids).slice(0, 8).map((id) => {
    const target = nodesById.get(id);
    return `<button class="graph-path-chip" data-graph-node-id="${escHtml(id)}">${escHtml(nodeTitle(target || { id }))}</button>`;
  }).join('');

  return `
    <div class="graph-path-section">
      <div class="graph-path-label">One hop</div>
      <div class="graph-path-chips">${renderIds(oneHop) || '<span>No direct neighbors.</span>'}</div>
    </div>
    <div class="graph-path-section">
      <div class="graph-path-label">Two hops</div>
      <div class="graph-path-chips">${renderIds(twoHop) || '<span>No second-degree neighbors.</span>'}</div>
    </div>`;
}

function renderNodeProperties(node: GraphNode): string {
  const entries = [
    ['Status', nodeStatus(node)],
    ['Type', nodeType(node)],
    ['Priority', node.properties?.priority ?? ''],
    ['Assignee', node.properties?.assignee ?? ''],
    ['Sprint', node.properties?.sprint ?? ''],
    ['Release', node.properties?.release ?? ''],
    ['Deadline', node.properties?.deadline ?? ''],
    ['Updated', node.properties?.updated_at ?? ''],
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  const tags = Array.isArray(node.properties?.tags) ? node.properties.tags.map(String).filter(Boolean) : [];

  return `
    <div class="graph-property-grid">
      ${entries.map(([label, value]) => `
        <div class="graph-property-row">
          <span>${escHtml(String(label))}</span>
          <strong>${escHtml(String(value))}</strong>
        </div>
      `).join('')}
    </div>
    ${tags.length > 0 ? `
      <div class="graph-tag-list">
        ${tags.map((tag) => `<button class="graph-tag-chip" data-graph-query="${escHtml(tag)}">${escHtml(tag)}</button>`).join('')}
      </div>
    ` : ''}`;
}

function renderSelectedNode(node: GraphNode | undefined, relationships: GraphRelationship[], nodesById: Map<string, GraphNode>): string {
  if (!node) {
    return '<div class="graph-node-empty">Select a node to inspect direct relationships.</div>';
  }

  const outgoing = relationships.filter((rel) => rel.from === node.id);
  const incoming = relationships.filter((rel) => rel.to === node.id);
  const direct = [...outgoing, ...incoming];
  return `
    <div class="graph-selected">
      <div class="graph-selected-title">${escHtml(nodeTitle(node))}</div>
      <div class="graph-selected-meta">${escHtml(node.id)} · ${escHtml(nodeType(node))} · ${escHtml(nodeStatus(node))}</div>
      <div class="graph-selected-actions">
        ${isItemNode(node) ? `<button class="btn btn-secondary btn-sm" id="graph-open-selected">Open Item</button>` : ''}
        <button class="btn btn-secondary btn-sm" id="graph-focus-selected">${filter.scope === 'focus' ? 'Show All' : 'Focus Neighbors'}</button>
        <button class="btn btn-ghost btn-sm" id="graph-clear-selected">Clear</button>
      </div>
      <div class="graph-selected-counts">
        <span>${outgoing.length} outgoing</span>
        <span>${incoming.length} incoming</span>
      </div>
      ${renderNodeProperties(node)}
      <div class="graph-panel-title graph-panel-title-spaced">Direct Relationships</div>
      ${direct.length === 0
        ? '<div class="graph-node-empty">No direct relationships for this node.</div>'
        : direct.slice(0, 12).map((rel) => {
          const otherId = rel.from === node.id ? rel.to : rel.from;
          const other = nodesById.get(otherId);
          const direction = rel.from === node.id ? 'to' : 'from';
          return `<button class="graph-neighbor" data-graph-node-id="${escHtml(otherId)}"><span>${escHtml(rel.type)} ${direction}</span><strong>${escHtml(nodeTitle(other || { id: otherId }))}</strong></button>`;
        }).join('')}
    </div>`;
}

function renderGraph(data: GraphResponse): string {
  const graph = data.graph || {};
  const nodes = graph.nodes || [];
  const relationships = graph.relationships || [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const connected = new Set(relationships.flatMap((rel) => [rel.from, rel.to]));
  const itemNodes = nodes.filter(isItemNode);
  const facetNodes = nodes.filter(isFacetNode);
  const isolatedCount = itemNodes.filter((node) => !connected.has(node.id)).length;
  const typeCounts = nodes.reduce<Record<string, number>>((acc, node) => {
    const type = nodeType(node);
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const relCounts = relationshipCounts(relationships);
  const visible = visibleGraph(graph);
  const visibleNodesById = new Map(visible.nodes.map((node) => [node.id, node]));
  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : undefined;
  const relOptions = Object.keys(relCounts).sort();
  const extensionError = compactError(data.extensionError);

  return `
    <div class="view-header">
      <div>
        <h1>Knowledge Graph</h1>
        <p class="view-subtitle">Dependency, hierarchy, and metadata relationships generated from live pm data${data.extensionAvailable ? ' through pm-graph' : ' with the pm-web fallback'}.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" id="graph-refresh">Refresh</button>
      </div>
    </div>

    <div class="graph-status ${data.extensionAvailable ? 'graph-status-ok' : ''}">
      <div>
        <div class="graph-status-title">${data.extensionAvailable ? 'pm-graph extension active' : 'pm-graph extension not active'}</div>
        <div class="graph-status-text">
          ${data.extensionAvailable
            ? 'Graph export came from pm-graph. Neo4j is synced automatically after project changes.'
            : 'Using the built-in graph from pm list-all, pm deps, parent links, tags, status, type, assignee, sprint, and release metadata. Neo4j is synced automatically after project changes.'}
          ${extensionError ? `<br><span class="graph-status-warning">${escHtml(extensionError)}</span>` : ''}
        </div>
      </div>
      <code>${escHtml(graph.source || 'pm-web')}</code>
    </div>

    <div class="graph-stats">
      <div class="stat-card"><div class="stat-value">${itemNodes.length}</div><div class="stat-label">Items</div></div>
      <div class="stat-card"><div class="stat-value">${relationships.length}</div><div class="stat-label">Relationships</div></div>
      <div class="stat-card"><div class="stat-value">${facetNodes.length}</div><div class="stat-label">Metadata nodes</div></div>
      <div class="stat-card"><div class="stat-value">${isolatedCount}</div><div class="stat-label">Unlinked</div></div>
    </div>

    <div class="graph-toolbar">
      <div class="search-box-wrap graph-search">
        <span class="search-icon">⌕</span>
        <input class="search-input" id="graph-filter-query" type="text" placeholder="Filter graph by title, id, type, status, or tag" value="${escHtml(filter.query)}">
      </div>
      <select class="form-select graph-filter-select" id="graph-filter-kind">
        ${[
          ['all', 'All nodes'],
          ['items', 'Items'],
          ['facets', 'Metadata'],
          ['external', 'External refs'],
          ['unlinked', 'Unlinked items'],
        ].map(([value, label]) => `<option value="${value}" ${filter.kind === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <select class="form-select graph-filter-select" id="graph-filter-rel">
        <option value="all">All relationships</option>
        ${relOptions.map((rel) => `<option value="${escHtml(rel)}" ${filter.rel === rel ? 'selected' : ''}>${escHtml(rel)}</option>`).join('')}
      </select>
      <select class="form-select graph-filter-select" id="graph-filter-direction" ${selectedNodeId ? '' : 'disabled'}>
        ${[
          ['all', 'Any direction'],
          ['connected', 'Selected: all'],
          ['outgoing', 'Selected: outgoing'],
          ['incoming', 'Selected: incoming'],
        ].map(([value, label]) => `<option value="${value}" ${filter.direction === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <select class="form-select graph-filter-select" id="graph-filter-layout">
        ${[
          ['topology', 'Layout: topology'],
          ['status', 'Layout: status'],
          ['type', 'Layout: type'],
          ['activity', 'Layout: activity'],
        ].map(([value, label]) => `<option value="${value}" ${filter.layout === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <select class="form-select graph-filter-select" id="graph-filter-depth" ${selectedNodeId ? '' : 'disabled'}>
        <option value="1" ${filter.depth === '1' ? 'selected' : ''}>Focus: 1 hop</option>
        <option value="2" ${filter.depth === '2' ? 'selected' : ''}>Focus: 2 hops</option>
      </select>
      <button class="btn btn-secondary graph-density-toggle" id="graph-density-toggle">${filter.density === 'compact' ? 'Comfortable' : 'Compact'}</button>
    </div>

    <div class="graph-layout">
      <section class="graph-panel graph-panel-map">
        <div class="graph-panel-title">Relationship Map</div>
        ${renderGraphMap(visible.nodes, visible.relationships)}
      </section>
      <section class="graph-panel">
        <div class="graph-panel-title">Graph Coverage</div>
        ${renderCoverageSummary(itemNodes, relationships, connected, relCounts)}
        <div class="graph-panel-title">Selected Node</div>
        ${renderSelectedNode(selectedNode, relationships, nodesById)}
        <div class="graph-panel-title graph-panel-title-spaced">Neighborhood</div>
        ${renderPathHints(selectedNode, relationships, nodesById)}
        <div class="graph-panel-title graph-panel-title-spaced">Item Hubs</div>
        <div class="graph-insight-list">
          ${renderHubList(nodes, relationships)}
        </div>
        <div class="graph-panel-title graph-panel-title-spaced">Nodes by Kind</div>
        <div class="graph-type-list">
          ${Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
            <div class="graph-type-row"><span>${escHtml(type)}</span><strong>${count}</strong></div>
          `).join('') || '<div class="empty-state"><div class="empty-state-text">No items available.</div></div>'}
        </div>
        <div class="graph-panel-title graph-panel-title-spaced">Relationships by Type</div>
        <div class="graph-type-list">
          ${Object.entries(relCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
            <div class="graph-type-row"><span>${escHtml(type)}</span><strong>${count}</strong></div>
          `).join('') || '<div class="empty-state"><div class="empty-state-text">No relationships available.</div></div>'}
        </div>
      </section>
    </div>

    <section class="graph-panel graph-relationship-panel">
      <div class="graph-panel-title">Visible Relationships</div>
      ${visible.relationships.length === 0
        ? '<div class="empty-state"><div class="empty-state-text">No parent, dependency, or metadata relationships match the current filters.</div></div>'
        : visible.relationships.slice(0, 80).map((rel) => renderRelationship(rel, visibleNodesById)).join('')}
    </section>`;
}

function bindGraphControls(): void {
  document.getElementById('graph-refresh')?.addEventListener('click', () => renderGraphView());
  document.getElementById('graph-open-selected')?.addEventListener('click', () => {
    if (selectedNodeId) (window as any).__app.openItemDetail(selectedNodeId);
  });
  document.getElementById('graph-clear-selected')?.addEventListener('click', () => {
    selectedNodeId = '';
    filter.scope = 'all';
    filter.direction = 'all';
    rerenderCurrentGraph();
  });
  document.getElementById('graph-focus-selected')?.addEventListener('click', () => {
    filter.scope = filter.scope === 'focus' ? 'all' : 'focus';
    rerenderCurrentGraph();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-graph-node-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedNodeId = button.dataset.graphNodeId || '';
      rerenderCurrentGraph();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-graph-query]').forEach((button) => {
    button.addEventListener('click', () => {
      filter.query = button.dataset.graphQuery || '';
      selectedNodeId = '';
      filter.scope = 'all';
      filter.direction = 'all';
      rerenderCurrentGraph();
    });
  });

  document.getElementById('graph-filter-query')?.addEventListener('input', (event) => {
    filter.query = (event.target as HTMLInputElement).value;
    selectedNodeId = '';
    rerenderAndFocus('graph-filter-query');
  });
  document.getElementById('graph-filter-kind')?.addEventListener('change', (event) => {
    filter.kind = (event.target as HTMLSelectElement).value as GraphFilter['kind'];
    selectedNodeId = '';
    rerenderAndFocus('graph-filter-kind');
  });
  document.getElementById('graph-filter-rel')?.addEventListener('change', (event) => {
    filter.rel = (event.target as HTMLSelectElement).value;
    selectedNodeId = '';
    rerenderAndFocus('graph-filter-rel');
  });
  document.getElementById('graph-filter-direction')?.addEventListener('change', (event) => {
    filter.direction = (event.target as HTMLSelectElement).value as GraphFilter['direction'];
    rerenderAndFocus('graph-filter-direction');
  });
  document.getElementById('graph-filter-layout')?.addEventListener('change', (event) => {
    filter.layout = (event.target as HTMLSelectElement).value as GraphFilter['layout'];
    rerenderAndFocus('graph-filter-layout');
  });
  document.getElementById('graph-filter-depth')?.addEventListener('change', (event) => {
    filter.depth = (event.target as HTMLSelectElement).value as GraphFilter['depth'];
    filter.scope = 'focus';
    rerenderAndFocus('graph-filter-depth');
  });
  document.getElementById('graph-density-toggle')?.addEventListener('click', () => {
    filter.density = filter.density === 'compact' ? 'comfortable' : 'compact';
    rerenderCurrentGraph();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-graph-from-id][data-graph-to-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedNodeId = button.dataset.graphToId || button.dataset.graphFromId || '';
      filter.scope = 'focus';
      filter.direction = 'connected';
      rerenderCurrentGraph();
    });
  });
}

function rerenderCurrentGraph(): void {
  const el = document.getElementById('content-graph');
  if (!el || !currentGraph) return;
  el.innerHTML = renderGraph(currentGraph);
  bindGraphControls();
}

function rerenderAndFocus(id: string): void {
  rerenderCurrentGraph();
  const input = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  input?.focus();
  if (input instanceof HTMLInputElement) {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

export async function renderGraphView(): Promise<void> {
  const el = document.getElementById('content-graph');
  if (!el) return;
  if (!state.currentProject) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Select a project to view its graph.</div></div>';
    return;
  }
  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  try {
    currentGraph = await api('GET', `/projects/${state.currentProject.id}/pm/graph`) as GraphResponse;
    selectedNodeId = '';
    el.innerHTML = renderGraph(currentGraph);
    bindGraphControls();
  } catch (err: unknown) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Graph failed: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}
