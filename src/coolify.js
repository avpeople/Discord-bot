import { config } from './config.js';

/**
 * Minimal Coolify API client, used to follow the deploy Coolify kicks off
 * when Commit merges into a repo's default branch (Coolify auto-deploys on
 * push). Endpoints, per Coolify's API reference:
 *   GET /api/v1/applications                      -> [{ uuid, name, git_repository, git_branch, ... }]
 *   GET /api/v1/deployments/applications/{uuid}   -> that app's deployments, newest first
 *                                                    ({ uuid, status, git_commit_sha, created_at, ... })
 *   GET /api/v1/deployments/{uuid}                 -> one deployment, including `logs`
 * Auth is `Authorization: Bearer <COOLIFY_API_TOKEN>`.
 */

const POLL_INTERVAL_MS = 10_000;
// If no matching deploy shows up in this long, assume auto-deploy is off
// for this app (or Coolify missed the push) and stop watching.
const APPEAR_TIMEOUT_MS = 3 * 60 * 1000;
const FINISH_TIMEOUT_MS = 30 * 60 * 1000;

// Coolify's deployment statuses: queued, in_progress, finished, failed, cancelled-by-user
const DONE_STATUSES = new Set(['finished', 'failed', 'cancelled-by-user']);

export function isConfigured() {
  return Boolean(config.coolify.url && config.coolify.apiToken);
}

async function api(path, method = 'GET') {
  const url = `${config.coolify.url.replace(/\/+$/, '')}/api/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.coolify.apiToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      // no JSON body
    }
    const err = new Error(
      res.status === 401 || res.status === 403
        ? "Coolify refused — the API token is wrong or doesn't have permission for this (Restart/Stop/Redeploy need a token with write + deploy)."
        : `Coolify API ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Current Coolify docs use POST for actions; older versions used GET — retry with GET if POST isn't allowed. */
async function action(path) {
  try {
    return await api(path, 'POST');
  } catch (err) {
    if (err.status === 405 || err.status === 404) return api(path, 'GET');
    throw err;
  }
}

/**
 * Runs a control action on an application. `kind` is 'restart',
 * 'redeploy', 'stop' or 'start'. Resolves with the deployment uuid Coolify
 * queued for it (restart/redeploy/start), or null (stop).
 */
export async function controlApplication(appUuid, kind) {
  const uuid = encodeURIComponent(appUuid);
  switch (kind) {
    case 'restart':
      return (await action(`/applications/${uuid}/restart`))?.deployment_uuid ?? null;
    case 'start':
      return (await action(`/applications/${uuid}/start`))?.deployment_uuid ?? null;
    case 'stop':
      await action(`/applications/${uuid}/stop`);
      return null;
    case 'redeploy': {
      const data = await action(`/deploy?uuid=${uuid}`);
      return data?.deployments?.[0]?.deployment_uuid ?? null;
    }
    default:
      throw new Error(`Unknown action ${kind}`);
  }
}

/** Status of one deployment ('queued', 'in_progress', 'finished', 'failed', 'cancelled-by-user'), or null if unknown. */
export async function getDeploymentStatus(deploymentUuid) {
  return (await api(`/deployments/${encodeURIComponent(deploymentUuid)}`).catch(() => null))?.status ?? null;
}

/** Last `lines` lines of an application's container logs, with terminal colour codes stripped. */
export async function getApplicationLogs(appUuid, lines = 30) {
  const data = await api(`/applications/${encodeURIComponent(appUuid)}/logs?lines=${lines}`);
  // eslint-disable-next-line no-control-regex
  return String(data?.logs ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
}

export { DONE_STATUSES };

/** 'https://github.com/Owner/Repo.git', 'git@github.com:Owner/Repo', 'Owner/Repo' -> 'owner/repo' */
function normalizeRepo(value) {
  return String(value ?? '')
    .trim()
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Coolify applications deployed from `owner/repo` on `branch`. */
export async function findApplications(owner, repo, branch) {
  const apps = await api('/applications');
  const wanted = `${owner}/${repo}`.toLowerCase();
  return (Array.isArray(apps) ? apps : apps.data ?? []).filter(
    (app) => normalizeRepo(app.git_repository) === wanted && (!app.git_branch || app.git_branch === branch),
  );
}

async function listDeployments(appUuid, take = 10) {
  const data = await api(`/deployments/applications/${encodeURIComponent(appUuid)}?skip=0&take=${take}`);
  return Array.isArray(data) ? data : data.deployments ?? data.data ?? [];
}

/** Coolify timestamps can carry microseconds ('…:00.000000Z'); trim to milliseconds so Date parses them everywhere. */
function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(String(value).replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) ? null : ms;
}

/** Last few visible log lines of a deployment, for a failure message. Best-effort — '' if unavailable. */
export async function deploymentLogTail(deploymentUuid, lines = 15) {
  try {
    const deployment = await api(`/deployments/${encodeURIComponent(deploymentUuid)}`);
    const logs = typeof deployment.logs === 'string' ? JSON.parse(deployment.logs) : deployment.logs;
    if (!Array.isArray(logs)) return '';
    return logs
      .filter((entry) => !entry.hidden && entry.output)
      .map((entry) => String(entry.output).trim())
      .slice(-lines)
      .join('\n');
  } catch {
    return '';
  }
}

const asList = (data) => (Array.isArray(data) ? data : data?.data ?? []);

/**
 * Everything Coolify runs, with its current status:
 * `[{ kind, name, uuid, status, lastDeploy }]` where kind is 'app',
 * 'database' or 'service' and status is Coolify's raw string (e.g.
 * 'running:healthy', 'exited:unhealthy') or null if the API didn't include
 * one — documented for applications; databases and services are
 * best-effort since their list responses aren't documented. Apps also get
 * `lastDeploy: { at, status }` from their most recent deployment (`at` in
 * ms — when it finished, or started if it's still going), or null. A kind
 * or deployment lookup that fails is left out rather than failing the list.
 */
export async function listResources() {
  const [apps, databases, services] = await Promise.all(
    ['/applications', '/databases', '/services'].map((p) => api(p).then(asList).catch(() => [])),
  );
  const toResource = (kind) => (r) => ({ kind, name: r.name ?? r.uuid, uuid: r.uuid ?? null, status: r.status ?? null, lastDeploy: null });

  const appResources = await Promise.all(
    apps.map(async (app) => {
      const resource = toResource('app')(app);
      if (!app.uuid) return resource;
      const [latest] = await listDeployments(app.uuid, 1).catch(() => []);
      if (latest) {
        const done = DONE_STATUSES.has(latest.status);
        resource.lastDeploy = {
          at: parseTime(done ? latest.updated_at ?? latest.created_at : latest.created_at),
          status: latest.status,
        };
      }
      return resource;
    }),
  );
  return [...appResources, ...databases.map(toResource('database')), ...services.map(toResource('service'))];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Follows one app's deploy of `sha` (the merge commit). Matches on
 * git_commit_sha, falling back to any deploy created after `since` —
 * Coolify sometimes records 'HEAD' instead of the real sha. Calls
 * `onStatus(status, deployment)` whenever the status changes and resolves
 * with the final status: 'finished', 'failed', 'cancelled-by-user',
 * 'not-found' (never appeared) or 'timeout'.
 */
export async function watchDeployment(app, { sha, since, onStatus }) {
  const startedAt = Date.now();
  let lastStatus = null;
  let deploymentUuid = null;

  while (Date.now() - startedAt < FINISH_TIMEOUT_MS) {
    try {
      const deployments = await listDeployments(app.uuid);
      const match = deploymentUuid
        ? deployments.find((d) => d.uuid === deploymentUuid)
        : deployments.find((d) => sha && d.git_commit_sha === sha) ??
          deployments.find((d) => d.created_at && new Date(d.created_at).getTime() >= since - 5_000);

      if (match) {
        deploymentUuid = match.uuid;
        if (match.status !== lastStatus) {
          lastStatus = match.status;
          await onStatus?.(match.status, match);
        }
        if (DONE_STATUSES.has(match.status)) return { status: match.status, deployment: match };
      } else if (Date.now() - startedAt > APPEAR_TIMEOUT_MS) {
        return { status: 'not-found', deployment: null };
      }
    } catch (err) {
      console.error(`[coolify] polling ${app.name} failed:`, err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: 'timeout', deployment: null };
}
