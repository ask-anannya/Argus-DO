// ============ Backup Engine ============
// Handles export/import of all Argus data from SQLite.

import * as fs from 'fs';
import * as path from 'path';
import { exportAllData as dbExportAll, importData as dbImportData } from './db.js';

// ============ Types ============

export interface BackupPayload {
  version: string;
  exportedAt: string;
  source: string;
  counts: {
    events: number;
    messages: number;
    triggers: number;
    contacts: number;
    contextDismissals: number;
    pushSubscriptions: number;
  };
  indices: {
    events: Record<string, any>[];
    messages: Record<string, any>[];
    triggers: Record<string, any>[];
    contacts: Record<string, any>[];
    contextDismissals: Record<string, any>[];
    pushSubscriptions: Record<string, any>[];
  };
}

export interface ImportOptions {
  mode: 'merge' | 'replace';
  indices?: string[];
}

export interface ImportResult {
  created: number;
  updated: number;
  failed: number;
  counts: Record<string, number>;
}

export interface BackupInfo {
  filename: string;
  date: string;
  sizeBytes: number;
  counts: Record<string, number>;
}

const BACKUP_VERSION = '1.0';
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

export async function exportAllData(): Promise<BackupPayload> {
  console.log('[Backup] Starting export...');
  const data = dbExportAll();

  const counts = {
    events: data.events.length,
    messages: data.messages.length,
    triggers: data.triggers.length,
    contacts: data.contacts.length,
    contextDismissals: data.dismissals.length,
    pushSubscriptions: data.subscriptions.length,
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[Backup] Export complete: ${total} docs — ${JSON.stringify(counts)}`);

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: 'argus-sqlite',
    counts,
    indices: {
      events: data.events,
      messages: data.messages,
      triggers: data.triggers,
      contacts: data.contacts,
      contextDismissals: data.dismissals,
      pushSubscriptions: data.subscriptions,
    },
  };
}

export async function importFromBackup(
  payload: BackupPayload,
  options: ImportOptions
): Promise<ImportResult> {
  if (!payload.indices || typeof payload.indices !== 'object') {
    throw new Error('Invalid backup: missing or malformed "indices" field');
  }

  const result: ImportResult = { created: 0, updated: 0, failed: 0, counts: {} };

  const data = {
    events:        payload.indices.events        || [],
    messages:      payload.indices.messages       || [],
    triggers:      payload.indices.triggers       || [],
    contacts:      payload.indices.contacts       || [],
    dismissals:    payload.indices.contextDismissals || [],
    subscriptions: payload.indices.pushSubscriptions || [],
  };

  dbImportData(data, options.mode);

  result.counts = {
    events:             data.events.length,
    messages:           data.messages.length,
    triggers:           data.triggers.length,
    contacts:           data.contacts.length,
    contextDismissals:  data.dismissals.length,
    pushSubscriptions:  data.subscriptions.length,
  };
  result.created = Object.values(result.counts).reduce((a, b) => a + b, 0);

  console.log('[Backup] Import complete:', JSON.stringify(result.counts));
  return result;
}

export async function runDailyBackup(): Promise<string> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `argus-backup-${dateStr}.json`;
  const filePath = path.join(BACKUP_DIR, filename);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const payload = await exportAllData();
  const json = JSON.stringify(payload);
  fs.writeFileSync(filePath, json, 'utf-8');

  const sizeKb = Math.round(json.length / 1024);
  console.log(`[Backup] Daily backup saved: ${filename} (${sizeKb} KB)`);

  return filePath;
}

export async function pruneOldBackups(keepLast = 7): Promise<number> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return 0;

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^argus-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();

    const toDelete = files.slice(keepLast);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`[Backup] Pruned: ${f}`);
    }

    return toDelete.length;
  } catch (err) {
    console.warn('[Backup] pruneOldBackups error:', (err as Error).message);
    return 0;
  }
}

export async function getBackupList(): Promise<BackupInfo[]> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^argus-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();

    return files.map(filename => {
      const filePath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(filePath);

      const buf = Buffer.alloc(400);
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, 400, 0);
      fs.closeSync(fd);
      const header = buf.slice(0, bytesRead).toString('utf-8');

      let counts: Record<string, number> = {};
      const countsMatch = header.match(/"counts"\s*:\s*(\{[^}]+\})/);
      if (countsMatch) {
        try { counts = JSON.parse(countsMatch[1]); } catch { /* ignore */ }
      }

      const dateMatch = filename.match(/argus-backup-(\d{4}-\d{2}-\d{2})\.json/);

      return {
        filename,
        date: dateMatch ? dateMatch[1] : '',
        sizeBytes: stat.size,
        counts,
      };
    });
  } catch (err) {
    console.warn('[Backup] getBackupList error:', (err as Error).message);
    return [];
  }
}
