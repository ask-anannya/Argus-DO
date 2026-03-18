// Argus Popup Script v2.6.1 - Event CRUD support
const API = 'http://localhost:3000/api';

// DOM Elements
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statNew = document.getElementById('stat-new');
const statScheduled = document.getElementById('stat-scheduled');
const statCompleted = document.getElementById('stat-completed');

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.events').forEach(e => e.classList.add('hidden'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

// Load stats
async function loadStats() {
  const errorBanner = document.getElementById('error-banner');
  try {
    const res = await fetch(API + '/stats');
    if (!res.ok) throw new Error('Stats fetch failed');
    const data = await res.json();

    // New = discovered + snoozed (needs attention)
    statNew.textContent = (data.discoveredEvents || 0) + (data.snoozedEvents || 0);
    statScheduled.textContent = data.scheduledEvents || 0;
    statCompleted.textContent = data.completedEvents || 0;

    statusDot.classList.remove('error');
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
    if (errorBanner) errorBanner.classList.add('hidden');
  } catch (e) {
    statusDot.classList.remove('connected');
    statusDot.classList.add('error');
    statusText.textContent = 'Offline';
    if (errorBanner) errorBanner.classList.remove('hidden');
    console.error('[Argus Popup] Stats error:', e);
  }
}

// Load events by status
async function loadEvents() {
  try {
    // Load discovered + snoozed events (new tab)
    const newRes = await fetch(API + '/events?status=discovered&limit=10');
    const newEvents = newRes.ok ? await newRes.json() : [];
    const snoozedRes = await fetch(API + '/events?status=snoozed&limit=10');
    const snoozedEvents = snoozedRes.ok ? await snoozedRes.json() : [];
    renderEvents('new-events-list', [...newEvents, ...snoozedEvents], 'new');
    
    // Load scheduled events (active)
    const schedRes = await fetch(API + '/events?status=scheduled&limit=10');
    const schedEvents = schedRes.ok ? await schedRes.json() : [];
    renderEvents('scheduled-events-list', schedEvents, 'scheduled');
    
    // Load completed events
    const doneRes = await fetch(API + '/events?status=completed&limit=10');
    const doneEvents = doneRes.ok ? await doneRes.json() : [];
    renderEvents('done-events-list', doneEvents, 'completed');
    
  } catch (e) {
    console.error('[Argus Popup] Events error:', e);
    document.getElementById('new-events-list').innerHTML = '<p class="empty">Failed to load</p>';
  }
}

function renderEvents(containerId, events, tabType) {
  const container = document.getElementById(containerId);
  
  if (!events.length) {
    container.innerHTML = '<p class="empty">No events</p>';
    return;
  }
  
  container.innerHTML = events.map(e => {
    const dateStr = e.event_time ? new Date(e.event_time * 1000).toLocaleDateString() : '';
    let actions = '';
    
    // Actions based on actual status
    if (e.status === 'discovered') {
      actions = `
        <button class="btn btn-schedule" data-action="schedule" data-id="${e.id}">📅 Schedule</button>
        <button class="btn btn-later" data-action="snooze" data-id="${e.id}">💤 Later</button>
        <button class="btn btn-delete" data-action="ignore" data-id="${e.id}">🚫</button>
      `;
    } else if (e.status === 'snoozed') {
      actions = `
        <button class="btn btn-schedule" data-action="schedule" data-id="${e.id}">📅 Schedule</button>
        <button class="btn btn-delete" data-action="ignore" data-id="${e.id}">🚫 Ignore</button>
      `;
    } else if (e.status === 'scheduled') {
      actions = `
        <button class="btn btn-done" data-action="complete" data-id="${e.id}">✅ Done</button>
        <button class="btn btn-later" data-action="snooze" data-id="${e.id}">💤</button>
      `;
    }
    
    return `
      <div class="event-item" data-id="${e.id}">
        <div class="event-header">
          <div class="event-title">${escapeHtml(e.title || 'Untitled')}</div>
          <span class="event-badge badge-${e.status}">${e.status}</span>
        </div>
        <div class="event-meta">
          <span>${e.event_type || ''}</span>
          ${e.location ? `<span>📍 ${escapeHtml(e.location)}</span>` : ''}
          ${dateStr ? `<span>📅 ${dateStr}</span>` : ''}
        </div>
        ${actions ? `<div class="event-actions">${actions}</div>` : ''}
      </div>
    `;
  }).join('');
  
  // Add event listeners to ALL buttons
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async function(e) {
      e.preventDefault();
      e.stopPropagation();
      const action = this.dataset.action;
      const id = parseInt(this.dataset.id);
      console.log('[Argus Popup] Action:', action, 'ID:', id);
      
      // Disable button during API call
      const originalText = this.textContent;
      this.disabled = true;
      this.textContent = '...';

      let actionFailed = false;
      try {
        const result = await handleEventAction(action, id);
        if (result && result.error) {
          actionFailed = true;
          console.error('[Argus Popup] Action error response:', result.error);
        }
      } catch (err) {
        actionFailed = true;
        console.error('[Argus Popup] Action error:', err);
      }

      if (actionFailed) {
        this.textContent = '❌';
        this.style.background = '#f87171';
        setTimeout(() => {
          this.textContent = originalText;
          this.style.background = '';
          this.disabled = false;
        }, 2000);
        return;
      }

      // Reload data
      await loadEvents();
      await loadStats();
    });
  });
}

// Event action handler - direct API calls
async function handleEventAction(action, eventId) {
  let endpoint = '';
  let method = 'POST';
  let body = null;
  
  switch (action) {
    case 'schedule':
      endpoint = `/events/${eventId}/set-reminder`;
      break;
    case 'snooze':
      endpoint = `/events/${eventId}/snooze`;
      body = JSON.stringify({ minutes: 30 });
      break;
    case 'ignore':
      endpoint = `/events/${eventId}/ignore`;
      break;
    case 'complete':
      endpoint = `/events/${eventId}/complete`;
      break;
    case 'delete':
      endpoint = `/events/${eventId}`;
      method = 'DELETE';
      break;
    default:
      console.error('[Argus Popup] Unknown action:', action);
      return;
  }
  
  console.log('[Argus Popup] API call:', method, API + endpoint);
  
  const options = { method };
  if (body) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = body;
  }
  
  const res = await fetch(API + endpoint, options);
  const data = await res.json();
  console.log('[Argus Popup] API response:', data);
  return data;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Export backup button
document.getElementById('export-backup').addEventListener('click', async function () {
  this.disabled = true;
  this.textContent = 'Exporting...';
  try {
    const res = await fetch(API + '/backup/export');
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `argus-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.textContent = 'Downloaded!';
    setTimeout(() => { this.textContent = 'Export Backup'; this.disabled = false; }, 2000);
  } catch (e) {
    this.textContent = 'Failed';
    setTimeout(() => { this.textContent = 'Export Backup'; this.disabled = false; }, 2000);
  }
});

// Initialize
console.log('[Argus Popup] Initializing...');
loadStats();
loadEvents();

// Auto-refresh every 5 seconds
setInterval(() => {
  loadStats();
  loadEvents();
}, 5000);
