// 개선 개발 1회차 시험 (docs/IMPROVEMENT.md 우선순위 확정판, PRD 확정 2026-10-21의 A18~A22·Q25).
//  - I-01 (A19): 이름·이메일 가리기를 끈 일지에 남은 사용자 이름·이메일도 값 없이 세어 check가 [알림]으로 알리고(판정·종료 코드 그대로),
//    일지 만들기 S3 검사 줄 아래에 같은 뜻을 더해요.
//  - I-02 (A20): --root도 roots도 없는 일지 만들기는 S3 읽음 칸에 안내를 한 번 넣어요(경고 아님, git이 없으면 빼요).
//  - I-03 (A18 설정·A21): 기본 실행이 다시 만드는 일지는 이름·이메일 가리기를 끄지 않고, --date·--from으로 끈 채 다시 만들면 알려요.
//  - I-04 (A21): 손으로 고친 일지 마크다운은 어느 일지 만들기도 덮어쓰지 않고(.md·.json 그대로) S3에 날짜를 모두 알려요.
//    다시 가리기 뒤에도 고친 여부가 그대로예요.
//  - I-05 (A18·Q25): 날짜 옵션 없는 기본 실행이 빠진 지난 날짜와 그날이 끝나기 전에 만든 지난 일지를 만들고, --from·--to가 있어요.
//    보관본은 실행마다 한 번만 훑어요.
//  - I-06 (A22): 옵션 오류는 종류별 한국어 고정 문구예요(옵션 이름·모르는 명령만 보여 주고 값·Node 영어 원문은 넣지 않아요).
//  - I-07·I-08·I-11: README 빠른 시작·지금 되는 설치·용어 풀이.
// 모든 시험은 임시 폴더의 가짜 세션 기록·임시 저장소로만 해요.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { Redactor } from '../src/redact/redact.js';
import { displayWidth } from '../src/term/format.js';
import { MAKE_TEXT } from '../src/term/s3-summary.js';
import { IDENTITY_TEXT } from '../src/term/s4-check.js';
import { USAGE_NEXT, usageText } from '../src/term/usage.js';
import { dayKeyOf, dayRange, shiftDate } from '../src/util/time.js';
import { ARCHIVE_ONLY_HELP } from '../src/web/badge.js';
import { startServer } from '../src/web/server.js';
import { WorklogBuilder } from '../src/worklog/build.js';
import { markdownHashOf } from '../src/worklog/edited.js';
import { shellPath } from '../src/worklog/mismatch.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  APP_DIR,
  assistantText,
  commitAt,
  fingerprint,
  initRepo,
  kst,
  lastCheckRow,
  listFilesRec,
  readJson,
  rowText,
  runCli,
  sandbox,
  userText,
  writeSession,
  type Sandbox,
} from './helpers.js';

const ME = 'dev.kim@example.test';
/** 일지에 남을 가짜 이메일과 경로 속 사용자 이름 (요청 글 앞 100자 안) */
const EMAIL = 'qa.lee@example.test';
const WIN_USER = 'kimdev';
const PATTERNS = JSON.stringify([{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}' }]);
const TODAY = dayKeyOf(Date.now(), 3);
const ago = (n: number) => shiftDate(TODAY, -n);
const CHECK = '검사 공개 전에 cc-worklog check로 확인하세요';

let sidN = 0;
const nextSid = () => `1a000000-0000-4000-8000-${String(++sidN).padStart(12, '0')}`;

/** date의 10:00 요청 + 10:05 답변 세션 하나를 써요. 세션 파일 경로를 돌려줘요. */
function session(sb: Sandbox, cwd: string, date: string, text: string): string {
  const sid = nextSid();
  const A = { sid, cwd };
  return writeSession(sb, cwd, sid, [userText({ ...A, ts: kst(date, '10:00') }, text), assistantText({ ...A, ts: kst(date, '10:05') }, '했어요')]);
}

const files = (sb: Sandbox, date: string) => ({ md: join(sb.dataDir, 'worklogs', `${date}.md`), json: join(sb.dataDir, 'worklogs', `${date}.json`) });
const worklogDates = (dataDir: string) =>
  existsSync(join(dataDir, 'worklogs'))
    ? [...new Set(readdirSync(join(dataDir, 'worklogs')).map((n) => n.slice(0, 10)))].sort()
    : [];
const pair = (sb: Sandbox, date: string) => {
  const f = files(sb, date);
  return { md: fingerprint(f.md), json: fingerprint(f.json) };
};
/** 그 일지를 "그날이 끝나기 전에 만든 일지"로 바꿔요(화면용 데이터의 만든 시각만 그날 시작 + 1시간으로, 마크다운은 그대로). */
function madeDuringDay(sb: Sandbox, date: string) {
  const f = files(sb, date);
  const day = readJson<DayLog>(f.json);
  day.generatedAt = new Date(Date.parse(day.range.start) + 3_600_000).toISOString();
  writeFileSync(f.json, `${JSON.stringify(day, null, 1)}\n`);
}
const lines = (out: string) => out.split('\n');

// ---- I-06 옵션 오류 (A22) ----

test('I-06: 옵션 오류는 종류별 한국어 고정 문구 [실패] 한 줄 + 다음: 줄(종료 코드 1)이고, 옵션 값·Node 영어 원문은 나오지 않아요', () => {
  const sb = sandbox();
  try {
    const SECRET = 'kimsecret';
    const cases: Array<{ args: string[]; msg: string; hidden?: string[] }> = [
      { args: ['--form', '2026-10-01'], msg: usageText.unknownOption('--form'), hidden: ['2026-10-01'] },
      { args: ['-x'], msg: usageText.unknownOption('-x') },
      { args: ['--date'], msg: usageText.missingValue('--date') },
      { args: ['--hide-identity=yes'], msg: usageText.noValueAllowed('--hide-identity'), hidden: ['yes'] },
      { args: ['nope'], msg: usageText.unknownCommand('nope') },
      // 옵션 이름 없이 경로만 준 경우: 경로 속 사용자 이름이 오류에 나오지 않아요.
      { args: [`C:\\Users\\${SECRET}\\work`], msg: usageText.unknownCommandHidden, hidden: [SECRET] },
      { args: ['check', `/home/${SECRET}/x`], msg: usageText.extraArgs(1), hidden: [SECRET] },
      // 잘못된 값은 값 없이 받는 모양만 알려요.
      { args: ['--date', `C:/Users/${SECRET}`], msg: usageText.badDate('--date'), hidden: [SECRET] },
      { args: [`--from=${SECRET}`], msg: usageText.badDate('--from'), hidden: [SECRET] },
      { args: ['--from', '2026-10-01', '--to', `x${SECRET}`], msg: usageText.badDate('--to'), hidden: [SECRET] },
      { args: ['--day-start', '99'], msg: usageText.badDayStart, hidden: ['99'] },
      { args: ['view', '--port', '70000'], msg: usageText.badPort, hidden: ['70000'] },
      // 그 명령에서 받지 않거나 함께 쓸 수 없는 옵션 (A16·A18)
      { args: ['archive', '--yes'], msg: usageText.yesOnlyRedact },
      { args: ['make', '-y'], msg: usageText.yesOnlyRedact },
      { args: ['check', '--from', '2026-10-01'], msg: usageText.rangeOnlyMake, hidden: ['2026-10-01'] },
      { args: ['redact', '--to', '2026-10-01'], msg: usageText.rangeOnlyMake },
      { args: ['--date', 'today', '--from', '2026-10-01'], msg: usageText.dateWithRange },
      { args: ['--to', '2026-10-01'], msg: usageText.toWithoutFrom },
      { args: ['--from', '2026-10-05', '--to', '2026-10-01'], msg: usageText.reversedRange, hidden: ['2026-10-05'] },
    ];
    for (const c of cases) {
      const r = runCli(sb, c.args);
      const label = JSON.stringify(c.args);
      assert.equal(r.code, 1, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, '', label);
      assert.deepEqual(r.stderr.split('\n'), [`[실패] ${c.msg}`, `다음: ${USAGE_NEXT}`, ''], label);
      assert.ok(!/Unknown|argument|ambiguous|does not take|Did you|positional/i.test(r.stderr), `${label}: Node 영어 원문이 없어요`);
      // 옵션 이름·명령 이름·날짜 모양 글자를 빼면 영어 글자가 없어요.
      const rest = r.stderr.replace(/cc-worklog|--?[a-z][a-z-]*|YYYY-MM-DD|today|yesterday|redact|make|nope/g, '');
      assert.ok(!/[A-Za-z]/.test(rest), `${label}: 영어 글자가 남았어요: ${rest}`);
      for (const h of c.hidden ?? []) assert.ok(!r.stderr.includes(h), `${label}: 값(${h})은 보여 주지 않아요`);
    }
    assert.ok(!existsSync(sb.dataDir), '사용법 오류로 멈추면 데이터 폴더를 만들지 않아요');
  } finally {
    sb.cleanup();
  }
});

// ---- I-02 세션 없던 저장소 안내 (A20) ----

test('I-02: --root도 roots도 없으면 S3 읽음 칸에 (세션이 있던 곳만)과 안내 한 줄이 여러 날이어도 한 번 나오고, --root·roots·git 없음과 보관·검사·다시 가리기에서는 나오지 않아요', () => {
  const sb = sandbox();
  try {
    const work = join(sb.root, 'work');
    const web = join(work, 'web');
    const docs = join(work, 'docs-site');
    initRepo(sb, web, ME);
    initRepo(sb, docs, ME);
    commitAt(sb, web, 'feat: 헤더', `${ago(1)}T11:00:00+09:00`);
    commitAt(sb, docs, 'docs: 세션 없이 고친 문서', `${ago(1)}T15:00:00+09:00`);
    session(sb, web, ago(2), '어제 전 작업');
    session(sb, web, ago(1), '어제 작업');

    const HINT = `            ${MAKE_TEXT.noRootsHint}`;
    const r = runCli(sb, []);
    assert.equal(r.code, 0, r.stderr);
    const L = lines(r.stdout);
    const i = L.findIndex((l) => l.startsWith('읽음'));
    assert.equal(L[i], '읽음        세션 2개 · 저장소 1개(세션이 있던 곳만) · 커밋 1개', r.stdout);
    assert.equal(L[i + 1], HINT, '바로 다음 줄(값 칸 위치)이에요');
    assert.ok(displayWidth(L[i + 1]!) <= 80);
    assert.equal(L.filter((l) => l === HINT).length, 1, '여러 날짜여도 한 번이에요');
    assert.ok(!r.stdout.includes('[경고]') && !r.stdout.includes('[알림]'), '경고·알림이 아니에요');

    // --root를 주면 세션 없던 저장소의 커밋도 들어가고 안내는 없어요.
    const withRoot = runCli(sb, ['--date', ago(1), '--root', work]);
    assert.equal(withRoot.code, 0, withRoot.stderr);
    assert.match(withRoot.stdout, /^읽음 {8}세션 1개 · 저장소 2개 · 커밋 2개$/m);
    assert.ok(!withRoot.stdout.includes('세션이 있던 곳만') && !withRoot.stdout.includes(MAKE_TEXT.noRootsHint));
    // config.json의 roots도 같아요. 모두 건너뛴 경로여도 빼요(경로마다 [알림]이 대신 나와요).
    writeFileSync(join(sb.dataDir, 'config.json'), JSON.stringify({ roots: [join(sb.root, 'no-such')] }));
    const cfgRoots = runCli(sb, ['--date', ago(1)]);
    assert.equal(cfgRoots.code, 0, cfgRoots.stderr);
    assert.ok(!cfgRoots.stdout.includes(MAKE_TEXT.noRootsHint) && cfgRoots.stdout.includes('[알림] config.json의 roots 경로를 건너뛰었어요'));
    rmSync(join(sb.dataDir, 'config.json'));
    // git을 찾지 못했으면 빼요.
    const noGit = runCli(sb, ['--date', ago(1)], { CC_WORKLOG_GIT: join(sb.root, 'no-such-git.exe') });
    assert.equal(noGit.code, 0, noGit.stderr);
    assert.ok(noGit.stdout.includes('[알림] git을 찾지 못해') && !noGit.stdout.includes(MAKE_TEXT.noRootsHint) && !noGit.stdout.includes('세션이 있던 곳만'));
    // 저장소를 읽지 않는 명령에서는 나오지 않아요.
    for (const args of [['archive'], ['check'], ['redact']]) {
      const o = runCli(sb, args);
      assert.ok(!o.stdout.includes(MAKE_TEXT.noRootsHint) && !o.stdout.includes('세션이 있던 곳만'), `${args[0]}에는 안내가 없어요`);
    }
    // 만든 일지가 없어도 안내는 그대로이고(읽음 칸은 늘 있어요), 기본 실행의 까닭은 그대로 둔 수예요. 대상 날짜가 없으면 머리 줄은 오늘이에요.
    const none = runCli(sb, []);
    assert.equal(none.code, 0, none.stderr);
    assert.match(none.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${TODAY} \\(하루 경계 03:00\\)$`, 'm'));
    assert.match(none.stdout, /^읽음 {8}세션 0개 · 저장소 0개\(세션이 있던 곳만\) · 커밋 0개$/m);
    assert.match(none.stdout, /^결과 {8}만든 일지 없음 — 새로 만들 날짜가 없어요 · 그대로 둠 2개$/m);
    assert.equal(lastCheckRow(none.stdout), CHECK, '만든 일지가 없으면 이름·이메일 안내도 없어요');
  } finally {
    sb.cleanup();
  }
});

// ---- I-01 끈 일지의 이름·이메일 (A19) ----

test('I-01: 옵션을 끄고 만든 일지에 경로 속 사용자 이름·이메일이 남으면 check가 값 없이 세어 판정 줄 바로 위 [알림]으로 알리고(통과·종료 코드 0 그대로), 일지 만들기 S3 검사 줄 아래에도 알려요', () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    commitAt(sb, web, `리뷰 요청 ${EMAIL}`, `${ago(1)}T11:00:00+09:00`);
    session(sb, web, ago(1), `C:\\Users\\${WIN_USER}\\proj 에서 ${EMAIL} 확인`);
    session(sb, web, TODAY, '오늘 작업');

    const m = runCli(sb, []);
    assert.equal(m.code, 0, m.stderr);
    // S3: 검사 줄 바로 아래(12칸)에 A19 안내 두 줄, 출력의 마지막이에요(DESIGN S3 가·나 14번).
    assert.equal(lastCheckRow(m.stdout), `${CHECK} ${MAKE_TEXT.checkIdentityAll}`, m.stdout);
    const tail = lines(m.stdout.trimEnd()).slice(-3);
    assert.equal(tail[1], '            이번 일지는 이름·이메일을 가리지 않았어요. 검사는 비밀 값만');
    assert.equal(tail[2], '            판정해요. 공개할 날짜는 --hide-identity를 붙여 다시 만드세요.');
    assert.ok(tail.every((l) => displayWidth(l) <= 80));
    assert.ok(readFileSync(files(sb, ago(1)).md, 'utf8').includes(EMAIL), '옵션을 끄면 일지에 이메일이 그대로예요');

    const c = runCli(sb, ['check']);
    assert.equal(c.code, 0, `판정·종료 코드는 그대로예요: ${c.stdout}`);
    const L = lines(c.stdout.replace(/\n$/, ''));
    const v = L.findIndex((l) => l.startsWith('[통과]'));
    assert.equal(L[v], '[통과] 남은 의심 0건, 놓친 패턴 0개');
    // 2. 결과물 재검사: 끈 일지 줄(날짜 수 2개)과 늘 두는 괄호 줄, 위치 목록은 없어요(DESIGN S4 5번).
    const r0 = L.findIndex((l) => l.startsWith('   이름·이메일 (일지만)  '));
    const m1 = /^ {3}이름·이메일 \(일지만\) {2}끈 일지 2개 — 사용자 이름 (\d+)건 · 이메일 (\d+)건$/.exec(L[r0]!);
    assert.ok(m1, c.stdout);
    assert.equal(L[r0 + 1], `${' '.repeat(25)}${IDENTITY_TEXT.rowNote}`);
    assert.equal(L[r0 + 2], '', '끈 일지의 위치는 늘어놓지 않아요');
    const [names, emails] = [Number(m1[1]), Number(m1[2])];
    assert.ok(names > 0 && emails > 0, '실제 수를 보여 줘요("옵션이 꺼져 있어 세지 않았어요"만 보여 주지 않아요)');
    assert.ok(!c.stdout.includes('옵션이 꺼져 있어 세지 않았어요'));
    // 판정 다음 빈 줄 하나 뒤 맨 끝 [알림] 덩어리(DESIGN S4 12번): 끈 일지 수·남은 수, 판정은 비밀 값만 본 결과, 명령 모양(9칸, 이번 실행의 폴더 포함), 안내 한 줄(7칸)
    assert.equal(L[v + 1], '');
    assert.ok(L[v + 2]!.startsWith('[알림] 이름·이메일 가리기를 끈 일지 2개에'), c.stdout);
    const cmdShape = `cc-worklog --date <날짜> --hide-identity --data-dir ${shellPath(sb.dataDir)} --claude-dir ${shellPath(sb.claudeDir)}`;
    assert.equal(L[L.length - 2], `         ${cmdShape}`);
    assert.equal(IDENTITY_TEXT.offCommand({ dayStartHour: 3, dataDir: sb.dataDir, claudeDir: sb.claudeDir }), cmdShape);
    assert.equal(L[L.length - 1], '       만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요.');
    assert.equal(rowText(L.slice(v + 2, L.length - 2).join('\n'), '[알림]'), `[알림] ${IDENTITY_TEXT.offNotice(2, names, emails)}`);
    assert.ok(L.slice(v + 2, L.length - 2).every((l) => displayWidth(l) <= 80));
    assert.ok(!c.stdout.includes(EMAIL) && !c.stdout.includes(WIN_USER), '값은 보여 주지 않아요');

    // 같은 데이터를 --hide-identity로 검사하면 같은 수가 켠 일지 줄로 판정에 들어가요(실패).
    const on = runCli(sb, ['check', '--hide-identity']);
    assert.equal(on.code, 1, on.stdout);
    assert.match(on.stdout, new RegExp(`^ {3}이름·이메일 \\(일지만\\) {2}켠 일지 2개 — 사용자 이름 ${names}건 · 이메일 ${emails}건$`, 'm'));
    assert.match(on.stdout, new RegExp(`^\\[실패\\] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 ${names + emails}건$`, 'm'));
    assert.ok(!on.stdout.includes('[알림] 이름·이메일 가리기를 끈 일지') && !on.stdout.includes('끈 일지 '), '모두 켠 것으로 보면 끈 일지 줄·알림은 없어요');

    // 이름·이메일 가리기를 켜고 만들면 S3 검사 줄은 그대로 한 줄이고, check에도 끈 일지 알림이 없어요.
    const hide = runCli(sb, ['--from', ago(1), '--hide-identity']);
    assert.equal(hide.code, 0, hide.stderr);
    assert.equal(lastCheckRow(hide.stdout), CHECK);
    const c2 = runCli(sb, ['check']);
    assert.equal(c2.code, 0, c2.stdout);
    assert.ok(!c2.stdout.includes('[알림]') && !c2.stdout.includes('끈 일지'), c2.stdout);
    assert.match(c2.stdout, /^ {3}이름·이메일 \(일지만\) {2}켠 일지 2개 — 사용자 이름 0건 · 이메일 0건$/m);

    // 켠 일지와 끈 일지가 섞이면 켠 일지 줄이 먼저예요.
    const mix = runCli(sb, ['--date', TODAY]);
    assert.equal(mix.code, 0, mix.stderr);
    const c3 = runCli(sb, ['check']);
    const L3 = lines(c3.stdout);
    const i3 = L3.findIndex((l) => l.startsWith('   이름·이메일 (일지만)  '));
    assert.equal(L3[i3], '   이름·이메일 (일지만)  켠 일지 1개 — 사용자 이름 0건 · 이메일 0건');
    assert.match(L3[i3 + 1]!, /^ {25}끈 일지 1개 — 사용자 이름 \d+건 · 이메일 \d+건$/);
    assert.equal(L3[i3 + 2], `${' '.repeat(25)}${IDENTITY_TEXT.rowNote}`);
  } finally {
    sb.cleanup();
  }
});

// ---- I-03 공개용 일지 지키기 (A18 설정·A21) ----

test('I-03: 기본 실행은 켜고 만든 오늘·그날이 끝나기 전 일지를 켠 채 다시 만들고, --date·--from으로 끈 채 다시 만들면 날짜와 --hide-identity 명령을 알려요', () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    const Y = ago(1);
    const Z = ago(2);
    session(sb, web, Y, `C:\\Users\\${WIN_USER}\\proj 에서 ${EMAIL} 확인`);
    session(sb, web, TODAY, `오늘도 ${EMAIL} 확인`);
    const first = runCli(sb, ['--hide-identity']);
    assert.equal(first.code, 0, first.stderr);
    for (const d of [Y, TODAY]) assert.equal(readJson<DayLog>(files(sb, d).json).hideIdentity, true);
    madeDuringDay(sb, Y); // 어제 저녁에 만들고 더 일한 일지
    session(sb, web, Z, '그저께 작업(일지 없음)');
    const madeAt = Object.fromEntries([Y, TODAY].map((d) => [d, readJson<DayLog>(files(sb, d).json).generatedAt]));

    const r = runCli(sb, []);
    assert.equal(r.code, 0, r.stderr);
    for (const d of [Y, TODAY]) {
      const f = files(sb, d);
      const day = readJson<DayLog>(f.json);
      assert.equal(day.hideIdentity, true, `${d}: 켠 채로 다시 만들어요`);
      assert.notEqual(day.generatedAt, madeAt[d], `${d}: 다시 만들었어요`);
      const text = readFileSync(f.md, 'utf8') + readFileSync(f.json, 'utf8');
      assert.ok(!text.includes(EMAIL) && !text.includes(WIN_USER), `${d}: 이름·이메일이 없어요`);
    }
    assert.equal(readJson<DayLog>(files(sb, Z).json).hideIdentity, false, '새로 만든 날짜는 이번 실행 설정(꺼짐)이에요');
    assert.match(r.stdout, /^이름·이메일 꺼짐 \(켜고 만들었던 일지 2개는 켠 채로 다시 만들었어요\)$/m);
    assert.ok(!r.stdout.includes('끈 채 다시 만들었어요'), '기본 실행은 끈 채 다시 만들지 않아서 [알림]이 없어요');
    assert.equal(lastCheckRow(r.stdout), `${CHECK} ${MAKE_TEXT.checkIdentitySome(1)}`, '끈 채 만든 일지 1개만 알려요');
    assert.match(r.stdout, /^결과 {8}일지 3개 — 새로 만듦 1개 · 다시 만듦 2개$/m);

    // --date로 끈 채 다시 만들면 [알림]으로 그 날짜와 --hide-identity를 붙인 명령을 보여 줘요(막지는 않아요).
    const d1 = runCli(sb, ['--date', Y]);
    assert.equal(d1.code, 0, d1.stderr);
    assert.equal(readJson<DayLog>(files(sb, Y).json).hideIdentity, false);
    const L = lines(d1.stdout);
    const a = L.indexOf('[알림] 이름·이메일 가리기를 켜고 만들었던 일지 1개를 끈 채 다시 만들었어요.');
    assert.ok(a >= 0, d1.stdout);
    const cmdY = `cc-worklog --date ${Y} --hide-identity --data-dir ${shellPath(sb.dataDir)} --claude-dir ${shellPath(sb.claudeDir)}`;
    assert.deepEqual(L.slice(a + 1, a + 4), [`       ${Y}`, `       ${MAKE_TEXT.identityOffTodo}`, `         ${cmdY}`]);
    assert.equal(L[a + 4], '', '결과 칸 바로 위 [알림]이에요');
    assert.match(L[a + 5]!, /^결과/);

    // --from이면 기간 명령(--to는 오늘 날짜로)이에요. 그 명령대로 실행하면 다시 켜져요.
    const f1 = runCli(sb, ['--from', Z]);
    assert.equal(f1.code, 0, f1.stderr);
    const cmdRange = `cc-worklog --from ${Z} --to ${TODAY} --hide-identity --data-dir ${shellPath(sb.dataDir)} --claude-dir ${shellPath(sb.claudeDir)}`;
    assert.ok(f1.stdout.includes(`[알림] 이름·이메일 가리기를 켜고 만들었던 일지 1개를 끈 채 다시 만들었어요.\n       ${TODAY}\n`), f1.stdout);
    assert.ok(f1.stdout.includes(`\n         ${cmdRange}\n`), f1.stdout);
    const again = runCli(sb, ['--from', Z, '--to', TODAY, '--hide-identity']);
    assert.equal(again.code, 0, again.stderr);
    for (const d of [Z, Y, TODAY]) assert.equal(readJson<DayLog>(files(sb, d).json).hideIdentity, true);
    assert.ok(!again.stdout.includes('끈 채 다시 만들었어요'));
  } finally {
    sb.cleanup();
  }
});

// ---- I-04 손으로 고친 일지 (A21) ----

test('I-04: 손으로 고친 일지 마크다운은 --date·--from·기본 실행 어느 것도 덮어쓰지 않고(.md·.json 바이트 그대로, 종료 코드 0) S3 [알림]에 날짜를 모두 보여 주며, 손대지 않은 일지는 새로 만듦·다시 만듦으로 알려요', () => {
  const sb = sandbox();
  try {
    const work = join(sb.root, 'work');
    const web = join(work, 'web');
    initRepo(sb, web, ME);
    const [A, B] = [ago(3), ago(1)];
    for (const d of [A, B, TODAY]) session(sb, web, d, `${d} 작업`);

    let r = runCli(sb, ['--date', B]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^결과 {8}일지 \(새로 만듦\)$/m);
    const day = readJson<DayLog>(files(sb, B).json);
    assert.equal(day.markdownHash, markdownHashOf(readFileSync(files(sb, B).md)), '도구가 쓴 마크다운의 해시를 화면용 데이터에 둬요');
    r = runCli(sb, ['--date', B]);
    assert.match(r.stdout, /^결과 {8}일지 \(다시 만듦 — 이미 있던 일지를 새 내용으로 바꿨어요\)$/m);

    // 메모를 더해요. --root를 붙여 다시 만들어도 그대로예요.
    appendFileSync(files(sb, B).md, '\n## 내 메모\n- 내일 리뷰 받기\n');
    const before = pair(sb, B);
    r = runCli(sb, ['--date', B, '--root', work]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pair(sb, B), before, '.md·.json 모두 바이트·수정 시각 그대로예요');
    const L = lines(r.stdout);
    const a = L.indexOf('[알림] 손으로 고친 일지 1개는 덮어쓰지 않고 그대로 뒀어요.');
    assert.ok(a >= 0, r.stdout);
    assert.deepEqual(L.slice(a + 1, a + 4), [`       ${B}`, `       ${MAKE_TEXT.editedTodo[0]}`, `       ${MAKE_TEXT.editedTodo[1]}`]);
    assert.ok(L.every((l) => l.includes('\\') || l.includes('/') || displayWidth(l) <= 80), '경로 줄 말고는 80칸 안이에요');
    assert.equal(rowText(r.stdout, '결과').split(' 보관 폴더')[0], `결과 ${MAKE_TEXT.resultNoneSkipped} 일지 폴더 ${join(sb.dataDir, 'worklogs')}`);
    assert.equal(lastCheckRow(r.stdout), CHECK, '만든 일지가 없으면 이름·이메일 안내가 없어요');

    // --from: 고친 날짜는 건너뛰고 나머지는 만들어요. 건너뛴 날짜는 결과 수에 넣지 않아요.
    r = runCli(sb, ['--from', A]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pair(sb, B), before);
    assert.ok(r.stdout.includes(`[알림] 손으로 고친 일지 1개는 덮어쓰지 않고 그대로 뒀어요.\n       ${B}\n`), r.stdout);
    assert.match(r.stdout, /^결과 {8}일지 2개 — 새로 만듦 2개$/m);
    assert.match(r.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${A} ~ ${TODAY} `, 'm'));

    // 기본 실행: 오늘 일지(늘 다시 만드는 대상)를 손으로 고치면 건너뛰어요. 줄 끝 모양만 바꿔도 고친 것으로 봐요(안전 쪽).
    const t = files(sb, TODAY);
    writeFileSync(t.md, readFileSync(t.md, 'utf8').replace(/\n/g, '\r\n'));
    const tBefore = pair(sb, TODAY);
    r = runCli(sb, []);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pair(sb, TODAY), tBefore);
    assert.deepEqual(pair(sb, B), before);
    assert.ok(r.stdout.includes(`[알림] 손으로 고친 일지 1개는 덮어쓰지 않고 그대로 뒀어요.\n       ${TODAY}\n`), r.stdout);
    assert.match(r.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${TODAY} `, 'm'), '대상 날짜는 건너뛴 날짜도 넣어요');
    assert.match(r.stdout, /^결과 {8}만든 일지 없음 — 손으로 고친 일지라 덮어쓰지 않았어요$/m);

    // 고친 일지가 여럿이면 날짜를 모두 보여 줘요(줄이지 않아요).
    r = runCli(sb, ['--from', A]);
    assert.ok(r.stdout.includes(`[알림] 손으로 고친 일지 2개는 덮어쓰지 않고 그대로 뒀어요.\n       ${B}, ${TODAY}\n`), r.stdout);
    assert.match(r.stdout, /^결과 {8}일지 \(다시 만듦 — /m);

    // 새 종류의 파일은 없어요(일지 폴더에는 날짜마다 .md·.json뿐). 사본·백업도 없어요.
    assert.deepEqual(readdirSync(join(sb.dataDir, 'worklogs')).filter((n) => !/^\d{4}-\d{2}-\d{2}\.(md|json)$/.test(n)), []);
    assert.deepEqual(listFilesRec(sb.dataDir).filter((p) => /\.(bak|orig|copy)$|~$/.test(p)), []);

    // 메모를 옮기고 .md를 지우면 새로 만들어져요(일지가 없는 날짜).
    rmSync(files(sb, B).md);
    r = runCli(sb, ['--date', B]);
    assert.match(r.stdout, /^결과 {8}일지 \(새로 만듦\)$/m);
    assert.ok(!readFileSync(files(sb, B).md, 'utf8').includes('내 메모'));
  } finally {
    sb.cleanup();
  }
});

test('I-04: 다시 가리기가 조각을 고친 일지는 고친 여부가 다시 가리기 전과 같아요 — 손대지 않은 일지는 다시 만들어지고, 손으로 고친 일지는 건너뛰어요', () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    const [U, E] = [ago(2), ago(1)];
    session(sb, web, U, '손대지 않을 일지 CORP-11112222 확인');
    session(sb, web, E, '메모를 더할 일지 CORP-33334444 확인');
    assert.equal(runCli(sb, ['--from', U, '--to', E]).code, 0);
    appendFileSync(files(sb, E).md, '\n## 내 메모\n- 회고 때 이야기하기\n');
    writeFileSync(join(sb.dataDir, 'patterns.json'), PATTERNS);

    const rd = runCli(sb, ['redact', '--yes']);
    assert.equal(rd.code, 0, `${rd.stdout}\n${rd.stderr}`);
    for (const d of [U, E]) assert.ok(!readFileSync(files(sb, d).md, 'utf8').includes('CORP-'), `${d}: 다시 가리기가 조각을 고쳤어요`);
    assert.ok(readFileSync(files(sb, E).md, 'utf8').includes('회고 때 이야기하기'), '손으로 적은 줄은 그대로예요');
    const u = readJson<DayLog>(files(sb, U).json);
    assert.equal(u.markdownHash, markdownHashOf(readFileSync(files(sb, U).md)), '손대지 않은 일지는 새 마크다운의 해시예요');
    const e = readJson<DayLog>(files(sb, E).json);
    assert.notEqual(e.markdownHash, markdownHashOf(readFileSync(files(sb, E).md)), '손으로 고친 일지는 여전히 고친 일지예요');

    let r = runCli(sb, ['--date', U]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^결과 {8}일지 \(다시 만듦 — /m);
    const before = pair(sb, E);
    r = runCli(sb, ['--date', E]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pair(sb, E), before, '다시 가리기 뒤의 일지 만들기도 메모를 덮어쓰지 않아요');
    assert.ok(r.stdout.includes(`[알림] 손으로 고친 일지 1개는 덮어쓰지 않고 그대로 뒀어요.\n       ${E}\n`), r.stdout);
    // 검사는 통과해요(다시 가리기가 고친 일지예요).
    assert.equal(runCli(sb, ['check']).code, 0);
  } finally {
    sb.cleanup();
  }
});

// ---- I-05 여러 날 한 번에 (A18·Q25) ----

test('I-05: 기본 실행은 가장 이른 세션 날짜부터 오늘까지 재료가 있는 날짜(원본을 지운 보관본·roots 커밋만 있는 날짜 포함)를 모두 만들고, 날짜마다 --date로 따로 만든 일지와 같아요(만든 시각 제외)', () => {
  const sb = sandbox();
  try {
    const work = join(sb.root, 'work');
    const web = join(work, 'web');
    const docs = join(work, 'docs');
    initRepo(sb, web, ME);
    initRepo(sb, docs, ME);
    const [D0, A, B, C] = [ago(40), ago(25), ago(10), ago(1)];
    commitAt(sb, docs, 'docs: 가장 이른 세션보다 먼저 한 커밋', `${D0}T11:00:00+09:00`);
    commitAt(sb, docs, 'docs: 세션 없이 고친 문서', `${B}T15:00:00+09:00`);
    commitAt(sb, web, 'feat: 오늘 기능', `${TODAY}T11:00:00+09:00`);
    // A: 보관한 뒤 원본을 지운 세션 (보관본만 남음)
    const fileA = session(sb, web, A, '오래된 작업');
    assert.equal(runCli(sb, ['archive']).code, 0);
    rmSync(fileA);
    session(sb, web, C, '어제 작업');
    session(sb, web, TODAY, '오늘 작업');
    writeFileSync(join(sb.dataDir, 'config.json'), JSON.stringify({ roots: [work] }));

    const r = runCli(sb, []);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(worklogDates(sb.dataDir), [A, B, C, TODAY], '가장 이른 세션 날짜(A)보다 이른 roots 커밋 날짜(D0)는 넣지 않아요');
    assert.match(r.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${A} ~ ${TODAY} \\(하루 경계 03:00\\)$`, 'm'));
    assert.match(r.stdout, /^결과 {8}일지 4개 — 새로 만듦 4개$/m);
    assert.match(r.stdout, /^ {12}일지 폴더$/m);
    assert.match(r.stdout, /\(원본은 지워지고 보관본만 남은 세션 1개\)/);
    assert.equal(readJson<DayLog>(files(sb, B).json).totals.sessions, 0, 'B는 roots 커밋만 있는 날짜예요');
    assert.equal(readJson<DayLog>(files(sb, A).json).totals.sessions, 1, 'A는 보관본만으로 만들어요');

    // 날짜마다 같은 설정으로 --date로 따로 만든 일지와 같아요(만든 시각 제외).
    const sb2 = { ...sb, dataDir: join(sb.root, 'data-each') };
    cpSync(sb.dataDir, sb2.dataDir, { recursive: true });
    rmSync(join(sb2.dataDir, 'worklogs'), { recursive: true });
    for (const d of [A, B, C, TODAY]) {
      const each = runCli(sb2, ['--date', d]);
      assert.equal(each.code, 0, each.stderr);
      const x = files(sb, d);
      const y = files(sb2, d);
      assert.equal(readFileSync(y.md, 'utf8'), readFileSync(x.md, 'utf8'), `${d} 마크다운`);
      const strip = (p: string) => {
        const o = readJson<Record<string, unknown>>(p);
        delete o.generatedAt;
        return o;
      };
      assert.deepEqual(strip(y.json), strip(x.json), `${d} 화면용 데이터`);
    }

    // 다음 기본 실행: 그날이 끝난 뒤 만든 일지(A·B·C)는 그대로, 오늘만 다시 만들어요.
    const kept = [A, B, C].map((d) => pair(sb, d));
    const r2 = runCli(sb, []);
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual([A, B, C].map((d) => pair(sb, d)), kept);
    assert.match(r2.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${TODAY} `, 'm'));
    assert.match(r2.stdout, /^결과 {8}일지 \(다시 만듦 — 이미 있던 일지를 새 내용으로 바꿨어요\)$/m, '하나면 그대로 둠 수는 붙이지 않아요');

    // 그날이 끝나기 전에 만든 지난 일지(C)는 기본 실행이 다시 만들어요.
    madeDuringDay(sb, C);
    const r3 = runCli(sb, []);
    assert.equal(r3.code, 0, r3.stderr);
    assert.ok(Date.parse(readJson<DayLog>(files(sb, C).json).generatedAt) > dayRange(C, 3).end, 'C를 다시 만들었어요');
    assert.deepEqual([A, B].map((d) => pair(sb, d)), kept.slice(0, 2));
    assert.match(r3.stdout, /^결과 {8}일지 2개 — 다시 만듦 2개 · 그대로 둠 2개$/m);
    assert.match(r3.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${C} ~ ${TODAY} `, 'm'));

    // --from은 기간 안 재료가 있는 날짜를 모두(이미 있어도) 다시 만들고, 커밋만 있는 이른 날짜(D0)도 넣어요. --to를 빼면 오늘까지예요.
    const f = runCli(sb, ['--from', D0]);
    assert.equal(f.code, 0, f.stderr);
    assert.deepEqual(worklogDates(sb.dataDir), [D0, A, B, C, TODAY]);
    assert.match(f.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${D0} ~ ${TODAY} `, 'm'));
    assert.match(f.stdout, /^결과 {8}일지 5개 — 새로 만듦 1개 · 다시 만듦 4개$/m);
    // 그대로 둔 일지는 일지 폴더에 이미 있던 일지 중 대상 날짜가 아닌 것이라, 가장 이른 세션보다 이른 D0도 들어가요(DESIGN S3 "이 절의 말").
    madeDuringDay(sb, C);
    const r4 = runCli(sb, []);
    assert.match(r4.stdout, /^결과 {8}일지 2개 — 다시 만듦 2개 · 그대로 둠 3개$/m, r4.stdout);
    // --from·--to: 그 기간만이에요.
    const before = pair(sb, TODAY);
    const ft = runCli(sb, ['--from', A, '--to', C]);
    assert.match(ft.stdout, /^결과 {8}일지 3개 — 다시 만듦 3개$/m);
    assert.deepEqual(pair(sb, TODAY), before);
    // 재료가 없는 기간: 만든 일지 없음, 그 날짜의 일지는 만들지 않아요. 같은 날짜 기간은 날짜 하나로 적어요.
    const empty = runCli(sb, ['--from', ago(5), '--to', ago(5)]);
    assert.equal(empty.code, 0, empty.stderr);
    assert.match(empty.stdout, new RegExp(`^cc-worklog 일지 만들기 — ${ago(5)} \\(하루 경계 03:00\\)$`, 'm'));
    assert.match(empty.stdout, /^결과 {8}만든 일지 없음 — 이 기간에 읽을 세션과 커밋이 없어요$/m);
    assert.ok(!existsSync(files(sb, ago(5)).md));

    // 기본 실행에서 만들 날짜가 없으면(오늘 일지를 손으로 고침) 까닭과 그대로 둔 수예요.
    appendFileSync(files(sb, TODAY).md, '\n메모\n');
    const nothing = runCli(sb, []);
    assert.match(nothing.stdout, /^결과 {8}만든 일지 없음 — 손으로 고친 일지라 덮어쓰지 않았어요$/m);
  } finally {
    sb.cleanup();
  }
});

test('I-05: 여러 날을 만들어도 보관본은 실행마다 한 번만 훑어요(날짜 수에 비례해 다시 읽지 않아요) — WorklogBuilder 단위', async () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    const dates = Array.from({ length: 12 }, (_, i) => ago(i * 2));
    for (const d of dates) session(sb, web, d, `${d} 작업`);
    assert.equal(runCli(sb, ['archive']).code, 0);

    const cfg = resolveConfig({ claudeDir: sb.claudeDir, dataDir: sb.dataDir });
    const archived = listFilesRec(join(sb.dataDir, 'archive', 'projects')).filter((p) => p.endsWith('.jsonl'));
    const totalLines = archived.reduce((n, p) => n + readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0).length, 0);
    const b = await WorklogBuilder.open(cfg, new Redactor([]), { from: null, to: TODAY });
    const stats = b.scanStats;
    assert.deepEqual(stats, { files: archived.length, lines: totalLines }, '보관본 파일마다 한 번, 줄마다 한 번 읽었어요');
    assert.deepEqual(b.materialDates(), [...dates].sort());
    for (const d of b.materialDates()) {
      const built = await b.build(d, { hideIdentity: false });
      assert.equal(built.day.totals.sessions, 1, d);
    }
    assert.deepEqual(b.scanStats, stats, '날짜를 만들 때 보관본을 다시 읽지 않아요');
  } finally {
    sb.cleanup();
  }
});

test('I-05: 여러 날의 읽음 합계는 여러 날에 걸친 세션을 한 번만 세요(DESIGN S3 가·나 3번)', () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    const sid = nextSid();
    const A = { sid, cwd: web };
    writeSession(sb, web, sid, [
      userText({ ...A, ts: kst(ago(2), '10:00') }, '이틀에 걸친 세션 시작'),
      assistantText({ ...A, ts: kst(ago(2), '10:05') }, '했어요'),
      userText({ ...A, ts: kst(ago(1), '10:00') }, '이어서'),
      assistantText({ ...A, ts: kst(ago(1), '10:05') }, '했어요'),
    ]);
    session(sb, web, ago(1), '하루짜리 세션');
    const r = runCli(sb, []);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^결과 {8}일지 2개 — 새로 만듦 2개$/m);
    assert.match(r.stdout, /^읽음 {8}세션 2개 · 저장소 1개\(세션이 있던 곳만\) · 커밋 0개$/m, r.stdout);
  } finally {
    sb.cleanup();
  }
});

test('I-05: --help의 날짜 옵션 설명이 Q25 기본 실행과 --from·--to를 알려요', () => {
  const sb = sandbox();
  try {
    const r = runCli(sb, ['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('오늘 일지와, 재료는 있는데 일지가 없는 지난 날짜,') && r.stdout.includes('그날이 끝나기 전에 만든 지난 일지를 모두 만들어요'), r.stdout);
    assert.match(r.stdout, /--from <날짜> +기간 안에서 재료가 있는 날짜를 모두 만들어요/);
    assert.match(r.stdout, /--to <날짜> +기간의 끝 날짜 \(기본: 오늘\)/);
    assert.ok(!r.stdout.includes('기본: today'), '예전 "기본: today"는 없어요');
    // I-11: 끝에 용어 묶음 아홉 줄(DESIGN 3장 "용어 풀이"), 모든 줄 80칸 안
    const L = lines(r.stdout.replace(/\n$/, ''));
    const g = L.indexOf('용어');
    assert.ok(g > 0 && L[g - 1] === '', '사용자 패턴 줄 다음 빈 줄 뒤예요');
    const items = L.slice(g + 1);
    assert.equal(items.length, 8, '용어 줄과 여덟 줄, 모두 아홉 줄이에요');
    items.forEach((l, i) => {
      const m = /^( {2}(\S+(?: \S+)?) +| {15})(\S.*)$/.exec(l);
      assert.ok(m, l);
      assert.equal(displayWidth(m[1]!), 15, `값은 같은 자리에서 시작해요: ${l}`);
      assert.equal(m[2] ?? '', ['가림', '', '보관본', '', '다시 가리기', '', '하루 경계', ''][i]);
    });
    assert.ok(L.slice(g).every((l) => displayWidth(l) <= 80), '용어 묶음은 80칸 안이에요');
  } finally {
    sb.cleanup();
  }
});

// ---- I-11 화면의 "보관본만 남음" 풀이 줄 ----

function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

test('I-11: 화면에 "보관본만 남음" 배지가 보일 때만 풀이 줄을 한 번 보여 줘요(S1 요약 아래, S2 알림 줄)', async () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    const [X, Y] = [ago(3), ago(2)];
    const fileX = session(sb, web, X, '원본을 지울 세션');
    session(sb, web, Y, '원본이 남은 세션');
    assert.equal(runCli(sb, ['--from', X, '--to', Y]).code, 0);
    let srv = await startServer({ dataDir: sb.dataDir, port: 0, hideIdentity: false });
    const count = (body: string) => body.split(ARCHIVE_ONLY_HELP).length - 1;
    try {
      assert.equal(count(await httpGet(srv.port, '/')), 0, '배지가 없으면 풀이 줄도 없어요');
    } finally {
      srv.server.closeAllConnections();
      await new Promise<void>((done) => srv.server.close(() => done()));
    }
    rmSync(fileX);
    assert.equal(runCli(sb, ['archive']).code, 0); // 마지막 실행 기준이라 보관을 한 번 더 해요
    srv = await startServer({ dataDir: sb.dataDir, port: 0, hideIdentity: false });
    try {
      const s1 = await httpGet(srv.port, '/');
      assert.match(s1, /보관본만 남음/);
      assert.equal(count(s1), 1, 'S1에 한 번');
      assert.ok(s1.indexOf(ARCHIVE_ONLY_HELP) < s1.indexOf('<table'), '요약 줄 아래, 날짜 목록 위예요');
      assert.equal(count(await httpGet(srv.port, `/day/${X}`)), 1, 'S2(보관본만 남은 날)에 한 번');
      assert.equal(count(await httpGet(srv.port, `/day/${Y}`)), 0, 'S2(보관됨)에는 없어요');
    } finally {
      srv.server.closeAllConnections();
      await new Promise<void>((done) => srv.server.close(() => done()));
    }
  } finally {
    sb.cleanup();
  }
});

// ---- I-07·I-08·I-11 README ----

test('I-07·I-08·I-11: README 한국어·영어 모두 맨 위 가까이 빠른 시작이 있고, 지금 되는 설치(소스 빌드 → npm link)가 npm 배포 뒤 설치보다 먼저이며, 용어 풀이가 있고, 드문 경우 설명은 명령 표 뒤 절로 모였어요', () => {
  const readme = readFileSync(join(APP_DIR, 'README.md'), 'utf8');
  const [ko, en] = readme.split(/^## English$/m) as [string, string];
  assert.ok(en, 'English 절이 있어요');
  const check = (part: string, h: { quick: string; install: string; commands: string; rare: string; glossary: string }, terms: string[]) => {
    const at = (title: string) => {
      const i = part.indexOf(`\n### ${title}\n`);
      assert.ok(i >= 0, `### ${title} 절이 있어요`);
      return i;
    };
    const quick = at(h.quick);
    assert.ok(quick < at(h.install) && at(h.install) < at(h.commands) && at(h.commands) < at(h.rare), '빠른 시작 → 설치 → 명령 → 드문 경우 순서예요');
    const quickBody = part.slice(quick, part.indexOf('\n### ', quick + 1));
    for (const cmd of ['npm link', 'cc-worklog view', 'roots']) assert.ok(quickBody.includes(cmd), `빠른 시작에 ${cmd}`);
    assert.ok(/\ncc-worklog\s/.test(quickBody), '빠른 시작에 cc-worklog 실행');
    const install = part.slice(at(h.install), at(h.commands));
    assert.ok(install.indexOf('npm link') >= 0 && install.indexOf('npm link') < install.indexOf('npm install -g cc-worklog'), '지금 되는 방법(npm link)이 먼저예요');
    assert.ok(install.includes('node dist/src/cli.js'), 'npm link 없이 쓰는 방법도 있어요');
    // 드문 경우(잠금 파일·따옴표 규칙·깨진 기록·읽지 못한 파일)는 명령 표 바로 뒤가 아니라 드문 경우 절에 있어요.
    const commands = part.slice(at(h.commands), part.indexOf('\n### ', at(h.commands) + 1));
    for (const w of ['UNC', 'BOM']) assert.ok(!commands.includes(w), `명령 절에 ${w} 설명이 없어요`);
    const glossary = part.slice(at(h.glossary), part.indexOf('\n### ', at(h.glossary) + 1));
    for (const t of terms) assert.ok(glossary.includes(t), `용어 ${t}`);
  };
  check(ko, { quick: '빠른 시작', install: '설치', commands: '명령', rare: '드문 경우', glossary: '용어' }, ['**가림**', '**보관본**', '**다시 가리기**', '**하루 경계**']);
  check(
    en,
    { quick: 'Quick start', install: 'Install', commands: 'Commands', rare: 'Edge cases', glossary: 'Terms' },
    ['**Redaction (`가림`)**', '**Archive (`보관본`)**', '**Re-redaction (`다시 가리기`)**', '**Day boundary (`하루 경계`)**'],
  );
  // 용어 절은 명령 표 다음, 드문 경우 설명보다 앞이에요(DESIGN 3장 "용어 풀이").
  assert.ok(ko.indexOf('\n### 명령\n') < ko.indexOf('\n### 용어\n') && ko.indexOf('\n### 용어\n') < ko.indexOf('\n### 드문 경우\n'));
  assert.ok(en.indexOf('\n### Commands\n') < en.indexOf('\n### Terms\n') && en.indexOf('\n### Terms\n') < en.indexOf('\n### Edge cases\n'));
  // 기본 실행 설명이 Q25와 같아요(예전 "기본 날짜는 오늘"은 없어요).
  assert.ok(!ko.includes('기본 날짜는 오늘') && !en.includes('(default: today)'));
});
