import { z } from 'zod';

// ============ Message Schemas ============
export const MessageSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  sender: z.string(),
  content: z.string(),
  timestamp: z.number(),
  created_at: z.number().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

// ============ Event Schemas ============
export const EventTypeEnum = z.enum(['meeting', 'deadline', 'reminder', 'travel', 'task', 'subscription', 'recommendation', 'other']);
export type EventType = z.infer<typeof EventTypeEnum>;

// Event Status Flow:
// - discovered: New event found, waiting for user to approve/set reminder
// - scheduled: User approved, reminder is scheduled
// - reminded: 1-hour reminder was sent
// - completed: User marked as done
// - dismissed: User dismissed (for context events, can reappear)
// - expired: Event time has passed
export const EventStatusEnum = z.enum(['discovered', 'scheduled', 'snoozed', 'ignored', 'reminded', 'completed', 'dismissed', 'expired', 'pending']);
export type EventStatus = z.infer<typeof EventStatusEnum>;

export const EventSchema = z.object({
  id: z.number().optional(),
  message_id: z.string().nullable(),
  event_type: EventTypeEnum,
  title: z.string(),
  description: z.string().nullable(),
  event_time: z.number().nullable(),
  location: z.string().nullable(),
  participants: z.string().nullable(), // JSON array
  keywords: z.string(), // comma-separated
  confidence: z.number().min(0).max(1),
  status: EventStatusEnum.default('discovered'),
  reminder_time: z.number().nullable().optional(), // Unix timestamp for when to remind
  context_url: z.string().nullable().optional(), // URL pattern that triggers this event (e.g., netflix.com)
  dismiss_count: z.number().default(0).optional(), // How many times dismissed (for persistent reminders)
  sender_name: z.string().nullable().optional(), // Who sent the original message (e.g., "Rahul")
  created_at: z.number().optional(),
});
export type Event = z.infer<typeof EventSchema>;

// ============ Trigger Schemas ============
export const TriggerTypeEnum = z.enum(['time', 'time_24h', 'time_1h', 'time_15m', 'url', 'keyword', 'reminder_24h', 'reminder_1hr', 'reminder_15m']);
export type TriggerType = z.infer<typeof TriggerTypeEnum>;

export const TriggerSchema = z.object({
  id: z.number().optional(),
  event_id: z.number(),
  trigger_type: TriggerTypeEnum,
  trigger_value: z.string(),
  is_fired: z.boolean().default(false),
  fire_count: z.number().default(0).optional(), // For URL triggers that can fire multiple times
  created_at: z.number().optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

// ============ Popup Types ============
// Used by extension to determine modal appearance and behavior
export const PopupTypeEnum = z.enum([
  'event_discovery',    // New event found - "Set reminder?"
  'event_reminder',     // 1hr before event - "Event coming up!"
  'context_reminder',   // URL-based trigger (Netflix) - persistent until done
  'conflict_warning',   // Calendar conflict detected
  'insight_card',       // Recommendation/suggestion
  'snooze_reminder',    // Snoozed event fires again
  'update_confirm',     // Message suggests event changes - needs confirmation
  'form_mismatch',      // DOM form field contradicts WhatsApp memory
]);
export type PopupType = z.infer<typeof PopupTypeEnum>;

// ============ Contact Schemas ============
export const ContactSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  first_seen: z.number(),
  last_seen: z.number(),
  message_count: z.number().default(0),
});
export type Contact = z.infer<typeof ContactSchema>;

// ============ Webhook Schemas ============
export const WhatsAppWebhookSchema = z.object({
  event: z.string(),
  instance: z.string(),
  data: z.object({
    key: z.object({
      remoteJid: z.string(),
      fromMe: z.boolean(),
      id: z.string(),
    }),
    pushName: z.string().optional(),
    message: z.object({
      conversation: z.string().optional(),
      extendedTextMessage: z.object({
        text: z.string(),
      }).optional(),
    }).optional(),
    messageTimestamp: z.union([z.string(), z.number()]),
  }),
});
export type WhatsAppWebhook = z.infer<typeof WhatsAppWebhookSchema>;

// ============ Context Check Schemas ============
export const ContextCheckRequestSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});
export type ContextCheckRequest = z.infer<typeof ContextCheckRequestSchema>;

export const ContextCheckResponseSchema = z.object({
  matched: z.boolean(),
  events: z.array(EventSchema),
  confidence: z.number(),
});
export type ContextCheckResponse = z.infer<typeof ContextCheckResponseSchema>;

// ============ LLM Extraction Schemas ============
export const LLMExtractionSchema = z.object({
  events: z.array(z.object({
    type: EventTypeEnum,
    title: z.string(),
    description: z.string().nullable(),
    event_time: z.string().nullable(),
    location: z.string().nullable(),
    participants: z.array(z.string()),
    keywords: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    event_action: z.enum(['create', 'update', 'merge']).nullable().optional(),
    target_event_id: z.number().nullable().optional(),
  })),
});
export type LLMExtraction = z.infer<typeof LLMExtractionSchema>;

export const LLMValidationSchema = z.object({
  relevant: z.array(z.number()),
  confidence: z.number().min(0).max(1),
});
export type LLMValidation = z.infer<typeof LLMValidationSchema>;

// ============ Config Schema ============
export const ConfigSchema = z.object({
  port: z.number().default(3000),
  // DigitalOcean Gradient
  doGradientModelKey: z.string().optional(),
  adkAgentUrl: z.string().optional(),
  internalApiSecret: z.string().optional(),
  sqlitePath: z.string().default('./data/argus.db'),
  dbPath: z.string().default('./data/events.db'),
  evolutionApiUrl: z.string().optional(),
  evolutionApiKey: z.string().optional(),
  evolutionInstanceName: z.string().optional(),
  evolutionPg: z.object({
    host: z.string(),
    port: z.number(),
    database: z.string(),
    user: z.string(),
    password: z.string(),
    schema: z.string().optional(),
  }).optional(),
  processOwnMessages: z.boolean().default(true),
  skipGroupMessages: z.boolean().default(false),
  hotWindowDays: z.number().default(90),
  // AI Fallback Tier config
  aiTierMode: z.enum(['auto', 'tier1_only', 'tier2_only', 'tier3_only']).default('auto'),
  aiCooldownBaseSec: z.number().default(30),
  aiCacheTtlSec: z.number().default(3600),
  aiCacheMaxSize: z.number().default(500),
  backupRetentionDays: z.number().default(7),
});
export type Config = z.infer<typeof ConfigSchema>;

// ============ Helper Functions ============
export function parseConfig(): Config {
  const evolutionPg = process.env.EVOLUTION_PG_HOST ? {
    host: process.env.EVOLUTION_PG_HOST,
    port: parseInt(process.env.EVOLUTION_PG_PORT || '5432'),
    database: process.env.EVOLUTION_PG_DATABASE || 'evolution',
    user: process.env.EVOLUTION_PG_USER || 'postgres',
    password: process.env.EVOLUTION_PG_PASSWORD || 'postgres',
    schema: process.env.EVOLUTION_PG_SCHEMA || 'evolution_api',
  } : undefined;

  return ConfigSchema.parse({
    port: parseInt(process.env.PORT || '3000'),
    doGradientModelKey: process.env.DO_GRADIENT_MODEL_KEY,
    adkAgentUrl: process.env.ADK_AGENT_URL,
    internalApiSecret: process.env.INTERNAL_API_SECRET,
    sqlitePath: process.env.SQLITE_PATH || './data/argus.db',
    dbPath: process.env.DATABASE_PATH || './data/events.db',
    evolutionApiUrl: process.env.EVOLUTION_API_URL,
    evolutionApiKey: process.env.EVOLUTION_API_KEY,
    evolutionInstanceName: process.env.EVOLUTION_INSTANCE_NAME,
    evolutionPg,
    processOwnMessages: process.env.PROCESS_OWN_MESSAGES !== 'false',
    skipGroupMessages: process.env.SKIP_GROUP_MESSAGES === 'true',
    hotWindowDays: parseInt(process.env.HOT_WINDOW_DAYS || '90'),
    aiTierMode: (process.env.AI_TIER_MODE as any) || 'auto',
    aiCooldownBaseSec: parseInt(process.env.AI_COOLDOWN_BASE_SEC || '30'),
    aiCacheTtlSec: parseInt(process.env.AI_CACHE_TTL_SEC || '3600'),
    aiCacheMaxSize: parseInt(process.env.AI_CACHE_MAX_SIZE || '500'),
    backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '7'),
  });
}
