import { Octokit } from 'octokit';
import { config } from './config.js';

const octokit = new Octokit({ auth: config.github.token });

export async function openPullRequest({ owner, repo, base, head, title, body }) {
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    base,
    head,
    title,
    body,
  });
  return data;
}

/** Merges a pull request (squash) and returns the merge result. */
export async function mergePullRequest({ owner, repo, pullNumber }) {
  const { data } = await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: 'squash',
  });
  return data;
}

/**
 * Opens a PR that reverts a merged PR — the same thing as GitHub's "Revert"
 * button, via its GraphQL `revertPullRequest` mutation (there's no REST
 * equivalent). GitHub creates the revert branch itself. Throws if GitHub
 * can't revert it cleanly (e.g. later changes touched the same lines).
 * Returns `{ number, url, headRefName }` of the new PR.
 */
export async function openRevertPullRequest({ owner, repo, pullNumber }) {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const result = await octokit.graphql(
    `mutation($id: ID!, $title: String!, $body: String!) {
      revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) {
        revertPullRequest { number url headRefName }
      }
    }`,
    {
      id: pr.node_id,
      title: `Revert "${pr.title}"`,
      body: `Reverts #${pullNumber}, requested from the Claude Code Discord session.`,
    },
  );
  return result.revertPullRequest.revertPullRequest;
}

/** Deletes a branch on the remote (used to clean up after an auto-merge). */
export async function deleteBranch({ owner, repo, branch }) {
  await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }).catch((err) => {
    // Already gone (e.g. GitHub auto-deleted it) — not worth failing over.
    if (err.status !== 422 && err.status !== 404) throw err;
  });
}

/**
 * Lists repos the configured GitHub token currently has access to.
 * Works for a fine-grained PAT (the recommended setup — see README),
 * which authenticates as your user and scopes /user/repos to whatever
 * repos were selected on the token.
 */
export async function listAccessibleRepos() {
  const repos = [];
  for await (const { data } of octokit.paginate.iterator(octokit.rest.repos.listForAuthenticatedUser, {
    per_page: 100,
    affiliation: 'owner,collaborator,organization_member',
  })) {
    for (const repo of data) {
      repos.push({ owner: repo.owner.login, name: repo.name, fullName: repo.full_name });
    }
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export function parseRepoSlug(slug) {
  const [owner, name] = slug.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repo "${slug}", expected format "owner/name"`);
  }
  return { owner, name };
}
