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
