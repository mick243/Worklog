// 멈춘 보관본 다시 가리기 알림과 데이터 폴더 쓰기 실패 시험 (A16, Q21, PRD 5장·S1~S4, DESIGN S3 오류).
// - 파일을 바꾸기 시작한 뒤 멈춘 다시 쓰기 기록이 남아 있으면 check(S4)는 [알림]을 띄우고 판정 기준·종료 코드는 그대로예요. view(S1·S2)도 같은 뜻을 배너로 보여 줘요.
// - 바꾸기 시작하기 전에 멈춘 기록이면 알리지 않아요. check·view는 기록·임시 파일을 지우지 않아요.
// - 다시 쓰기 기록이 깨져 읽을 수 없으면 check·view·일지 만들기·보관은 "다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요" + cc-worklog redact 안내를 보여 줘요.
//   일지 만들기·보관은 하던 일을 끝내고(종료 코드 그대로) 깨진 기록과 임시 파일을 건드리지 않아요.
// - redact는 임시 파일을 읽지 않고 지금 파일로 다시 세요. 확인·--yes면 지우고 다시 쓰고, 거절·확인 불가면 아무것도 지우거나 만들지 않아요(종료 코드 1).
//   바뀔 자리가 0개면 묻지 않고 깨진 기록과 임시 파일만 지워요(종료 코드 0).
// - 깨진 기록에서 시작한 redact가 확인 뒤 확정 전에 멈추거나 되돌려지면(그 자리의 Ctrl+C·쓰기 오류, 갑자기 꺼진 뒤 다음 실행) "깨짐" 표시가 다시 남아
//   check·view·다음 실행이 깨진 기록 알림을 계속 보여 줘요. 되돌리기 전에도 check·view는 깨진 기록처럼 알려요. 확정 뒤에 멈추면 보통 때처럼 마저 끝내요.
//   쓰기 오류로 되돌린 뒤 깨짐 표시마저 쓰지 못해 fromBroken "준비 중" 기록이 남아도 그 자리의 [실패]는 보통 때와 같아요(6회차).
// - 데이터 폴더에 쓰지 못하면 [실패] 데이터 폴더에 쓰지 못했어요 / 경로 / 다음: 줄을 표준 오류로 보여 줘요(종료 코드 1).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCheckReport } from '../src/commands/check.js';
import { runRedact, type RedactIo } from '../src/commands/redact.js';
import { resolveConfig } from '../src/config.js';
import { JOURNAL_NAME, pendingNotice, readJournalState, STAGED_SUFFIX } from '../src/redact/journal.js';
import { painterFor } from '../src/term/format.js';
import { renderRedactAborted } from '../src/term/s3-redact.js';
import { MAKE_TEXT } from '../src/term/s3-summary.js';
import { lockPathFor } from '../src/util/lock.js';
import { startServer } from '../src/web/server.js';
import {
  APP_DIR,
  assistantText,
  commitAt,
  fingerprint,
  initRepo,
  kst,
  lastCheckRow,
  listFilesRec,
  rowText,
  runCli,
  sandbox,
  snapshotDir,
  userText,
  writeSession,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-15';
const ME = 'dev.kim@example.test';
const T1 = 'CORP-12345678';
const T2 = 'CORP-87654321';
const T3 = 'CORP-55554444';
const PATTERNS = JSON.stringify([{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}', samples: ['CORP-00000000'] }]);
const SID_A = 'ef000000-0000-4000-8000-00000000000a';
const SID_B = 'ef000000-0000-4000-8000-00000000000b';
/** 지난번 실행이 남긴 새 내용 임시 파일 안 글 (다시 가리기가 이 글을 쓰면 안 돼요) */
const STALE = 'STALE-STAGED-CONTENT-QZX';

/** 검사(S4)의 확정 뒤 멈춘 기록 [알림] (DESIGN S4 9번: 판정 기준 문장과 다시 검사 안내까지) */
const UNFINISHED = /^\[알림\] 지난번 보관본 다시 가리기가 끝나지 않아 일부 파일만 바뀐 상태일 수 있어요\. 다음 cc-worklog·cc-worklog archive·cc-worklog redact 실행이 마저 끝내요\. 판정은 지금 파일 기준이에요\. 마저 끝낸 뒤 다시 검사하세요\.$/;
/** 일지 만들기·보관(S3)의 깨진 기록 [알림] */
const BROKEN = /^\[알림\] 다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요\. 지난번 보관본 다시 가리기가 일부 파일만 바꾼 채 멈췄을 수 있어요\. cc-worklog redact를 다시 실행하세요\./;
/** 검사(S4)의 깨진 기록 [알림] (DESIGN S4 9번) */
const BROKEN_CHECK = /^\[알림\] 다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요\. 지난번 보관본 다시 가리기가 일부 파일만 바꾼 채 멈췄을 수 있어요\. 판정은 지금 파일 기준이에요\. cc-worklog redact를 다시 실행한 뒤 다시 검사하세요\.$/;
const ANY_JOURNAL_NOTICE = /다시 가리기가 끝나지 않아|다시 쓰기 기록이 깨져|다시 가리기 덜 끝남|다시 가리기 기록 깨짐/;

function cfgOf(s: Sandbox) {
  return resolveConfig({ claudeDir: s.claudeDir, dataDir: s.dataDir });
}

/** 세션 2개·커밋 1개로 일지와 보관본을 만든 뒤 사용자 패턴을 더해 둔 상자 (사내 토큰은 아직 안 가려져 있어요) */
function smallSandbox(): { s: Sandbox; originalA: string } {
  const s = sandbox();
  const cwd = join(s.root, 'work', 'svc');
  initRepo(s, cwd, ME);
  commitAt(s, cwd, `릴리스 ${T1}`, '2026-10-15T12:00:00+09:00');
  const A = { sid: SID_A, cwd };
  const originalA = writeSession(s, cwd, SID_A, [userText({ ...A, ts: kst(DATE, '10:00') }, `토큰 ${T1} 써 줘`), assistantText({ ...A, ts: kst(DATE, '10:01') }, `${T2} 도요`)]);
  const B = { sid: SID_B, cwd };
  writeSession(s, cwd, SID_B, [userText({ ...B, ts: kst(DATE, '11:00') }, `또 ${T3}`), assistantText({ ...B, ts: kst(DATE, '11:01') }, '네')]);
  assert.equal(runCli(s, ['--date', DATE]).code, 0);
  writeFileSync(join(s.dataDir, 'patterns.json'), PATTERNS);
  return { s, originalA };
}

function runCrash(s: Sandbox, phase: 'stage' | 'rename' | 'interrupt' | 'enospc' | 'enospc-nomark', n: number) {
  return spawnSync(process.execPath, [join(APP_DIR, 'test', 'fixtures', 'redact-crash.mjs'), s.claudeDir, s.dataDir, phase, String(n)], {
    env: s.env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

/** 깨진 다시 쓰기 기록과 지난번 실행이 남긴 새 내용 임시 파일을 심어요. 심은 임시 파일 경로를 돌려줘요. */
function plantBroken(s: Sandbox): string[] {
  writeFileSync(join(s.dataDir, JOURNAL_NAME), '{"schema":1,"state":"comm');
  const archive = listFilesRec(join(s.dataDir, 'archive', 'projects')).find((p) => p.endsWith(`${SID_A}.jsonl`))!;
  const staged = [join(s.dataDir, 'worklogs', `${DATE}.md${STAGED_SUFFIX}`), `${archive}${STAGED_SUFFIX}`];
  for (const p of staged) writeFileSync(p, `${STALE}\n`);
  return staged;
}

function stagedFiles(s: Sandbox): string[] {
  return listFilesRec(s.dataDir).filter((p) => p.endsWith(STAGED_SUFFIX));
}

/** 사내 토큰 값이 든 결과물 (patterns.json의 시험 값은 빼요) */
function filesWithCorp(dir: string): string[] {
  return listFilesRec(dir).filter((p) => !p.endsWith('patterns.json') && /CORP-[0-9]{8}/.test(readFileSync(p, 'utf8')));
}

function fakeIo(answer: string | null): RedactIo & { out: string; err: string; asked: number } {
  const io = {
    interactive: true,
    color: false,
    errColor: false,
    out: '',
    err: '',
    asked: 0,
    write(x: string) {
      io.out += x;
    },
    writeErr(x: string) {
      io.err += x;
    },
    async ask(q: string) {
      io.out += q;
      io.asked++;
      return answer;
    },
  };
  return io;
}

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 로컬 화면(S1·S2)을 한 번씩 열어 HTML을 돌려줘요. 서버는 끝에 꺼요. */
async function viewPages(s: Sandbox): Promise<{ s1: string; s2: string }> {
  const { server, port } = await startServer({ dataDir: s.dataDir, port: 0, hideIdentity: false });
  try {
    return { s1: await get(port, '/'), s2: await get(port, `/day/${DATE}`) };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

/** check를 돌리고, 같은 데이터 폴더의 판정(passed)과 종료 코드가 맞는지 봐요(알림이 판정을 바꾸지 않아요). */
async function checkKeepsVerdict(s: Sandbox) {
  const r = runCli(s, ['check']);
  const report = await buildCheckReport(cfgOf(s));
  assert.equal(r.code, report.passed ? 0 : 1, r.stdout);
  assert.match(r.stdout, report.passed ? /\[통과\] 남은 의심 0건/ : /\[실패\] 남은 의심 \d+건/);
  return { r, report };
}

/** 보관본·일지·색인의 지문 (다시 쓰기 기록과 새 내용 임시 파일은 빼요) */
function contentSnapshot(s: Sandbox) {
  return Object.fromEntries(Object.entries(snapshotDir(s.dataDir)).filter(([rel]) => rel !== JOURNAL_NAME && !rel.endsWith(STAGED_SUFFIX)));
}

/** 다시 쓰기 기록이 "깨짐" 표시이고(옛 내용·경로 목록 없음), 남은 새 내용 임시 파일이 없는지 봐요. */
function expectBrokenMark(s: Sandbox) {
  assert.equal(readJournalState(s.dataDir).state, 'broken');
  const raw = readFileSync(join(s.dataDir, JOURNAL_NAME), 'utf8');
  const j = JSON.parse(raw) as { state: string; files: unknown[] };
  assert.equal(j.state, 'broken', raw);
  assert.deepEqual(j.files, [], '깨짐 표시에는 경로 목록도 담지 않아요');
  assert.ok(!/CORP-[0-9]{8}/.test(raw) && !raw.includes(STALE), '깨짐 표시에 옛 내용이 없어요');
  assert.deepEqual(stagedFiles(s), []);
}

/** check·view가 깨진 기록 알림과 redact 안내를 보여 주고, 아무것도 바꾸지 않는지 봐요. */
async function expectBrokenNotices(s: Sandbox) {
  const before = snapshotDir(s.dataDir);
  const { r, report } = await checkKeepsVerdict(s);
  assert.equal(report.journal, 'broken');
  assert.match(rowText(r.stdout, '[알림]'), BROKEN_CHECK);
  const { s1, s2 } = await viewPages(s);
  for (const page of [s1, s2]) {
    assert.match(page, /<div class="banner banner--warning" role="status"><strong class="banner__title">다시 가리기 기록 깨짐<\/strong>/);
    assert.match(page, /<code>cc-worklog redact<\/code>를 다시 실행하세요/);
  }
  assert.deepEqual(snapshotDir(s.dataDir), before, 'check·view는 읽기만 해요');
}

/** 정리된 뒤: 기록·임시 파일·남은 값이 없고, check가 알림 없이 통과하고, 화면 배너도 없어요. */
async function expectCleared(s: Sandbox) {
  assert.equal(readJournalState(s.dataDir).state, 'none');
  assert.deepEqual(stagedFiles(s), []);
  assert.deepEqual(filesWithCorp(s.dataDir), []);
  const c = await checkKeepsVerdict(s);
  assert.equal(c.r.code, 0, c.r.stdout);
  assert.ok(!ANY_JOURNAL_NOTICE.test(c.r.stdout), c.r.stdout);
  const pages = await viewPages(s);
  assert.ok(!ANY_JOURNAL_NOTICE.test(pages.s1 + pages.s2));
}

const ROLLED_BACK = /^\[알림\] 지난번에 멈춘 보관본 다시 가리기를 되돌렸어요\. 그때 바뀐 파일은 없어요\.$/;
const CLEARED_AFTER_WRITE = /^\[알림\] 깨진 다시 쓰기 기록을 지웠어요\. 검사·화면의 알림도 더는 나오지 않아요\.$/;
/** 다시 가리기(S3 확인 출력)의 깨진 기록 [알림]: 지금 파일로 바뀔 자리를 다시 셌다는 문장 */
const BROKEN_RECOUNT = /^\[알림\] 다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요\. 그래서 이번 실행은 지난번 기록 없이 지금 파일로 바뀔 자리를 다시 셌어요\.$/;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * firstStart로 시작하는 [알림](80칸을 넘겨 들여 쓴 이어지는 줄 포함) 바로 다음 줄이 nextStart로 시작하는지 봐요.
 * 두 [알림] 사이에 빈 줄이 없는 것까지 보려고 써요(DESIGN S3: 되돌림 [알림] 바로 다음 줄에 깨진 기록 [알림]).
 */
function expectNoticeFollows(out: string, firstStart: string, nextStart: string) {
  const lines = out.split(/\r?\n/);
  let i = lines.findIndex((l) => l.startsWith(firstStart));
  assert.ok(i >= 0, `${firstStart} 줄이 없어요:\n${out}`);
  i++;
  while (i < lines.length && /^ +\S/.test(lines[i]!)) i++;
  assert.ok((lines[i] ?? '').startsWith(nextStart), `${firstStart} 바로 다음 줄(빈 줄 없이)이 ${nextStart}로 시작해야 해요:\n${out}`);
}

/** 기록 파일을 쓰다 남은 임시 파일(redact-journal.json.tmp-*) */
function journalTemps(s: Sandbox): string[] {
  return readdirSync(s.dataDir).filter((n) => n.startsWith(`${JOURNAL_NAME}.tmp-`));
}

test('다시 쓰기 기록 읽기: 없음·준비 중·확정·깨짐을 나누고, 읽기만 해요', () => {
  const s = sandbox();
  try {
    mkdirSync(s.dataDir, { recursive: true });
    const path = join(s.dataDir, JOURNAL_NAME);
    assert.equal(readJournalState(s.dataDir).state, 'none');
    writeFileSync(path, JSON.stringify({ schema: 1, state: 'preparing', createdAt: 'x', files: ['worklogs/2026-10-15.md'] }));
    assert.equal(readJournalState(s.dataDir).state, 'preparing');
    assert.equal(pendingNotice(s.dataDir), null, '보통 다시 가리기의 준비 중 기록은 알리지 않아요');
    writeFileSync(path, JSON.stringify({ schema: 1, state: 'committed', createdAt: 'x', files: ['archive/index.json'] }));
    assert.equal(readJournalState(s.dataDir).state, 'committed');
    assert.equal(pendingNotice(s.dataDir), 'unfinished');
    // 깨진 기록에서 시작한 준비 중 기록: 상태는 준비 중이지만 검사·화면은 깨진 기록처럼 알려요(A16).
    writeFileSync(path, JSON.stringify({ schema: 1, state: 'preparing', createdAt: 'x', files: ['worklogs/2026-10-15.md'], fromBroken: true }));
    const fromBroken = readJournalState(s.dataDir);
    assert.equal(fromBroken.state, 'preparing');
    assert.equal(fromBroken.state === 'preparing' && fromBroken.journal.fromBroken, true);
    assert.equal(pendingNotice(s.dataDir), 'broken');
    // "깨짐" 표시
    writeFileSync(path, JSON.stringify({ schema: 1, state: 'broken', createdAt: 'x', files: [] }));
    assert.equal(readJournalState(s.dataDir).state, 'broken');
    assert.equal(pendingNotice(s.dataDir), 'broken');
    const broken = [
      '{not json',
      '',
      '[]',
      JSON.stringify({ schema: 2, state: 'committed', files: [] }),
      JSON.stringify({ schema: 1, state: 'done', files: [] }),
      JSON.stringify({ schema: 1, state: 'committed', files: 'worklogs/a.md' }),
      JSON.stringify({ schema: 1, state: 'committed', files: ['../outside.txt'] }),
      JSON.stringify({ schema: 1, state: 'preparing', files: ['worklogs/a.md'], fromBroken: 'yes' }),
    ];
    for (const raw of broken) {
      writeFileSync(path, raw);
      const before = fingerprint(path);
      assert.equal(readJournalState(s.dataDir).state, 'broken', raw);
      assert.deepEqual(fingerprint(path), before, '읽기만 해요');
    }
    // 데이터 폴더 자리에 파일이 있어도 "없음"이에요(이 경우는 쓰기 실패로 따로 알려요).
    const file = join(s.root, 'not-a-folder');
    writeFileSync(file, 'x');
    assert.equal(readJournalState(file).state, 'none');
  } finally {
    s.cleanup();
  }
});

test('파일을 바꾸기 시작한 뒤 멈춘 기록이 있으면 check는 [알림]을 띄우고 판정·종료 코드는 그대로예요. view도 배너로 알리고, 둘 다 아무것도 지우지 않아요', async () => {
  const { s } = smallSandbox();
  try {
    const crash = runCrash(s, 'rename', 1);
    assert.notEqual(crash.status, 0);
    assert.equal(readJournalState(s.dataDir).state, 'committed');
    assert.ok(stagedFiles(s).length > 0, '아직 바꾸지 않은 새 내용 파일이 남아 있어야 해요');
    const before = snapshotDir(s.dataDir);

    const { r, report } = await checkKeepsVerdict(s);
    assert.equal(report.journal, 'unfinished');
    assert.match(rowText(r.stdout, '[알림]'), UNFINISHED);
    assert.equal(r.code, 1, '아직 바뀌지 않은 파일의 값은 남은 의심으로 잡혀요');
    assert.ok(!/CORP-[0-9]{8}/.test(r.stdout));

    const { s1, s2 } = await viewPages(s);
    for (const page of [s1, s2]) {
      assert.match(page, /<div class="banner banner--warning" role="status"><strong class="banner__title">다시 가리기 덜 끝남<\/strong>/);
      assert.match(page, /일부 파일만 바뀐 상태일 수 있어요/);
      assert.match(page, /<code>cc-worklog<\/code>·<code>cc-worklog archive<\/code>·<code>cc-worklog redact<\/code> 중 하나를 실행하면 마저 끝내요/);
      assert.ok(!/<script/i.test(page), '페이지에 스크립트가 없어요');
    }
    assert.deepEqual(snapshotDir(s.dataDir), before, 'check·view는 기록·임시 파일을 지우거나 바꾸지 않아요');

    // 다음 보관이 마저 끝내면 알림이 사라지고 검사가 통과해요.
    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /지난번에 멈춘 보관본 다시 가리기를 마저 끝냈어요/);
    const after = await checkKeepsVerdict(s);
    assert.equal(after.r.code, 0, after.r.stdout);
    assert.ok(!ANY_JOURNAL_NOTICE.test(after.r.stdout));
    const pages = await viewPages(s);
    assert.ok(!ANY_JOURNAL_NOTICE.test(pages.s1 + pages.s2));
  } finally {
    s.cleanup();
  }
});

test('모두 바뀐 뒤 기록만 남은 경우에도 check는 [알림]만 더하고 통과 판정(종료 코드 0)은 그대로예요', async () => {
  const { s } = smallSandbox();
  try {
    assert.equal(runCli(s, ['redact', '--yes']).code, 0);
    // 마지막 이름 바꾸기 뒤, 기록 파일을 지우기 직전에 멈춘 모습
    writeFileSync(join(s.dataDir, JOURNAL_NAME), JSON.stringify({ schema: 1, state: 'committed', createdAt: 'x', files: [`worklogs/${DATE}.md`] }));
    const { r } = await checkKeepsVerdict(s);
    assert.equal(r.code, 0, r.stdout);
    assert.match(rowText(r.stdout, '[알림]'), UNFINISHED);
    assert.ok(existsSync(join(s.dataDir, JOURNAL_NAME)), 'check는 기록 파일을 지우지 않아요');
  } finally {
    s.cleanup();
  }
});

test('파일을 바꾸기 시작하기 전에 멈춘 기록이면 check·view는 알리지 않고, 기록·임시 파일도 그대로 둬요', async () => {
  const { s } = smallSandbox();
  try {
    const crash = runCrash(s, 'stage', 1);
    assert.notEqual(crash.status, 0);
    assert.equal(readJournalState(s.dataDir).state, 'preparing');
    assert.ok(stagedFiles(s).length > 0);
    const before = snapshotDir(s.dataDir);

    const { r, report } = await checkKeepsVerdict(s);
    assert.equal(report.journal, null);
    assert.ok(!ANY_JOURNAL_NOTICE.test(r.stdout), r.stdout);
    const { s1, s2 } = await viewPages(s);
    assert.ok(!ANY_JOURNAL_NOTICE.test(s1 + s2));
    assert.deepEqual(snapshotDir(s.dataDir), before);

    // 다음 보관이 새 내용 파일만 지워 되돌리고, 죽은 실행이 남긴 잠금도 치워요.
    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /지난번에 멈춘 보관본 다시 가리기를 되돌렸어요/);
    assert.deepEqual(stagedFiles(s), []);
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
  } finally {
    s.cleanup();
  }
});

test('다시 쓰기 기록이 깨지면 check·view는 깨진 기록 알림과 redact 안내를 보여 주고, 판정은 그대로이며 아무것도 지우지 않아요', async () => {
  const { s } = smallSandbox();
  try {
    plantBroken(s);
    const before = snapshotDir(s.dataDir);

    const { r, report } = await checkKeepsVerdict(s);
    assert.equal(report.journal, 'broken');
    assert.match(rowText(r.stdout, '[알림]'), BROKEN_CHECK);
    assert.ok(!/이어서 끝내요/.test(r.stdout + r.stderr), '깨진 기록에는 "닫고 다시 실행하면 이어서 끝내요" 안내가 맞지 않아요');

    const { s1, s2 } = await viewPages(s);
    for (const page of [s1, s2]) {
      assert.match(page, /<div class="banner banner--warning" role="status">/);
      assert.match(page, /다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요\./);
      assert.match(page, /<code>cc-worklog redact<\/code>를 다시 실행하세요/);
      assert.ok(!page.includes(STALE), '화면은 임시 파일을 읽지 않아요');
    }
    assert.deepEqual(snapshotDir(s.dataDir), before, 'check·view는 깨진 기록과 임시 파일을 지우지 않아요');
  } finally {
    s.cleanup();
  }
});

test('깨진 기록이 있어도 보관·일지 만들기는 하던 일을 끝내고(종료 코드 0) 알림·안내를 더하며, 깨진 기록과 임시 파일은 건드리지 않아요', () => {
  const { s, originalA } = smallSandbox();
  try {
    const staged = plantBroken(s);
    const keep = [join(s.dataDir, JOURNAL_NAME), ...staged];
    const fps = keep.map((p) => fingerprint(p));
    appendFileSync(originalA, `${userText({ sid: SID_A, cwd: join(s.root, 'work', 'svc'), ts: kst(DATE, '18:00') }, '저녁 작업')}\n`);

    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    assert.ok(!a.stderr.includes('[실패]'), a.stderr);
    assert.match(a.stdout, /이어 붙임 1개/, '보관은 그대로 해요');
    assert.match(rowText(a.stdout, '[알림]'), BROKEN);
    assert.match(a.stdout, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/);
    assert.deepEqual(keep.map((p) => fingerprint(p)), fps, '보관은 깨진 기록과 임시 파일을 건드리지 않아요');

    const m = runCli(s, ['--date', DATE]);
    assert.equal(m.code, 0, m.stderr);
    assert.match(rowText(m.stdout, '[알림]'), BROKEN);
    // 끝 검사 줄은 그대로예요. 이름·이메일 가리기를 끈 채 만들어서 그 아래에 A19 안내가 이어져요(PRD S3, I-01).
    assert.equal(lastCheckRow(m.stdout), `검사 공개 전에 cc-worklog check로 확인하세요 ${MAKE_TEXT.checkIdentityAll}`, m.stdout);
    assert.ok(readFileSync(join(s.dataDir, 'worklogs', `${DATE}.md`), 'utf8').includes('저녁 작업'), '일지도 그대로 만들어요');
    assert.deepEqual(keep.map((p) => fingerprint(p)), fps, '일지 만들기도 깨진 기록과 임시 파일을 건드리지 않아요');
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
  } finally {
    s.cleanup();
  }
});

test('redact: 깨진 기록에서 거절·질문 중단·확인 불가면 아무것도 지우거나 만들지 않고 다시 실행하라고 안내해요 (종료 코드 1). --yes면 지우고 다시 써요', async () => {
  const { s } = smallSandbox();
  try {
    plantBroken(s);
    const before = snapshotDir(s.dataDir);

    for (const answer of ['', 'n', null]) {
      const io = fakeIo(answer);
      const code = await runRedact(cfgOf(s), { yes: false, io });
      assert.equal(code, 1, `${String(answer)}: ${io.out}`);
      assert.equal(io.asked, 1);
      assert.match(rowText(io.out, '[알림]'), /^\[알림\] 다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요\. 그래서 이번 실행은 지난번 기록 없이 지금 파일로 바뀔 자리를 다시 셌어요\./);
      assert.match(io.out, /worklogs\/2026-10-15\.md$/m, '지금 파일로 센 바뀔 일지가 보여요');
      assert.match(io.out, /\[취소\]/);
      assert.match(io.out, /깨진 다시 쓰기 기록은 그대로 남아 있어서 검사·화면의 알림도 계속 나와요/);
      assert.match(rowText(io.out, '다음:'), /cc-worklog redact를 다시 실행하세요/);
      assert.ok(!io.out.includes('공개 전에 cc-worklog check로 확인하세요'), '멈춘 경우에는 검사 줄을 넣지 않아요');
      assert.deepEqual(snapshotDir(s.dataDir), before, `${String(answer)}: 데이터 폴더가 바뀌었어요`);
    }

    const ni = runCli(s, ['redact']);
    assert.equal(ni.code, 1, ni.stdout + ni.stderr);
    assert.match(ni.stdout, /다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요/);
    assert.match(ni.stdout, /깨진 다시 쓰기 기록은 그대로 남아 있어서/);
    assert.match(ni.stdout, /--yes를 붙여 다시 실행하세요/);
    assert.deepEqual(snapshotDir(s.dataDir), before, '확인 불가: 데이터 폴더가 바뀌었어요');
    assert.ok(!existsSync(lockPathFor(s.dataDir)));

    const y = runCli(s, ['redact', '--yes']);
    assert.equal(y.code, 0, y.stdout + y.stderr);
    assert.match(rowText(y.stdout, '[알림] 깨진'), /깨진 다시 쓰기 기록과 남은 임시 파일 2개를 지웠어요\. 검사·화면의 알림도 더는 나오지 않아요\./);
    assert.ok(!existsSync(join(s.dataDir, JOURNAL_NAME)));
    assert.deepEqual(stagedFiles(s), []);
    assert.deepEqual(filesWithCorp(s.dataDir), []);
  } finally {
    s.cleanup();
  }
});

test('redact: 깨진 기록에서 확인하면 깨진 기록과 임시 파일을 지우고 지금 규칙으로 다시 써요 (임시 파일 내용은 쓰지 않아요)', async () => {
  const { s } = smallSandbox();
  try {
    plantBroken(s);
    const io = fakeIo('y');
    const code = await runRedact(cfgOf(s), { yes: false, io });
    assert.equal(code, 0, io.out + io.err);
    assert.equal(io.asked, 1);
    assert.match(rowText(io.out, '[알림] 깨진'), /깨진 다시 쓰기 기록과 남은 임시 파일 2개를 지웠어요\. 검사·화면의 알림도 더는 나오지 않아요\./);
    assert.match(io.out, /새로 가림 +모두 \d+개/);
    assert.ok(!existsSync(join(s.dataDir, JOURNAL_NAME)));
    assert.deepEqual(stagedFiles(s), []);
    assert.deepEqual(filesWithCorp(s.dataDir), []);
    assert.ok(!listFilesRec(s.dataDir).some((p) => readFileSync(p, 'utf8').includes(STALE)), '지난번 임시 파일 내용이 쓰이면 안 돼요');
    const c = await checkKeepsVerdict(s);
    assert.equal(c.r.code, 0, c.r.stdout);
    assert.ok(!ANY_JOURNAL_NOTICE.test(c.r.stdout));
  } finally {
    s.cleanup();
  }
});

test('redact: 깨진 기록인데 바뀔 자리가 0개면 묻지 않고 깨진 기록과 임시 파일만 지우고 정리했다고 알려요 (확인 불가 환경에서도 종료 코드 0)', async () => {
  const { s } = smallSandbox();
  try {
    assert.equal(runCli(s, ['redact', '--yes']).code, 0);
    const before = snapshotDir(s.dataDir);
    plantBroken(s);

    const r = runCli(s, ['redact']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /바뀔 자리 {3}0개/);
    assert.match(r.stdout, /다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요/);
    assert.match(rowText(r.stdout, '[알림] 깨진'), /깨진 다시 쓰기 기록과 남은 임시 파일 2개를 지워 정리했어요/);
    assert.match(r.stdout, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/);
    assert.deepEqual(snapshotDir(s.dataDir), before, '깨진 기록과 임시 파일만 지우고 보관본·일지는 그대로예요');

    const c = await checkKeepsVerdict(s);
    assert.equal(c.r.code, 0);
    assert.ok(!ANY_JOURNAL_NOTICE.test(c.r.stdout), '정리한 뒤에는 알림이 없어요');
    const io = fakeIo('y');
    assert.equal(await runRedact(cfgOf(s), { yes: false, io }), 0);
    assert.equal(io.asked, 0);
  } finally {
    s.cleanup();
  }
});

test('redact: 깨진 기록에서 확인한 뒤 새 내용을 쓰는 중 Ctrl+C·쓰기 오류로 그 자리에서 되돌리면 "깨짐" 표시가 다시 남아 check·view·다음 실행이 계속 알려요', async () => {
  const { s } = smallSandbox();
  try {
    plantBroken(s);
    const content = contentSnapshot(s);

    // ① 새 내용을 쓰는 중 Ctrl+C: [실패] 문구는 보통 때와 같고, 깨짐 표시가 남아요.
    const r = runCrash(s, 'interrupt', 1);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^\[실패\] 다시 쓰다 멈췄어요 \(Ctrl\+C를 받았어요\)$/m);
    assert.match(r.stderr, /바뀐 파일은 없어요/);
    assert.ok(!r.stdout.includes('[실패]'), r.stdout);
    expectBrokenMark(s);
    assert.deepEqual(contentSnapshot(s), content, '보관본·일지·색인은 그대로예요');
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
    await expectBrokenNotices(s);

    // 다음 redact(확인 불가): 그 자리에서 이미 되돌려서 되돌림 [알림]은 없고, 첫 [알림]이 다시 셈 [알림]이에요. 아무것도 바꾸지 않아요(6회차 시험).
    const beforeRedact = snapshotDir(s.dataDir);
    const ni = runCli(s, ['redact']);
    assert.equal(ni.code, 1, ni.stdout + ni.stderr);
    assert.ok(!ni.stdout.includes('되돌렸어요'), ni.stdout);
    assert.match(rowText(ni.stdout, '[알림]'), BROKEN_RECOUNT);
    assert.match(ni.stdout, /\[취소\]/);
    assert.match(ni.stdout, /깨진 다시 쓰기 기록은 그대로 남아 있어서 검사·화면의 알림도 계속 나와요/);
    assert.deepEqual(snapshotDir(s.dataDir), beforeRedact, '확인 불가: 데이터 폴더가 바뀌었어요');
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
    expectBrokenMark(s);

    // 다음 보관: 그 자리에서 이미 되돌려서 되돌림 [알림]은 없고, 깨진 기록 [알림]만 나와요. 깨짐 표시는 그대로예요.
    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(rowText(a.stdout, '[알림]'), BROKEN);
    assert.ok(!a.stdout.includes('되돌렸어요'), a.stdout);
    assert.match(a.stdout, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/);
    expectBrokenMark(s);

    // ② 확정 전 쓰기 오류(ENOSPC): 보통 때와 같은 [실패]와 쓰기 오류 다음: 줄, 깨짐 표시가 남아요.
    const e = runCrash(s, 'enospc', 1);
    assert.equal(e.status, 1, e.stdout + e.stderr);
    assert.match(e.stderr, /^\[실패\] 다시 쓰다 멈췄어요 \(ENOSPC\)$/m);
    assert.match(e.stderr, /바뀐 파일은 없어요/);
    assert.match(rowText(e.stderr, '다음:'), /^다음: 디스크 공간과 폴더 권한을 확인한 뒤 다시 실행하세요\./);
    expectBrokenMark(s);
    await expectBrokenNotices(s);
    const m = runCli(s, ['--date', DATE]);
    assert.equal(m.code, 0, m.stderr);
    assert.match(rowText(m.stdout, '[알림]'), BROKEN);

    // redact --yes로 정리하면 알림이 사라져요.
    const y = runCli(s, ['redact', '--yes']);
    assert.equal(y.code, 0, y.stdout + y.stderr);
    assert.match(rowText(y.stdout, '[알림] 깨진'), CLEARED_AFTER_WRITE);
    await expectCleared(s);
  } finally {
    s.cleanup();
  }
});

test('redact: 깨진 기록에서 확인한 뒤 새 내용을 쓰다 갑자기 꺼지면, 되돌리기 전에도 check·view가 깨진 기록으로 알리고, 다음 실행은 되돌린 뒤 "깨짐" 표시를 다시 남겨요', async () => {
  const { s } = smallSandbox();
  try {
    plantBroken(s);
    const content = contentSnapshot(s);

    const crash = runCrash(s, 'stage', 1);
    assert.notEqual(crash.status, 0);
    const st = readJournalState(s.dataDir);
    assert.equal(st.state, 'preparing');
    assert.equal(st.state === 'preparing' && st.journal.fromBroken, true, '준비 중 기록에 깨진 기록에서 시작했다는 칸이 있어요');
    const raw = readFileSync(join(s.dataDir, JOURNAL_NAME), 'utf8');
    assert.ok(!/CORP-[0-9]{8}/.test(raw) && !raw.includes(STALE), '기록에 옛 내용이 없어요');
    assert.equal(stagedFiles(s).length, 1, '지난번 임시 파일 2개는 지웠고 이번에 쓴 새 내용 파일 1개만 남아요');
    assert.deepEqual(contentSnapshot(s), content, '보관본·일지·색인은 그대로예요');

    // 되돌리기 전(갑자기 꺼진 직후)에도 check·view는 깨진 기록처럼 알리고, 아무것도 지우지 않아요.
    await expectBrokenNotices(s);

    // 다음 보관이 되돌리고 깨짐 표시를 다시 남겨요: 되돌림 [알림] 바로 뒤에 깨진 기록 [알림].
    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(rowText(a.stdout, '[알림]'), ROLLED_BACK);
    assert.match(rowText(a.stdout, '[알림] 다시 쓰기 기록이 깨져'), BROKEN);
    expectNoticeFollows(a.stdout, '[알림] 지난번에 멈춘 보관본 다시 가리기를 되돌렸어요', '[알림] 다시 쓰기 기록이 깨져');
    assert.match(a.stdout, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/);
    expectBrokenMark(s);
    assert.ok(!existsSync(lockPathFor(s.dataDir)), '죽은 실행이 남긴 잠금도 치웠어요');
    await expectBrokenNotices(s);

    // 다시 깨진 기록에서 시작해 꺼진 뒤 다음 실행이 redact여도 같아요(확인 불가: 되돌리고 깨짐 표시를 남긴 뒤 [취소]).
    assert.notEqual(runCrash(s, 'stage', 1).status, 0);
    const ni = runCli(s, ['redact']);
    assert.equal(ni.code, 1, ni.stdout + ni.stderr);
    assert.match(rowText(ni.stdout, '[알림]'), ROLLED_BACK);
    assert.match(rowText(ni.stdout, '[알림] 다시 쓰기 기록이 깨져'), BROKEN_RECOUNT);
    expectNoticeFollows(ni.stdout, '[알림] 지난번에 멈춘 보관본 다시 가리기를 되돌렸어요', '[알림] 다시 쓰기 기록이 깨져');
    assert.match(ni.stdout, /깨진 다시 쓰기 기록은 그대로 남아 있어서 검사·화면의 알림도 계속 나와요/);
    expectBrokenMark(s);

    // redact --yes로 정리하면 알림이 사라져요.
    const y = runCli(s, ['redact', '--yes']);
    assert.equal(y.code, 0, y.stdout + y.stderr);
    assert.ok(!y.stdout.includes('되돌렸어요'), y.stdout);
    assert.match(rowText(y.stdout, '[알림] 깨진'), CLEARED_AFTER_WRITE);
    await expectCleared(s);
  } finally {
    s.cleanup();
  }
});

test(
  'redact: 깨진 기록에서 확인한 뒤 확정 전 쓰기 오류로 되돌렸는데 "깨짐" 표시마저 쓰지 못해도 [실패] 세 줄은 보통 때와 같고, 남은 fromBroken 준비 중 기록으로 check·view·다음 실행이 계속 알려요',
  { skip: isRoot ? '관리자 계정(POSIX root)은 읽기 전용 권한을 무시해서 깨짐 표시 쓰기 실패를 흉내 낼 수 없어요' : false },
  async () => {
    const { s } = smallSandbox();
    try {
      plantBroken(s);
      const content = contentSnapshot(s);

      // 새 내용 파일 1개를 쓴 뒤 기록 파일을 읽기 전용으로 바꾸고(POSIX는 데이터 폴더도) ENOSPC를 흉내 내요. markBroken이 실패해요.
      const e = runCrash(s, 'enospc-nomark', 1);
      assert.equal(e.status, 1, e.stdout + e.stderr);
      assert.equal(e.stderr, renderRedactAborted('ENOSPC', 'write-error', painterFor(false)), '보통 확정 전 쓰기 오류의 [실패]와 글자·줄까지 같아요');
      assert.match(e.stderr, /^\[실패\] 다시 쓰다 멈췄어요 \(ENOSPC\)$/m);
      assert.match(e.stderr, /파일은 깨지지 않았어요\. 새로 쓰던 내용은 지웠고 바뀐 파일은 없어요\./);
      assert.match(rowText(e.stderr, '다음:'), /^다음: 디스크 공간과 폴더 권한을 확인한 뒤 다시 실행하세요\. 바뀔 자리를 처음부터 다시 세서 보여 줘요\.$/);
      assert.ok(!/실행하지 못했어요|폴더 경로와 읽기·쓰기 권한|runRedact가 오류를 던졌어요/.test(e.stdout + e.stderr), '일반 [실패]로 넘기지 않아요');
      assert.ok(!e.stdout.includes('[실패]'), e.stdout);

      // 깨짐 표시는 쓰지 못해 fromBroken "준비 중" 기록이 남아요(옛 내용 없음). 새 내용 파일은 지웠고 보관본·일지·색인은 그대로예요.
      const st = readJournalState(s.dataDir);
      assert.equal(st.state, 'preparing', '깨짐 표시를 쓰지 못한 경우를 흉내 냈어요');
      assert.equal(st.state === 'preparing' && st.journal.fromBroken, true);
      const raw = readFileSync(join(s.dataDir, JOURNAL_NAME), 'utf8');
      assert.ok(!/CORP-[0-9]{8}/.test(raw) && !raw.includes(STALE), '기록에 옛 내용이 없어요');
      assert.deepEqual(stagedFiles(s), [], '새 내용 파일이 남지 않았어요');
      assert.deepEqual(journalTemps(s), [], '깨짐 표시를 쓰다 남은 임시 파일이 없어요');
      assert.deepEqual(contentSnapshot(s), content, '보관본·일지·색인은 그대로예요');
      assert.ok(!existsSync(lockPathFor(s.dataDir)));

      // 알림은 끊기지 않아요: check·view는 깨진 기록으로 알리고 아무것도 바꾸지 않아요.
      await expectBrokenNotices(s);

      // 다음 보관이 다시 되돌리며 깨짐 표시를 남겨요: 되돌림 [알림] 바로 다음 줄에 깨진 기록 [알림].
      const a = runCli(s, ['archive']);
      assert.equal(a.code, 0, a.stderr);
      assert.match(rowText(a.stdout, '[알림]'), ROLLED_BACK);
      assert.match(rowText(a.stdout, '[알림] 다시 쓰기 기록이 깨져'), BROKEN);
      expectNoticeFollows(a.stdout, '[알림] 지난번에 멈춘 보관본 다시 가리기를 되돌렸어요', '[알림] 다시 쓰기 기록이 깨져');
      assert.match(a.stdout, /검사 +공개 전에 cc-worklog check로 확인하세요\n$/);
      expectBrokenMark(s);
      await expectBrokenNotices(s);

      // redact --yes로 정리하면 알림이 사라져요.
      const y = runCli(s, ['redact', '--yes']);
      assert.equal(y.code, 0, y.stdout + y.stderr);
      assert.ok(!y.stdout.includes('되돌렸어요'), y.stdout);
      assert.match(rowText(y.stdout, '[알림] 깨진'), CLEARED_AFTER_WRITE);
      await expectCleared(s);
    } finally {
      // 흉내 낸 쪽이 권한을 되돌리지만, 도중에 멈췄을 때도 상자를 지울 수 있게 한 번 더 되돌려요.
      if (process.platform !== 'win32') chmodSync(s.dataDir, 0o755);
      if (existsSync(join(s.dataDir, JOURNAL_NAME))) chmodSync(join(s.dataDir, JOURNAL_NAME), 0o644);
      s.cleanup();
    }
  },
);

test('redact: 깨진 기록에서 시작한 다시 가리기가 확정 뒤에 멈추면 보통 때처럼 덜 끝남으로 알리고, 다음 실행이 마저 끝내면 알림이 사라져요', async () => {
  const { s } = smallSandbox();
  try {
    plantBroken(s);
    const crash = runCrash(s, 'rename', 1);
    assert.notEqual(crash.status, 0);
    assert.equal(readJournalState(s.dataDir).state, 'committed');
    const { r, report } = await checkKeepsVerdict(s);
    assert.equal(report.journal, 'unfinished');
    assert.match(rowText(r.stdout, '[알림]'), UNFINISHED);

    const a = runCli(s, ['archive']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /지난번에 멈춘 보관본 다시 가리기를 마저 끝냈어요/);
    assert.ok(!ANY_JOURNAL_NOTICE.test(a.stdout), a.stdout);
    await expectCleared(s);
  } finally {
    s.cleanup();
  }
});

test('보통 다시 가리기가 확정 전 쓰기 오류(ENOSPC)로 그 자리에서 되돌려지면 지금처럼 기록 없이 끝나고 알림도 없어요', async () => {
  const { s } = smallSandbox();
  try {
    const before = snapshotDir(s.dataDir);
    const e = runCrash(s, 'enospc', 1);
    assert.equal(e.status, 1, e.stdout + e.stderr);
    assert.match(e.stderr, /^\[실패\] 다시 쓰다 멈췄어요 \(ENOSPC\)$/m);
    assert.match(e.stderr, /파일은 깨지지 않았어요\. 새로 쓰던 내용은 지웠고 바뀐 파일은 없어요\./);
    assert.match(rowText(e.stderr, '다음:'), /^다음: 디스크 공간과 폴더 권한을 확인한 뒤 다시 실행하세요\. 바뀔 자리를 처음부터 다시 세서 보여 줘요\.$/);
    assert.ok(!e.stdout.includes('[실패]'), e.stdout);
    assert.deepEqual(snapshotDir(s.dataDir), before, '바뀌거나 남은 파일이 없어요(기록 파일 포함)');
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
    const { r, report } = await checkKeepsVerdict(s);
    assert.equal(report.journal, null);
    assert.ok(!ANY_JOURNAL_NOTICE.test(r.stdout), r.stdout);
  } finally {
    s.cleanup();
  }
});

test('데이터 폴더에 쓰지 못하면 [실패] 데이터 폴더에 쓰지 못했어요 / 경로 / 다음: 줄을 표준 오류로 보여 줘요 (종료 코드 1)', () => {
  const expectFail = (r: { code: number | null; stdout: string; stderr: string }, dataDir: string) => {
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const lines = r.stderr.trimEnd().split(/\r?\n/);
    assert.match(lines[0]!, /^\[실패\] 데이터 폴더에 쓰지 못했어요 \(E[A-Z]+\)$/);
    assert.equal(lines[1], `       ${dataDir}`);
    assert.equal(lines[2], '다음: 폴더 권한과 디스크 공간을 확인하거나 --data-dir로 다른 폴더를 고르세요.');
    assert.equal(lines.length, 3, r.stderr);
    assert.ok(!r.stdout.includes('[실패]') && !r.stdout.includes('공개 전에 cc-worklog check'), r.stdout);
  };

  // ① 데이터 폴더 자리에 파일이 있어요 (--data-dir로 파일 경로를 준 것과 같아요). 보관·일지 만들기 모두 멈춰요.
  const s = sandbox();
  try {
    const cwd = join(s.root, 'work', 'svc');
    mkdirSync(cwd, { recursive: true });
    writeSession(s, cwd, SID_A, [userText({ sid: SID_A, cwd, ts: kst(DATE, '10:00') }, '안녕')]);
    writeFileSync(s.dataDir, 'not a folder');
    expectFail(runCli(s, ['archive']), s.dataDir);
    expectFail(runCli(s, ['--date', DATE]), s.dataDir);
    assert.equal(readFileSync(s.dataDir, 'utf8'), 'not a folder');
    assert.ok(!existsSync(lockPathFor(s.dataDir)));
  } finally {
    s.cleanup();
  }

  // ② 보관은 되지만 일지 폴더 자리에 파일이 있어 일지를 쓰지 못해요.
  const t = sandbox();
  try {
    const cwd = join(t.root, 'work', 'svc');
    mkdirSync(cwd, { recursive: true });
    writeSession(t, cwd, SID_A, [userText({ sid: SID_A, cwd, ts: kst(DATE, '10:00') }, '안녕'), assistantText({ sid: SID_A, cwd, ts: kst(DATE, '10:01') }, '네')]);
    mkdirSync(t.dataDir, { recursive: true });
    writeFileSync(join(t.dataDir, 'worklogs'), 'not a folder');
    expectFail(runCli(t, ['--date', DATE]), t.dataDir);
    assert.ok(existsSync(join(t.dataDir, 'archive', 'index.json')), '보관은 끝났어요');
  } finally {
    t.cleanup();
  }
});
