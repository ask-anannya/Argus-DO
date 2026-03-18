// Argus Background Service Worker v2.6.1
// Handles: WebSocket connection, API calls, context triggers, reminder flow, sidePanel, event CRUD
// NOTE: All popups are shown via content.js overlay - NO Chrome notifications

const API_BASE = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000';

let ws = null;
let reconnectAttempts = 0;
let lastCheckedUrl = '';
let contextCheckTimer = null;

// Store dismissed context reminders temporarily (per session)
const dismissedEvents = new Map(); // eventId -> timestamp

// Track which discovered events have already been notified this session.
// Uses chrome.storage.session so it survives service worker restarts.
async function isAlreadyNotified(eventId) {
  try {
    const data = await chrome.storage.session.get('notifiedIds');
    return (data.notifiedIds || []).includes(eventId);
  } catch { return false; }
}

async function markNotified(eventId) {
  try {
    const data = await chrome.storage.session.get('notifiedIds');
    const ids = data.notifiedIds || [];
    if (!ids.includes(eventId)) {
      ids.push(eventId);
      if (ids.length > 200) ids.splice(0, ids.length - 200); // cap size
      await chrome.storage.session.set({ notifiedIds: ids });
    }
  } catch (e) { console.error('[Argus] markNotified error:', e); }
}

// ============ UTILITY FUNCTIONS ============

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  if (typeof AbortController === 'undefined') return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('Request timed out after ' + timeoutMs + 'ms');
      e.name = 'TimeoutError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function debounce(func, wait) {
  return function executedFunction(...args) {
    clearTimeout(contextCheckTimer);
    contextCheckTimer = setTimeout(() => func.apply(this, args), wait);
  };
}

function isEventDismissed(eventId) {
  const dismissedTime = dismissedEvents.get(eventId);
  if (!dismissedTime) return false;
  
  const DISMISS_DURATION = 30 * 60 * 1000;
  const isDismissed = (Date.now() - dismissedTime) < DISMISS_DURATION;
  if (isDismissed) {
    const remaining = Math.floor((DISMISS_DURATION - (Date.now() - dismissedTime)) / 1000 / 60);
    console.log('[Argus] Event #' + eventId + ' dismissed (' + remaining + ' min left)');
  }
  return isDismissed;
}

function dismissEvent(eventId) {
  dismissedEvents.set(eventId, Date.now());
  console.log('[Argus] Event #' + eventId + ' dismissed for 30 min');
}

// ============ PENDING EVENT RECOVERY ============
// Fetches any 'discovered' events not yet notified and shows popups for them.
// Called on WS connect/reconnect and periodically as a fallback.

async function fetchAndShowDiscoveredEvents() {
  try {
    const res = await fetchWithTimeout(API_BASE + '/api/events?status=discovered&limit=20');
    if (!res.ok) return;
    const events = await res.json();
    if (!events || events.length === 0) return;

    for (const event of events) {
      if (!event.id) continue;
      if (await isAlreadyNotified(event.id)) continue;
      console.log('[Argus] 🔔 Recovered unnotified event #' + event.id + ':', event.title);
      const sent = await sendToFirstAvailableTab({ type: 'ARGUS_NEW_EVENT', event, popup: null });
      if (sent) {
        await markNotified(event.id);
        if (events.indexOf(event) < events.length - 1) {
          await new Promise(r => setTimeout(r, 800));
        }
      } else {
        console.log('[Argus] ⚠️ No tab available for event #' + event.id + ', will retry on next poll');
      }
    }
  } catch (e) {
    console.error('[Argus] fetchAndShowDiscoveredEvents error:', e.message);
  }
}

// ============ WEBSOCKET CONNECTION ============

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  
  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = function() {
      console.log('[Argus] WebSocket connected');
      reconnectAttempts = 0;
      // Delay slightly so any pending real-time broadcasts arrive and take priority.
      // Recovery poll only catches what the real-time path missed.
      setTimeout(fetchAndShowDiscoveredEvents, 3000);
    };
    
    ws.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        console.log('[Argus] WS:', data.type);
        handleWebSocketMessage(data);
      } catch (e) {
        console.error('[Argus] WS parse error:', e);
      }
    };
    
    ws.onclose = function() {
      console.log('[Argus] WebSocket disconnected');
      ws = null;
      const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
      reconnectAttempts++;
      setTimeout(connectWebSocket, delay);
    };
    
    ws.onerror = function() {};
  } catch (e) {
    console.error('[Argus] WS error:', e);
  }
}

// ============ WEBSOCKET MESSAGE HANDLERS ============

async function handleWebSocketMessage(data) {
  // data.popup contains the Gemini-generated popup blueprint (if available)
  // Pass it through to content.js so it can render without hardcoded templates
  const popup = data.popup || null;
  
  switch (data.type) {
    case 'notification':
      console.log('[Argus] New event:', data.event?.title);
      if (await sendToFirstAvailableTab({ type: 'ARGUS_NEW_EVENT', event: data.event, popup })) {
        if (data.event?.id) await markNotified(data.event.id);
      } else {
        console.log('[Argus] ⚠️ Real-time send failed for event #' + data.event?.id + ', recovery poll will retry');
      }
      break;

    case 'conflict_warning':
      console.log('[Argus] Conflict:', data.event?.title);
      if (await sendToFirstAvailableTab({ type: 'ARGUS_CONFLICT', event: data.event, conflictingEvents: data.conflictingEvents, popup })) {
        if (data.event?.id) await markNotified(data.event.id);
      }
      break;
      
    case 'trigger':
      console.log('[Argus] Reminder:', data.event?.title);
      await sendToAllTabs({
        type: 'ARGUS_REMINDER',
        event: data.event || { title: data.message },
        message: data.message,
        popup,
      });
      break;

    case 'context_reminder':
      console.log('[Argus] Context reminder:', data.event?.title);
      if (data.event && !isEventDismissed(data.event.id)) {
        await sendToFirstAvailableTab({
          type: 'ARGUS_CONTEXT_REMINDER',
          event: data.event,
          url: data.url,
          popup,
        });
      }
      break;

    case 'action_performed':
      console.log('[Argus] Action:', data.action, 'on', data.eventTitle);
      await sendToFirstAvailableTab({
        type: 'ARGUS_ACTION_TOAST',
        action: data.action,
        eventId: data.eventId,
        eventTitle: data.eventTitle,
        message: data.message,
      });
      break;

    case 'update_confirm':
      console.log('[Argus] Update confirm:', data.eventTitle, data.description);
      await sendToFirstAvailableTab({
        type: 'ARGUS_UPDATE_CONFIRM',
        eventId: data.eventId,
        eventTitle: data.eventTitle,
        changes: data.changes,
        description: data.description,
        popup: data.popup,
      });
      break;

    case 'event_updated':
      console.log('[Argus] Event updated:', data.eventId, data.fields);
      await sendToFirstAvailableTab({
        type: 'ARGUS_ACTION_TOAST',
        action: 'update',
        eventId: data.eventId,
        eventTitle: '',
        message: 'Event updated: ' + (data.fields || []).join(', '),
      });
      break;
  }
}

// ============ TAB COMMUNICATION ============

async function sendToFirstAvailableTab(message) {
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('[Argus] 🔍 Looking for tab to send', message.type, '| active tabs:', activeTabs.length);
    for (const tab of activeTabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        if (await trySendToTab(tab.id, message)) {
          console.log('[Argus] Sent to active tab:', tab.id, tab.url?.substring(0, 50));
          return true;
        }
      }
    }
    
    const allTabs = await chrome.tabs.query({});
    console.log('[Argus] No active tab worked, trying all', allTabs.length, 'tabs...');
    for (const tab of allTabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        if (await trySendToTab(tab.id, message)) {
          console.log('[Argus] Sent to tab ' + tab.id + ':', tab.url?.substring(0, 50));
          return true;
        }
      }
    }
    
    console.log('[Argus] ❌ No tabs available to show popup!');
    return false;
  } catch (e) {
    console.error('[Argus] Send error:', e.message);
    return false;
  }
}

async function trySendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (e) {
    try {
      console.log('[Argus] Content script not ready on tab ' + tabId + ', injecting...');
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      // Wait for content script to fully initialize and register its listeners
      await new Promise(r => setTimeout(r, 1000));
      await chrome.tabs.sendMessage(tabId, message);
      console.log('[Argus] ✅ Sent after injecting content script on tab ' + tabId);
      return true;
    } catch (e2) {
      console.log('[Argus] ❌ Failed to send to tab ' + tabId + ':', e2.message);
      return false;
    }
  }
}

async function sendToAllTabs(message) {
  const tabs = await chrome.tabs.query({});
  let sent = 0;
  for (const tab of tabs) {
    if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      if (await trySendToTab(tab.id, message)) sent++;
    }
  }
  console.log('[Argus] Sent to ' + sent + ' tabs');
  return sent;
}

// ============ CONTEXT CHECK ============

// Sites where context-trigger polling is useless (saves API calls + log noise)
const CONTEXT_CHECK_BLOCKLIST = [
  'localhost', '127.0.0.1', '0.0.0.0',
  'web.whatsapp.com', 'whatsapp.com',
  'mail.google.com', 'accounts.google.com',
  'chrome.google.com', 'extensions',
  'new-tab-page',
];

function isBlockedForContextCheck(url) {
  try {
    const hostname = new URL(url).hostname;
    return CONTEXT_CHECK_BLOCKLIST.some(b => hostname === b || hostname.endsWith('.' + b));
  } catch { return false; }
}

async function checkCurrentUrl(url, title) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return;
  if (isBlockedForContextCheck(url)) return;
  if (url === lastCheckedUrl) return;
  lastCheckedUrl = url;

  console.log('[Argus] Context check:', url.substring(0, 50));

  try {
    const response = await fetchWithTimeout(API_BASE + '/api/context-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title }),
    }, 8000);

    if (!response.ok) return;
    const result = await response.json();

    if (result.contextTriggers && result.contextTriggers.length > 0) {
      console.log('[Argus] Found ' + result.contextTriggers.length + ' context triggers');
      
      for (const event of result.contextTriggers) {
        if (!isEventDismissed(event.id)) {
          console.log('[Argus] Context reminder:', event.title);
          await sendToFirstAvailableTab({
            type: 'ARGUS_CONTEXT_REMINDER',
            event: event,
            url: url,
            popup: event.popup || null,
          });
        }
      }
    }
  } catch (error) {
    if (error && error.name === 'TimeoutError') {
      console.warn('[Argus] Context check timed out for:', url.substring(0, 50));
    } else {
      console.error('[Argus] Context error:', error.message);
    }
  }
}

const debouncedUrlCheck = debounce(checkCurrentUrl, 500);

// ============ TAB LISTENERS ============

chrome.tabs.onUpdated.addListener(async function(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete' && tab.url && tab.active) {
    debouncedUrlCheck(tab.url, tab.title);
  }
});

chrome.tabs.onActivated.addListener(async function(activeInfo) {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && tab.status === 'complete') {
      lastCheckedUrl = '';
      debouncedUrlCheck(tab.url, tab.title);
    }
  } catch (e) {}
});

// ============ MESSAGE HANDLERS ============

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  console.log('[Argus] Action:', message.type, 'Event:', message.eventId || 'N/A');
  
  const handleAsync = async () => {
    try {
      switch (message.type) {
        case 'SET_REMINDER':
          console.log('[Argus] API: set-reminder for event', message.eventId);
          const setRes = await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId + '/set-reminder', { method: 'POST' });
          const setData = await setRes.json();
          console.log('[Argus] API response:', setData);
          return setData;
          
        case 'SNOOZE_EVENT':
          console.log('[Argus] API: snooze for event', message.eventId);
          const snoozeRes = await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId + '/snooze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ minutes: message.minutes || 30 }),
          });
          const snoozeData = await snoozeRes.json();
          console.log('[Argus] API response:', snoozeData);
          return snoozeData;
          
        case 'IGNORE_EVENT':
          console.log('[Argus] API: ignore for event', message.eventId);
          const ignoreRes = await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId + '/ignore', { method: 'POST' });
          const ignoreData = await ignoreRes.json();
          console.log('[Argus] API response:', ignoreData);
          return ignoreData;
          
        case 'ACKNOWLEDGE_REMINDER':
          return await (await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId + '/acknowledge', { method: 'POST' })).json();
          
        case 'MARK_DONE':
        case 'COMPLETE_EVENT':
          console.log('[Argus] API: complete for event', message.eventId);
          const completeRes = await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId + '/complete', { method: 'POST' });
          const completeData = await completeRes.json();
          console.log('[Argus] API response:', completeData);
          return completeData;
          
        case 'DISMISS_EVENT':
          console.log('[Argus] API: dismiss for event', message.eventId);
          if (!message.permanent) dismissEvent(message.eventId);
          const dismissRes = await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId + '/dismiss', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permanent: message.permanent, urlPattern: message.url }),
          });
          const dismissData = await dismissRes.json();
          console.log('[Argus] API response:', dismissData);
          return dismissData;
          
        case 'DELETE_EVENT':
          console.log('[Argus] API: delete for event', message.eventId);
          return await (await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId, { method: 'DELETE' })).json();

        case 'UPDATE_EVENT':
          console.log('[Argus] API: update for event', message.eventId, message.fields);
          const updateRes = await fetchWithTimeout(API_BASE + '/api/events/' + message.eventId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message.fields || {}),
          });
          return await updateRes.json();
          
        case 'OPEN_DASHBOARD':
          chrome.tabs.create({ url: 'http://localhost:3000' });
          return { success: true };
          
        case 'GET_STATS':
          return await (await fetchWithTimeout(API_BASE + '/api/stats')).json();

        case 'GET_EVENTS':
          return await (await fetchWithTimeout(API_BASE + '/api/events?limit=10')).json();

        case 'GET_DAY_EVENTS':
          console.log('[Argus] API: get day events for timestamp', message.timestamp);
          const dayRes = await fetchWithTimeout(API_BASE + '/api/events/day/' + message.timestamp);
          return await dayRes.json();

        default:
          console.log('[Argus] Unknown message type:', message.type);
          return { error: 'Unknown message type: ' + message.type };
      }
    } catch (error) {
      if (error && error.name === 'TimeoutError') {
        console.warn('[Argus] API timeout:', error.message);
        return { error: 'Server not responding', timeout: true };
      }
      const isOffline = error && (
        error.message?.includes('Failed to fetch') ||
        error.message?.includes('NetworkError') ||
        error.message?.includes('ERR_CONNECTION_REFUSED')
      );
      if (isOffline) {
        return { error: 'Cannot reach Argus server', offline: true };
      }
      console.error('[Argus] API error:', error);
      return { error: error.message };
    }
  };
  
  handleAsync().then(sendResponse);
  return true;
});

// ============ SIDE PANEL ============

// Enable side panel to open on action click
try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
      .catch(function(e) { console.log('[Argus] sidePanel behavior error:', e); });
  }
} catch (e) {}

// Allow opening side panel via context menu or keyboard shortcut
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'OPEN_SIDE_PANEL') {
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.sidePanel.open({ windowId: sender.tab ? sender.tab.windowId : undefined })
          .then(function() { sendResponse({ success: true }); })
          .catch(function(e) { sendResponse({ error: e.message }); });
        return true;
      }
    } catch (e) {}
    sendResponse({ error: 'sidePanel not available' });
    return false;
  }
});

// ============ STARTUP ============

chrome.runtime.onInstalled.addListener(function() {
  console.log('[Argus] Extension installed');
  connectWebSocket();
  chrome.alarms.create('argusKeepAlive', { periodInMinutes: 0.4 });
});

chrome.runtime.onStartup.addListener(function() {
  connectWebSocket();
  chrome.alarms.create('argusKeepAlive', { periodInMinutes: 0.4 });
});

// MV3 keepalive: Chrome terminates service workers after inactivity.
// This alarm fires every ~24s to keep the SW alive, check the WS, and run recovery.
chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name !== 'argusKeepAlive') return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('[Argus] ⏰ Alarm: WS not open, reconnecting...');
    connectWebSocket();
  }
  // Recovery poll — safe to run every alarm because storage.session deduplicates
  fetchAndShowDiscoveredEvents();
});

connectWebSocket();
chrome.alarms.create('argusKeepAlive', { periodInMinutes: 0.4 });

console.log('[Argus] Background v2.6.1 loaded');
