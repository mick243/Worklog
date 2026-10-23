// 시험 도우미. 모든 시험은 임시 폴더의 가짜 세션 기록과 임시 git 저장소로만 해요.
// 사용자의 실제 ~/.claude 나 실제 저장소는 건드리지 않아요 (HOME·USERPROFILE도 임시 폴더로 바꿔요).
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = join(APP_DIR, 'dist', 'src', 'cli.js');
export const NO_NET = join(APP_DIR, 'test', 'fixtures', 'no-network.cjs');
/** 가짜 claude (PRD A26). 실제 Claude Code를 부르지 않아요. */
export const FAKE_CLAUDE = join(APP_DIR, 'test', 'fixtures', 'fake-claude.mjs');

// 시험이 실수로라도 실제 claude를 부르지 않게, 이 모듈을 부르는 모든 시험(같은 프로세스에서 부르는 runMake 등 포함)에 늘 가짜를 줘요.
process.env.CC_WORKLOG_CLAUDE = FAKE_CLAUDE;
for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_CLAUDE_') || k === 'CC_WORKLOG_CLAUDE_TIMEOUT_MS') delete process.env[k];

export interface Sandbox {
  root: string;
  home: string;
  claudeDir: string;
  projectsDir: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'ccwl-'));
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  const projectsDir = join(claudeDir, 'projects');
  const dataDir = join(home, '.cc-worklog');
  mkdirSync(projectsDir, { recursive: true });
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(gitConfig, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TZ: 'Asia/Seoul',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CC_WORKLOG_HOME;
  delete env.CC_WORKLOG_GIT;
  delete env.NODE_OPTIONS;
  // 가짜 claude와 그 호출 기록 폴더 (A26). 요약을 켜지 않으면 이 폴더가 생기지 않아요(claude 실행 0회).
  env.CC_WORKLOG_CLAUDE = FAKE_CLAUDE;
  env.FAKE_CLAUDE_LOG_DIR = join(root, 'fake-claude-calls');
  return {
    root,
    home,
    claudeDir,
    projectsDir,
    dataDir,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** CLI를 네트워크 차단 상태로 실행해요. 네트워크에 연결하려 하면 종료 코드 97이 돼요. */
export function runCli(sb: Sandbox, args: string[], extraEnv: NodeJS.ProcessEnv = {}, nodeArgs: string[] = []): CliResult {
  const r = spawnSync(process.execPath, [...nodeArgs, '--require', NO_NET, CLI, ...args, '--claude-dir', sb.claudeDir, '--data-dir', sb.dataDir], {
    env: { ...sb.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 가짜 claude가 남긴 호출 기록 (시작 시각 순서). 한 번도 실행되지 않았으면 빈 목록이에요. */
export interface FakeCall {
  argv: string[];
  cwd: string;
  pid: number;
  start: number;
  end: number | null;
  stdin: string;
  mode: string;
}

export function fakeCalls(sb: Sandbox): FakeCall[] {
  const dir = sb.env.FAKE_CLAUDE_LOG_DIR!;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as FakeCall)
    .sort((a, b) => a.start - b.start || a.pid - b.pid);
}

/** 가짜 claude 호출 기록을 비워요 (다음 실행의 호출만 보려고). */
export function clearFakeCalls(sb: Sandbox): void {
  rmSync(sb.env.FAKE_CLAUDE_LOG_DIR!, { recursive: true, force: true });
}

// ---- git ----

export function git(sb: Sandbox, cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync('git', args, { cwd, env: { ...sb.env, ...extraEnv }, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 실패: ${r.stderr}`);
  return r.stdout.trim();
}

export function initRepo(sb: Sandbox, dir: string, email: string): void {
  mkdirSync(dir, { recursive: true });
  git(sb, dir, ['init', '-q', '-b', 'main']);
  git(sb, dir, ['config', 'user.email', email]);
  git(sb, dir, ['config', 'user.name', 'Test User']);
  git(sb, dir, ['config', 'commit.gpgsign', 'false']);
}

let fileCounter = 0;
/**
 * iso 시각으로 커밋을 만들고 해시를 돌려줘요. author를 주면 그 작성자로 만들어요.
 * committerIso를 주면 커밋 시각만 따로 정해요(rebase·cherry-pick으로 커밋 시각이 바뀐 커밋 흉내).
 */
export function commitAt(
  sb: Sandbox,
  dir: string,
  message: string,
  iso: string,
  author?: { name: string; email: string },
  committerIso?: string,
): string {
  const f = join(dir, `file-${++fileCounter}.txt`);
  writeFileSync(f, `${message}\n${fileCounter}\n`);
  git(sb, dir, ['add', '-A']);
  const env: NodeJS.ProcessEnv = { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: committerIso ?? iso };
  if (author) {
    env.GIT_AUTHOR_NAME = author.name;
    env.GIT_AUTHOR_EMAIL = author.email;
    env.GIT_COMMITTER_NAME = author.name;
    env.GIT_COMMITTER_EMAIL = author.email;
  }
  git(sb, dir, ['commit', '-q', '-m', message], env);
  return git(sb, dir, ['rev-parse', 'HEAD']);
}

// ---- 가짜 세션 기록 ----

/** 서울 시각 → ISO(UTC) */
export function kst(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00+09:00`).toISOString();
}

export function encodeProject(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

interface Base {
  sid: string;
  cwd: string;
  ts: string;
  branch?: string;
  version?: string;
  extra?: Record<string, unknown>;
}

function base(b: Base, type: string) {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: b.cwd,
    sessionId: b.sid,
    version: b.version ?? '2.1.299',
    gitBranch: b.branch ?? 'main',
    type,
    uuid: randomUUID(),
    timestamp: b.ts,
    ...b.extra,
  };
}

export const userText = (b: Base, text: string) => JSON.stringify({ ...base(b, 'user'), message: { role: 'user', content: text } });

export const userBlocks = (b: Base, content: unknown[]) => JSON.stringify({ ...base(b, 'user'), message: { role: 'user', content } });

export const toolResult = (b: Base, toolUseId: string, output: string) =>
  JSON.stringify({
    ...base(b, 'user'),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }] },
    toolUseResult: { stdout: output, stderr: '' },
  });

export const assistantText = (b: Base, text: string) =>
  JSON.stringify({
    ...base(b, 'assistant'),
    requestId: 'req_fake',
    message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }], usage: { input_tokens: 1 } },
  });

export const assistantThinking = (b: Base, thinking: string) =>
  JSON.stringify({
    ...base(b, 'assistant'),
    message: { role: 'assistant', content: [{ type: 'thinking', thinking, signature: 'sig'.repeat(50) }] },
  });

export const assistantToolUse = (b: Base, id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ ...base(b, 'assistant'), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });

export const attachmentLine = (b: Base, content: string) => JSON.stringify({ ...base(b, 'attachment'), attachment: { type: 'file', content } });

export const systemLine = (b: Base, content: string) => JSON.stringify({ ...base(b, 'system'), subtype: 'local_command', content });

export const snapshotLine = (content: string) =>
  JSON.stringify({ type: 'file-history-snapshot', messageId: randomUUID(), snapshot: { trackedFileBackups: { 'a.ts': content } } });

export const customTitle = (sid: string, title: string) => JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: sid });

export const lastPrompt = (sid: string, prompt: string) => JSON.stringify({ type: 'last-prompt', lastPrompt: prompt, sessionId: sid });

/** 자동으로 붙은 세션 제목 줄. 실제 기록 모양 그대로 timestamp·cwd가 없어요 (A5·A17). */
export const aiTitle = (sid: string, title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: sid });

/** 세션에서 만든 PR 줄 (Q19): prNumber, prUrl, prRepository, timestamp, sessionId */
export const prLink = (sid: string, ts: string, prNumber: number, prRepository: string, prUrl = `https://github.com/${prRepository}/pull/${prNumber}`) =>
  JSON.stringify({ type: 'pr-link', prNumber, prUrl, prRepository, timestamp: ts, sessionId: sid });

/** pr-link 말고 2026-10-20에 처음 본 줄 종류 11가지 (일지 재료가 아니라 보관본에서 빼요). 칸은 흉내만 냈어요. */
export const OTHER_SEEN_TYPES = [
  'frame-link',
  'permission-mode',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'started',
  'result',
  'failed',
  'launched',
] as const;

export const seenTypeLine = (type: string, sid: string, ts: string, body = 'SEEN-TYPE-BODY-ZQX') => JSON.stringify({ type, sessionId: sid, timestamp: ts, data: body });

export const costState = (sid: string, added: number, removed: number, durationMs: number) =>
  JSON.stringify({ type: 'cost-state', sessionId: sid, totalCostUSD: 0.5, totalLinesAdded: added, totalLinesRemoved: removed, totalDuration: durationMs, totalAPIDuration: 1000 });

export function writeSession(sb: Sandbox, cwd: string, sid: string, lines: string[]): string {
  const file = join(sb.projectsDir, encodeProject(cwd), `${sid}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

export function writeSubagent(sb: Sandbox, cwd: string, sid: string, agentId: string, lines: string[]): string {
  const file = join(sb.projectsDir, encodeProject(cwd), sid, 'subagents', `agent-${agentId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

// ---- 파일 살펴보기 ----

export function listFilesRec(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function fingerprint(file: string): { hash: string; mtimeMs: number; size: number } {
  const st = statSync(file);
  return { hash: createHash('sha256').update(readFileSync(file)).digest('hex'), mtimeMs: st.mtimeMs, size: st.size };
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** 폴더 안 모든 파일의 내용 해시·수정 시각·크기 (폴더 기준 / 구분 상대 경로 → 지문) */
export function snapshotDir(dir: string): Record<string, { hash: string; mtimeMs: number; size: number }> {
  return Object.fromEntries(listFilesRec(dir).map((p) => [relative(dir, p).split(sep).join('/'), fingerprint(p)]));
}

/**
 * S3 끝 덩어리: 출력의 마지막 `검사` 줄과 그 아래 값 칸 위치(12칸)에 이어지는 줄을 한 줄로 이어 붙여 돌려줘요.
 * `검사` 줄 뒤에 그 덩어리 밖의 줄이 있으면 빈 글을 돌려줘요(검사 덩어리가 출력의 마지막이 아니면 시험이 실패하게).
 * 일지 만들기는 이름·이메일 가리기를 끈 채 만든 일지가 있으면 검사 줄 아래에 A19 안내가 이어져요(PRD S3, I-01).
 */
export function lastCheckRow(out: string): string {
  const lines = out.replace(/\n$/, '').split('\n');
  const i = lines.map((l) => l.startsWith('검사')).lastIndexOf(true);
  if (i === -1 || !lines.slice(i + 1).every((l) => l.startsWith(' '.repeat(12)) && l.trim())) return '';
  return lines
    .slice(i)
    .map((l) => l.trim())
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * 이 규칙(손으로 고친 일지 알아보기, A21) 전에 만든 일지를 흉내 내요: 화면용 일지 데이터에서 markdownHash 칸을 빼요.
 * 이전 판이 남긴 어긋남(한쪽만 가려진 일지 등)은 이 칸이 없어서, 손으로 고친 일지가 아니라 다시 만들 수 있는 일지예요(PRD A21).
 */
export function asOldVersionWorklog(jsonPath: string): void {
  const day = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
  delete day.markdownHash;
  writeFileSync(jsonPath, `${JSON.stringify(day, null, 1)}\n`);
}

/**
 * 터미널 출력에서 label로 시작하는 줄부터, 들여쓰기가 그 줄보다 깊은 이어지는 줄까지를 한 줄로 이어 붙여요.
 * 칸 맞춤용 여러 칸 공백도 하나로 줄여요. 디자인이 긴 줄을 어떻게 나누든(80칸 대비) 내용(수·종류)만 확인하려고 써요.
 */
export function rowText(out: string, label: string): string {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.trimStart().startsWith(label));
  if (i === -1) return '';
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const base = indentOf(lines[i]!);
  const picked = [lines[i]!];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (!l.trim() || indentOf(l) <= base) break;
    picked.push(l);
  }
  return picked
    .map((l) => l.trim())
    .join(' ')
    .replace(/\s+/g, ' ');
}
