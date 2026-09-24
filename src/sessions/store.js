import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Tiny persisted JSON store for session metadata, so sessions can be
 * restored after a container restart (see Session for why this works:
 * each message is a fresh `claude --resume` process, keyed by on-disk
 * conversation history under CLAUDE_CONFIG_DIR — nothing lives only in
 * memory that resuming needs).
 */
export function loadSessionsState() {
  try {
    const raw = fs.readFileSync(config.sessionsStatePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to read sessions state, starting fresh:', err);
    }
    return [];
  }
}

export function saveSessionsState(sessions) {
  const dir = path.dirname(config.sessionsStatePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${config.sessionsStatePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmpPath, config.sessionsStatePath);
}
