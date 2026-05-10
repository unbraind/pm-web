// ═══════════════════════════════════════════════════════════════
// GUIDE VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { getGuide, getGuideTopic } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';

const TOPIC_ICONS: Record<string, string> = {
  quickstart: '🚀',
  commands: '⌨️',
  workflows: '🔄',
  sdk: '🛠️',
  extensions: '🧩',
  skills: '🤖',
  harnesses: '⚙️',
  release: '📦',
};

function topicIcon(id: string): string {
  return TOPIC_ICONS[id] ?? '📖';
}

function renderTopicCards(topics: Array<{id: string; title: string; summary?: string; intent?: string}>): string {
  if (topics.length === 0) {
    return '<div class="empty-state"><div class="empty-state-text">No guide topics found.</div></div>';
  }
  return `<div class="guide-topic-grid">${topics.map(t => `
    <div class="card guide-topic-card" style="cursor:pointer;margin-bottom:0" onclick="window.__app.renderGuideView('${escHtml(t.id)}')">
      <div class="guide-topic-icon">${topicIcon(t.id)}</div>
      <div class="guide-topic-body">
        <div class="guide-topic-title">${escHtml(t.title)}</div>
        <div class="guide-topic-summary">${escHtml(t.summary || t.intent || '')}</div>
      </div>
    </div>`).join('')}</div>`;
}

function renderTopicDetail(topic: {
  id: string;
  title: string;
  summary?: string;
  intent?: string;
  quick_commands?: string[];
  commands?: string[];
  workflows?: Array<{name: string; goal?: string; commands?: string[]}>;
  related?: string[];
}): string {
  const commands: string[] = topic.commands ?? topic.quick_commands ?? [];
  const related: string[] = topic.related ?? [];

  return `
    <div style="margin-bottom:16px">
      <a href="#" class="guide-back-link" onclick="event.preventDefault();window.__app.renderGuideView()"
        style="font-size:13px;color:var(--accent);text-decoration:none">← Back to topics</a>
    </div>
    <div class="page-header">
      <div>
        <div class="page-title">${topicIcon(topic.id)} ${escHtml(topic.title)}</div>
        ${topic.intent ? `<div class="page-subtitle">${escHtml(topic.intent)}</div>` : ''}
      </div>
    </div>
    ${topic.summary ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-body">
          <div class="item-detail-desc">${escHtml(topic.summary)}</div>
        </div>
      </div>` : ''}
    ${commands.length > 0 ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><div class="card-title">Quick Commands</div></div>
        <div class="card-body">
          ${commands.map(cmd => `
            <div class="guide-cmd-row">
              <code class="guide-cmd-code">${escHtml(cmd)}</code>
              <button class="btn btn-ghost btn-sm guide-copy-btn"
                onclick="navigator.clipboard.writeText('${escHtml(cmd.replace(/'/g, "\\'"))}').then(()=>window.__app.toast('Copied!','success')).catch(()=>{})"
                title="Copy to clipboard">⎘</button>
            </div>`).join('')}
        </div>
      </div>` : ''}
    ${topic.workflows && topic.workflows.length > 0 ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><div class="card-title">Workflows</div></div>
        <div class="card-body">
          ${topic.workflows.map(wf => `
            <div style="margin-bottom:16px">
              <div style="font-weight:600;font-size:14px;margin-bottom:4px">${escHtml(wf.name)}</div>
              ${wf.goal ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${escHtml(wf.goal)}</div>` : ''}
              ${wf.commands && wf.commands.length > 0 ? wf.commands.map(cmd => `
                <div class="guide-cmd-row">
                  <code class="guide-cmd-code">${escHtml(cmd)}</code>
                  <button class="btn btn-ghost btn-sm guide-copy-btn"
                    onclick="navigator.clipboard.writeText('${escHtml(cmd.replace(/'/g, "\\'"))}').then(()=>window.__app.toast('Copied!','success')).catch(()=>{})"
                    title="Copy to clipboard">⎘</button>
                </div>`).join('') : ''}
            </div>`).join('')}
        </div>
      </div>` : ''}
    ${related.length > 0 ? `
      <div class="card">
        <div class="card-header"><div class="card-title">Related Topics</div></div>
        <div class="card-body" style="display:flex;flex-wrap:wrap;gap:8px">
          ${related.map(r => `
            <a href="#" class="badge badge-secondary"
              onclick="event.preventDefault();window.__app.renderGuideView('${escHtml(r)}')"
              style="cursor:pointer;text-decoration:none">${escHtml(r)}</a>`).join('')}
        </div>
      </div>` : ''}`;
}

export async function renderGuideView(topicId?: string): Promise<void> {
  const el = document.getElementById('content-guide');
  if (!el) return;
  if (!state.currentProject) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
    return;
  }

  if (topicId) {
    // Show single topic detail
    el.innerHTML = `
      <div style="margin-bottom:16px">
        <a href="#" onclick="event.preventDefault();window.__app.renderGuideView()"
          style="font-size:13px;color:var(--accent);text-decoration:none">← Back to topics</a>
      </div>
      <div id="guide-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

    try {
      const data = await getGuideTopic(state.currentProject.id, topicId);
      const topic = (data as {topic?: unknown}).topic || data;
      const contentEl = document.getElementById('guide-content');
      if (contentEl) contentEl.innerHTML = renderTopicDetail(topic as Parameters<typeof renderTopicDetail>[0]);
    } catch (err: unknown) {
      const contentEl = document.getElementById('guide-content');
      if (contentEl) {
        contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
      }
      toast(err instanceof Error ? err.message : 'Failed to load topic', 'error');
    }
  } else {
    // Show topic list
    el.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">Guide</div><div class="page-subtitle">${escHtml(state.currentProject.name)}</div></div>
        <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderGuideView()">↺ Refresh</button></div>
      </div>
      <div id="guide-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

    try {
      const data = await getGuide(state.currentProject.id);
      const topics = (data as {topics?: unknown[]}).topics || [];
      const contentEl = document.getElementById('guide-content');
      if (contentEl) contentEl.innerHTML = renderTopicCards(topics as Parameters<typeof renderTopicCards>[0]);
    } catch (err: unknown) {
      const contentEl = document.getElementById('guide-content');
      if (contentEl) {
        contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
      }
      toast(err instanceof Error ? err.message : 'Failed to load guide', 'error');
    }
  }
}
