// Argus Content Script v2.2
// In-page overlay popups for event notifications
// Popup Types: event_discovery, event_reminder, context_reminder, conflict_warning, insight_card

(function () {
  'use strict';

  // Track dismissed/handled events (persisted for session)
  const dismissedEventIds = new Set();
  const handledEventIds = new Set();

  // ============ STYLES ============
  const STYLES = `
    /* Reset for Argus elements */
    #argus-modal-backdrop,
    #argus-modal-backdrop * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    }

    /* Modal Backdrop */
    #argus-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(15, 23, 42, 0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: argus-fade-in 0.25s ease-out;
    }

    @keyframes argus-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes argus-scale-in {
      from { transform: scale(0.9) translateY(-20px); opacity: 0; }
      to { transform: scale(1) translateY(0); opacity: 1; }
    }

    @keyframes argus-scale-out {
      from { transform: scale(1); opacity: 1; }
      to { transform: scale(0.9); opacity: 0; }
    }

    /* Modal Container */
    #argus-modal {
      background: rgba(30, 41, 59, 0.75);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 16px;
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.4);
      max-width: 420px;
      width: 92%;
      overflow: hidden;
      animation: argus-scale-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      color: #ffffff;
    }

    #argus-modal.hiding {
      animation: argus-scale-out 0.2s ease-in forwards;
    }

    /* Header */
    .argus-header {
      padding: 24px 24px 20px;
      position: relative;
      color: #ffffff;
      background: transparent;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .argus-header.discovery .argus-icon { background: rgba(99, 102, 241, 0.2); border: 1px solid rgba(99, 102, 241, 0.4); box-shadow: 0 0 15px rgba(99, 102, 241, 0.3); }
    .argus-header.reminder .argus-icon { background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); box-shadow: 0 0 15px rgba(245, 158, 11, 0.3); }
    .argus-header.context .argus-icon { background: rgba(14, 165, 233, 0.2); border: 1px solid rgba(14, 165, 233, 0.4); box-shadow: 0 0 15px rgba(14, 165, 233, 0.3); }
    .argus-header.conflict .argus-icon { background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); box-shadow: 0 0 15px rgba(239, 68, 68, 0.3); }
    .argus-header.insight .argus-icon { background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.4); box-shadow: 0 0 15px rgba(16, 185, 129, 0.3); }

    .argus-close-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #94a3b8;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .argus-close-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
    }

    .argus-icon {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 12px;
      font-size: 28px;
    }

    .argus-title {
      font-size: 20px;
      font-weight: 700;
      text-align: center;
      margin: 0 0 4px;
    }

    .argus-subtitle {
      font-size: 13px;
      text-align: center;
      color: #cbd5e1;
    }

    /* Body */
    .argus-body {
      padding: 20px 24px 24px;
    }

    .argus-event-title {
      font-size: 17px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 6px;
      line-height: 1.3;
    }

    .argus-event-desc {
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.5;
      margin-bottom: 16px;
    }

    .argus-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 20px;
    }

    .argus-meta-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      color: #cbd5e1;
    }

    .argus-meta-item span {
      font-size: 14px;
    }

    .argus-question {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 14px;
      text-align: center;
      font-size: 14px;
      color: #cbd5e1;
      margin-bottom: 20px;
    }

    /* Actions */
    .argus-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .argus-actions-row {
      display: flex;
      gap: 10px;
    }

    .argus-btn {
      flex: 1;
      padding: 12px 20px;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .argus-btn:hover {
      transform: translateY(-1px);
    }

    .argus-btn:active {
      transform: translateY(0);
    }

    .argus-btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .argus-btn-primary:hover {
      box-shadow: 0 6px 16px rgba(99, 102, 241, 0.5);
    }

    .argus-btn-success {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .argus-btn-success:hover {
      box-shadow: 0 6px 16px rgba(16, 185, 129, 0.5);
    }

    .argus-btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }

    .argus-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .argus-btn-outline {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #94a3b8;
    }

    .argus-btn-outline:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.25);
    }

    /* Footer */
    .argus-footer {
      padding: 12px 24px;
      text-align: center;
      background: rgba(0, 0, 0, 0.15);
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .argus-powered {
      font-size: 11px;
      color: #64748b;
    }

    .argus-powered strong {
      color: #818cf8;
    }

    /* Toast Notifications */
    #argus-toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }

    .argus-toast {
      background: rgba(30, 41, 59, 0.85);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      padding: 14px 18px;
      min-width: 280px;
      max-width: 360px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      color: #f8fafc;
      pointer-events: all;
      animation: argus-slide-in 0.3s ease-out;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    @keyframes argus-slide-in {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .argus-toast.hiding {
      animation: argus-slide-out 0.2s ease-in forwards;
    }

    @keyframes argus-slide-out {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }

    .argus-toast-icon {
      font-size: 20px;
      flex-shrink: 0;
    }

    .argus-toast-content {
      flex: 1;
    }

    .argus-toast-title {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 2px;
    }

    .argus-toast-desc {
      font-size: 12px;
      color: #94a3b8;
    }

    .argus-toast-close {
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      font-size: 16px;
      padding: 0;
      flex-shrink: 0;
    }

    .argus-toast-close:hover {
      color: #f8fafc;
    }

    .argus-toast-error {
      border-left: 3px solid #f87171;
    }

    .argus-toast-error .argus-toast-icon {
      color: #f87171;
    }
      max-width: 360px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      color: #f9fafb;
      pointer-events: all;
      animation: argus-slide-in 0.3s ease-out;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    @keyframes argus-slide-in {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .argus-toast.hiding {
      animation: argus-slide-out 0.2s ease-in forwards;
    }

    @keyframes argus-slide-out {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }

    .argus-toast-icon {
      font-size: 20px;
      flex-shrink: 0;
    }

    .argus-toast-content {
      flex: 1;
    }

    .argus-toast-title {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 2px;
    }

    .argus-toast-desc {
      font-size: 12px;
      color: #9ca3af;
    }

    .argus-toast-close {
      background: none;
      border: none;
      color: #6b7280;
      cursor: pointer;
      font-size: 16px;
      padding: 0;
      flex-shrink: 0;
    }

    .argus-toast-close:hover {
      color: #f9fafb;
    }
  `;

  // ============ STATE ============
  let styleElement = null;
  let currentModal = null;
  let toastContainer = null;
  const shownEventIds = new Set();
  let argusFormWatcherTarget = null; // Tracks the input field that triggered a form mismatch

  // ============ MODAL CONFIGURATION ============
  // Dynamic - uses event data to build human-readable messages
  function getModalConfig(popupType, event, extraData) {
    const sender = event.sender_name || 'Someone';
    const eventType = event.event_type || 'other';

    switch (popupType) {
      case 'event_discovery':
        return {
          icon: eventType === 'recommendation' ? '💡' : eventType === 'subscription' ? '💳' : eventType === 'meeting' ? '📅' : eventType === 'task' ? '📝' : '📅',
          headerClass: eventType === 'recommendation' ? 'insight' : 'discovery',
          title: eventType === 'recommendation' ? 'Remember This?' :
            eventType === 'subscription' ? 'Subscription Alert!' :
              eventType === 'meeting' ? 'New Event Detected!' :
                'New Event Detected!',
          subtitle: sender !== 'Someone' ? 'From your chat with ' + sender : 'From your WhatsApp messages',
          question: eventType === 'recommendation' ? 'Want to save this for later?' :
            eventType === 'subscription' ? 'Want to set a reminder for this?' :
              'Would you like to set a reminder?',
          buttons: [
            { text: '⏰ Set Reminder', action: 'set-reminder', style: 'primary' },
            { text: '💤 Later', action: 'snooze', style: 'secondary' },
            { text: '🚫 Not Interested', action: 'ignore', style: 'outline' },
          ]
        };

      case 'event_reminder':
        return {
          icon: '⏰',
          headerClass: 'reminder',
          title: 'Event Starting Soon!',
          subtitle: sender !== 'Someone' ? sender + ' mentioned this' : 'This is your scheduled reminder',
          question: null,
          buttons: [
            { text: '✓ Got It', action: 'acknowledge', style: 'primary' },
            { text: '✅ Mark Done', action: 'done', style: 'success' },
            { text: '💤 Snooze 30min', action: 'snooze', style: 'secondary' },
          ]
        };

      case 'context_reminder':
        // Build smart message based on event type
        let contextTitle = 'Remember This?';
        let contextSubtitle = 'From your messages';
        let contextQuestion = 'Would you like to take action now?';
        let contextButtons = [
          { text: '✅ Done', action: 'done', style: 'success' },
          { text: '💤 Not Now', action: 'dismiss-temp', style: 'secondary' },
          { text: "🚫 Never Show", action: 'dismiss-permanent', style: 'outline' },
        ];

        if (eventType === 'subscription') {
          contextTitle = '💳 Subscription Alert!';
          contextSubtitle = 'You planned to take action on this';
          contextQuestion = 'You\'re on this site right now. Want to take action?';
          contextButtons = [
            { text: '✅ Already Done', action: 'done', style: 'success' },
            { text: '💤 Remind Later', action: 'dismiss-temp', style: 'secondary' },
            { text: "🚫 Cancel Reminder", action: 'dismiss-permanent', style: 'outline' },
          ];
        } else if (eventType === 'recommendation' || eventType === 'travel') {
          contextTitle = '💡 ' + (sender !== 'Someone' ? sender + '\'s Recommendation' : 'Recommendation');
          contextSubtitle = sender !== 'Someone' ? 'From your chat with ' + sender : 'From your conversations';
          contextQuestion = 'You\'re browsing related content right now!';
          contextButtons = [
            { text: '📍 Save Location', action: 'done', style: 'success' },
            { text: '💤 Not Now', action: 'dismiss-temp', style: 'secondary' },
            { text: "🚫 Not Interested", action: 'dismiss-permanent', style: 'outline' },
          ];
        }

        return {
          icon: eventType === 'subscription' ? '💳' : eventType === 'recommendation' ? '💡' : '🎯',
          headerClass: 'context',
          title: contextTitle,
          subtitle: contextSubtitle,
          question: contextQuestion,
          buttons: contextButtons,
        };

      case 'conflict_warning': {
        const conflicts = extraData.conflictingEvents || [];
        const conflictNames = conflicts.map(function (e) { return e.title; }).join(', ');
        // Build a human, conversational message
        let friendlyQuestion = 'You may have overlapping commitments.';
        if (conflicts.length === 1) {
          const c = conflicts[0];
          let cTime = '';
          if (c.event_time) {
            cTime = new Date(c.event_time * 1000).toLocaleDateString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
          }
          friendlyQuestion = 'You already have "' + c.title + '"' + (cTime ? ' on ' + cTime : '') + '. This new event will overlap — want to pick a different time?';
        } else if (conflicts.length > 1) {
          friendlyQuestion = 'Heads up! You already have ' + conflicts.length + ' things planned around this time (' + conflictNames + '). Want to find a better slot?';
        }
        return {
          icon: '🗓️',
          headerClass: 'conflict',
          title: 'Hmm, you might be double-booked',
          subtitle: sender !== 'Someone' ? sender + ' mentioned this — but you already have plans' : 'Let\'s sort out your schedule',
          question: friendlyQuestion,
          buttons: [
            { text: '� View My Day', action: 'view-day', style: 'primary' },
            { text: '✅ Keep Both', action: 'acknowledge', style: 'secondary' },
            { text: '🚫 Skip This One', action: 'ignore', style: 'outline' },
          ]
        };
      }

      case 'update_confirm': {
        const changeDesc = extraData.description || 'Some changes have been proposed for this event.';
        return {
          icon: '📝',
          headerClass: 'conflict',
          title: 'Update Event?',
          subtitle: sender !== 'Someone' ? sender + ' mentioned changes' : 'A message suggests changes to this event',
          question: changeDesc,
          buttons: [
            { text: '✅ Yes, Update', action: 'confirm-update', style: 'primary' },
            { text: '⏭️ Skip', action: 'dismiss', style: 'secondary' },
            { text: '🚫 Ignore', action: 'ignore', style: 'outline' },
          ]
        };
      }

      case 'form_mismatch': {
        const remembered = extraData.remembered || 'a different value';
        const entered = extraData.entered || 'what you typed';
        const suggestion = extraData.suggestion || 'Double-check before proceeding — you might get a better deal!';
        return {
          icon: '⚠️',
          headerClass: 'conflict',
          title: 'Hold on — that doesn\'t match!',
          subtitle: 'From your WhatsApp conversations',
          question: suggestion,
          buttons: [
            { text: '✏️ Fix It', action: 'fix-form-field', style: 'primary' },
            { text: '👍 It\'s Correct', action: 'dismiss', style: 'secondary' },
            { text: '🚫 Dismiss', action: 'dismiss', style: 'outline' },
          ]
        };
      }

      case 'insight_card':
        return {
          icon: '💡',
          headerClass: 'insight',
          title: sender !== 'Someone' ? sender + '\'s Suggestion' : 'Suggestion',
          subtitle: 'Based on your conversations',
          question: null,
          buttons: [
            { text: '👍 Thanks!', action: 'acknowledge', style: 'primary' },
            { text: '🚫 Not Relevant', action: 'dismiss', style: 'secondary' },
          ]
        };

      default:
        return {
          icon: '📅',
          headerClass: 'discovery',
          title: 'New Event Detected!',
          subtitle: 'From your WhatsApp messages',
          question: 'Would you like to set a reminder?',
          buttons: [
            { text: '⏰ Set Reminder', action: 'set-reminder', style: 'primary' },
            { text: '💤 Later', action: 'snooze', style: 'secondary' },
            { text: '🚫 Not Interested', action: 'ignore', style: 'outline' },
          ]
        };
    }
  }

  // ============ INITIALIZATION ============
  function injectStyles() {
    if (styleElement) return;
    styleElement = document.createElement('style');
    styleElement.id = 'argus-styles';
    styleElement.textContent = STYLES;
    document.head.appendChild(styleElement);
  }

  function createToastContainer() {
    if (toastContainer) return toastContainer;
    toastContainer = document.createElement('div');
    toastContainer.id = 'argus-toast-container';
    document.body.appendChild(toastContainer);
    return toastContainer;
  }

  // ============ MODAL FUNCTIONS ============
  function showModal(event, popupType = 'event_discovery', extraData = {}) {
    // Prevent duplicate/dismissed modals
    if (event.id) {
      if (shownEventIds.has(event.id)) {
        console.log('[Argus] ⏭️ Modal already shown for event:', event.id);
        return;
      }
      if (dismissedEventIds.has(event.id)) {
        console.log('[Argus] ⏭️ Event dismissed, not showing:', event.id);
        return;
      }
      if (handledEventIds.has(event.id)) {
        console.log('[Argus] ⏭️ Event already handled, not showing:', event.id);
        return;
      }
    }

    console.log(`[Argus] 🎨 Showing popup: type="${popupType}", event="${event.title}" (id: ${event.id})`);

    injectStyles();

    // Close any existing modal
    if (currentModal) {
      currentModal.remove();
      currentModal = null;
    }

    if (event.id) {
      shownEventIds.add(event.id);
    }

    // Use API popup blueprint if available, otherwise fall back to local config
    // v2.6.0: Server sends complete popup spec via Gemini — extension just renders
    const config = extraData.popup || getModalConfig(popupType, event, extraData);

    // Create backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'argus-modal-backdrop';

    // Format event time
    let timeDisplay = null;
    if (event.event_time) {
      const eventDate = new Date(event.event_time * 1000);
      timeDisplay = eventDate.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    }

    // Build modal HTML
    let html = '<div id="argus-modal">';

    // Header
    html += '<div class="argus-header ' + config.headerClass + '">';
    html += '<button class="argus-close-btn" data-action="close">✕</button>';
    html += '<div class="argus-icon">' + config.icon + '</div>';
    html += '<h2 class="argus-title">' + config.title + '</h2>';
    html += '<p class="argus-subtitle">' + config.subtitle + '</p>';
    html += '</div>';

    // Body
    html += '<div class="argus-body">';
    html += '<div class="argus-event-title">' + escapeHtml(event.title || 'Untitled Event') + '</div>';

    if (event.description) {
      // Build smart description with sender attribution
      let desc = event.description;
      if (event.sender_name && !desc.toLowerCase().includes(event.sender_name.toLowerCase())) {
        desc = event.sender_name + ' mentioned: ' + desc;
      }
      html += '<div class="argus-event-desc">' + escapeHtml(desc) + '</div>';
    }

    // Meta info
    html += '<div class="argus-meta">';
    if (timeDisplay) {
      html += '<div class="argus-meta-item"><span>📅</span> ' + timeDisplay + '</div>';
    }
    if (event.location) {
      html += '<div class="argus-meta-item"><span>📍</span> ' + escapeHtml(event.location) + '</div>';
    }
    if (event.event_type) {
      html += '<div class="argus-meta-item"><span>🏷️</span> ' + escapeHtml(event.event_type) + '</div>';
    }
    html += '</div>';

    // Show conflicting events for conflict_warning popup
    if (popupType === 'conflict_warning' && extraData.conflictingEvents && extraData.conflictingEvents.length > 0) {
      html += '<div class="argus-question" style="background: #fff7ed; border-color: #fed7aa; color: #9a3412; border-radius: 10px; padding: 12px 16px;">';
      html += '<strong>📅 What\'s already on your plate:</strong><br><br>';
      extraData.conflictingEvents.forEach(function (conflict) {
        let conflictTime = '';
        if (conflict.event_time) {
          const d = new Date(conflict.event_time * 1000);
          conflictTime = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        html += '&nbsp;&nbsp;→ ' + escapeHtml(conflict.title) + (conflictTime ? ' — ' + conflictTime : '') + '<br>';
      });
      html += '</div>';
    }

    // Question
    if (config.question) {
      html += '<div class="argus-question">' + config.question + '</div>';
    }

    // Action buttons
    if (event.id && config.buttons.length > 0) {
      html += '<div class="argus-actions">';
      html += '<div class="argus-actions-row">';
      config.buttons.slice(0, 2).forEach(function (btn) {
        html += '<button class="argus-btn argus-btn-' + btn.style + '" data-action="' + btn.action + '">' + btn.text + '</button>';
      });
      html += '</div>';
      if (config.buttons.length > 2) {
        html += '<button class="argus-btn argus-btn-' + config.buttons[2].style + '" data-action="' + config.buttons[2].action + '">' + config.buttons[2].text + '</button>';
      }
      html += '</div>';
    }

    html += '</div>'; // End body

    // Footer
    html += '<div class="argus-footer">';
    html += '<span class="argus-powered">Powered by <strong>Argus</strong></span>';
    html += '</div>';

    html += '</div>'; // End modal

    backdrop.innerHTML = html;
    document.body.appendChild(backdrop);
    currentModal = backdrop;

    // Event handlers
    backdrop.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const action = this.getAttribute('data-action');
        if (action === 'close') {
          closeModal();
        } else {
          handleAction(action, event, popupType, extraData);
        }
      });
    });

    // Close on backdrop click (except for context reminders)
    if (popupType !== 'context_reminder') {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) {
          closeModal();
        }
      });
    }

    console.log('[Argus] Modal shown:', popupType, event.title);
  }

  function closeModal() {
    if (!currentModal) return;

    const modal = currentModal.querySelector('#argus-modal');
    if (modal) {
      modal.classList.add('hiding');
    }

    const modalToRemove = currentModal;
    currentModal = null;

    setTimeout(function () {
      if (modalToRemove && modalToRemove.parentNode) {
        modalToRemove.remove();
      }
    }, 200);
  }

  function handleAction(action, event, popupType, extraData) {
    const eventId = event.id;
    console.log(`[Argus] 🔵 User action: "${action}" on event #${eventId} (popup: ${popupType})`);

    // Track this event as handled so we don't show it again
    if (eventId) {
      handledEventIds.add(eventId);
    }

    switch (action) {
      case 'set-reminder':
      case 'schedule':
        console.log(`[Argus] 📡 Sending SET_REMINDER message to background for event #${eventId}`);
        safeSendMessage(
          { type: 'SET_REMINDER', eventId: eventId },
          { title: '📅 Scheduled!', desc: 'You will be reminded before the event.' },
          '❌ Couldn\'t Schedule'
        );
        break;

      case 'snooze':
        console.log(`[Argus] 📡 Sending SNOOZE for event #${eventId}`);
        safeSendMessage(
          { type: 'SNOOZE_EVENT', eventId: eventId, minutes: 30 },
          { title: '💤 Snoozed!', desc: 'Reminder in 30 minutes.' },
          '❌ Couldn\'t Snooze'
        );
        break;

      case 'ignore':
        console.log(`[Argus] 📡 Sending IGNORE for event #${eventId}`);
        safeSendMessage(
          { type: 'IGNORE_EVENT', eventId: eventId },
          { title: '🚫 Ignored', desc: 'Event will not remind you.' },
          '❌ Couldn\'t Ignore'
        );
        break;

      case 'acknowledge':
        console.log(`[Argus] 📡 Sending ACKNOWLEDGE_REMINDER for event #${eventId}`);
        safeSendMessage(
          { type: 'ACKNOWLEDGE_REMINDER', eventId: eventId },
          null,
          '❌ Acknowledge Failed'
        );
        break;

      case 'done':
      case 'complete':
        console.log(`[Argus] 📡 Sending COMPLETE for event #${eventId}`);
        safeSendMessage(
          { type: 'COMPLETE_EVENT', eventId: eventId },
          { title: '✅ Completed!', desc: event.title },
          '❌ Couldn\'t Complete'
        );
        break;

      case 'dismiss':
      case 'dismiss-temp':
        console.log(`[Argus] 🔔 Temporary dismiss for event #${eventId}`);
        if (eventId) dismissedEventIds.add(eventId);
        safeSendMessage(
          { type: 'DISMISS_EVENT', eventId: eventId, permanent: false, url: extraData.url || window.location.href },
          null,
          '❌ Dismiss Failed'
        );
        break;

      case 'dismiss-permanent':
        console.log(`[Argus] ❌ Permanent dismiss for event #${eventId}`);
        if (eventId) dismissedEventIds.add(eventId);
        safeSendMessage(
          { type: 'DISMISS_EVENT', eventId: eventId, permanent: true, url: extraData.url || window.location.href },
          { title: 'Got it!', desc: "Won't show this reminder again." },
          '❌ Dismiss Failed'
        );
        break;

      case 'delete':
        console.log(`[Argus] 🗑️ Deleting event #${eventId}`);
        safeSendMessage(
          { type: 'DELETE_EVENT', eventId: eventId },
          { title: '🗑️ Event Deleted', desc: event.title },
          '❌ Couldn\'t Delete'
        );
        break;

      case 'view':
        console.log(`[Argus] 👁️ Opening dashboard`);
        chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
        break;

      case 'view-day':
        console.log(`[Argus] 📅 View My Day for event #${eventId}`);
        // Get event timestamp for the day
        var dayTimestamp = event.event_time || Math.floor(Date.now() / 1000);
        chrome.runtime.sendMessage(
          { type: 'GET_DAY_EVENTS', timestamp: dayTimestamp },
          function (response) {
            if (response && response.events) {
              showDayScheduleInline(response.date, response.events, event);
            } else {
              showToast('📅 No events found', 'Your day looks clear!');
            }
          }
        );
        // Don't close modal — we'll update it inline
        return;

      case 'confirm-update':
        console.log(`[Argus] ✅ User confirmed update for event #${eventId}`);
        var changes = extraData.changes || {};
        fetch('http://localhost:3000/api/events/' + eventId + '/confirm-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changes: changes }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              showToast('📝 Updated!', event.title + ' has been updated.');
            } else {
              showToast('❌ Update failed', data.error || 'Could not update event.');
            }
          })
          .catch(function (err) {
            console.error('[Argus] Confirm-update error:', err);
            showToast('❌ Error', 'Could not reach server.');
          });
        break;

      case 'fix-form-field':
        console.log(`[Argus] ✏️ User wants to fix form field, remembered: ${extraData.remembered}`);
        // Find the input field on the page and fill it with the remembered value
        if (extraData.remembered && argusFormWatcherTarget) {
          argusFormWatcherTarget.value = extraData.remembered;
          argusFormWatcherTarget.dispatchEvent(new Event('input', { bubbles: true }));
          argusFormWatcherTarget.focus();
          argusFormWatcherTarget.style.outline = '3px solid #22c55e';
          setTimeout(function () { argusFormWatcherTarget.style.outline = ''; }, 2000);
          showToast('✏️ Fixed!', 'Updated to: ' + extraData.remembered);
        } else {
          showToast('✏️ Fix it manually', 'Change the value to: ' + (extraData.remembered || 'the correct one'));
        }
        break;
    }

    closeModal();
  }

  // ============ DAY SCHEDULE VIEW ============
  function showDayScheduleInline(dateLabel, events, currentEvent) {
    var modal = document.querySelector('#argus-modal');
    if (!modal) return;

    // Find or create the day-schedule container inside the modal body
    var existing = modal.querySelector('.argus-day-schedule');
    if (existing) existing.remove();

    var container = document.createElement('div');
    container.className = 'argus-day-schedule';
    container.style.cssText = 'margin: 12px 20px; padding: 14px 16px; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;';

    var header = '<div style="font-weight: 600; font-size: 13px; color: #0369a1; margin-bottom: 10px;">📅 Your day: ' + escapeHtml(dateLabel || 'Today') + '</div>';

    var timeline = '';
    if (events.length === 0) {
      timeline = '<div style="color: #64748b; font-size: 12px; padding: 8px 0;">Nothing scheduled — your day is wide open! 🎉</div>';
    } else {
      events.forEach(function (ev) {
        var time = '';
        if (ev.event_time) {
          var d = new Date(ev.event_time * 1000);
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        var isCurrent = currentEvent && ev.id === currentEvent.id;
        var isConflict = currentEvent && currentEvent.event_time && ev.event_time &&
          Math.abs(ev.event_time - currentEvent.event_time) < 3600 && ev.id !== currentEvent.id;

        var dotColor = isConflict ? '#ef4444' : (isCurrent ? '#3b82f6' : '#10b981');
        var bg = isConflict ? 'background: #fef2f2;' : (isCurrent ? 'background: #eff6ff;' : '');
        var label = isConflict ? ' <span style="color: #ef4444; font-size: 10px;">⚠️ overlaps</span>' : '';
        if (isCurrent) label = ' <span style="color: #3b82f6; font-size: 10px;">← new</span>';

        timeline += '<div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; margin-bottom: 4px; ' + bg + '">';
        timeline += '<div style="width: 8px; height: 8px; border-radius: 50%; background: ' + dotColor + '; flex-shrink: 0;"></div>';
        timeline += '<span style="font-size: 11px; color: #64748b; min-width: 55px;">' + (time || 'All day') + '</span>';
        timeline += '<span style="font-size: 12px; color: #1e293b; font-weight: 500;">' + escapeHtml(ev.title) + '</span>';
        timeline += label;
        timeline += '</div>';
      });
    }

    container.innerHTML = header + timeline;

    // Insert before the actions div
    var actionsDiv = modal.querySelector('.argus-actions');
    if (actionsDiv) {
      actionsDiv.parentNode.insertBefore(container, actionsDiv);
    } else {
      var body = modal.querySelector('.argus-body');
      if (body) body.appendChild(container);
    }
  }

  // ============ TOAST FUNCTIONS ============
  function showToast(title, description) {
    injectStyles();
    const container = createToastContainer();

    const toast = document.createElement('div');
    toast.className = 'argus-toast';
    toast.innerHTML =
      '<div class="argus-toast-icon">✓</div>' +
      '<div class="argus-toast-content">' +
      '<div class="argus-toast-title">' + escapeHtml(title) + '</div>' +
      '<div class="argus-toast-desc">' + escapeHtml(description) + '</div>' +
      '</div>' +
      '<button class="argus-toast-close">✕</button>';

    toast.querySelector('.argus-toast-close').addEventListener('click', function () {
      removeToast(toast);
    });

    container.appendChild(toast);

    // Auto-remove after 4 seconds
    setTimeout(function () {
      removeToast(toast);
    }, 4000);
  }

  function showErrorToast(title, description) {
    injectStyles();
    const container = createToastContainer();
    const toast = document.createElement('div');
    toast.className = 'argus-toast argus-toast-error';
    toast.innerHTML =
      '<div class="argus-toast-icon">✕</div>' +
      '<div class="argus-toast-content">' +
      '<div class="argus-toast-title">' + escapeHtml(title) + '</div>' +
      '<div class="argus-toast-desc">' + escapeHtml(description) + '</div>' +
      '</div>' +
      '<button class="argus-toast-close">✕</button>';
    toast.querySelector('.argus-toast-close').addEventListener('click', function () {
      removeToast(toast);
    });
    container.appendChild(toast);
    setTimeout(function () { removeToast(toast); }, 5000); // 5s for errors (vs 4s success)
  }

  // Wrapper for all chrome.runtime.sendMessage calls.
  // Handles: service worker crash (lastError), API errors (response.error),
  // timeout (response.timeout), and offline (response.offline).
  function safeSendMessage(msg, successToast, errorTitle) {
    chrome.runtime.sendMessage(msg, function (response) {
      if (chrome.runtime.lastError) {
        showErrorToast('❌ Extension Error', 'Argus background service is not running.');
        return;
      }
      if (response && response.error) {
        showErrorToast(errorTitle || '❌ Action Failed', response.error);
      } else if (successToast) {
        showToast(successToast.title, successToast.desc);
      }
    });
  }

  function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add('hiding');
    setTimeout(function () {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 200);
  }

  // ============ UTILITIES ============
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============ INSURANCE FORM MISMATCH (DOM WATCHER) ============
  // Watches input fields on insurance-like pages for car model entries
  // Cross-references with WhatsApp memory to detect mismatches
  const FORM_CHECK_DEBOUNCE = 1500; // ms after user stops typing
  let formCheckTimer = null;
  let formMismatchShown = false; // Only show once per page load

  function isInsuranceLikePage() {
    const url = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();
    const bodyText = (document.body?.innerText || '').substring(0, 3000).toLowerCase();

    const insuranceKeywords = ['insurance', 'insure', 'acko', 'policybazaar', 'digit', 'hdfc ergo', 'icici lombard', 'bajaj allianz', 'car quote', 'vehicle quote', 'renew policy', 'car model', 'get quote'];

    // Also check input placeholders for car-related hints
    const inputs = document.querySelectorAll('input');
    let hasCarInput = false;
    inputs.forEach(function (inp) {
      const ph = (inp.placeholder || '').toLowerCase();
      if (ph.includes('car') || ph.includes('vehicle') || ph.includes('model')) hasCarInput = true;
    });

    return hasCarInput || insuranceKeywords.some(kw => url.includes(kw) || title.includes(kw) || bodyText.includes(kw));
  }

  function extractCarModel(text) {
    if (!text || text.length < 3) return null;
    // Match patterns like "Honda Civic 2022", "Maruti Swift 2020", "Hyundai i20 2019"
    // Model tokens must start with a letter so "2020" isn't eaten as part of the model name
    const carPattern = /\b(honda|toyota|maruti|suzuki|hyundai|tata|mahindra|kia|mg|skoda|volkswagen|bmw|audi|mercedes|ford|chevrolet|renault|nissan|fiat|jeep)\s+([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*)?)\s*(20[0-9]{2})?\b/i;
    const match = text.match(carPattern);
    if (match) {
      console.log('[Argus] 🚗 Parsed car:', JSON.stringify({ make: match[1], model: match[2], year: match[3] || null }));
      return {
        make: match[1].trim(),
        model: match[2].trim(),
        year: match[3] || null,
        full: text.trim(),
      };
    }
    return null;
  }

  function checkFormFieldForMismatch(inputEl) {
    if (formMismatchShown) return;
    const value = inputEl.value.trim();
    if (!value || value.length < 5) return;

    const carInfo = extractCarModel(value);
    if (!carInfo) return;

    console.log('[Argus] 🚗 Detected car model in form:', carInfo);
    argusFormWatcherTarget = inputEl;

    // Call server to check for mismatch
    fetch('http://localhost:3000/api/form-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fieldValue: value,
        fieldType: 'car_model',
        url: window.location.href,
        parsed: carInfo,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.mismatch && !formMismatchShown) {
          formMismatchShown = true;
          console.log('[Argus] ⚠️ Form mismatch detected!', data);
          showModal(
            {
              id: 'form-mismatch-' + Date.now(),
              title: data.entered + ' → should be ' + data.remembered,
              description: data.suggestion,
              event_type: 'form_check',
            },
            'form_mismatch',
            {
              remembered: data.remembered,
              entered: data.entered,
              suggestion: data.suggestion,
            }
          );
        }
      })
      .catch(function (err) {
        console.error('[Argus] Form check error:', err);
      });
  }

  function attachFormWatchers() {
    if (!isInsuranceLikePage()) return;
    console.log('[Argus] 🏥 Insurance-like page detected, attaching form watchers');

    // Watch all text inputs on the page
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    inputs.forEach(function (input) {
      if (input.dataset.argusWatching) return;
      input.dataset.argusWatching = 'true';

      input.addEventListener('input', function () {
        clearTimeout(formCheckTimer);
        formCheckTimer = setTimeout(function () {
          checkFormFieldForMismatch(input);
        }, FORM_CHECK_DEBOUNCE);
      });
    });

    // Also watch for dynamically added inputs
    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          const newInputs = node.querySelectorAll ? node.querySelectorAll('input[type="text"], input:not([type])') : [];
          newInputs.forEach(function (input) {
            if (input.dataset.argusWatching) return;
            input.dataset.argusWatching = 'true';
            input.addEventListener('input', function () {
              clearTimeout(formCheckTimer);
              formCheckTimer = setTimeout(function () {
                checkFormFieldForMismatch(input);
              }, FORM_CHECK_DEBOUNCE);
            });
          });
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Attach watchers after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachFormWatchers);
  } else {
    attachFormWatchers();
  }

  // ============ MESSAGE HANDLERS ============
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    console.log(`[Argus] 📬 Content script received: ${message.type}`);

    try {
      switch (message.type) {
        case 'ARGUS_NEW_EVENT':
          console.log(`[Argus] 📅 New event discovered: "${message.event?.title}" (id: ${message.event?.id})`);
          showModal(message.event, 'event_discovery', { popup: message.popup });
          sendResponse({ received: true });
          break;

        case 'ARGUS_REMINDER':
          console.log(`[Argus] ⏰ Time-based reminder: "${message.event?.title || message.message}" (id: ${message.event?.id})`);
          showModal(message.event || { title: message.message }, 'event_reminder', { popup: message.popup });
          sendResponse({ received: true });
          break;

        case 'ARGUS_CONTEXT_REMINDER':
          console.log(`[Argus] 🌐 Context reminder: "${message.event?.title}" (id: ${message.event?.id}) for URL: ${message.url}`);
          showModal(message.event, 'context_reminder', { url: message.url, popup: message.popup });
          sendResponse({ received: true });
          break;

        case 'ARGUS_CONFLICT':
          console.log(`[Argus] ⚠️ Conflict warning: "${message.event?.title}" conflicts with ${message.conflictingEvents?.length} event(s)`);
          showModal(message.event, 'conflict_warning', { conflictingEvents: message.conflictingEvents, popup: message.popup });
          sendResponse({ received: true });
          break;

        case 'ARGUS_INSIGHT':
          console.log(`[Argus] 💡 Insight card: "${message.event?.title}"`);
          showModal(message.event, 'insight_card', { popup: message.popup });
          sendResponse({ received: true });
          break;

        case 'ARGUS_UPDATE_CONFIRM':
          console.log(`[Argus] 📝 Update confirm: "${message.eventTitle}" (id: ${message.eventId})`);
          showModal(
            { id: message.eventId, title: message.eventTitle },
            'update_confirm',
            { description: message.description, changes: message.changes, popup: message.popup }
          );
          sendResponse({ received: true });
          break;

        case 'ARGUS_FORM_MISMATCH':
          console.log(`[Argus] ⚠️ Form mismatch from server: entered="${message.entered}", remembered="${message.remembered}"`);
          showModal(
            {
              id: 'form-mismatch-' + Date.now(),
              title: message.entered + ' → should be ' + message.remembered,
              description: message.suggestion,
              event_type: 'form_check',
            },
            'form_mismatch',
            {
              remembered: message.remembered,
              entered: message.entered,
              suggestion: message.suggestion,
            }
          );
          sendResponse({ received: true });
          break;

        case 'ARGUS_ACTION_TOAST':
          console.log(`[Argus] 🎯 Action toast: "${message.action}" on "${message.eventTitle}"`);
          const actionEmoji = message.action === 'cancel' || message.action === 'delete' ? '🗑️' :
            message.action === 'complete' ? '✅' :
              message.action === 'ignore' ? '🚫' :
                message.action === 'snooze' || message.action === 'postpone' ? '💤' :
                  message.action === 'modify' ? '📅' : '✓';
          showToast(actionEmoji + ' ' + message.action.charAt(0).toUpperCase() + message.action.slice(1), message.message || message.eventTitle);
          sendResponse({ received: true });
          break;

        default:
          console.log(`[Argus] ❓ Unknown message type: ${message.type}`);
          sendResponse({ received: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[Argus] Popup render error for', message.type + ':', err);
      // Show a minimal fallback toast so the user knows something happened
      try {
        const title = message.event?.title || message.eventTitle || 'Argus notification';
        showToast('Argus', title);
      } catch (_) { /* last resort — ignore */ }
      sendResponse({ received: false, error: 'Render error' });
    }

    return true;
  });

  console.log('[Argus] Content Script v2.6.5 loaded — insurance form mismatch detection');
})();
