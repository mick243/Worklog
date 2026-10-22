// F3 완료 기준 시험:
// 새 기록이 없을 때 보관을 다시 실행하면 보관본이 바뀌지 않고, 원본 세션 파일을 지운 뒤에도 보관본만으로
// 같은 날짜 일지가(ai-title로 정한 제목 포함) 같은 설정에서 똑같이 만들어져요. 보관 전후 원본 파일의 내용·수정 시각이 그대로이고,
// 보관본에는 도구 출력 본문과 첨부 줄이 없고 pr-link 줄은 남아 있으며(일지에는 나오지 않아요) F2 검사에서 0건이에요.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ArchiveIndex } from '../src/archive/archive.js';
import { fakeSecrets } from '../src/redact/samples.js';
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
  fingerprint,
  initRepo,
  kst,
  lastPrompt,
  listFilesRec,
  OTHER_SEEN_TYPES,
  prLink,
  readJson,
  runCli,
  sandbox,
  seenTypeLine,
  snapshotLine,
  systemLine,
  toolResult,
  userBlocks,
  userText,
  writeSession,
  writeSubagent,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-15';
const f = fakeSecrets();
const TOOL_OUTPUT = 'TOOL-OUTPUT-BODY-ZQX '.repeat(200);
const ATTACHMENT = 'ATTACHMENT-BODY-ZQX';
const THINKING = 'THINKING-BODY-ZQX';
const SNAPSHOT = 'SNAPSHOT-BODY-ZQX';
const SYSTEM = 'SYSTEM-BODY-ZQX';
const WRITE_CONTENT = 'WRITE-CONTENT-BODY-ZQX';
const IMAGE_DATA = 'iVBORw0KGgoIMAGEDATAZQX';
const SID_A = 'f3000000-0000-4000-8000-00000000000a';
const SID_B = 'f3000000-0000-4000-8000-00000000000b';
const PR_REPO = 'octo-zq/f3-pr';
const AI_TITLE = '오래된 세션 자동 제목';

let sb: Sandbox;
let repoDir: string;
let originals: string[] = [];

function archiveFiles(dataDir = sb.dataDir): string[] {
  return listFilesRec(join(dataDir, 'archive', 'projects'));
}

function snapshot(files: string[]) {
  return Object.fromEntries(files.map((p) => [p, fingerprint(p)]));
}

before(() => {
  sb = sandbox();
  repoDir = join(sb.root, 'work', 'app');
  initRepo(sb, repoDir, 'dev.kim@example.test');
  commitAt(sb, repoDir, '보관 시험 커밋', '2026-10-15T10:30:00+09:00');
  // Claude Code 설정의 cleanupPeriodDays를 읽어요 (가짜 설정 폴더).
  mkdirSync(sb.claudeDir, { recursive: true });
  writeFileSync(join(sb.claudeDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }));

  const A = { sid: SID_A, cwd: repoDir };
  const a = writeSession(sb, repoDir, SID_A, [
    userBlocks({ ...A, ts: kst(DATE, '10:00') }, [
      { type: 'text', text: `화면이 깨져요. 토큰 ${f.githubToken}` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA } },
    ]),
    assistantThinking({ ...A, ts: kst(DATE, '10:01') }, THINKING),
    assistantToolUse({ ...A, ts: kst(DATE, '10:02') }, 'toolu_1', 'Bash', { command: 'npm run build', description: '빌드' }),
    toolResult({ ...A, ts: kst(DATE, '10:03') }, 'toolu_1', TOOL_OUTPUT),
    assistantToolUse({ ...A, ts: kst(DATE, '10:04') }, 'toolu_2', 'Write', { file_path: join(repoDir, 'a.ts'), content: WRITE_CONTENT }),
    attachmentLine({ ...A, ts: kst(DATE, '10:05') }, ATTACHMENT),
    systemLine({ ...A, ts: kst(DATE, '10:05') }, SYSTEM),
    snapshotLine(SNAPSHOT),
    assistantText({ ...A, ts: kst(DATE, '10:06') }, '고쳤어요'),
    customTitle(SID_A, '화면 깨짐 고치기'),
    costState(SID_A, 40, 5, 360_000),
    lastPrompt(SID_A, '화면이 깨져요'),
    // pr-link는 보관본에 남기고(가린 뒤), 나머지 처음 본 줄 종류 11가지는 빼요 (A7·Q19).
    prLink(SID_A, kst(DATE, '10:07'), 42, PR_REPO, `https://github.com/${PR_REPO}/pull/42?access_token=${f.githubToken}`),
    ...OTHER_SEEN_TYPES.map((t) => seenTypeLine(t, SID_A, kst(DATE, '10:08'))),
  ]);
  const sub = writeSubagent(sb, repoDir, SID_A, 'x1', [
    userText({ ...A, ts: kst(DATE, '10:02'), extra: { isSidechain: true, agentId: 'x1' } }, '하위 조사'),
    toolResult({ ...A, ts: kst(DATE, '10:02'), extra: { isSidechain: true, agentId: 'x1' } }, 'toolu_9', TOOL_OUTPUT),
    assistantText({ ...A, ts: kst(DATE, '10:03'), extra: { isSidechain: true, agentId: 'x1' } }, '조사 끝'),
  ]);
  // 오래된 세션: 마지막 수정이 25일 전 → 삭제 예상일까지 5일 (경고 대상)
  const B = { sid: SID_B, cwd: repoDir };
  const b = writeSession(sb, repoDir, SID_B, [
    userText({ ...B, ts: kst(DATE, '15:00') }, '오래된 세션 요청'),
    assistantText({ ...B, ts: kst(DATE, '15:10') }, '답변'),
    aiTitle(SID_B, AI_TITLE), // custom-title 없이 ai-title만 있는 세션
  ]);
  const old = new Date(Date.now() - 25 * 86_400_000);
  utimesSync(b, old, old);
  originals = [a, sub, b];
});

after(() => sb?.cleanup());

test('F3: 보관 전후 원본의 내용·수정 시각이 그대로이고, 삭제 임박 세션을 알려 줘요', () => {
  const before = snapshot(originals);
  const r = runCli(sb, ['archive']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /보관 {8}새로 2개 · 이어 붙임 0개 · 그대로 0개/);
  assert.match(r.stdout, /삭제 예상일이 7일 안이던 세션 1개를 이번에 보관했어요/);
  assert.ok(!r.stdout.includes('[경고]'), '보관에 성공했으면 경고는 없어요 (F3)');
  assert.match(r.stdout, /서브 에이전트 기록 1개는 부모 세션에 묶음/);
  assert.match(r.stdout, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/, 'S3 끝에 검사 명령 안내 한 줄');
  assert.deepEqual(snapshot(originals), before, '원본이 바뀌었어요');
  const idx = readJson<ArchiveIndex>(join(sb.dataDir, 'archive', 'index.json'));
  assert.equal(idx.cleanupPeriodDays, 30);
  assert.equal(Object.keys(idx.files).length, 3);
});

test('F3: 보관본에는 도구 출력 본문·첨부·스냅샷·생각 과정·그림이 없고 빠진 자리만 표시하며, ai-title·pr-link 줄은 남겨요', () => {
  const files = archiveFiles();
  assert.equal(files.length, 3);
  const all = files.map((p) => readFileSync(p, 'utf8')).join('\n');
  for (const gone of ['TOOL-OUTPUT-BODY', ATTACHMENT, THINKING, SNAPSHOT, SYSTEM, WRITE_CONTENT, IMAGE_DATA, 'toolUseResult', '"attachment"', 'file-history-snapshot', 'signature', 'SEEN-TYPE-BODY']) {
    assert.ok(!all.includes(gone), `보관본에 ${gone} 가 남았어요`);
  }
  assert.ok(!all.includes(f.githubToken), '보관본은 가린 상태예요');
  for (const keep of ['"omitted":"도구 출력"', '"omitted":"그림"', '"omitted":"생각 과정"', '"command":"npm run build"', '"content":"[생략: 긴 값]"', '화면 깨짐 고치기', 'cost-state', 'last-prompt', '[가림:GitHub 토큰]']) {
    assert.ok(all.includes(keep), `보관본에 ${keep} 가 없어요`);
  }
  const kept = all
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const o of kept) {
    assert.ok(['user', 'assistant', 'custom-title', 'ai-title', 'last-prompt', 'cost-state', 'pr-link'].includes(o.type as string), `남기지 않는 줄 종류: ${o.type}`);
    if (o.type === 'user' || o.type === 'assistant') {
      for (const k of ['timestamp', 'cwd', 'sessionId', 'gitBranch', 'version']) assert.ok(k in o, `${k} 없음`);
    }
  }
  // ai-title 줄은 시각·작업 폴더 없이 그대로 남아요 (A7).
  assert.ok(kept.some((o) => o.type === 'ai-title' && o.aiTitle === AI_TITLE && o.sessionId === SID_B), 'ai-title 줄이 없어요');
  // pr-link 줄은 칸 그대로 남고 F2로 가려져요 (Q19). 나머지 처음 본 줄 종류는 없어요.
  const pr = kept.filter((o) => o.type === 'pr-link');
  assert.equal(pr.length, 1, 'pr-link 줄은 하나 남아요');
  assert.equal(pr[0]!.prNumber, 42);
  assert.equal(pr[0]!.prRepository, PR_REPO);
  assert.equal(pr[0]!.sessionId, SID_A);
  assert.equal(pr[0]!.timestamp, kst(DATE, '10:07'));
  assert.ok(String(pr[0]!.prUrl).startsWith(`https://github.com/${PR_REPO}/pull/42?access_token=[가림:`), String(pr[0]!.prUrl));
  for (const t of OTHER_SEEN_TYPES) assert.ok(!kept.some((o) => o.type === t), `${t} 줄은 보관본에서 빼요`);
  // 보관본이 원본보다 훨씬 작아요
  const srcSize = originals.reduce((n, p) => n + fingerprint(p).size, 0);
  const archSize = files.reduce((n, p) => n + fingerprint(p).size, 0);
  assert.ok(archSize < srcSize / 2, `보관본 ${archSize}B / 원본 ${srcSize}B`);
});

test('F3: 새 기록이 없으면 보관을 다시 해도 보관본이 바뀌지 않아요', () => {
  const before = snapshot(archiveFiles());
  const r = runCli(sb, ['archive']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /새로 0개 · 이어 붙임 0개 · 그대로 2개/);
  assert.deepEqual(snapshot(archiveFiles()), before);
});

test('F3: 늘어난 부분만 더하고 중복이 없어요 (끝이 덜 쓰인 줄은 다음에)', () => {
  const [a] = originals;
  const linesBefore = readFileSync(archiveFiles().find((p) => p.endsWith(`${SID_A}.jsonl`))!, 'utf8').trim().split('\n').length;
  const A = { sid: SID_A, cwd: repoDir };
  appendFileSync(a!, `${userText({ ...A, ts: kst(DATE, '18:00') }, '저녁에 이어서 작업')}\n`);
  // 아직 쓰는 중인 줄 (\n 없음)
  appendFileSync(a!, assistantText({ ...A, ts: kst(DATE, '18:01') }, '이어서 답변'));
  let r = runCli(sb, ['archive']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /새로 0개 · 이어 붙임 1개 · 그대로 1개/);
  const archA = archiveFiles().find((p) => p.endsWith(`${SID_A}.jsonl`))!;
  let lines = readFileSync(archA, 'utf8').trim().split('\n');
  assert.equal(lines.length, linesBefore + 1, '완전한 줄 하나만 더해요');
  appendFileSync(a!, '\n');
  r = runCli(sb, ['archive']);
  assert.equal(r.code, 0, r.stderr);
  lines = readFileSync(archA, 'utf8').trim().split('\n');
  assert.equal(lines.length, linesBefore + 2);
  const uuids = lines.map((l) => (JSON.parse(l) as { uuid?: string }).uuid).filter(Boolean);
  assert.equal(new Set(uuids).size, uuids.length, '중복 줄이 없어요');
});

test('F3: 원본을 지운 뒤에도 보관본만으로 같은 날짜 일지가 똑같이 나오고, 검사는 0건이에요', () => {
  let r = runCli(sb, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  const mdPath = join(sb.dataDir, 'worklogs', `${DATE}.md`);
  const jsonPath = join(sb.dataDir, 'worklogs', `${DATE}.json`);
  const md1 = readFileSync(mdPath, 'utf8');
  const day1 = readJson<DayLog>(jsonPath);
  assert.ok(md1.includes('저녁에 이어서 작업') && md1.includes('화면 깨짐 고치기'));
  assert.ok(md1.includes(`**세션** ${AI_TITLE}`), 'ai-title로 정한 제목이 일지에 있어요');
  for (const text of [md1, readFileSync(jsonPath, 'utf8')]) assert.ok(!text.includes(PR_REPO) && !text.includes('pull/42'), 'pr-link는 일지에 나오지 않아요');

  rmSync(sb.projectsDir, { recursive: true, force: true });
  mkdirSync(sb.projectsDir, { recursive: true });
  r = runCli(sb, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /원본은 지워지고 보관본만 남은 세션 2개/);
  const md2 = readFileSync(mdPath, 'utf8');
  const day2 = readJson<DayLog>(jsonPath);
  assert.equal(md2, md1, '원본을 지운 뒤 일지 마크다운이 달라졌어요 (ai-title 제목 포함)');
  assert.deepEqual({ ...day2, generatedAt: '' }, { ...day1, generatedAt: '' });

  const idx = readJson<ArchiveIndex>(join(sb.dataDir, 'archive', 'index.json'));
  assert.ok(Object.values(idx.files).every((e) => e.originalExists === false));

  const c = runCli(sb, ['check']);
  assert.equal(c.code, 0, c.stdout);
  assert.match(c.stdout, /^ {3}남은 의심 +0건$/m);
  assert.match(c.stdout, /\[통과\]/);
});

test('F3: 큰 세션 파일도 한 번에 메모리에 올리지 않고 끝까지 보관해요', () => {
  const sbBig = sandbox();
  try {
    const cwd = join(sbBig.root, 'big');
    mkdirSync(cwd);
    const B = { sid: 'big00000-0000-4000-8000-000000000001', cwd };
    const lines: string[] = [];
    const chunk = 'x'.repeat(400_000);
    for (let i = 0; i < 100; i++) {
      const ts = new Date(Date.parse(kst(DATE, '09:00')) + i * 60_000).toISOString();
      lines.push(userText({ ...B, ts }, `요청 ${i}`));
      lines.push(toolResult({ ...B, ts }, `toolu_${i}`, chunk));
    }
    const file = writeSession(sbBig, cwd, B.sid, lines);
    const size = fingerprint(file).size;
    assert.ok(size > 70_000_000, `시험 파일 ${size}B`);
    // 힙을 64MB로 묶어도(파일은 약 80MB) 끝까지 돌아요.
    const r = runCli(sbBig, ['archive'], {}, ['--max-old-space-size=64']);
    assert.equal(r.code, 0, r.stderr);
    const arch = listFilesRec(join(sbBig.dataDir, 'archive', 'projects'));
    assert.equal(arch.length, 1);
    assert.ok(fingerprint(arch[0]!).size < 200_000, '도구 출력을 빼서 보관본이 작아요');
  } finally {
    sbBig.cleanup();
  }
});
