// 세션의 작업 폴더(cwd)가 어느 저장소에 속하는지 찾아요 (A4).
// git 명령 없이 .git 폴더·파일만 보고 찾아서, git이 없어도 프로젝트로 묶을 수 있어요.
// - 저장소 하위 폴더 → 그 저장소
// - 워크트리 → 원래 저장소 (.git 파일의 gitdir → commondir)
// - 지금은 없어진 폴더 → 남아 있는 위 폴더의 저장소, 또는 원래 저장소에 적힌 워크트리 목록으로 찾기
//   (워크트리 목록을 살펴볼 저장소는 지정한 상위 폴더 아래 저장소와 세션 기록 전체에서 나온 저장소예요. build.ts가 더해 줘요, F1-08)
// - 어디에도 속하지 않으면 "저장소 없음"
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface RepoInfo {
  /** 저장소 최상위 폴더 */
  root: string;
  /** 비교용 키 (Windows는 소문자) */
  key: string;
  name: string;
}

export const pathKey = (p: string): string => {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function statKind(p: string): 'dir' | 'file' | null {
  try {
    const s = statSync(p);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function info(root: string): RepoInfo {
  const r = resolve(root);
  return { root: r, key: pathKey(r), name: basename(r).replace(/\.git$/i, '') || r };
}

/** 폴더 dir에 .git이 있으면 그 저장소(워크트리면 원래 저장소)를 돌려줘요. */
export function repoAt(dir: string): RepoInfo | null {
  const dotgit = join(dir, '.git');
  const kind = statKind(dotgit);
  if (kind === 'dir') return info(dir);
  if (kind !== 'file') return null;
  const text = readText(dotgit);
  const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
  if (!m) return info(dir);
  const gitdir = isAbsolute(m[1]!) ? resolve(m[1]!) : resolve(dir, m[1]!);
  const commondirText = readText(join(gitdir, 'commondir'));
  if (!commondirText) return info(dir); // 서브모듈 등: 그 폴더를 저장소로 봐요.
  const common = resolve(gitdir, commondirText.trim());
  return basename(common).toLowerCase() === '.git' ? info(dirname(common)) : info(common);
}

export class RepoResolver {
  private cache = new Map<string, RepoInfo | null>();
  private known = new Map<string, RepoInfo>();
  private worktrees: Map<string, RepoInfo> | null = null;

  addKnown(r: RepoInfo): void {
    this.known.set(r.key, r);
    this.worktrees = null;
  }

  /**
   * 찾지 못한(null) 결과를 잊어요. 워크트리 목록을 살펴볼 저장소를 더 알게 된 뒤, 찾지 못했던 작업 폴더를 다시 찾을 때 불러요(F1-08).
   */
  forgetMisses(): void {
    for (const [k, v] of this.cache) if (v === null) this.cache.delete(k);
  }

  knownRepos(): RepoInfo[] {
    return [...this.known.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** 작업 폴더의 저장소. 없는 폴더도 위 폴더·워크트리 목록으로 찾아봐요. */
  resolve(cwd: string): RepoInfo | null {
    const k = pathKey(cwd);
    if (this.cache.has(k)) return this.cache.get(k)!;
    const p = resolve(cwd);
    let r: RepoInfo | null;
    if (statKind(p) === 'dir') {
      r = this.walkUp(p);
    } else {
      r = this.walkUp(p) ?? this.fromWorktreeList(p);
    }
    this.cache.set(k, r);
    if (r) this.addKnown(r);
    return r;
  }

  private walkUp(start: string): RepoInfo | null {
    let dir = start;
    for (;;) {
      if (statKind(dir) === 'dir') {
        const r = repoAt(dir);
        if (r) return r;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private fromWorktreeList(p: string): RepoInfo | null {
    if (!this.worktrees) {
      this.worktrees = new Map();
      for (const repo of this.known.values()) {
        const wtDir = join(repo.root, '.git', 'worktrees');
        let names: string[] = [];
        try {
          names = readdirSync(wtDir);
        } catch {
          continue;
        }
        for (const n of names) {
          const g = readText(join(wtDir, n, 'gitdir'));
          if (!g) continue;
          const wt = dirname(resolve(g.trim()));
          this.worktrees.set(pathKey(wt), repo);
        }
      }
    }
    const k = pathKey(p);
    for (const [wtKey, repo] of this.worktrees) {
      if (k === wtKey || k.startsWith(wtKey + (process.platform === 'win32' ? '\\' : '/'))) return repo;
    }
    return null;
  }
}

const SKIP_DIRS = new Set(['node_modules']);

/**
 * --root·config.json의 roots에 준 경로를 건너뛴 까닭 (F1-20, A4): 없음(missing), 폴더가 아닌 파일(not-dir),
 * 그 아래에서 git 저장소를 하나도 찾지 못함(no-repo). 일지 만들기 S3가 경로마다 [알림]으로 보여 줘요.
 */
export interface RootIssue {
  path: string;
  kind: 'missing' | 'not-dir' | 'no-repo';
}

/** 사용자가 지정한 상위 폴더 아래 저장소를 찾아요 (git-standup처럼). 찾은 저장소 안으로는 더 내려가지 않아요. */
export function scanRoots(roots: string[], maxDepth: number): RepoInfo[] {
  return inspectRoots(roots, maxDepth).repos;
}

/**
 * scanRoots와 같지만, 저장소를 찾지 못한 경로와 그 까닭도 돌려줘요(F1-20). 멈추지 않고 그 경로만 건너뛰어요.
 * 경로가 저장소 자체면 그 저장소를 찾은 것으로 봐요. 위 폴더로는 올라가 찾지 않아요(전과 같아요).
 */
export function inspectRoots(roots: string[], maxDepth: number): { repos: RepoInfo[]; issues: RootIssue[] } {
  const found = new Map<string, RepoInfo>();
  const issues: RootIssue[] = [];
  let count = 0;
  const visit = (dir: string, depth: number) => {
    const r = repoAt(dir);
    if (r) {
      found.set(r.key, r);
      count++;
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) {
    const p = resolve(root);
    const kind = statKind(p);
    if (kind === null) {
      issues.push({ path: p, kind: 'missing' });
      continue;
    }
    if (kind !== 'dir') {
      issues.push({ path: p, kind: 'not-dir' });
      continue;
    }
    count = 0;
    visit(p, 0);
    if (count === 0) issues.push({ path: p, kind: 'no-repo' });
  }
  return { repos: [...found.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), issues };
}
