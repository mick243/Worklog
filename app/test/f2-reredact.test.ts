// F2 완료 기준 시험 — 보관본 다시 가리기 (A16, PRD 5장 제약):
// 원본이 남은 보관본과 원본을 지운 보관본 모두에서, 보관본에 들어간 가짜 값에 맞는 사용자 패턴을 새로 더하고 다시 가리기를 실행하면
// 보관본과 이미 만든 일지(마크다운·화면용 일지 데이터)에서 그 값이 사라지고 검사가 통과해요.
// 다시 쓰기 전에 보관본·일지별, 종류별 바뀔 자리 수를 값 없이 보여 주고, 확인을 거절하거나 확인을 물을 수 없는 환경에서
// --yes 없이 실행하면 데이터 폴더의 어떤 파일도 바뀌거나 새로 생기지 않아요(종료 코드 1).
// 확인하거나 --yes를 줬을 때만 다시 쓰고, 실제로 바뀐 자리 수는 먼저 보여 준 수와 같아요.
// 두 번 실행해도 결과가 같고(두 번째는 바뀔 자리 0개라 묻지 않고 끝나요), 남아 있는 원본 세션 파일의 내용·수정 시각은 그대로예요.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ArchiveIndex } from '../src/archive/archive.js';
import { runRedact, type RedactIo } from '../src/commands/redact.js';
import { resolveConfig } from '../src/config.js';
import { JOURNAL_NAME, STAGED_SUFFIX } from '../src/redact/journal.js';
import { countMarkers, marker } from '../src/redact/marker.js';
import { fakeSecrets } from '../src/redact/samples.js';
import { lockPathFor } from '../src/util/lock.js';
import { markdownHashOf } from '../src/worklog/edited.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  APP_DIR,
  assistantText,
  assistantToolUse,
  commitAt,
  customTitle,
  fingerprint,
  initRepo,
  kst,
  listFilesRec,
  readJson,
  runCli,
  sandbox,
  snapshotDir,
  userText,
  writeSession,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-15';
const ME = 'dev.kim@example.test';
const f = fakeSecrets();
/** 내장 규칙에는 안 걸리는 사내 토큰 모양 가짜 값 (형식만 흉내 냈어요) */
const CORP = /CORP-[0-9]{8}/g;
const T1 = 'CORP-12345678';
const T2 = 'CORP-87654321';
const T3 = 'CORP-55554444';
const LABEL = '사내 토큰';
const M = marker(LABEL);
const PATTERNS = JSON.stringify([{ name: LABEL, pattern: 'CORP-[0-9]{8}', samples: ['CORP-00000000'] }]);
const SID_KEEP = 'ab000000-0000-4000-8000-00000000000a';
const SID_GONE = 'ab000000-0000-4000-8000-00000000000b';

function cfgOf(s: Sandbox) {
  return resolveConfig({ claudeDir: s.claudeDir, dataDir: s.dataDir });
}

function fakeIo(answer: string | null | (() => Promise<string | null>)): RedactIo & { out: string; err: string; asked: number } {
  const io = {
    interactive: true,
    color: false,
    errColor: false,
    out: '',
    err: '',
    asked: 0,
    write(s: string) {
      io.out += s;
    },
    writeErr(s: string) {
      io.err += s;
    },
    async ask(q: string) {
      io.out += q;
      io.asked++;
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  return io;
}

/** 확인 출력의 바뀔 파일 줄 모양: "   수  [원본 없음]  경로" (DESIGN S3 다시 가리기) */
const FILE_LINE = /^ {3} *(\d[\d,]*) {2}(원본 없음| {9}) {2}((?:archive|worklogs)\/\S+)$/;

/** 확인 출력에서 파일마다 보여 준 바뀔 자리 수 (데이터 폴더 기준 경로 → 수) */
function shownPerFile(out: string): Record<string, number> {
  const res: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const m = FILE_LINE.exec(line);
    if (m) res[m[3]!] = Number(m[1]!.replace(/,/g, ''));
  }
  return res;
}

/** 원본 없음 표시가 붙은 바뀔 보관본 줄 수 */
function goneLines(out: string): number {
  return out.split('\n').filter((l) => FILE_LINE.exec(l)?.[2] === '원본 없음').length;
}

function markerTotal(text: string): number {
  return Object.values(countMarkers(text)).reduce((a, b) => a + b, 0);
}

/** 사내 토큰 값이 든 결과물 (사용자가 쓴 patterns.json의 시험 값은 빼요) */
function filesWithCorp(dir: string): string[] {
  return listFilesRec(dir).filter((p) => !p.endsWith('patterns.json') && /CORP-[0-9]{8}/.test(readFileSync(p, 'utf8')));
}

let sb: Sandbox;
let repoDir: string;
let keepOriginal: string;
let goneOriginal: string;

before(() => {
  sb = sandbox();
  repoDir = join(sb.root, 'work', 'deploy');
  initRepo(sb, repoDir, ME);
  commitAt(sb, repoDir, `배포 설정 정리 ${T1}`, '2026-10-15T11:00:00+09:00');
  const A = { sid: SID_KEEP, cwd: repoDir };
  keepOriginal = writeSession(sb, repoDir, SID_KEEP, [
    userText({ ...A, ts: kst(DATE, '10:00') }, `사내 토큰 ${T1} 으로 배포해 줘. GitHub 토큰 ${f.githubToken} 도 있어요`),
    assistantText({ ...A, ts: kst(DATE, '10:01') }, `${T2} 도 같은 사내 토큰이에요`),
    assistantToolUse({ ...A, ts: kst(DATE, '10:02') }, 'toolu_1', 'Bash', { command: `deploy ${T1}` }),
    userText({ ...A, ts: kst(DATE, '10:05') }, '고마워요'),
    customTitle(SID_KEEP, `${T1} 배포`),
  ]);
  const scratch = join(sb.root, 'scratch');
  mkdirSync(scratch);
  const B = { sid: SID_GONE, cwd: scratch };
  goneOriginal = writeSession(sb, scratch, SID_GONE, [
    userText({ ...B, ts: kst(DATE, '14:00') }, `다른 키 ${T3} 확인해 줘`),
    assistantText({ ...B, ts: kst(DATE, '14:03') }, '확인했어요'),
  ]);
  // 패턴이 없을 때 일지·보관본을 만들어요 → 사내 토큰은 그대로 들어가요.
  const r = runCli(sb, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  // 한 세션은 원본을 지워요(되돌릴 수 없는 보관본).
  rmSync(goneOriginal);
  // 나중에 사용자 패턴을 더해요.
  writeFileSync(join(sb.dataDir, 'patterns.json'), PATTERNS);
});

after(() => sb?.cleanup());

test('다시 가리기 전: 검사가 보관본·일지에 남은 사내 토큰을 찾고 cc-worklog redact를 안내해요', () => {
  assert.ok(filesWithCorp(sb.dataDir).length >= 3, '보관본 2개와 일지에 값이 들어가 있어야 해요');
  const c = runCli(sb, ['check']);
  assert.equal(c.code, 1, c.stdout);
  assert.match(c.stdout, /archive\/projects\/.*\.jsonl/);
  assert.match(c.stdout, /worklogs\/2026-10-15\.md/);
  assert.match(c.stdout, /다음: .*cc-worklog redact/);
  assert.ok(!/CORP-[0-9]{8}/.test(c.stdout), '검사 출력에 값이 나오면 안 돼요');
});

test('확인을 물을 수 없는 환경에서 --yes 없이: 바뀔 자리 수만 보여 주고 아무 파일도 바꾸지 않아요 (종료 코드 1)', () => {
  const before = snapshotDir(sb.dataDir);
  const orig = fingerprint(keepOriginal);
  const r = runCli(sb, ['redact']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(!/CORP-[0-9]{8}/.test(r.stdout + r.stderr), '출력에 값이 나오면 안 돼요');
  const shown = shownPerFile(r.stdout);
  const archives = Object.keys(shown).filter((k) => k.startsWith('archive/'));
  assert.equal(archives.length, 2, r.stdout);
  assert.ok(shown['worklogs/2026-10-15.md']! > 0 && shown['worklogs/2026-10-15.json']! > 0, r.stdout);
  assert.match(r.stdout, new RegExp(`${LABEL} \\(사용자 패턴\\) +\\d+`), '사용자 패턴은 패턴마다 따로 세요');
  assert.equal(goneLines(r.stdout), 1, '원본이 지워진 보관본만 표시해요');
  assert.match(r.stdout, /--yes/);
  assert.match(r.stdout, /바뀐 파일은 없어요/);
  assert.deepEqual(snapshotDir(sb.dataDir), before, '데이터 폴더가 바뀌었어요');
  assert.deepEqual(fingerprint(keepOriginal), orig);
  assert.ok(!existsSync(lockPathFor(sb.dataDir)), '잠금 파일이 남았어요');
});

test('그냥 Enter·n·Ctrl+C는 거절이에요: 아무 파일도 바뀌거나 생기지 않아요 (종료 코드 1)', async () => {
  const before = snapshotDir(sb.dataDir);
  for (const answer of ['', 'n', '아니요', null]) {
    const io = fakeIo(answer);
    const code = await runRedact(cfgOf(sb), { yes: false, io });
    assert.equal(code, 1, `${String(answer)}: ${io.out}`);
    assert.equal(io.asked, 1);
    assert.match(io.out, /그만두려면 그냥 Enter를 누르세요/);
    assert.match(io.out, answer === null ? /\[취소\] 확인 질문을 끊어서 다시 쓰지 않았어요/ : /\[취소\] 다시 쓰지 않았어요\. 바뀐 파일은 없어요/);
    assert.deepEqual(snapshotDir(sb.dataDir), before, `${String(answer)}: 데이터 폴더가 바뀌었어요`);
  }
});

test('확인을 기다리는 동안에는 다른 실행(보관·일지 만들기)이 같은 데이터 폴더를 쓰지 못해요', async () => {
  const before = snapshotDir(sb.dataDir);
  const busy: Array<{ code: number | null; stderr: string }> = [];
  const io = fakeIo(async () => {
    busy.push(runCli(sb, ['archive']));
    busy.push(runCli(sb, ['--date', DATE]));
    busy.push(runCli(sb, ['redact', '--yes']));
    return 'n';
  });
  const code = await runRedact(cfgOf(sb), { yes: false, io });
  assert.equal(code, 1);
  for (const b of busy) {
    assert.equal(b.code, 1, b.stderr);
    assert.match(b.stderr, /\[실패\] 다른 cc-worklog 실행\(PID \d+, redact\)이 같은 데이터 폴더를 쓰고 있어요/);
  }
  assert.deepEqual(snapshotDir(sb.dataDir), before);
});

test('확인하면 다시 쓰고, 실제로 바뀐 자리 수가 먼저 보여 준 수와 같아요. 원본이 남은·지워진 보관본과 일지 모두에서 값이 사라져요', async () => {
  const beforeSnap = snapshotDir(sb.dataDir);
  const beforeText = Object.fromEntries(Object.keys(beforeSnap).map((k) => [k, readFileSync(join(sb.dataDir, k), 'utf8')]));
  const orig = fingerprint(keepOriginal);
  const io = fakeIo('y');
  const code = await runRedact(cfgOf(sb), { yes: false, io });
  assert.equal(code, 0, io.out);
  assert.ok(!/CORP-[0-9]{8}/.test(io.out));

  // 보여 준 수 = 실제로 늘어난 가림 표시 수 (파일마다)
  const shown = shownPerFile(io.out);
  assert.ok(Object.keys(shown).length >= 4, io.out);
  let shownTotal = 0;
  for (const [rel, n] of Object.entries(shown)) {
    const after = readFileSync(join(sb.dataDir, rel), 'utf8');
    assert.equal(markerTotal(after) - markerTotal(beforeText[rel]!), n, `${rel}: 보여 준 수와 바뀐 수가 달라요`);
    shownTotal += n;
  }
  assert.match(io.out, new RegExp(`새로 가림 +모두 ${shownTotal}개`));
  assert.match(io.out, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/);

  // 가림 표시만 늘었어요: 보관본은 값 자리만 표시로 바뀌고 나머지 바이트는 그대로예요.
  for (const rel of Object.keys(shown).filter((k) => k.startsWith('archive/'))) {
    const after = readFileSync(join(sb.dataDir, rel), 'utf8');
    assert.equal(after, beforeText[rel]!.replace(CORP, M), `${rel}: 가림 표시 말고 다른 내용이 바뀌었어요`);
  }
  // 일지 마크다운: 머리의 가린 자리 줄 말고는 값 자리만 바뀌어요.
  const mdRel = 'worklogs/2026-10-15.md';
  const mdAfter = readFileSync(join(sb.dataDir, mdRel), 'utf8').split('\n');
  const mdExpected = beforeText[mdRel]!.replace(CORP, M).split('\n');
  assert.equal(mdAfter.length, mdExpected.length);
  mdAfter.forEach((line, i) => {
    if (line.startsWith('- 가린 자리:')) assert.match(line, new RegExp(`${LABEL} \\d+`));
    else assert.equal(line, mdExpected[i], `마크다운 ${i + 1}번째 줄`);
  });
  // 화면용 일지 데이터: 글 칸의 값 자리만 바뀌고, 가린 자리 수에 사내 토큰이 더해져요.
  // 손대지 않은 일지라 손으로 고쳤는지 알아보는 해시는 새 마크다운의 해시로 바뀌어요(PRD A21, 개선 1회차 I-04).
  const jsonRel = 'worklogs/2026-10-15.json';
  const dayAfter = readJson<DayLog>(join(sb.dataDir, jsonRel));
  const dayExpected = JSON.parse(beforeText[jsonRel]!.replace(CORP, M)) as DayLog;
  assert.equal(dayAfter.markdownHash, markdownHashOf(readFileSync(join(sb.dataDir, mdRel))));
  assert.deepEqual({ ...dayAfter, redactions: {}, markdownHash: '' }, { ...dayExpected, redactions: {}, markdownHash: '' });
  assert.ok((dayAfter.redactions[LABEL] ?? 0) > 0 && dayAfter.redactions['GitHub 토큰'] === dayExpected.redactions['GitHub 토큰']);

  // 데이터 폴더 어디에도 값이 없고, 새 파일(임시·백업·기록 파일)도 남지 않았어요.
  assert.deepEqual(filesWithCorp(sb.dataDir), []);
  assert.deepEqual(Object.keys(snapshotDir(sb.dataDir)).sort(), Object.keys(beforeSnap).sort());
  assert.ok(!existsSync(join(sb.dataDir, JOURNAL_NAME)));
  assert.ok(!listFilesRec(sb.dataDir).some((p) => p.endsWith(STAGED_SUFFIX)));
  // 남아 있는 원본은 그대로예요(원본에는 값이 그대로 있어요).
  assert.deepEqual(fingerprint(keepOriginal), orig);
  assert.ok(readFileSync(keepOriginal, 'utf8').includes(T1));
  // 보관 색인의 보관본 크기가 새 파일 크기와 맞아요(다음 보관이 이어 붙일 자리).
  const idx = readJson<ArchiveIndex>(join(sb.dataDir, 'archive', 'index.json'));
  for (const [key, e] of Object.entries(idx.files)) {
    assert.equal(e.archiveBytes, fingerprint(join(sb.dataDir, 'archive', 'projects', ...key.split('/'))).size, key);
  }

  const c = runCli(sb, ['check']);
  assert.equal(c.code, 0, c.stdout);
  assert.match(c.stdout, /\[통과\] 남은 의심 0건/);
});

test('두 번째 실행은 바뀔 자리 0개라 묻지 않고 끝나요 (확인할 수 없는 환경에서도 종료 코드 0)', async () => {
  const before = snapshotDir(sb.dataDir);
  const r = runCli(sb, ['redact']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /바뀔 자리 {3}0개/);
  assert.match(r.stdout, /바뀐 파일은 없어요/);
  assert.match(r.stdout, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/);
  const io = fakeIo('y');
  assert.equal(await runRedact(cfgOf(sb), { yes: false, io }), 0);
  assert.equal(io.asked, 0, '바뀔 자리가 없으면 묻지 않아요');
  assert.deepEqual(snapshotDir(sb.dataDir), before);
});

test('다시 가린 보관본에 이어서 보관해도 중복·누락이 없어요', () => {
  const archive = listFilesRec(join(sb.dataDir, 'archive', 'projects')).find((p) => p.endsWith(`${SID_KEEP}.jsonl`))!;
  const before = readFileSync(archive, 'utf8');
  const A = { sid: SID_KEEP, cwd: repoDir };
  appendFileSync(keepOriginal, `${userText({ ...A, ts: kst(DATE, '18:00') }, `저녁 작업 ${'CORP-99990000'}`)}\n`);
  const r = runCli(sb, ['archive']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /이어 붙임 1개/);
  const after = readFileSync(archive, 'utf8');
  assert.ok(after.startsWith(before), '이미 보관한(다시 가린) 줄은 그대로예요');
  const lines = after.trim().split('\n');
  assert.equal(lines.length, before.trim().split('\n').length + 1);
  const uuids = lines.map((l) => (JSON.parse(l) as { uuid?: string }).uuid).filter(Boolean);
  assert.equal(new Set(uuids).size, uuids.length, '중복 줄이 없어요');
  assert.ok(lines[lines.length - 1]!.includes(`저녁 작업 ${M}`), '새 줄도 지금 규칙으로 가려요');
  const again = runCli(sb, ['archive']);
  assert.match(again.stdout, /이어 붙임 0개/);
  assert.equal(readFileSync(archive, 'utf8'), after);
});

test('다시 가린 뒤에도 원본을 지우면 보관본만으로 같은 일지가 나와요 (F3)', () => {
  let r = runCli(sb, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  const md1 = readFileSync(join(sb.dataDir, 'worklogs', `${DATE}.md`), 'utf8');
  assert.ok(md1.includes(M) && !/CORP-[0-9]{8}/.test(md1));
  rmSync(keepOriginal);
  r = runCli(sb, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(sb.dataDir, 'worklogs', `${DATE}.md`), 'utf8'), md1);
  assert.equal(runCli(sb, ['check']).code, 0);
});

// ---- --yes, 멈춤, 잠금 ----

function smallSandbox(): Sandbox {
  const s = sandbox();
  const cwd = join(s.root, 'work', 'svc');
  initRepo(s, cwd, ME);
  commitAt(s, cwd, `릴리스 ${T1}`, '2026-10-15T12:00:00+09:00');
  const A = { sid: 'cd000000-0000-4000-8000-00000000000a', cwd };
  writeSession(s, cwd, A.sid, [userText({ ...A, ts: kst(DATE, '10:00') }, `토큰 ${T1} 써 줘`), assistantText({ ...A, ts: kst(DATE, '10:01') }, `${T2} 도요`)]);
  const B = { sid: 'cd000000-0000-4000-8000-00000000000b', cwd };
  writeSession(s, cwd, B.sid, [userText({ ...B, ts: kst(DATE, '11:00') }, `또 ${T3}`), assistantText({ ...B, ts: kst(DATE, '11:01') }, '네')]);
  assert.equal(runCli(s, ['--date', DATE]).code, 0);
  writeFileSync(join(s.dataDir, 'patterns.json'), PATTERNS);
  return s;
}

function runCrash(s: Sandbox, phase: 'stage' | 'rename' | 'interrupt', n: number) {
  return spawnSync(process.execPath, [join(APP_DIR, 'test', 'fixtures', 'redact-crash.mjs'), s.claudeDir, s.dataDir, phase, String(n)], {
    env: s.env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('--yes면 확인할 수 없는 환경에서도 묻지 않고 다시 쓰고, 다른 명령에는 --yes를 쓸 수 없어요', () => {
  const s = smallSandbox();
  try {
    const r = runCli(s, ['redact', '--yes']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /--yes를 받아 묻지 않고 다시 써요/);
    assert.match(r.stdout, /새로 가림 +모두 \d+개/);
    assert.deepEqual(filesWithCorp(s.dataDir), []);
    assert.equal(runCli(s, ['check']).code, 0);
    const bad = runCli(s, ['archive', '--yes']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--yes는 redact 명령에서만 써요/);
  } finally {
    s.cleanup();
  }
});

test('확인 답은 y·yes만이 아니라 예·네도 확인이에요 (A16)', async () => {
  const s = smallSandbox();
  try {
    const io = fakeIo('네');
    const code = await runRedact(cfgOf(s), { yes: false, io });
    assert.equal(code, 0, io.out);
    assert.equal(io.asked, 1);
    assert.match(io.out, /새로 가림 +모두 \d+개/);
    assert.deepEqual(filesWithCorp(s.dataDir), []);
    assert.equal(runCli(s, ['check']).code, 0);
  } finally {
    s.cleanup();
  }
});

test('새 내용을 쓰다가 프로세스가 죽으면, 다음 실행이 되돌려서 바뀐 파일이 없어요 (남은 잠금도 치워요)', () => {
  const s = smallSandbox();
  try {
    const before = snapshotDir(s.dataDir);
    const r = runCrash(s, 'stage', 2);
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(join(s.dataDir, JOURNAL_NAME)), '기록 파일이 남아 있어야 해요');
    assert.ok(listFilesRec(s.dataDir).some((p) => p.endsWith(STAGED_SUFFIX)));
    assert.ok(existsSync(lockPathFor(s.dataDir)), '죽은 실행의 잠금이 남아 있어요');
    for (const [rel, fp] of Object.entries(before)) assert.deepEqual(fingerprint(join(s.dataDir, rel)), fp, `${rel}: 원래 파일이 바뀌었어요`);

    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /지난번에 멈춘 보관본 다시 가리기를 되돌렸어요/);
    assert.ok(!existsSync(join(s.dataDir, JOURNAL_NAME)));
    assert.ok(!listFilesRec(s.dataDir).some((p) => p.endsWith(STAGED_SUFFIX)));
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
    for (const rel of Object.keys(before).filter((k) => k.startsWith('worklogs/'))) {
      assert.deepEqual(fingerprint(join(s.dataDir, rel)), before[rel], rel);
    }
    // 되돌린 뒤 다시 실행하면 끝까지 돼요.
    assert.equal(runCli(s, ['redact', '--yes']).code, 0);
    assert.equal(runCli(s, ['check']).code, 0);
  } finally {
    s.cleanup();
  }
});

test('이름을 바꾸다가 프로세스가 죽으면, 다음 실행이 마저 끝내서 보관본·일지·색인이 맞아요', () => {
  const s = smallSandbox();
  try {
    const r = runCrash(s, 'rename', 1);
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(join(s.dataDir, JOURNAL_NAME)));
    const m = runCli(s, ['--date', DATE]);
    assert.equal(m.code, 0, m.stderr);
    assert.match(m.stdout, /지난번에 멈춘 보관본 다시 가리기를 마저 끝냈어요/);
    assert.ok(!existsSync(join(s.dataDir, JOURNAL_NAME)));
    assert.ok(!listFilesRec(s.dataDir).some((p) => p.endsWith(STAGED_SUFFIX)));
    assert.deepEqual(filesWithCorp(s.dataDir), []);
    const idx = readJson<ArchiveIndex>(join(s.dataDir, 'archive', 'index.json'));
    for (const [key, e] of Object.entries(idx.files)) {
      const file = join(s.dataDir, 'archive', 'projects', ...key.split('/'));
      assert.equal(e.archiveBytes, fingerprint(file).size, key);
      for (const line of readFileSync(file, 'utf8').trim().split('\n')) JSON.parse(line); // 깨진 줄이 없어요
    }
    const a = runCli(s, ['archive']);
    assert.match(a.stdout, /새로 0개 · 이어 붙임 0개 · 그대로 2개/);
    assert.equal(runCli(s, ['check']).code, 0);
    assert.equal(runCli(s, ['redact']).code, 0, '다시 실행하면 바뀔 자리 0개예요');
  } finally {
    s.cleanup();
  }
});

test('새 내용을 쓰는 중에 Ctrl+C를 받으면 되돌리고 멈춰요 (종료 코드 1, 바뀐 파일 없음)', () => {
  const s = smallSandbox();
  try {
    const before = snapshotDir(s.dataDir);
    const r = runCrash(s, 'interrupt', 1);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    // 다시 쓰다 멈춘 [실패]는 표준 오류로 나가요 (DESIGN: 오류는 표준 오류).
    assert.match(r.stderr, /\[실패\] 다시 쓰다 멈췄어요/);
    assert.match(r.stderr, /바뀐 파일은 없어요/);
    assert.ok(!r.stdout.includes('[실패]'), r.stdout);
    assert.deepEqual(snapshotDir(s.dataDir), before);
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
  } finally {
    s.cleanup();
  }
});
