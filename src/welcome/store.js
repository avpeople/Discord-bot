import { config } from '../config.js';
import { readJsonFile, writeJsonFile } from '../json-store.js';

/**
 * Per-guild welcome-panel config: the list of requestable roles (each a
 * {roleId, label}) and which channel approval requests get posted in.
 * Keyed by guild id so this could in principle serve multiple servers,
 * though this bot is generally run for one.
 */
const DEFAULT_STATE = {}; // { [guildId]: { roles: [{roleId, label}], approvalChannelId } }

function load() {
  return readJsonFile(config.welcomeStatePath, DEFAULT_STATE);
}

function save(state) {
  writeJsonFile(config.welcomeStatePath, state);
}

function guildEntry(state, guildId) {
  if (!state[guildId]) state[guildId] = { roles: [], approvalChannelId: null };
  return state[guildId];
}

export function getGuildConfig(guildId) {
  const state = load();
  return state[guildId] ?? { roles: [], approvalChannelId: null };
}

export function addRole(guildId, roleId, label) {
  const state = load();
  const entry = guildEntry(state, guildId);
  const existing = entry.roles.find((r) => r.roleId === roleId);
  if (existing) {
    existing.label = label;
  } else {
    entry.roles.push({ roleId, label });
  }
  save(state);
  return entry.roles;
}

export function removeRole(guildId, roleId) {
  const state = load();
  const entry = guildEntry(state, guildId);
  entry.roles = entry.roles.filter((r) => r.roleId !== roleId);
  save(state);
  return entry.roles;
}

export function setApprovalChannel(guildId, channelId) {
  const state = load();
  const entry = guildEntry(state, guildId);
  entry.approvalChannelId = channelId;
  save(state);
  return entry;
}
