// ═══════════════════════════════════════════════════════════════
// GRAPH CANVAS — Obsidian-quality force-directed knowledge graph
// Canvas 2D + physics simulation, no external dependencies
// Features: minimap, animated edge particles, dot grid, tooltip,
//           keyboard nav, fly-to, gradient nodes, zoom HUD,
//           spatial partitioning, edge bundling, hierarchical layout
// ═══════════════════════════════════════════════════════════════

export interface CanvasNode {
  id: string;
  label: string;
  type: string;
  status: string;
  lane: 'item' | 'facet' | 'external';
  degree: number;
  tags?: string[];
}

export interface CanvasEdge {
  from: string;
  to: string;
  type: string;
}

export type LayoutMode = 'force' | 'hierarchical';

export interface GraphCanvasOptions {
  onSelectNode(id: string | null): void;
  onOpenNode(id: string): void;
  onContextMenu(id: string, x: number, y: number): void;
  layout?: LayoutMode;
  edgeBundling?: boolean;
  onExportPng?(canvas: HTMLCanvasElement): void;
}

export interface CanvasFilter {
  visibleNodeIds: Set<string> | null;
  selectedId: string | null;
  query: string;
  highlightRelTypes: Set<string>;
  colorMode: 'status' | 'type' | 'tag';
  colorTag: string;
  criticalPathIds: Set<string>;
}

// ── Palette ───────────────────────────────────────────────────
const STATUS_COLORS: Record<string, string> = {
  open:          '#2dd4bf',
  'in-progress': '#fb923c',
  in_progress:   '#fb923c',
  closed:        '#64748b',
  blocked:       '#f87171',
  draft:         '#94a3b8',
};

const TYPE_COLORS: Record<string, string> = {
  task:       '#2dd4bf',
  feature:    '#60a5fa',
  epic:       '#a78bfa',
  bug:        '#f87171',
  milestone:  '#fbbf24',
  story:      '#34d399',
  chore:      '#94a3b8',
  release:    '#38bdf8',
};
const TYPE_COLOR_DEFAULT = '#64748b';

const TAG_PALETTE = ['#2dd4bf','#60a5fa','#a78bfa','#f87171','#fbbf24','#34d399','#fb923c','#e879f9'];

const TYPE_ABBR: Record<string, string> = {
  task:      'T',
  feature:   'F',
  epic:      'E',
  bug:       'B',
  milestone: 'M',
  story:     'S',
  chore:     'C',
  release:   'R',
};

const LANE_COLOR: Record<CanvasNode['lane'], string> = {
  item:     '#2dd4bf',
  facet:    '#60a5fa',
  external: '#f87171',
};

const EDGE_COLOR: Record<string, string> = {
  PARENT_OF:    '#60a5fa',
  CHILD_OF:     '#60a5fa',
  DEPENDS_ON:   '#fb923c',
  BLOCKED_BY:   '#f87171',
  HAS_TAG:      '#8b5cf6',
  HAS_ASSIGNEE: '#34d399',
  IN_SPRINT:    '#38bdf8',
  IN_RELEASE:   '#a78bfa',
};
const EDGE_DEFAULT = 'rgba(148,163,184,0.3)';

// ── Internal types ────────────────────────────────────────────
interface SimNode extends CanvasNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  r: number;
  color: string;
}

interface SimEdge extends CanvasEdge {
  source: SimNode;
  target: SimNode;
}

/** A particle flowing along an edge */
interface Particle {
  edge: SimEdge;
  t: number;     // 0..1 position along edge
  speed: number;
}

// ── Helpers ───────────────────────────────────────────────────
function nodeRadius(degree: number): number {
  return Math.max(8, Math.min(28, 8 + Math.sqrt(Math.max(0, degree)) * 4.2));
}

function statusColor(node: CanvasNode): string {
  if (node.lane === 'facet')    return LANE_COLOR.facet;
  if (node.lane === 'external') return LANE_COLOR.external;
  return STATUS_COLORS[node.status] ?? LANE_COLOR.item;
}

function getEdgeColor(type: string): string {
  return EDGE_COLOR[type] ?? EDGE_DEFAULT;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hexAlpha(hex: string, a: number): string {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

function initialPositions(nodes: CanvasNode[]): Array<{ x: number; y: number }> {
  const golden = 2.399963;
  return nodes.map((_, i) => {
    const radius = 70 + Math.sqrt(i) * 60;
    const angle  = i * golden;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

/** Graham scan convex hull — returns hull in counter-clockwise order */
function convexHull(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (pts.length < 3) return pts.slice();
  let bot = pts[0];
  for (const p of pts) if (p.y < bot.y || (p.y === bot.y && p.x < bot.x)) bot = p;
  const rest = pts.filter((p) => p !== bot);
  rest.sort((a, b) => {
    const ax = a.x - bot.x, ay = a.y - bot.y;
    const bx = b.x - bot.x, by = b.y - bot.y;
    const cross = ax * by - ay * bx;
    if (Math.abs(cross) < 1e-9) return (ax * ax + ay * ay) - (bx * bx + by * by);
    return -cross;
  });
  const hull: Array<{ x: number; y: number }> = [bot];
  for (const p of rest) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2], b = hull[hull.length - 1];
      if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0) hull.pop();
      else break;
    }
    hull.push(p);
  }
  return hull;
}

// escHtml is imported from utils.ts in graph.ts — canvas uses its own for DOM tooltip only
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════
// GraphCanvas class
// ═══════════════════════════════════════════════════════════════
export class GraphCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;
  private w = 0;
  private h = 0;

  // Simulation
  private nodes: SimNode[] = [];
  private edges: SimEdge[] = [];
  private nodeMap = new Map<string, SimNode>();
  private alpha = 1;
  private paused = false;

  // Physics constants (mutable for live slider control)
  private readonly ALPHA_DECAY   = 0.020;
  private readonly ALPHA_MIN     = 0.001;
  private VEL_DECAY     = 0.56;
  private REPULSE       = 2000;
  private SPRING        = 0.065;
  private REST_LEN      = 140;
  private CENTER        = 0.010;
  private LINK_DIST_FAC = 80;

  // Camera
  private tx = 0;
  private ty = 0;
  private scale = 1;

  // Camera fly-to
  private flyTarget: { tx: number; ty: number; scale: number } | null = null;

  // Interaction
  private isDraggingNode   = false;
  private isDraggingCanvas = false;
  private dragNode: SimNode | null = null;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  private hasMoved = false;
  private hoveredId: string | null = null;

  // Touch
  private touchDist = 0;
  private touchMidX = 0;
  private touchMidY = 0;

  // Particles
  private particles: Particle[] = [];
  private lastParticleSpawn = 0;

  // Pulse animation (selected node)
  private pulseT = 0;

  // Animated dash offset for cluster borders
  private dashOffset = 0;

  // Keyboard nav: ordered list of visible node ids
  private navOrder: string[] = [];

  // Filter
  private filter: CanvasFilter = {
    visibleNodeIds:    null,
    selectedId:        null,
    query:             '',
    highlightRelTypes: new Set(),
    colorMode:         'status',
    colorTag:          '',
    criticalPathIds:   new Set(),
  };

  // RAF + cleanup
  private rafId: number | null = null;
  private destroyed = false;
  private abortCtrl = new AbortController();
  private ro: ResizeObserver;

  // Bidirectional edge pairs (precomputed in setData)
  private biDirPairs = new Set<string>();

  // Tag→color map for tag colorMode (recomputed in recolorNodes)
  private tagColorMap = new Map<string, string>();

  // Layout mode
  private layout: LayoutMode = 'force';

  // Edge bundling
  private edgeBundling = false;

  // Spatial grid for culling
  private gridCells = new Map<number, SimNode[]>();
  private gridCellSize = 200;
  private gridOriginX = 0;
  private gridOriginY = 0;

  // Initial load zoom-to-fit
  private initialFitDone = false;
  private initialFitTimer: ReturnType<typeof setTimeout> | null = null;

  // Callbacks
  private onSelectNode:   (id: string | null) => void;
  private onOpenNode:     (id: string) => void;
  private onContextMenu:  (id: string, x: number, y: number) => void;
  private onExportPng:    ((canvas: HTMLCanvasElement) => void) | undefined;

  constructor(container: HTMLElement, options: GraphCanvasOptions) {
    this.onSelectNode  = options.onSelectNode;
    this.onOpenNode    = options.onOpenNode;
    this.onContextMenu = options.onContextMenu;
    this.onExportPng   = options.onExportPng;
    this.layout        = options.layout ?? 'force';
    this.edgeBundling  = options.edgeBundling ?? false;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'width:100%;height:100%;display:block;touch-action:none;cursor:grab;outline:none;';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(container);
    this.onResize();
    this.bindEvents();
    this.startLoop();
  }

  // ── Public API ─────────────────────────────────────────────

  setData(nodes: CanvasNode[], edges: CanvasEdge[]): void {
    const prevPos = new Map(this.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const initPos = initialPositions(nodes);

    this.nodes = nodes.map((node, i) => {
      const prev = prevPos.get(node.id);
      return {
        ...node,
        x:  prev?.x ?? initPos[i].x,
        y:  prev?.y ?? initPos[i].y,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        r:  nodeRadius(node.degree),
        color: statusColor(node),
      };
    });

    this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

    this.edges = edges.flatMap((e) => {
      const source = this.nodeMap.get(e.from);
      const target = this.nodeMap.get(e.to);
      return source && target ? [{ ...e, source, target }] : [];
    });

    this.alpha     = 1;
    this.particles = [];
    this.navOrder  = nodes.map((n) => n.id);

    // Precompute bidirectional edge pairs
    const edgeKeySet = new Set(this.edges.map((e) => `${e.source.id}→${e.target.id}`));
    this.biDirPairs = new Set<string>();
    for (const e of this.edges) {
      if (edgeKeySet.has(`${e.target.id}→${e.source.id}`)) {
        this.biDirPairs.add([e.source.id, e.target.id].sort().join('|'));
      }
    }

    this.recolorNodes();

    // Initial zoom-to-fit animation
    this.initialFitDone = false;
    if (this.initialFitTimer) clearTimeout(this.initialFitTimer);
    this.initialFitTimer = setTimeout(() => {
      this.fitView();
      this.initialFitDone = true;
    }, 1400);

    // Apply hierarchical layout if selected
    if (this.layout === 'hierarchical') {
      this.applyHierarchicalLayout();
    }
  }

  setFilter(filter: Partial<CanvasFilter>): void {
    const prevMode = this.filter.colorMode;
    const prevTag  = this.filter.colorTag;
    this.filter = { ...this.filter, ...filter };
    this.navOrder = this.nodes
      .filter((n) => !this.filter.visibleNodeIds || this.filter.visibleNodeIds.has(n.id))
      .map((n) => n.id);
    if ('selectedId' in filter) {
      this.particles = [];
      this.lastParticleSpawn = 0;
    }
    if (filter.colorMode !== undefined && filter.colorMode !== prevMode) this.recolorNodes();
    else if (filter.colorTag !== undefined && filter.colorTag !== prevTag) this.recolorNodes();
  }

  getTagColorMap(): Map<string, string> { return this.tagColorMap; }

  // Live physics control — used by the physics sliders panel
  setPhysicsParams(params: {
    repulsion?: number;
    linkDistance?: number;
    centerForce?: number;
    linkStrength?: number;
  }): void {
    if (params.repulsion   !== undefined) this.REPULSE  = params.repulsion;
    if (params.linkDistance !== undefined) { this.REST_LEN = params.linkDistance; this.LINK_DIST_FAC = params.linkDistance * 0.57; }
    if (params.centerForce !== undefined) this.CENTER   = params.centerForce;
    if (params.linkStrength !== undefined) this.SPRING  = params.linkStrength;
    this.reheat();
  }

  getPhysicsParams(): { repulsion: number; linkDistance: number; centerForce: number; linkStrength: number } {
    return { repulsion: this.REPULSE, linkDistance: this.REST_LEN, centerForce: this.CENTER, linkStrength: this.SPRING };
  }

  setSelected(id: string | null): void {
    this.filter = { ...this.filter, selectedId: id };
    this.particles = [];
    this.lastParticleSpawn = 0;
    if (id) {
      const node = this.nodeMap.get(id);
      if (node) this.flyTo(node);
    }
  }

  jumpToNode(id: string): void {
    const node = this.nodeMap.get(id);
    if (node) this.flyTo(node);
  }

  fitView(): void {
    if (!this.nodes.length) return;
    const vis = this.filter.visibleNodeIds;
    const ns  = vis ? this.nodes.filter((n) => vis.has(n.id)) : this.nodes;
    if (!ns.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const pad = 72;
    const gw  = maxX - minX + pad * 2;
    const gh  = maxY - minY + pad * 2;
    const s   = Math.min(this.w / gw, this.h / gh, 2.5);
    this.flyTarget = {
      tx:    this.w / 2 - ((minX + maxX) / 2) * s,
      ty:    this.h / 2 - ((minY + maxY) / 2) * s,
      scale: s,
    };
  }

  togglePhysics(): boolean {
    this.paused = !this.paused;
    if (!this.paused) this.alpha = Math.max(this.alpha, 0.05);
    return this.paused;
  }

  reheat(): void {
    this.alpha  = 0.3;
    this.paused = false;
  }

  setLayout(layout: LayoutMode): void {
    if (this.layout === layout) return;
    this.layout = layout;
    if (layout === 'hierarchical') {
      this.applyHierarchicalLayout();
    } else {
      // Scatter nodes slightly and reheat force simulation
      for (const n of this.nodes) {
        n.x += (Math.random() - 0.5) * 40;
        n.y += (Math.random() - 0.5) * 40;
      }
      this.reheat();
    }
  }

  setEdgeBundling(enabled: boolean): void {
    this.edgeBundling = enabled;
  }

  exportPng(): void {
    if (this.onExportPng) {
      this.onExportPng(this.canvas);
      return;
    }
    // Default: trigger download
    try {
      const link = document.createElement('a');
      link.download = 'graph-export.png';
      link.href = this.canvas.toDataURL('image/png');
      link.click();
    } catch { /* Canvas tainted — cannot export */ }
  }

  private applyHierarchicalLayout(): void {
    // Topological-sort-based hierarchical layout
    // Build adjacency for layering
    const inDeg = new Map<string, number>();
    const adjOut = new Map<string, string[]>();
    for (const n of this.nodes) {
      inDeg.set(n.id, 0);
      adjOut.set(n.id, []);
    }
    for (const e of this.edges) {
      inDeg.set(e.target.id, (inDeg.get(e.target.id) ?? 0) + 1);
      adjOut.get(e.source.id)?.push(e.target.id);
    }

    // BFS layering from roots (nodes with in-degree 0)
    const layers: string[][] = [];
    const assigned = new Set<string>();
    let frontier = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    if (!frontier.length && this.nodes.length > 0) {
      frontier = [this.nodes[0].id];
    }

    while (frontier.length) {
      layers.push(frontier);
      for (const id of frontier) assigned.add(id);
      const next = new Set<string>();
      for (const id of frontier) {
        for (const child of adjOut.get(id) ?? []) {
          if (!assigned.has(child)) {
            next.add(child);
          }
        }
      }
      frontier = [...next];
    }

    // Assign unassigned nodes to last layer
    for (const n of this.nodes) {
      if (!assigned.has(n.id)) {
        layers[layers.length - 1]?.push(n.id) ?? layers.push([n.id]);
      }
    }

    // Position nodes in layers
    const layerSpacing = 180;
    const nodeSpacing = 100;
    const startY = -((layers.length - 1) * layerSpacing) / 2;

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const startX = -((layer.length - 1) * nodeSpacing) / 2;
      for (let ni = 0; ni < layer.length; ni++) {
        const node = this.nodeMap.get(layer[ni]);
        if (node) {
          node.x = startX + ni * nodeSpacing;
          node.y = startY + li * layerSpacing;
          node.vx = 0;
          node.vy = 0;
        }
      }
    }

    // Freeze positions for hierarchical mode
    this.alpha = 0.005;
  }

  /** Rebuild the spatial grid for culling */
  private rebuildGrid(): void {
    this.gridCells.clear();
    if (!this.nodes.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
    }

    this.gridOriginX = minX - this.gridCellSize;
    this.gridOriginY = minY - this.gridCellSize;
    const cs = this.gridCellSize;

    for (const n of this.nodes) {
      const cx = Math.floor((n.x - this.gridOriginX) / cs);
      const cy = Math.floor((n.y - this.gridOriginY) / cs);
      const key = cx * 10000 + cy;
      let cell = this.gridCells.get(key);
      if (!cell) { cell = []; this.gridCells.set(key, cell); }
      cell.push(n);
    }
  }

  /** Get all nodes within a world-space rectangle */
  private getNodesInRect(wx1: number, wy1: number, wx2: number, wy2: number): SimNode[] {
    const cs = this.gridCellSize;
    const cx1 = Math.floor((wx1 - this.gridOriginX) / cs);
    const cy1 = Math.floor((wy1 - this.gridOriginY) / cs);
    const cx2 = Math.floor((wx2 - this.gridOriginX) / cs);
    const cy2 = Math.floor((wy2 - this.gridOriginY) / cs);

    const result: SimNode[] = [];
    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        const cell = this.gridCells.get(cx * 10000 + cy);
        if (cell) {
          for (const n of cell) {
            if (n.x >= wx1 && n.x <= wx2 && n.y >= wy1 && n.y <= wy2) {
              result.push(n);
            }
          }
        }
      }
    }
    return result;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.initialFitTimer) clearTimeout(this.initialFitTimer);
    this.abortCtrl.abort();
    this.ro.disconnect();
    this.canvas.remove();
    const tt = document.getElementById('gc-tooltip');
    if (tt) tt.remove();
  }

  // ── Color computation ──────────────────────────────────────

  private computeNodeColor(node: SimNode): string {
    if (node.lane === 'facet')    return LANE_COLOR.facet;
    if (node.lane === 'external') return LANE_COLOR.external;
    const mode = this.filter.colorMode;
    if (mode === 'type') {
      return TYPE_COLORS[node.type.toLowerCase()] ?? TYPE_COLOR_DEFAULT;
    }
    if (mode === 'tag') {
      for (const t of node.tags ?? []) {
        const c = this.tagColorMap.get(t);
        if (c) return c;
      }
      return 'rgba(100,116,139,0.45)';
    }
    return STATUS_COLORS[node.status] ?? LANE_COLOR.item;
  }

  private recolorNodes(): void {
    if (this.filter.colorMode === 'tag') {
      const freq = new Map<string, number>();
      for (const n of this.nodes) {
        for (const t of n.tags ?? []) freq.set(t, (freq.get(t) ?? 0) + 1);
      }
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_PALETTE.length).map(([t]) => t);
      this.tagColorMap = new Map(top.map((t, i) => [t, TAG_PALETTE[i]]));
    } else {
      this.tagColorMap = new Map();
    }
    for (const node of this.nodes) node.color = this.computeNodeColor(node);
  }

  // ── Fly-to ─────────────────────────────────────────────────

  private flyTo(node: SimNode): void {
    const targetScale = Math.min(Math.max(this.scale, 1.2), 2.2);
    this.flyTarget = {
      tx:    this.w / 2 - node.x * targetScale,
      ty:    this.h / 2 - node.y * targetScale,
      scale: targetScale,
    };
  }

  private advanceFly(): void {
    if (!this.flyTarget) return;
    const speed = 0.08;
    this.tx    = lerp(this.tx,    this.flyTarget.tx,    speed);
    this.ty    = lerp(this.ty,    this.flyTarget.ty,    speed);
    this.scale = lerp(this.scale, this.flyTarget.scale, speed);
    const distTx    = Math.abs(this.tx    - this.flyTarget.tx);
    const distTy    = Math.abs(this.ty    - this.flyTarget.ty);
    const distScale = Math.abs(this.scale - this.flyTarget.scale);
    if (distTx < 0.5 && distTy < 0.5 && distScale < 0.002) {
      this.tx    = this.flyTarget.tx;
      this.ty    = this.flyTarget.ty;
      this.scale = this.flyTarget.scale;
      this.flyTarget = null;
    }
  }

  // ── Keyboard navigation ────────────────────────────────────

  private navigateToNeighbor(direction: 'next' | 'prev' | 'first-neighbor'): void {
    const sel = this.filter.selectedId;

    if (direction === 'first-neighbor' && sel) {
      const outEdge = this.edges.find((e) => e.source.id === sel || e.target.id === sel);
      if (!outEdge) return;
      const neighbor = outEdge.source.id === sel ? outEdge.target : outEdge.source;
      this.filter = { ...this.filter, selectedId: neighbor.id };
      this.particles = [];
      this.onSelectNode(neighbor.id);
      this.flyTo(neighbor);
      return;
    }

    const order = this.navOrder;
    if (!order.length) return;
    const idx = sel ? order.indexOf(sel) : -1;
    let nextIdx: number;
    if (direction === 'prev') {
      nextIdx = idx <= 0 ? order.length - 1 : idx - 1;
    } else {
      nextIdx = idx >= order.length - 1 ? 0 : idx + 1;
    }
    const nextId = order[nextIdx];
    this.filter    = { ...this.filter, selectedId: nextId };
    this.particles = [];
    this.onSelectNode(nextId);
    const node = this.nodeMap.get(nextId);
    if (node) this.flyTo(node);
  }

  // ── Physics simulation ─────────────────────────────────────

  private tick(dt: number): void {
    if (this.paused || this.alpha < this.ALPHA_MIN) return;

    const nodes = this.nodes;
    const edges = this.edges;
    const n     = nodes.length;
    const a     = this.alpha;
    const dtS   = Math.min(dt / 1000, 0.05);

    // Repulsion O(n²) — fine for ≤400 nodes
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const A = nodes[i], B = nodes[j];
        const dx = B.x - A.x || 0.01;
        const dy = B.y - A.y || 0.01;
        const d2 = dx * dx + dy * dy;
        if (d2 < 0.01) continue;
        const d  = Math.sqrt(d2);
        const f  = (this.REPULSE / d2) * a;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        A.vx -= fx; A.vy -= fy;
        B.vx += fx; B.vy += fy;
      }
    }

    // Spring forces
    for (const e of edges) {
      const { source: s, target: t } = e;
      const dx = t.x - s.x || 0.01;
      const dy = t.y - s.y || 0.01;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const restLen = (s.lane === 'facet' || t.lane === 'facet')
        ? this.LINK_DIST_FAC
        : this.REST_LEN;
      const f  = (d - restLen) * this.SPRING * a;
      const nx = dx / d;
      const ny = dy / d;
      s.vx += nx * f; s.vy += ny * f;
      t.vx -= nx * f; t.vy -= ny * f;
    }

    // Center gravity
    for (const nd of nodes) {
      nd.vx -= nd.x * this.CENTER * a;
      nd.vy -= nd.y * this.CENTER * a;
    }

    // Tag centroid grouping — nodes sharing a tag gently attract each other
    if (this.filter.colorMode === 'tag' && this.tagColorMap.size > 0) {
      const tagCent = new Map<string, { x: number; y: number; count: number }>();
      for (const nd of nodes) {
        for (const t of nd.tags ?? []) {
          if (!this.tagColorMap.has(t)) continue;
          let c = tagCent.get(t);
          if (!c) { c = { x: 0, y: 0, count: 0 }; tagCent.set(t, c); }
          c.x += nd.x; c.y += nd.y; c.count++;
          break;
        }
      }
      const cs = 0.004 * a;
      for (const nd of nodes) {
        for (const t of nd.tags ?? []) {
          if (!this.tagColorMap.has(t)) continue;
          const c = tagCent.get(t);
          if (c && c.count >= 2) {
            nd.vx += (c.x / c.count - nd.x) * cs;
            nd.vy += (c.y / c.count - nd.y) * cs;
          }
          break;
        }
      }
    }

    // Integrate
    for (const nd of nodes) {
      nd.vx *= this.VEL_DECAY;
      nd.vy *= this.VEL_DECAY;
      if (nd.fx !== null) { nd.x = nd.fx; nd.vx = 0; }
      else nd.x += nd.vx;
      if (nd.fy !== null) { nd.y = nd.fy; nd.vy = 0; }
      else nd.y += nd.vy;
    }

    this.alpha *= (1 - this.ALPHA_DECAY);

    // Advance particles
    for (const p of this.particles) {
      p.t += p.speed * dtS;
    }
    this.particles = this.particles.filter((p) => p.t < 1);

    // Spawn particles on selected-node edges
    const sel = this.filter.selectedId;
    if (sel && Date.now() - this.lastParticleSpawn > 90) {
      const selEdges = this.edges.filter(
        (e) => e.source.id === sel || e.target.id === sel,
      );
      for (const e of selEdges.slice(0, 10)) {
        this.particles.push({ edge: e, t: Math.random() * 0.15, speed: 0.25 + Math.random() * 0.25 });
      }
      this.lastParticleSpawn = Date.now();
    }

    // Pulse timer
    this.pulseT   = (this.pulseT   + dtS * 2.5) % (Math.PI * 2);
    // Cluster border animation
    this.dashOffset = (this.dashOffset - dtS * 8) % 18;
  }

  // ── Draw ───────────────────────────────────────────────────

  private draw(): void {
    const { ctx, w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w * this.dpr, h * this.dpr);

    // Background
    ctx.fillStyle = '#080d1a';
    ctx.fillRect(0, 0, w * this.dpr, h * this.dpr);

    // Dot grid (screen-space)
    this.drawGrid();

    // World-space transforms
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const sel  = this.filter.selectedId;
    const vis  = this.filter.visibleNodeIds;
    const hrel = this.filter.highlightRelTypes;

    const hov = this.hoveredId;

    const isHighlightedEdge = (e: SimEdge): boolean => {
      if (sel && (e.source.id === sel || e.target.id === sel)) return true;
      if (hov && (e.source.id === hov || e.target.id === hov)) return true;
      if (hrel.size > 0 && hrel.has(e.type)) return true;
      return false;
    };

    // Precompute hovered-node neighbors for dimming
    const hovNeighbors = hov ? new Set<string>(
      this.edges
        .filter((e) => e.source.id === hov || e.target.id === hov)
        .flatMap((e) => [e.source.id, e.target.id])
    ) : null;

    const nodeOpacity = (nd: SimNode): number => {
      if (vis && !vis.has(nd.id)) return 0.07;
      // Selected node dims unrelated nodes
      if (sel) {
        if (nd.id === sel) return 1;
        const connectedToSel = this.edges.some(
          (e) => (e.source.id === sel && e.target.id === nd.id) ||
                 (e.target.id === sel && e.source.id === nd.id),
        );
        return connectedToSel ? 0.85 : 0.15;
      }
      // Hovered node softly highlights neighbors
      if (hov && hovNeighbors && !sel) {
        if (nd.id === hov) return 1;
        return hovNeighbors.has(nd.id) ? 0.85 : 0.45;
      }
      return 1;
    };

    // Rebuild spatial grid for culling
    this.rebuildGrid();

    // Compute viewport in world-space for culling
    const vpLeft   = -this.tx / this.scale;
    const vpTop    = -this.ty / this.scale;
    const vpRight  = vpLeft + this.w / this.scale;
    const vpBottom = vpTop  + this.h / this.scale;
    const cullPad  = 100;
    const visibleNodesSet = new Set<string>();
    const vpNodes = this.getNodesInRect(
      vpLeft - cullPad, vpTop - cullPad,
      vpRight + cullPad, vpBottom + cullPad,
    );
    for (const n of vpNodes) visibleNodesSet.add(n.id);

    // Tag cluster blobs (behind everything)
    this.drawTagClusters(visibleNodesSet);

    // Edges (back) — cull edges whose endpoints are both off-screen
    if (this.edgeBundling && !sel) {
      this.drawBundledEdges(nodeOpacity, isHighlightedEdge, visibleNodesSet);
    } else {
      for (const e of this.edges) {
        if (!visibleNodesSet.has(e.source.id) && !visibleNodesSet.has(e.target.id)) continue;
        const op = Math.min(nodeOpacity(e.source), nodeOpacity(e.target));
        this.drawEdge(e, op, isHighlightedEdge(e));
      }
    }

    // Particles
    this.drawParticles();

    // Nodes — only draw those in viewport
    for (const nd of vpNodes) {
      this.drawNode(nd, nodeOpacity(nd), nd.id === sel, nd.id === this.hoveredId);
    }

    ctx.restore();

    // Screen-space HUD + minimap
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    this.drawHud();
    this.drawMinimap();
    ctx.restore();

    // DOM tooltip
    this.renderTooltip();
  }

  // ── Tag cluster blobs ─────────────────────────────────────

  private drawTagClusters(visibleNodesSet: Set<string>): void {
    if (this.filter.colorMode !== 'tag' || this.tagColorMap.size === 0) return;

    const vis = this.filter.visibleNodeIds;
    const { ctx } = this;

    // Group visible, on-screen nodes by their primary tag
    const tagGroups = new Map<string, SimNode[]>();
    for (const nd of this.nodes) {
      if (!visibleNodesSet.has(nd.id)) continue;
      if (vis && !vis.has(nd.id)) continue;
      for (const t of nd.tags ?? []) {
        if (this.tagColorMap.has(t)) {
          if (!tagGroups.has(t)) tagGroups.set(t, []);
          tagGroups.get(t)!.push(nd);
          break;
        }
      }
    }

    for (const [tag, nodes] of tagGroups) {
      if (nodes.length < 1) continue;
      const color = this.tagColorMap.get(tag)!;
      const rgb = hexToRgb(color);
      if (!rgb) continue;

      ctx.save();
      ctx.globalAlpha = 1;

      const PAD = 30;

      if (nodes.length === 1) {
        // Single node: radial halo
        const nd = nodes[0];
        const haloR = nd.r + PAD * 1.2;
        const grad = ctx.createRadialGradient(nd.x, nd.y, nd.r, nd.x, nd.y, haloR);
        grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0.10)`);
        grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, haloR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      } else {
        // Multiple nodes: smooth convex hull blob
        const hull = convexHull(nodes.map((nd) => ({ x: nd.x, y: nd.y })));
        if (hull.length < 2) {
          ctx.restore();
          continue;
        }

        // Expand hull points outward from centroid
        const centX = hull.reduce((s, p) => s + p.x, 0) / hull.length;
        const centY = hull.reduce((s, p) => s + p.y, 0) / hull.length;
        const expanded = hull.map((p) => {
          const dx = p.x - centX;
          const dy = p.y - centY;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          return { x: p.x + (dx / d) * PAD, y: p.y + (dy / d) * PAD };
        });

        const hn = expanded.length;

        // Draw blob using catmull-rom spline through expanded hull
        ctx.beginPath();
        for (let i = 0; i < hn; i++) {
          const p0 = expanded[(i - 1 + hn) % hn];
          const p1 = expanded[i];
          const p2 = expanded[(i + 1) % hn];
          const p3 = expanded[(i + 2) % hn];

          if (i === 0) {
            ctx.moveTo((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
          }
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = p1.y + (p2.y - p0.y) / 6;
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = p2.y - (p3.y - p1.y) / 6;
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
        }
        ctx.closePath();

        // Translucent fill
        ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.055)`;
        ctx.fill();

        // Animated glowing border (marching ants)
        ctx.shadowColor    = color;
        ctx.shadowBlur     = 12;
        ctx.strokeStyle    = `rgba(${rgb.r},${rgb.g},${rgb.b},0.28)`;
        ctx.lineWidth      = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = this.dashOffset;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        ctx.shadowBlur     = 0;

        // Tag label near centroid top edge
        if (this.scale > 0.18) {
          const topY = Math.min(...expanded.map((p) => p.y)) - 6;
          ctx.font        = `600 10px Inter, sans-serif`;
          ctx.textAlign   = 'center';
          ctx.textBaseline = 'bottom';
          ctx.globalAlpha  = 0.55;
          ctx.fillStyle    = color;
          ctx.shadowColor  = color;
          ctx.shadowBlur   = 4;
          ctx.fillText(`#${tag}`, centX, topY);
          ctx.shadowBlur   = 0;
          ctx.globalAlpha  = 1;
        }
      }

      ctx.restore();
    }
  }

  // ── Dot grid ───────────────────────────────────────────────

  private drawGrid(): void {
    const { ctx, dpr } = this;
    const W = this.w * dpr;
    const H = this.h * dpr;
    const spacing = 28 * this.scale * dpr;
    if (spacing < 8) return;

    const ox = ((this.tx * dpr % spacing) + spacing) % spacing;
    const oy = ((this.ty * dpr % spacing) + spacing) % spacing;

    ctx.save();
    ctx.fillStyle = 'rgba(148,163,184,0.06)';
    const r = 1.2 * dpr;

    for (let x = ox; x < W; x += spacing) {
      for (let y = oy; y < H; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ── Minimap ────────────────────────────────────────────────

  private drawMinimap(): void {
    if (this.nodes.length < 3) return;
    const { ctx, w, h } = this;

    const mmW = 148, mmH = 108;
    const mmX = w - mmW - 14;
    const mmY = h - mmH - 14;
    const pad = 12;

    // Graph bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nd of this.nodes) {
      minX = Math.min(minX, nd.x); minY = Math.min(minY, nd.y);
      maxX = Math.max(maxX, nd.x); maxY = Math.max(maxY, nd.y);
    }
    const gw = (maxX - minX) || 1;
    const gh = (maxY - minY) || 1;
    const s  = Math.min((mmW - pad * 2) / gw, (mmH - pad * 2) / gh);

    const toMm = (x: number, y: number) => ({
      x: mmX + pad + (x - minX) * s,
      y: mmY + pad + (y - minY) * s,
    });

    ctx.save();

    // Panel background
    ctx.fillStyle   = 'rgba(8,13,26,0.90)';
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.lineWidth   = 1;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(mmX, mmY, mmW, mmH, 8);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(mmX, mmY, mmW, mmH);
      ctx.strokeRect(mmX, mmY, mmW, mmH);
    }

    // Clip to minimap area
    ctx.beginPath();
    ctx.rect(mmX + 1, mmY + 1, mmW - 2, mmH - 2);
    ctx.clip();

    // Edges
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth   = 0.7;
    for (const e of this.edges) {
      const a = toMm(e.source.x, e.source.y);
      const b = toMm(e.target.x, e.target.y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Nodes
    const sel = this.filter.selectedId;
    const vis = this.filter.visibleNodeIds;
    for (const nd of this.nodes) {
      const { x, y } = toMm(nd.x, nd.y);
      const r   = nd.id === sel ? 4 : 2;
      const dim = !!(vis && !vis.has(nd.id));
      ctx.globalAlpha = dim ? 0.18 : nd.id === sel ? 1 : 0.65;
      if (nd.id === sel) {
        ctx.shadowColor = nd.color;
        ctx.shadowBlur  = 6;
      }
      ctx.fillStyle = nd.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;

    // Viewport box
    const vpX1 = (-this.tx) / this.scale;
    const vpY1 = (-this.ty) / this.scale;
    const vpX2 = vpX1 + this.w / this.scale;
    const vpY2 = vpY1 + this.h / this.scale;
    const va   = toMm(vpX1, vpY1);
    const vb   = toMm(vpX2, vpY2);
    ctx.strokeStyle = 'rgba(45,212,191,0.6)';
    ctx.lineWidth   = 1.2;
    ctx.strokeRect(
      Math.min(va.x, vb.x), Math.min(va.y, vb.y),
      Math.abs(vb.x - va.x), Math.abs(vb.y - va.y),
    );

    ctx.restore();
  }

  // ── Particles ──────────────────────────────────────────────

  private drawParticles(): void {
    const { ctx } = this;
    for (const p of this.particles) {
      const e = p.edge;
      const s = e.source;
      const t = e.target;
      const x = lerp(s.x, t.x, p.t);
      const y = lerp(s.y, t.y, p.t);
      const color = getEdgeColor(e.type);
      const fade  = p.t < 0.12 ? p.t / 0.12 : p.t > 0.88 ? (1 - p.t) / 0.12 : 1;

      ctx.save();
      ctx.globalAlpha = 0.88 * fade;
      ctx.fillStyle   = color;
      ctx.shadowColor = color;
      ctx.shadowBlur  = 8;
      ctx.beginPath();
      ctx.arc(x, y, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Bundled edges ────────────────────────────────────────

  private drawBundledEdges(
    nodeOpacity: (nd: SimNode) => number,
    isHighlightedEdge: (e: SimEdge) => boolean,
    visibleNodesSet: Set<string>,
  ): void {
    const { ctx } = this;
    // Group edges by type and draw as bundled curves through centroid
    const byType = new Map<string, SimEdge[]>();
    for (const e of this.edges) {
      if (!visibleNodesSet.has(e.source.id) && !visibleNodesSet.has(e.target.id)) continue;
      let arr = byType.get(e.type);
      if (!arr) { arr = []; byType.set(e.type, arr); }
      arr.push(e);
    }

    for (const [type, edges] of byType) {
      if (edges.length < 4) {
        // Too few edges to bundle — draw normally
        for (const e of edges) {
          const op = Math.min(nodeOpacity(e.source), nodeOpacity(e.target));
          this.drawEdge(e, op, isHighlightedEdge(e));
        }
        continue;
      }

      const color = getEdgeColor(type);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 0.25;

      // Compute centroid of all edge endpoints
      let cx = 0, cy = 0, count = 0;
      for (const e of edges) {
        cx += e.source.x + e.target.x;
        cy += e.source.y + e.target.y;
        count += 2;
      }
      cx /= count; cy /= count;

      for (const e of edges) {
        const op = Math.min(nodeOpacity(e.source), nodeOpacity(e.target));
        if (op < 0.1) continue;
        ctx.globalAlpha = op * 0.3;
        ctx.beginPath();
        ctx.moveTo(e.source.x, e.source.y);
        // Bezier through a point biased toward centroid
        const mx = (e.source.x + e.target.x) / 2;
        const my = (e.source.y + e.target.y) / 2;
        const bpx = mx + (cx - mx) * 0.3;
        const bpy = my + (cy - my) * 0.3;
        ctx.quadraticCurveTo(bpx, bpy, e.target.x, e.target.y);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  // ── Edge ───────────────────────────────────────────────────

  private drawEdge(edge: SimEdge, opacity: number, highlighted: boolean): void {
    const { ctx } = this;
    const { source: s, target: t } = edge;
    const onCritPath = this.filter.criticalPathIds.has(s.id) && this.filter.criticalPathIds.has(t.id);

    const dx  = t.x - s.x;
    const dy  = t.y - s.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    // Perpendicular unit vector
    const px = -dy / len;
    const py =  dx / len;

    // Determine curvature direction for bidirectional edges
    const key      = [s.id, t.id].sort().join('|');
    const isBiDir  = this.biDirPairs.has(key);
    const curveDir = isBiDir ? (s.id < t.id ? 1 : -1) : 0;
    const curvature = isBiDir ? 0.22 : 0.0;
    const cpFactor  = len * curvature * curveDir;

    // Control point (on the perpendicular bisector)
    const cpX = (s.x + t.x) / 2 + px * cpFactor;
    const cpY = (s.y + t.y) / 2 + py * cpFactor;

    // Start/end points offset from node radii
    const nx = dx / len;
    const ny = dy / len;
    const x1 = s.x + nx * s.r;
    const y1 = s.y + ny * s.r;
    const x2 = t.x - nx * (t.r + 7);
    const y2 = t.y - ny * (t.r + 7);

    const color = onCritPath ? '#fbbf24' : getEdgeColor(edge.type);
    const isActive = highlighted || onCritPath;

    ctx.save();
    ctx.globalAlpha = opacity * (isActive ? 0.95 : 0.42);
    ctx.lineWidth   = isActive ? (onCritPath && !highlighted ? 2.0 : 1.8) : 1.1;

    if (isActive) {
      // Gradient stroke from source to target node color for highlighted edges
      if (!onCritPath && s.color !== t.color) {
        const grad = ctx.createLinearGradient(x1, y1, x2, y2);
        const sRgb = hexToRgb(s.color);
        const tRgb = hexToRgb(t.color);
        if (sRgb && tRgb) {
          grad.addColorStop(0, `rgba(${sRgb.r},${sRgb.g},${sRgb.b},0.9)`);
          grad.addColorStop(1, `rgba(${tRgb.r},${tRgb.g},${tRgb.b},0.9)`);
          ctx.strokeStyle = grad;
        } else {
          ctx.strokeStyle = color;
        }
      } else {
        ctx.strokeStyle = color;
      }
      ctx.shadowColor = color;
      ctx.shadowBlur  = onCritPath ? 8 : 5;
    } else {
      ctx.strokeStyle = EDGE_DEFAULT;
    }

    // Draw straight line or quadratic bezier
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    if (isBiDir) {
      ctx.quadraticCurveTo(cpX, cpY, x2, y2);
    } else {
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();

    // Arrowhead: tangent direction at the endpoint
    if (len > 28) {
      let angle: number;
      if (isBiDir) {
        // Tangent at end of quadratic bezier: direction from CP to endpoint
        angle = Math.atan2(y2 - cpY, x2 - cpX);
      } else {
        angle = Math.atan2(dy, dx);
      }

      const aw = isBiDir ? 8 : 7;
      const aa = isBiDir ? 0.38 : 0.42;
      // Position arrowhead at the actual edge endpoint (where bezier meets target offset)
      const ax = x2;
      const ay = y2;

      ctx.fillStyle   = isActive ? color : 'rgba(148,163,184,0.4)';
      ctx.globalAlpha = opacity * (isActive ? 0.92 : 0.42);
      ctx.shadowBlur  = 0;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - aw * Math.cos(angle - aa), ay - aw * Math.sin(angle - aa));
      // Small notch for better definition on curved edges
      const notchLen = aw * 0.35;
      ctx.lineTo(ax - notchLen * Math.cos(angle), ay - notchLen * Math.sin(angle));
      ctx.lineTo(ax - aw * Math.cos(angle + aa), ay - aw * Math.sin(angle + aa));
      ctx.closePath();
      ctx.fill();
    }

    // Edge label — midpoint of the bezier curve
    if (isActive && this.scale > 0.55) {
      const mx = isBiDir ? (x1 + 2 * cpX + x2) / 4 : (x1 + x2) / 2;
      const my = isBiDir ? (y1 + 2 * cpY + y2) / 4 : (y1 + y2) / 2;
      ctx.globalAlpha = opacity * 0.82;
      ctx.shadowBlur  = 0;
      ctx.font        = '9px JetBrains Mono, monospace';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(edge.type).width + 8;
      ctx.fillStyle = 'rgba(8,13,26,0.78)';
      ctx.fillRect(mx - tw / 2, my - 7, tw, 14);
      ctx.fillStyle = hexAlpha(color, 0.9);
      ctx.fillText(edge.type, mx, my);
    }

    ctx.restore();
  }

  // ── Node ───────────────────────────────────────────────────

  private drawNode(node: SimNode, opacity: number, selected: boolean, hovered: boolean): void {
    const { ctx } = this;
    const { x, y, r, color } = node;
    const prominent   = selected || hovered;
    const pulse       = selected ? (Math.sin(this.pulseT) * 0.5 + 0.5) : 0;
    const onCritPath  = this.filter.criticalPathIds.has(node.id);

    ctx.save();
    ctx.globalAlpha = opacity;

    // Critical path outer ring (gold/amber)
    if (onCritPath && !selected) {
      const cp = Math.sin(this.pulseT * 0.7) * 0.5 + 0.5;
      ctx.strokeStyle = hexAlpha('#fbbf24', 0.55 + cp * 0.30);
      ctx.lineWidth   = 2.2;
      ctx.shadowColor = '#fbbf24';
      ctx.shadowBlur  = 10 + cp * 8;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Outer pulse ring (selected)
    if (selected) {
      ctx.strokeStyle = hexAlpha(color, 0.28 + pulse * 0.38);
      ctx.lineWidth   = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur  = 14 + pulse * 18;
      ctx.beginPath();
      ctx.arc(x, y, r + 6 + pulse * 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }

    // Ambient glow on all nodes (subtle for non-selected, stronger for selected/hovered)
    ctx.shadowColor = color;
    ctx.shadowBlur  = selected ? (18 + pulse * 10) : hovered ? 10 : (r > 10 ? 5 : 3);

    // Radial gradient fill — more vibrant on non-selected nodes than before
    const grad = ctx.createRadialGradient(x - r * 0.32, y - r * 0.32, r * 0.08, x, y, r);
    if (selected) {
      grad.addColorStop(0, hexAlpha(color, 1.0));
      grad.addColorStop(1, hexAlpha(color, 0.65));
    } else if (hovered) {
      grad.addColorStop(0, hexAlpha(color, 0.72));
      grad.addColorStop(1, hexAlpha(color, 0.28));
    } else {
      grad.addColorStop(0, hexAlpha(color, 0.55));
      grad.addColorStop(1, hexAlpha(color, 0.15));
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Stroke — more vivid for all nodes
    ctx.shadowBlur  = 0;
    ctx.strokeStyle = hexAlpha(color, selected ? 1 : hovered ? 0.92 : 0.72);
    ctx.lineWidth   = selected ? 2.2 : hovered ? 1.8 : 1.2;
    ctx.stroke();

    // Type icon or inner dot
    const abbr = node.lane === 'item' ? (TYPE_ABBR[node.type.toLowerCase()] ?? '') : '';
    const showIcon = this.scale > 0.20 || prominent;
    if (r >= 9 && showIcon && abbr) {
      const iSize = Math.max(7, Math.min(12, r * 0.62));
      ctx.font = `700 ${iSize}px 'JetBrains Mono', monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur   = 0;
      ctx.fillStyle    = selected
        ? 'rgba(255,255,255,0.92)'
        : hovered
          ? 'rgba(226,232,240,0.88)'
          : hexAlpha(color, 0.78);
      ctx.fillText(abbr, x, y);
    } else if (r >= 11 && node.lane === 'item') {
      // Fallback dot when no abbr or low zoom
      ctx.beginPath();
      ctx.arc(x, y, r * 0.25, 0, Math.PI * 2);
      ctx.fillStyle = selected ? 'rgba(255,255,255,0.75)' : hexAlpha(color, 0.55);
      ctx.fill();
    }

    // Label — always show at scale > 0.14 (was 0.32), with background pill for readability
    const showLabel = this.scale > 0.14 || prominent;
    if (showLabel) {
      const maxLen = this.scale > 0.72 ? 28 : this.scale > 0.45 ? 20 : this.scale > 0.25 ? 15 : 10;
      const label  = truncate(node.label || node.id, maxLen);
      const fSize  = prominent ? Math.max(10, Math.min(13, r * 0.95)) : Math.max(9, Math.min(12, r * 0.85));
      const labelAlpha = selected ? 1.0 : hovered ? 0.96 : this.scale > 0.45 ? 0.82 : 0.62;

      ctx.font        = `${selected ? 600 : 400} ${fSize}px Inter, sans-serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'top';

      const labelY  = y + r + 5;
      const textW   = ctx.measureText(label).width;
      const pillW   = textW + 8;
      const pillH   = fSize + 5;

      // Background pill for readability (skip when very faint)
      if (labelAlpha > 0.35) {
        ctx.globalAlpha = opacity * labelAlpha * 0.72;
        ctx.fillStyle   = 'rgba(8,13,26,0.75)';
        ctx.shadowBlur  = 0;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(x - pillW / 2, labelY - 2, pillW, pillH, 3);
          ctx.fill();
        } else {
          ctx.fillRect(x - pillW / 2, labelY - 2, pillW, pillH);
        }
      }

      ctx.globalAlpha = opacity * labelAlpha;
      ctx.shadowBlur  = prominent ? 6 : 0;
      ctx.shadowColor = '#000';
      ctx.fillStyle   = selected
        ? '#ffffff'
        : hovered
          ? 'rgba(226,232,240,0.98)'
          : 'rgba(203,213,225,0.88)';
      ctx.fillText(label, x, labelY);
      ctx.shadowBlur  = 0;
      ctx.globalAlpha = opacity;
    }

    ctx.restore();
  }

  // ── HUD (screen-space) ─────────────────────────────────────

  private drawHud(): void {
    const { ctx, w, h } = this;
    const simActive = !this.paused && this.alpha > this.ALPHA_MIN;

    ctx.save();

    // Keyboard hint (top bar, very subtle)
    if (this.nodes.length > 0) {
      ctx.globalAlpha = 0.28;
      ctx.font        = '10px Inter, sans-serif';
      ctx.fillStyle   = '#94a3b8';
      ctx.textAlign   = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        'Tab: next  Shift+Tab: prev  ↑↓ or →: neighbor  Enter: open  F: fit  Esc: deselect',
        12, 10,
      );
      ctx.globalAlpha = 1;
    }

    // Sim activity dot (top-right)
    if (simActive) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle   = '#2dd4bf';
      ctx.shadowColor = '#2dd4bf';
      ctx.shadowBlur  = 8;
      ctx.beginPath();
      ctx.arc(w - 18, 18, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    // Node + edge count (bottom-left)
    const nodeCount = this.filter.visibleNodeIds
      ? `${this.filter.visibleNodeIds.size}/${this.nodes.length} nodes`
      : `${this.nodes.length} nodes · ${this.edges.length} edges`;
    ctx.globalAlpha = 0.45;
    ctx.font        = '10px Inter, sans-serif';
    ctx.fillStyle   = '#94a3b8';
    ctx.textAlign   = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(nodeCount, 14, h - 36);
    ctx.globalAlpha = 1;

    // Zoom badge (bottom-left)
    const zoomTxt = `${Math.round(this.scale * 100)}%`;
    ctx.font       = '11px JetBrains Mono, monospace';
    const tw       = ctx.measureText(zoomTxt).width + 18;
    ctx.fillStyle   = 'rgba(8,13,26,0.75)';
    ctx.globalAlpha = 0.9;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(12, h - 30, tw, 20, 4);
      ctx.fill();
    } else {
      ctx.fillRect(12, h - 30, tw, 20);
    }
    ctx.fillStyle   = '#94a3b8';
    ctx.textAlign   = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(zoomTxt, 21, h - 20);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // ── Tooltip (DOM) ──────────────────────────────────────────

  private renderTooltip(): void {
    const hov = this.hoveredId ? this.nodeMap.get(this.hoveredId) : null;
    if (!hov || hov.id === this.filter.selectedId) {
      this.hideTooltip();
      return;
    }

    let tt = document.getElementById('gc-tooltip');
    if (!tt) {
      tt = document.createElement('div');
      tt.id = 'gc-tooltip';
      tt.style.cssText = [
        'position:fixed',
        'z-index:9999',
        'pointer-events:none',
        'background:rgba(10,15,30,0.96)',
        'border:1px solid rgba(148,163,184,0.18)',
        'border-radius:10px',
        'padding:10px 14px',
        'font-family:Inter,sans-serif',
        'font-size:12px',
        'color:#e2e8f0',
        'max-width:240px',
        'backdrop-filter:blur(12px)',
        'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
        'transition:opacity 0.1s ease',
        'line-height:1.5',
      ].join(';');
      document.body.appendChild(tt);
    }

    const degText  = `${hov.degree} link${hov.degree !== 1 ? 's' : ''}`;
    const laneLabel = hov.lane === 'facet' ? 'Metadata' : hov.lane === 'external' ? 'External' : 'Item';

    tt.innerHTML = `
      <div style="font-weight:600;font-size:13px;margin-bottom:5px;color:#f1f5f9;word-break:break-all;display:flex;align-items:center;gap:7px;">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${hov.color};flex-shrink:0;box-shadow:0 0 6px ${hov.color}"></span>
        ${escHtml(hov.label || hov.id)}
      </div>
      <div style="color:#475569;font-size:10px;font-family:'JetBrains Mono',monospace;margin-bottom:8px;word-break:break-all;">${escHtml(hov.id)}</div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;">
        <span style="color:#64748b;">Type</span><span>${escHtml(hov.type)}</span>
        <span style="color:#64748b;">Status</span><span style="color:${hov.color};">${escHtml(hov.status)}</span>
        <span style="color:#64748b;">Lane</span><span>${escHtml(laneLabel)}</span>
        <span style="color:#64748b;">Links</span><span>${escHtml(degText)}</span>
      </div>
      <div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(148,163,184,0.1);color:#475569;font-size:10px;">
        Click to select · Double-click to open
      </div>
    `;
    tt.style.display = 'block';
    tt.style.opacity = '1';

    // Position near cursor / node
    const rect = this.canvas.getBoundingClientRect();
    const sx   = hov.x * this.scale + this.tx + rect.left;
    const sy   = hov.y * this.scale + this.ty + rect.top;
    const ttW  = 250;
    const left = Math.min(sx + 18, window.innerWidth - ttW - 10);
    const top  = Math.max(sy - 70, 8);
    tt.style.left = `${left}px`;
    tt.style.top  = `${top}px`;
  }

  private hideTooltip(): void {
    const tt = document.getElementById('gc-tooltip');
    if (tt) tt.style.opacity = '0';
  }

  // ── Camera ─────────────────────────────────────────────────

  private zoom(delta: number, px: number, py: number): void {
    const factor   = delta > 0 ? 1.11 : 1 / 1.11;
    const newScale = Math.max(0.04, Math.min(6, this.scale * factor));
    this.tx    = px - (px - this.tx) * (newScale / this.scale);
    this.ty    = py - (py - this.ty) * (newScale / this.scale);
    this.scale = newScale;
    this.flyTarget = null;
  }

  private toWorld(px: number, py: number): [number, number] {
    return [(px - this.tx) / this.scale, (py - this.ty) / this.scale];
  }

  private hitTest(wx: number, wy: number): SimNode | null {
    const vis = this.filter.visibleNodeIds;
    // Use spatial grid for O(1) cell lookup
    const cs = this.gridCellSize;
    const cx = Math.floor((wx - this.gridOriginX) / cs);
    const cy = Math.floor((wy - this.gridOriginY) / cs);
    // Check this cell and immediate neighbors
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.gridCells.get((cx + dx) * 10000 + (cy + dy));
        if (!cell) continue;
        for (const nd of cell) {
          if (vis && !vis.has(nd.id)) continue;
          const ddx = wx - nd.x;
          const ddy = wy - nd.y;
          const hitR = (nd.r + 6);
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 <= hitR * hitR && d2 < bestDist) {
            best = nd;
            bestDist = d2;
          }
        }
      }
    }
    return best;
  }

  // ── Events ─────────────────────────────────────────────────

  private getPos(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindEvents(): void {
    const sig = { signal: this.abortCtrl.signal };

    this.canvas.addEventListener('mousedown',   (e) => this.onMouseDown(e),  sig);
    window.addEventListener('mousemove',         (e) => this.onMouseMove(e),  sig);
    window.addEventListener('mouseup',           (e) => this.onMouseUp(e),    sig);
    this.canvas.addEventListener('wheel',        (e) => this.onWheel(e),      { ...sig, passive: false });
    this.canvas.addEventListener('dblclick',     (e) => this.onDblClick(e),   sig);
    this.canvas.addEventListener('keydown',      (e) => this.onKeyDown(e),    sig);
    this.canvas.addEventListener('mouseleave',   () => { this.hideTooltip(); this.hoveredId = null; }, sig);
    this.canvas.addEventListener('contextmenu',  (e) => this.onCtxMenu(e),    sig);

    this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { ...sig, passive: false });
    this.canvas.addEventListener('touchmove',  (e) => this.onTouchMove(e),  { ...sig, passive: false });
    this.canvas.addEventListener('touchend',   (e) => this.onTouchEnd(e),   { ...sig, passive: false });
  }

  private onCtxMenu(e: MouseEvent): void {
    e.preventDefault();
    const { x, y } = this.getPos(e);
    const [wx, wy] = this.toWorld(x, y);
    const hit = this.hitTest(wx, wy);
    if (!hit) return;
    this.canvas.focus();
    this.onContextMenu(hit.id, e.clientX, e.clientY);
  }

  private onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        this.navigateToNeighbor(e.shiftKey ? 'prev' : 'next');
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        this.navigateToNeighbor('first-neighbor');
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        this.navigateToNeighbor('prev');
        break;
      case 'Escape':
        if (this.filter.selectedId) {
          this.filter    = { ...this.filter, selectedId: null };
          this.particles = [];
          this.onSelectNode(null);
        }
        break;
      case 'Enter':
        if (this.filter.selectedId) {
          this.onOpenNode(this.filter.selectedId);
        }
        break;
      case 'f':
      case 'F':
        this.fitView();
        break;
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.canvas.focus();
    const { x, y } = this.getPos(e);
    this.lastX = x; this.lastY = y;
    this.downX = x; this.downY = y;
    this.hasMoved = false;

    const [wx, wy] = this.toWorld(x, y);
    const hit = this.hitTest(wx, wy);
    if (hit) {
      this.isDraggingNode = true;
      this.dragNode = hit;
      hit.fx = hit.x;
      hit.fy = hit.y;
      this.alpha = Math.max(this.alpha, 0.25);
      this.canvas.style.cursor = 'grabbing';
    } else {
      this.isDraggingCanvas = true;
      this.canvas.style.cursor = 'grabbing';
    }
  }

  private onMouseMove(e: MouseEvent): void {
    const r  = this.canvas.getBoundingClientRect();
    const x  = e.clientX - r.left;
    const y  = e.clientY - r.top;
    const dx = x - this.lastX;
    const dy = y - this.lastY;

    if (Math.abs(x - this.downX) > 3 || Math.abs(y - this.downY) > 3) this.hasMoved = true;

    if (this.isDraggingNode && this.dragNode) {
      const [wx, wy] = this.toWorld(x, y);
      this.dragNode.fx = wx;
      this.dragNode.fy = wy;
      this.flyTarget   = null;
    } else if (this.isDraggingCanvas) {
      this.tx += dx;
      this.ty += dy;
      this.flyTarget = null;
    } else {
      const [wx, wy]  = this.toWorld(x, y);
      const hit       = this.hitTest(wx, wy);
      const newHov    = hit?.id ?? null;
      if (newHov !== this.hoveredId) {
        this.hoveredId = newHov;
        this.canvas.style.cursor = newHov ? 'pointer' : 'grab';
        if (!newHov) this.hideTooltip();
      }
    }

    this.lastX = x;
    this.lastY = y;
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;

    if (this.isDraggingNode && this.dragNode) {
      if (!this.hasMoved) {
        const id     = this.dragNode.id;
        const newSel = this.filter.selectedId === id ? null : id;
        this.filter  = { ...this.filter, selectedId: newSel };
        this.particles = [];
        this.lastParticleSpawn = 0;
        this.onSelectNode(newSel);
        if (newSel) this.flyTo(this.dragNode);
      }
      this.dragNode.fx = null;
      this.dragNode.fy = null;
      this.dragNode    = null;
      this.isDraggingNode = false;
    } else if (this.isDraggingCanvas) {
      this.isDraggingCanvas = false;
      if (!this.hasMoved && this.filter.selectedId) {
        this.filter    = { ...this.filter, selectedId: null };
        this.particles = [];
        this.onSelectNode(null);
      }
    }

    this.canvas.style.cursor = this.hoveredId ? 'pointer' : 'grab';
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.getPos(e);
    const delta    = e.deltaMode === 1 ? -e.deltaY * 20 : -e.deltaY;
    this.zoom(delta, x, y);
  }

  private onDblClick(e: MouseEvent): void {
    const { x, y } = this.getPos(e);
    const [wx, wy] = this.toWorld(x, y);
    const hit = this.hitTest(wx, wy);
    if (hit) this.onOpenNode(hit.id);
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    if (e.touches.length === 1) {
      const x = e.touches[0].clientX - rect.left;
      const y = e.touches[0].clientY - rect.top;
      this.lastX = x; this.lastY = y;
      this.downX = x; this.downY = y;
      this.hasMoved = false;
      const [wx, wy] = this.toWorld(x, y);
      const hit = this.hitTest(wx, wy);
      if (hit) {
        this.isDraggingNode = true;
        this.dragNode = hit;
        hit.fx = hit.x;
        hit.fy = hit.y;
        this.alpha = Math.max(this.alpha, 0.25);
      } else {
        this.isDraggingCanvas = true;
      }
    } else if (e.touches.length === 2) {
      this.isDraggingNode = false;
      this.isDraggingCanvas = false;
      if (this.dragNode) { this.dragNode.fx = null; this.dragNode.fy = null; this.dragNode = null; }
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      this.touchDist = Math.sqrt(dx * dx + dy * dy);
      this.touchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      this.touchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    if (e.touches.length === 1) {
      const x  = e.touches[0].clientX - rect.left;
      const y  = e.touches[0].clientY - rect.top;
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      if (Math.abs(x - this.downX) > 5 || Math.abs(y - this.downY) > 5) this.hasMoved = true;
      if (this.isDraggingNode && this.dragNode) {
        const [wx, wy] = this.toWorld(x, y);
        this.dragNode.fx = wx;
        this.dragNode.fy = wy;
      } else if (this.isDraggingCanvas) {
        this.tx += dx;
        this.ty += dy;
        this.flyTarget = null;
      }
      this.lastX = x;
      this.lastY = y;
    } else if (e.touches.length === 2) {
      const dx   = e.touches[0].clientX - e.touches[1].clientX;
      const dy   = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      this.zoom((dist - this.touchDist) * 0.6, midX, midY);
      this.tx += midX - this.touchMidX;
      this.ty += midY - this.touchMidY;
      this.touchDist = dist;
      this.touchMidX = midX;
      this.touchMidY = midY;
      this.flyTarget = null;
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 0) {
      if (this.isDraggingNode && this.dragNode) {
        if (!this.hasMoved) {
          const id     = this.dragNode.id;
          const newSel = this.filter.selectedId === id ? null : id;
          this.filter  = { ...this.filter, selectedId: newSel };
          this.particles = [];
          this.lastParticleSpawn = 0;
          this.onSelectNode(newSel);
          if (newSel) this.flyTo(this.dragNode);
        }
        this.dragNode.fx = null;
        this.dragNode.fy = null;
        this.dragNode    = null;
      }
      this.isDraggingNode   = false;
      this.isDraggingCanvas = false;
    }
  }

  // ── Resize ─────────────────────────────────────────────────

  private onResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width  = rect.width  * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ── RAF loop ───────────────────────────────────────────────

  private startLoop(): void {
    let last = performance.now();
    const loop = (now: number) => {
      if (this.destroyed) return;
      const dt = Math.min(now - last, 80);
      last = now;
      this.tick(dt);
      this.advanceFly();
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }
}
