// 로컬 git 저장소에서 커밋을 읽어요. 읽기 전용 명령(log, config, --version)만 써요.
// 내 커밋(저장소의 user.email과 같은 작성자)만, 모든 로컬 브랜치에서 가져와요 (A3).
import { spawnSync } from 'node:child_process';
import { isoLocal } from '../util/time.js';

export interface Commit {
  hash: string;
  /** 작성 시각 (ms) */
  time: number;
  branch: string | null;
  /** 커밋 메시지 첫 줄 */
  subject: string;
}

/** 시험에서 git이 없는 상황을 흉내 낼 수 있게 CC_WORKLOG_GIT로 git 실행 파일을 바꿀 수 있어요. */
export function gitBin(): string {
  return process.env.CC_WORKLOG_GIT || 'git';
}

function git(args: string[], cwd?: string) {
  return spawnSync(gitBin(), args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

let available: boolean | null = null;
export function gitAvailable(): boolean {
  if (available === null) {
    const r = git(['--version']);
    available = !r.error && r.status === 0;
  }
  return available;
}

export function userEmail(root: string): string | null {
  const r = git(['-C', root, 'config', 'user.email']);
  if (r.error || r.status !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

export class GitLogError extends Error {}

/** git log에서 읽은 내 커밋 한 줄. 커밋 시각은 여러 날을 한 번에 만들 때 날짜마다 --since를 흉내 내려고 둬요(A18). */
export interface CommitRow extends Commit {
  /** 커밋 시각 (ms) */
  committerTime: number;
}

const DAY_MS = 86_400_000;
/** git --since는 커밋 시각 기준이라, 작성 시각으로 거르기 전에 이만큼 여유를 두고 넓게 가져와요. */
export const SINCE_MARGIN_MS = 2 * DAY_MS;

/**
 * sinceMs 뒤(커밋 시각 기준, git --since)의 내 커밋을 모두 읽어요. 작성 시각으로는 아직 거르지 않아요.
 * 여러 날을 한 번에 만들 때 저장소마다 한 번만 부르고(A18, PRD 5장), 날짜마다 pickRange로 나눠요.
 */
export function commitRowsSince(root: string, email: string, sinceMs: number): CommitRow[] {
  const since = isoLocal(sinceMs);
  const r = git([
    '-C',
    root,
    '-c',
    'i18n.logOutputEncoding=UTF-8',
    '-c',
    'log.showSignature=false',
    'log',
    '--branches',
    '--source',
    '--no-color',
    '--no-decorate',
    `--since=${since}`,
    '--format=%H%x1f%aI%x1f%ae%x1f%S%x1f%cI%x1f%s%x1e',
  ]);
  if (r.error || r.status !== 0) {
    // 커밋이 하나도 없는 저장소는 오류 없이 빈 목록이에요.
    if (/does not have any commits|unknown revision/i.test(r.stderr ?? '')) return [];
    throw new GitLogError('git log 실패');
  }
  const want = email.toLowerCase();
  const out: CommitRow[] = [];
  const seen = new Set<string>();
  for (const rec of r.stdout.split('\x1e')) {
    const t = rec.replace(/^\s+/, '');
    if (!t) continue;
    const [hash, date, ae, source, cdate, subject] = t.split('\x1f');
    if (!hash || !date || !/^[0-9a-f]{7,64}$/.test(hash) || seen.has(hash)) continue;
    if ((ae ?? '').toLowerCase() !== want) continue;
    const ms = Date.parse(date);
    if (Number.isNaN(ms)) continue;
    const cms = Date.parse(cdate ?? '');
    seen.add(hash);
    const branch = source ? source.replace(/^refs\/heads\//, '') : null;
    out.push({ hash, time: ms, committerTime: Number.isNaN(cms) ? ms : cms, branch: branch || null, subject: (subject ?? '').trim() });
  }
  return out;
}

/**
 * [start, end) 사이에 작성한 커밋만 골라요(작성 시각 기준, A3). 하루치를 따로 읽을 때의 --since(start - 2일, 커밋 시각 기준)도 같이 걸러서,
 * 여러 날을 한 번에 읽어 나눈 결과가 그 날짜를 따로 읽은 결과와 같아요(A18).
 */
export function pickRange(rows: CommitRow[], start: number, end: number): Commit[] {
  const since = start - SINCE_MARGIN_MS;
  return rows
    .filter((c) => c.time >= start && c.time < end && c.committerTime >= since)
    .map(({ hash, time, branch, subject }) => ({ hash, time, branch, subject }))
    .sort((a, b) => a.time - b.time || (a.hash < b.hash ? -1 : 1));
}
