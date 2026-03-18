**Argus** - An AI-powered **proactive memory assistant** that extracts events and reminders from WhatsApp messages and triggers them based on your browsing context.

DO NOT USE : OPEN AI : ONLY GOOGLE SDK AND OPENAI COMPATIBLE GEMINI POINTS 



https://github.com/ktg-one/quicksave/tree/main
Quicksave (Ex-CEP) is designed to compress complex, multi-domain conversations into machine-optimized "Carry-Packets." These packets achieve a crystallization point of 0.15 entity/token, ensuring that a receiving model can reconstruct the original context with near-perfect fidelity.

IT SHOULD USE GEMINI 3 PREVIEW and not 2.5
IT should able to handle 50k msgs for now 

GOAL MAKE IT AS SIMPLE AS POSSIBLE FOREVER 
AVOID VECTOR, EMBEDDING AND ALL : TRY TO USE NOSQL FOR MOST 

AVOID FAISS

EVERY CONTEXT CHECK:

1. SQLite Query (top-10 candidates)
2. Gemini Validation 10 candidates, not 100
   Input: Query + 10 messages
   Average: 5,000 tokens
3. Total per context check:
   Cost: $0.000375
    Time: ~805ms
    User sees: FAST

AVOID RAG


**WhatsApp-first ingestion** via Evolution API webhooks

- **Gemini Flash** for single-call extraction

- **3-Month hot window** with daily archive job

**Chrome URL detection** for proactive triggers (no DOM read for MVP)


### Core Application (Argus Service)

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Runtime | Node.js | 22.x | JavaScript runtime |
| Language | TypeScript | 5.8.x | Type-safe JavaScript |
| Web Framework | Express.js | 5.x | HTTP server & routing |
| Database | SQLite | better-sqlite3 12.x | Event & message storage |
| Vector Store | FAISS | faiss-node | Semantic similarity search |
| Schema Validation | Zod | 3.24.x | Runtime type validation |
| Logging | Winston | 3.x | Structured logging |
| WebSocket | ws | 8.x | Real-time communication |


| Component | Technology | Purpose |
|-----------|------------|---------|
| Manifest | V3 | Chrome extension standard |
| Background | Service Worker | Site detection, API calls |
| Content Script | Injected JS | Overlay cards, page context |
| Popup | HTML/JS | Quick status view |
| Storage | chrome.storage | Settings sync |




| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Primary LLM | Gemini 3 Flash Preview | Current | High-speed, cost-efficient extraction |
| Fallback Provider | OpenAI API | SDK 4.96.x | Embeddings fallback |
| Embedding Model | text-embedding-3-small | Latest | Vector embeddings |


### WhatsApp Integration (Evolution API)

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| WhatsApp API | Evolution API | v2.1.1 | WhatsApp Web bridge |
| Protocol Library | Baileys | Built-in | WhatsApp Web protocol |
| Database | PostgreSQL | 16-alpine | Evolution API storage |




Eample events ROUGH : 

1. The "Goa Cashew" Scenario (Travel & Social)

* The History:  Months ago, in a messy WhatsApp group chat, a friend (Rahul) recommended a specific shop in Goa for cashews.
* The Trigger: You are browsing a flight booking site or a Goa travel blog.
* Argus Action:  It interrupts with a card: "Rahul recommended the cashews at 'Zantye’s' in Goa. Want me to pin the location to your maps?"

 2. The "Insurance Accuracy" Scenario (Financial Intelligence)

* The History: You mentioned in a chat four months ago that you own a 2018 Honda Civic.
* The Trigger: You are on an insurance portal filling out a quote, and the site auto-fills "2022 Honda" by default.
* Argus Action:  It highlights the field: "I remember you have a 2018 model. This quote is for a 2022 model, which will cost you more. Click here to correct it."

 3. The "Gift Intent" Scenario (E-commerce)

* The History: A family member mentioned a specific brand of sneakers they liked during a random conversation weeks ago.
* The Trigger:  You land on a shopping site like Amazon or Myntra during a sale.
* Argus Action:  It displays an  Insight Card : "Your sister mentioned she loved these sneakers. They are 30% off right now. Perfect for her birthday next month?"

4. The "Netflix Subscription" Scenario (Budgeting)

* The History:  You wrote a note or sent an email saying, "I need to cancel Netflix after this show ends."
* The Trigger:  You open your banking app or land on the Netflix landing page.
* Argus Action:  A  Priority Alert : "You planned to cancel this subscription. Should I help you navigate to the cancellation page now?"

5. The "Calendar Conflict" Scenario (Scheduling)

* The History:  You made an informal commitment to a dinner plan in a group chat, but never added it to your calendar.
* The Trigger: You are currently typing an email to schedule a business meeting for that same Thursday night.
* Argus Action:  A Conflict Warning: "You told the 'Dinner Group' you’d meet them this Thursday. This meeting will conflict. Suggest Friday instead?"


IGNORE : EMAIL , and website : IT IS WHATSAPP PROACTIVE , and URL CHROME BASED

