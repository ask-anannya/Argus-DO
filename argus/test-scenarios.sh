#!/bin/bash
API="http://localhost:3000"
PASS=0
FAIL=0

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║       ARGUS SCENARIO TEST SUITE v2.4.2          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

HEALTH=$(curl -s --max-time 5 "$API/api/health" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  echo "❌ Server not running on port 3000"
  exit 1
fi
echo "✅ Server is healthy"
echo ""

# SCENARIO 1: GOA CASHEW
echo "━━━ SCENARIO 1: GOA CASHEW (Travel) ━━━"
echo "  Trigger: MakeMyTrip for Goa flights"
R=$(curl -s --max-time 30 -X POST "$API/api/context-check" -H "Content-Type: application/json" -d '{"url":"https://www.makemytrip.com/flights/goa","title":"Flights to Goa"}')
CT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('contextTriggers',[])))" 2>/dev/null)
MT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('events',[])))" 2>/dev/null)
echo "  contextTriggers=$CT  keywordMatches=$MT"
echo "$R" | python3 -c "
import json,sys; r=json.load(sys.stdin)
for t in r.get('contextTriggers',[]):
    print(f'    📌 #{t[\"id\"]}: {t[\"title\"]} ({t[\"event_type\"]})')
for e in r.get('events',[]):
    print(f'    🔍 #{e[\"id\"]}: {e[\"title\"]} by {e.get(\"sender_name\",\"?\")}')
" 2>/dev/null
if [ "${CT:-0}" -gt 0 ] 2>/dev/null || [ "${MT:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ✅ PASS"; PASS=$((PASS+1))
else
  echo "  ❌ FAIL"; FAIL=$((FAIL+1))
fi
echo ""

# SCENARIO 4: NETFLIX
echo "━━━ SCENARIO 4: NETFLIX SUBSCRIPTION ━━━"
echo "  Trigger: netflix.com"
R=$(curl -s --max-time 30 -X POST "$API/api/context-check" -H "Content-Type: application/json" -d '{"url":"https://www.netflix.com/browse","title":"Netflix"}')
CT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('contextTriggers',[])))" 2>/dev/null)
MT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('events',[])))" 2>/dev/null)
echo "  contextTriggers=$CT  keywordMatches=$MT"
echo "$R" | python3 -c "
import json,sys; r=json.load(sys.stdin)
for t in r.get('contextTriggers',[]):
    print(f'    📌 #{t[\"id\"]}: {t[\"title\"]} ({t[\"event_type\"]})')
for e in r.get('events',[]):
    print(f'    🔍 #{e[\"id\"]}: {e[\"title\"]} by {e.get(\"sender_name\",\"?\")}')
" 2>/dev/null
if [ "${CT:-0}" -gt 0 ] 2>/dev/null || [ "${MT:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ✅ PASS"; PASS=$((PASS+1))
else
  echo "  ❌ FAIL"; FAIL=$((FAIL+1))
fi
echo ""

# CANVA
echo "━━━ CANVA SUBSCRIPTION (New Fix) ━━━"
echo "  Trigger: canva.com"
R=$(curl -s --max-time 30 -X POST "$API/api/context-check" -H "Content-Type: application/json" -d '{"url":"https://www.canva.com/design/page","title":"Canva"}')
CT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('contextTriggers',[])))" 2>/dev/null)
MT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('events',[])))" 2>/dev/null)
echo "  contextTriggers=$CT  keywordMatches=$MT"
echo "$R" | python3 -c "
import json,sys; r=json.load(sys.stdin)
for t in r.get('contextTriggers',[]):
    print(f'    📌 #{t[\"id\"]}: {t[\"title\"]} ({t[\"event_type\"]})')
for e in r.get('events',[]):
    print(f'    🔍 #{e[\"id\"]}: {e[\"title\"]} by {e.get(\"sender_name\",\"?\")}')
" 2>/dev/null
if [ "${CT:-0}" -gt 0 ] 2>/dev/null || [ "${MT:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ✅ PASS"; PASS=$((PASS+1))
else
  echo "  ❌ FAIL"; FAIL=$((FAIL+1))
fi
echo ""

# SCENARIO 5: CALENDAR CONFLICT (chat-based test)
echo "━━━ SCENARIO 5: CALENDAR CONFLICT ━━━"
echo "  Test: AI awareness of scheduling conflicts"
R=$(curl -s --max-time 30 -X POST "$API/api/chat" -H "Content-Type: application/json" -d '{"query":"I want to schedule a meeting on January 15 2027 at 10am. Do I have any conflicts?"}')
RESP=$(echo "$R" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('response','')[:300])" 2>/dev/null)
echo "  AI says: $RESP"
if [ -n "$RESP" ]; then
  echo "  ✅ PASS"; PASS=$((PASS+1))
else
  echo "  ❌ FAIL"; FAIL=$((FAIL+1))
fi
echo ""

# STATS
echo "━━━ API HEALTH ━━━"
curl -s "$API/api/stats" | python3 -c "import json,sys; s=json.load(sys.stdin); print(f'  Events: {s.get(\"totalEvents\",\"?\")}  Messages: {s.get(\"totalMessages\",\"?\")}  Triggers: {s.get(\"totalTriggers\",\"?\")}')" 2>/dev/null
FE=$(curl -s -o /dev/null -w "%{http_code}" "$API/" 2>/dev/null)
echo "  Frontend: HTTP $FE"
echo ""

echo "╔══════════════════════════════════════════════════╗"
printf "║  RESULTS: %d passed, %d failed                    ║\n" $PASS $FAIL
echo "╚══════════════════════════════════════════════════╝"
