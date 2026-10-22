// 개선 취합 2회차 시험 (docs/DESIGN.md 5장 "개발·취합이 맞춰야 할 것"의 "시험", 취합이 코드에 옮긴 모양).
//  - I-10: S4 패턴 시험(머리 줄 끝 합계, 놓친 패턴은 줄마다, 잡힌 패턴은 이름 목록)과 보통 경우 판정 줄 자리(24번째 줄 안).
//  - I-01: S4 `이름·이메일 (일지만)` 켠·끈 일지 줄과 맨 끝 [알림]이 DESIGN S4 예시 글자 그대로.
//  - I-04·I-03: S3 두 [알림]의 날짜가 많을 때 80칸에서 날짜 사이로 끊기고, 기본 실행의 빈 상태 까닭.
//  - I-12: S1·S2 맨 위 기준 줄(빈 상태·오류 화면 포함, S2는 "← 날짜 목록" 위), S1의 예전 "보관 상태는 … 실행 기준이에요" 줄 없음.
//  - (개선 취합 4회차) I-32: --help 50줄 전체가 DESIGN 3장 "도움말 출력" 글자 그대로.
// 모든 시험은 임시 폴더의 가짜 세션 기록·임시 저장소로만 해요.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinSamples, negativeSamples } from '../src/redact/samples.js';
import { displayWidth } from '../src/term/format.js';
import { IDENTITY_TEXT, PATTERN_TEXT, renderCheckReport, type CheckReport } from '../src/term/s4-check.js';
import { dayKeyOf, localDateTime, shiftDate } from '../src/util/time.js';
import { BASIS_TEXT } from '../src/web/basis-line.js';
import { renderS1 } from '../src/web/s1-date-list.js';
import { renderS2 } from '../src/web/s2-day-log.js';
import { startServer } from '../src/web/server.js';
import { assistantText, initRepo, kst, readJson, runCli, sandbox, userText, writeSession, type Sandbox } from './helpers.js';

/** 색을 쓰지 않는 출력 대상 (TTY 아님) */
const PLAIN = { isTTY: false } as unknown as NodeJS.WriteStream;
const lines = (s: string) => s.replace(/\n$/, '').split('\n');
const TODAY = dayKeyOf(Date.now(), 3);
const ago = (n: number) => shiftDate(TODAY, -n);

/** DESIGN S4 "처음 쓰는 사람의 보통 경우" 예시와 같은 검사 보고 (기본 설정으로 만든 일지 31개, 끈 일지에 이름 8건·이메일 2건) */
function usualReport(over: Partial<CheckReport> = {}): CheckReport {
  return {
    dataDir: 'C:\\Users\\…\\.cc-worklog',
    builtin: builtinSamples().map((s) => ({ label: s.label, caught: true })),
    negatives: negativeSamples().map((n) => ({ what: n.what, intact: true })),
    user: [],
    scanned: { worklogs: 31, archives: 528 },
    markers: {
      worklog: { 'GitHub 토큰': 12, '이름=값 비밀 줄': 9, JWT: 3, 'AWS 액세스 키': 2 },
      archive: { 'GitHub 토큰': 40, '이름=값 비밀 줄': 31, JWT: 8 },
    },
    findings: [],
    identity: { counted: false, worklogs: 0, userNames: 0, emails: 0, findings: [] },
    identityOff: { worklogs: 31, userNames: 8, emails: 2 },
    passed: true,
    remake: { dayStartHour: 3 },
    ...over,
  };
}

/** DESIGN S4 보통 경우 예시 (왼쪽 줄 번호를 뺀 글 그대로) */
const USUAL = [
  'cc-worklog 가리기 검사',
  '검사한 폴더  C:\\Users\\…\\.cc-worklog',
  '',
  '1. 패턴 시험  내장 가짜 값 19개 — 잡힘 19 · 놓침 0',
  '   잡힘  개인 키 블록 · JWT · 접속 주소 비밀번호 · AWS 액세스 키 · AWS 비밀 키 ·',
  '         GitHub 토큰 · GitLab 토큰 · Anthropic API 키 · OpenAI API 키 ·',
  '         Google API 키 · Slack 웹훅 주소 · Slack 토큰 · Stripe 키 · npm 토큰 ·',
  '         Hugging Face 토큰 · Supabase 비밀 키 · Basic 인증 · Bearer 토큰 ·',
  '         이름=값 비밀 줄',
  '   가리면 안 되는 값 6종(커밋 해시·파일 경로 (Windows)·파일 경로 (macOS·Linux)·',
  '    세션 아이디·일반 문장·코드 조각)은 그대로 남았어요',
  '',
  '2. 결과물 재검사  일지 31개 · 보관본 528개',
  '   가린 자리 (일지)      GitHub 토큰 12 · 이름=값 비밀 줄 9 · JWT 3 ·',
  '                         AWS 액세스 키 2',
  '   가린 자리 (보관본)    GitHub 토큰 40 · 이름=값 비밀 줄 31 · JWT 8',
  '   남은 의심             0건',
  '   이름·이메일 (일지만)  끈 일지 31개 — 사용자 이름 8건 · 이메일 2건',
  '                         (보관본은 이 옵션을 쓰지 않아 세지 않아요)',
  '',
  '참고: 형식 없는 비밀(문장 속 비밀번호 등)과 문장 속 이름은 찾지 못할 수 있어요.',
  '',
  '[통과] 남은 의심 0건, 놓친 패턴 0개',
  '',
  '[알림] 이름·이메일 가리기를 끈 일지 31개에 사용자 이름 8건 · 이메일 2건이 남아',
  '       있어요. 판정은 비밀 값만 본 결과라 이 수는 넣지 않았어요. 공개할 날짜의',
  '       일지는 아래처럼 --hide-identity를 붙여 다시 만드세요.',
  '         cc-worklog --date <날짜> --hide-identity',
  '       만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요.',
];

test('I-10·I-01: 처음 쓰는 사람의 보통 경우 검사 출력이 DESIGN S4 예시와 글자까지 같고, 판정이 23번째 줄이에요', () => {
  const L = lines(renderCheckReport(usualReport(), PLAIN));
  assert.deepEqual(L, USUAL);
  assert.equal(L.indexOf('[통과] 남은 의심 0건, 놓친 패턴 0개') + 1, 23, '판정은 23번째 줄(첫 24줄 안)이에요');
  assert.ok(L.every((l) => displayWidth(l) <= 80), '모든 줄이 80칸 안이에요');
  assert.ok(!L.some((l) => /^ {3}잡힘 \d+ · 놓침 \d+$/.test(l)), '목록 아래 예전 "잡힘 a · 놓침 b" 줄은 없어요');
  assert.ok(!L.some((l) => /^ {3}잡힘 {2}\S+$/.test(l) && !l.includes('·')), '잡힌 패턴을 한 줄에 하나씩 늘어놓지 않아요');

  // 가린 자리 종류가 늘어 한 줄이 늘어도 판정은 24번째 줄이에요(DESIGN 예시 아래 설명).
  const more = usualReport({
    markers: {
      worklog: { 'GitHub 토큰': 12, '이름=값 비밀 줄': 9, JWT: 3, 'AWS 액세스 키': 2, 'Slack 토큰': 1, 'npm 토큰': 1, 'Stripe 키': 1, 'OpenAI API 키': 1 },
      archive: { 'GitHub 토큰': 40, '이름=값 비밀 줄': 31, JWT: 8 },
    },
  });
  const L2 = lines(renderCheckReport(more, PLAIN));
  assert.equal(L2.indexOf('[통과] 남은 의심 0건, 놓친 패턴 0개') + 1, 24);

  // 끈 일지에 남은 이름·이메일이 0건이면 18번 줄이 0건이고 24~29번 줄(빈 줄 + [알림])이 없어요.
  const zero = lines(renderCheckReport(usualReport({ identityOff: { worklogs: 31, userNames: 0, emails: 0 } }), PLAIN));
  assert.deepEqual(zero, [...USUAL.slice(0, 17), '   이름·이메일 (일지만)  끈 일지 31개 — 사용자 이름 0건 · 이메일 0건', ...USUAL.slice(18, 23)]);

  // --data-dir로 검사했으면 [알림]의 명령 줄만 바뀌어요(80칸을 넘어도 한 줄).
  const withDir = lines(renderCheckReport(usualReport({ remake: { dayStartHour: 3, dataDir: 'D:\\work logs\\cc-worklog' } }), PLAIN));
  assert.equal(withDir[27], '         cc-worklog --date <날짜> --hide-identity --data-dir "D:\\work logs\\cc-worklog"');
  assert.deepEqual([...withDir.slice(0, 27), ...withDir.slice(28)], [...USUAL.slice(0, 27), ...USUAL.slice(28)]);
});

test('I-10·I-01: 패턴을 놓치고 남은 의심도 있으면 놓친 패턴만 한 줄씩, 잡힌 패턴은 이름 목록이고, 끈 일지 [알림]은 마지막 다음: 아래 맨 끝이에요(DESIGN S4 예시)', () => {
  const r = usualReport({
    builtin: builtinSamples().map((s) => ({ label: s.label, caught: s.label !== 'Slack 토큰' })),
    user: [
      { name: '사내 토큰', samples: 2, caught: 2 },
      { name: '사내 계정 주소', samples: 0, caught: 0 },
    ],
    markers: {
      worklog: { 'GitHub 토큰': 12, '이름=값 비밀 줄': 9, JWT: 3, 'AWS 액세스 키': 2, '사내 토큰': 2 },
      archive: { 'GitHub 토큰': 40, '이름=값 비밀 줄': 31, JWT: 8 },
    },
    findings: [
      { file: 'worklogs/2026-10-19.md', line: 12, kind: 'GitHub 토큰' },
      { file: 'worklogs/2026-10-19.md', line: 48, kind: 'GitHub 토큰' },
      { file: 'archive/projects/…/3f2a….jsonl', line: 3, kind: '사내 토큰' },
    ],
    passed: false,
  });
  const L = lines(renderCheckReport(r, PLAIN));
  assert.deepEqual(L.slice(0, 16), [
    'cc-worklog 가리기 검사',
    '검사한 폴더  C:\\Users\\…\\.cc-worklog',
    '',
    '1. 패턴 시험  내장 가짜 값 19개 — 잡힘 18 · 놓침 1',
    '   놓침  Slack 토큰',
    '   잡힘  개인 키 블록 · JWT · 접속 주소 비밀번호 · AWS 액세스 키 · AWS 비밀 키 ·',
    '         GitHub 토큰 · GitLab 토큰 · Anthropic API 키 · OpenAI API 키 ·',
    '         Google API 키 · Slack 웹훅 주소 · Stripe 키 · npm 토큰 ·',
    '         Hugging Face 토큰 · Supabase 비밀 키 · Basic 인증 · Bearer 토큰 ·',
    '         이름=값 비밀 줄',
    '   가리면 안 되는 값 6종(커밋 해시·파일 경로 (Windows)·파일 경로 (macOS·Linux)·',
    '    세션 아이디·일반 문장·코드 조각)은 그대로 남았어요',
    '   사용자 패턴 2개',
    '   잡힘          사내 토큰 (시험 값 2/2)',
    '   시험 값 없음  사내 계정 주소',
    '',
  ]);
  // 판정부터 끝까지 (DESIGN 예시 그대로)
  const v = L.indexOf('[실패] 남은 의심 3건, 놓친 패턴 1개');
  assert.ok(v > 0, L.join('\n'));
  assert.deepEqual(L.slice(v), [
    '[실패] 남은 의심 3건, 놓친 패턴 1개',
    '다음: 필요하면 사용자 패턴을 더한 뒤 cc-worklog redact를 실행하고 다시',
    '      검사하세요.',
    '다음: 내장 규칙 문제예요. 도구를 새 버전으로 바꾼 뒤 다시 검사하세요.',
    ...USUAL.slice(23),
  ]);

  // 하나도 잡히지 않으면 잡힘 줄은 없고, 놓친 패턴이 내장 순서로 한 줄씩이에요.
  const none = lines(renderCheckReport(usualReport({ builtin: builtinSamples().map((s) => ({ label: s.label, caught: false })), passed: false }), PLAIN));
  const head = none.indexOf(`1. 패턴 시험  ${PATTERN_TEXT.head(19, 0, 19)}`);
  assert.ok(head > 0);
  assert.deepEqual(
    none.slice(head + 1, head + 20),
    builtinSamples().map((s) => `   놓침  ${s.label}`),
  );
  assert.ok(none[head + 20]!.startsWith('   가리면 안 되는 값'), '놓침 줄 다음은 바로 가리면 안 되는 값 줄이에요');
  assert.ok(!none.some((l) => l.startsWith(PATTERN_TEXT.caughtLead)));
});

test('I-01·I-10: 일지가 없으면 이름·이메일 칸은 "일지가 없어 세지 않았어요" 한 줄이고, 켠 일지·끈 일지가 함께면 켠 일지 줄이 먼저예요(DESIGN S4 5번)', () => {
  const noLogs = lines(renderCheckReport(usualReport({ scanned: { worklogs: 0, archives: 3 }, markers: { worklog: {}, archive: {} }, identityOff: { worklogs: 0, userNames: 0, emails: 0 } }), PLAIN));
  const i = noLogs.findIndex((l) => l.startsWith('   이름·이메일 (일지만)  '));
  assert.equal(noLogs[i], `   이름·이메일 (일지만)  ${IDENTITY_TEXT.noWorklogs}`);
  assert.equal(noLogs[i + 1], '', '괄호 줄은 없어요');
  assert.ok(!noLogs.join('\n').includes('옵션이 꺼져 있어 세지 않았어요'));

  // DESIGN S4 "켠 일지에 이름·이메일이 남은 경우" 예시의 아래쪽. 두 종류 모두 마크다운에 있어서 화면용 데이터 자리는
  // 수와 목록에 넣지 않아요(PRD A23, 개선 2회차 I-29: commands/check.ts가 수에 든 자리만 넘겨요).
  const mixed = usualReport({
    identity: {
      counted: true,
      worklogs: 1,
      userNames: 2,
      emails: 1,
      findings: [
        { file: 'worklogs/2026-10-17.md', line: 9, kind: '사용자 이름' },
        { file: 'worklogs/2026-10-17.md', line: 9, kind: '이메일' },
        { file: 'worklogs/2026-10-17.md', line: 14, kind: '사용자 이름' },
      ],
    },
    identityOff: { worklogs: 30, userNames: 0, emails: 0 },
    identityDays: [{ date: '2026-10-17', hideIdentity: true, dayStartHour: 3 }],
    passed: false,
  });
  const M = lines(renderCheckReport(mixed, PLAIN));
  const s = M.indexOf('   남은 의심             0건');
  assert.deepEqual(M.slice(s), [
    '   남은 의심             0건',
    '   이름·이메일 (일지만)  켠 일지 1개 — 사용자 이름 2건 · 이메일 1건',
    '                         끈 일지 30개 — 사용자 이름 0건 · 이메일 0건',
    '                         (보관본은 이 옵션을 쓰지 않아 세지 않아요)',
    '     worklogs/2026-10-17.md  줄 9, 14 (사용자 이름 모양, 이메일 모양)',
    '',
    '참고: 형식 없는 비밀(문장 속 비밀번호 등)과 문장 속 이름은 찾지 못할 수 있어요.',
    '',
    '[실패] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 3건',
    '다음: 아래 날짜의 일지에 사용자 이름·이메일이 남아 있어요. 그 날짜 일지를',
    '      이름·이메일 가리기를 켜고 다시 만든 뒤 다시 검사하세요.',
    '        cc-worklog --date 2026-10-17 --hide-identity',
    '      만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요.',
  ]);

  // DESIGN S4 "화면용 데이터에만 남은" 예시: 사용자 이름은 화면용 데이터에만 남아 그 종류 1건(.json 줄), 이메일은 마크다운 14번째 줄
  const jsonOnly = usualReport({
    identity: {
      counted: true,
      worklogs: 1,
      userNames: 1,
      emails: 1,
      findings: [
        { file: 'worklogs/2026-10-17.json', line: 0, kind: '사용자 이름' },
        { file: 'worklogs/2026-10-17.md', line: 14, kind: '이메일' },
      ],
    },
    identityOff: { worklogs: 30, userNames: 0, emails: 0 },
    identityDays: [{ date: '2026-10-17', hideIdentity: true, dayStartHour: 3 }],
    passed: false,
  });
  const J = lines(renderCheckReport(jsonOnly, PLAIN));
  const sj = J.indexOf('   남은 의심             0건');
  assert.deepEqual(J.slice(sj, sj + 10), [
    '   남은 의심             0건',
    '   이름·이메일 (일지만)  켠 일지 1개 — 사용자 이름 1건 · 이메일 1건',
    '                         끈 일지 30개 — 사용자 이름 0건 · 이메일 0건',
    '                         (보관본은 이 옵션을 쓰지 않아 세지 않아요)',
    '     worklogs/2026-10-17.json  줄 번호 없음 (사용자 이름 모양)',
    '     worklogs/2026-10-17.md    줄 14 (이메일 모양)',
    '',
    '참고: 형식 없는 비밀(문장 속 비밀번호 등)과 문장 속 이름은 찾지 못할 수 있어요.',
    '',
    '[실패] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 2건',
  ]);
});

test('I-10·I-01: 기본 설정으로 만든 일지를 실제로 검사하면 판정이 첫 24줄 안이고, 끈 일지의 [알림]이 출력 맨 끝이에요(종료 코드 0)', () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, 'dev.kim@example.test');
    const sid = '2b000000-0000-4000-8000-000000000001';
    writeSession(sb, web, sid, [
      userText({ sid, cwd: web, ts: kst(ago(1), '10:00') }, 'C:\\Users\\kimdev\\proj 에서 qa.lee@example.test 확인'),
      assistantText({ sid, cwd: web, ts: kst(ago(1), '10:05') }, '했어요'),
    ]);
    assert.equal(runCli(sb, []).code, 0);
    const c = runCli(sb, ['check']);
    assert.equal(c.code, 0, c.stdout);
    const L = lines(c.stdout);
    const v = L.indexOf('[통과] 남은 의심 0건, 놓친 패턴 0개');
    assert.ok(v >= 0 && v < 24, `판정이 첫 24줄 안이에요 (${v + 1}번째):\n${c.stdout}`);
    assert.equal(L[3], `1. 패턴 시험  ${PATTERN_TEXT.head(19, 19, 0)}`);
    assert.equal(L[4], USUAL[4]);
    assert.ok(L[v + 2]!.startsWith('[알림] 이름·이메일 가리기를 끈 일지 1개에 사용자 이름 '), c.stdout);
    assert.equal(L[L.length - 1], '       만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요.');
    assert.ok(L.slice(0, -2).every((l) => displayWidth(l) <= 80), '명령 줄 말고는 80칸 안이에요');
    assert.ok(!c.stdout.includes('kimdev') && !c.stdout.includes('qa.lee@example.test'), '값은 보여 주지 않아요');
  } finally {
    sb.cleanup();
  }
});

test('I-04·I-03: S3 두 [알림]의 날짜가 많으면 한 줄에 여섯 개씩 날짜 사이에서 끊기고(줄 끝 ","), 기본 실행에 재료가 없으면 "읽을 세션과 커밋이 없어요"예요', () => {
  const sb = sandbox();
  try {
    // 처음 쓰는데 세션·커밋이 없으면 (DESIGN S3 빈 상태 표 마지막 줄)
    const empty = runCli(sb, []);
    assert.equal(empty.code, 0, empty.stderr);
    assert.match(empty.stdout, /^결과 {8}만든 일지 없음 — 읽을 세션과 커밋이 없어요$/m);

    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, 'dev.kim@example.test');
    const dates = Array.from({ length: 14 }, (_, i) => ago(20 - i));
    dates.forEach((d, i) => {
      const sid = `2c000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      writeSession(sb, web, sid, [userText({ sid, cwd: web, ts: kst(d, '10:00') }, `${d} 작업`), assistantText({ sid, cwd: web, ts: kst(d, '10:05') }, '했어요')]);
    });
    const from = dates[0]!;
    const to = dates[dates.length - 1]!;
    assert.equal(runCli(sb, ['--from', from, '--to', to, '--hide-identity']).code, 0);
    // 짝수 번째 날짜 일곱 개는 마크다운에 메모를 더해요(손으로 고친 일지), 나머지 일곱 개는 켜고 만든 일지를 끈 채 다시 만들어요.
    const edited = dates.filter((_, i) => i % 2 === 0);
    const offDates = dates.filter((_, i) => i % 2 === 1);
    for (const d of edited) appendFileSync(join(sb.dataDir, 'worklogs', `${d}.md`), '\n내 메모\n');
    const r = runCli(sb, ['--from', from, '--to', to]);
    assert.equal(r.code, 0, r.stderr);
    const L = lines(r.stdout);
    const a = L.indexOf('[알림] 손으로 고친 일지 7개는 덮어쓰지 않고 그대로 뒀어요.');
    assert.ok(a > 0, r.stdout);
    assert.equal(L[a + 1], `       ${edited.slice(0, 6).join(', ')},`);
    assert.equal(L[a + 2], `       ${edited[6]}`);
    assert.equal(L[a + 3], '       메모를 다른 곳에 옮긴 뒤 그 .md 파일을 옮기거나 지우고 다시 실행하면');
    assert.equal(L[a + 4], '       새로 만들어져요.');
    assert.equal(L[a + 5], '[알림] 이름·이메일 가리기를 켜고 만들었던 일지 7개를 끈 채 다시 만들었어요.');
    assert.equal(L[a + 6], `       ${offDates.slice(0, 6).join(', ')},`);
    assert.equal(L[a + 7], `       ${offDates[6]}`);
    assert.equal(L[a + 8], '       공개용으로 되돌리려면 아래처럼 --hide-identity를 붙여 다시 만드세요.');
    assert.ok(L[a + 9]!.startsWith(`         cc-worklog --from ${from} --to ${to} --hide-identity`), L[a + 9]);
    assert.ok(L.slice(a, a + 9).every((l) => displayWidth(l) <= 80));
    assert.match(r.stdout, /^결과 {8}일지 7개 — 다시 만듦 7개$/m);
  } finally {
    sb.cleanup();
  }
});

// ---- I-12 S1·S2 기준 줄 ----

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const plainText = (html: string) => html.replace(/<[^>]+>/g, '');
/** 본문(main) 맨 앞의 기준 줄 글 (태그를 뺀 글). 맨 앞이 아니면 null */
function basisAtTop(body: string): string | null {
  const m = /<main class="content">\n(<p class="basis muted">.*?<\/p>)/.exec(body);
  return m ? plainText(m[1]!) : null;
}

test('I-12: S1·S2 맨 위 막대 바로 아래에 기준 줄이 늘 있어요(빈 상태·오류 화면 포함, S2는 "← 날짜 목록" 위), S1의 예전 "보관 상태는 … 실행 기준이에요" 줄은 없어요', async () => {
  const sb = sandbox();
  try {
    const unknown = BASIS_TEXT.unknown('cc-worklog');
    // 아직 실행한 적이 없으면(보관 색인 없음) 시각 없는 글이에요.
    let srv = await startServer({ dataDir: sb.dataDir, port: 0, hideIdentity: false });
    try {
      const s1 = await httpGet(srv.port, '/');
      assert.equal(basisAtTop(s1.body), unknown, s1.body);
      assert.match(s1.body, /아직 만든 일지가 없어요/);
      const s2 = await httpGet(srv.port, `/day/${TODAY}`);
      assert.equal(basisAtTop(s2.body), unknown);
      assert.ok(s2.body.indexOf('class="basis') < s2.body.indexOf('← 날짜 목록'));
    } finally {
      srv.server.closeAllConnections();
      await new Promise<void>((done) => srv.server.close(() => done()));
    }

    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, 'dev.kim@example.test');
    const sid = '2d000000-0000-4000-8000-000000000001';
    writeSession(sb, web, sid, [userText({ sid, cwd: web, ts: kst(ago(1), '10:00') }, '어제 작업'), assistantText({ sid, cwd: web, ts: kst(ago(1), '10:05') }, '했어요')]);
    assert.equal(runCli(sb, []).code, 0);
    const lastRunAt = readJson<{ lastRunAt: string }>(join(sb.dataDir, 'archive', 'index.json')).lastRunAt;
    const known = BASIS_TEXT.known(localDateTime(Date.parse(lastRunAt)).slice(5), 'cc-worklog');
    assert.match(known, /^화면은 마지막 실행\(\d{2}-\d{2} \d{2}:\d{2}\) 기준이에요\. 터미널에서 cc-worklog를 다시 실행한 뒤 새로 고침하면 바뀌어요\.$/);

    srv = await startServer({ dataDir: sb.dataDir, port: 0, hideIdentity: false });
    try {
      const s1 = await httpGet(srv.port, '/');
      assert.equal(basisAtTop(s1.body), known, s1.body);
      assert.ok(s1.body.indexOf('class="basis') < s1.body.indexOf('<section class="summary">'), '요약 줄보다 위예요');
      assert.ok(!s1.body.includes('보관 상태는'), 'S1의 예전 기준 시각 줄은 없어요');
      assert.equal(s1.body.split('class="basis').length - 1, 1, '한 번만');

      const day = await httpGet(srv.port, `/day/${ago(1)}`);
      assert.equal(day.status, 200);
      assert.equal(basisAtTop(day.body), known);
      assert.ok(day.body.indexOf('class="basis') < day.body.indexOf('← 날짜 목록'));

      // 그 날짜 일지가 없는 S2(빈 상태)
      const none = await httpGet(srv.port, `/day/${ago(5)}`);
      assert.match(none.body, /이 날짜의 일지가 없어요/);
      assert.equal(basisAtTop(none.body), known);

      // 그날 일지를 읽지 못한 S2(오류 화면)
      writeFileSync(join(sb.dataDir, 'worklogs', `${ago(1)}.json`), '{ 깨진');
      const broken = await httpGet(srv.port, `/day/${ago(1)}`);
      assert.match(broken.body, /일지를 읽지 못했어요/);
      assert.equal(basisAtTop(broken.body), known);
      assert.ok(broken.body.indexOf('class="basis') < broken.body.indexOf('← 날짜 목록'));
    } finally {
      srv.server.closeAllConnections();
      await new Promise<void>((done) => srv.server.close(() => done()));
    }
    assert.ok(readFileSync(join(sb.dataDir, 'worklogs', `${ago(1)}.md`), 'utf8').length > 0);
  } finally {
    sb.cleanup();
  }
});

test('I-12: S1 오류 화면(일지 폴더를 읽지 못함)과 화면용 명령이 다를 때도 기준 줄이 본문 맨 앞이고, 그 명령을 써요', () => {
  const base = { rows: [], dataDir: 'C:\\data', version: '0.1.0', makeCommand: 'cc-worklog', archiveCommand: 'cc-worklog archive' };
  const err = renderS1({ ...base, lastRunAt: '2026-10-19T13:10:00.000Z', error: 'unreadable' });
  assert.equal(basisAtTop(err), BASIS_TEXT.known(localDateTime(Date.parse('2026-10-19T13:10:00.000Z')).slice(5), 'cc-worklog'));
  assert.ok(err.indexOf('class="basis') < err.indexOf('banner--error'));
  // 시각을 읽을 수 없으면 시각 없는 글이에요.
  assert.equal(basisAtTop(renderS1({ ...base, lastRunAt: 'not-a-date' })), BASIS_TEXT.unknown('cc-worklog'));
  const s2 = renderS2({
    date: '2026-10-19',
    day: null,
    unreadable: true,
    status: null,
    sessionStatus: () => ({ state: 'archived', daysLeft: null }) as never,
    mdPath: 'C:\\data\\worklogs\\2026-10-19.md',
    prevDate: null,
    nextDate: null,
    dataDir: 'C:\\data',
    version: '0.1.0',
    archiveCommand: 'node cli.js archive',
    makeCommand: 'node cli.js',
    lastRunAt: null,
  });
  assert.equal(basisAtTop(s2), BASIS_TEXT.unknown('node cli.js'));
});

// ---- 개선 취합 4회차: I-32 --help 전체 ----

/** DESIGN 3장 "도움말 출력"의 50줄 글자 그대로 (`--port` 기본값 자리는 DEFAULT_PORT 4848) */
const HELP_DESIGN = `cc-worklog — Claude Code 세션과 git log로 비밀 값을 가린 날짜별 일지를 만들어요

사용법
  cc-worklog [make] [날짜 옵션] [옵션]    일지 만들기 (보관을 먼저 해요)
  cc-worklog archive [옵션]               보관만 하기
  cc-worklog check [옵션]                 가리기 검사
  cc-worklog redact [--yes] [옵션]        보관본 다시 가리기 (일지도 함께)
  cc-worklog view [--port 번호]           로컬 화면 열기 (이 컴퓨터에서만)

일지 만들기의 날짜 옵션 (날짜 모양: YYYY-MM-DD, today, yesterday)
  (없음)                 오늘 일지와, 재료는 있는데 일지가 없는 지난 날짜,
                         그날이 끝나기 전에 만든 지난 일지를 모두 만들어요
  --date <날짜>          그날 하나만 만들어요 (이미 있으면 다시 만들어요)
  --from <날짜>          기간 안에서 재료가 있는 날짜를 모두 만들어요
                         (이미 있어도 다시 만들어요)
  --to <날짜>            기간의 끝 날짜 (기본: 오늘). --from과 함께 써요
                         --date와 --from·--to는 함께 쓸 수 없어요
                         손으로 고친 일지 .md는 어느 방식으로도 덮어쓰지 않아요

옵션
  --root <폴더>          이 폴더 아래 저장소는 세션이 없던 날의 커밋도 넣어요
                         (여러 번 쓸 수 있어요)
  --day-start <시>       하루가 바뀌는 시각 0~23 (기본: 3, 새벽 3시)
  --hide-identity        일지에서 경로 속 사용자 이름과 이메일 주소도 가려요
                         (보관본에는 쓰지 않아요)
  --claude-dir <폴더>    Claude Code 폴더
                         (기본: CLAUDE_CONFIG_DIR 또는 ~/.claude)
  --data-dir <폴더>      cc-worklog 데이터 폴더
                         (기본: CC_WORKLOG_HOME 또는 ~/.cc-worklog)
  --port <번호>          view 명령의 포트 (기본: 4848)
  -y, --yes              redact 명령에서 확인을 묻지 않고 바로 다시 써요
                         (되돌릴 수 없어요)
  -h, --help             도움말
  -v, --version          버전

설정 파일   <데이터 폴더>/config.json
  예) { "roots": ["C:/work"], "dayStartHour": 3, "hideIdentity": false }
사용자 패턴 <데이터 폴더>/patterns.json
  예) [{ "name": "사내 토큰", "pattern": "CORP-[0-9]{8}",
         "samples": ["CORP-12345678"] }]

용어
  가림         비밀 값(API 키·토큰 등)을 [가림:종류] 표시로 바꾼 자리예요.
               원문은 일지·보관본·화면 어디에도 남기지 않아요
  보관본       Claude Code가 30일(기본) 뒤 지우는 세션 기록을, 비밀 값을 가려
               데이터 폴더에 옮겨 둔 사본이에요. 일지는 보관본으로 만들어요
  다시 가리기  나중에 더한 패턴으로 이미 만든 보관본과 일지를 다시 가려요
               (cc-worklog redact). 되돌릴 수 없어서 먼저 수를 보여 주고 물어요
  하루 경계    날짜가 바뀌는 시각이에요. 기본은 새벽 3시라 새벽 2시에 한 일은
               전날 일지에 들어가요. --day-start로 바꿔요
`;

test('I-32: --help·-h 출력 50줄 전체가 DESIGN 3장 "도움말 출력" 글자 그대로이고(표준 출력, 종료 코드 0, 표준 오류 없음), 가장 긴 줄은 79칸이에요', () => {
  const sb = sandbox();
  try {
    for (const flag of ['--help', '-h']) {
      const r = runCli(sb, [flag]);
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.deepEqual(lines(r.stdout), lines(HELP_DESIGN));
      assert.equal(Math.max(...lines(r.stdout).map(displayWidth)), 79);
    }
  } finally {
    sb.cleanup();
  }
});
