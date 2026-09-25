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

async function api(path) {
  const url = `${config.coolify.url.replace(/\/+$/, '')}/api/v1${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.coolify.apiToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = new Error(`Coolify API ${res.status} ${res.statusText} for ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

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

async function listDeployments(appUuid) {
  const data = await api(`/deployments/applications/${encodeURIComponent(appUuid)}?skip=0&take=10`);
  return Array.isArray(data) ? data : data.deployments ?? data.data ?? [];
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
 * Everything Coolify runs, with its current status: `[{ kind, name, status }]`
 * where kind is 'app', 'database' or 'service' and status is Coolify's raw
 * string (e.g. 'running:healthy', 'exited:unhealthy') or null if the API
 * didn't include one — documented for applications; databases and
 * services are best-effort since their list responses aren't documented.
 * A kind whose endpoint fails is skipped rather than failing the whole list.
 */
export async function listResources() {
  const [apps, databases, services] = await Promise.all(
    ['/applications', '/databases', '/services'].map((p) => api(p).then(asList).catch(() => [])),
  );
  const toResource = (kind) => (r) => ({ kind, name: r.name ?? r.uuid, status: r.status ?? null });
  return [...apps.map(toResource('app')), ...databases.map(toResource('database')), ...services.map(toResource('service'))];
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
