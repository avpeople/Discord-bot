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

export function parseRepoSlug(slug) {
  const [owner, name] = slug.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repo "${slug}", expected format "owner/name"`);
  }
  return { owner, name };
}
