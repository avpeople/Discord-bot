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

/**
 * Everything changed in the working directory since the last commit,
 * including new untracked files: `{ files, stat, patch }` where `files` is
 * `git status --short` output and `patch` the full diff. Untracked files
 * are marked intent-to-add first so they show up in the diff — harmless,
 * since Commit stages everything with `add .` anyway.
 */
export async function pendingChanges(git) {
  await git.raw(['add', '--intent-to-add', '--all']);
  const [files, stat, patch] = await Promise.all([
    git.raw(['status', '--short']),
    git.raw(['diff', 'HEAD', '--shortstat']),
    git.raw(['diff', 'HEAD']),
  ]);
  return { files: files.trim(), stat: stat.trim(), patch };
}

/**
 * Records the working directory's current state (tracked + untracked,
 * respecting .gitignore) as a git tree object and returns its hash, without
 * touching the real index, HEAD or any branch — a scratch index file is
 * used instead. Used before each Claude turn so Undo can put files back.
 */
export async function snapshotWorkingTree(dir) {
  const git = scratchIndexGit(dir);
  await git.raw(['read-tree', 'HEAD']); // start from HEAD so `add` only has to hash what changed
  await git.raw(['add', '-A']);
  return (await git.raw(['write-tree'])).trim();
}

/**
 * Puts the working directory back to a snapshotWorkingTree() state:
 * restores every file in the snapshot and deletes files created since
 * (ignored files, e.g. node_modules, are left alone). The real index is
 * reset to HEAD afterwards so no stale staged entries linger.
 */
export async function restoreWorkingTree(dir, tree) {
  const git = scratchIndexGit(dir);
  await git.raw(['read-tree', tree]);
  await git.raw(['checkout-index', '-a', '-f']);

  const inSnapshot = new Set((await git.raw(['ls-tree', '-r', '--name-only', '-z', tree])).split('\0').filter(Boolean));
  const current = (await simpleGit(dir).raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .split('\0')
    .filter(Boolean);
  for (const file of current) {
    if (!inSnapshot.has(file)) fs.rmSync(path.join(dir, file), { force: true });
  }
  await simpleGit(dir).raw(['reset', '-q']);
}

function scratchIndexGit(dir) {
  // simple-git refuses to run with some inherited GIT_* variables set (e.g.
  // GIT_EDITOR, as a safety check), so pass the environment without them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return simpleGit(dir).env({ ...env, GIT_INDEX_FILE: path.join(dir, '.git', 'claude-snapshot-index') });
}

/** True if the working directory has no uncommitted changes (tracked or untracked). */
export async function isWorkingTreeClean(git) {
  return (await git.status()).isClean();
}

/** Discards all uncommitted working-directory changes (used on idle timeout). */
export async function discardPendingChanges(git) {
  await git.reset(['--hard']);
  await git.clean('fd');
}

/**
 * After a session branch has been merged into the default branch, moves
 * the working directory onto a fresh branch off the now-updated default
 * so the session can keep going and commit again later (each Commit click
 * gets its own branch/PR rather than reusing an already-merged one, which
 * GitHub won't accept further pushes/PRs against in the same way).
 */
export async function rebranchFromDefault(git, defaultBranch, newBranchName) {
  await git.checkout(defaultBranch);
  await git.pull('origin', defaultBranch);
  await git.checkoutLocalBranch(newBranchName);
}
