// Argus Side Panel - AI Chat v2.6.1
// Provides a conversational interface to query events and interact with Argus

(function() {
  'use strict';

  const API = 'http://localhost:3000/api';
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const statusDot = document.getElementById('status-dot');
  const quickActions = document.getElementById('quick-actions');

  let isLoading = false;
  let chatHistory = []; // { role: 'user'|'assistant', content: string }

  // ============ CONNECTION CHECK ============
  async function checkConnection() {
    try {
      const res = await fetch(API + '/health');
      if (res.ok) {
        statusDot.classList.add('connected');
        return true;
      }
    } catch (e) {}
    statusDot.classList.remove('connected');
    return false;
  }

  // ============ CHAT API ============
  async function sendMessage(query) {
    if (!query.trim() || isLoading) return;

    // Add user message
    addMessage(query, 'user');
    chatHistory.push({ role: 'user', content: query });
    inputEl.value = '';
    autoResize();

    // Show typing indicator
    isLoading = true;
    sendBtn.disabled = true;
    const typingEl = showTyping();

    try {
      const res = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query,
          history: chatHistory.slice(-10), // Send last 10 messages for context
        }),
      });

      if (!res.ok) {
        throw new Error('Server returned ' + res.status);
      }

      const data = await res.json();

      // Remove typing indicator
      removeTyping(typingEl);

      // Add assistant response
      const responseText = data.response || 'Sorry, I could not process that.';
      addMessage(responseText, 'assistant', data.events);
      chatHistory.push({ role: 'assistant', content: responseText });

    } catch (error) {
      removeTyping(typingEl);
      addMessage('Failed to connect to Argus server. Make sure it is running on localhost:3000.', 'error');
      console.error('[Argus Chat] Error:', error);
    }

    isLoading = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  // ============ UI FUNCTIONS ============
  function addMessage(text, type, events) {
    const msgEl = document.createElement('div');
    msgEl.className = 'msg ' + type;

    if (type === 'assistant') {
      // Parse simple markdown
      msgEl.innerHTML = parseMarkdown(text);
    } else {
      msgEl.textContent = text;
    }

    messagesEl.appendChild(msgEl);

    // If events are included, render event cards
    if (events && events.length > 0) {
      events.forEach(function(event) {
        const card = createEventCard(event);
        messagesEl.appendChild(card);
      });
    }

    scrollToBottom();
  }

  function parseMarkdown(text) {
    // Simple markdown: **bold**, *italic*, `code`, \n → <br>, lists
    let html = escapeHtml(text);
    
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Code
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    // Newlines
    html = html.replace(/\n/g, '<br>');
    // Bullet lists (lines starting with - or •)
    html = html.replace(/((?:^|<br>)(?:[-•] .+(?:<br>|$))+)/g, function(match) {
      const items = match.split('<br>').filter(function(l) { return l.trim(); });
      return '<ul>' + items.map(function(item) {
        return '<li>' + item.replace(/^[-•]\s*/, '') + '</li>';
      }).join('') + '</ul>';
    });

    return html;
  }

  function createEventCard(event) {
    const card = document.createElement('div');
    card.className = 'event-card';

    let dateStr = '';
    if (event.event_time) {
      const d = new Date(event.event_time * 1000);
      dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      dateStr += ' ' + timeStr;
    }

    const typeEmoji = {
      meeting: '📅', deadline: '⏰', reminder: '🔔', travel: '✈️',
      task: '📝', subscription: '💳', recommendation: '💡', other: '📌'
    };

    card.innerHTML =
      '<div class="event-card-title">' + (typeEmoji[event.event_type] || '📌') + ' ' + escapeHtml(event.title) + '</div>' +
      '<div class="event-card-meta">' +
        (dateStr ? '<span>📅 ' + dateStr + '</span>' : '<span>📅 No date</span>') +
        (event.location ? '<span>📍 ' + escapeHtml(event.location) + '</span>' : '') +
        '<span>🏷️ ' + escapeHtml(event.event_type) + '</span>' +
        (event.status ? '<span>• ' + escapeHtml(event.status) + '</span>' : '') +
      '</div>' +
      '<div class="event-card-actions">' +
        '<button class="event-card-btn primary" data-action="complete" data-id="' + event.id + '">✅ Done</button>' +
        '<button class="event-card-btn" data-action="snooze" data-id="' + event.id + '">💤 Snooze</button>' +
        '<button class="event-card-btn" data-action="delete" data-id="' + event.id + '">🗑️</button>' +
      '</div>';

    // Event card action handlers
    card.querySelectorAll('[data-action]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const action = this.dataset.action;
        const id = this.dataset.id;
        try {
          let endpoint = '';
          let method = 'POST';
          let fetchOpts = {};
          if (action === 'complete') endpoint = '/events/' + id + '/complete';
          else if (action === 'snooze') {
            endpoint = '/events/' + id + '/snooze';
            fetchOpts = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes: 30 }) };
          }
          else if (action === 'delete') { endpoint = '/events/' + id; method = 'DELETE'; }

          const res = await fetch(API + endpoint, Object.assign({ method: method }, fetchOpts));
          if (res.ok) {
            card.style.opacity = '0.5';
            card.style.pointerEvents = 'none';
            addMessage('✓ Event ' + action + 'd successfully.', 'system');
          }
        } catch (e) {
          console.error('[Argus Chat] Action error:', e);
        }
      });
    });

    return card;
  }

  function showTyping() {
    const typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML =
      '<div class="typing-dot"></div>' +
      '<div class="typing-dot"></div>' +
      '<div class="typing-dot"></div>';
    messagesEl.appendChild(typing);
    scrollToBottom();
    return typing;
  }

  function removeTyping(el) {
    if (el && el.parentNode) el.remove();
  }

  function scrollToBottom() {
    requestAnimationFrame(function() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============ AUTO-RESIZE TEXTAREA ============
  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
  }

  // ============ EVENT LISTENERS ============

  // Send on button click
  sendBtn.addEventListener('click', function() {
    sendMessage(inputEl.value);
  });

  // Send on Enter (Shift+Enter for newline)
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  // Auto resize textarea
  inputEl.addEventListener('input', autoResize);

  // Quick action buttons
  quickActions.addEventListener('click', function(e) {
    const btn = e.target.closest('.quick-btn');
    if (btn) {
      const query = btn.dataset.query;
      inputEl.value = query;
      sendMessage(query);
    }
  });

  // ============ INIT ============
  checkConnection();
  setInterval(checkConnection, 30000);
  inputEl.focus();

  console.log('[Argus] Side Panel Chat v1.0 loaded');
})();
