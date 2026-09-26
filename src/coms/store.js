import { config } from '../config.js';
import { readJsonFile, writeJsonFile } from '../json-store.js';

/**
 * Per-guild coms config: where the landing panel is (so it can be edited in
 * place and found again after a restart), and the voice chat the bot
 * created for the current bridge (so it can be deleted afterwards — even if
 * the bot restarted mid-bridge and lost track of it).
 */
const DEFAULT_STATE = {}; // { [guildId]: { landingChannelId, landingMessageId, createdVoiceChannelId } }

function load() {
  return readJsonFile(config.comsStatePath, DEFAULT_STATE);
}

export function getComsConfig(guildId) {
  return load()[guildId] ?? null;
}

export function allComsConfigs() {
  return load();
}

/** Merges `changes` into the guild's config. */
export function updateComsConfig(guildId, changes) {
  const state = load();
  state[guildId] = { ...state[guildId], ...changes };
  writeJsonFile(config.comsStatePath, state);
  return state[guildId];
}
