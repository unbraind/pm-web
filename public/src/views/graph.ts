import { api } from '../api.js';
import { state } from '../state.js';
import type { GraphNode, GraphRelationship, ProjectGraph } from '../types.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';

type GraphResponse = {
  graph?: ProjectGraph;
  extensionAvailable?: boolean;
  extensionError?: string;
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

function renderRelationship(rel: GraphRelationship, nodesById: Map<string, GraphNode>): string {
  const from = nodesById.get(rel.from);
  const to = nodesById.get(rel.to);
  return `
    <div class="graph-rel-row">
      <div>
        <div class="graph-rel-title">${escHtml(nodeTitle(from || { id: rel.from }))}</div>
        <div class="graph-rel-id">${escHtml(rel.from)}</div>
      </div>
      <div class="graph-rel-type">${escHtml(rel.type)}</div>
      <div>
        <div class="graph-rel-title">${escHtml(nodeTitle(to || { id: rel.to }))}</div>
        <div class="graph-rel-id">${escHtml(rel.to)}</div>
      </div>
    </div>`;
}

function renderGraph(data: GraphResponse): string {
  const graph = data.graph || {};
  const nodes = graph.nodes || [];
  const relationships = graph.relationships || [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const connected = new Set(relationships.flatMap((rel) => [rel.from, rel.to]));
  const itemNodes = nodes.filter((node) => node.labels?.includes('PmItem') || !node.id.includes(':'));
  const facetNodes = nodes.filter((node) => node.labels?.includes('PmFacet'));
  const isolatedCount = itemNodes.filter((node) => !connected.has(node.id)).length;
  const typeCounts = nodes.reduce<Record<string, number>>((acc, node) => {
    const type = nodeType(node);
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const relCounts = relationships.reduce<Record<string, number>>((acc, rel) => {
    acc[rel.type] = (acc[rel.type] || 0) + 1;
    return acc;
  }, {});

  return `
    <div class="view-header">
      <div>
        <h1>Knowledge Graph</h1>
        <p class="view-subtitle">Item relationships generated from pm data${data.extensionAvailable ? ' through pm-graph' : ' with the built-in pm-web fallback'}.</p>
      </div>
      <button class="btn btn-primary" onclick="window.__app.syncGraphToNeo4j()">Sync Neo4j</button>
    </div>

    <div class="graph-status ${data.extensionAvailable ? 'graph-status-ok' : ''}">
      <div>
        <div class="graph-status-title">${data.extensionAvailable ? 'pm-graph extension active' : 'pm-graph extension not active'}</div>
        <div class="graph-status-text">
          ${data.extensionAvailable
            ? 'Graph data came from pm pm-graph export. Neo4j sync uses pm pm-graph sync and NEO4J_* environment variables.'
            : 'Using pm-web fallback graph from live pm items, dependencies, tags, status, type, assignee, sprint, and release metadata. Neo4j sync is still available with NEO4J_* environment variables.'}
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

    <div class="graph-layout">
      <section class="graph-panel">
        <div class="graph-panel-title">Relationship Map</div>
        ${relationships.length === 0
          ? '<div class="empty-state"><div class="empty-state-text">No parent or dependency relationships yet.</div></div>'
          : relationships.slice(0, 80).map((rel) => renderRelationship(rel, nodesById)).join('')}
      </section>
      <section class="graph-panel">
        <div class="graph-panel-title">Nodes by Kind</div>
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
        <div class="graph-panel-title graph-panel-title-spaced">Recent Nodes</div>
        <div class="graph-node-list">
          ${itemNodes.slice(0, 24).map((node) => `
            <button class="graph-node" onclick="window.__app.openItemDetail('${escHtml(node.id)}')">
              <span>
                <strong>${escHtml(nodeTitle(node))}</strong>
                <small>${escHtml(node.id)} · ${escHtml(nodeStatus(node))}</small>
              </span>
              <em>${escHtml(nodeType(node))}</em>
            </button>
          `).join('')}
        </div>
      </section>
    </div>`;
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
    const data = await api('GET', `/projects/${state.currentProject.id}/pm/graph`) as GraphResponse;
    el.innerHTML = renderGraph(data);
  } catch (err: unknown) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Graph failed: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

export async function syncGraphToNeo4j(): Promise<void> {
  if (!state.currentProject) return;
  try {
    const result = await api('POST', `/projects/${state.currentProject.id}/pm/graph/sync`, {});
    const syncedNodes = result.syncedNodes ?? 0;
    const syncedRelationships = result.syncedRelationships ?? 0;
    toast(`Synced ${syncedNodes} nodes and ${syncedRelationships} relationships`, 'success');
    await renderGraphView();
  } catch (err: unknown) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}
