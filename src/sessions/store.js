import { config } from '../config.js';
import { readJsonFile, writeJsonFile } from '../json-store.js';

/**
 * Tiny persisted JSON store for session metadata, so sessions can be
 * restored after a container restart (see Session for why this works:
 * each message is a fresh `claude --resume` process, keyed by on-disk
 * conversation history under CLAUDE_CONFIG_DIR — nothing lives only in
 * memory that resuming needs).
 */
export function loadSessionsState() {
  const data = readJsonFile(config.sessionsStatePath, []);
  return Array.isArray(data) ? data : [];
}

export function saveSessionsState(sessions) {
  writeJsonFile(config.sessionsStatePath, sessions);
}
