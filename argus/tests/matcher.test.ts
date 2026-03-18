import { describe, it, expect } from 'vitest';

// URL context extraction logic (inline for testing)
const URL_PATTERNS: Array<{ pattern: RegExp; activity: string }> = [
  { pattern: /makemytrip\.com.*\/(flights?|hotels?)/i, activity: 'travel_booking' },
  { pattern: /amazon\.(com|in)/i, activity: 'shopping' },
  { pattern: /netflix\.com/i, activity: 'streaming' },
  { pattern: /flipkart\.com/i, activity: 'shopping' },
];

function extractContextFromUrl(url: string): { activity: string; keywords: string[] } {
  for (const { pattern, activity } of URL_PATTERNS) {
    if (pattern.test(url)) {
      const urlObj = new URL(url);
      const pathKeywords = urlObj.pathname
        .split(/[\/\-_?&=]+/)
        .filter(s => s.length > 2 && !/^\d+$/.test(s))
        .map(s => decodeURIComponent(s).toLowerCase());
      return { activity, keywords: pathKeywords };
    }
  }
  return { activity: 'browsing', keywords: [] };
}

describe('URL Context Extraction', () => {
  it('should detect travel booking sites', () => {
    const result = extractContextFromUrl('https://www.makemytrip.com/flights/goa-mumbai');
    expect(result.activity).toBe('travel_booking');
    expect(result.keywords).toContain('goa');
  });

  it('should detect shopping sites', () => {
    const result = extractContextFromUrl('https://www.amazon.in/dp/B08XYZ123');
    expect(result.activity).toBe('shopping');
  });

  it('should detect streaming sites', () => {
    const result = extractContextFromUrl('https://www.netflix.com/browse');
    expect(result.activity).toBe('streaming');
  });

  it('should extract keywords from URL path', () => {
    const result = extractContextFromUrl('https://www.makemytrip.com/hotels/goa-beach-resorts');
    expect(result.keywords).toContain('goa');
    expect(result.keywords).toContain('beach');
    expect(result.keywords).toContain('resorts');
  });

  it('should handle unknown URLs', () => {
    const result = extractContextFromUrl('https://example.com/some/path');
    expect(result.activity).toBe('browsing');
  });
});

describe('Keyword Matching', () => {
  it('should match exact keywords', () => {
    const eventKeywords = 'goa,travel,beach,hotel';
    const searchKeywords = ['goa', 'travel'];
    
    const matches = searchKeywords.filter(kw => 
      eventKeywords.toLowerCase().includes(kw.toLowerCase())
    );
    
    expect(matches.length).toBe(2);
  });

  it('should handle partial matches', () => {
    const eventKeywords = 'goa,cashew,shop,zantye';
    const searchKeywords = ['goa', 'flight'];
    
    const matches = searchKeywords.filter(kw => 
      eventKeywords.toLowerCase().includes(kw.toLowerCase())
    );
    
    expect(matches).toContain('goa');
    expect(matches).not.toContain('flight');
  });
});

describe('Event Filtering', () => {
  const mockEvents = [
    { id: 1, title: 'Goa trip', location: 'Goa', keywords: 'goa,travel,beach', status: 'pending' },
    { id: 2, title: 'Office meeting', location: 'Office', keywords: 'meeting,work', status: 'pending' },
    { id: 3, title: 'Buy cashews', location: 'Goa', keywords: 'goa,cashew,shopping', status: 'pending' },
    { id: 4, title: 'Old event', location: 'Mumbai', keywords: 'old', status: 'completed' },
  ];

  it('should filter by location', () => {
    const goaEvents = mockEvents.filter(e => 
      e.location?.toLowerCase().includes('goa') && e.status === 'pending'
    );
    expect(goaEvents.length).toBe(2);
  });

  it('should filter by keywords', () => {
    const travelEvents = mockEvents.filter(e => 
      e.keywords.includes('travel') && e.status === 'pending'
    );
    expect(travelEvents.length).toBe(1);
    expect(travelEvents[0].title).toBe('Goa trip');
  });

  it('should exclude completed events', () => {
    const pendingEvents = mockEvents.filter(e => e.status === 'pending');
    expect(pendingEvents.length).toBe(3);
  });
});
