/**
 * Evolution API PostgreSQL Proxy
 * Access WhatsApp messages with full metadata (names, phones, timestamps)
 */

import pg from 'pg';
const { Pool } = pg;

interface EvolutionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema?: string;
}

interface EvolutionContact {
  id: string;
  remoteJid: string;
  pushName: string | null;
  profilePicUrl: string | null;
}

interface MessageWithContact {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  pushName: string | null;
  phoneNumber: string;
  content: string | null;
  messageType: string;
  timestamp: Date;
  status: string;
  isGroup: boolean;
}

let pool: pg.Pool | null = null;
let cachedInstanceId: string | null = null;
let tablesVerified = false;
let tablesExist = false;

export function initEvolutionDb(config: EvolutionConfig): void {
  const schema = config.schema || 'evolution_api';
  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Set search_path and cap slow queries at 10s to prevent server stalls
    options: `-c search_path=${schema},public -c statement_timeout=10000`,
  });

  pool.on('error', (err) => {
    console.error('Evolution DB pool error:', err);
  });

  console.log(`✅ Evolution PostgreSQL pool initialized (schema: ${schema})`);
}

/**
 * One-time check: do the Evolution tables exist?
 * If not, log a single warning and skip all future queries.
 */
async function ensureTablesExist(): Promise<boolean> {
  if (tablesVerified) return tablesExist;
  if (!pool) return false;

  try {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('Instance', 'Message', 'Chat', 'Contact')
    `);
    const found = result.rows.map((r: { table_name: string }) => r.table_name);
    tablesExist = found.length >= 2;
    tablesVerified = true;

    if (!tablesExist) {
      console.warn(
        `⚠️ Evolution DB tables not found (found: [${found.join(', ')}]). ` +
        `Evolution API may not have run its migrations yet. ` +
        `Skipping direct PG reads — webhook ingestion still works.`
      );
    } else {
      console.log(`✅ Evolution DB tables verified: ${found.join(', ')}`);
    }
    return tablesExist;
  } catch (err) {
    tablesVerified = true;
    tablesExist = false;
    console.warn('⚠️ Could not verify Evolution DB tables — skipping direct PG reads');
    return false;
  }
}

/**
 * Get instance ID by name (cached)
 */
export async function getInstanceIdByName(instanceName: string): Promise<string | null> {
  if (cachedInstanceId) return cachedInstanceId;
  if (!pool) return null;
  if (!(await ensureTablesExist())) return null;
  
  try {
    const result = await pool.query(
      `SELECT id FROM "Instance" WHERE name = $1 LIMIT 1`,
      [instanceName]
    );
    if (result.rows.length > 0) {
      cachedInstanceId = result.rows[0].id;
      return cachedInstanceId;
    }
    return null;
  } catch (err) {
    console.error('Failed to get instance ID:', err);
    return null;
  }
}

export async function testEvolutionConnection(): Promise<boolean> {
  if (!pool) return false;
  try {
    const result = await pool.query('SELECT 1');
    return result.rows.length > 0;
  } catch (err) {
    console.error('Evolution DB connection test failed:', err);
    return false;
  }
}

export async function getEvolutionInstances(): Promise<{ id: string; name: string; status: string; ownerJid: string }[]> {
  if (!pool) return [];
  if (!(await ensureTablesExist())) return [];
  try {
    const result = await pool.query(`
      SELECT id, name, "connectionStatus" as status, "ownerJid"
      FROM "Instance"
      WHERE "connectionStatus" = 'open'
      ORDER BY "updatedAt" DESC
    `);
    return result.rows;
  } catch (err) {
    console.error('Failed to get instances:', err);
    return [];
  }
}

/**
 * Get messages from Evolution API's PostgreSQL
 * Note: key and message are JSONB columns
 */
export async function getEvolutionMessages(options: {
  instanceId?: string;
  limit?: number;
  offset?: number;
  fromMe?: boolean | null;
  isGroup?: boolean | null;
  search?: string;
}): Promise<MessageWithContact[]> {
  if (!pool) return [];
  if (!(await ensureTablesExist())) return [];

  const { limit = 50, offset = 0, fromMe, isGroup, search, instanceId } = options;

  try {
    let query = `
      SELECT 
        m.id,
        m.key->>'remoteJid' as "remoteJid",
        (m.key->>'fromMe')::boolean as "fromMe",
        m."pushName",
        m.message,
        m."messageType",
        m."messageTimestamp" as timestamp,
        m.status,
        m.key->>'participant' as participant,
        m."instanceId"
      FROM "Message" m
      WHERE 1=1
    `;
    const params: (string | number | boolean)[] = [];
    let paramIndex = 1;

    if (instanceId) {
      query += ` AND m."instanceId" = $${paramIndex++}`;
      params.push(instanceId);
    }

    if (fromMe !== null && fromMe !== undefined) {
      query += ` AND (m.key->>'fromMe')::boolean = $${paramIndex++}`;
      params.push(fromMe);
    }

    if (isGroup === true) {
      query += ` AND m.key->>'remoteJid' LIKE '%@g.us'`;
    } else if (isGroup === false) {
      query += ` AND m.key->>'remoteJid' LIKE '%@s.whatsapp.net'`;
    }

    if (search) {
      query += ` AND m.message::text ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY m."messageTimestamp" DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    return result.rows.map(row => ({
      id: row.id,
      remoteJid: row.remoteJid,
      fromMe: row.fromMe,
      pushName: row.pushName,
      phoneNumber: extractPhoneNumber(row.remoteJid),
      content: parseMessageContent(row.message),
      messageType: row.messageType,
      timestamp: new Date(row.timestamp * 1000),
      status: row.status,
      isGroup: row.remoteJid?.includes('@g.us') || false,
    }));
  } catch (err) {
    console.error('Failed to get Evolution messages:', err);
    return [];
  }
}

/**
 * Get message count from Evolution
 */
export async function getEvolutionMessageCount(instanceId?: string): Promise<number> {
  if (!pool) return 0;
  if (!(await ensureTablesExist())) return 0;
  try {
    let query = 'SELECT COUNT(*) as count FROM "Message"';
    const params: string[] = [];
    
    if (instanceId) {
      query += ' WHERE "instanceId" = $1';
      params.push(instanceId);
    }
    
    const result = await pool.query(query, params);
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('Failed to get message count:', err);
    return 0;
  }
}

/**
 * Get contacts from Evolution
 */
export async function getEvolutionContacts(instanceId?: string, limit = 100): Promise<EvolutionContact[]> {
  if (!pool) return [];
  if (!(await ensureTablesExist())) return [];
  try {
    let query = `
      SELECT id, "remoteJid", "pushName", "profilePicUrl"
      FROM "Contact"
    `;
    const params: (string | number)[] = [];
    
    if (instanceId) {
      query += ' WHERE "instanceId" = $1';
      params.push(instanceId);
    }
    
    query += ` ORDER BY "updatedAt" DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error('Failed to get contacts:', err);
    return [];
  }
}

/**
 * Get chats from Evolution
 */
export async function getEvolutionChats(instanceId?: string, limit = 50): Promise<{
  id: string;
  remoteJid: string;
  name: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
}[]> {
  if (!pool) return [];
  if (!(await ensureTablesExist())) return [];
  try {
    let query = `
      SELECT 
        c.id,
        c."remoteJid",
        c.name,
        c."unreadMessages" as "unreadCount",
        c."updatedAt" as "lastMessageAt"
      FROM "Chat" c
    `;
    const params: (string | number)[] = [];
    
    if (instanceId) {
      query += ' WHERE c."instanceId" = $1';
      params.push(instanceId);
    }
    
    query += ` ORDER BY c."updatedAt" DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error('Failed to get chats:', err);
    return [];
  }
}

/**
 * Search messages in Evolution DB
 */
export async function searchEvolutionMessages(query: string, limit = 20): Promise<MessageWithContact[]> {
  if (!pool) return [];
  if (!(await ensureTablesExist())) return [];
  try {
    const result = await pool.query(`
      SELECT 
        m.id,
        m.key->>'remoteJid' as "remoteJid",
        (m.key->>'fromMe')::boolean as "fromMe",
        m."pushName",
        m.message,
        m."messageType",
        m."messageTimestamp" as timestamp,
        m.status
      FROM "Message" m
      WHERE m.message::text ILIKE $1
      ORDER BY m."messageTimestamp" DESC
      LIMIT $2
    `, [`%${query}%`, limit]);

    return result.rows.map(row => ({
      id: row.id,
      remoteJid: row.remoteJid,
      fromMe: row.fromMe,
      pushName: row.pushName,
      phoneNumber: extractPhoneNumber(row.remoteJid),
      content: parseMessageContent(row.message),
      messageType: row.messageType,
      timestamp: new Date(row.timestamp * 1000),
      status: row.status,
      isGroup: row.remoteJid?.includes('@g.us') || false,
    }));
  } catch (err) {
    console.error('Failed to search messages:', err);
    return [];
  }
}

/**
 * Get Evolution stats
 */
export async function getEvolutionStats(instanceId?: string): Promise<{
  totalMessages: number;
  sentMessages: number;
  receivedMessages: number;
  contacts: number;
  chats: number;
}> {
  if (!pool) return { totalMessages: 0, sentMessages: 0, receivedMessages: 0, contacts: 0, chats: 0 };
  if (!(await ensureTablesExist())) return { totalMessages: 0, sentMessages: 0, receivedMessages: 0, contacts: 0, chats: 0 };

  try {
    const whereClause = instanceId ? `WHERE "instanceId" = $1` : '';
    const params = instanceId ? [instanceId] : [];

    const [totalResult, sentResult, receivedResult, contactsResult, chatsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count FROM "Message" ${whereClause}`, params),
      pool.query(`SELECT COUNT(*) as count FROM "Message" ${whereClause} ${instanceId ? 'AND' : 'WHERE'} (key->>'fromMe')::boolean = true`, params),
      pool.query(`SELECT COUNT(*) as count FROM "Message" ${whereClause} ${instanceId ? 'AND' : 'WHERE'} (key->>'fromMe')::boolean = false`, params),
      pool.query(`SELECT COUNT(*) as count FROM "Contact" ${whereClause}`, params),
      pool.query(`SELECT COUNT(*) as count FROM "Chat" ${whereClause}`, params),
    ]);

    return {
      totalMessages: parseInt(totalResult.rows[0].count),
      sentMessages: parseInt(sentResult.rows[0].count),
      receivedMessages: parseInt(receivedResult.rows[0].count),
      contacts: parseInt(contactsResult.rows[0].count),
      chats: parseInt(chatsResult.rows[0].count),
    };
  } catch (err) {
    console.error('Failed to get Evolution stats:', err);
    return { totalMessages: 0, sentMessages: 0, receivedMessages: 0, contacts: 0, chats: 0 };
  }
}

// Helpers
function extractPhoneNumber(jid: string | null): string {
  if (!jid) return 'unknown';
  return jid.split('@')[0];
}

function parseMessageContent(message: unknown): string | null {
  if (!message) return null;
  
  // pg automatically parses JSONB to object
  if (typeof message === 'object' && message !== null) {
    const msg = message as Record<string, unknown>;
    return (msg.conversation as string) || 
           ((msg.extendedTextMessage as Record<string, unknown>)?.text as string) || 
           ((msg.imageMessage as Record<string, unknown>)?.caption as string) ||
           ((msg.videoMessage as Record<string, unknown>)?.caption as string) ||
           ((msg.documentMessage as Record<string, unknown>)?.caption as string) ||
           '[Media]';
  }
  
  // Fallback for string (shouldn't happen with pg)
  if (typeof message === 'string') {
    try {
      const parsed = JSON.parse(message);
      return parsed.conversation || 
             parsed.extendedTextMessage?.text || 
             parsed.imageMessage?.caption ||
             parsed.videoMessage?.caption ||
             parsed.documentMessage?.caption ||
             '[Media]';
    } catch {
      return message;
    }
  }
  
  return null;
}

export async function closeEvolutionDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
