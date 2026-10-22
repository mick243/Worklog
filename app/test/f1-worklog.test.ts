// F1 완료 기준 시험:
// 가짜 세션 기록과 저장소 3개로 날짜를 지정해 실행하면 네트워크 없이 그날 일지가 만들어지고,
// 프로젝트별 커밋 목록이 각 저장소의 git log(같은 날짜 범위·같은 작성자)와 개수·해시가 일치해요.
// 커밋 없는 세션과 세션 없는 커밋도 빠지지 않고, custom-title 없이 ai-title만 있는 세션도 제목이 빠지지 않으며(A5),
// 모르는 줄 종류가 섞여 있어도 멈추지 않고 건너뛴 줄 수를 알려 줘요(2026-10-20에 처음 본 12가지는 아는 줄이라 세지 않아요, A13).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MAKE_TEXT } from '../src/term/s3-summary.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  aiTitle,
  assistantText,
  assistantThinking,
  assistantToolUse,
  attachmentLine,
  commitAt,
  costState,
  customTitle,
  git,
  initRepo,
  kst,
  lastCheckRow,
  lastPrompt,
  OTHER_SEEN_TYPES,
  prLink,
  readJson,
  rowText,
  runCli,
  sandbox,
  seenTypeLine,
  snapshotLine,
  systemLine,
  toolResult,
  userText,
  writeSession,
  writeSubagent,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-15';
const ME = 'dev.kim@example.test';
const OTHER = { name: 'Lee', email: 'lee@example.test' };
const SID = {
  A: 'aaaaaaaa-0000-4000-8000-000000000001',
  B: 'bbbbbbbb-0000-4000-8000-000000000002',
  C: 'cccccccc-0000-4000-8000-000000000003',
  D: 'dddddddd-0000-4000-8000-000000000004',
  E: 'eeeeeeee-0000-4000-8000-000000000005',
  F: 'ffffffff-0000-4000-8000-000000000006',
  G: '99999999-0000-4000-8000-000000000007',
  H: '88888888-0000-4000-8000-000000000008',
};

let sb: Sandbox;
let work: string;
const repo = { alpha: '', beta: '', gamma: '', alphaWt: '' };
const h: Record<string, string> = {};

before(() => {
  sb = sandbox();
  work = join(sb.root, 'work');
  repo.alpha = join(work, 'alpha');
  repo.beta = join(work, 'beta');
  repo.gamma = join(work, 'gamma');
  repo.alphaWt = join(work, 'alpha-wt');
  for (const r of [repo.alpha, repo.beta, repo.gamma]) initRepo(sb, r, ME);

  // alpha: 여러 브랜치, 다른 작성자, 날짜 경계 앞뒤 커밋
  h.alphaPrevDay = commitAt(sb, repo.alpha, 'init', '2026-10-14T10:00:00+09:00');
  h.alphaEarly = commitAt(sb, repo.alpha, '새벽 커밋은 전날로 쳐요', '2026-10-15T02:30:00+09:00');
  h.a1 = commitAt(sb, repo.alpha, '로그인 토큰 만료 처리', '2026-10-15T10:05:00+09:00');
  h.other = commitAt(sb, repo.alpha, '다른 사람 커밋', '2026-10-15T11:00:00+09:00', OTHER);
  git(sb, repo.alpha, ['checkout', '-q', '-b', 'feature']);
  h.a2 = commitAt(sb, repo.alpha, 'feature 작업', '2026-10-15T14:20:00+09:00');
  git(sb, repo.alpha, ['checkout', '-q', 'main']);
  h.aLate = commitAt(sb, repo.alpha, '자정 넘어 커밋', '2026-10-16T01:30:00+09:00');
  h.aNext = commitAt(sb, repo.alpha, '다음 날 커밋', '2026-10-16T03:30:00+09:00');
  git(sb, repo.alpha, ['worktree', 'add', '-q', repo.alphaWt, '-b', 'wt-branch']);
  h.wt = commitAt(sb, repo.alphaWt, '워크트리 커밋', '2026-10-15T15:10:00+09:00');

  // beta: 그날 커밋 없음 (커밋 없는 세션)
  commitAt(sb, repo.beta, 'beta init', '2026-10-13T09:00:00+09:00');
  mkdirSync(join(repo.beta, 'sub', 'dir'), { recursive: true });

  // gamma: 그날 세션 없음 (세션 없는 커밋)
  h.g1 = commitAt(sb, repo.gamma, 'gamma 첫 커밋', '2026-10-15T09:00:00+09:00');
  h.g2 = commitAt(sb, repo.gamma, 'gamma 둘째 커밋', '2026-10-15T09:30:00+09:00');
  // 작성 시각은 그날이지만 rebase로 커밋 시각이 이틀 뒤인 커밋 → 그날에 넣어요 (A3)
  h.gRebased = commitAt(sb, repo.gamma, 'rebase한 커밋', '2026-10-15T20:00:00+09:00', undefined, '2026-10-17T09:00:00+09:00');
  // 커밋 시각은 그날이지만 작성 시각이 사흘 전인 커밋(cherry-pick) → 그날에 넣지 않아요
  h.gPicked = commitAt(sb, repo.gamma, 'cherry-pick한 옛 커밋', '2026-10-12T09:00:00+09:00', undefined, '2026-10-15T21:00:00+09:00');

  const scratch = join(sb.root, 'scratch');
  mkdirSync(scratch);

  const A = { sid: SID.A, cwd: repo.alpha };
  writeSession(sb, repo.alpha, SID.A, [
    userText({ ...A, ts: kst(DATE, '09:10') }, '로그인 할 때 500 오류가 나요. 고쳐 줘'),
    assistantThinking({ ...A, ts: kst(DATE, '09:10') }, '생각 과정 비밀 메모'),
    assistantText({ ...A, ts: kst(DATE, '09:11') }, '원인을 찾았어요'),
    assistantToolUse({ ...A, ts: kst(DATE, '09:12') }, 'toolu_1', 'Bash', { command: 'npm test', description: '시험' }),
    toolResult({ ...A, ts: kst(DATE, '09:12') }, 'toolu_1', 'BIG TOOL OUTPUT '.repeat(100)),
    attachmentLine({ ...A, ts: kst(DATE, '09:13') }, 'attached content'),
    systemLine({ ...A, ts: kst(DATE, '09:13') }, 'hook output'),
    snapshotLine('file content'),
    userText({ ...A, ts: kst(DATE, '11:40') }, '테스트 돌려 줘'),
    assistantText({ ...A, ts: kst(DATE, '11:40') }, '모두 통과했어요'),
    customTitle(SID.A, '로그인 버그 고치기'),
    aiTitle(SID.A, '자동 제목은 쓰지 않아요'),
    costState(SID.A, 120, 30, 5_400_000),
    lastPrompt(SID.A, '테스트 돌려 줘'),
    // 2026-10-20에 처음 본 줄 종류 12가지: 아는 줄이라 건너뛴 줄 수에 세지 않고, 일지에도 쓰지 않아요.
    prLink(SID.A, kst(DATE, '11:45'), 7, 'octo-zq/alpha-pr'),
    ...OTHER_SEEN_TYPES.map((t) => seenTypeLine(t, SID.A, kst(DATE, '09:20'))),
    '{"type":"future-thing","x":1}',
    '{"type":"another-new-type"}',
    '{not json',
    JSON.stringify({ type: 'user', timestamp: kst(DATE, '09:30'), sessionId: SID.A, message: { role: 'user', content: 'cwd 없음' } }),
  ]);
  writeSubagent(sb, repo.alpha, SID.A, 'a1', [
    userText({ ...A, ts: kst(DATE, '10:00'), extra: { isSidechain: true, agentId: 'a1' } }, '하위 작업 지시'),
    assistantText({ ...A, ts: kst(DATE, '10:02'), extra: { isSidechain: true, agentId: 'a1' } }, '하위 작업 완료'),
  ]);

  const betaSub = join(repo.beta, 'sub', 'dir');
  writeSession(sb, betaSub, SID.B, [
    userText({ sid: SID.B, cwd: betaSub, ts: kst(DATE, '13:00') }, '베타 설정 정리해 줘'),
    assistantText({ sid: SID.B, cwd: betaSub, ts: kst(DATE, '13:30') }, '정리했어요'),
    aiTitle(SID.B, '베타 설정 정리 (자동 제목)'),
  ]);
  writeSession(sb, repo.alphaWt, SID.C, [
    userText({ sid: SID.C, cwd: repo.alphaWt, ts: kst(DATE, '15:00'), branch: 'wt-branch' }, '워크트리에서 기능 만들기'),
    assistantText({ sid: SID.C, cwd: repo.alphaWt, ts: kst(DATE, '15:20'), branch: 'wt-branch' }, '만들었어요'),
  ]);
  writeSession(sb, scratch, SID.D, [
    userText({ sid: SID.D, cwd: scratch, ts: kst(DATE, '16:00') }, '메모 정리'),
    assistantText({ sid: SID.D, cwd: scratch, ts: kst(DATE, '16:05') }, '정리했어요'),
  ]);
  writeSession(sb, repo.alpha, SID.E, [
    userText({ sid: SID.E, cwd: repo.alpha, ts: kst('2026-10-16', '00:30') }, '자정 넘어 작업'),
    assistantText({ sid: SID.E, cwd: repo.alpha, ts: kst('2026-10-16', '01:10') }, '끝났어요'),
  ]);
  writeSession(sb, repo.alpha, SID.F, [userText({ sid: SID.F, cwd: repo.alpha, ts: kst('2026-10-14', '20:00') }, '어제 작업')]);
  const goneWt = join(repo.alpha, '.claude', 'worktrees', 'gone');
  writeSession(sb, goneWt, SID.G, [userText({ sid: SID.G, cwd: goneWt, ts: kst(DATE, '17:00') }, '사라진 워크트리 작업')]);
  const gone = join(sb.root, 'nowhere', 'gone');
  writeSession(sb, gone, SID.H, [userText({ sid: SID.H, cwd: gone, ts: kst(DATE, '18:00') }, '없어진 폴더 작업')]);
});

after(() => sb?.cleanup());

/** 그 저장소의 git log에서 같은 작성자이고 작성 시각(author date)이 [start, end) 안인 커밋 (PRD F1 완료 기준) */
function gitLogHashes(dir: string, start: string, end: string): string[] {
  const out = git(sb, dir, ['log', '--branches', `--author=${ME}`, '--format=%H%x09%aI']);
  const s = Date.parse(start);
  const e = Date.parse(end);
  return out
    ? out
        .split('\n')
        .map((l) => l.split('\t') as [string, string])
        .filter(([, at]) => Date.parse(at) >= s && Date.parse(at) < e)
        .map(([hash]) => hash)
        .sort()
    : [];
}

test('F1: 날짜를 지정하면 네트워크 없이 그날 일지를 만들고, 커밋이 git log와 개수·해시가 같아요', () => {
  const r = runCli(sb, ['--date', DATE, '--root', work]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stderr.includes('NETWORK_ATTEMPT'), r.stderr);
  // 건너뛴 줄 = 모르는 줄 종류 2 + 읽을 수 없는 줄 1 + 꼭 필요한 값(cwd)이 없는 요청 줄 1, 이유별로 나눠 보여 줘요 (처음 본 12가지는 세지 않아요, A13)
  assert.match(r.stdout, /건너뛴 줄 4개/, '처음 본 12가지는 건너뛴 줄로 세지 않아요');
  assert.match(
    rowText(r.stdout, '기록 형식'),
    /건너뛴 줄 4개 \(모르는 줄 종류 2 · 읽을 수 없는 줄 1 · 시각·폴더·세션 값이 없는 줄 1\) \(모르는 줄 종류: another-new-type, future-thing\)$/,
  );
  assert.ok(!/옛 형식|기준\(2\.1\.299\)보다 새로워요/.test(r.stdout), '모두 기준 버전이면 형식 알림이 없어요');
  assert.match(r.stdout, /세션 7개 · 저장소 3개 · 커밋 7개/);
  // S3 끝에 검사 명령 안내 한 줄. 이름·이메일 가리기를 끈 채 만들어서 그 아래에 A19 안내가 이어져요(PRD S3, I-01).
  assert.equal(lastCheckRow(r.stdout), `검사 공개 전에 cc-worklog check로 확인하세요 ${MAKE_TEXT.checkIdentityAll}`, r.stdout);
  assert.match(r.stdout, /서브 에이전트 기록 1개는 부모 세션에 묶음/);

  const mdPath = join(sb.dataDir, 'worklogs', `${DATE}.md`);
  const day = readJson<DayLog>(join(sb.dataDir, 'worklogs', `${DATE}.json`));
  assert.ok(existsSync(mdPath));
  const md = readFileSync(mdPath, 'utf8');

  // 프로젝트 순서: 첫 활동이 이른 순, 저장소 없음은 맨 끝
  assert.deepEqual(
    day.projects.map((p) => p.name),
    ['gamma', 'alpha', 'beta', '저장소 없음'],
  );

  // 하루 경계(새벽 3시) 기준 그날 범위
  const start = '2026-10-15T03:00:00+09:00';
  const end = '2026-10-16T03:00:00+09:00';
  for (const name of ['alpha', 'beta', 'gamma'] as const) {
    const expected = gitLogHashes(repo[name], start, end);
    const p = day.projects.find((x) => x.name === name);
    assert.ok(p, `${name} 프로젝트가 없어요`);
    const got = p.commits.map((c) => c.hash).sort();
    assert.deepEqual(got, expected, `${name} 커밋 목록이 git log와 달라요`);
    for (const c of p.commits) assert.ok(md.includes(c.hash.slice(0, 7)), `${name} ${c.hash} 가 마크다운에 없어요`);
  }
  const alpha = day.projects.find((p) => p.name === 'alpha')!;
  assert.deepEqual(alpha.commits.map((c) => c.hash).sort(), [h.a1, h.a2, h.wt, h.aLate].sort());
  assert.ok(!alpha.commits.some((c) => c.hash === h.other || c.hash === h.alphaEarly || c.hash === h.aNext));
  assert.equal(alpha.commits.find((c) => c.hash === h.a2)?.branch, 'feature');

  // 하위 폴더·워크트리(있는 것·없어진 것)도 같은 프로젝트로 묶어요
  assert.deepEqual(alpha.sessions.map((s) => s.sessionId).sort(), [SID.A, SID.C, SID.E, SID.G].sort());
  const beta = day.projects.find((p) => p.name === 'beta')!;
  assert.deepEqual(beta.sessions.map((s) => s.sessionId), [SID.B]);
  assert.equal(beta.sessions[0]!.title, '베타 설정 정리 (자동 제목)', 'custom-title이 없으면 ai-title을 제목으로 써요 (A5)');
  assert.equal(beta.commits.length, 0, '커밋 없는 세션');
  const gamma = day.projects.find((p) => p.name === 'gamma')!;
  assert.equal(gamma.sessions.length, 0, '세션 없는 커밋');
  assert.deepEqual(gamma.commits.map((c) => c.hash).sort(), [h.g1, h.g2, h.gRebased].sort(), '작성 시각 기준이에요');
  assert.ok(!gamma.commits.some((c) => c.hash === h.gPicked));
  const none = day.projects.find((p) => p.noRepo)!;
  assert.deepEqual(none.sessions.map((s) => s.sessionId).sort(), [SID.D, SID.H].sort());

  // 세션 요약 재료
  const sa = alpha.sessions.find((s) => s.sessionId === SID.A)!;
  assert.equal(sa.title, '로그인 버그 고치기');
  assert.equal(sa.firstRequest, '로그인 할 때 500 오류가 나요. 고쳐 줘');
  assert.equal(sa.lastRequest, '테스트 돌려 줘');
  assert.equal(sa.requests, 2);
  assert.deepEqual(sa.lines, { added: 120, removed: 30, wholeSession: false });
  assert.deepEqual(sa.usage, { ms: 5_400_000, source: 'cost-state', wholeSession: false });
  assert.equal(sa.subagents, 1);
  assert.deepEqual(sa.branches, ['main']);
  assert.equal(sa.start, kst(DATE, '09:10'));
  assert.equal(sa.end, kst(DATE, '11:40'));

  // 마크다운 모양
  assert.match(md, /^# 2026-10-15 \(목\) 작업일지/);
  assert.match(md, /09:10–11:40 \*\*세션\*\* 로그인 버그 고치기/);
  assert.match(md, /사용 1시간 30분 · \+120 \/ -30/);
  assert.match(md, /00:30\(다음 날\)–01:10\(다음 날\) \*\*세션\*\* \(제목 없음\)/);
  assert.match(md, /\*\*커밋\*\* `[0-9a-f]{7}` `feature` feature 작업/);
  assert.ok(!md.includes('어제 작업'), '다른 날 세션은 넣지 않아요');
  // 보관본에서 빠진 것은 일지에도 없어요
  assert.ok(!md.includes('BIG TOOL OUTPUT') && !md.includes('생각 과정 비밀 메모'));
  assert.match(md, /13:00–13:30 \*\*세션\*\* 베타 설정 정리 \(자동 제목\)/);
  assert.ok(!md.includes('자동 제목은 쓰지 않아요'), 'custom-title이 있으면 ai-title은 쓰지 않아요');
  // pr-link는 이번 일지에 쓰지 않아요(Q19). 나머지 11가지도 일지 재료가 아니에요.
  const json = readFileSync(join(sb.dataDir, 'worklogs', `${DATE}.json`), 'utf8');
  for (const text of [md, json]) {
    assert.ok(!text.includes('octo-zq/alpha-pr') && !text.includes('pull/7'), 'pr-link가 일지에 나오면 안 돼요');
    assert.ok(!text.includes('SEEN-TYPE-BODY'), '처음 본 줄 종류의 내용이 일지에 나오면 안 돼요');
  }
});

test('F1: 다른 날짜는 그날 재료만 담아요 (새벽 3시 전 커밋은 전날)', () => {
  const r = runCli(sb, ['--date', '2026-10-14', '--root', work]);
  assert.equal(r.code, 0, r.stderr);
  const day = readJson<DayLog>(join(sb.dataDir, 'worklogs', '2026-10-14.json'));
  const alpha = day.projects.find((p) => p.name === 'alpha')!;
  assert.deepEqual(alpha.sessions.map((s) => s.sessionId), [SID.F]);
  assert.deepEqual(alpha.commits.map((c) => c.hash).sort(), [h.alphaPrevDay, h.alphaEarly].sort());
});

test('F1: git이 없으면 세션만으로 일지를 만들고 그 사실을 알려요', () => {
  const sb2 = { ...sb, dataDir: join(sb.root, 'data-nogit') };
  const r = runCli(sb2, ['--date', DATE, '--root', work], { CC_WORKLOG_GIT: join(sb.root, 'no-such-git.exe') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[알림\] git을 찾지 못해 세션만으로 만들었어요/);
  const day = readJson<DayLog>(join(sb2.dataDir, 'worklogs', `${DATE}.json`));
  assert.equal(day.gitAvailable, false);
  assert.equal(day.totals.commits, 0);
  assert.equal(day.totals.sessions, 7);
  assert.ok(day.projects.some((p) => p.name === 'alpha' && p.sessions.length === 4), 'git 없이도 저장소로 묶어요');
  assert.match(readFileSync(join(sb2.dataDir, 'worklogs', `${DATE}.md`), 'utf8'), /git을 찾지 못해 커밋 없이 세션만 담았어요/);
});

test('F1: 세션 기록 폴더가 없으면 멈추지 않고 알린 뒤 커밋만으로 일지를 만들어요 (S3)', () => {
  const sb2 = { ...sb, claudeDir: join(sb.root, 'no-claude-here'), dataDir: join(sb.root, 'data-noclaude') };
  const r = runCli(sb2, ['--date', DATE, '--root', work]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[알림\] 세션 기록 폴더를 찾지 못해 커밋만으로 만들었어요/);
  const day = readJson<DayLog>(join(sb2.dataDir, 'worklogs', `${DATE}.json`));
  assert.equal(day.totals.sessions, 0);
  assert.equal(day.totals.commits, 7);
});

test('F1: 세션도 커밋도 없는 날은 일지 파일을 만들지 않고 알려요', () => {
  const r = runCli(sb, ['--date', '2026-09-01', '--root', work]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /만든 일지 없음/);
  assert.ok(!existsSync(join(sb.dataDir, 'worklogs', '2026-09-01.md')));
});

test('F1: 여러 날 세션은 "(세션 전체)", 사용 시간이 없으면 "약 N분(추정)", 마지막 요청은 그날 요청, 지워진 워크트리는 원래 저장소로 (A4·A5)', () => {
  const s = sandbox();
  try {
    const w = join(s.root, 'work');
    const delta = join(w, 'delta');
    const deltaWt = join(w, 'delta-wt');
    initRepo(s, delta, ME);
    commitAt(s, delta, 'delta init', '2026-10-13T09:00:00+09:00');
    git(s, delta, ['worktree', 'add', '-q', deltaWt, '-b', 'wt2']);
    const multi = { sid: 'a5000000-0000-4000-8000-000000000001', cwd: delta };
    writeSession(s, delta, multi.sid, [
      userText({ ...multi, ts: kst(DATE, '22:00') }, '그날 마지막 요청'),
      assistantText({ ...multi, ts: kst(DATE, '22:10') }, '했어요'),
      userText({ ...multi, ts: kst('2026-10-16', '10:00') }, '다음 날 요청'),
      costState(multi.sid, 50, 10, 7_200_000),
      lastPrompt(multi.sid, '다음 날 요청'),
    ]);
    const est = { sid: 'a5000000-0000-4000-8000-000000000002', cwd: delta };
    writeSession(s, delta, est.sid, [
      userText({ ...est, ts: kst(DATE, '10:00') }, '추정 시간 세션'),
      assistantText({ ...est, ts: kst(DATE, '10:20') }, '답'),
      assistantText({ ...est, ts: kst(DATE, '12:00') }, '긴 쉼 뒤 답'),
      aiTitle(est.sid, '추정 세션 자동 제목'),
    ]);
    // 서브 에이전트 기록도 부모 세션 아이디를 써요. 그 안의 제목 줄은 부모 세션 제목으로 쓰지 않아요.
    writeSubagent(s, delta, est.sid, 'e1', [
      userText({ ...est, ts: kst(DATE, '10:05'), extra: { isSidechain: true, agentId: 'e1' } }, '하위 작업'),
      customTitle(est.sid, '서브 에이전트 제목은 쓰지 않아요'),
      aiTitle(est.sid, '서브 에이전트 자동 제목도 쓰지 않아요'),
    ]);
    const resumed = { sid: 'a5000000-0000-4000-8000-000000000003', cwd: delta };
    writeSession(s, delta, resumed.sid, [assistantText({ ...resumed, ts: kst(DATE, '15:00') }, '이어서 답'), lastPrompt(resumed.sid, '이어서 해 줘')]);
    const wt = { sid: 'a5000000-0000-4000-8000-000000000004', cwd: deltaWt };
    writeSession(s, deltaWt, wt.sid, [userText({ ...wt, ts: kst(DATE, '16:00') }, '워크트리 작업'), assistantText({ ...wt, ts: kst(DATE, '16:05') }, '끝')]);
    // 워크트리 폴더를 지워요 (git worktree prune은 하지 않아서 원래 저장소에 기록이 남아요)
    rmSync(deltaWt, { recursive: true, force: true });

    const r = runCli(s, ['--date', DATE, '--root', w]);
    assert.equal(r.code, 0, r.stderr);
    const day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${DATE}.json`));
    assert.deepEqual(
      day.projects.map((p) => p.name),
      ['delta'],
      '지워진 워크트리 세션도 원래 저장소로 묶어요',
    );
    const sessions = day.projects[0]!.sessions;
    const sm = sessions.find((x) => x.sessionId === multi.sid)!;
    assert.deepEqual(sm.usage, { ms: 7_200_000, source: 'cost-state', wholeSession: true });
    assert.deepEqual(sm.lines, { added: 50, removed: 10, wholeSession: true });
    assert.equal(sm.lastRequest, '그날 마지막 요청', 'last-prompt(다른 날 요청)보다 그날 요청을 먼저 써요');
    const se = sessions.find((x) => x.sessionId === est.sid)!;
    assert.deepEqual(se.usage, { ms: 20 * 60_000, source: 'estimate', wholeSession: false }, '30분 넘는 쉼은 빼요');
    assert.equal(se.title, '추정 세션 자동 제목', '서브 에이전트 기록의 제목 줄은 부모 제목을 덮지 않아요');
    assert.equal(se.subagents, 1);
    const sr = sessions.find((x) => x.sessionId === resumed.sid)!;
    assert.equal(sr.lastRequest, '이어서 해 줘', '그날 요청이 없고 하루 안 세션이면 last-prompt를 써요');
    assert.ok(sessions.some((x) => x.sessionId === wt.sid));
    const md = readFileSync(join(s.dataDir, 'worklogs', `${DATE}.md`), 'utf8');
    assert.match(md, /사용 2시간\(세션 전체\) · \+50 \/ -10\(세션 전체\)/);
    assert.match(md, /사용 약 20분\(추정\)/);
  } finally {
    s.cleanup();
  }
});

test('S3 기록 형식: 기준보다 옛 버전은 [알림] 없이 "옛 형식 파일 N개", 새 버전이 있을 때만 [알림]으로 가장 새 버전 (A13)', () => {
  const s = sandbox();
  try {
    const cwd = join(s.root, 'fmt');
    mkdirSync(cwd);
    const file = (sid: string, version: string, hhmm: string) =>
      writeSession(s, cwd, sid, [
        userText({ sid, cwd, ts: kst(DATE, hhmm), version }, `형식 ${version}`),
        assistantText({ sid, cwd, ts: kst(DATE, hhmm), version }, '답'),
      ]);
    // 한 파일 안에서 버전이 바뀌면 그 파일의 가장 새 버전으로 세요.
    const mixed = 'f0000000-0000-4000-8000-000000000003';
    writeSession(s, cwd, mixed, [
      userText({ sid: mixed, cwd, ts: kst(DATE, '11:00'), version: '2.1.250' }, '옛 버전으로 시작'),
      assistantText({ sid: mixed, cwd, ts: kst(DATE, '11:05'), version: '2.1.299' }, '기준 버전으로 끝'),
    ]);
    file('f0000000-0000-4000-8000-000000000001', '2.1.260', '09:00');
    file('f0000000-0000-4000-8000-000000000002', '2.1.299', '10:00');
    let r = runCli(s, ['archive']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /기록 형식 {3}기준 2\.1\.299 · 옛 형식 파일 1개 · 건너뛴 줄 0개/);
    assert.ok(!r.stdout.includes('[알림]'), `옛 버전만 섞였으면 [알림]이 없어요: ${r.stdout}`);

    // 기준보다 새 버전이 있으면 [알림]으로 그중 가장 새 버전을 보여 줘요 (2.2.10 > 2.2.9).
    file('f0000000-0000-4000-8000-000000000004', '2.2.9', '12:00');
    file('f0000000-0000-4000-8000-000000000005', '2.2.10', '13:00');
    r = runCli(s, ['archive']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /옛 형식 파일 1개/);
    // [알림]은 80칸을 넘으면 다음 줄로 넘어가서, 이어지는 줄까지 이어 붙여 봐요.
    assert.match(rowText(r.stdout, '[알림]'), /^\[알림\] 기록 형식 2\.2\.10이 이 도구의 기준\(2\.1\.299\)보다 새로워요\. 건너뛴 줄이 많으면 도구를 새 버전으로 바꿔 주세요\./);
    assert.ok(!r.stdout.includes('2.2.9'), '기준보다 새 버전이 여럿이면 가장 새 버전 하나만 보여 줘요');
    assert.ok(!r.stdout.includes('2.1.260') && !r.stdout.includes('2.1.250'), '옛 버전 번호는 보여 주지 않아요');
  } finally {
    s.cleanup();
  }
});

test('CLI: 잘못된 날짜·명령은 사용법 안내와 함께 실패해요', () => {
  const r1 = runCli(sb, ['--date', '2026-13-40']);
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /\[실패\] --date는/);
  const r2 = runCli(sb, ['nope']);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /모르는 명령이에요/);
});
