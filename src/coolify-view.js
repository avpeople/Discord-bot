import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

/**
 * Display helpers for Coolify resources, shared by the Server Status list
 * (sessions/handlers.js) and the per-app controls (coolify-controls.js).
 */

// Discord messages don't render Markdown horizontal rules, so a run of box-drawing characters stands in.
export const STATUS_DIVIDER = '─'.repeat(28);

// Picking an app from Server Status's dropdown opens its controls.
export const APP_SELECT_ID = 'coolify:app-select';

// Coolify reports status as 'state:health' (e.g. 'running:healthy', 'exited:unhealthy').
export function coolifyStatusIcon(status) {
  const [state = '', health = ''] = String(status ?? '').toLowerCase().split(/[:()\s]+/);
  if (state.startsWith('running')) return health === 'unhealthy' ? '🟡' : '🟢';
  if (state.startsWith('degraded')) return '🟡';
  if (state.startsWith('restarting') || state.startsWith('starting')) return '🟠';
  if (state.startsWith('exited') || state.startsWith('stopped') || state.startsWith('dead')) return '🔴';
  return '⚪';
}

/** True if Coolify's status string means it's not running at all. */
export function isStopped(status) {
  return coolifyStatusIcon(status) === '🔴';
}

/**
 * Readable labels for Coolify resources. Coolify names things like
 * 'live.nz:main-u14d84x6bi7xactgxnmlk87d' (name:branch-uuid) or
 * 'postgresql-database-vktj5awb3hjtynjlasr0uhya' (name-uuid): the random
 * id is dropped and the branch shown separately -> '**live.nz** · `main`'.
 * If two labels still collide (e.g. two 'postgresql-database'), each gets
 * the first 4 characters of its id to tell them apart. Adds `base`,
 * `branch`, `label` (Markdown) and `plainLabel` (for dropdowns).
 */
export function labelCoolifyResources(resources) {
  const parsed = resources.map((r) => {
    let name = String(r.name);
    if (r.uuid) name = name.replace(new RegExp(`-?${r.uuid}$`), '');
    name = name.replace(/-[a-z0-9]{20,}$/, ''); // any id Coolify appended without uuid matching exactly
    const [base, branch] = name.split(':');
    return { ...r, base: base || name, branch: branch || null };
  });
  const key = (p) => `${p.kind}|${p.base}|${p.branch}`;
  const counts = new Map();
  for (const p of parsed) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  return parsed.map((p) => {
    const shortId = counts.get(key(p)) > 1 && p.uuid ? p.uuid.slice(0, 4) : null;
    return {
      ...p,
      label: `**${p.base}**${p.branch ? ` · \`${p.branch}\`` : ''}${shortId ? ` _(${shortId})_` : ''}`,
      plainLabel: `${p.base}${p.branch ? ` · ${p.branch}` : ''}${shortId ? ` (${shortId})` : ''}`,
    };
  });
}

/**
 * Labels plus the icon to show: the status circle, 🟡 if the last deploy
 * failed (the old version is still running), or 🔨 while a deploy is
 * running. `statusIcon` keeps the real status circle for problem checks.
 */
export function decorateResources(resources) {
  return labelCoolifyResources(resources).map((r) => {
    const deployFailed = r.lastDeploy?.status === 'failed';
    const deploying = r.lastDeploy?.status === 'queued' || r.lastDeploy?.status === 'in_progress';
    let icon = coolifyStatusIcon(r.status);
    if (deployFailed && icon === '🟢') icon = '🟡';
    return { ...r, deployFailed, statusIcon: icon, icon: deploying ? '🔨' : icon };
  });
}

/** 'running:healthy' -> 'healthy', 'running:unknown' -> 'running' (no health check), 'exited:unhealthy' -> 'stopped'. */
export function friendlyCoolifyStatus(status) {
  if (!status) return 'no status reported';
  const [state = '', health = ''] = String(status).toLowerCase().split(/[:()\s]+/);
  if (state.startsWith('running')) return health === 'healthy' ? 'healthy' : health === 'unhealthy' ? 'running but unhealthy' : 'running';
  if (state.startsWith('exited') || state.startsWith('stopped') || state.startsWith('dead')) return 'stopped';
  if (state.startsWith('restarting')) return 'restarting';
  if (state.startsWith('starting')) return 'starting';
  if (state.startsWith('degraded')) return 'degraded (some containers down)';
  return state || status;
}

/**
 * 'Deployed 2 hours ago' (a Discord relative timestamp, which keeps itself
 * up to date in the client), or a note if the latest deploy failed or is
 * still running. '' for things with no deploys (e.g. databases).
 */
export function describeLastDeploy(lastDeploy) {
  if (!lastDeploy?.at) return '';
  const when = `<t:${Math.floor(lastDeploy.at / 1000)}:R>`;
  switch (lastDeploy.status) {
    case 'finished':
      return `Deployed ${when}`;
    case 'failed':
      return `❌ Last deploy failed ${when}`;
    case 'cancelled-by-user':
      return `Last deploy cancelled ${when}`;
    case 'queued':
    case 'in_progress':
      return `Deploying now (started ${when})`;
    default:
      return `Last deploy ${when}`;
  }
}

/** Icon + name line, then status and last deploy as small grey subtext lines. */
export function describeResource(r) {
  const deploy = describeLastDeploy(r.lastDeploy);
  return [`${r.icon} ${r.label}`, `-# Status: ${friendlyCoolifyStatus(r.status)}`, ...(deploy ? [`-# ${deploy}`] : [])].join('\n');
}

/** "Manage an app..." dropdown under Server Status (apps only — Discord allows 25 options). */
export function buildAppSelectRow(decorated) {
  const apps = decorated
    .filter((r) => r.kind === 'app' && r.uuid)
    .sort((a, b) => a.plainLabel.localeCompare(b.plainLabel))
    .slice(0, 25);
  if (apps.length === 0) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(APP_SELECT_ID)
      .setPlaceholder('Manage an app — logs, restart, redeploy, stop...')
      .addOptions(
        apps.map((r) => ({
          label: r.plainLabel.slice(0, 100),
          description: friendlyCoolifyStatus(r.status).slice(0, 100),
          value: r.uuid,
          emoji: r.icon,
        })),
      ),
  );
}
