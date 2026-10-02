import { config } from '../config.js';
import { readJsonFile, writeJsonFile } from '../json-store.js';

/**
 * Per-guild LiveU status panel config: which channel it lives in, the id
 * of the summary message at the top, one message id per unit (so a restart
 * edits the same messages instead of re-posting), and the low-bitrate
 * alert threshold for the studio log.
 */
const DEFAULT_STATE = {}; // { [guildId]: { channelId, summaryMessageId, unitMessages: { [bossId]: messageId }, lowBitrateKbps } }

export const DEFAULT_LOW_BITRATE_KBPS = 1500;

function load() {
  return readJsonFile(config.liveuStatePath, DEFAULT_STATE);
}

function save(state) {
  writeJsonFile(config.liveuStatePath, state);
}

export function getLiveuConfig(guildId) {
  return load()[guildId] ?? null;
}

export function allLiveuConfigs() {
  return load();
}

/** Merges `changes` into the guild's config. */
export function updateLiveuConfig(guildId, changes) {
  const state = load();
  state[guildId] = { unitMessages: {}, ...state[guildId], ...changes };
  save(state);
  return state[guildId];
}

export function lowBitrateKbps(guildId) {
  return getLiveuConfig(guildId)?.lowBitrateKbps ?? DEFAULT_LOW_BITRATE_KBPS;
}
