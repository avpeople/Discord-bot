import * as coolify from './coolify.js';
import { labelCoolifyResources } from './coolify-view.js';
import { getLogChannel } from './log-channel-store.js';

/**
 * Posts every Coolify deployment on the server — whatever started it (Push
 * Live, a GitHub push, the Coolify dashboard, the Redeploy button) — into
 * each guild's 'coolify' log channel (`/code set-coolify-log-channel`).
 * One message per deployment, edited as it goes: 🔨 deploying → ✅ deployed
 * / ❌ failed (with the log tail) / ⚪ cancelled.
 *
 * Polls each app's latest deployments. The first poll after boot only
 * records what's already there, so a restart doesn't re-post history;
 * deploys already running at boot still get their result posted when they
 * finish. Does nothing unless Coolify is configured and at least one guild
 * has a Coolify log channel.
 */

const POLL_INTERVAL_MS = 20_000;
const DEPLOYMENTS_PER_APP = 5;

let client = null;
let started = false;
let firstPoll = true;
// deployment uuid -> { status, messages: [{ channelId, messageId }] }
let seen = new Map();

function logChannelIds() {
  return client.guilds.cache.map((guild) => getLogChannel(guild.id, 'coolify')).filter(Boolean);
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

async function describe(app, deployment) {
  const startedAt = coolify.parseTime(deployment.created_at);
  const endedAt = coolify.parseTime(deployment.updated_at);
  const sha = deployment.git_commit_sha && deployment.git_commit_sha !== 'HEAD' ? deployment.git_commit_sha.slice(0, 7) : null;
  const commitMessage = String(deployment.commit_message ?? '').split('\n')[0].trim();
  const what = deployment.restart_only ? 'restart' : 'deploy';

  const details = [
    sha ? `Commit \`${sha}\`${commitMessage ? ` — ${commitMessage.slice(0, 80)}` : ''}` : null,
    deployment.restart_only ? 'Restart only (no rebuild)' : deployment.force_rebuild ? 'Forced rebuild' : null,
  ].filter(Boolean);

  let headline;
  let extra = '';
  switch (deployment.status) {
    case 'finished':
      headline = `✅ ${app.label} — ${what === 'restart' ? 'restarted' : 'deployed'}`;
      if (startedAt && endedAt) details.push(`Took ${formatDuration(endedAt - startedAt)} · finished <t:${Math.floor(endedAt / 1000)}:R>`);
      break;
    case 'failed': {
      headline = `❌ ${app.label} — ${what} **failed**`;
      if (startedAt && endedAt) details.push(`Failed after ${formatDuration(endedAt - startedAt)} · <t:${Math.floor(endedAt / 1000)}:R>`);
      const tail = await coolify.deploymentLogTail(deployment.uuid);
      if (tail) extra = `\n\`\`\`\n${tail.replace(/```/g, "'''").slice(-1200)}\n\`\`\``;
      break;
    }
    case 'cancelled-by-user':
      headline = `⚪ ${app.label} — ${what} cancelled`;
      break;
    case 'queued':
      headline = `🕐 ${app.label} — ${what} queued`;
      if (startedAt) details.push(`Queued <t:${Math.floor(startedAt / 1000)}:R>`);
      break;
    default:
      headline = `🔨 ${app.label} — ${what === 'restart' ? 'restarting' : 'deploying'}...`;
      if (startedAt) details.push(`Started <t:${Math.floor(startedAt / 1000)}:R>`);
  }
  return `${headline}\n${details.map((d) => `-# ${d}`).join('\n')}${extra}`.slice(0, 2000);
}

async function post(content) {
  const messages = [];
  for (const channelId of logChannelIds()) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const message = await channel?.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
    if (message) messages.push({ channelId, messageId: message.id });
  }
  return messages;
}

async function edit(messages, content) {
  for (const { channelId, messageId } of messages) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const message = await channel?.messages.fetch(messageId).catch(() => null);
    await message?.edit({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

async function poll() {
  if (!coolify.isConfigured() || logChannelIds().length === 0) return;

  const apps = labelCoolifyResources((await coolify.listApplications()).map((a) => ({ ...a, kind: 'app' })));
  const next = new Map();
  for (const app of apps) {
    if (!app.uuid) continue;
    const deployments = await coolify.listDeployments(app.uuid, DEPLOYMENTS_PER_APP).catch(() => null);
    if (!deployments) {
      // Couldn't check this app this time — keep what we knew so nothing is re-posted next poll.
      for (const [uuid, entry] of seen) if (entry.appUuid === app.uuid) next.set(uuid, entry);
      continue;
    }

    for (const deployment of deployments) {
      const known = seen.get(deployment.uuid);
      const entry = { appUuid: app.uuid, status: deployment.status, messages: known?.messages ?? [] };
      next.set(deployment.uuid, entry);

      if (firstPoll) continue; // just learning what's already there
      if (known && known.status === deployment.status) continue;

      const content = await describe(app, deployment);
      if (entry.messages.length > 0) {
        await edit(entry.messages, content);
      } else {
        // New deployment — or one that was already running at boot and has now changed status.
        entry.messages = await post(content);
      }
    }
  }
  seen = next;
  firstPoll = false;
}

/** Starts the deployment watcher (once). Called from index.js after login. */
export function startCoolifyMonitor(discordClient) {
  if (started) return;
  started = true;
  client = discordClient;

  let running = false;
  const tick = async () => {
    if (running) return; // a slow poll shouldn't overlap the next one
    running = true;
    try {
      await poll();
    } catch (err) {
      console.error('[coolify-monitor] poll failed:', err.message);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
