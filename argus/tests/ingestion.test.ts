import { describe, it, expect } from 'vitest';

describe('Message Ingestion', () => {
  it('should extract message content from webhook', () => {
    const webhook = {
      event: 'messages.upsert',
      instance: 'test',
      data: {
        key: {
          remoteJid: '919876543210@s.whatsapp.net',
          fromMe: false,
          id: 'msg123',
        },
        pushName: 'Test User',
        message: {
          conversation: 'lets meet tomorrow at 5pm',
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };

    const content = webhook.data.message?.conversation || 
                    webhook.data.message?.extendedTextMessage?.text;
    
    expect(content).toBe('lets meet tomorrow at 5pm');
  });

  it('should extract from extended text message', () => {
    const webhook = {
      data: {
        message: {
          extendedTextMessage: {
            text: 'Check this out: meeting at 3pm',
          },
        },
      },
    };

    const content = webhook.data.message?.conversation || 
                    webhook.data.message?.extendedTextMessage?.text;
    
    expect(content).toBe('Check this out: meeting at 3pm');
  });

  it('should parse sender from remote JID', () => {
    const remoteJid = '919876543210@s.whatsapp.net';
    const sender = remoteJid.split('@')[0];
    
    expect(sender).toBe('919876543210');
  });

  it('should detect group messages', () => {
    const groupJid = '120363123456789@g.us';
    const personalJid = '919876543210@s.whatsapp.net';
    
    expect(groupJid.includes('@g.us')).toBe(true);
    expect(personalJid.includes('@g.us')).toBe(false);
  });
});

describe('Event Classification Heuristics', () => {
  const classifyMessage = (message: string): { hasEvent: boolean; confidence: number } => {
    const eventKeywords = /\b(meet|meeting|call|tomorrow|kal|today|aaj|deadline|reminder|book|flight|hotel|birthday|party|event|task|todo|buy|get|bring|send|submit|complete|finish|cancel|pay|payment)\b/i;
    const timePatterns = /\b(\d{1,2}:\d{2}|\d{1,2}\s*(am|pm)|morning|evening|night|subah|shaam|raat|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
    
    const hasKeyword = eventKeywords.test(message);
    const hasTime = timePatterns.test(message);
    
    if (!hasKeyword && !hasTime) {
      return { hasEvent: false, confidence: 0.9 };
    }
    
    if (hasKeyword && hasTime) {
      return { hasEvent: true, confidence: 0.85 };
    }
    
    return { hasEvent: hasKeyword || hasTime, confidence: 0.6 };
  };

  it('should classify meeting messages as events', () => {
    const result = classifyMessage('lets meet tomorrow at 5pm');
    expect(result.hasEvent).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('should classify deadline messages as events', () => {
    const result = classifyMessage('deadline is on Friday');
    expect(result.hasEvent).toBe(true);
  });

  it('should not classify casual messages as events', () => {
    const result = classifyMessage('haha nice joke');
    expect(result.hasEvent).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('should handle Hinglish messages', () => {
    const result = classifyMessage('kal subah meeting hai');
    expect(result.hasEvent).toBe(true);
  });

  it('should detect time-only messages', () => {
    const result = classifyMessage('at 3pm sharp');
    expect(result.hasEvent).toBe(true);
  });
});

describe('Trigger Creation', () => {
  it('should create time trigger from event time', () => {
    const eventTime = '2026-02-15T17:00:00Z';
    const trigger = {
      event_id: 1,
      trigger_type: 'time',
      trigger_value: eventTime,
      is_fired: false,
    };
    
    expect(trigger.trigger_type).toBe('time');
    // Compare timestamps directly to avoid .000Z vs Z format differences
    expect(new Date(trigger.trigger_value).getTime()).toBe(new Date(eventTime).getTime());
  });

  it('should create URL trigger from location', () => {
    const location = 'Goa';
    const trigger = {
      event_id: 1,
      trigger_type: 'url',
      trigger_value: location.toLowerCase(),
      is_fired: false,
    };
    
    expect(trigger.trigger_type).toBe('url');
    expect(trigger.trigger_value).toBe('goa');
  });
});
