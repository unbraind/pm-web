// ═══════════════════════════════════════════════════════════════
// GRAPH VIEW — Obsidian-quality immersive knowledge & dependency graph
// ═══════════════════════════════════════════════════════════════
import { api } from '../api.js';
import { state } from '../state.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { GraphCanvas } from './graph-canvas.js';
// ── Module state ──────────────────────────────────────────────
let currentGraph = null;
let selectedNodeId = '';
const canvasRef = { current: null };
let physicsLabel = 'Pause Physics';
let graphSyncInFlight = false;
let infoDrawerOpen = false;
let relDrawerOpen = false;
let filterOpen = false;
let physicsOpen = false;
let filter = {
    query: '',
    kind: 'items',
    rel: 'all',
    direction: 'all',
    scope: 'all',
    depth: '1',
    colorMode: 'status',
    depMode: false,
    layout: 'force',
    edgeBundling: false,
    statusFilter: '',
};
let selectedItemCache = null;
let criticalPath = new Set();
const DEP_REL_TYPES = new Set([
    'DEPENDS_ON',
    'BLOCKED_BY',
    'BLOCKS',
    'PARENT',
    'PARENT_OF',
    'CHILD',
    'CHILD_OF',
    'RELATED',
    'RELATES_TO',
]);
// ── Context menu ──────────────────────────────────────────────
let ctxMenuEl = null;
function removeCtxMenu() {
    if (ctxMenuEl) {
        ctxMenuEl.remove();
        ctxMenuEl = null;
    }
}
function showCtxMenu(nodeId, x, y) {
    removeCtxMenu();
    const graph = currentGraph?.graph || {};
    const nodes = graph.nodes || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const node = byId.get(nodeId);
    const isItem = node ? isItemNode(node) : false;
    const menu = document.createElement('div');
    menu.className = 'graph-ctx-menu';
    menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 160)}px`;
    const btn = (icon, label, action, danger = false) => {
        const b = document.createElement('button');
        b.className = 'graph-ctx-item' + (danger ? ' danger' : '');
        b.innerHTML = `<span style="opacity:0.6;font-size:11px">${icon}</span>${escHtml(label)}`;
        b.addEventListener('click', () => { removeCtxMenu(); action(); });
        return b;
    };
    if (isItem) {
        menu.appendChild(btn('⊡', 'Open Item', () => window.__app.openItemDetail(nodeId)));
        const sep1 = document.createElement('div');
        sep1.className = 'graph-ctx-sep';
        menu.appendChild(sep1);
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
    const sep2 = document.createElement('div');
    sep2.className = 'graph-ctx-sep';
    menu.appendChild(sep2);
    menu.appendChild(btn('⊞', 'Copy ID', () => { void navigator.clipboard?.writeText(nodeId); }));
    document.body.appendChild(menu);
    ctxMenuEl = menu;
    const dismiss = (ev) => {
        if (!menu.contains(ev.target)) {
            removeCtxMenu();
            document.removeEventListener('mousedown', dismiss);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}
// ── Node helpers ──────────────────────────────────────────────
function nodeTitle(node) {
    return String(node.properties?.title || node.id);
}
function nodeType(node) {
    return String(node.properties?.kind
        || node.properties?.type
        || node.labels?.find((l) => l !== 'PmItem' && l !== 'PmFacet')
        || 'Item');
}
function nodeStatus(node) {
    return String(node.properties?.status || 'unknown');
}
function isItemNode(node) {
    return Boolean(node.labels?.includes('PmItem') || !node.id.includes(':'));
}
function isFacetNode(node) {
    return Boolean(node.labels?.includes('PmFacet'));
}
function nodeLane(node) {
    if (isFacetNode(node))
        return 'facet';
    if (node.labels?.includes('ExternalPmItem'))
        return 'external';
    return 'item';
}
function compactError(raw) {
    if (!raw)
        return '';
    try {
        const parsed = JSON.parse(raw);
        const message = parsed.detail || parsed.title || parsed.code || '';
        return message.includes('does not expose command path "pm-graph"') ? '' : message;
    }
    catch {
        const message = raw.replace(/\s+/g, ' ').trim();
        return message.includes('does not expose command path "pm-graph"') ? '' : message;
    }
}
// ── Graph data processing ─────────────────────────────────────
function directNeighborIds(nodeId, rels) {
    const ids = new Set([nodeId]);
    for (const r of rels) {
        if (r.from === nodeId)
            ids.add(r.to);
        if (r.to === nodeId)
            ids.add(r.from);
    }
    return ids;
}
function walkDirectionMatch(rel, nodeId, dir) {
    if (dir === 'incoming') {
        return rel.to === nodeId ? [rel.from] : [];
    }
    if (dir === 'outgoing') {
        return rel.from === nodeId ? [rel.to] : [];
    }
    return rel.to === nodeId ? [rel.from] : rel.from === nodeId ? [rel.to] : [];
}
function expandedNeighborIds(nodeId, rels, depth, direction) {
    const ids = new Set([nodeId]);
    let frontier = new Set([nodeId]);
    const dir = direction === 'all' ? 'connected' : direction;
    for (let d = 0; d < depth; d++) {
        const next = new Set();
        for (const r of rels) {
            for (const f of frontier) {
                for (const n of walkDirectionMatch(r, f, dir)) {
                    if (!ids.has(n))
                        next.add(n);
                }
            }
        }
        for (const id of next)
            ids.add(id);
        frontier = next;
        if (!frontier.size)
            break;
    }
    return ids;
}
function degreeMap(rels) {
    const m = new Map();
    for (const r of rels) {
        m.set(r.from, (m.get(r.from) || 0) + 1);
        m.set(r.to, (m.get(r.to) || 0) + 1);
    }
    return m;
}
function isDependencyRel(rel) {
    return DEP_REL_TYPES.has(rel.type);
}
function blockingPair(rel) {
    if (rel.type === 'BLOCKS')
        return { blocked: rel.to, blocker: rel.from };
    if (rel.type === 'DEPENDS_ON' || rel.type === 'BLOCKED_BY')
        return { blocked: rel.from, blocker: rel.to };
    return null;
}
function dependencyLabel(rel) {
    const labels = {
        DEPENDS_ON: 'Depends on',
        BLOCKED_BY: 'Blocked by',
        BLOCKS: 'Blocks',
        PARENT: 'Parent',
        PARENT_OF: 'Parent of',
        CHILD: 'Child',
        CHILD_OF: 'Child of',
        RELATED: 'Related',
        RELATES_TO: 'Related to',
    };
    return labels[rel.type] ?? rel.type.replace(/_/g, ' ').toLowerCase();
}
function computeCriticalPath(rels) {
    const depRels = rels.filter(isDependencyRel);
    if (!depRels.length)
        return new Set();
    const blockedBy = new Map();
    const allIds = new Set();
    for (const r of depRels) {
        const pair = blockingPair(r);
        if (!pair)
            continue;
        if (!blockedBy.has(pair.blocked))
            blockedBy.set(pair.blocked, new Set());
        blockedBy.get(pair.blocked).add(pair.blocker);
        allIds.add(pair.blocked);
        allIds.add(pair.blocker);
    }
    const memo = new Map();
    function longestPathFrom(id, seen = new Set()) {
        if (memo.has(id))
            return memo.get(id);
        if (seen.has(id))
            return [id];
        const nextSeen = new Set(seen);
        nextSeen.add(id);
        const prereqs = [...(blockedBy.get(id) ?? new Set())];
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
function blockerStats(rels) {
    const stats = new Map();
    const entry = (id) => {
        if (!stats.has(id))
            stats.set(id, { blockers: new Set(), blocked: new Set() });
        return stats.get(id);
    };
    for (const rel of rels) {
        const pair = blockingPair(rel);
        if (!pair)
            continue;
        entry(pair.blocked).blockers.add(pair.blocker);
        entry(pair.blocker).blocked.add(pair.blocked);
    }
    return stats;
}
function visibleGraph(graph) {
    const nodes = graph.nodes || [];
    let rels = graph.relationships || [];
    const connected = new Set(rels.flatMap((r) => [r.from, r.to]));
    // Dep mode: restrict to dependency/block edges
    if (filter.depMode) {
        rels = rels.filter(isDependencyRel);
    }
    const focusIds = selectedNodeId && filter.scope === 'focus'
        ? expandedNeighborIds(selectedNodeId, rels, Number(filter.depth), filter.direction)
        : null;
    const q = filter.query.trim().toLowerCase();
    const depConnected = filter.depMode
        ? new Set(rels.flatMap((r) => [r.from, r.to]))
        : null;
    const nodeVisible = (n) => {
        if (depConnected && !depConnected.has(n.id))
            return false;
        if (focusIds && !focusIds.has(n.id))
            return false;
        if (filter.kind === 'items' && !isItemNode(n))
            return false;
        if (filter.kind === 'facets' && !isFacetNode(n))
            return false;
        if (filter.kind === 'external' && !n.labels?.includes('ExternalPmItem'))
            return false;
        if (filter.kind === 'unlinked' && (!isItemNode(n) || connected.has(n.id)))
            return false;
        if (filter.statusFilter && nodeStatus(n) !== filter.statusFilter)
            return false;
        if (!q)
            return true;
        const hay = [n.id, nodeTitle(n), nodeType(n), nodeStatus(n),
            n.properties?.tags?.join(' ') || ''].join(' ').toLowerCase();
        return hay.includes(q);
    };
    const visNodes = nodes.filter(nodeVisible);
    const visIds = new Set(visNodes.map((n) => n.id));
    const visRels = rels.filter((r) => {
        if (!visIds.has(r.from) || !visIds.has(r.to))
            return false;
        if (filter.rel !== 'all' && r.type !== filter.rel)
            return false;
        if (!selectedNodeId || filter.direction === 'all')
            return true;
        if (filter.direction === 'incoming')
            return r.to === selectedNodeId;
        if (filter.direction === 'outgoing')
            return r.from === selectedNodeId;
        return r.from === selectedNodeId || r.to === selectedNodeId;
    });
    return { nodes: visNodes, rels: visRels, connected };
}
// ── Canvas data conversion ────────────────────────────────────
function toCanvasNodes(nodes, rels) {
    const deg = degreeMap(rels);
    return nodes.map((n) => ({
        id: n.id,
        label: nodeTitle(n),
        type: nodeType(n),
        status: nodeStatus(n),
        lane: nodeLane(n),
        degree: deg.get(n.id) || 0,
        tags: Array.isArray(n.properties?.tags)
            ? n.properties.tags.map(String)
            : [],
        priority: n.properties?.priority !== undefined ? Number(n.properties.priority) : undefined,
        assignee: n.properties?.assignee ? String(n.properties.assignee) : undefined,
    }));
}
function toCanvasEdges(rels) {
    return rels.map((r) => ({ from: r.from, to: r.to, type: r.type }));
}
// ── Info panel rendering ──────────────────────────────────────
function renderCoverage(itemNodes, rels, connected, relCounts) {
    const linked = itemNodes.filter((n) => connected.has(n.id)).length;
    const linkedPct = itemNodes.length > 0 ? Math.round((linked / itemNodes.length) * 100) : 0;
    const unlinked = itemNodes.length - linked;
    const external = new Set(rels.flatMap((r) => [r.from, r.to]).filter((id) => id.includes(':external') || id.startsWith('external:'))).size;
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
function renderSelectedNode(node, rels, byId, fullItem) {
    if (!node)
        return '<div class="graph-node-empty">Click any node in the graph to inspect it.</div>';
    const outgoing = rels.filter((r) => r.from === node.id);
    const incoming = rels.filter((r) => r.to === node.id);
    const direct = [...outgoing, ...incoming];
    const blocks = blockerStats(rels).get(node.id) ?? { blockers: new Set(), blocked: new Set() };
    const props = [
        ['Status', nodeStatus(node)],
        ['Type', nodeType(node)],
        ['Priority', node.properties?.priority ?? ''],
        ['Assignee', node.properties?.assignee ?? ''],
        ['Sprint', node.properties?.sprint ?? ''],
        ['Release', node.properties?.release ?? ''],
        ['Deadline', node.properties?.deadline ?? ''],
        ['Updated', node.properties?.updated_at ?? ''],
    ].filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
    const tags = Array.isArray(node.properties?.tags)
        ? node.properties.tags.map(String).filter(Boolean) : [];
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
  <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;max-height:120px;overflow-y:auto;padding:8px;background:rgba(15,23,42,0.5);border-radius:6px;border:1px solid rgba(148,163,184,0.1)">${escHtml(String(fullItem.body).slice(0, 500))}${String(fullItem.body).length > 500 ? '…' : ''}</div>
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
            const other = byId.get(otherId);
            const dir = r.from === node.id ? '→' : '←';
            // Show any non-trivial relationship properties (e.g. weight, since, note)
            const relProps = r.properties ? Object.entries(r.properties).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '') : [];
            const propHint = relProps.length > 0
                ? ` <span style="font-size:10px;color:var(--text-muted);opacity:0.8">[${relProps.slice(0, 3).map(([k, v]) => `${k}:${escHtml(String(v))}`).join(', ')}]</span>`
                : '';
            return `<button class="graph-neighbor" data-graph-node-id="${escHtml(otherId)}"><span class="graph-rel-badge">${escHtml(r.type)}</span> ${dir} <strong>${escHtml(nodeTitle(other || { id: otherId }))}</strong>${propHint}</button>`;
        }).join('') + (direct.length > 16 ? `<div class="graph-limit-note">+${direct.length - 16} more — use Focus scope to narrow</div>` : '')}
    </div>`;
}
function renderPaths(node, rels, byId) {
    if (!node)
        return '<div class="graph-node-empty">Select a node to explore paths.</div>';
    const oneHop = directNeighborIds(node.id, rels);
    oneHop.delete(node.id);
    const twoHop = expandedNeighborIds(node.id, rels, 2, 'connected');
    for (const id of oneHop)
        twoHop.delete(id);
    twoHop.delete(node.id);
    const chips = (ids) => Array.from(ids).slice(0, 10).map((id) => {
        const t = byId.get(id);
        return `<button class="graph-path-chip" data-graph-node-id="${escHtml(id)}">${escHtml(nodeTitle(t || { id }))}</button>`;
    }).join('');
    return `
    <div class="graph-path-section"><div class="graph-path-label">One hop (${oneHop.size})</div><div class="graph-path-chips">${chips(oneHop) || '<span>None.</span>'}</div></div>
    <div class="graph-path-section"><div class="graph-path-label">Two hops (${twoHop.size})</div><div class="graph-path-chips">${chips(twoHop) || '<span>None.</span>'}</div></div>`;
}
function renderHubs(nodes, rels) {
    const deg = degreeMap(rels);
    const hubs = nodes.filter(isItemNode)
        .map((n) => ({ n, d: deg.get(n.id) || 0, out: rels.filter((r) => r.from === n.id).length, inn: rels.filter((r) => r.to === n.id).length }))
        .filter((e) => e.d > 0)
        .sort((a, b) => b.d - a.d || nodeTitle(a.n).localeCompare(nodeTitle(b.n)))
        .slice(0, 8);
    if (!hubs.length)
        return '<div class="graph-node-empty">No linked item hubs yet.</div>';
    return hubs.map((e) => `
    <button class="graph-insight-row" data-graph-node-id="${escHtml(e.n.id)}">
      <span><strong>${escHtml(nodeTitle(e.n))}</strong><em>${escHtml(e.n.id)}</em></span>
      <b>${e.d}</b>
      <small>${e.out}↑ ${e.inn}↓</small>
    </button>`).join('');
}
function renderBlockingInsights(nodes, rels) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const stats = blockerStats(rels);
    const rows = [...stats.entries()]
        .map(([id, value]) => ({ id, ...value, node: byId.get(id) }))
        .filter((row) => row.node && isItemNode(row.node) && (row.blockers.size || row.blocked.size))
        .sort((a, b) => b.blocked.size - a.blocked.size || b.blockers.size - a.blockers.size || nodeTitle(a.node).localeCompare(nodeTitle(b.node)))
        .slice(0, 8);
    if (!rows.length)
        return '<div class="graph-node-empty">No dependency blockers in this view.</div>';
    return rows.map((row) => `
    <button class="graph-insight-row${criticalPath.has(row.id) ? ' critical' : ''}" data-graph-node-id="${escHtml(row.id)}">
      <span><strong>${escHtml(nodeTitle(row.node))}</strong><em>${escHtml(row.id)}</em></span>
      <b>${row.blocked.size}</b>
      <small>${row.blockers.size} blockers · ${row.blocked.size} items blocked${criticalPath.has(row.id) ? ' · critical path' : ''}</small>
    </button>`).join('');
}
function renderDependencyChains(nodes, rels) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const depRels = rels.filter(isDependencyRel);
    if (!depRels.length) {
        return '<div class="graph-node-empty">No dependency chains in this view.</div>';
    }
    const blockersByItem = new Map();
    const blockedByItem = new Map();
    for (const rel of depRels) {
        const pair = blockingPair(rel);
        if (!pair)
            continue;
        blockersByItem.set(pair.blocked, [...(blockersByItem.get(pair.blocked) ?? []), pair.blocker]);
        blockedByItem.set(pair.blocker, [...(blockedByItem.get(pair.blocker) ?? []), pair.blocked]);
    }
    const cycleStarts = new Set();
    const leafBlockers = [...blockedByItem.entries()]
        .filter(([id, blocked]) => blocked.length > 0 && !(blockersByItem.get(id)?.length))
        .map(([id, blocked]) => ({ id, blocked: blocked.length }))
        .sort((a, b) => b.blocked - a.blocked || nodeTitle(byId.get(a.id) || { id: a.id }).localeCompare(nodeTitle(byId.get(b.id) || { id: b.id })))
        .slice(0, 4);
    function traceFrom(id, seen = new Set()) {
        if (seen.has(id)) {
            cycleStarts.add(id);
            return [id];
        }
        const nextSeen = new Set(seen);
        nextSeen.add(id);
        const blockers = blockersByItem.get(id) ?? [];
        if (!blockers.length)
            return [id];
        const best = blockers
            .map((blocker) => traceFrom(blocker, nextSeen))
            .sort((a, b) => b.length - a.length)[0] ?? [];
        return [id, ...best];
    }
    const chains = [...new Set([...blockersByItem.keys(), ...blockedByItem.keys()])]
        .map((id) => traceFrom(id))
        .filter((chain) => chain.length > 1)
        .sort((a, b) => b.length - a.length || nodeTitle(byId.get(a[0]) || { id: a[0] }).localeCompare(nodeTitle(byId.get(b[0]) || { id: b[0] })))
        .slice(0, 3);
    const chainRows = chains.map((chain) => {
        const isCritical = chain.some((id) => criticalPath.has(id));
        return `
      <button class="graph-chain-row${isCritical ? ' critical' : ''}" data-graph-node-id="${escHtml(chain[0])}">
        <span>${chain.map((id) => escHtml(nodeTitle(byId.get(id) || { id }))).join('<i>←</i>')}</span>
        <small>${chain.length} items · ${isCritical ? 'critical dependency chain' : 'dependency chain'}</small>
      </button>`;
    }).join('');
    const cycleRows = [...cycleStarts].slice(0, 3).map((id) => `
    <button class="graph-chain-row warning" data-graph-node-id="${escHtml(id)}">
      <span>${escHtml(nodeTitle(byId.get(id) || { id }))}</span>
      <small>Potential dependency cycle detected from this item.</small>
    </button>`).join('');
    const leafRows = leafBlockers.map(({ id, blocked }) => `
    <button class="graph-chain-row root" data-graph-node-id="${escHtml(id)}">
      <span>${escHtml(nodeTitle(byId.get(id) || { id }))}</span>
      <small>Root blocker for ${blocked} item${blocked === 1 ? '' : 's'}.</small>
    </button>`).join('');
    return `
    <div class="graph-chain-list">
      ${chainRows || '<div class="graph-node-empty">No multi-step dependency chains.</div>'}
      ${cycleRows}
      ${leafRows}
    </div>`;
}
function renderInfoPanel(data, fullItem) {
    const graph = data.graph || {};
    const nodes = graph.nodes || [];
    const rels = graph.relationships || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const connected = new Set(rels.flatMap((r) => [r.from, r.to]));
    const itemNodes = nodes.filter(isItemNode);
    const relCounts = rels.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {});
    const selectedNode = selectedNodeId ? byId.get(selectedNodeId) : undefined;
    const typeCounts = nodes.reduce((acc, n) => {
        const t = nodeType(n);
        acc[t] = (acc[t] || 0) + 1;
        return acc;
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
    <div class="graph-panel-title graph-panel-title-spaced">Dependency Chains</div>
    ${renderDependencyChains(nodes, rels)}
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
function renderRelList(data) {
    const graph = data.graph || {};
    const nodes = graph.nodes || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const { rels: visRels } = visibleGraph(graph);
    const editBtns = `
    <div class="graph-rel-edit-bar">
      <button class="btn btn-secondary btn-sm" id="graph-add-dep-btn">+ Add Dependency</button>
      <button class="btn btn-ghost btn-sm" id="graph-remove-dep-btn">− Remove Dependency</button>
    </div>`;
    if (!visRels.length) {
        return editBtns + '<div class="graph-node-empty" style="padding:14px 0">No relationships match current filters.</div>';
    }
    const rows = visRels.slice(0, 100).map((r) => {
        const from = byId.get(r.from);
        const to = byId.get(r.to);
        const relProps = r.properties ? Object.entries(r.properties).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '') : [];
        const propHtml = relProps.length > 0
            ? `<div class="graph-rel-props">${relProps.slice(0, 4).map(([k, v]) => `<span><em>${escHtml(k)}</em> ${escHtml(String(v))}</span>`).join('')}</div>`
            : '';
        return `
      <button class="graph-rel-row" data-graph-from-id="${escHtml(r.from)}" data-graph-to-id="${escHtml(r.to)}" data-graph-rel-type="${escHtml(r.type)}">
        <div><div class="graph-rel-title">${escHtml(nodeTitle(from || { id: r.from }))}</div><div class="graph-rel-id">${escHtml(r.from)}</div></div>
        <div class="graph-rel-type">${escHtml(r.type)}${propHtml}</div>
        <div><div class="graph-rel-title">${escHtml(nodeTitle(to || { id: r.to }))}</div><div class="graph-rel-id">${escHtml(r.to)}</div></div>
      </button>`;
    }).join('');
    const limitNote = visRels.length > 100
        ? `<div class="graph-limit-note" style="padding:10px 0">Showing 100 of ${visRels.length} — use filters to narrow.</div>`
        : '';
    return editBtns + rows + limitNote;
}
// ── Immersive shell ───────────────────────────────────────────
function graphPresetActive(id) {
    if (id === 'knowledge') {
        return !filter.depMode && (filter.kind === 'items' || filter.kind === 'all') && filter.rel === 'all' && filter.scope === 'all' && filter.colorMode === 'status';
    }
    if (id === 'dependency')
        return filter.depMode;
    if (id === 'unlinked')
        return filter.kind === 'unlinked';
    if (id === 'metadata')
        return filter.kind === 'facets' || (filter.kind === 'all' && !filter.depMode && filter.colorMode !== 'tag');
    if (id === 'critical')
        return filter.depMode && filter.scope === 'focus' && Boolean(selectedNodeId);
    if (id === 'tags')
        return !filter.depMode && filter.colorMode === 'tag';
    return false;
}
function renderGraphPresets(depRels, isolatedCount) {
    const allNodes = currentGraph?.graph?.nodes ?? [];
    const tagSet = new Set();
    for (const n of allNodes) {
        const tags = Array.isArray(n.properties?.tags) ? n.properties.tags.map(String) : [];
        for (const t of tags)
            tagSet.add(t);
    }
    const presets = [
        { id: 'knowledge', label: 'Knowledge', value: String(allNodes.length) },
        { id: 'dependency', label: 'Dependencies', value: String(depRels.length) },
        { id: 'unlinked', label: 'Unlinked', value: String(isolatedCount) },
        { id: 'tags', label: 'Tags', value: tagSet.size ? String(tagSet.size) : 'none' },
        { id: 'metadata', label: 'Metadata', value: 'facets' },
        { id: 'critical', label: 'Critical', value: criticalPath.size ? String(criticalPath.size) : 'pick node' },
    ];
    return `
    <div class="graph-preset-rail" role="toolbar" aria-label="Graph views">
      ${presets.map((preset) => `
        <button class="graph-preset-btn${graphPresetActive(preset.id) ? ' active' : ''}" data-graph-preset="${preset.id}">
          <span>${escHtml(preset.label)}</span>
          <strong>${escHtml(preset.value)}</strong>
        </button>`).join('')}
    </div>`;
}
function renderGraphShell(data) {
    const graph = data.graph || {};
    const nodes = graph.nodes || [];
    const rels = graph.relationships || [];
    const itemNodes = nodes.filter(isItemNode);
    const facetNodes = nodes.filter(isFacetNode);
    const connected = new Set(rels.flatMap((r) => [r.from, r.to]));
    const isolated = itemNodes.filter((n) => !connected.has(n.id)).length;
    const relCounts = rels.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {});
    const relOptions = Object.keys(relCounts).sort();
    const errText = compactError(data.extensionError);
    const { rels: visRels } = visibleGraph(graph);
    const depRels = rels.filter(isDependencyRel);
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
            <input class="graph-search-hud-input" id="graph-filter-query" type="text" placeholder="Search nodes… (Ctrl+F)" value="${escHtml(filter.query)}" autocomplete="off">
          </div>
          ${renderGraphPresets(depRels, isolated)}
        </div>
        <div class="graph-hud-right">
          <button class="graph-hud-btn" id="graph-refresh" title="Reload graph data (R)">↻</button>
          <button class="graph-hud-btn" id="graph-sync-btn" title="Run backend graph sync (S)">${graphSyncInFlight ? 'Syncing…' : '⧉ Sync'}</button>
          <button class="graph-hud-btn" id="graph-fit-btn" title="Fit all in view (F)">⊡ Fit</button>
          <button class="graph-hud-btn" id="graph-physics-btn" title="Pause/Resume physics (Space)">${physicsLabel}</button>
          <button class="graph-hud-btn" id="graph-export-png" title="Export as PNG">PNG</button>
          <div class="graph-hud-select-wrap">
            <select class="graph-hud-select" id="graph-layout-select" title="Layout mode">
              <option value="force"${filter.layout === 'force' ? ' selected' : ''}>Force</option>
              <option value="hierarchical"${filter.layout === 'hierarchical' ? ' selected' : ''}>Hierarchy</option>
            </select>
          </div>
          <button class="graph-hud-btn${filter.edgeBundling ? ' active' : ''}" id="graph-bundle-btn" title="Toggle edge bundling">Bundle</button>
          <button class="graph-hud-btn${physicsOpen ? ' active' : ''}" id="graph-physics-panel-toggle" title="Physics controls">⚡ Physics</button>
          <button class="graph-hud-btn${filterOpen ? ' active' : ''}" id="graph-filter-toggle" title="Toggle filters (G)">⚙ Filters</button>
          <button class="graph-hud-btn${infoDrawerOpen ? ' active' : ''}" id="graph-info-toggle" title="Toggle analysis panel (I)">⊞ Info</button>
          <button class="graph-hud-btn${relDrawerOpen ? ' active' : ''}" id="graph-rel-toggle" title="Show all relationships">⇄ Rels</button>
        </div>
      </div>

      <!-- Physics controls panel (bottom-left, above filter overlay) -->
      <div class="graph-physics-panel${physicsOpen ? ' open' : ''}" id="graph-physics-panel">
        <div class="graph-filter-overlay-header">
          <span>⚡ Physics Controls</span>
          <button class="graph-filter-close-btn" id="graph-physics-close">✕</button>
        </div>
        <div class="graph-physics-body">
          <div class="graph-physics-row">
            <label>Repulsion</label>
            <input type="range" id="graph-physics-repulsion" class="graph-physics-slider" min="200" max="8000" step="100" value="2000">
            <span class="graph-physics-val" id="graph-physics-repulsion-val">2000</span>
          </div>
          <div class="graph-physics-row">
            <label>Link distance</label>
            <input type="range" id="graph-physics-linkdist" class="graph-physics-slider" min="30" max="400" step="10" value="140">
            <span class="graph-physics-val" id="graph-physics-linkdist-val">140</span>
          </div>
          <div class="graph-physics-row">
            <label>Link strength</label>
            <input type="range" id="graph-physics-linkstr" class="graph-physics-slider" min="1" max="30" step="1" value="7">
            <span class="graph-physics-val" id="graph-physics-linkstr-val">0.065</span>
          </div>
          <div class="graph-physics-row">
            <label>Gravity</label>
            <input type="range" id="graph-physics-gravity" class="graph-physics-slider" min="0" max="50" step="1" value="10">
            <span class="graph-physics-val" id="graph-physics-gravity-val">0.010</span>
          </div>
          <button class="graph-scope-btn" id="graph-physics-reset" style="margin-top:4px">↺ Reset defaults</button>
        </div>
      </div>

      <!-- Filter overlay (bottom-left) -->
      <div class="graph-filter-overlay${filterOpen ? ' open' : ''}" id="graph-filter-overlay">
        <div class="graph-filter-overlay-header">
          <span>⚙ Filters</span>
          <button class="graph-filter-close-btn" id="graph-filter-close">✕</button>
        </div>
        <div class="graph-filter-overlay-body">
          <div class="graph-filter-row">
            <label>Color by</label>
            <select id="graph-color-mode">
              <option value="status"${filter.colorMode === 'status' ? ' selected' : ''}>Status</option>
              <option value="type"${filter.colorMode === 'type' ? ' selected' : ''}>Node type</option>
              <option value="tag"${filter.colorMode === 'tag' ? ' selected' : ''}>Tags (auto)</option>
            </select>
          </div>
          <button class="graph-dep-mode-btn${filter.depMode ? ' active' : ''}" id="graph-dep-mode-btn">
            <span>Dependency Graph</span>
            <strong>${filter.depMode ? 'On' : 'Off'}</strong>
          </button>
          <div class="graph-filter-note">${depRels.length} dep/block edges · ${criticalPath.size} critical-path nodes</div>
          <div class="graph-filter-row">
            <label>Show</label>
            <select id="graph-filter-kind">
              ${[['all', 'All nodes'], ['items', 'Items only'], ['facets', 'Metadata only'], ['external', 'External'], ['unlinked', 'Unlinked']]
        .map(([v, l]) => `<option value="${v}"${filter.kind === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="graph-filter-row">
            <label>Status</label>
            <select id="graph-filter-status">
              ${[['', 'All statuses'], ['open', 'Open'], ['in-progress', 'In Progress'], ['blocked', 'Blocked'], ['draft', 'Draft'], ['closed', 'Closed']]
        .map(([v, l]) => `<option value="${v}"${filter.statusFilter === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="graph-filter-row">
            <label>Relation</label>
            <select id="graph-filter-rel">
              <option value="all">All types</option>
              ${relOptions.map((r) => `<option value="${escHtml(r)}"${filter.rel === r ? ' selected' : ''}>${escHtml(r)}</option>`).join('')}
            </select>
          </div>
          <div class="graph-filter-row">
            <label>Direction</label>
            <select id="graph-filter-direction" ${selectedNodeId ? '' : 'disabled'}>
              ${[['all', 'Any direction'], ['connected', 'All connected'], ['outgoing', 'Outgoing →'], ['incoming', '← Incoming']]
        .map(([v, l]) => `<option value="${v}"${filter.direction === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="graph-filter-row graph-filter-row-depth">
            <label>Depth <span id="graph-depth-label" class="graph-depth-val">${filter.depth}</span></label>
            <input type="range" id="graph-filter-depth" class="graph-depth-slider"
              min="1" max="5" step="1" value="${filter.depth}"
              ${selectedNodeId && filter.scope === 'focus' ? '' : 'disabled'}>
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
        <span class="legend-sep">·</span>
        <span style="color:rgba(148,163,184,0.5);font-size:10px">Tab/↑↓ navigate · F fit · Space pause · Esc deselect</span>
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
async function fetchAndUpdateSelectedItem(nodeId) {
    if (!state.currentProject || !nodeId)
        return;
    // Only fetch for item-lane nodes (not facets)
    const graph = currentGraph?.graph || {};
    const node = (graph.nodes || []).find((n) => n.id === nodeId);
    if (!node || !isItemNode(node)) {
        selectedItemCache = null;
        return;
    }
    try {
        const result = await api('GET', `/projects/${state.currentProject.id}/pm/get/${encodeURIComponent(nodeId)}`);
        selectedItemCache = result.item ?? result ?? null;
        // Re-render panel with the full item
        if (currentGraph) {
            const panel = document.getElementById('graph-info-panel');
            if (panel)
                panel.innerHTML = renderInfoPanel(currentGraph, selectedItemCache ?? undefined);
            bindInfoPanelEvents();
        }
    }
    catch {
        selectedItemCache = null;
    }
}
function syncCanvas() {
    if (!canvasRef.current || !currentGraph)
        return;
    const graph = currentGraph.graph || {};
    const { nodes: visNodes } = visibleGraph(graph);
    const visIds = new Set(visNodes.map((n) => n.id));
    const useAll = filter.kind === 'all' && !filter.query && filter.scope === 'all';
    canvasRef.current.setFilter({
        visibleNodeIds: useAll ? null : visIds,
        selectedId: selectedNodeId || null,
        query: filter.query,
        highlightRelTypes: filter.rel !== 'all' ? new Set([filter.rel]) : new Set(),
        colorMode: filter.colorMode,
        colorTag: '',
        criticalPathIds: filter.depMode ? criticalPath : new Set(),
    });
    if (filter.query && !selectedNodeId) {
        const q = filter.query.toLowerCase();
        const match = visNodes.find((n) => nodeTitle(n).toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
        if (match)
            canvasRef.current.jumpToNode(match.id);
    }
}
function initCanvas() {
    const host = document.getElementById('graph-canvas-host');
    if (!host || !currentGraph)
        return;
    canvasRef.current?.destroy();
    canvasRef.current = null;
    const graph = currentGraph.graph || {};
    const nodes = graph.nodes || [];
    const rels = graph.relationships || [];
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
            if (id)
                void fetchAndUpdateSelectedItem(id);
            else
                selectedItemCache = null;
        },
        onOpenNode(id) {
            window.__app.openItemDetail(id);
        },
        onContextMenu(id, x, y) { showCtxMenu(id, x, y); },
    });
    canvasRef.current.setData(toCanvasNodes(nodes, rels), toCanvasEdges(rels));
    syncCanvas();
}
// ── Panel / drawer updates ────────────────────────────────────
function updateInfoPanel() {
    if (!currentGraph)
        return;
    const panel = document.getElementById('graph-info-panel');
    if (panel)
        panel.innerHTML = renderInfoPanel(currentGraph, selectedItemCache ?? undefined);
    const relList = document.getElementById('graph-rel-list');
    if (relList)
        relList.innerHTML = renderRelList(currentGraph);
    bindInfoPanelEvents();
}
function updateFilterToolbarState() {
    const dirSel = document.getElementById('graph-filter-direction');
    const depthSldr = document.getElementById('graph-filter-depth');
    const depthLbl = document.getElementById('graph-depth-label');
    const scopeBtn = document.getElementById('graph-scope-btn');
    if (dirSel)
        dirSel.disabled = !selectedNodeId;
    if (depthSldr) {
        depthSldr.disabled = !(selectedNodeId && filter.scope === 'focus');
        depthSldr.value = filter.depth;
    }
    if (depthLbl)
        depthLbl.textContent = filter.depth;
    if (scopeBtn)
        scopeBtn.textContent = filter.scope === 'focus' ? '⊙ Show All Nodes' : '⊕ Focus on Selected';
    document.querySelectorAll('[data-graph-preset]').forEach((presetBtn) => {
        presetBtn.classList.toggle('active', graphPresetActive(presetBtn.dataset.graphPreset || ''));
    });
}
// ── Legend update ─────────────────────────────────────────────
const TYPE_COLORS_MAP = {
    task: '#2dd4bf', feature: '#60a5fa', epic: '#a78bfa', bug: '#f87171',
    milestone: '#fbbf24', story: '#34d399', chore: '#94a3b8', release: '#38bdf8',
};
const TAG_PALETTE_JS = ['#2dd4bf', '#60a5fa', '#a78bfa', '#f87171', '#fbbf24', '#34d399', '#fb923c', '#e879f9'];
function computeTagColorMap(nodes) {
    const freq = new Map();
    for (const n of nodes) {
        const tags = Array.isArray(n.properties?.tags) ? n.properties.tags.map(String) : [];
        for (const t of tags)
            freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_PALETTE_JS.length).map(([t]) => t);
    return new Map(top.map((t, i) => [t, TAG_PALETTE_JS[i]]));
}
function updateLegend() {
    const legend = document.getElementById('graph-legend-hud');
    if (!legend)
        return;
    const nodes = currentGraph?.graph?.nodes ?? [];
    if (filter.colorMode === 'type') {
        const typeCounts = nodes.filter(isItemNode).reduce((acc, n) => {
            const t = nodeType(n);
            acc[t] = (acc[t] || 0) + 1;
            return acc;
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
    }
    else if (filter.colorMode === 'tag') {
        const tagMap = computeTagColorMap(nodes);
        legend.innerHTML = `
      <span><i class="legend-dot legend-facet"></i>Metadata</span>
      <span><i class="legend-dot legend-external"></i>External</span>
      <span class="legend-sep">·</span>
      ${[...tagMap.entries()].slice(0, 6).map(([t, c]) => `<button class="legend-tag-btn" data-legend-tag="${escHtml(t)}" style="border-color:${c}33;color:${c}"><i class="legend-dot" style="background:${c};box-shadow:0 0 4px ${c}66;flex-shrink:0"></i>#${escHtml(t)}</button>`).join('')}
      ${tagMap.size === 0 ? '<span style="color:var(--text-muted);font-size:11px">No tags</span>' : ''}
    `;
        // Bind tag filter clicks
        legend.querySelectorAll('[data-legend-tag]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tag = btn.dataset.legendTag || '';
                const isActive = filter.query === tag;
                filter = { ...filter, query: isActive ? '' : tag };
                const inp = document.getElementById('graph-filter-query');
                if (inp)
                    inp.value = filter.query;
                syncCanvas();
                updateInfoPanel();
                legend.querySelectorAll('[data-legend-tag]').forEach((b) => {
                    b.classList.toggle('active', !isActive && b.dataset.legendTag === tag);
                });
            });
        });
    }
    else if (filter.depMode) {
        legend.innerHTML = `
      <span><i class="legend-dot legend-item"></i>Item</span>
      <span class="legend-sep">·</span>
      <span><i class="legend-line" style="background:#fb923c"></i>depends on</span>
      <span><i class="legend-line" style="background:#f87171"></i>blocked by</span>
      <span><i class="legend-line" style="background:#60a5fa"></i>parent / child</span>
      <span><i class="legend-line" style="background:#94a3b8"></i>related</span>
      <span class="legend-sep">·</span>
      <span><i class="legend-dot" style="background:#fbbf24;box-shadow:0 0 6px #fbbf2488"></i>critical path</span>
    `;
    }
    else {
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
function bindInfoPanelEvents() {
    document.getElementById('graph-open-selected')?.addEventListener('click', () => {
        if (selectedNodeId)
            window.__app.openItemDetail(selectedNodeId);
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
    document.querySelectorAll('[data-graph-node-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            selectedNodeId = btn.dataset.graphNodeId || '';
            canvasRef.current?.setSelected(selectedNodeId || null);
            updateInfoPanel();
            syncCanvas();
            updateFilterToolbarState();
        });
    });
    document.querySelectorAll('[data-graph-query]').forEach((btn) => {
        btn.addEventListener('click', () => {
            filter = { ...filter, query: btn.dataset.graphQuery || '' };
            const inp = document.getElementById('graph-filter-query');
            if (inp)
                inp.value = filter.query;
            updateInfoPanel();
            syncCanvas();
        });
    });
    document.querySelectorAll('[data-graph-from-id][data-graph-to-id]').forEach((btn) => {
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
function bindHudEvents() {
    // Back button
    document.getElementById('graph-back-btn')?.addEventListener('click', () => {
        removeCtxMenu();
        // Remove graph keyboard handler
        const kh = window.__graphKeyHandler;
        if (kh) {
            document.removeEventListener('keydown', kh);
            delete window.__graphKeyHandler;
        }
        window.__app.showView('items');
    });
    const runGraphSync = async () => {
        if (!state.currentProject || graphSyncInFlight)
            return;
        const syncBtn = document.getElementById('graph-sync-btn');
        graphSyncInFlight = true;
        if (syncBtn) {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Syncing…';
        }
        try {
            await api('POST', `/projects/${state.currentProject.id}/pm/graph/sync`);
            toast('Graph sync completed', 'success');
            await renderGraphView();
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
        finally {
            graphSyncInFlight = false;
            if (syncBtn) {
                syncBtn.disabled = false;
                syncBtn.textContent = '⧉ Sync';
            }
        }
    };
    // Refresh
    document.getElementById('graph-refresh')?.addEventListener('click', () => {
        canvasRef.current?.destroy();
        canvasRef.current = null;
        void renderGraphView();
    });
    document.getElementById('graph-sync-btn')?.addEventListener('click', () => {
        void runGraphSync();
    });
    // Fit view
    document.getElementById('graph-fit-btn')?.addEventListener('click', () => canvasRef.current?.fitView());
    document.querySelectorAll('[data-graph-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const preset = btn.dataset.graphPreset || 'knowledge';
            if (preset === 'knowledge') {
                filter = { ...filter, depMode: false, kind: 'items', rel: 'all', scope: 'all', direction: 'all', colorMode: 'status' };
            }
            else if (preset === 'dependency') {
                filter = { ...filter, depMode: true, kind: 'items', rel: 'all', scope: 'all', direction: 'all', layout: 'hierarchical' };
                canvasRef.current?.setLayout('hierarchical');
            }
            else if (preset === 'unlinked') {
                filter = { ...filter, depMode: false, kind: 'unlinked', rel: 'all', scope: 'all', direction: 'all' };
            }
            else if (preset === 'metadata') {
                filter = { ...filter, depMode: false, kind: 'all', rel: 'all', scope: 'all', direction: 'all', colorMode: 'type' };
            }
            else if (preset === 'critical') {
                const nextSelected = selectedNodeId || [...criticalPath][0] || '';
                selectedNodeId = nextSelected;
                filter = { ...filter, depMode: true, kind: 'items', rel: 'all', scope: nextSelected ? 'focus' : 'all', depth: '2', direction: 'connected', layout: 'hierarchical' };
                canvasRef.current?.setLayout('hierarchical');
                canvasRef.current?.setSelected(nextSelected || null);
            }
            else if (preset === 'tags') {
                filter = { ...filter, depMode: false, kind: 'all', rel: 'all', scope: 'all', direction: 'all', colorMode: 'tag', layout: 'force' };
                canvasRef.current?.setLayout('force');
            }
            updateInfoPanel();
            syncCanvas();
            updateFilterToolbarState();
            updateLegend();
            // Sync color-mode select to reflect new colorMode (for Filters panel)
            const colorSel = document.getElementById('graph-color-mode');
            if (colorSel)
                colorSel.value = filter.colorMode;
            // Fit and reheat after preset switch so the new layout settles cleanly
            setTimeout(() => { canvasRef.current?.reheat(); canvasRef.current?.fitView(); }, 80);
            document.querySelectorAll('[data-graph-preset]').forEach((presetBtn) => {
                presetBtn.classList.toggle('active', graphPresetActive(presetBtn.dataset.graphPreset || ''));
            });
            pushGraphState();
        });
    });
    // Physics toggle
    document.getElementById('graph-physics-btn')?.addEventListener('click', (e) => {
        const paused = canvasRef.current?.togglePhysics() ?? false;
        physicsLabel = paused ? 'Resume Physics' : 'Pause Physics';
        e.target.textContent = physicsLabel;
    });
    // Export PNG
    document.getElementById('graph-export-png')?.addEventListener('click', () => {
        canvasRef.current?.exportPng();
    });
    // Layout selector
    document.getElementById('graph-layout-select')?.addEventListener('change', (e) => {
        const layout = e.target.value;
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
    const onFilterChange = (id, key, getValue) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            const val = getValue(e.target);
            filter = { ...filter, [key]: val };
            if (key === 'rel') {
                canvasRef.current?.setFilter({ highlightRelTypes: val !== 'all' ? new Set([val]) : new Set() });
            }
            updateInfoPanel();
            syncCanvas();
            updateFilterToolbarState();
        });
    };
    onFilterChange('graph-filter-kind', 'kind', (el) => el.value);
    onFilterChange('graph-filter-rel', 'rel', (el) => el.value);
    onFilterChange('graph-filter-direction', 'direction', (el) => el.value);
    onFilterChange('graph-filter-status', 'statusFilter', (el) => el.value);
    // Depth slider (range input, not select)
    const depthSlider = document.getElementById('graph-filter-depth');
    const depthLabel = document.getElementById('graph-depth-label');
    depthSlider?.addEventListener('input', () => {
        filter = { ...filter, depth: depthSlider.value };
        if (depthLabel)
            depthLabel.textContent = depthSlider.value;
        updateInfoPanel();
        syncCanvas();
        updateFilterToolbarState();
        pushGraphState();
    });
    // All filter changes push URL state
    document.querySelectorAll('#graph-filter-overlay select').forEach((sel) => {
        sel.addEventListener('change', () => pushGraphState());
    });
    // Physics panel toggle
    document.getElementById('graph-physics-panel-toggle')?.addEventListener('click', () => {
        physicsOpen = !physicsOpen;
        document.getElementById('graph-physics-panel')?.classList.toggle('open', physicsOpen);
        document.getElementById('graph-physics-panel-toggle')?.classList.toggle('active', physicsOpen);
        if (physicsOpen && canvasRef.current) {
            const params = canvasRef.current.getPhysicsParams();
            const repEl = document.getElementById('graph-physics-repulsion');
            const ldEl = document.getElementById('graph-physics-linkdist');
            const lsEl = document.getElementById('graph-physics-linkstr');
            const gEl = document.getElementById('graph-physics-gravity');
            if (repEl) {
                repEl.value = String(params.repulsion);
            }
            if (ldEl) {
                ldEl.value = String(params.linkDistance);
            }
            if (lsEl) {
                lsEl.value = String(Math.round(params.linkStrength * 100));
            }
            if (gEl) {
                gEl.value = String(Math.round(params.centerForce * 1000));
            }
        }
    });
    document.getElementById('graph-physics-close')?.addEventListener('click', () => {
        physicsOpen = false;
        document.getElementById('graph-physics-panel')?.classList.remove('open');
        document.getElementById('graph-physics-panel-toggle')?.classList.remove('active');
    });
    const bindPhysicsSlider = (id, valId, key, scale, decimals) => {
        const el = document.getElementById(id);
        const valEl = document.getElementById(valId);
        el?.addEventListener('input', () => {
            const raw = parseFloat(el.value) / scale;
            if (valEl)
                valEl.textContent = decimals > 0 ? raw.toFixed(decimals) : String(Math.round(raw * scale));
            canvasRef.current?.setPhysicsParams({ [key]: raw });
        });
    };
    bindPhysicsSlider('graph-physics-repulsion', 'graph-physics-repulsion-val', 'repulsion', 1, 0);
    bindPhysicsSlider('graph-physics-linkdist', 'graph-physics-linkdist-val', 'linkDistance', 1, 0);
    bindPhysicsSlider('graph-physics-linkstr', 'graph-physics-linkstr-val', 'linkStrength', 100, 3);
    bindPhysicsSlider('graph-physics-gravity', 'graph-physics-gravity-val', 'centerForce', 1000, 3);
    document.getElementById('graph-physics-reset')?.addEventListener('click', () => {
        canvasRef.current?.setPhysicsParams({ repulsion: 2000, linkDistance: 140, linkStrength: 0.065, centerForce: 0.010 });
        const repEl = document.getElementById('graph-physics-repulsion');
        const ldEl = document.getElementById('graph-physics-linkdist');
        const lsEl = document.getElementById('graph-physics-linkstr');
        const gEl = document.getElementById('graph-physics-gravity');
        if (repEl)
            repEl.value = '2000';
        if (ldEl)
            ldEl.value = '140';
        if (lsEl)
            lsEl.value = '7';
        if (gEl)
            gEl.value = '10';
        const repValEl = document.getElementById('graph-physics-repulsion-val');
        const ldValEl = document.getElementById('graph-physics-linkdist-val');
        const lsValEl = document.getElementById('graph-physics-linkstr-val');
        const gValEl = document.getElementById('graph-physics-gravity-val');
        if (repValEl)
            repValEl.textContent = '2000';
        if (ldValEl)
            ldValEl.textContent = '140';
        if (lsValEl)
            lsValEl.textContent = '0.065';
        if (gValEl)
            gValEl.textContent = '0.010';
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
        updateLegend();
        const btn = document.getElementById('graph-dep-mode-btn');
        btn?.classList.toggle('active', filter.depMode);
        const strong = btn?.querySelector('strong');
        if (strong)
            strong.textContent = filter.depMode ? 'On' : 'Off';
    });
    document.getElementById('graph-color-mode')?.addEventListener('change', (e) => {
        filter = { ...filter, colorMode: e.target.value };
        syncCanvas();
        updateLegend();
        // If switching to tag mode, reheat so clustering force takes effect
        if (filter.colorMode === 'tag')
            canvasRef.current?.reheat();
        // Sync preset buttons
        document.querySelectorAll('[data-graph-preset]').forEach((b) => {
            b.classList.toggle('active', graphPresetActive(b.dataset.graphPreset || ''));
        });
        pushGraphState();
    });
    // Search input
    const queryInput = document.getElementById('graph-filter-query');
    queryInput?.addEventListener('input', (e) => {
        filter = { ...filter, query: e.target.value };
        updateInfoPanel();
        syncCanvas();
    });
    // Global keyboard shortcuts for the graph view
    const graphKeyHandler = (e) => {
        const tag = e.target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea')
            return;
        if (e.code === 'Space' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const paused = canvasRef.current?.togglePhysics() ?? false;
            physicsLabel = paused ? 'Resume Physics' : 'Pause Physics';
            const physBtn = document.getElementById('graph-physics-btn');
            if (physBtn)
                physBtn.textContent = physicsLabel;
        }
        if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            canvasRef.current?.fitView();
        }
        if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            canvasRef.current?.destroy();
            canvasRef.current = null;
            void renderGraphView();
        }
        if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            void runGraphSync();
        }
        if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            infoDrawerOpen = !infoDrawerOpen;
            document.getElementById('graph-info-drawer')?.classList.toggle('open', infoDrawerOpen);
            document.getElementById('graph-info-toggle')?.classList.toggle('active', infoDrawerOpen);
        }
        if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            filterOpen = !filterOpen;
            document.getElementById('graph-filter-overlay')?.classList.toggle('open', filterOpen);
            document.getElementById('graph-filter-toggle')?.classList.toggle('active', filterOpen);
        }
        if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            queryInput?.focus();
        }
    };
    document.addEventListener('keydown', graphKeyHandler);
    // Store for cleanup on graph exit
    window.__graphKeyHandler = graphKeyHandler;
}
// ── URL routing (pushState) ─────────────────────────────────
function pushGraphState() {
    if (!state.currentProject)
        return;
    const params = new URLSearchParams();
    params.set('project', state.currentProject.id);
    params.set('graph', '1');
    if (selectedNodeId)
        params.set('node', selectedNodeId);
    if (filter.scope === 'focus')
        params.set('scope', 'focus');
    if (filter.kind !== 'all')
        params.set('kind', filter.kind);
    if (filter.colorMode !== 'status')
        params.set('color', filter.colorMode);
    if (filter.depMode)
        params.set('dep', '1');
    if (filter.layout !== 'force')
        params.set('layout', filter.layout);
    const qs = params.toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    history.replaceState(null, '', url);
}
let urlStateRestored = false;
function restoreGraphState() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('graph'))
        return;
    urlStateRestored = true;
    if (params.has('node'))
        selectedNodeId = params.get('node') || '';
    if (params.has('scope'))
        filter = { ...filter, scope: params.get('scope') };
    if (params.has('kind'))
        filter = { ...filter, kind: (params.get('kind') || 'all') };
    if (params.has('color'))
        filter = { ...filter, colorMode: (params.get('color') || 'status') };
    if (params.has('dep'))
        filter = { ...filter, depMode: params.get('dep') === '1' };
    if (params.has('layout'))
        filter = { ...filter, layout: (params.get('layout') || 'force') };
}
// ── Dependency editing modals ────────────────────────────────
function showAddDependencyModal() {
    if (!state.currentProject || !currentGraph)
        return;
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
        const fromSel = document.getElementById('graph-dep-from');
        if (fromSel)
            fromSel.value = selectedNodeId;
    }
    document.getElementById('graph-dep-submit')?.addEventListener('click', async () => {
        const fromId = document.getElementById('graph-dep-from')?.value;
        const toId = document.getElementById('graph-dep-to')?.value;
        const relType = document.getElementById('graph-dep-type')?.value;
        const errEl = document.getElementById('graph-dep-error');
        if (!fromId || !toId || fromId === toId) {
            if (errEl) {
                errEl.textContent = 'Select two different items.';
                errEl.style.display = '';
            }
            return;
        }
        try {
            await api('POST', `/projects/${state.currentProject.id}/pm/deps/${fromId}`, { targetId: toId, rel: relType });
            document.getElementById('graph-add-dep-modal')?.remove();
            // Refresh graph
            canvasRef.current?.destroy();
            canvasRef.current = null;
            void renderGraphView();
        }
        catch (err) {
            if (errEl) {
                errEl.textContent = err instanceof Error ? err.message : String(err);
                errEl.style.display = '';
            }
        }
    });
}
function showRemoveDependencyModal() {
    if (!state.currentProject || !currentGraph)
        return;
    const graph = currentGraph.graph || {};
    const rels = graph.relationships || [];
    const depRels = rels.filter(isDependencyRel);
    const options = depRels.map((r, i) => {
        const nodes = graph.nodes || [];
        const from = nodes.find((n) => n.id === r.from);
        const to = nodes.find((n) => n.id === r.to);
        return `<option value="${i}">${escHtml(dependencyLabel(r))}: ${escHtml(nodeTitle(from || { id: r.from }))} → ${escHtml(nodeTitle(to || { id: r.to }))}</option>`;
    }).join('');
    if (!depRels.length) {
        window.__app.toast('No dependencies to remove', 'info');
        return;
    }
    const html = `
    <div class="modal-backdrop" id="graph-remove-dep-modal" style="display:flex">
      <div class="modal" style="max-width:440px">
        <div class="modal-header">
          <div class="modal-title">Remove Dependency</div>
          <button class="modal-close" onclick="document.getElementById('graph-remove-dep-modal')?.remove()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Select dependency to remove</label>
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
        const selIdx = parseInt(document.getElementById('graph-remove-dep-select')?.value ?? '-1', 10);
        const errEl = document.getElementById('graph-remove-dep-error');
        const rel = depRels[selIdx];
        if (!rel) {
            if (errEl) {
                errEl.textContent = 'Select a dependency.';
                errEl.style.display = '';
            }
            return;
        }
        try {
            await api('DELETE', `/projects/${state.currentProject.id}/pm/deps/${rel.from}`, { targetId: rel.to, rel: rel.type });
            document.getElementById('graph-remove-dep-modal')?.remove();
            // Refresh graph
            canvasRef.current?.destroy();
            canvasRef.current = null;
            void renderGraphView();
        }
        catch (err) {
            if (errEl) {
                errEl.textContent = err instanceof Error ? err.message : String(err);
                errEl.style.display = '';
            }
        }
    });
}
// ── Main entry point ──────────────────────────────────────────
export async function renderGraphView() {
    const el = document.getElementById('content-graph');
    if (!el)
        return;
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
        currentGraph = await api('GET', `/projects/${state.currentProject.id}/pm/graph`);
        selectedItemCache = null;
        if (!urlStateRestored) {
            selectedNodeId = '';
            filter = { query: '', kind: 'items', rel: 'all', direction: 'all', scope: 'all', depth: '1', colorMode: 'status', depMode: false, layout: 'force', edgeBundling: false, statusFilter: '' };
        }
        criticalPath = computeCriticalPath(currentGraph.graph?.relationships ?? []);
        el.innerHTML = renderGraphShell(currentGraph);
        bindHudEvents();
        bindInfoPanelEvents();
        initCanvas();
        // Restore selected node after canvas init
        if (selectedNodeId) {
            canvasRef.current?.setSelected(selectedNodeId);
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
    }
    catch (err) {
        canvasRef.current?.destroy();
        canvasRef.current = null;
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px">Graph failed to load: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
}
/**
 * Lightweight refresh from SSE events — updates graph data in-place
 * without destroying zoom/pan state.
 */
export async function refreshGraphData() {
    if (!state.currentProject || !canvasRef.current) {
        return renderGraphView();
    }
    try {
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/graph`);
        currentGraph = data;
        const graph = data.graph || {};
        const nodes = graph.nodes || [];
        const rels = graph.relationships || [];
        canvasRef.current.setData(toCanvasNodes(nodes, rels), toCanvasEdges(rels));
        updateInfoPanel();
        syncCanvas();
    }
    catch {
        // Silently ignore — user can hit Refresh manually
    }
}
// ── Local graph (embedded mini-graph for item detail) ─────────
// Registry of active local graph canvases so they can be cleaned up
const localGraphRegistry = new Map();
export function destroyLocalGraph(containerId) {
    const existing = localGraphRegistry.get(containerId);
    if (existing) {
        existing.destroy();
        localGraphRegistry.delete(containerId);
    }
}
export async function renderLocalGraph(containerId, nodeId, depth = 2) {
    const container = document.getElementById(containerId);
    if (!container || !state.currentProject)
        return;
    // Cleanup previous instance
    destroyLocalGraph(containerId);
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--text-muted);font-size:12px"><div class="loading-spinner" style="width:16px;height:16px"></div>Loading…</div>';
    // Use cached graph data if available, otherwise fetch
    let graphData = currentGraph;
    if (!graphData?.graph?.nodes?.length) {
        try {
            graphData = await api('GET', `/projects/${state.currentProject.id}/pm/graph`);
        }
        catch {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px">Graph unavailable.</div>';
            return;
        }
    }
    const graph = graphData.graph || {};
    const nodes = graph.nodes || [];
    const rels = graph.relationships || [];
    // Get neighborhood
    const neighborIds = expandedNeighborIds(nodeId, rels, depth, 'connected');
    if (neighborIds.size < 2) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;text-align:center">No connections to display.<br><small>Add dependencies or tags to see the local graph.</small></div>';
        return;
    }
    const subNodes = nodes.filter((n) => neighborIds.has(n.id));
    const subRels = rels.filter((r) => neighborIds.has(r.from) && neighborIds.has(r.to));
    const deg = degreeMap(subRels);
    container.innerHTML = '';
    container.style.position = 'relative';
    container.style.background = '#080d1a';
    container.style.borderRadius = '8px';
    container.style.overflow = 'hidden';
    const canvas = new GraphCanvas(container, {
        layout: 'force',
        onSelectNode(id) {
            if (!id)
                return;
            canvas.setSelected(id);
            // Clicking a neighbor node navigates to its item detail
            if (id !== nodeId) {
                const n = nodes.find((nd) => nd.id === id);
                if (n && isItemNode(n)) {
                    const appw = window;
                    appw.__app?.openItemDetail(id);
                }
            }
        },
        onOpenNode(id) {
            const appw = window;
            appw.__app?.openItemDetail(id);
        },
        onContextMenu() { },
    });
    const canvasNodes = subNodes.map((n) => ({
        id: n.id,
        label: nodeTitle(n),
        type: nodeType(n),
        status: nodeStatus(n),
        lane: nodeLane(n),
        degree: deg.get(n.id) || 0,
        tags: Array.isArray(n.properties?.tags) ? n.properties.tags.map(String) : [],
    }));
    const canvasEdges = subRels.map((r) => ({ from: r.from, to: r.to, type: r.type }));
    canvas.setData(canvasNodes, canvasEdges);
    canvas.setSelected(nodeId);
    canvas.setFilter({
        visibleNodeIds: null,
        selectedId: nodeId,
        query: '',
        highlightRelTypes: new Set(),
        colorMode: 'status',
        colorTag: '',
        criticalPathIds: new Set(),
    });
    localGraphRegistry.set(containerId, canvas);
}
//# sourceMappingURL=graph.js.map