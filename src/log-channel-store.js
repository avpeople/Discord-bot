import { config } from './config.js';
import { readJsonFile, writeJsonFile } from './json-store.js';

/**
 * Per-guild, per-kind log channels: which channel gets which category of
 * log message. `kind` is a free-form string ('activity' for Claude Code
 * session events, 'studio' for GFX/studio monitoring events, etc.) so new
 * event sources can get their own channel without new storage plumbing.
 *
 * Backward-compatible with the original shape (state[guildId] was a bare
 * channelId string, implicitly the 'activity' log) — read as
 * state[guildId].activity if state[guildId] is a string.
 */
const DEFAULT_STATE = {}; // { [guildId]: { [kind]: channelId } }

function load() {
  const state = readJsonFile(config.logChannelStatePath, DEFAULT_STATE);
  for (const guildId of Object.keys(state)) {
    if (typeof state[guildId] === 'string') {
      state[guildId] = { activity: state[guildId] };
    }
  }
  return state;
}

function save(state) {
  writeJsonFile(config.logChannelStatePath, state);
}

export function getLogChannel(guildId, kind = 'activity') {
  const state = load();
  return state[guildId]?.[kind] ?? null;
}

export function setLogChannel(guildId, channelId, kind = 'activity') {
  const state = load();
  if (!state[guildId]) state[guildId] = {};
  state[guildId][kind] = channelId;
  save(state);
}
