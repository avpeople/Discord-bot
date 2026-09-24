import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { config } from './config.js';

/**
 * Ensures a repo is cloned locally (or pulls latest if it already exists),
 * checks out a fresh branch off the base branch, and returns a ready-to-use
 * simple-git handle scoped to that repo's working directory.
 */
export async function prepareRepo({ owner, name, base, branchSuffix }) {
  const repoSlug = `${owner}/${name}`;
  const dir = path.join(config.workspaceDir, owner, name);
  const remoteUrl = `https://x-access-token:${config.github.token}@github.com/${repoSlug}.git`;

  fs.mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);

  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    await simpleGit().clone(remoteUrl, dir);
  }

  // Always repoint remote in case token rotated, and fetch latest.
  const remotes = await git.getRemotes();
  if (remotes.find((r) => r.name === 'origin')) {
    await git.remote(['set-url', 'origin', remoteUrl]);
  } else {
    await git.addRemote('origin', remoteUrl);
  }
  await git.fetch('origin');

  const defaultBranch = base || (await detectDefaultBranch(git));
  await git.checkout(defaultBranch);
  await git.pull('origin', defaultBranch);

  const branchName = `claude/${branchSuffix}`;
  await git.checkoutLocalBranch(branchName);

  await git.addConfig('user.name', config.github.commitName);
  await git.addConfig('user.email', config.github.commitEmail);

  return { git, dir, defaultBranch, branchName, remoteUrl };
}

async function detectDefaultBranch(git) {
  const info = await git.remote(['show', 'origin']);
  const match = /HEAD branch: (.+)/.exec(info || '');
  return match ? match[1].trim() : 'main';
}

export async function commitAndPush(git, branchName, message) {
  await git.add('.');
  const status = await git.status();
  if (status.staged.length === 0 && status.created.length === 0 && status.deleted.length === 0) {
    return { pushed: false, status };
  }
  await git.commit(message);
  await git.push('origin', branchName, ['--set-upstream']);
  return { pushed: true, status };
}

export async function diffSummary(git, base, branchName) {
  return git.diff([`${base}...${branchName}`, '--stat']);
}
