import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { config } from './config.js';

/**
 * Clones a repo into its own dedicated directory (not shared between
 * concurrent jobs/sessions), checks out a fresh branch off the base
 * branch, and returns a ready-to-use simple-git handle.
 *
 * `workDirName` should be unique per job/session (e.g. a job timestamp or
 * session id) so concurrent runs against the same repo never share a
 * working directory.
 */
export async function prepareRepo({ owner, name, base, branchSuffix, workDirName }) {
  const repoSlug = `${owner}/${name}`;
  const dir = path.join(config.workspaceDir, owner, name, workDirName ?? branchSuffix);
  const remoteUrl = `https://x-access-token:${config.github.token}@github.com/${repoSlug}.git`;

  fs.mkdirSync(dir, { recursive: true });
  await simpleGit().clone(remoteUrl, dir);
  const git = simpleGit(dir);

  const defaultBranch = base || (await detectDefaultBranch(git));
  await git.checkout(defaultBranch);

  const branchName = `claude/${branchSuffix}`;
  await git.checkoutLocalBranch(branchName);

  await git.addConfig('user.name', config.github.commitName);
  await git.addConfig('user.email', config.github.commitEmail);

  return { git, dir, defaultBranch, branchName, remoteUrl };
}

/** Recursively deletes a session/job's working directory. */
export async function cleanupRepoDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function detectDefaultBranch(git) {
  const info = await git.remote(['show', 'origin']);
  const match = /HEAD branch: (.+)/.exec(info || '');
  return match ? match[1].trim() : 'main';
}

export async function commitAndPush(git, branchName, message) {
  await git.add('.');
  const status = await git.status();
  // `staged` reflects everything currently in the index — new, modified,
  // or deleted files alike — after `add('.')`, so it alone tells us
  // whether there's anything to commit (verified against simple-git's
  // actual status() output).
  if (status.staged.length === 0) {
    return { pushed: false, status };
  }
  await git.commit(message);
  await git.push('origin', branchName, ['--set-upstream']);
  return { pushed: true, status };
}

export async function diffSummary(git, base, branchName) {
  return git.diff([`${base}...${branchName}`, '--stat']);
}

/** Discards all uncommitted working-directory changes (used on idle timeout). */
export async function discardPendingChanges(git) {
  await git.reset(['--hard']);
  await git.clean('fd');
}
