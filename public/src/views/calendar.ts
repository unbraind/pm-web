// ═══════════════════════════════════════════════════════════════
// CALENDAR VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, typeIcon, statusBadge } from '../utils.js';
import { skeletonRows } from '../utils.js';
import { showModal, createModal } from '../components/modals.js';
import { renderItemRow } from './items.js';

export async function renderCalendarView(): Promise<void> {
  const el = document.getElementById('content-calendar');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Calendar</div><div class="page-subtitle">Upcoming events &amp; deadlines</div></div>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" onclick="window.__app.calNav(-1)">← Prev</button>
        <span id="cal-month-label" style="font-size:13px;font-weight:600;min-width:120px;text-align:center"></span>
        <button class="btn btn-ghost btn-sm" onclick="window.__app.calNav(1)">Next →</button>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderCalendarView()">↺ Today</button>
      </div>
    </div>
    <div id="calendar-content">${skeletonRows(6)}</div>`;

  try {
    const [itemsData, calData] = await Promise.all([
      api('GET',`/projects/${state.currentProject.id}/pm/list-all?limit=9999`),
      api('GET',`/projects/${state.currentProject.id}/pm/calendar`).catch(()=>({events:[]})),
    ]);
    const allItems = ((itemsData as any).items || []).filter((i: any) => i.deadline || i.type === 'Event' || i.type === 'Meeting' || i.type === 'Reminder');
    const calEvents = (calData as any).events || (calData as any).items || [];

    state.calOffset = state.calOffset || 0;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + state.calOffset;
    const calDate = new Date(year, month, 1);
    const monthLabel = calDate.toLocaleDateString('en-US', {month:'long', year:'numeric'});
    const labelEl = document.getElementById('cal-month-label');
    if (labelEl) labelEl.textContent = monthLabel;

    const firstDay = calDate.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();
    const today = new Date();

    const dateMap: Record<string, any[]> = {};
    allItems.forEach((item: any) => {
      if (item.deadline) {
        const d = new Date(item.deadline).toISOString().slice(0, 10);
        if (!dateMap[d]) dateMap[d] = [];
        dateMap[d].push(item);
      }
    });

    let gridHtml = '<div class="cal-grid">';
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
      gridHtml += `<div class="cal-header">${d}</div>`;
    });
    for (let i = firstDay - 1; i >= 0; i--) {
      gridHtml += `<div class="cal-day other-month"><div class="cal-day-num">${daysInPrev - i}</div></div>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${calDate.getFullYear()}-${String(calDate.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
      const dayItems = dateMap[dateStr] || [];
      gridHtml += `<div class="cal-day${isToday?' today':''}" onclick="window.__app.showDayItems('${dateStr}')">`;
      gridHtml += `<div class="cal-day-num">${d}</div>`;
      dayItems.slice(0, 3).forEach((item: any) => {
        gridHtml += `<div class="cal-event-dot status-${item.status}" title="${escHtml(item.title)}" onclick="event.stopPropagation();window.__app.openItemDetail('${escHtml(item.id)}')">${escHtml(item.title.slice(0,12))}</div>`;
      });
      if (dayItems.length > 3) {
        gridHtml += `<div class="cal-event-dot more">+${dayItems.length - 3} more</div>`;
      }
      gridHtml += '</div>';
    }
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remaining; i++) {
      gridHtml += `<div class="cal-day other-month"><div class="cal-day-num">${i}</div></div>`;
    }
    gridHtml += '</div>';

    let upcomingHtml = '';
    if (calEvents.length > 0) {
      upcomingHtml = '<div class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">Upcoming Events</div></div><div class="card-body">';
      calEvents.slice(0, 10).forEach((ev: any) => {
        upcomingHtml += `<div class="calendar-event" onclick="window.__app.openItemDetail('${escHtml(ev.id||ev.itemId||'')}')">
          <div class="calendar-event-id">${typeIcon(ev.type||'')} ${escHtml(ev.id||'')}</div>
          <div class="calendar-event-title">${escHtml(ev.title||ev.name||'')}</div>
          <div class="calendar-event-date">${escHtml(ev.date||ev.dueDate||ev.timestamp||'')}</div>
        </div>`;
      });
      upcomingHtml += '</div></div>';
    }

    const contentEl = document.getElementById('calendar-content');
    if (contentEl) contentEl.innerHTML = gridHtml + upcomingHtml;
  } catch(err: unknown) {
    const contentEl = document.getElementById('calendar-content');
    if (contentEl) contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

export function calNav(dir: number): void {
  state.calOffset = (state.calOffset || 0) + dir;
  renderCalendarView();
}

export function showDayItems(dateStr: string): void {
  if (!state.currentProject) return;
  createModal('day-items-modal', `Items due ${dateStr}`, '<div class="loading-state"><div class="loading-spinner"></div></div>', '', true);
  showModal('day-items-modal');
  api('GET', `/projects/${state.currentProject.id}/pm/list-all?limit=9999`).then(data => {
    const items = ((data as any).items || []).filter((i: any) => {
      if (!i.deadline) return false;
      return new Date(i.deadline).toISOString().slice(0,10) === dateStr;
    });
    const bodyEl = document.getElementById('day-items-modal')?.querySelector('.modal-body');
    if (bodyEl) bodyEl.innerHTML = items.length === 0
      ? '<div style="color:var(--text-muted);font-size:13px">No items due on this date</div>'
      : `<div class="item-list">${items.map((item: any) => renderItemRow(item)).join('')}</div>`;
  }).catch((err: unknown) => {
    const bodyEl = document.getElementById('day-items-modal')?.querySelector('.modal-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  });
}
