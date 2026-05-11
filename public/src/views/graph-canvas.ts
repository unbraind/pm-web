// ═══════════════════════════════════════════════════════════════
// GRAPH CANVAS — Interactive force-directed knowledge graph
// Canvas 2D + physics simulation, no external dependencies
// ═══════════════════════════════════════════════════════════════

/** Public node descriptor (from graph view). */
export interface CanvasNode {
  id: string;
  label: string;
  type: string;
  status: string;
  lane: 'item' | 'facet' | 'external';
  degree: number;
}

/** Public edge descriptor. */
export interface CanvasEdge {
  from: string;
  to: string;
  type: string;
}

/** Callbacks from the canvas to the graph view. */
export interface GraphCanvasOptions {
  onSelectNode(id: string | null): void;
  onOpenNode(id: string): void;
}

/** External filter state (passed in from the view). */
export interface CanvasFilter {
  /** Null = all visible; otherwise only these IDs are fully visible. */
  visibleNodeIds: Set<string> | null;
  selectedId: string | null;
  query: string;
  /** Relationship types to highlight (all highlighted if empty). */
  highlightRelTypes: Set<string>;
}

// ── Colors ────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, string> = {
  open:         '#2dd4bf',
  'in-progress': '#fb923c',
  in_progress:  '#fb923c',
  closed:       '#64748b',
  blocked:      '#f87171',
  draft:        '#94a3b8',
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
const EDGE_DEFAULT = 'rgba(148,163,184,0.45)';

// ── Internal types ────────────────────────────────────────────
interface SimNode extends CanvasNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned position while dragging (null = free). */
  fx: number | null;
  fy: number | null;
  r: number;
  color: string;
}

interface SimEdge extends CanvasEdge {
  source: SimNode;
  target: SimNode;
}

// ── Helpers ───────────────────────────────────────────────────
function nodeRadius(degree: number): number {
  return Math.max(9, Math.min(30, 9 + Math.sqrt(Math.max(0, degree)) * 4.5));
}

function getNodeColor(node: CanvasNode): string {
  if (node.lane === 'facet') return LANE_COLOR.facet;
  if (node.lane === 'external') return LANE_COLOR.external;
  return STATUS_COLORS[node.status] ?? LANE_COLOR.item;
}

function getEdgeColor(type: string): string {
  return EDGE_COLOR[type] ?? EDGE_DEFAULT;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

/** Spread nodes in a deterministic spiral for good simulation start. */
function initialPositions(nodes: CanvasNode[]): Array<{ x: number; y: number }> {
  const golden = 2.399963; // golden angle in radians
  return nodes.map((_, i) => {
    const radius = 60 + Math.sqrt(i) * 55;
    const angle = i * golden;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
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

  // Simulation constants
  private readonly ALPHA_DECAY = 0.022;
  private readonly ALPHA_MIN   = 0.001;
  private readonly VEL_DECAY   = 0.58;
  private readonly REPULSE     = 1800;
  private readonly SPRING      = 0.07;
  private readonly REST_LEN    = 130;
  private readonly CENTER      = 0.012;
  private readonly LINK_DIST_FACET = 80;

  // Camera
  private tx = 0;
  private ty = 0;
  private scale = 1;

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

  // Touch (pinch-zoom)
  private touchDist = 0;
  private touchMidX = 0;
  private touchMidY = 0;

  // Filter state
  private filter: CanvasFilter = {
    visibleNodeIds: null,
    selectedId: null,
    query: '',
    highlightRelTypes: new Set(),
  };

  // RAF + cleanup
  private rafId: number | null = null;
  private destroyed = false;
  private abortCtrl = new AbortController();
  private ro: ResizeObserver;

  // Callbacks
  private onSelectNode: (id: string | null) => void;
  private onOpenNode: (id: string) => void;

  constructor(container: HTMLElement, options: GraphCanvasOptions) {
    this.onSelectNode = options.onSelectNode;
    this.onOpenNode   = options.onOpenNode;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab;';
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
        color: getNodeColor(node),
      };
    });

    this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

    this.edges = edges.flatMap((e) => {
      const source = this.nodeMap.get(e.from);
      const target = this.nodeMap.get(e.to);
      return source && target ? [{ ...e, source, target }] : [];
    });

    this.alpha = 1;
    setTimeout(() => this.fitView(), 1200);
  }

  setFilter(filter: Partial<CanvasFilter>): void {
    this.filter = { ...this.filter, ...filter };
  }

  setSelected(id: string | null): void {
    this.filter = { ...this.filter, selectedId: id };
  }

  fitView(): void {
    if (this.nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const pad = 64;
    const gw = maxX - minX + pad * 2;
    const gh = maxY - minY + pad * 2;
    this.scale = Math.min(this.w / gw, this.h / gh, 2.5);
    this.tx = this.w / 2 - ((minX + maxX) / 2) * this.scale;
    this.ty = this.h / 2 - ((minY + maxY) / 2) * this.scale;
  }

  togglePhysics(): boolean {
    this.paused = !this.paused;
    if (!this.paused) this.alpha = Math.max(this.alpha, 0.05);
    return this.paused;
  }

  reheat(): void {
    this.alpha = 0.3;
    this.paused = false;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.abortCtrl.abort();
    this.ro.disconnect();
    this.canvas.remove();
  }

  // ── Physics simulation ─────────────────────────────────────

  private tick(): void {
    if (this.paused || this.alpha < this.ALPHA_MIN) return;

    const nodes = this.nodes;
    const edges = this.edges;
    const n = nodes.length;
    const a = this.alpha;

    // Repulsion (O(n²) — fine for ≤300 nodes)
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

    // Spring forces along edges
    for (const edge of edges) {
      const A = edge.source, B = edge.target;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const restLen = edge.type.startsWith('HAS_') || edge.type.startsWith('IN_')
        ? this.LINK_DIST_FACET
        : this.REST_LEN;
      const f  = (d - restLen) * this.SPRING * a;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      A.vx += fx; A.vy += fy;
      B.vx -= fx; B.vy -= fy;
    }

    // Centering force
    for (const nd of nodes) {
      nd.vx -= nd.x * this.CENTER * a;
      nd.vy -= nd.y * this.CENTER * a;
    }

    // Integrate + damp + apply fixed positions
    for (const nd of nodes) {
      nd.vx *= this.VEL_DECAY;
      nd.vy *= this.VEL_DECAY;
      if (nd.fx !== null) { nd.x = nd.fx; nd.vx = 0; }
      else nd.x += nd.vx;
      if (nd.fy !== null) { nd.y = nd.fy; nd.vy = 0; }
      else nd.y += nd.vy;
    }

    this.alpha -= this.alpha * this.ALPHA_DECAY;
  }

  // ── Rendering ──────────────────────────────────────────────

  private draw(): void {
    const { ctx, w, h, dpr } = this;
    ctx.clearRect(0, 0, w * dpr, h * dpr);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const { selectedId, visibleNodeIds, query, highlightRelTypes } = this.filter;

    // Neighbor set for selected node
    const neighborIds = new Set<string>();
    if (selectedId) {
      for (const e of this.edges) {
        if (e.from === selectedId) neighborIds.add(e.to);
        if (e.to   === selectedId) neighborIds.add(e.from);
      }
    }

    const getOpacity = (nodeId: string): number => {
      const visible = !visibleNodeIds || visibleNodeIds.has(nodeId);
      if (!visible) return 0.07;
      if (selectedId) {
        if (nodeId === selectedId) return 1;
        if (neighborIds.has(nodeId)) return 0.8;
        return 0.15;
      }
      if (query) {
        const nd = this.nodeMap.get(nodeId);
        if (!nd) return 0.15;
        const q = query.toLowerCase();
        const match = nd.label.toLowerCase().includes(q)
          || nd.id.toLowerCase().includes(q)
          || nd.type.toLowerCase().includes(q)
          || nd.status.toLowerCase().includes(q);
        return match ? 1 : 0.12;
      }
      return 1;
    };

    // 1. Draw edges (behind nodes)
    for (const edge of this.edges) {
      const opacity = Math.min(getOpacity(edge.from), getOpacity(edge.to));
      if (opacity < 0.04) continue;
      const isHighlightedByRel = highlightRelTypes.size > 0 && highlightRelTypes.has(edge.type);
      const isHighlightedBySel = selectedId && (edge.from === selectedId || edge.to === selectedId);
      this.drawEdge(edge, opacity, !!(isHighlightedByRel || isHighlightedBySel));
    }

    // 2. Draw nodes (above edges)
    for (const node of this.nodes) {
      const opacity = getOpacity(node.id);
      this.drawNode(
        node, opacity,
        node.id === selectedId,
        node.id === this.hoveredId,
      );
    }

    ctx.restore();

    // Draw HUD overlays (in screen space)
    this.drawHud();
  }

  private drawEdge(edge: SimEdge, opacity: number, highlighted: boolean): void {
    const { ctx } = this;
    const { source: s, target: t } = edge;

    const dx  = t.x - s.x;
    const dy  = t.y - s.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    const nx = dx / len;
    const ny = dy / len;

    // Start/end at node surfaces
    const x1 = s.x + nx * s.r;
    const y1 = s.y + ny * s.r;
    const x2 = t.x - nx * (t.r + 7);
    const y2 = t.y - ny * (t.r + 7);

    const color = getEdgeColor(edge.type);

    ctx.save();
    ctx.globalAlpha = opacity * (highlighted ? 0.92 : 0.42);
    ctx.strokeStyle = highlighted ? color : EDGE_DEFAULT;
    ctx.lineWidth   = highlighted ? 1.6 : 0.9;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Arrowhead (skip very short edges)
    if (len > 30) {
      const angle = Math.atan2(dy, dx);
      const aw = 7;
      const aa = 0.4;
      const ax = t.x - nx * t.r;
      const ay = t.y - ny * t.r;

      ctx.fillStyle = highlighted ? color : 'rgba(148,163,184,0.55)';
      ctx.globalAlpha = opacity * (highlighted ? 0.9 : 0.5);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - aw * Math.cos(angle - aa), ay - aw * Math.sin(angle - aa));
      ctx.lineTo(ax - aw * Math.cos(angle + aa), ay - aw * Math.sin(angle + aa));
      ctx.closePath();
      ctx.fill();
    }

    // Edge label (only when zoomed in and highlighted)
    if (highlighted && this.scale > 0.9) {
      const mx = (s.x + t.x) / 2;
      const my = (s.y + t.y) / 2;
      ctx.globalAlpha = opacity * 0.85;
      ctx.fillStyle = 'rgba(148,163,184,0.9)';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(edge.type, mx, my - 7);
    }

    ctx.restore();
  }

  private drawNode(node: SimNode, opacity: number, selected: boolean, hovered: boolean): void {
    const { ctx } = this;
    const { x, y, r, color } = node;
    const prominent = selected || hovered;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Glow effect for selected / hovered
    if (prominent) {
      ctx.shadowColor = color;
      ctx.shadowBlur  = selected ? 22 : 12;
    }

    // Fill + stroke
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle   = selected ? color : `${color}28`;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth   = selected ? 2.5 : (hovered ? 2 : 1.5);
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Inner status dot for item nodes
    if (r >= 12 && node.lane === 'item') {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = selected ? 'rgba(255,255,255,0.65)' : `${color}99`;
      ctx.fill();
    }

    // Label
    const showLabel = this.scale > 0.3 || prominent;
    if (showLabel) {
      const maxLen = this.scale > 0.65 ? 24 : 14;
      const label  = truncate(node.label || node.id, maxLen);
      const fSize  = Math.max(9, Math.min(13, r * 0.95));

      ctx.shadowBlur  = prominent ? 6 : 0;
      ctx.shadowColor = '#000';
      ctx.fillStyle   = selected ? '#ffffff' : 'rgba(226,232,240,0.88)';
      ctx.font        = `${selected ? 600 : 400} ${fSize}px Inter, sans-serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, y + r + 4);
      ctx.shadowBlur = 0;

      // Show type/status hint on hover
      if (hovered && this.scale > 0.5) {
        const hint = `${node.type} · ${node.status}`;
        ctx.fillStyle = 'rgba(148,163,184,0.75)';
        ctx.font      = `10px JetBrains Mono, monospace`;
        ctx.fillText(hint, x, y + r + 4 + fSize + 3);
      }
    }

    ctx.restore();
  }

  /** HUD: physics indicator, node count (screen-space). */
  private drawHud(): void {
    const { ctx } = this;
    const simActive = !this.paused && this.alpha > this.ALPHA_MIN;
    if (!simActive) return;

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = 'rgba(45,212,191,0.8)';
    ctx.beginPath();
    ctx.arc(this.w - 14, 14, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── Camera ─────────────────────────────────────────────────

  private zoom(delta: number, px: number, py: number): void {
    const factor = delta > 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(0.04, Math.min(6, this.scale * factor));
    this.tx = px - (px - this.tx) * (newScale / this.scale);
    this.ty = py - (py - this.ty) * (newScale / this.scale);
    this.scale = newScale;
  }

  private toWorld(px: number, py: number): [number, number] {
    return [(px - this.tx) / this.scale, (py - this.ty) / this.scale];
  }

  private hitTest(wx: number, wy: number): SimNode | null {
    // Iterate in reverse so topmost (last drawn) is hit first
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const nd = this.nodes[i];
      const dx = wx - nd.x;
      const dy = wy - nd.y;
      if (dx * dx + dy * dy <= (nd.r + 5) * (nd.r + 5)) return nd;
    }
    return null;
  }

  // ── Events ─────────────────────────────────────────────────

  private getPos(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindEvents(): void {
    const sig = { signal: this.abortCtrl.signal };

    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e), sig);
    window.addEventListener('mousemove',  (e) => this.onMouseMove(e),  sig);
    window.addEventListener('mouseup',    (e) => this.onMouseUp(e),    sig);
    this.canvas.addEventListener('wheel',     (e) => this.onWheel(e),    { ...sig, passive: false });
    this.canvas.addEventListener('dblclick',  (e) => this.onDblClick(e), sig);

    this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { ...sig, passive: false });
    this.canvas.addEventListener('touchmove',  (e) => this.onTouchMove(e),  { ...sig, passive: false });
    this.canvas.addEventListener('touchend',   (e) => this.onTouchEnd(e),   { ...sig, passive: false });
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
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
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const dx = x - this.lastX;
    const dy = y - this.lastY;

    if (Math.abs(x - this.downX) > 3 || Math.abs(y - this.downY) > 3) this.hasMoved = true;

    if (this.isDraggingNode && this.dragNode) {
      const [wx, wy] = this.toWorld(x, y);
      this.dragNode.fx = wx;
      this.dragNode.fy = wy;
    } else if (this.isDraggingCanvas) {
      this.tx += dx;
      this.ty += dy;
    } else {
      const [wx, wy] = this.toWorld(x, y);
      const hit = this.hitTest(wx, wy);
      const newHovered = hit?.id ?? null;
      if (newHovered !== this.hoveredId) {
        this.hoveredId = newHovered;
        this.canvas.style.cursor = newHovered ? 'pointer' : 'grab';
      }
    }

    this.lastX = x;
    this.lastY = y;
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;

    if (this.isDraggingNode && this.dragNode) {
      if (!this.hasMoved) {
        const id = this.dragNode.id;
        const newSel = this.filter.selectedId === id ? null : id;
        this.filter = { ...this.filter, selectedId: newSel };
        this.onSelectNode(newSel);
      }
      this.dragNode.fx = null;
      this.dragNode.fy = null;
      this.dragNode = null;
      this.isDraggingNode = false;
    } else if (this.isDraggingCanvas) {
      this.isDraggingCanvas = false;
      if (!this.hasMoved && this.filter.selectedId) {
        this.filter = { ...this.filter, selectedId: null };
        this.onSelectNode(null);
      }
    }

    this.canvas.style.cursor = this.hoveredId ? 'pointer' : 'grab';
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.getPos(e);
    // Normalize across trackpads and mice
    const delta = e.deltaMode === 1 ? -e.deltaY * 20 : -e.deltaY;
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
      const x = e.touches[0].clientX - rect.left;
      const y = e.touches[0].clientY - rect.top;
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
      }
      this.lastX = x;
      this.lastY = y;
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      this.zoom((dist - this.touchDist) * 0.6, midX, midY);
      this.tx += midX - this.touchMidX;
      this.ty += midY - this.touchMidY;
      this.touchDist = dist;
      this.touchMidX = midX;
      this.touchMidY = midY;
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 0) {
      if (this.isDraggingNode && this.dragNode) {
        if (!this.hasMoved) {
          const id = this.dragNode.id;
          const newSel = this.filter.selectedId === id ? null : id;
          this.filter = { ...this.filter, selectedId: newSel };
          this.onSelectNode(newSel);
        }
        this.dragNode.fx = null;
        this.dragNode.fy = null;
        this.dragNode = null;
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
  }

  // ── RAF loop ───────────────────────────────────────────────

  private startLoop(): void {
    const loop = () => {
      if (this.destroyed) return;
      this.tick();
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }
}
