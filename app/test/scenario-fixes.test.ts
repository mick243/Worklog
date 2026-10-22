// 시나리오 실행(docs/TEST_REPORT.md) 실패 항목을 고친 것의 시험 (7회차).
//  - F2-23: 다시 가리기가 잠긴·읽을 수 없는 보관본·일지 파일을 말없이 건너뛰지 않아요. 위치·원인 코드와 [실패], 종료 코드 1,
//           같은 날짜의 .md·.json은 함께 바뀌거나 함께 그대로예요. 잠금을 풀고 다시 실행하면 맞는 상태가 돼요.
//           이미 한쪽만 가려진 일지는 S3·S4가 그 날짜와 cc-worklog --date 날짜로 다시 만들라고 안내해요.
//  - X-01: config.json·patterns.json(과 손으로 고칠 수 있는 다른 JSON)이 UTF-8 BOM으로 시작해도 읽어요.
//  - F1-08: 지운 워크트리의 세션은 --root 없이도, 세션 기록 전체(다른 날짜·원본이 지워진 보관본)에서 찾은 원래 저장소로 묶여요.
//  - F1-20: --root·roots의 없는 경로·파일 경로·저장소 없는 폴더는 멈추지 않고 건너뛰며 일지 만들기 S3에 경로마다 [알림]이 나와요.
//  - F1-21: view가 요청한 포트(기본 포함)가 쓰이는 중이면 다음 빈 포트로 열고 바뀐 사실을 알려요.
// 잠금은 Windows에서 공유 없이 연 파일(다른 프로그램이 FileShare.None으로 연 것과 같아요)로, 그 밖의 OS에서는 읽기 권한을 빼서 흉내 내요.
// 시험이 바꾼 잠금·권한은 시험이 끝나기 전에 모두 되돌려요.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadIndex } from '../src/archive/archive.js';
import { portChangedNotice } from '../src/commands/view.js';
import { runRedact, type RedactIo } from '../src/commands/redact.js';
import { DEFAULT_PORT, resolveConfig } from '../src/config.js';
import { JOURNAL_NAME, STAGED_SUFFIX } from '../src/redact/journal.js';
import { loadUserPatterns } from '../src/redact/redact.js';
import { MAKE_TEXT } from '../src/term/s3-summary.js';
import { lockPathFor } from '../src/util/lock.js';
import { numberParticles } from '../src/util/text.js';
import { readDay } from '../src/web/data.js';
import { REMAKE_HINT, shellPath } from '../src/worklog/mismatch.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  assistantText,
  CLI,
  commitAt,
  git,
  initRepo,
  asOldVersionWorklog,
  kst,
  lastCheckRow,
  listFilesRec,
  readJson,
  rowText,
  runCli,
  sandbox,
  snapshotDir,
  userText,
  writeSession,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-16';
const ME = 'dev.kim@example.test';
const T1 = 'CORP-12345678';
const T2 = 'CORP-87654321';
const LABEL = '헤더 문구';
const PATTERNS = JSON.stringify([{ name: LABEL, pattern: 'CORP-[0-9]{8}', samples: ['CORP-00000000'] }]);
const SID = 'f2230000-0000-4000-8000-000000000001';
const BOM = '\uFEFF';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** 다른 프로그램이 파일을 잡고 있는 것을 흉내 낼 수 없는 환경(POSIX root는 권한을 무시해요)이면 건너뛰어요. */
const lockSkip = isRoot ? 'POSIX root는 파일 권한을 무시해서 잠금을 흉내 낼 수 없어요' : false;

/** libuv: Windows에서 공유 없이(FILE_SHARE 0) 여는 플래그. 다른 프로그램이 FileShare.None으로 연 것과 같아요. */
const UV_FS_O_EXLOCK = 0x10000000;

/**
 * 파일을 잠가요. Windows는 이 시험 프로세스가 공유 없이 열어 두고(다른 프로세스의 읽기·쓰기·이름 바꾸기가 모두 실패해요),
 * 그 밖의 OS는 권한을 모두 빼요. 돌려준 함수로 꼭 풀어요(권한도 원래대로 돌려요).
 */
function lockFile(path: string): () => void {
  if (process.platform === 'win32') {
    const fd = openSync(path, constants.O_RDWR | UV_FS_O_EXLOCK);
    let open = true;
    return () => {
      if (open) closeSync(fd);
      open = false;
    };
  }
  const mode = statSync(path).mode & 0o777;
  chmodSync(path, 0o000);
  return () => chmodSync(path, mode);
}

/** 읽기 전용으로 바꿔요(읽을 수는 있지만 바꿀 수 없어요). 돌려준 함수로 원래대로 돌려요. */
function readOnly(path: string): () => void {
  const mode = statSync(path).mode & 0o777;
  chmodSync(path, 0o444);
  return () => chmodSync(path, mode | 0o200);
}

interface Seeded {
  s: Sandbox;
  md: string;
  json: string;
  archive: string;
  rel: { md: string; json: string; archive: string };
}

/** 가짜 사내 토큰이 든 세션·커밋으로 일지와 보관본을 만든 뒤, 그 값에 맞는 사용자 패턴을 새로 더해요(다시 가리기 차례). */
function seed(): Seeded {
  const s = sandbox();
  const repo = join(s.root, 'work', 'web');
  initRepo(s, repo, ME);
  commitAt(s, repo, `style: 헤더 정리 ${T2}`, `${DATE}T11:00:00+09:00`);
  const A = { sid: SID, cwd: repo };
  writeSession(s, repo, SID, [
    userText({ ...A, ts: kst(DATE, '10:00') }, `헤더 손보기 ${T1} 로 확인해 줘`),
    assistantText({ ...A, ts: kst(DATE, '10:05') }, '했어요'),
  ]);
  const r = runCli(s, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  writeFileSync(join(s.dataDir, 'patterns.json'), PATTERNS);
  const md = join(s.dataDir, 'worklogs', `${DATE}.md`);
  const json = join(s.dataDir, 'worklogs', `${DATE}.json`);
  const archive = listFilesRec(join(s.dataDir, 'archive', 'projects')).find((p) => p.endsWith(`${SID}.jsonl`))!;
  assert.ok(archive, '보관본이 있어요');
  for (const p of [md, json, archive]) assert.match(readFileSync(p, 'utf8'), /CORP-[0-9]{8}/, `시작할 때는 ${p}에 값이 남아 있어요`);
  const rel = (p: string) => p.slice(s.dataDir.length + 1).split('\\').join('/');
  return { s, md, json, archive, rel: { md: rel(md), json: rel(json), archive: rel(archive) } };
}

/** 사용자가 쓴 patterns.json(시험 값)을 빼고, 사내 토큰 값이 남은 결과물 */
function filesWithCorp(dir: string): string[] {
  return listFilesRec(dir).filter((p) => !p.endsWith('patterns.json') && /CORP-[0-9]{8}/.test(readFileSync(p, 'utf8')));
}

/** 다시 쓰는 동안의 파일(다시 쓰기 기록, 새 내용 임시 파일)이 남지 않았는지 */
function assertNoLeftovers(s: Sandbox): void {
  assert.ok(!existsSync(join(s.dataDir, JOURNAL_NAME)), '다시 쓰기 기록이 남지 않아요');
  assert.deepEqual(
    listFilesRec(s.dataDir).filter((p) => p.endsWith(STAGED_SUFFIX) || p.includes('.tmp-')),
    [],
    '새 내용 임시 파일이 남지 않아요',
  );
  assert.ok(!existsSync(lockPathFor(s.dataDir)), '잠금 파일이 남지 않아요');
}

/** 80칸에 맞춰 나눈 줄을 이어 붙여요(이어지는 줄의 들여쓰기를 한 칸 공백으로). */
const flat = (t: string) => t.replace(/\n +/g, ' ');

/**
 * 잠긴 파일 [실패] (표준 오류): 파일 위치·원인 코드(읽기·쓰기 구분 포함), 프로그램을 닫으라는 공통 다음: 줄. 데이터 폴더 [실패]와는 다른 안내예요.
 * stage 'plan'은 바뀔 자리를 세다 멈춘 경우(DESIGN 가 방식: 1줄 파일 수, 파일마다 한 줄), 'commit'은 확인 뒤 확정 전에 멈춘 경우
 * (한 파일이면 "다시 쓰다 멈췄어요 (경로, 코드 · 구분)")예요.
 */
function assertInaccessible(stderr: string, rel: string, op: '읽지 못함' | '쓰지 못함', stage: 'plan' | 'commit' = 'plan'): void {
  const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (stage === 'plan') {
    // 모두 읽지 못한 파일이면 DESIGN 문장 그대로 "읽지 못해", 쓰지 못한 파일이 있으면 "읽거나 쓰지 못해"예요.
    assert.match(stderr, new RegExp(`^\\[실패\\] 보관본·일지 파일 1개를 ${op === '읽지 못함' ? '읽지' : '읽거나 쓰지'} 못해 다시 쓰지 않았어요$`, 'm'), stderr);
    assert.match(stderr, new RegExp(`^ {7}${esc} \\((EBUSY|EPERM|EACCES) · ${op}\\)$`, 'm'), stderr);
  } else {
    assert.match(stderr, new RegExp(`^\\[실패\\] 다시 쓰다 멈췄어요 \\(${esc}, (EBUSY|EPERM|EACCES) · ${op}\\)$`, 'm'), stderr);
  }
  assert.equal(rowText(stderr, '다음:'), '다음: 위 파일을 연 프로그램(편집기·화면·백신 등)을 닫거나 파일 권한을 확인한 뒤 다시 실행하세요.');
  assert.ok(!stderr.includes('--data-dir'), '데이터 폴더를 바꾸라는 안내가 아니에요');
  assert.ok(!stderr.includes('데이터 폴더에 쓰지 못했어요'));
}

/** 잠금을 풀고 다시 실행하면 보관본·마크다운·화면용 데이터가 모두 가려지고 검사가 통과해요. */
function assertFixedAfterUnlock(x: Seeded): void {
  const r = runCli(x.s, ['redact', '--yes']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /다시 씀 +보관본 1개 · 일지 1개/);
  assert.deepEqual(filesWithCorp(x.s.dataDir), [], '값이 남은 파일이 없어요');
  assert.ok(readFileSync(x.md, 'utf8').includes(`[가림:${LABEL}]`) && readFileSync(x.json, 'utf8').includes(`[가림:${LABEL}]`), '마크다운과 화면용 데이터가 함께 가려져요');
  const c = runCli(x.s, ['check']);
  assert.equal(c.code, 0, c.stdout);
  assertNoLeftovers(x.s);
}

function cfgOf(s: Sandbox) {
  return resolveConfig({ claudeDir: s.claudeDir, dataDir: s.dataDir });
}

function fakeIo(onAsk: () => string | null): RedactIo & { out: string; err: string } {
  const io = {
    interactive: true,
    color: false,
    errColor: false,
    out: '',
    err: '',
    write(t: string) {
      io.out += t;
    },
    writeErr(t: string) {
      io.err += t;
    },
    async ask(q: string) {
      io.out += q;
      return onAsk();
    },
  };
  return io;
}

// ---- F2-23 ----

for (const which of ['md', 'json', 'archive'] as const) {
  test(`F2-23: 잠긴 ${which === 'archive' ? '보관본' : `일지 .${which}`}은 말없이 건너뛰지 않고 [실패]·종료 코드 1, 아무 파일도 바뀌지 않아요 → 잠금을 풀고 다시 실행하면 맞는 상태가 돼요`, { skip: lockSkip }, () => {
    const x = seed();
    try {
      const before = snapshotDir(x.s.dataDir);
      const release = lockFile(x[which]);
      let r;
      try {
        r = runCli(x.s, ['redact', '--yes']);
      } finally {
        release();
      }
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assertInaccessible(r.stderr, x.rel[which], '읽지 못함');
      assert.match(flat(r.stderr), /바뀐 파일은 없어요\. 다시 실행하면 바뀔 자리를 처음부터 다시 세요\./);
      assert.ok(!r.stdout.includes('다시 씀'), '"다시 씀"으로 성공처럼 끝내지 않아요');
      assert.ok(!r.stdout.includes('[실패]') && !r.stdout.includes('공개 전에 cc-worklog check'), '표준 출력에는 [실패]·검사 줄이 없어요');
      assert.match(r.stdout, /^cc-worklog 보관본 다시 가리기$/m, '머리 줄과 데이터 폴더는 보여 줘요');
      // 잠긴 파일만이 아니라 같은 날짜의 짝(.md·.json)과 다른 파일 모두 그대로예요(일부만 바뀐 채 남지 않아요).
      assert.deepEqual(snapshotDir(x.s.dataDir), before, '데이터 폴더의 어떤 파일도 바뀌거나 생기지 않아요');
      assertNoLeftovers(x.s);

      // --yes 없이 확인을 물을 수 없는 환경에서도 같은 [실패]예요(묻기 전에 멈춰요).
      const release2 = lockFile(x[which]);
      try {
        r = runCli(x.s, ['redact']);
      } finally {
        release2();
      }
      assert.equal(r.code, 1);
      assertInaccessible(r.stderr, x.rel[which], '읽지 못함');
      assert.ok(!r.stdout.includes('--yes를 붙여'), '확인 안내까지 가지 않아요');
      assert.deepEqual(snapshotDir(x.s.dataDir), before);

      assertFixedAfterUnlock(x);
    } finally {
      x.s.cleanup();
    }
  });
}

test('F2-23: 읽을 수는 있지만 바꿀 수 없는(읽기 전용) 일지 .md도 확인을 묻기 전에 [실패]로 알리고, .json도 바꾸지 않아요', { skip: lockSkip }, () => {
  const x = seed();
  try {
    const before = snapshotDir(x.s.dataDir);
    const restore = readOnly(x.md);
    let r;
    try {
      r = runCli(x.s, ['redact', '--yes']);
    } finally {
      restore();
    }
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
    assertInaccessible(r.stderr, x.rel.md, '쓰지 못함');
    const after = snapshotDir(x.s.dataDir);
    // 권한을 되돌리며 바뀌는 것은 없어요(내용·크기·수정 시각 그대로).
    assert.deepEqual(after, before, '어떤 파일도 바뀌지 않아요(.json만 가려진 채 남지 않아요)');
    assertFixedAfterUnlock(x);
  } finally {
    x.s.cleanup();
  }
});

test('F2-23: 확인을 기다리는 동안 다른 프로그램이 일지를 잡으면 확정 전에 모두 되돌리고 [실패]·종료 코드 1이에요', { skip: lockSkip }, async () => {
  const x = seed();
  try {
    const before = snapshotDir(x.s.dataDir);
    let release: (() => void) | null = null;
    const io = fakeIo(() => {
      release = lockFile(x.md); // 사용자가 확인하기 직전에 편집기가 파일을 잡았어요.
      return 'y';
    });
    let code: number;
    try {
      code = await runRedact(cfgOf(x.s), { yes: false, io });
    } finally {
      (release as (() => void) | null)?.();
    }
    assert.equal(code, 1, `${io.out}\n${io.err}`);
    assertInaccessible(io.err, x.rel.md, '쓰지 못함', 'commit');
    assert.match(flat(io.err), /파일은 깨지지 않았어요\. 새로 쓰던 내용은 지웠고 바뀐 파일은 없어요\./);
    assert.ok(!io.out.includes('다시 씀'));
    assert.deepEqual(snapshotDir(x.s.dataDir), before, '보관본·일지·색인 모두 그대로예요');
    assertNoLeftovers(x.s);
    assertFixedAfterUnlock(x);
  } finally {
    x.s.cleanup();
  }
});

test('F2-23: 이미 한쪽(화면용 데이터)만 가려진 일지는 redact가 날짜와 cc-worklog --date 안내를 붙이고, check의 다음: 줄도 같아요 → 다시 만들면 고쳐져요', () => {
  const x = seed();
  try {
    // 이전 판이 남긴 어긋남을 만들어요: 다시 가린 뒤 마크다운만 가리기 전 내용으로 되돌려요.
    // 이전 판은 손으로 고친 일지를 알아보는 해시를 남기지 않았어요(그래서 다시 만들 수 있어요, PRD A21).
    const oldMd = readFileSync(x.md, 'utf8');
    let r = runCli(x.s, ['redact', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    writeFileSync(x.md, oldMd);
    asOldVersionWorklog(x.json);
    assert.match(readFileSync(x.md, 'utf8'), /CORP-/);
    assert.ok(!readFileSync(x.json, 'utf8').includes('CORP-'));

    r = runCli(x.s, ['redact', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /바뀔 자리 {3}0개/);
    // 고칠 수 없는 의심 [알림]과 같은 덩어리 안, 다음 줄(이름표 뒤 위치)에 한쪽만 가려진 일지 문장과 날짜마다 다시 만드는 명령(9칸)이 이어져요(DESIGN 다 9번).
    // 명령은 그 일지를 만든 설정과 같게 다시 만드는 명령이에요. runCli가 --data-dir·--claude-dir를 주니 그 폴더가 붙고,
    // 기본 하루 경계·이름·이메일 가리기 꺼짐으로 만든 일지라 --day-start·--hide-identity는 없어요. 명령 아래에 --root·--claude-dir 한 줄(8회차, PRD Q22·Q23·Q24).
    const remake = `cc-worklog --date ${DATE} --data-dir ${shellPath(x.s.dataDir)} --claude-dir ${shellPath(x.s.claudeDir)}`;
    const remakeRe = remake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hintRe = REMAKE_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const notice = rowText(r.stdout, '[알림] 다시 가리기로 고칠 수 없는 의심');
    assert.match(notice, /의심 \d+건은 그대로 남아요/);
    assert.match(notice, new RegExp(`위치를 알려 줘요\\. 그중 \\d+건은 \\.md와 화면용 \\.json 중 한쪽만 가려진 일지에 있어요\\. 아래 명령으로 그 날짜 일지를 다시 만들면 고쳐져요\\. ${remakeRe} ${hintRe}$`));
    assert.match(r.stdout, new RegExp(`^ {7}그중 \\d+건은 `, 'm'), '같은 [알림] 덩어리 안 이름표 뒤 위치예요');
    assert.match(r.stdout, new RegExp(`^ {9}${remakeRe}\\n {7}${hintRe}$`, 'm'), '다시 만드는 명령을 한 줄로 보여 주고, 그 아래 이름표 뒤 위치에 안내 한 줄');

    const c = runCli(x.s, ['check']);
    assert.equal(c.code, 1);
    assert.match(c.stdout, new RegExp(`worklogs/${DATE}\\.md +줄 `));
    assert.match(rowText(c.stdout, '다음: 아래 날짜의'), new RegExp(`^다음: 아래 날짜의 일지는 \\.md와 화면용 \\.json 중 한쪽만 가려져 있어서 다시 가리기로 고쳐지지 않을 수 있어요\\. 그 날짜 일지를 다시 만든 뒤 다시 검사하세요\\. ${remakeRe} ${hintRe}$`));
    assert.match(c.stdout, new RegExp(`^ {8}${remakeRe}\\n {6}${hintRe}$`, 'm'));
    // 다시 가리기 다음: 줄은 지우지 않고, 한쪽만 가려진 일지 다음: 줄은 그 뒤에 와요(PRD S4 "안내도 함께", DESIGN S4 11번).
    const redactNext = c.stdout.indexOf('다음: 필요하면 사용자 패턴을 더한 뒤 cc-worklog redact를 실행하고');
    assert.ok(redactNext >= 0 && redactNext < c.stdout.indexOf('다음: 아래 날짜의'), '다시 가리기 → 그 날짜 일지 다시 만들기 순서예요');

    // 안내대로 그 날짜 일지를 다시 만들면 두 파일이 같게 가려지고 검사가 통과해요.
    r = runCli(x.s, ['--date', DATE]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(filesWithCorp(x.s.dataDir), []);
    const ok = runCli(x.s, ['check']);
    assert.equal(ok.code, 0, ok.stdout);
    const again = runCli(x.s, ['redact', '--yes']);
    assert.ok(!again.stdout.includes('한쪽만 가려진'), '고친 뒤에는 안내가 없어요');
  } finally {
    x.s.cleanup();
  }
});

test('F2-23: 일지 만들기도 같은 날짜의 .md·.json 중 하나를 쓸 수 없으면 둘 다 쓰기 전에 멈춰요 (한쪽만 새 내용으로 바뀌지 않아요)', { skip: lockSkip }, () => {
  const x = seed();
  try {
    const mdBefore = readFileSync(x.md);
    const jsonBefore = readFileSync(x.json);
    const release = lockFile(x.json);
    let r;
    try {
      r = runCli(x.s, ['--date', DATE]);
    } finally {
      release();
    }
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /^\[실패\] 데이터 폴더에 쓰지 못했어요 \((EBUSY|EPERM|EACCES)\)$/m);
    assert.ok(readFileSync(x.md).equals(mdBefore) && readFileSync(x.json).equals(jsonBefore), '두 파일 모두 그대로예요');
  } finally {
    x.s.cleanup();
  }
});

// ---- X-01 ----

test('X-01: config.json·patterns.json이 UTF-8 BOM으로 시작해도 올바른 JSON으로 읽어요 (Claude settings.json·보관 색인·화면용 일지 데이터도)', () => {
  const s = sandbox();
  try {
    const repo = join(s.root, 'work', 'bom');
    initRepo(s, repo, ME);
    commitAt(s, repo, '세션 없는 날 커밋', `${DATE}T09:00:00+09:00`);
    mkdirSync(s.dataDir, { recursive: true });
    writeFileSync(join(s.dataDir, 'config.json'), `${BOM}${JSON.stringify({ roots: [join(s.root, 'work')], dayStartHour: 3 })}`, 'utf8');
    writeFileSync(join(s.dataDir, 'patterns.json'), `${BOM}${PATTERNS}`, 'utf8');
    writeFileSync(join(s.claudeDir, 'settings.json'), `${BOM}${JSON.stringify({ cleanupPeriodDays: 45 })}`, 'utf8');

    const c = runCli(s, ['check']);
    assert.equal(c.code, 0, `${c.stdout}\n${c.stderr}`);
    assert.match(c.stdout, new RegExp(`잡힘 +${LABEL} \\(시험 값 1/1\\)`));
    assert.ok(!c.stderr.includes('올바른 JSON'));

    const cfg = cfgOf(s);
    assert.deepEqual(cfg.roots, [join(s.root, 'work')], 'BOM이 붙은 config.json의 roots를 읽어요');
    assert.equal(cfg.cleanupPeriodDays, 45, 'BOM이 붙은 Claude Code settings.json도 읽어요');
    assert.equal(loadUserPatterns(join(s.dataDir, 'patterns.json')).length, 1);

    // roots를 읽었으니 세션 없는 날의 커밋도 들어가요.
    const m = runCli(s, ['--date', DATE]);
    assert.equal(m.code, 0, m.stderr);
    assert.match(m.stdout, /커밋 1개/);

    // 손으로 고치며 BOM이 붙은 보관 색인과 화면용 일지 데이터도 읽어요.
    const indexFile = join(s.dataDir, 'archive', 'index.json');
    writeFileSync(indexFile, `${BOM}${readFileSync(indexFile, 'utf8')}`, 'utf8');
    assert.equal(loadIndex(s.dataDir).schema, 1);
    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    const dayFile = join(s.dataDir, 'worklogs', `${DATE}.json`);
    writeFileSync(dayFile, `${BOM}${readFileSync(dayFile, 'utf8')}`, 'utf8');
    assert.equal(readDay(s.dataDir, DATE).date, DATE);
    assert.equal(runCli(s, ['check']).code, 0);
  } finally {
    s.cleanup();
  }
});

test('X-01: BOM만 떼요 — BOM 뒤가 올바른 JSON이 아니면 전처럼 [실패]예요', () => {
  const s = sandbox();
  try {
    mkdirSync(s.dataDir, { recursive: true });
    writeFileSync(join(s.dataDir, 'patterns.json'), `${BOM}[{ "name": "x", }]`, 'utf8');
    const r = runCli(s, ['check']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\[실패\] 사용자 패턴 파일을 읽지 못했어요 \(올바른 JSON이 아니에요\)/);
    writeFileSync(join(s.dataDir, 'patterns.json'), '[]');
    writeFileSync(join(s.dataDir, 'config.json'), `${BOM}{ "roots": [ }`, 'utf8');
    const r2 = runCli(s, ['check']);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /\[실패\] 설정 파일이 올바른 JSON이 아니에요/);
  } finally {
    s.cleanup();
  }
});

// ---- F1-08 ----

test('F1-08: 작업 폴더를 지운 워크트리의 세션은 --root 없이도 원래 저장소로 묶여요 (원래 저장소의 세션이 다른 날짜에만 있어도, 그 원본이 지워져도)', () => {
  const s = sandbox();
  try {
    const work = join(s.root, 'work');
    const api = join(work, 'api');
    const wt = join(work, 'api-wt');
    initRepo(s, api, ME);
    commitAt(s, api, 'api init', '2026-10-13T09:00:00+09:00');
    const apiCommit = commitAt(s, api, '그날 api 커밋', `${DATE}T15:30:00+09:00`);
    git(s, api, ['worktree', 'add', '-q', wt, '-b', 'feature']);
    // 원래 저장소에서 남긴 세션은 다른 날짜(10-14)에만 있어요. 그날(10-16)에는 워크트리 세션 하나뿐이에요.
    const other = { sid: 'f1080000-0000-4000-8000-000000000001', cwd: api };
    const otherFile = writeSession(s, api, other.sid, [userText({ ...other, ts: kst('2026-10-14', '10:00') }, '다른 날 api 작업')]);
    const w = { sid: 'f1080000-0000-4000-8000-000000000002', cwd: wt };
    writeSession(s, wt, w.sid, [userText({ ...w, ts: kst(DATE, '14:00'), branch: 'feature' }, '워크트리에서 기능 만들기'), assistantText({ ...w, ts: kst(DATE, '14:10') }, '만들었어요')]);
    // 워크트리 폴더만 지워요 (git worktree prune은 하지 않아서 원래 저장소에 워크트리 기록이 남아요).
    rmSync(wt, { recursive: true, force: true });

    let r = runCli(s, ['--date', DATE]);
    assert.equal(r.code, 0, r.stderr);
    let day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${DATE}.json`));
    assert.deepEqual(
      day.projects.map((p) => p.name),
      ['api'],
      '--root 없이도 지운 워크트리 세션이 원래 저장소 api로 묶여요',
    );
    assert.ok(day.projects[0]!.sessions.some((x) => x.sessionId === w.sid));
    assert.deepEqual(
      day.projects[0]!.commits.map((c) => c.hash),
      [apiCommit],
      '원래 저장소의 그날 커밋도 함께 나와요',
    );

    // 원래 저장소 세션의 원본이 지워져 보관본만 남아도 같아요.
    rmSync(otherFile);
    r = runCli(s, ['--date', DATE]);
    assert.equal(r.code, 0, r.stderr);
    day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${DATE}.json`));
    assert.deepEqual(
      day.projects.map((p) => p.name),
      ['api'],
      '원본이 지워진 보관본의 작업 폴더도 후보예요',
    );
    assert.ok(!r.stdout.includes('[알림] --root'), '--root를 주지 않았으니 건너뛴 경로 알림도 없어요');
  } finally {
    s.cleanup();
  }
});

test('F1-08: 원래 저장소를 찾을 단서가 전혀 없으면 "저장소 없음"이고, --root로 상위 폴더를 주면 그 저장소로 묶여요 (한계)', () => {
  const s = sandbox();
  try {
    const work = join(s.root, 'work');
    const solo = join(work, 'solo');
    const wt = join(work, 'solo-wt');
    initRepo(s, solo, ME);
    commitAt(s, solo, 'solo init', '2026-10-13T09:00:00+09:00');
    git(s, solo, ['worktree', 'add', '-q', wt, '-b', 'wt']);
    const w = { sid: 'f1080000-0000-4000-8000-000000000003', cwd: wt };
    writeSession(s, wt, w.sid, [userText({ ...w, ts: kst(DATE, '14:00') }, '단서 없는 워크트리 작업')]);
    rmSync(wt, { recursive: true, force: true });

    let r = runCli(s, ['--date', DATE]);
    assert.equal(r.code, 0, r.stderr);
    let day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${DATE}.json`));
    assert.deepEqual(
      day.projects.map((p) => p.name),
      ['저장소 없음'],
    );
    r = runCli(s, ['--date', DATE, '--root', work]);
    assert.equal(r.code, 0, r.stderr);
    day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${DATE}.json`));
    assert.deepEqual(
      day.projects.map((p) => p.name),
      ['solo'],
    );
  } finally {
    s.cleanup();
  }
});

// ---- F1-20 ----

test('F1-20: --root·roots의 없는 경로·파일 경로·저장소 없는 폴더는 멈추지 않고 건너뛰고, 일지 만들기 S3에 경로마다 [알림]을 보여 줘요', () => {
  const s = sandbox();
  try {
    const work = join(s.root, 'work');
    const repo = join(work, 'good');
    initRepo(s, repo, ME);
    const hash = commitAt(s, repo, '좋은 저장소 커밋', `${DATE}T09:00:00+09:00`);
    const missing = join(s.root, 'wrok'); // 오타
    const file = join(s.root, 'notes.txt');
    writeFileSync(file, '파일이에요');
    const empty = join(s.root, 'empty');
    mkdirSync(join(empty, 'a', 'b'), { recursive: true });
    const cfgMissing = join(s.root, 'from-config');
    mkdirSync(s.dataDir, { recursive: true });
    writeFileSync(join(s.dataDir, 'config.json'), JSON.stringify({ roots: [cfgMissing] }));

    const r = runCli(s, ['--date', DATE, '--root', work, '--root', missing, '--root', file, '--root', empty]);
    assert.equal(r.code, 0, r.stderr);
    const day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${DATE}.json`));
    assert.deepEqual(
      day.projects.flatMap((p) => p.commits.map((c) => c.hash)),
      [hash],
      '올바른 경로의 저장소는 그대로 읽어요',
    );
    const lines = r.stdout.split('\n');
    // 경로마다 세 줄 한 덩어리(DESIGN S3 가·나 10번): 1줄 [알림]과 까닭, 2줄 이름표 뒤 위치(7칸)에 찾아본 절대 경로, 3줄 할 일.
    const pathAfter = (text: RegExp, path: string, todo: string) => {
      const i = lines.findIndex((l) => text.test(l));
      assert.ok(i >= 0, `${text} 알림이 있어요:\n${r.stdout}`);
      assert.equal(lines[i + 1], `       ${path}`, `경로 ${path}가 알림 바로 아래 자기 줄에 있어요:\n${r.stdout}`);
      assert.equal(lines[i + 2], `       ${todo}`, `할 일 문장이 경로 아래에 있어요:\n${r.stdout}`);
    };
    const MISSING_TODO = '경로를 고친 뒤 다시 실행하면 그 아래 저장소의 커밋도 들어가요.';
    pathAfter(/^\[알림\] --root 경로를 건너뛰었어요 \(없는 경로\)\.$/, missing, MISSING_TODO);
    pathAfter(/^\[알림\] --root 경로를 건너뛰었어요 \(폴더가 아닌 파일\)\.$/, file, '저장소가 든 폴더를 주면 그 아래 저장소의 커밋도 들어가요.');
    pathAfter(/^\[알림\] --root 경로를 건너뛰었어요 \(git 저장소를 찾지 못한 폴더\)\.$/, empty, '그 아래 4단계까지 찾아봤어요. 저장소가 더 깊이 있으면 그 폴더를 주세요.');
    pathAfter(/^\[알림\] config\.json의 roots 경로를 건너뛰었어요 \(없는 경로\)\.$/, cfgMissing, MISSING_TODO);
    const heads = lines.filter((l) => /^\[알림\] (--root|config\.json의 roots) 경로를 건너뛰었어요/.test(l));
    assert.equal(heads.length, 4, '잘못된 경로마다 하나씩, 올바른 경로는 알리지 않아요');
    assert.ok(heads[0]!.startsWith('[알림] config.json의 roots'), '준 순서예요: config.json의 roots 다음 --root');
    assert.ok(!lines.some((l) => l.trim() === work), '올바른 경로는 알림에 나오지 않아요');
    // 끝 검사 줄은 그대로예요. 이름·이메일 가리기를 끈 채 만들어서 그 아래에 A19 안내가 이어져요(PRD S3, I-01).
    assert.equal(lastCheckRow(r.stdout), `검사 공개 전에 cc-worklog check로 확인하세요 ${MAKE_TEXT.checkIdentityAll}`, '끝 검사 줄은 그대로예요');

    // 저장소를 읽지 않는 명령(보관·검사·다시 가리기)에서는 나오지 않아요 (A4).
    for (const args of [['archive'], ['check'], ['redact']]) {
      const o = runCli(s, [...args, '--root', missing]);
      assert.ok(!o.stdout.includes('건너뛰었어요') && !o.stderr.includes('건너뛰었어요'), `${args[0]}에는 알림이 없어요`);
    }
  } finally {
    s.cleanup();
  }
});

// ---- F1-21 ----

test('F1-21: 숫자 뒤 조사와 포트 알림 문장', () => {
  assert.deepEqual(numberParticles(4000), { subject: '이', toward: '으로' });
  assert.deepEqual(numberParticles(4848), { subject: '이', toward: '로' });
  assert.deepEqual(numberParticles(4849), { subject: '가', toward: '로' });
  assert.deepEqual(numberParticles(4003), { subject: '이', toward: '으로' });
  // 포트 알림은 숫자 뒤에 "번 포트"를 붙여 조사를 고르지 않아요(DESIGN "화면 열기 출력"). 둘째 줄은 이름표 뒤 위치(7칸)예요.
  assert.equal(portChangedNotice(4000, 4001, true), '[알림] 요청한 4000번 포트가 쓰이는 중이라 4001번 포트로 열었어요.\n       4000번 포트는 다른 프로그램(앞서 연 화면 등)이 쓰고 있어요.');
  assert.equal(portChangedNotice(4848, 4849, false), '[알림] 기본 4848번 포트가 쓰이는 중이라 4849번 포트로 열었어요.\n       4848번 포트는 다른 프로그램(앞서 연 화면 등)이 쓰고 있어요.');
  assert.equal(portChangedNotice(4849, 4850, true), '[알림] 요청한 4849번 포트가 쓰이는 중이라 4850번 포트로 열었어요.\n       4849번 포트는 다른 프로그램(앞서 연 화면 등)이 쓰고 있어요.');
});

/** 127.0.0.1의 port를 잡아요. 이미 다른 것이 쓰고 있으면 null이에요(그래도 "쓰이는 중"이에요). */
function occupy(port: number): Promise<{ port: number; close: () => Promise<void> } | null> {
  const srv = createServer();
  return new Promise((resolve) => {
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () =>
      resolve({ port: (srv.address() as AddressInfo).port, close: () => new Promise<void>((done) => srv.close(() => done())) }),
    );
  });
}

/**
 * view를 띄워 시작 출력(시작 두 줄과, 포트를 바꿨으면 그 뒤 [알림])을 읽은 뒤 꺼요. 남은 프로세스가 없게 끝날 때까지 기다려요.
 * [알림]은 시작 두 줄 뒤에 와서(DESIGN "화면 열기 출력"), 둘째 줄을 본 뒤 조금 더 기다려 뒤따르는 출력까지 받아요.
 * 네트워크 차단 장치(NO_NET)는 붙이지 않아요. Node의 listen이 '127.0.0.1'을 dns.lookup으로 거르는데(숫자 주소라 밖으로 나가지 않아요),
 * 차단 장치가 dns.lookup 자체를 막아서예요. 화면 서버가 127.0.0.1에만 열리는 것은 web.test가 봐요.
 */
async function viewOutput(s: Sandbox, args: string[]): Promise<string> {
  const child = spawn(process.execPath, [CLI, 'view', ...args, '--claude-dir', s.claudeDir, '--data-dir', s.dataDir], {
    env: { ...s.env, CC_WORKLOG_NO_BROWSER: '1' },
    windowsHide: true,
  });
  let out = '';
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`view가 주소를 찍지 않았어요: ${out}`)), 20_000);
      child.stdout.setEncoding('utf8');
      let settling = false;
      child.stdout.on('data', (d: string) => {
        out += d;
        if (!settling && out.includes('끄려면 Ctrl+C')) {
          settling = true;
          clearTimeout(timer);
          setTimeout(resolve, 500);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`view가 먼저 끝났어요 (${code}): ${out}`));
      });
    });
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
  return out;
}

test('F1-21: view가 요청한 포트가 쓰이는 중이면 다음 빈 포트로 열고 시작 두 줄 뒤에 "요청한 N번 포트가 쓰이는 중이라 M번 포트로 열었어요"를 알려요 (기본 포트도)', async () => {
  const s = sandbox();
  const held: Array<{ close: () => Promise<void> }> = [];
  try {
    const busy = await occupy(0);
    assert.ok(busy);
    held.push(busy);
    let out = await viewOutput(s, ['--port', String(busy.port)]);
    const opened = Number(/로컬 화면을 열었어요: http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1]);
    assert.ok(opened > busy.port, out);
    assert.ok(out.includes(portChangedNotice(busy.port, opened, true)), out);
    assert.match(out, new RegExp(`^\\[알림\\] 요청한 ${busy.port}번 포트가 쓰이는 중이라 ${opened}번 포트로 열었어요\\.$`, 'm'));
    // 시작 두 줄은 그대로이고, [알림]은 그 뒤 빈 줄 하나 다음 맨 끝에 와요.
    assert.ok(out.endsWith(`이 컴퓨터에서만 열려요. 끄려면 Ctrl+C를 누르세요.\n\n${portChangedNotice(busy.port, opened, true)}\n`), out);

    // 빈 포트를 요청하면 알림이 없어요.
    const free = await occupy(0);
    assert.ok(free);
    const freePort = free.port;
    await free.close();
    out = await viewOutput(s, ['--port', String(freePort)]);
    if (out.includes(`127.0.0.1:${freePort}/`)) assert.ok(!out.includes('쓰이는 중'), out);

    // 기본 포트(4848)가 쓰이는 중이어도 알려요. 이미 다른 것이 쓰고 있으면 그대로 그 상태로 시험해요.
    const dflt = await occupy(DEFAULT_PORT);
    if (dflt) held.push(dflt);
    out = await viewOutput(s, []);
    assert.match(out, new RegExp(`^\\[알림\\] 기본 ${DEFAULT_PORT}번 포트가 쓰이는 중이라 \\d+번 포트로 열었어요\\.\\n {7}${DEFAULT_PORT}번 포트는 다른 프로그램\\(앞서 연 화면 등\\)이 쓰고 있어요\\.$`, 'm'), out);
  } finally {
    for (const h of held) await h.close();
    s.cleanup();
  }
});
