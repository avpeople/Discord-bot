import { config } from './config.js';
import { readJsonFile, writeJsonFile } from './json-store.js';

/** Per-guild audit log channel: which channel gets activity log messages. */
const DEFAULT_STATE = {}; // { [guildId]: channelId }

function load() {
  return readJsonFile(config.logChannelStatePath, DEFAULT_STATE);
}

function save(state) {
  writeJsonFile(config.logChannelStatePath, state);
}

export function getLogChannel(guildId) {
  const state = load();
  return state[guildId] ?? null;
}

export function setLogChannel(guildId, channelId) {
  const state = load();
  state[guildId] = channelId;
  save(state);
}
