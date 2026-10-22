// 개발 9회차 시험: 취합 15회차 차이 1·2 (PRD S4·A10·A16, 2026-10-21 확정).
//  - 차이 1: 검사가 이름·이메일 옵션이 켜진 일지에 남은 사용자 이름·이메일을 찾으면, 다음: 안내 아래에 그 날짜마다
//    한쪽만 가려진 일지와 같은 규칙의 다시 만드는 명령(--hide-identity는 늘 붙음, 그 일지의 하루 경계가 기본이나 지금 설정과
//    다르면 --day-start N, 이번 실행에 준 --data-dir·--claude-dir)과 "만들 때 --root나 --claude-dir를 줬으면 …" 한 줄을 보여 줘요.
//    그 명령을 그대로 실행하면 같은 설정으로 다시 만들어지고 검사가 통과해요.
//  - 차이 2: 검사가 읽지 못한 파일은 하나를 한 건으로 세고, 읽다 중간에 멈춘 파일에서 앞서 찾은 의심(비밀 값·이름·이메일)은
//    따로 세지 않아요. 그래서 남은 의심 수와 목록이 맞아요. 다시 검사하면 다시 나와요.
// 개발 10회차(취합 17회차 차이 3)에 더한 시험 둘: 같은 날짜가 두 안내(한쪽만 가려진 일지, 남은 이름·이메일)에 다 걸릴 때의 S4 모양
//    (DESIGN S4 11번 "두 안내에 다 걸린 날짜") — 옵션을 끄고 만든 일지의 명령에 --hide-identity가 새로 붙는 실제 실행과,
//    겹친 날짜가 여럿이라 "위에 명령이 있는 날짜(…)" 줄이 80칸에서 끊기는 렌더예요.
// 모든 시험은 임시 폴더의 가짜 세션 기록·임시 저장소로만 해요. 잠금은 시험 안에서 모두 풀어요.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectFile, type FileScan } from '../src/commands/check.js';
import { displayWidth } from '../src/term/format.js';
import { IDENTITY_NEXT, renderCheckReport, UNREADABLE_NEXT, type CheckReport } from '../src/term/s4-check.js';
import { REMAKE_HINT, shellPath } from '../src/worklog/mismatch.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  APP_DIR,
  asOldVersionWorklog,
  assistantText,
  CLI,
  commitAt,
  fingerprint,
  initRepo,
  kst,
  NO_NET,
  readJson,
  rowText,
  runCli,
  sandbox,
  userText,
  writeSession,
  type CliResult,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-16';
const DATE2 = '2026-10-17';
const ME = 'dev.kim@example.test';
/** 일지에 남을 가짜 이메일 (커밋 메시지 첫 줄에 넣어요. 요청 글은 앞 100자만 남아서요) */
const EMAIL = 'qa.lee@example.test';
const T1 = 'CORP-12345678';
const LABEL = '헤더 문구';
const PATTERNS = JSON.stringify([{ name: LABEL, pattern: 'CORP-[0-9]{8}', samples: ['CORP-00000000'] }]);
const SID = 'f9000000-0000-4000-8000-000000000001';
const SID2 = 'f9000000-0000-4000-8000-000000000002';
const EMAIL_MARK = '[가림:이메일]';
const LOCK_PS1 = join(APP_DIR, 'test', 'fixtures', 'lock-range.ps1');

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const notStream = { isTTY: false } as NodeJS.WriteStream;

/** CLI를 준 인자 그대로 실행해요(runCli와 달리 폴더 옵션을 붙이지 않아요). 네트워크는 막아요. */
function runRaw(sb: Sandbox, args: string[]): CliResult {
  const r = spawnSync(process.execPath, ['--require', NO_NET, CLI, ...args], { env: sb.env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 안내에 나온 명령 한 줄을 인자로 나눠요(큰따옴표로 감싼 경로는 한 덩어리). 맨 앞 cc-worklog는 빼요. */
function argsOf(command: string): string[] {
  const parts = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  assert.equal(parts[0], 'cc-worklog');
  return parts.slice(1);
}

/** 출력에서 n칸 들여 쓴 cc-worklog --date <날짜> 명령 줄을 모두 꺼내요. 끈 일지의 이름·이메일 [알림] 아래 명령 모양(`--date <날짜>` 글자 그대로, A19)은 빼요. */
function commandLines(out: string, indent: number): string[] {
  return out
    .split('\n')
    .filter((l) => new RegExp(`^ {${indent}}cc-worklog --date \\d{4}-`).test(l))
    .map((l) => l.trim());
}

/** S4 출력의 다음: 덩어리들 (줄바꿈을 이어 붙인 글, 명령 줄 포함) */
function nextBlocks(out: string): string[] {
  const lines = out.split('\n');
  return lines.flatMap((l, i) => (l.startsWith('다음:') ? [rowText(lines.slice(i).join('\n'), '다음:')] : []));
}

/** `남은 의심` 칸 아래(이름·이메일 칸 앞)의 목록 줄 */
function suspectRows(out: string): string[] {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => /^ {3}남은 의심 /.test(l));
  const rows: string[] = [];
  for (let j = i + 1; j < lines.length && /^ {5}\S/.test(lines[j]!); j++) rows.push(lines[j]!);
  return rows;
}

/** 이메일이 든 커밋과 세션 하나로 date 일지를 만들어요(makeArgs 설정). 일지 두 파일 경로를 돌려줘요. */
function makeDay(
  s: Sandbox,
  dirs: { claudeDir: string; dataDir: string },
  run: (args: string[]) => CliResult,
  date: string,
  sid: string,
  makeArgs: string[],
  request = '헤더 손보기',
) {
  const repo = join(s.root, 'work', 'web');
  if (!existsSync(join(repo, '.git'))) initRepo(s, repo, ME);
  commitAt(s, repo, `리뷰 요청 ${EMAIL}`, `${date}T11:00:00+09:00`);
  const A = { sid, cwd: repo };
  writeSession({ ...s, projectsDir: join(dirs.claudeDir, 'projects') }, repo, sid, [
    userText({ ...A, ts: kst(date, '10:00') }, request),
    assistantText({ ...A, ts: kst(date, '10:05') }, '했어요'),
  ]);
  const r = run(['--date', date, ...makeArgs]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  return { md: join(dirs.dataDir, 'worklogs', `${date}.md`), json: join(dirs.dataDir, 'worklogs', `${date}.json`) };
}

/**
 * 이름·이메일 가리기를 켜고 만든 일지에 이메일이 가려지지 않고 남은 상태(이전 판이 남긴 일지)를 흉내 내요.
 * 이전 판은 손으로 고친 일지를 알아보는 해시(markdownHash)를 남기지 않았어서, 그 칸도 빼요. 칸이 남아 있으면
 * 손으로 고친 일지로 보여 일지 만들기가 덮어쓰지 않아요(PRD A21, I-04 시험이 따로 봐요).
 */
function leakEmail(...files: string[]) {
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(text.includes(EMAIL_MARK), `${f}에 이메일 가림 표시가 있어야 해요`);
    writeFileSync(f, text.split(EMAIL_MARK).join(EMAIL));
  }
  for (const f of files) {
    const json = f.replace(/\.md$/, '.json');
    if (existsSync(json)) asOldVersionWorklog(json);
  }
}

// ---- 차이 2: 읽다 중간에 멈춘 파일 (세는 함수 단위) ----

function emptyReport(): CheckReport {
  return {
    dataDir: 'D:\\wl',
    builtin: [{ label: 'GitHub 토큰', caught: true }],
    negatives: [{ what: '커밋 해시', intact: true }],
    user: [],
    scanned: { worklogs: 1, archives: 1 },
    markers: { worklog: {}, archive: {} },
    findings: [],
    identity: { counted: true, worklogs: 1, userNames: 0, emails: 0, findings: [] },
    passed: false,
    mismatched: [],
    identityDays: [],
  };
}

/** 몇 줄을 읽은 뒤 오류로 멈추는 줄 공급원 (바이트 범위 잠금·네트워크 드라이브 끊김 흉내) */
async function* linesThenFail(lines: string[], code: string) {
  for (const line of lines) yield { line };
  throw Object.assign(new Error('읽다 멈춤 흉내'), { code });
}

test('9회차: 읽다 중간에 멈춘 파일은 앞서 찾은 의심·이름·이메일·가림 표시를 세지 않고 "읽지 못함" 1건만 남겨요 (collectFile)', async () => {
  const r = emptyReport();
  r.markers.worklog = { 'GitHub 토큰': 2 };
  const complete = await collectFile(r, 'worklogs/2026-10-16.md', r.markers.worklog, async (part: FileScan) => {
    let n = 0;
    for await (const { line } of linesThenFail(['토큰 줄', '이메일 줄', '가림 줄'], 'EIO')) {
      n++;
      part.findings.push({ file: 'worklogs/2026-10-16.md', line: n, kind: 'GitHub 토큰' });
      part.identity.push({ file: 'worklogs/2026-10-16.md', line: n, kind: '이메일' });
      part.markers['GitHub 토큰'] = (part.markers['GitHub 토큰'] ?? 0) + 1;
      assert.ok(line);
    }
  });
  assert.equal(complete, false);
  assert.deepEqual(r.findings, [{ file: 'worklogs/2026-10-16.md', line: 0, kind: '읽지 못함', code: 'EIO' }], '읽지 못함 1건만이에요');
  assert.deepEqual(r.identity.findings, [], '앞서 찾은 이름·이메일도 세지 않아요');
  assert.deepEqual(r.markers.worklog, { 'GitHub 토큰': 2 }, '앞서 센 가림 표시도 더하지 않아요');

  // 처음부터 열지 못한 파일도 1건이에요.
  assert.equal(
    await collectFile(r, 'archive/projects/a.jsonl', r.markers.archive, () => {
      throw Object.assign(new Error('잠김'), { code: 'EBUSY' });
    }),
    false,
  );
  assert.equal(r.findings.length, 2);

  // 끝까지 읽으면 찾은 것을 모두 더해요.
  const ok = await collectFile(r, 'worklogs/2026-10-17.md', r.markers.worklog, (part) => {
    part.findings.push({ file: 'worklogs/2026-10-17.md', line: 3, kind: 'GitHub 토큰' });
    part.identity.push({ file: 'worklogs/2026-10-17.md', line: 4, kind: '이메일' });
    part.markers['GitHub 토큰'] = 1;
  });
  assert.equal(ok, true);
  assert.equal(r.findings.length, 3);
  assert.equal(r.identity.findings.length, 1);
  assert.deepEqual(r.markers.worklog, { 'GitHub 토큰': 3 });

  // 파일 시스템 오류가 아닌 오류(코드 없음)는 그대로 던져요.
  await assert.rejects(
    collectFile(r, 'x', {}, () => {
      throw new Error('버그');
    }),
    /버그/,
  );
});

test('9회차: 읽다 중간에 멈춘 파일 하나뿐이면 S4가 "남은 의심 1건" · 목록 한 줄 `읽지 못함 (EIO)` · 다음: 한 줄(프로그램을 닫고 다시 검사)로 맞아요', async () => {
  const r = emptyReport();
  await collectFile(r, 'worklogs/2026-10-16.md', r.markers.worklog, async (part) => {
    let n = 0;
    for await (const _ of linesThenFail(['a', 'b'], 'EIO')) {
      n++;
      part.findings.push({ file: 'worklogs/2026-10-16.md', line: n, kind: 'GitHub 토큰' });
      part.identity.push({ file: 'worklogs/2026-10-16.md', line: n, kind: '이메일' });
    }
  });
  const out = renderCheckReport(r, notStream);
  assert.match(out, /^ {3}남은 의심 +1건$/m);
  assert.deepEqual(suspectRows(out), ['     worklogs/2026-10-16.md  읽지 못함 (EIO)'], '수와 목록이 맞아요(앞 줄 번호 없음)');
  assert.match(out, /이름·이메일 \(일지만\) {2}켠 일지 \d+개 — 사용자 이름 0건 · 이메일 0건/);
  assert.match(out, /^\[실패\] 남은 의심 1건, 놓친 패턴 0개$/m, '남은 이름·이메일은 덧붙지 않아요');
  assert.deepEqual(nextBlocks(out), [`다음: ${UNREADABLE_NEXT}`], '다시 가리기·이름·이메일 다음: 줄은 없어요');
});

// ---- 차이 1: 남은 이름·이메일의 다시 만드는 명령 (렌더 단위) ----

test('9회차: S4 남은 이름·이메일 다음: — 날짜마다 다시 만드는 명령(8칸, --hide-identity 늘 붙음)과 안내 한 줄(6칸), 같은 날짜가 한쪽만 가려진 일지에도 걸리면 그 날짜 명령은 위 안내에 한 번만 (취합 17회차)', () => {
  const r = emptyReport();
  r.identity.userNames = 1;
  r.identity.emails = 2;
  r.identity.findings = [
    { file: `worklogs/${DATE}.md`, line: 9, kind: '이메일' },
    { file: `worklogs/${DATE}.json`, line: 0, kind: '이메일' },
    { file: `worklogs/${DATE2}.md`, line: 4, kind: '사용자 이름' },
  ];
  // 그 일지의 설정: DATE는 하루 경계 5, DATE2는 기본(3). hideIdentity가 false로 와도 명령에는 늘 붙어요.
  r.identityDays = [
    { date: DATE, hideIdentity: true, dayStartHour: 5 },
    { date: DATE2, hideIdentity: false, dayStartHour: 3 },
  ];
  r.remake = { dayStartHour: 3, dataDir: 'D:\\work logs\\cc-worklog' };
  const out = renderCheckReport(r, notStream);
  assert.match(out, /^\[실패\] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 3건$/m);
  const cmd1 = `cc-worklog --date ${DATE} --hide-identity --day-start 5 --data-dir "D:\\work logs\\cc-worklog"`;
  const cmd2 = `cc-worklog --date ${DATE2} --hide-identity --data-dir "D:\\work logs\\cc-worklog"`;
  assert.deepEqual(commandLines(out, 8), [cmd1, cmd2], '날짜 순서, 한 줄에 하나(80칸을 넘어도 끊지 않음)');
  assert.match(out, new RegExp(`^ {8}${esc(cmd2)}\\n {6}${esc(REMAKE_HINT)}$`, 'm'), '안내 한 줄은 명령들 다음 한 번이에요');
  assert.equal(out.split('\n').filter((l) => l.trim() === REMAKE_HINT).length, 1);
  assert.deepEqual(nextBlocks(out), [`다음: ${IDENTITY_NEXT} ${cmd1} ${cmd2} ${REMAKE_HINT}`]);
  assert.ok(!out.includes('make --date'), '옛 문장(make --date 날짜 --hide-identity)은 없어요');

  // 같은 날짜가 한쪽만 가려진 일지에도 걸림: 그 날짜 명령은 한쪽만 가려진 일지 다음: 아래에 한 번만 두고, 이름·이메일 다음:에는
  // "위에 명령이 있는 날짜(…)는 …" 한 줄과 그 밖의 날짜 명령만 둬요(DESIGN S4 11번 "두 안내에 다 걸린 날짜", 취합 17회차).
  r.findings = [{ file: `worklogs/${DATE}.md`, line: 7, kind: LABEL }];
  r.mismatched = [{ date: DATE, hideIdentity: true, dayStartHour: 5 }];
  const both = renderCheckReport(r, notStream);
  const blocks = nextBlocks(both);
  assert.equal(blocks.length, 3, both);
  assert.match(blocks[0]!, /^다음: 필요하면 사용자 패턴을 더한 뒤 cc-worklog redact를/);
  assert.ok(blocks[1]!.startsWith('다음: 아래 날짜의 일지는 .md와 화면용 .json 중 한쪽만') && blocks[1]!.endsWith(`${cmd1} ${REMAKE_HINT}`), blocks[1]);
  assert.equal(blocks[2], `다음: ${IDENTITY_NEXT} 위에 명령이 있는 날짜(${DATE})는 그 명령이 이름·이메일도 가려요. ${cmd2} ${REMAKE_HINT}`);
  assert.deepEqual(commandLines(both, 8), [cmd1, cmd2]);
});

// ---- 차이 1: 실제 실행 ----

test('9회차: --hide-identity --day-start 5로 공백 든 --data-dir·--claude-dir에 만든 일지에 이메일이 남으면 → 명령에 그 설정이 모두 붙고, 그대로 실행하면 같은 설정으로 다시 만들어져 검사가 통과해요', () => {
  const s = sandbox();
  try {
    const dataDir = join(s.root, 'my data');
    const claudeDir = join(s.root, 'claude home');
    cpSync(s.claudeDir, claudeDir, { recursive: true });
    const run = (args: string[]) => runRaw(s, [...args, '--data-dir', dataDir, '--claude-dir', claudeDir]);
    const x = makeDay(s, { claudeDir, dataDir }, run, DATE, SID, ['--hide-identity', '--day-start', '5']);
    assert.equal(readJson<DayLog>(x.json).dayStartHour, 5);
    assert.equal(run(['check']).code, 0, '시작할 때는 통과해요');
    leakEmail(x.md, x.json);

    const c = run(['check']);
    assert.equal(c.code, 1, c.stdout);
    assert.match(c.stdout, /^\[실패\] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 \d+건$/m);
    const expected = `cc-worklog --date ${DATE} --hide-identity --day-start 5 --data-dir ${shellPath(dataDir)} --claude-dir ${shellPath(claudeDir)}`;
    assert.deepEqual(commandLines(c.stdout, 8), [expected], c.stdout);
    assert.match(c.stdout, new RegExp(`^ {8}${esc(expected)}\\n {6}${esc(REMAKE_HINT)}$`, 'm'));
    assert.deepEqual(nextBlocks(c.stdout), [`다음: ${IDENTITY_NEXT} ${expected} ${REMAKE_HINT}`], '이름·이메일 다음: 줄 하나뿐이에요');
    assert.ok(!c.stdout.includes(EMAIL), '값은 보여 주지 않아요');

    // 안내대로 실행해요(명령에 있는 옵션만).
    const r = runRaw(s, argsOf(expected));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const day = readJson<DayLog>(x.json);
    assert.equal(day.hideIdentity, true);
    assert.equal(day.dayStartHour, 5, '같은 하루 경계(범위)로 다시 만들어져요');
    assert.equal(day.totals.sessions, 1, '준 세션 기록 폴더의 세션이 들어 있어요');
    assert.equal(day.totals.commits, 1);
    assert.ok(!readFileSync(x.md, 'utf8').includes(EMAIL) && !readFileSync(x.json, 'utf8').includes(EMAIL), '두 파일 모두 이메일이 가려져요');
    const ok = run(['check']);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /이름·이메일 \(일지만\) {2}켠 일지 \d+개 — 사용자 이름 0건 · 이메일 0건/);
    assert.ok(!existsSync(s.dataDir), '기본 데이터 폴더에는 아무것도 만들지 않아요');
  } finally {
    s.cleanup();
  }
});

test('9회차: 옵션을 끄고 기본(3)으로 만든 일지를 check --hide-identity로 검사하면(config.json의 dayStartHour 6) → --hide-identity가 늘 붙고 --day-start 3, 이번 실행의 폴더 → 실행하면 이름·이메일이 가려진 일지가 되고 검사 통과', () => {
  const s = sandbox();
  try {
    const run = (args: string[]) => runCli(s, args);
    const x = makeDay(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, run, DATE, SID, []);
    // 날짜가 둘이면 날짜 순서로 명령이 하나씩이에요.
    makeDay(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, run, DATE2, SID2, []);
    assert.equal(readJson<DayLog>(x.json).hideIdentity, false);
    assert.ok(readFileSync(x.md, 'utf8').includes(EMAIL), '옵션을 끄면 이메일이 그대로예요');
    writeFileSync(join(s.dataDir, 'config.json'), JSON.stringify({ dayStartHour: 6 }));

    const c = run(['check', '--hide-identity']);
    assert.equal(c.code, 1, c.stdout);
    const cmd = (d: string) => `cc-worklog --date ${d} --hide-identity --day-start 3 --data-dir ${shellPath(s.dataDir)} --claude-dir ${shellPath(s.claudeDir)}`;
    assert.deepEqual(commandLines(c.stdout, 8), [cmd(DATE), cmd(DATE2)], c.stdout);
    assert.match(c.stdout, new RegExp(`^ {8}${esc(cmd(DATE2))}\\n {6}${esc(REMAKE_HINT)}$`, 'm'));

    for (const d of [DATE, DATE2]) {
      const r = runRaw(s, argsOf(cmd(d)));
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${d}.json`));
      assert.equal(day.hideIdentity, true);
      assert.equal(day.dayStartHour, 3, '지금 설정(6)이 아니라 그 일지의 하루 경계로 다시 만들어져요');
    }
    // 옵션 없이 검사해도(그 일지가 옵션을 켜고 만든 일지라서 세요) 통과해요.
    const ok = run(['check']);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /이름·이메일 \(일지만\) {2}켠 일지 \d+개 — 사용자 이름 0건 · 이메일 0건/);
  } finally {
    s.cleanup();
  }
});

test('9회차: 같은 날짜가 한쪽만 가려진 일지이면서 이름·이메일도 남으면 명령은 한쪽만 가려진 일지 안내에 한 번만 나오고(취합 17회차), 그 명령을 실행하면 둘 다 고쳐져 검사가 통과해요', () => {
  const s = sandbox();
  try {
    const run = (args: string[]) => runRaw(s, args);
    const x = makeDay(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, run, DATE, SID, ['--hide-identity'], `헤더 손보기 ${T1} 로 확인해 줘`);
    // 이전 판이 남긴 어긋남: 패턴을 더해 다시 가린 뒤 마크다운만 옛 내용으로 되돌리고, 거기에 이메일도 남겨요.
    writeFileSync(join(s.dataDir, 'patterns.json'), PATTERNS);
    const oldMd = readFileSync(x.md, 'utf8');
    assert.equal(run(['redact', '--yes']).code, 0);
    writeFileSync(x.md, oldMd);
    leakEmail(x.md);

    const c = run(['check']);
    assert.equal(c.code, 1, c.stdout);
    assert.match(c.stdout, /^\[실패\] 남은 의심 1건, 놓친 패턴 0개, 남은 이름·이메일 1건$/m);
    const cmd = `cc-worklog --date ${DATE} --hide-identity`;
    const blocks = nextBlocks(c.stdout);
    assert.equal(blocks.length, 3, c.stdout);
    assert.match(blocks[0]!, /cc-worklog redact를 실행하고/);
    assert.ok(blocks[1]!.startsWith('다음: 아래 날짜의 일지는') && blocks[1]!.endsWith(`${cmd} ${REMAKE_HINT}`), blocks[1]);
    assert.equal(blocks[2], `다음: ${IDENTITY_NEXT} 위에 명령이 있는 날짜(${DATE})는 그 명령이 이름·이메일도 가려요.`);
    assert.deepEqual(commandLines(c.stdout, 8), [cmd]);

    const r = runRaw(s, argsOf(cmd));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const text = readFileSync(x.md, 'utf8') + readFileSync(x.json, 'utf8');
    assert.ok(!text.includes(EMAIL) && !text.includes('CORP-'), '두 파일 모두 같게 가려져요');
    const ok = run(['check']);
    assert.equal(ok.code, 0, ok.stdout);
  } finally {
    s.cleanup();
  }
});

// ---- 10회차: 두 안내에 다 걸린 날짜 (취합 17회차 차이 3, DESIGN S4 11번) ----

test('10회차: 옵션을 끄고 하루 경계 5로 만든 일지가 한쪽만 가려진 일지이면서 check --hide-identity에 이름·이메일도 걸리면 → 그 날짜 명령은 한쪽만 가려진 일지 다음: 아래 한 줄에 --hide-identity가 새로 붙고(--day-start 5 그대로), 이름·이메일 다음:은 문장과 "위에 명령이 있는 날짜" 한 줄뿐, S3 다시 가리기 명령은 그 일지 설정대로 → 그 명령 하나로 둘 다 고쳐져요', () => {
  const s = sandbox();
  try {
    const run = (args: string[]) => runRaw(s, args);
    const x = makeDay(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, run, DATE, SID, ['--day-start', '5'], `헤더 손보기 ${T1} 로 확인해 줘`);
    const made = readJson<DayLog>(x.json);
    assert.equal(made.hideIdentity, false, '옵션을 끄고 만든 일지예요');
    assert.equal(made.dayStartHour, 5);
    // 이전 판이 남긴 어긋남: 패턴을 더해 다시 가린 뒤 마크다운만 옛 내용으로 되돌려요. 옵션을 끄고 만들어 이메일은 원래 그대로예요.
    writeFileSync(join(s.dataDir, 'patterns.json'), PATTERNS);
    const oldMd = readFileSync(x.md, 'utf8');
    assert.ok(oldMd.includes(EMAIL));
    assert.equal(run(['redact', '--yes']).code, 0);
    writeFileSync(x.md, oldMd);
    asOldVersionWorklog(x.json); // 이전 판은 손으로 고친 일지를 알아보는 해시를 남기지 않았어요(PRD A21)

    // S3 다시 가리기는 이름·이메일을 세지 않아서 [알림]의 명령은 그 일지 설정대로예요(--hide-identity 없음, DESIGN S4 11번).
    const rd = run(['redact']);
    assert.equal(rd.code, 0, `${rd.stdout}\n${rd.stderr}`);
    assert.deepEqual(commandLines(rd.stdout, 9), [`cc-worklog --date ${DATE} --day-start 5`], rd.stdout);

    const c = run(['check', '--hide-identity']);
    assert.equal(c.code, 1, c.stdout);
    assert.match(c.stdout, /^\[실패\] 남은 의심 1건, 놓친 패턴 0개, 남은 이름·이메일 \d+건$/m);
    // 그 일지는 옵션을 끄고 만들었지만, 이름·이메일 안내에도 걸려서 --hide-identity가 붙어요. 나머지 옵션은 그 일지 설정 그대로예요.
    const cmd = `cc-worklog --date ${DATE} --hide-identity --day-start 5`;
    assert.deepEqual(commandLines(c.stdout, 8), [cmd], '그 날짜 명령은 한 번뿐이에요');
    const blocks = nextBlocks(c.stdout);
    assert.equal(blocks.length, 3, c.stdout);
    assert.match(blocks[0]!, /^다음: 필요하면 사용자 패턴을 더한 뒤 cc-worklog redact를 실행하고/);
    assert.ok(blocks[1]!.startsWith('다음: 아래 날짜의 일지는 .md와 화면용 .json 중 한쪽만') && blocks[1]!.endsWith(`${cmd} ${REMAKE_HINT}`), blocks[1]);
    assert.equal(blocks[2], `다음: ${IDENTITY_NEXT} 위에 명령이 있는 날짜(${DATE})는 그 명령이 이름·이메일도 가려요.`, '명령 줄과 안내 한 줄 없이 문장과 한 줄뿐이에요');
    const lines = c.stdout.split('\n');
    const note = lines.findIndex((l) => l.startsWith('      위에 명령이 있는 날짜('));
    assert.equal(lines[note], `      위에 명령이 있는 날짜(${DATE})는 그 명령이 이름·이메일도 가려요.`);
    assert.equal(displayWidth(lines[note]!), 73, '날짜 하나면 73칸 한 줄이에요');
    assert.ok(lines[note - 1]!.startsWith('      ') && lines[note - 2]!.startsWith('다음: 아래 날짜의 일지에 사용자 이름·이메일'), '이름·이메일 문장 바로 다음 줄이에요');
    assert.equal(lines.filter((l) => l.trim() === REMAKE_HINT).length, 1, '안내 한 줄은 위 명령 아래 한 번이에요');
    assert.ok(!c.stdout.includes(EMAIL) && !c.stdout.includes(T1), '값은 보여 주지 않아요');

    // 안내대로 그 명령 하나만 실행하면 비밀 값·이메일이 함께 가려지고, 같은 하루 경계로 다시 만들어져요.
    const r = runRaw(s, argsOf(cmd));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const day = readJson<DayLog>(x.json);
    assert.equal(day.hideIdentity, true);
    assert.equal(day.dayStartHour, 5);
    const text = readFileSync(x.md, 'utf8') + readFileSync(x.json, 'utf8');
    assert.ok(!text.includes(EMAIL) && !text.includes('CORP-'), '두 파일 모두 같게 가려져요');
    for (const args of [['check'], ['check', '--hide-identity']]) {
      const ok = run(args);
      assert.equal(ok.code, 0, ok.stdout);
    }
  } finally {
    s.cleanup();
  }
});

test('10회차: 두 안내에 다 걸린 날짜가 여럿이면 "위에 명령이 있는 날짜(…)" 줄은 날짜 순서로 ", "로 잇고 80칸을 넘으면 낱말 사이에서 끊어 6칸에 맞춰요 — 겹친 날짜 명령은 위 안내에(--hide-identity), 이름·이메일 안내에는 그 밖의 날짜만, 모두 겹치면 명령·안내 줄 없음', () => {
  const day = (date: string, hideIdentity: boolean, dayStartHour = 3) => ({ date, hideIdentity, dayStartHour });
  const IDENTITY_LINES = ['다음: 아래 날짜의 일지에 사용자 이름·이메일이 남아 있어요. 그 날짜 일지를', '      이름·이메일 가리기를 켜고 다시 만든 뒤 다시 검사하세요.'];
  /** 이름·이메일 다음: 줄부터 끝까지 (내장 규칙 다음: 줄은 없는 보고예요) */
  const identityTail = (out: string) => {
    const lines = out.replace(/\n$/, '').split('\n');
    return lines.slice(lines.indexOf(IDENTITY_LINES[0]!));
  };
  assert.equal(IDENTITY_LINES.map((l) => l.trim()).join(' '), `다음: ${IDENTITY_NEXT}`);
  assert.deepEqual(IDENTITY_LINES.map(displayWidth), [73, 61], 'DESIGN: 일지를(73칸) 다음에서 끊고 둘째 줄 61칸');

  // ① 겹친 날짜 셋(10-14는 옵션을 끄고, 10-15는 하루 경계 5로 만든 일지) + 이름·이메일만 걸린 10-18, 데이터 폴더는 드라이브 맨 위
  const r = emptyReport();
  r.findings = ['2026-10-14', '2026-10-15', '2026-10-16'].map((d) => ({ file: `worklogs/${d}.md`, line: 7, kind: LABEL }));
  r.identity.emails = 4;
  r.identity.findings = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-18'].map((d) => ({ file: `worklogs/${d}.md`, line: 9, kind: '이메일' }));
  r.mismatched = [day('2026-10-14', false), day('2026-10-15', true, 5), day('2026-10-16', false)];
  r.identityDays = [day('2026-10-14', true), day('2026-10-15', true, 5), day('2026-10-16', true), day('2026-10-18', true)];
  r.remake = { dayStartHour: 3, dataDir: 'D:\\' };
  const out = renderCheckReport(r, notStream);
  const cmd = (d: string, dayStart = '') => `cc-worklog --date ${d} --hide-identity${dayStart} --data-dir "D:\\\\"`;
  assert.deepEqual(
    commandLines(out, 8),
    [cmd('2026-10-14'), cmd('2026-10-15', ' --day-start 5'), cmd('2026-10-16'), cmd('2026-10-18')],
    '겹친 날짜는 위 안내에 한 번씩(옵션을 끄고 만든 일지도 --hide-identity), 그 밖의 날짜만 이름·이메일 안내에',
  );
  const blocks = nextBlocks(out);
  assert.equal(blocks.length, 3, out);
  assert.ok(blocks[1]!.endsWith(`${cmd('2026-10-14')} ${cmd('2026-10-15', ' --day-start 5')} ${cmd('2026-10-16')} ${REMAKE_HINT}`), blocks[1]);
  assert.deepEqual(identityTail(out), [
    ...IDENTITY_LINES,
    '      위에 명령이 있는 날짜(2026-10-14, 2026-10-15, 2026-10-16)는 그 명령이',
    '      이름·이메일도 가려요.',
    `        ${cmd('2026-10-18')}`,
    `      ${REMAKE_HINT}`,
  ]);
  const tail = identityTail(out);
  assert.equal(displayWidth(tail[2]!), 75, '다음 낱말(이름·이메일도)을 더하면 80칸을 넘어서 끊겨요');
  assert.ok(displayWidth(`${tail[2]!} 이름·이메일도`) > 80);

  // ② 겹친 날짜 다섯이 모두 이름·이메일에도 걸림: 괄호 안 날짜 사이에서 끊기고, 이름·이메일 다음:은 문장과 이 줄들뿐이에요.
  const five = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
  const r2 = emptyReport();
  r2.findings = five.map((d) => ({ file: `worklogs/${d}.md`, line: 3, kind: LABEL }));
  r2.identity.userNames = 5;
  r2.identity.findings = five.map((d) => ({ file: `worklogs/${d}.json`, line: 0, kind: '사용자 이름' }));
  r2.mismatched = five.map((d) => day(d, true));
  r2.identityDays = five.map((d) => day(d, true));
  const out2 = renderCheckReport(r2, notStream);
  const note = `위에 명령이 있는 날짜(${five.join(', ')})는 그 명령이 이름·이메일도 가려요.`;
  assert.deepEqual(identityTail(out2), [
    ...IDENTITY_LINES,
    '      위에 명령이 있는 날짜(2026-10-10, 2026-10-11, 2026-10-12, 2026-10-13,',
    '      2026-10-14)는 그 명령이 이름·이메일도 가려요.',
  ]);
  // 끊는 규칙: 줄마다 6칸에서 시작하고 80칸 안, 다음 낱말을 더하면 80칸을 넘을 때만 끊어요. 이어 붙이면 원래 한 줄이에요.
  const noteLines = identityTail(out2).slice(2);
  for (const [i, l] of noteLines.entries()) {
    assert.ok(l.startsWith('      ') && !l.startsWith('       ') && displayWidth(l) <= 80, l);
    const nextWord = noteLines[i + 1]?.trim().split(' ')[0];
    if (nextWord) assert.ok(displayWidth(`${l} ${nextWord}`) > 80, `${l} 뒤에 ${nextWord}가 들어갈 수 있었어요`);
  }
  assert.equal(noteLines.map((l) => l.trim()).join(' '), note);
  assert.deepEqual(commandLines(out2, 8), five.map((d) => `cc-worklog --date ${d} --hide-identity`), '명령은 위 안내에만 있어요');
  assert.equal(out2.split('\n').filter((l) => l.trim() === REMAKE_HINT).length, 1, '안내 한 줄도 위 안내에만 있어요');
});

// ---- 차이 2: 실제로 읽다 중간에 멈추게 하기 (Windows 바이트 범위 잠금) ----

/**
 * PowerShell로 파일의 offset부터 끝까지 바이트 범위 잠금을 걸어요(Windows만). 앞부분은 읽히고 잠긴 자리를 읽을 때 EBUSY가 나서,
 * 검사가 "읽다 중간에 멈추는" 상황이 돼요. 돌려준 함수로 꼭 풀어요(잠금을 풀고 PowerShell이 끝날 때까지 기다려요).
 */
async function lockRange(path: string, offset: number): Promise<() => Promise<void>> {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LOCK_PS1, '-Path', path, '-Offset', String(offset)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let err = '';
  ps.stderr.on('data', (d) => (err += String(d)));
  const exited = new Promise<void>((res) => ps.once('exit', () => res()));
  try {
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`잠그지 못했어요: ${err}`)), 30_000);
      ps.stdout.on('data', (d) => {
        if (String(d).includes('locked')) {
          clearTimeout(timer);
          res();
        }
      });
      ps.once('exit', (code) => {
        clearTimeout(timer);
        rej(new Error(`잠금 프로세스가 먼저 끝났어요 (${code}): ${err}`));
      });
    });
  } catch (e) {
    ps.kill();
    await exited;
    throw e;
  }
  return async () => {
    ps.stdin.end('\n');
    await exited;
  };
}

test(
  '9회차: (Windows) 일지 마크다운을 읽다 중간에 멈추면(뒷부분 바이트 범위 잠금) 앞에서 찾은 비밀 값·이메일은 세지 않고 "읽지 못함 (EBUSY)" 1건 → 잠금을 풀고 다시 검사하면 다시 나와요',
  { skip: process.platform !== 'win32' ? '바이트 범위 잠금(LockFile)은 Windows에서만 읽기를 막아요(세는 함수 단위 시험이 같은 규칙을 봐요)' : false },
  async () => {
    const s = sandbox();
    try {
      const x = makeDay(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, (a) => runCli(s, a), DATE, SID, ['--hide-identity']);
      writeFileSync(join(s.dataDir, 'patterns.json'), PATTERNS);
      // 앞부분(첫 1MB 안)에 사용자 패턴에 걸리는 값과 이메일이 든 줄, 그 뒤를 평범한 줄로 1MB가 넘게 채워요.
      const head = `${readFileSync(x.md, 'utf8')}\n- 메모 ${T1} ${EMAIL}\n`;
      const pad = Array.from({ length: 50_000 }, (_, i) => `- 평범한 메모 줄 ${i}`).join('\n');
      writeFileSync(x.md, `${head}${pad}\n`);
      const LOCK_AT = 1 << 20; // 검사가 한 번에 읽는 크기(1MB) 바로 뒤
      assert.ok(Buffer.byteLength(head) < LOCK_AT && readFileSync(x.md).length > LOCK_AT + 4096);
      const before = fingerprint(x.md);
      const rel = `worklogs/${DATE}.md`;

      const release = await lockRange(x.md, LOCK_AT);
      let c: CliResult;
      try {
        c = runCli(s, ['check']);
      } finally {
        await release();
      }
      assert.equal(c.code, 1, c.stdout);
      assert.match(c.stdout, /^ {3}남은 의심 +1건$/m, c.stdout);
      assert.deepEqual(suspectRows(c.stdout), [`     ${rel}  읽지 못함 (EBUSY)`], '수와 목록이 맞아요(앞 줄 번호·모양 없음)');
      assert.match(c.stdout, /이름·이메일 \(일지만\) {2}켠 일지 \d+개 — 사용자 이름 0건 · 이메일 0건/, '앞에서 찾은 이메일도 세지 않아요');
      assert.match(c.stdout, /^\[실패\] 남은 의심 1건, 놓친 패턴 0개$/m);
      assert.deepEqual(nextBlocks(c.stdout), [`다음: ${UNREADABLE_NEXT}`], '다시 가리기·이름·이메일 다음: 줄은 없어요');
      assert.deepEqual(fingerprint(x.md), before, '검사는 읽기만 해요');

      // 잠금을 풀고 다시 검사하면 앞에서 찾았던 의심과 이메일이 다시 나와요.
      const again = runCli(s, ['check']);
      assert.equal(again.code, 1, again.stdout);
      assert.match(again.stdout, /^\[실패\] 남은 의심 1건, 놓친 패턴 0개, 남은 이름·이메일 1건$/m);
      assert.match(again.stdout, new RegExp(`^ {5}${esc(rel)} +줄 \\d+ \\(${esc(LABEL)} 모양\\)$`, 'm'));
      assert.ok(!again.stdout.includes('읽지 못함'));
      assert.deepEqual(commandLines(again.stdout, 8), [`cc-worklog --date ${DATE} --hide-identity --data-dir ${shellPath(s.dataDir)} --claude-dir ${shellPath(s.claudeDir)}`]);
    } finally {
      s.cleanup();
    }
  },
);
