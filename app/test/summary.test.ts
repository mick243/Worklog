// AI 요약 한 줄 시험 (PRD 확정 2026-10-22의 A24~A28, Q26 (다)·Q27 (가)·Q28 (가)).
// 실제 claude는 부르지 않아요. helpers.ts가 모든 실행에 가짜 claude(test/fixtures/fake-claude.mjs)를 CC_WORKLOG_CLAUDE로 줘요.
// 가짜는 받은 인자·표준 입력·작업 폴더·시각을 호출마다 파일로 남겨서, 보내는 재료(A25)와 안전 옵션(A26), 실행 수·순서·동시 실행 수(A24)를 봐요.
// 모든 시험은 임시 폴더의 가짜 세션 기록·임시 저장소로만 해요(네트워크 차단 장치를 늘 켜요, runCli).
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { runMake } from '../src/commands/make.js';
import { resolveConfig } from '../src/config.js';
import { countMarkers } from '../src/redact/marker.js';
import { Redactor } from '../src/redact/redact.js';
import { fakeSecrets } from '../src/redact/samples.js';
import {
  CALL_LIMIT,
  CLAUDE_ARGS,
  claudeArgs,
  interpretOutput,
  resolveClaude,
  StopSignal,
  summaryWorkDir,
  SYSTEM_PROMPT,
  WORK_DIR_PROJECT,
} from '../src/summary/claude.js';
import { fitMaterial, MATERIAL_MAX, MATERIAL_TEXT, type MaterialItem } from '../src/summary/material.js';
import { orderCandidates, runSummaryCalls, tallyOutcomes, type Candidate, type SummaryRun } from '../src/summary/run.js';
import { sanitizeReceived } from '../src/summary/store.js';
import { displayWidth, painterFor } from '../src/term/format.js';
import { MAKE_TEXT, renderRunSummary, renderSummaryInterrupted, SUMMARY_TEXT, summaryCounts, type SummaryRunInfo } from '../src/term/s3-summary.js';
import type { ArchiveResult } from '../src/archive/archive.js';
import { renderCheckReport, SUMMARY_BROKEN, SUMMARY_CHECK_TEXT, UNREADABLE_NEXT, type CheckReport } from '../src/term/s4-check.js';
import { SUMMARY_MD } from '../src/worklog/markdown.js';
import { USAGE_NEXT, usageText } from '../src/term/usage.js';
import { dayKeyOf, shiftDate } from '../src/util/time.js';
import { readDay } from '../src/web/data.js';
import { renderS2 } from '../src/web/s2-day-log.js';
import { remakeCommand, remakeDayOf, rerunHideCommand } from '../src/worklog/mismatch.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  aiTitle,
  assistantText,
  assistantThinking,
  assistantToolUse,
  attachmentLine,
  clearFakeCalls,
  commitAt,
  customTitle,
  FAKE_CLAUDE,
  fakeCalls,
  fingerprint,
  initRepo,
  kst,
  readJson,
  rowText,
  runCli,
  sandbox,
  systemLine,
  toolResult,
  userText,
  writeSession,
  writeSubagent,
  type FakeCall,
  type Sandbox,
} from './helpers.js';

const ME = 'dev.park@example.test';
const TODAY = dayKeyOf(Date.now(), 3);
const ago = (n: number) => shiftDate(TODAY, -n);
const S = fakeSecrets();

let sidN = 0;
const nextSid = () => `5a000000-0000-4000-8000-${String(++sidN).padStart(12, '0')}`;

const files = (sb: Sandbox, date: string) => ({
  md: join(sb.dataDir, 'worklogs', `${date}.md`),
  json: join(sb.dataDir, 'worklogs', `${date}.json`),
  store: join(sb.dataDir, 'summaries', `${date}.json`),
});
const md = (sb: Sandbox, date: string) => readFileSync(files(sb, date).md, 'utf8');
const day = (sb: Sandbox, date: string) => readJson<DayLog>(files(sb, date).json);
const sessionsOf = (d: DayLog) => d.projects.flatMap((p) => p.sessions);
const oneSpace = (s: string) => s.replace(/\s+/g, ' ').trim();
/** 출력 전체를 한 줄로 이어(칸 맞춤 공백·줄바꿈을 하나로) 문장이 들어 있는지 볼 때 써요. */
const flat = (s: string) => oneSpace(s);
const titlesOf = (calls: FakeCall[]) => calls.map((c) => /^제목: (.*)$/m.exec(c.stdin)?.[1] ?? '');

/** 저장소가 아닌 작업 폴더에 date의 요청·답변 세션 하나 (제목 title). 세션 아이디를 돌려줘요. */
function chat(sb: Sandbox, date: string, title: string, at = '10:00', extra: string[] = []): string {
  const sid = nextSid();
  const cwd = join(sb.root, 'work');
  mkdirSync(cwd, { recursive: true });
  const A = { sid, cwd };
  const [h, m] = at.split(':').map(Number) as [number, number];
  const later = `${String(h).padStart(2, '0')}:${String(m + 5).padStart(2, '0')}`;
  writeSession(sb, cwd, sid, [
    customTitle(sid, title),
    userText({ ...A, ts: kst(date, at) }, `${title} 해 줘`),
    assistantText({ ...A, ts: kst(date, later) }, `${title} 했어요`),
    ...extra,
  ]);
  return sid;
}

function sessionFile(sb: Sandbox, sid: string): string {
  return join(sb.projectsDir, join(sb.root, 'work').replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
}

/** 프로세스가 끝났는지 */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('기다리던 상태가 오지 않았어요');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * 같은 프로세스에서 runMake를 부를 때 표준 출력·표준 오류에 쓴 글을 모아요(시험이 끝나면 되돌려요).
 * 이 도구는 글(string)로만 써요. 시험 실행기가 같은 표준 출력으로 보내는 자기 기록(바이트 덩어리)은 가로채지 않고 그대로 넘겨요.
 * 날짜를 가짜 세션 기록과 같은 시간대(Asia/Seoul)로 보게 TZ도 잠깐 바꿔요.
 */
async function captureRun(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Seoul';
  const grab = (into: string[], orig: typeof process.stdout.write, stream: NodeJS.WriteStream) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string') {
        into.push(chunk);
        return true;
      }
      return (orig as (...a: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = grab(out, ow, process.stdout);
  process.stderr.write = grab(err, ew, process.stderr);
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
}

/** 시험용 시각: i번째 세션의 시작 시각 (같은 날짜 안에서 i가 클수록 늦어요) */
const slot = (i: number) => `${String(8 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 9).padStart(2, '0')}`;

// ---- A24: 끄면 0회 ----

test('A24·Q27: 요약을 끄면(기본, config.json 포함) 어느 명령에서도 claude 실행 0회·네트워크 요청 0건이고, 일지 모양은 그대로예요. config.json의 summary는 일지 만들기에만 쓰여요', () => {
  const sb = sandbox();
  try {
    chat(sb, ago(1), '어제 일');
    chat(sb, TODAY, '오늘 일', '09:00');
    // 지난 실행이 남긴 요약 작업 폴더는 요약을 끈 일지 만들기도 지워요(PRD 5장 셋째 예외).
    const leftover = summaryWorkDir(sb.dataDir);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'left.txt'), 'x');
    // 요약 작업 폴더 이름의 세션 기록 폴더는 보관하지 않아요(A26 3의 안전장치).
    const workProject = join(sb.projectsDir, `C--tmp-${basename(leftover)}`);
    mkdirSync(workProject, { recursive: true });
    const wsid = nextSid();
    writeFileSync(
      join(workProject, `${wsid}.jsonl`),
      `${userText({ sid: wsid, cwd: leftover, ts: kst(TODAY, '09:30') }, 'SUMMARY-WORKDIR-ZQ0 요약 재료')}\n`,
    );

    const runs: string[][] = [[], ['--date', ago(1)], ['--from', ago(1)], ['archive'], ['check'], ['redact']];
    for (const args of runs) {
      const r = runCli(sb, args);
      assert.notEqual(r.code, 97, `네트워크 시도: ${args.join(' ')} ${r.stderr}`);
      assert.ok(r.code === 0 || args[0] === 'redact', `${args.join(' ')}: ${r.stderr}`);
      assert.deepEqual(fakeCalls(sb), [], `claude 실행 0회: ${args.join(' ')}`);
    }
    assert.ok(!existsSync(leftover), '남은 요약 작업 폴더를 지웠어요');
    assert.ok(!existsSync(join(sb.dataDir, 'summaries')), '요약 저장 파일은 요약을 켰을 때만 생겨요');
    assert.ok(!existsSync(join(sb.dataDir, 'archive', 'projects', basename(workProject))), '요약 작업 폴더의 세션 기록은 보관하지 않아요');
    for (const date of [ago(1), TODAY]) {
      assert.ok(!md(sb, date).includes('AI 요약'), '요약을 끈 일지에는 요약 줄이 없어요');
      assert.ok(!md(sb, date).includes('SUMMARY-WORKDIR-ZQ0'));
      const d = day(sb, date);
      assert.equal(d.summaryEnabled, undefined, '끈 일지의 화면용 데이터 모양은 그대로예요');
      for (const s of sessionsOf(d)) assert.ok(!('summary' in s) && !('summaryTarget' in s));
    }

    // config.json의 "summary": false도 꺼짐, true는 일지 만들기만 켜요(보관·검사·다시 가리기는 부르지 않아요).
    writeFileSync(join(sb.dataDir, 'config.json'), JSON.stringify({ summary: false }));
    assert.equal(runCli(sb, []).code, 0);
    assert.deepEqual(fakeCalls(sb), []);
    writeFileSync(join(sb.dataDir, 'config.json'), JSON.stringify({ summary: true }));
    for (const args of [['archive'], ['check'], ['redact']]) {
      const r = runCli(sb, args);
      assert.notEqual(r.code, 97);
      assert.deepEqual(fakeCalls(sb), [], `config.json의 summary는 ${args[0]}에서 쓰이지 않아요`);
    }
    const r = runCli(sb, ['--date', ago(1)]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fakeCalls(sb).length, 1, 'config.json의 "summary": true로 켜져요(Q27)');
    assert.ok(md(sb, ago(1)).includes('작업 내용(AI 요약): 어제 일 작업을 마무리했어요.'));
  } finally {
    sb.cleanup();
  }
});

test('A24·A22: --summary는 일지 만들기에서만 받고, 다른 명령에 주면 사용법 오류로 멈춰요(종료 코드 1, claude 0회)', () => {
  const sb = sandbox();
  try {
    for (const cmd of ['archive', 'check', 'redact', 'view']) {
      const r = runCli(sb, [cmd, '--summary']);
      assert.equal(r.code, 1, cmd);
      assert.deepEqual(r.stderr.trimEnd().split('\n'), [`[실패] ${usageText.summaryOnlyMake}`, `다음: ${USAGE_NEXT}`], cmd);
      assert.equal(r.stdout, '');
    }
    assert.equal(runCli(sb, ['make', '--summary', '--summary=yes']).code, 1, '값을 받지 않는 옵션이에요');
    assert.deepEqual(fakeCalls(sb), []);
  } finally {
    sb.cleanup();
  }
});

// ---- A25·A26: 보내는 재료와 안전 옵션 ----

test('A25·A26: --summary --date로 만들면 요약 대상 세션마다 가짜 요약이 AI 글 표시와 함께 들어가고, 가짜가 받은 것은 그 세션 그날의 가린 제목·요청·답변 글뿐이며 안전 옵션이 모두 있어요', () => {
  const sb = sandbox();
  try {
    const D = ago(2);
    const NEXT = ago(1);
    const repo = join(sb.root, 'repo');
    initRepo(sb, repo, ME);
    commitAt(sb, repo, 'COMMIT-MSG-ZQ1 로그인 수정', kst(D, '11:00'));
    const sid = nextSid();
    const A = { sid, cwd: repo };
    writeSession(sb, repo, sid, [
      customTitle(sid, '로그인 화면 고치기'),
      userText({ ...A, ts: kst(D, '10:00') }, `로그인 버튼 고쳐 줘 토큰은 ${S.githubToken} 이에요`),
      assistantToolUse({ ...A, ts: kst(D, '10:01') }, 'tu1', 'Bash', { command: 'TOOL-INPUT-ZQ2 ls' }),
      toolResult({ ...A, ts: kst(D, '10:02') }, 'tu1', 'TOOL-OUTPUT-ZQ3'),
      assistantThinking({ ...A, ts: kst(D, '10:03') }, 'THINKING-ZQ4'),
      assistantText({ ...A, ts: kst(D, '10:04') }, '버튼 핸들러를 고쳤어요 ANSWER-ZQ5'),
      attachmentLine({ ...A, ts: kst(D, '10:04') }, 'ATTACH-ZQ6'),
      systemLine({ ...A, ts: kst(D, '10:04') }, 'SYSTEM-ZQ7'),
      userText({ ...A, ts: kst(D, '10:10') }, '테스트도 돌려 줘 REQ2-ZQ8'),
      assistantText({ ...A, ts: kst(D, '10:12') }, '테스트 3개가 통과했어요 ANSWER2-ZQ9'),
      userText({ ...A, ts: kst(D, '10:20'), extra: { isSidechain: true } }, 'SIDECHAIN-ZQ11'),
      userText({ ...A, ts: kst(NEXT, '10:00') }, 'OTHER-DAY-ZQ10 다음 날 요청'),
    ]);
    writeSubagent(sb, repo, sid, 'a1', [
      userText({ ...A, ts: kst(D, '10:05'), extra: { isSidechain: true } }, 'SUBAGENT-ZQ12'),
      assistantText({ ...A, ts: kst(D, '10:06'), extra: { isSidechain: true } }, 'SUBAGENT-ANS-ZQ13'),
    ]);
    // 같은 날 다른 세션: ai-title 제목, 요청·답변 글이 있어요.
    const sid2 = nextSid();
    const B = { sid: sid2, cwd: repo };
    writeSession(sb, repo, sid2, [
      aiTitle(sid2, '문서 정리'),
      userText({ ...B, ts: kst(D, '15:00') }, 'README 다듬어 줘'),
      assistantText({ ...B, ts: kst(D, '15:05') }, '다듬었어요'),
    ]);
    // 요청·답변 글이 없는 세션(도구 결과와 도구 호출뿐)은 요약 대상이 아니에요.
    const sid3 = nextSid();
    const C = { sid: sid3, cwd: repo };
    writeSession(sb, repo, sid3, [assistantToolUse({ ...C, ts: kst(D, '16:00') }, 'tu9', 'Read', { file_path: 'a.ts' }), toolResult({ ...C, ts: kst(D, '16:01') }, 'tu9', 'x')]);

    const r = runCli(sb, ['--date', D, '--summary']);
    assert.equal(r.code, 0, r.stderr);
    const calls = fakeCalls(sb);
    assert.equal(calls.length, 2, '요약 대상 세션마다 한 번 (글이 없는 세션은 부르지 않아요)');

    for (const c of calls) {
      // 안전 옵션 (A26): 고정 옵션 그대로이고, 인자에 재료·경로·사용자 값이 없어요.
      assert.deepEqual(c.argv, [...CLAUDE_ARGS]);
      const at = (f: string) => c.argv[c.argv.indexOf(f) + 1];
      assert.ok(c.argv.includes('-p'));
      assert.ok(c.argv.includes('--no-session-persistence'), '세션 기록을 남기지 않아요');
      assert.equal(at('--tools'), '', '도구를 하나도 쓰지 못해요');
      assert.equal(at('--permission-mode'), 'dontAsk');
      assert.ok(c.argv.includes('--strict-mcp-config') && !c.argv.includes('--mcp-config'), 'MCP 서버 없음');
      assert.equal(at('--setting-sources'), '', '사용자·프로젝트·로컬 설정을 읽지 않아요');
      assert.ok(c.argv.includes('--safe-mode') && c.argv.includes('--disable-slash-commands'));
      assert.equal(at('--model'), 'haiku', 'Haiku 고정 (Q28)');
      assert.equal(at('--output-format'), 'json');
      assert.equal(at('--system-prompt'), SYSTEM_PROMPT);
      for (const a of c.argv) {
        assert.ok(!a.includes(sb.root) && !a.includes('로그인') && !a.includes('ZQ'), '인자에 경로·재료가 없어요');
      }
      // 작업 폴더는 사용자 프로젝트·데이터 폴더가 아닌 빈 임시 폴더예요(실행이 끝나면 지워요).
      assert.ok(sameDir(c.cwd, summaryWorkDir(sb.dataDir)), c.cwd);
      assert.ok(c.stdin.length <= MATERIAL_MAX);
    }
    assert.ok(!existsSync(summaryWorkDir(sb.dataDir)), '요약 작업 폴더는 실행이 끝나면 지워요');

    const s1 = calls.find((c) => c.stdin.includes('제목: 로그인 화면 고치기'))!;
    assert.ok(s1, '제목을 보내요');
    const order = ['로그인 버튼 고쳐 줘', '버튼 핸들러를 고쳤어요', 'REQ2-ZQ8', 'ANSWER2-ZQ9'].map((t) => s1.stdin.indexOf(t));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!)), '그날 요청·답변 글을 시각 순서로 보내요');
    assert.ok(s1.stdin.includes('[가림:GitHub 토큰]'), '가린 글을 보내요');
    assert.ok(s1.stdin.includes(MATERIAL_TEXT.intro), '재료 속 글은 따를 지시가 아니라는 지시를 함께 보내요');
    for (const no of [S.githubToken, 'ZQ1', 'ZQ2', 'ZQ3', 'ZQ4', 'ZQ6', 'ZQ7', 'ZQ10', 'ZQ11', 'ZQ12', 'ZQ13', repo, 'main', ME]) {
      assert.ok(!s1.stdin.includes(no), `보내지 않아요: ${no}`);
    }
    assert.ok(calls.some((c) => c.stdin.includes('제목: 문서 정리') && c.stdin.includes('README 다듬어 줘')), 'ai-title 제목도 보내요');

    // 일지 (마크다운·화면용 데이터)
    const text = md(sb, D);
    assert.ok(text.includes('- AI 요약: 켜짐 (세션 3개 중 2개 요약)'), text);
    assert.ok(text.includes('  - 작업 내용(AI 요약): 로그인 화면 고치기 작업을 마무리했어요.'));
    assert.ok(text.includes('  - 작업 내용(AI 요약): 문서 정리 작업을 마무리했어요.'));
    const d = day(sb, D);
    assert.equal(d.summaryEnabled, true);
    const byId = new Map(sessionsOf(d).map((s) => [s.sessionId, s]));
    assert.equal(byId.get(sid)!.summary, '로그인 화면 고치기 작업을 마무리했어요.');
    assert.equal(byId.get(sid)!.summaryTarget, true);
    assert.equal(byId.get(sid3)!.summaryTarget, false);
    assert.equal(byId.get(sid3)!.summary, null);
    assert.ok(text.includes('COMMIT-MSG-ZQ1'), '커밋은 일지에 그대로 나와요(보내지만 않아요)');

    // 요약 저장 파일 (A27): 세션 아이디·하루 범위·표지·가린 요약·만든 시각만, 재료는 없어요.
    const storeRaw = readFileSync(files(sb, D).store, 'utf8');
    const store = JSON.parse(storeRaw) as { sessions: Array<Record<string, unknown>> };
    assert.equal(store.sessions.length, 2);
    for (const e of store.sessions) {
      assert.deepEqual(Object.keys(e).sort(), ['createdAt', 'mark', 'range', 'sessionId', 'summary']);
      assert.deepEqual(e.range, d.range);
      assert.deepEqual(Object.keys(e.mark as object).sort(), ['assistantLines', 'lastLineAt', 'userLines']);
    }
    for (const no of ['ZQ5', 'ZQ8', 'ZQ9', '버튼 핸들러', S.githubToken]) assert.ok(!storeRaw.includes(no), `요약 저장 파일에 재료 없음: ${no}`);

    // S3: 요약 칸과 보냈다는 한 줄
    assert.equal(rowText(r.stdout, 'AI 요약'), 'AI 요약 켜짐 — 요약한 세션 2개 (새로 부름 2개)', r.stdout);
    assert.equal(rowText(r.stdout, '보냄'), `보냄 ${SUMMARY_TEXT.sent} ${SUMMARY_TEXT.sentNote(2)}`);
    assert.ok(!r.stdout.includes('못 한 세션'));
    // 칸 순서: 이름·이메일 → AI 요약 → 보냄 → 기록 형식 (DESIGN S3 가·나 6-1·6-2)
    const at = (label: string) => r.stdout.split('\n').findIndex((l) => l.startsWith(label));
    assert.ok(at('이름·이메일') < at('AI 요약') && at('AI 요약') < at('보냄') && at('보냄') < at('기록 형식'));
  } finally {
    sb.cleanup();
  }
});

test('A27: 그날 새 줄이 없으면 다시 실행해도 claude를 부르지 않고 같은 요약이 들어가고, 줄이 는 세션만 다시 불러요. 하루 경계를 바꾸면 다시 불러요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    const a = chat(sb, D, '첫째 일');
    chat(sb, D, '둘째 일', '13:00');
    assert.equal(runCli(sb, ['--date', D, '--summary']).code, 0);
    assert.equal(fakeCalls(sb).length, 2);
    const first = md(sb, D);

    clearFakeCalls(sb);
    const again = runCli(sb, ['--date', D, '--summary']);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(fakeCalls(sb), [], '그날 줄이 늘지 않았으면 부르지 않아요');
    assert.equal(md(sb, D), first, '같은 요약이 들어가요');
    assert.equal(rowText(again.stdout, 'AI 요약'), 'AI 요약 켜짐 — 요약한 세션 2개 (저장해 둔 요약 2개)');
    assert.ok(!again.stdout.split('\n').some((l) => l.startsWith('보냄')), '보낸 세션이 없으면 보냄 칸이 없어요');

    // 첫째 세션에만 그날 줄이 늘어요.
    const cwd = join(sb.root, 'work');
    appendFileSync(sessionFile(sb, a), `${userText({ sid: a, cwd, ts: kst(D, '18:00') }, '하나 더 고쳐 줘 MORE-ZQ')}\n${assistantText({ sid: a, cwd, ts: kst(D, '18:05') }, '더 고쳤어요')}\n`);
    clearFakeCalls(sb);
    const more = runCli(sb, ['--date', D, '--summary'], { FAKE_CLAUDE_TEXT: '{title} 다시 요약했어요.' });
    assert.equal(more.code, 0, more.stderr);
    const calls = fakeCalls(sb);
    assert.equal(calls.length, 1, '줄이 는 세션만 다시 불러요');
    assert.ok(calls[0]!.stdin.includes('MORE-ZQ'));
    assert.ok(md(sb, D).includes('작업 내용(AI 요약): 첫째 일 다시 요약했어요.'));
    assert.ok(md(sb, D).includes('작업 내용(AI 요약): 둘째 일 작업을 마무리했어요.'));
    assert.equal(rowText(more.stdout, 'AI 요약'), 'AI 요약 켜짐 — 요약한 세션 2개 (새로 부름 1개 · 저장해 둔 요약 1개)');

    // 깨진 요약 저장 파일은 저장한 요약이 없는 것으로 보고 다시 불러요. S3 [알림]에 절대 경로와 (깨진 파일), 정해진 두 줄이에요(A27).
    writeFileSync(files(sb, D).store, '{ 깨진');
    clearFakeCalls(sb);
    const broken = runCli(sb, ['--date', D, '--summary']);
    assert.equal(broken.code, 0, broken.stderr);
    assert.equal(fakeCalls(sb).length, 2);
    const L = broken.stdout.split('\n');
    const i = L.indexOf(`[알림] ${SUMMARY_TEXT.storeHead(1)}`);
    assert.ok(i >= 0, broken.stdout);
    assert.deepEqual(L.slice(i + 1, i + 4), [`       ${files(sb, D).store} (깨진 파일)`, ...SUMMARY_TEXT.storeTodo.map((t) => `       ${t}`)]);
    assert.equal(readJson<{ sessions: unknown[] }>(files(sb, D).store).sessions.length, 2, '다시 받은 요약으로 새로 써요');

    // 하루 경계를 바꾸면 하루 범위가 달라져 다시 불러요.
    clearFakeCalls(sb);
    assert.equal(runCli(sb, ['--date', D, '--summary', '--day-start', '4']).code, 0);
    assert.equal(fakeCalls(sb).length, 2);
  } finally {
    sb.cleanup();
  }
});

// ---- A27·F2: 받은 요약 가리기 ----

test('A27·F2: 가짜가 비밀 값·이메일·경로 속 사용자 이름·가림 표시 모양 글자가 든 요약을 돌려주면 일지·요약 저장 파일에 원문이 없고 검사가 통과하며, 화면은 글자 그대로 보여 주고 --hide-identity 일지는 이름·이메일도 가려요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    chat(sb, D, '배포 준비');
    const EMAIL = 'qa.choi@example.test';
    const reply = `토큰 ${S.githubToken} 과 키 ${S.awsAccessKey} 를 바꾸고 ${EMAIL} 에게 알렸어요. C:\\Users\\choidev\\proj 에서 [가림:토큰] 표시를 봤어요.`;
    const r = runCli(sb, ['--date', D, '--summary'], { FAKE_CLAUDE_TEXT: reply });
    assert.equal(r.code, 0, r.stderr);
    for (const f of [files(sb, D).md, files(sb, D).json, files(sb, D).store]) {
      const t = readFileSync(f, 'utf8');
      assert.ok(!t.includes(S.githubToken) && !t.includes(S.awsAccessKey), `원문 없음: ${f}`);
    }
    const text = md(sb, D);
    const line = text.split('\n').find((l) => l.includes('작업 내용(AI 요약)'))!;
    assert.ok(line.includes('[가림:GitHub 토큰]') && line.includes('[가림:AWS 액세스 키]'), line);
    assert.ok(line.includes('［가림:토큰]'), '가림 표시 모양 글자는 바꿔 남겨요');
    assert.ok(line.includes(EMAIL) && line.includes('choidev'), '이름·이메일 가리기를 끈 일지는 그대로예요');
    assert.equal(countMarkers(text)['토큰'], undefined, '가림 표시 모양 글자는 도구가 가린 자리로 세지 않아요');
    // S3 가림 칸에 요약 줄의 자리도 들어가요.
    assert.ok(rowText(r.stdout, '가림').includes('GitHub 토큰'), r.stdout);
    assert.equal(day(sb, D).redactions['GitHub 토큰'], 1);

    // 검사: 통과하고, 끈 일지의 남은 이메일에 요약 줄의 자리도 들어가요(A19·A23).
    const c = runCli(sb, ['check']);
    assert.equal(c.code, 0, c.stdout);
    assert.ok(c.stdout.includes('[통과]'));
    assert.ok(rowText(c.stdout, '이름·이메일').includes('이메일 1건'), c.stdout);
    assert.ok(c.stdout.includes('요약 저장 파일 1개'), 'S4가 요약 저장 파일도 훑어요');
    // 참고: 첫 줄 그대로 + 다음 줄(6칸)에 AI 요약 한 줄 (DESIGN S4 7번)
    const CL = c.stdout.split('\n');
    const ref = CL.findIndex((l) => l.startsWith('참고: '));
    assert.equal(CL[ref], '참고: 형식 없는 비밀(문장 속 비밀번호 등)과 문장 속 이름은 찾지 못할 수 있어요.');
    assert.equal(CL[ref + 1], `      ${SUMMARY_CHECK_TEXT.mayMiss}`);
    // 요약 저장 파일은 남은 의심에만 들고 가린 자리 칸을 따로 두지 않아요(DESIGN S4 5번).
    assert.ok(!c.stdout.includes('가린 자리 (요약'));
    // 끈 일지 [알림]: 요약을 켜고 만든 끈 일지가 있으면 명령 줄 아래(7칸)에 --summary 한 줄 (DESIGN S4 12번)
    const cmdAt = CL.findIndex((l) => l.startsWith('         cc-worklog --date <날짜> --hide-identity'));
    assert.equal(CL[cmdAt + 1], `       ${SUMMARY_CHECK_TEXT.offSummary}`, c.stdout);
    assert.equal(CL[cmdAt + 2], '       만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요.');

    // 화면(S2)은 요약을 부르지 않고 저장된 글만 글자 그대로 보여 줘요. 가린 자리는 칩, 바꿔 남긴 모양 글자는 칩이 아니에요.
    const html = renderS2({
      date: D,
      day: readDay(sb.dataDir, D),
      status: null,
      sessionStatus: () => ({ state: 'archived' }) as never,
      mdPath: files(sb, D).md,
      prevDate: null,
      nextDate: null,
      dataDir: sb.dataDir,
      version: 'test',
      archiveCommand: 'cc-worklog archive',
    });
    assert.ok(html.includes('<p class="session__summary"><span class="label muted">작업 내용</span> <span class="ai-mark">AI 요약</span> '), html);
    assert.ok(html.includes('작업 내용(AI 요약)은 가린 대화 글을 Claude Code로 보내 AI가 쓴 한 줄이라 틀릴 수 있어요. 이 날 세션 1개 중 1개에 있어요.'));
    assert.ok(!html.includes('cc-worklog --summary</code>'), '빈 세션이 없으면 명령 안내가 없어요');
    assert.ok(html.indexOf('session__summary') < html.indexOf('session__req'), '작업 내용 줄은 요청 줄 위예요');
    assert.ok(html.includes('<span class="redacted" title="가린 자리">[가림:GitHub 토큰]</span>'));
    assert.ok(html.includes('［가림:토큰]') && !html.includes('<span class="redacted" title="가린 자리">［'));
    assert.ok(!/<script/i.test(html));

    // --hide-identity로 다시 만들면 요약 줄의 이메일·사용자 이름도 가려요. 저장해 둔 요약을 다시 써서 부르지 않아요.
    clearFakeCalls(sb);
    assert.equal(runCli(sb, ['--date', D, '--summary', '--hide-identity'], { FAKE_CLAUDE_TEXT: reply }).code, 0);
    assert.deepEqual(fakeCalls(sb), []);
    const hidden = md(sb, D).split('\n').find((l) => l.includes('작업 내용(AI 요약)'))!;
    assert.ok(!hidden.includes(EMAIL) && !hidden.includes('choidev') && hidden.includes('[가림:이메일]'), hidden);
    assert.ok(readFileSync(files(sb, D).store, 'utf8').includes(EMAIL), '요약 저장 파일은 이름·이메일 가리기를 쓰지 않아요(보관본과 같아요)');
    const c2 = runCli(sb, ['check']);
    assert.equal(c2.code, 0, c2.stdout);
    assert.ok(rowText(c2.stdout, '이름·이메일').includes('켠 일지 1개 — 사용자 이름 0건 · 이메일 0건'), c2.stdout);
  } finally {
    sb.cleanup();
  }
});

test('A27·A16: 요약 저장 파일에 든 값에 맞는 사용자 패턴을 더하고 다시 가리기를 하면 확인 출력에 요약 저장 파일이 나오고, 요약 저장 파일과 일지 요약 줄에서 값이 사라지며 검사가 통과해요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    chat(sb, D, '사내 연동');
    assert.equal(runCli(sb, ['--date', D, '--summary'], { FAKE_CLAUDE_TEXT: '사내 토큰 CORP-12345678 을 정리했어요' }).code, 0);
    writeFileSync(join(sb.dataDir, 'patterns.json'), JSON.stringify([{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}' }]));

    const c = runCli(sb, ['check']);
    assert.equal(c.code, 1);
    assert.ok(c.stdout.includes(`summaries/${D}.json`) && c.stdout.includes(`worklogs/${D}.md`), c.stdout);

    const before = fingerprint(files(sb, D).store);
    const plan = runCli(sb, ['redact']);
    assert.equal(plan.code, 1, '확인을 물을 수 없어 다시 쓰지 않아요');
    assert.ok(plan.stdout.includes('바뀔 요약') && plan.stdout.includes(`summaries/${D}.json`), plan.stdout);
    assert.ok(rowText(plan.stdout, '읽음').includes('요약 저장 파일 1개'));
    assert.ok(rowText(plan.stdout, '바뀔 자리').includes('요약 1'), plan.stdout);
    assert.deepEqual(fingerprint(files(sb, D).store), before, '확인 전에는 바뀌지 않아요');

    assert.ok(plan.stdout.includes('바뀔 요약   1개 (요약 저장 파일, 날짜마다 하나)'), plan.stdout);
    const yes = runCli(sb, ['redact', '--yes']);
    assert.equal(yes.code, 0, yes.stderr);
    assert.equal(rowText(yes.stdout, '다시 씀'), '다시 씀 보관본 0개 · 일지 1개 · 요약 저장 파일 1개', yes.stdout);
    assert.ok(rowText(yes.stdout, '새로 가림').endsWith('· 요약 1)'), yes.stdout);
    assert.ok(yes.stdout.includes(`            요약 저장 폴더\n              ${join(sb.dataDir, 'summaries')}`), yes.stdout);
    for (const f of Object.values(files(sb, D))) assert.ok(!readFileSync(f, 'utf8').includes('CORP-12345678'), f);
    assert.ok(md(sb, D).includes('작업 내용(AI 요약): 사내 토큰 [가림:사내 토큰] 을 정리했어요'));
    const store = readJson<{ sessions: Array<{ mark: unknown; range: unknown; sessionId: string }> }>(files(sb, D).store);
    assert.equal(store.sessions.length, 1);
    assert.equal(runCli(sb, ['check']).code, 0);
    // 다시 가린 뒤에도 표지·범위가 그대로라 다시 부르지 않아요(A27).
    clearFakeCalls(sb);
    assert.equal(runCli(sb, ['--date', D, '--summary']).code, 0);
    assert.deepEqual(fakeCalls(sb), []);
    assert.ok(runCli(sb, ['redact']).stdout.includes('0개 — 이미 지금 규칙으로 가려져 있어요'));
  } finally {
    sb.cleanup();
  }
});

// ---- A28: 실패 ----

test('A28: claude를 찾지 못하면 일지는 요약 줄 없이 만들어지고 종료 코드는 그대로이며 S3에 까닭과 할 일이 나오고, 다음에 요약을 켜면 이어서 채워요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    chat(sb, D, '하나');
    chat(sb, D, '둘', '14:00');
    const r = runCli(sb, ['--date', D, '--summary'], { CC_WORKLOG_CLAUDE: join(sb.root, 'no-such-claude.exe') });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fakeCalls(sb), []);
    const text = md(sb, D);
    assert.ok(text.includes('- AI 요약: 켜짐 (세션 2개 중 0개 요약)'));
    assert.ok(!text.includes('작업 내용(AI 요약)'), '요약하지 못한 세션은 요약 줄을 비워 둬요');
    for (const s of sessionsOf(day(sb, D))) assert.ok(s.summaryTarget === true && s.summary === null);
    assert.ok(
      rowText(r.stdout, 'AI 요약').endsWith(
        '켜짐 — 요약한 세션 0개 (못 한 세션 2개 — claude를 찾지 못함 2개) 요약이 빈 세션 2개(일지 1개)가 남았어요. 다음에 요약을 켜고 실행하면 최근 날짜부터 이어서 채워요.',
      ),
      r.stdout,
    );
    assert.ok(!r.stdout.split('\n').some((l) => l.startsWith('보냄')), '찾지 못함이면 보낸 세션이 없어요');
    assert.ok(flat(r.stdout).includes(oneSpace(SUMMARY_TEXT.todo['not-found'](2))));
    assert.ok(!flat(r.stdout).includes('Anthropic에 보냈어요'));
    assert.ok(!existsSync(files(sb, D).store), '실패한 세션은 요약 저장 파일에 없어요');

    const next = runCli(sb, ['--date', D, '--summary']);
    assert.equal(next.code, 0);
    assert.equal(fakeCalls(sb).length, 2, '다음에 요약을 켜면 다시 불러요');
    assert.ok(md(sb, D).includes('세션 2개 중 2개 요약'));

    // 요약 대상 세션이 하나도 없으면 `켜짐 — 요약할 세션이 없었어요` 한 줄이에요(DESIGN S3 가·나 6-1).
    const E = ago(3);
    const sid = nextSid();
    const cwd = join(sb.root, 'work');
    writeSession(sb, cwd, sid, [assistantToolUse({ sid, cwd, ts: kst(E, '10:00') }, 'tu1', 'Read', { file_path: 'a.ts' })]);
    clearFakeCalls(sb);
    const none = runCli(sb, ['--date', E, '--summary']);
    assert.equal(none.code, 0, none.stderr);
    assert.deepEqual(fakeCalls(sb), []);
    assert.equal(rowText(none.stdout, 'AI 요약'), 'AI 요약 켜짐 — 요약할 세션이 없었어요');
    assert.ok(md(sb, E).includes('- AI 요약: 켜짐 (세션 1개 중 0개 요약)'));
  } finally {
    sb.cleanup();
  }
});

test('A28: 로그인 안 됨·사용량 제한은 처음 한 번 확인되면 남은 세션을 부르지 않고, 시간 초과·그 밖은 계속 불러요. 종료 코드는 그대로이고 출력·오류 원문은 보여 주지 않아요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    for (let i = 0; i < 4; i++) chat(sb, D, `세션${i}`, `1${i}:00`);
    const cases: Array<{ env: NodeJS.ProcessEnv; reason: string; maxCalls: number; minCalls: number }> = [
      { env: { FAKE_CLAUDE_MODE: 'auth' }, reason: '로그인 안 됨 4개', minCalls: 1, maxCalls: 2 },
      { env: { FAKE_CLAUDE_MODE: 'rate' }, reason: '사용량 제한 4개', minCalls: 1, maxCalls: 2 },
      { env: { FAKE_CLAUDE_MODE: 'rate429' }, reason: '사용량 제한 4개', minCalls: 1, maxCalls: 2 },
      { env: { FAKE_CLAUDE_MODE: 'timeout', CC_WORKLOG_CLAUDE_TIMEOUT_MS: '600' }, reason: '시간 초과 4개', minCalls: 4, maxCalls: 4 },
      {
        env: { FAKE_CLAUDE_MODE_MAP: JSON.stringify({ 세션0: 'garbage', 세션1: 'exit1', 세션2: 'empty', 세션3: 'error-json' }) },
        reason: '그 밖의 실패 4개',
        minCalls: 4,
        maxCalls: 4,
      },
    ];
    for (const k of cases) {
      clearFakeCalls(sb);
      rmSync(join(sb.dataDir, 'summaries'), { recursive: true, force: true });
      const t0 = Date.now();
      const r = runCli(sb, ['--date', D, '--summary'], k.env);
      assert.equal(r.code, 0, `${k.reason}: ${r.stderr}`);
      const calls = fakeCalls(sb);
      assert.ok(calls.length >= k.minCalls && calls.length <= k.maxCalls, `${k.reason}: 실행 ${calls.length}번`);
      assert.ok(rowText(r.stdout, 'AI 요약').includes(`(못 한 세션 4개 — ${k.reason})`), `${k.reason}\n${r.stdout}`);
      const why = { '로그인 안 됨': 'auth', '사용량 제한': 'rate-limit', '시간 초과': 'timeout', '그 밖의 실패': 'other' } as const;
      const reason = why[k.reason.replace(/ 4개$/, '') as keyof typeof why];
      assert.ok(flat(r.stdout).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo[reason](4)}`)), r.stdout);
      // 보낸 세션: 로컬 로그인 안 됨(가짜 auth = "Not logged in", 보내기 전에 멈춤)이면 없고, 그 밖에는 실행한 세션만큼이에요(PRD A28, 취합 20회차 차이 3).
      const sentRow = rowText(r.stdout, '보냄');
      if (reason === 'auth') assert.equal(sentRow, '');
      else assert.ok(sentRow.includes(`(세션 ${calls.length}개,`), sentRow);
      assert.ok(!/FAKE-RAW/.test(r.stdout + r.stderr), '출력·오류 원문은 보여 주지 않아요');
      assert.ok(!md(sb, D).includes('작업 내용(AI 요약)'));
      assert.ok(md(sb, D).includes('세션 4개 중 0개 요약'));
      if (k.env.FAKE_CLAUDE_MODE === 'timeout') {
        assert.ok(Date.now() - t0 < 20_000, '60초 대신 시험용 0.6초로 끝내요');
        await_gone(calls);
      }
    }
  } finally {
    sb.cleanup();
  }
});

test('A28 (차이 3): 보낸 세션은 실행한 세션 중 보내기 전에 멈춘 것이 확실한 세션만 빼요 — 로컬 로그인 안 됨은 보냄 없음, 서버가 거절한 401·403과 가릴 수 없는 로그인 글은 로그인 안 됨으로 세되 보냄에 들어요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    for (let i = 0; i < 3; i++) chat(sb, D, `인증${i}`, `1${i}:00`);
    const cases = [
      { mode: 'auth', sent: false, why: '로컬 로그인 안 됨(보내기 전에 멈춤)' },
      { mode: 'auth401', sent: true, why: '서버가 401로 거절' },
      { mode: 'auth403', sent: true, why: '서버가 403으로 거절' },
      { mode: 'auth-text', sent: true, why: '로그인 글뿐이라 가릴 수 없음' },
    ];
    for (const k of cases) {
      clearFakeCalls(sb);
      const r = runCli(sb, ['--date', D, '--summary'], { FAKE_CLAUDE_MODE: k.mode });
      assert.equal(r.code, 0, `${k.why}: ${r.stderr}`);
      const calls = fakeCalls(sb);
      assert.ok(calls.length >= 1 && calls.length <= 2, `${k.why}: 처음 확인되면 남은 세션은 부르지 않아요 (${calls.length}번)`);
      // 이유별 수는 모두 로그인 안 됨이에요(할 일이 같아서, PRD A28).
      assert.ok(rowText(r.stdout, 'AI 요약').includes('(못 한 세션 3개 — 로그인 안 됨 3개)'), `${k.why}\n${r.stdout}`);
      // DESIGN S3 10번: 두 줄(77·78칸)이고 낱말 사이에서 끊겨요.
      const L = r.stdout.split('\n');
      const at = L.indexOf('[알림] Claude Code에 로그인돼 있지 않거나 로그인이 거절돼 세션 3개를 요약하지');
      assert.ok(at >= 0, r.stdout);
      assert.equal(L[at + 1], '       못했어요. 터미널에서 claude를 한 번 실행해 로그인한 뒤 다시 실행하세요.');
      // 찾지 못함·로그인 안 됨으로 멈추면 상한에 닿은 것이 아니라 보통 남은 세션 문장이에요.
      assert.ok(flat(r.stdout).includes(oneSpace(SUMMARY_TEXT.remaining(3, 1))), r.stdout);
      const sentRow = rowText(r.stdout, '보냄');
      if (k.sent) assert.equal(sentRow, `보냄 ${SUMMARY_TEXT.sent} ${SUMMARY_TEXT.sentNote(calls.length)}`, `${k.why}\n${r.stdout}`);
      else assert.equal(sentRow, '', `${k.why}: 보낸 세션이 없으면 보냄 칸이 없어요`);
      assert.ok(!/FAKE-RAW/.test(r.stdout + r.stderr), '출력·오류 원문은 보여 주지 않아요');
    }
    assert.ok(SUMMARY_TEXT.todo.auth(3).includes('로그인돼 있지 않거나 로그인이 거절돼'));
  } finally {
    sb.cleanup();
  }
});

// ---- 취합 22회차 차이 1: 멈춘 까닭이 이번에 쓴 일지 밖에만 있어도 이유별 수와 [알림]이 빠지지 않아요 ----

/** 요약 일지 둘(ago(2)·ago(1), 빈 세션 3·3, 그날이 끝난 뒤 만든 일지)을 만들어 둬요. 오늘 세션은 없어요. */
function twoEmptySummaryLogs(sb: Sandbox, prefix: string): string[] {
  const dates = [ago(2), ago(1)];
  for (const d of dates) for (let i = 0; i < 3; i++) chat(sb, d, `${prefix}-${d}-${i}`, `1${i}:00`);
  // claude를 찾지 못한 채 요약을 켜고 만들면 두 날짜 모두 요약이 빈 요약 일지가 돼요.
  assert.equal(runCli(sb, ['--summary'], { CC_WORKLOG_CLAUDE: join(sb.root, 'none.exe') }).code, 0);
  for (const d of dates) assert.ok(md(sb, d).includes('- AI 요약: 켜짐 (세션 3개 중 0개 요약)'));
  return dates;
}

test('A28 (22회차 차이 1): 부를 세션이 모두 다시 만들지 않는 지난 요약 일지에 있고 새로 쓰는 일지가 없어도, 찾지 못함·로그인 안 됨·사용량 제한으로 멈추면 이유별 수와 [알림]이 나와요(종료 코드 0, 일지 내용 그대로)', () => {
  const sb = sandbox();
  try {
    const dates = twoEmptySummaryLogs(sb, 'H');
    const none = { CC_WORKLOG_CLAUDE: join(sb.root, 'none.exe') };
    const prints = () => dates.map((d) => ({ md: fingerprint(files(sb, d).md), json: fingerprint(files(sb, d).json) }));
    const mdHashes = () => dates.map((d) => fingerprint(files(sb, d).md).hash);
    const summariesOf = () =>
      dates.map((d) => ({ on: day(sb, d).summaryEnabled, sessions: sessionsOf(day(sb, d)).map((s) => [s.sessionId, s.summaryTarget, s.summary]) }));

    // ① 찾지 못함: 한 세션도 꺼내지 않아 두 일지 모두 다시 만들지 않아요(두 파일 그대로, ③ 고르기는 그대로). 그래도 까닭과 할 일이 나와요.
    // 예전(22회차)에는 `켜짐 — 요약할 세션이 없었어요`와 남은 세션 문장뿐이었어요.
    const before = prints();
    const r = runCli(sb, ['--summary'], none);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fakeCalls(sb), []);
    assert.deepEqual(prints(), before, '다시 만들지 않는 일지는 그대로예요');
    assert.equal(
      rowText(r.stdout, 'AI 요약'),
      oneSpace(`AI 요약 켜짐 — 요약한 세션 0개 (못 한 세션 6개 — claude를 찾지 못함 6개) ${SUMMARY_TEXT.remaining(6, 2)}`),
      r.stdout,
    );
    assert.ok(!r.stdout.includes(SUMMARY_TEXT.noTargets), r.stdout);
    assert.ok(flat(r.stdout).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo['not-found'](6)}`)), r.stdout);
    // DESIGN 6장 덧붙임 예시 글자 그대로: 3줄은 80·40칸, [알림]은 `설치돼` 다음에서 끊겨 76·61칸이에요.
    const L = r.stdout.split('\n');
    const at = L.indexOf('AI 요약     켜짐 — 요약한 세션 0개');
    assert.ok(at >= 0, r.stdout);
    assert.deepEqual(L.slice(at, at + 4), [
      'AI 요약     켜짐 — 요약한 세션 0개',
      '            (못 한 세션 6개 — claude를 찾지 못함 6개)',
      '            요약이 빈 세션 6개(일지 2개)가 남았어요. 다음에 요약을 켜고 실행하면',
      '            최근 날짜부터 이어서 채워요.',
    ]);
    const nt = L.indexOf('[알림] claude를 찾지 못해 세션 6개를 요약하지 못했어요. Claude Code가 설치돼');
    assert.ok(nt >= 0, r.stdout);
    assert.equal(L[nt + 1], '       있고 claude가 PATH에 있는지 확인한 뒤 다시 실행하세요.');
    assert.deepEqual([L[at + 2], L[at + 3], L[nt], L[nt + 1]].map((l) => displayWidth(l!)), [80, 40, 76, 61]);
    assert.equal(rowText(r.stdout, '보냄'), '', '찾지 못함이면 보낸 세션이 없어요');
    assert.equal(rowText(r.stdout, '결과').split(' 보관 폴더')[0], `결과 ${MAKE_TEXT.resultNoneKept(2)}`, r.stdout);
    for (const l of r.stdout.split('\n')) if (!l.includes(sb.root)) assert.ok(displayWidth(l) <= 80, l);

    // ② 로그인 안 됨·사용량 제한: 첫 호출(가장 늦은 날짜의 세션)을 실행했으니 그 ③ 일지는 지금처럼 다시 만들어 그 일지의 세션을 그 까닭으로 세요
    // (③ 고르기 그대로). 요약 줄은 그대로 비어 있어 일지 마크다운은 바이트까지 같고, 꺼내지 않은 일지는 두 파일 그대로예요. 까닭과 [알림]이 나와요.
    for (const k of [
      { mode: 'auth', reason: 'auth', name: '로그인 안 됨' },
      { mode: 'rate', reason: 'rate-limit', name: '사용량 제한' },
    ] as const) {
      clearFakeCalls(sb);
      const pre = prints();
      const preMd = mdHashes();
      const preSummaries = summariesOf();
      const a = runCli(sb, ['--summary'], { FAKE_CLAUDE_MODE: k.mode });
      assert.equal(a.code, 0, `${k.mode}: ${a.stderr}`);
      const calls = fakeCalls(sb);
      assert.ok(calls.length >= 1 && calls.length <= 2, `${k.mode}: 처음 확인되면 남은 세션은 부르지 않아요 (${calls.length}번)`);
      assert.ok(titlesOf(calls).every((t) => t.startsWith(`H-${ago(1)}-`)), '가장 늦은 날짜부터 불러요');
      assert.equal(
        rowText(a.stdout, 'AI 요약'),
        oneSpace(`AI 요약 켜짐 — 요약한 세션 0개 (못 한 세션 3개 — ${k.name} 3개) ${SUMMARY_TEXT.remaining(6, 2)}`),
        `${k.mode}\n${a.stdout}`,
      );
      assert.ok(flat(a.stdout).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo[k.reason](3)}`)), a.stdout);
      assert.ok(!a.stdout.includes(SUMMARY_TEXT.noTargets));
      assert.ok(!/FAKE-RAW/.test(a.stdout + a.stderr), '출력·오류 원문은 보여 주지 않아요');
      assert.deepEqual(mdHashes(), preMd, `${k.mode}: 일지 마크다운 내용은 그대로예요`);
      assert.deepEqual(summariesOf(), preSummaries, `${k.mode}: 요약 줄은 그대로 비어 있어요`);
      assert.deepEqual(prints()[0], pre[0], `${k.mode}: 꺼낸 세션이 없는 ③ 일지는 다시 만들지 않아요`);
    }
    assert.ok(!existsSync(join(sb.dataDir, 'summaries')), '실패한 세션은 요약 저장 파일에 없어요');
  } finally {
    sb.cleanup();
  }
});

test('A28 (22회차 차이 1): 이번에 쓴 일지의 요약 대상이 0이거나 저장해 둔 요약뿐이어도, claude를 찾지 못해 지난 요약 일지의 세션을 부르지 못했으면 그 수와 [알림]이 나와요', () => {
  const sb = sandbox();
  try {
    const dates = twoEmptySummaryLogs(sb, 'Z');
    const none = { CC_WORKLOG_CLAUDE: join(sb.root, 'none.exe') };
    const prints = () => dates.map((d) => ({ md: fingerprint(files(sb, d).md), json: fingerprint(files(sb, d).json) }));

    // 오늘: 요청·답변 글이 없는 세션 하나 → 오늘 일지는 새로 쓰지만 요약 대상이 0이에요.
    const sid = nextSid();
    const cwd = join(sb.root, 'work');
    writeSession(sb, cwd, sid, [assistantToolUse({ sid, cwd, ts: kst(TODAY, '09:00') }, 'tu1', 'Read', { file_path: 'a.ts' })]);
    let before = prints();
    const r = runCli(sb, ['--summary'], none);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(md(sb, TODAY).includes('- AI 요약: 켜짐 (세션 1개 중 0개 요약)'));
    assert.deepEqual(prints(), before, '지난 요약 일지는 다시 만들지 않아요');
    assert.equal(
      rowText(r.stdout, 'AI 요약'),
      oneSpace(`AI 요약 켜짐 — 요약한 세션 0개 (못 한 세션 6개 — claude를 찾지 못함 6개) ${SUMMARY_TEXT.remaining(6, 2)}`),
      r.stdout,
    );
    assert.ok(flat(r.stdout).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo['not-found'](6)}`)), r.stdout);

    // 오늘 세션을 하나 더해 가짜로 요약해 두면, 다음 기본 실행은 오늘 일지를 저장해 둔 요약으로만 다시 만들어요(부를 세션은 지난 요약 일지에만 있어요).
    chat(sb, TODAY, '오늘 일', '10:00');
    assert.equal(runCli(sb, ['--date', TODAY, '--summary']).code, 0);
    assert.equal(fakeCalls(sb).length, 1);
    clearFakeCalls(sb);
    before = prints();
    const s = runCli(sb, ['--summary'], none);
    assert.equal(s.code, 0, s.stderr);
    assert.deepEqual(fakeCalls(sb), []);
    assert.ok(md(sb, TODAY).includes('- AI 요약: 켜짐 (세션 2개 중 1개 요약)'));
    assert.deepEqual(prints(), before);
    assert.equal(
      rowText(s.stdout, 'AI 요약'),
      oneSpace(`AI 요약 켜짐 — 요약한 세션 1개 (저장해 둔 요약 1개) (못 한 세션 6개 — claude를 찾지 못함 6개) ${SUMMARY_TEXT.remaining(6, 2)}`),
      s.stdout,
    );
    assert.ok(flat(s.stdout).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo['not-found'](6)}`)), s.stdout);
    assert.equal(rowText(s.stdout, '보냄'), '');

    // 오늘 일지에 부를 세션이 1개 있으면 쓴 일지에 찾지 못함이 들어서 지금 규칙 그대로예요(쓴 일지 밖은 남은 세션 줄에만, DESIGN 6장 덧붙임).
    chat(sb, TODAY, '오늘 일 둘', '11:00');
    before = prints();
    const m = runCli(sb, ['--summary'], none);
    assert.equal(m.code, 0, m.stderr);
    assert.deepEqual(fakeCalls(sb), []);
    assert.ok(md(sb, TODAY).includes('- AI 요약: 켜짐 (세션 3개 중 1개 요약)'));
    assert.deepEqual(prints(), before);
    assert.equal(
      rowText(m.stdout, 'AI 요약'),
      oneSpace(`AI 요약 켜짐 — 요약한 세션 1개 (저장해 둔 요약 1개) (못 한 세션 1개 — claude를 찾지 못함 1개) ${SUMMARY_TEXT.remaining(7, 3)}`),
      m.stdout,
    );
    assert.ok(flat(m.stdout).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo['not-found'](1)}`)), m.stdout);
    assert.ok(!flat(m.stdout).includes(oneSpace(SUMMARY_TEXT.todo['not-found'](7))));
  } finally {
    sb.cleanup();
  }
});

test('A28 (22회차 차이 1) 단위: summaryCounts는 멈춘 까닭이 이번에 쓴 일지의 수에 없을 때만 그 까닭으로 부르지 않은 세션을 그 까닭과 요약 대상에 더하고, S3는 그 수로 2줄과 [알림]을 찍어요(찾지 못함·로그인 안 됨·사용량 제한, 쓴 일지 없음)', () => {
  const zero = { 'not-found': 0, auth: 0, 'rate-limit': 0, timeout: 0, other: 0 };
  const base: SummaryRunInfo = {
    on: true,
    targets: 0,
    newly: 0,
    reused: 0,
    failed: { ...zero },
    deferred: 0,
    capReached: false,
    sent: 0,
    remaining: { sessions: 6, days: 2 },
    droppedDays: [],
    storeProblems: [],
    storeWriteFailed: [],
    showRemaining: true,
  };
  // 멈추지 않았거나(칸 없음·null) 멈춘 까닭이 이번에 쓴 일지의 수에 이미 있으면 그대로예요(두 번 세지 않아요).
  assert.deepEqual(summaryCounts(base), { targets: 0, failed: zero });
  assert.deepEqual(summaryCounts({ ...base, halted: null }), { targets: 0, failed: zero });
  assert.deepEqual(summaryCounts({ ...base, targets: 3, failed: { ...zero, timeout: 3 } }), { targets: 3, failed: { ...zero, timeout: 3 } });
  assert.deepEqual(summaryCounts({ ...base, targets: 2, failed: { ...zero, 'not-found': 2 }, halted: { reason: 'not-found', outside: 6 } }), {
    targets: 2,
    failed: { ...zero, 'not-found': 2 },
  });
  // 저장해 둔 요약뿐인 일지 + 멈춤 → 요약한 + 못 한 = 대상
  assert.deepEqual(summaryCounts({ ...base, targets: 2, reused: 2, halted: { reason: 'auth', outside: 4 } }), { targets: 6, failed: { ...zero, auth: 4 } });

  // 쓴 일지가 없는 실행의 S3 (CLI로는 찾지 못함만 이렇게 돼요 — 로그인 안 됨·사용량 제한은 첫 호출의 ③ 일지를 다시 만들어서예요)
  const archive: ArchiveResult = {
    projectsDirExists: true,
    filesTotal: 6,
    sessionsTotal: 6,
    subagentFiles: 0,
    sessions: { new: 0, appended: 0, unchanged: 6 },
    linesRead: 0,
    linesKept: 0,
    skipped: { broken: 0, unknownType: 0, missingFields: 0, unknownTypeNames: [] },
    redactions: {},
    format: { files: {}, olderFiles: 0, newerFiles: 0, newest: null },
    atRiskBefore: { sessions: 0, earliestDeleteAt: null },
    atRiskAfter: { sessions: 0, earliestDeleteAt: null },
    originalsMissingSessions: 0,
    errors: [],
    cleanupPeriodDays: 30,
    archiveDir: 'C:\\x\\archive',
  };
  for (const k of [
    { reason: 'not-found', name: 'claude를 찾지 못함' },
    { reason: 'auth', name: '로그인 안 됨' },
    { reason: 'rate-limit', name: '사용량 제한' },
  ] as const) {
    const out = renderRunSummary(
      {
        mode: 'make',
        date: TODAY,
        dayStartHour: 3,
        archive,
        day: { sessions: 0, subagentFiles: 0, repos: 0, commits: 0, redactions: {}, identity: {}, gitAvailable: true, mdPath: null },
        hideIdentity: false,
        viewCommand: 'cc-worklog view',
        projectsDir: 'C:\\x\\projects',
        make: { kind: 'default', span: null, made: [], kept: 2, skippedEdited: [], identityOff: [], rerunHideCommand: null, noRootsHint: false, worklogsDir: 'C:\\x\\worklogs' },
        summary: { ...base, halted: { reason: k.reason, outside: 6 } },
      },
      process.stdout,
    );
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(rowText(plain, 'AI 요약'), oneSpace(`AI 요약 켜짐 — 요약한 세션 0개 (못 한 세션 6개 — ${k.name} 6개) ${SUMMARY_TEXT.remaining(6, 2)}`), plain);
    assert.ok(flat(plain).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo[k.reason](6)}`)), plain);
    assert.ok(!plain.includes(SUMMARY_TEXT.noTargets));
    assert.equal(rowText(plain, '보냄'), '');
    for (const l of plain.split('\n')) assert.ok(displayWidth(l) <= 80, l);
  }
});

test('A27·S4 (차이 7): 열리지만 깨진 요약 저장 파일(JSON이 아님·모양이 다름)은 검사가 읽지 못한 파일(깨진 파일)로 세고, 다음:은 다시 가리기가 아니라 지운 뒤 다시 검사하라는 안내예요. 지워도 일지는 그대로이고 요약을 켜고 다시 만들면 다시 불러요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    chat(sb, D, '깨짐 시험');
    assert.equal(runCli(sb, ['--date', D, '--summary']).code, 0);
    assert.equal(runCli(sb, ['check']).code, 0);
    const mdBefore = fingerprint(files(sb, D).md);
    const rel = `summaries/${D}.json`;
    const brokenNext = [
      '다음: 깨진 요약 저장 파일을 지운 뒤 다시 검사하세요. 지워도 일지는 그대로이고,',
      '      요약을 켜고 그 날짜를 다시 만들면 요약을 다시 불러요.',
    ];
    const shapes = [
      '{ 깨진',
      '[]',
      JSON.stringify({ schema: 1, date: D, sessions: [{ sessionId: 'x' }] }),
      JSON.stringify({ schema: 2, date: D, sessions: [] }),
    ];
    for (const text of shapes) {
      writeFileSync(files(sb, D).store, text);
      const c = runCli(sb, ['check']);
      assert.equal(c.code, 1, `${text}\n${c.stdout}`);
      const L = c.stdout.trimEnd().split('\n');
      assert.ok(L.includes(`     ${rel}  읽지 못함 (깨진 파일)`), c.stdout);
      assert.ok(!c.stdout.includes('읽을 수 없는 요약 저장 파일'), '예전 일반 의심 모양은 쓰지 않아요');
      const verdict = L.findIndex((l) => l.startsWith('[실패]'));
      assert.equal(L[verdict], '[실패] 남은 의심 1건, 놓친 패턴 0개');
      // 다음:은 깨진 요약 저장 파일 안내 하나뿐이에요(다시 가리기·프로그램 닫기 다음: 없음). 그 아래는 끈 일지의 이름·이메일 [알림]이에요.
      assert.deepEqual(L.slice(verdict + 1, verdict + 3), brokenNext, '다시 가리기·프로그램 닫기 다음:은 없어요');
      assert.equal(L[verdict + 3], '');
      assert.ok(L[verdict + 4]!.startsWith('[알림] 이름·이메일 가리기를 끈 일지'));
      assert.ok(brokenNext.every((l) => displayWidth(l) <= 80));
    }
    // 다시 가리기는 깨진 파일을 고치지 못해요(고칠 수 없는 의심, 같은 기준).
    const red = runCli(sb, ['redact', '--yes']);
    assert.equal(red.code, 0, red.stderr);
    assert.ok(flat(red.stdout).includes('다시 가리기로 고칠 수 없는 의심 1건은 그대로 남아요'), red.stdout);
    // 지우면 일지는 그대로이고 검사가 통과해요.
    rmSync(files(sb, D).store);
    assert.equal(runCli(sb, ['check']).code, 0);
    assert.deepEqual(fingerprint(files(sb, D).md), mdBefore, '지워도 일지는 그대로예요');
    // 모양이 다른 파일은 일지 만들기도 저장한 요약이 없는 것으로 보고 다시 불러 새로 써요(같은 기준).
    writeFileSync(files(sb, D).store, shapes[2]!);
    clearFakeCalls(sb);
    const again = runCli(sb, ['--date', D, '--summary']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fakeCalls(sb).length, 1);
    assert.ok(again.stdout.includes(`       ${files(sb, D).store} (깨진 파일)`), again.stdout);
    assert.notEqual(readFileSync(files(sb, D).store, 'utf8'), shapes[2]);
    assert.equal(readJson<{ sessions: unknown[] }>(files(sb, D).store).sessions.length, 1);
    assert.equal(runCli(sb, ['check']).code, 0);
  } finally {
    sb.cleanup();
  }
});

test('A27·S4 (차이 7) 렌더: 깨진 요약 저장 파일은 `읽지 못함 (깨진 파일)` 한 줄이고, 다음: 순서는 읽지 못한 파일 → 깨진 요약 저장 파일 → 다시 가리기예요. 깨진 파일만 있으면 프로그램 닫기 다음:은 없어요', () => {
  const notStream = { isTTY: false } as NodeJS.WriteStream;
  const base = (): CheckReport => ({
    dataDir: 'D:\\wl',
    builtin: [{ label: 'GitHub 토큰', caught: true }],
    negatives: [{ what: '커밋 해시', intact: true }],
    user: [],
    scanned: { worklogs: 1, archives: 1, summaries: 1 },
    markers: { worklog: {}, archive: {} },
    findings: [],
    identity: { counted: true, worklogs: 1, userNames: 0, emails: 0, findings: [] },
    passed: false,
    mismatched: [],
    identityDays: [],
  });
  const nexts = (out: string) => out.split('\n').filter((l) => l.startsWith('다음:'));
  const r = base();
  r.findings.push(
    { file: 'archive/projects/p/a.jsonl', line: 3, kind: 'GitHub 토큰' },
    { file: 'summaries/2026-10-18.json', line: 0, kind: '읽지 못함', code: SUMMARY_BROKEN },
    { file: 'worklogs/2026-10-18.md', line: 0, kind: '읽지 못함', code: 'EBUSY' },
  );
  const out = renderCheckReport(r, notStream);
  assert.match(out, /^ {5}summaries\/2026-10-18\.json +읽지 못함 \(깨진 파일\)$/m);
  assert.match(out, /^ {5}worklogs\/2026-10-18\.md +읽지 못함 \(EBUSY\)$/m);
  assert.ok(out.includes('[실패] 남은 의심 3건, 놓친 패턴 0개'));
  const order = ['다음: 읽지 못한 파일을 연 프로그램', '다음: 깨진 요약 저장 파일을 지운 뒤', '다음: 필요하면 사용자 패턴을 더한 뒤'];
  assert.equal(nexts(out).length, 3, out);
  nexts(out).forEach((l, i) => assert.ok(l.startsWith(order[i]!), `${i}: ${l}`));
  const only = base();
  only.findings.push({ file: 'summaries/2026-10-18.json', line: 0, kind: '읽지 못함', code: SUMMARY_BROKEN });
  const o2 = renderCheckReport(only, notStream);
  assert.deepEqual(nexts(o2), ['다음: 깨진 요약 저장 파일을 지운 뒤 다시 검사하세요. 지워도 일지는 그대로이고,']);
  assert.ok(o2.trimEnd().endsWith('      요약을 켜고 그 날짜를 다시 만들면 요약을 다시 불러요.'), o2);
  assert.ok(!o2.includes(UNREADABLE_NEXT.slice(0, 20)));
});

test('A27 (차이 8): 받은 요약을 요약 저장 파일에 쓰지 못하면 멈추지 않는 [알림]으로 알리고(종료 코드 그대로) 받은 요약은 일지에 넣어요. 그 세션은 그 날짜를 다시 만들 때만 다시 불러요(지난 날짜는 기본 실행이 다시 부르지 않아요)', () => {
  const sb = sandbox();
  try {
    const D = ago(2);
    chat(sb, D, '저장 실패');
    // 요약 저장 폴더 자리에 파일을 둬서 요약 저장 파일을 쓰지 못하게 해요(다른 프로그램이 잡은 것과 같은 결과).
    mkdirSync(sb.dataDir, { recursive: true });
    const block = join(sb.dataDir, 'summaries');
    writeFileSync(block, 'not a folder');
    const r = runCli(sb, ['--date', D, '--summary']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fakeCalls(sb).length, 1);
    assert.ok(md(sb, D).includes('작업 내용(AI 요약): 저장 실패 작업을 마무리했어요.'), '받은 요약은 일지에 넣어요');
    assert.equal(day(sb, D).projects[0]!.sessions[0]!.summary, '저장 실패 작업을 마무리했어요.');
    const L = r.stdout.split('\n');
    const i = L.indexOf(`[알림] ${SUMMARY_TEXT.storeWriteFailed(1)}`);
    assert.ok(i >= 0, r.stdout);
    assert.equal(SUMMARY_TEXT.storeWriteFailed(1), '받은 요약 1개를 요약 저장 파일에 쓰지 못했어요. 이번 일지에는 넣었어요.');
    assert.match(L[i + 1]!, new RegExp(`^       ${files(sb, D).store.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&')}( \\(E[A-Z]+\\))?$`));
    assert.deepEqual(L.slice(i + 2, i + 5), [
      '       다른 프로그램이 잡고 있으면 닫으세요.',
      '       저장하지 못한 요약은 요약을 켜고 그 날짜를 다시 만들 때 다시 불러요.',
      '       지난 날짜는 --date나 --from으로 다시 만들 때만 다시 불러요.',
    ]);
    assert.equal(L[i + 5], '', '요약 [알림]의 맨 끝, 결과 칸 바로 위예요');
    assert.ok(L[i + 6]!.startsWith('결과'));
    assert.ok(rowText(r.stdout, '보냄').includes('(세션 1개,'));

    // 막힌 것을 치운 뒤: 지난 날짜 일지는 요약이 들어 있어 기본 실행이 다시 만들지도 부르지도 않아요.
    rmSync(block);
    clearFakeCalls(sb);
    assert.equal(runCli(sb, ['--summary']).code, 0);
    assert.deepEqual(fakeCalls(sb), [], '지난 날짜는 기본 실행이 다시 부르지 않아요');
    // 그 날짜를 요약을 켜고 다시 만들면 저장 파일에 없어서 다시 불러 저장해요.
    const again = runCli(sb, ['--date', D, '--summary']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fakeCalls(sb).length, 1);
    assert.equal(readJson<{ sessions: unknown[] }>(files(sb, D).store).sessions.length, 1);
    assert.ok(!again.stdout.includes('쓰지 못했어요'));
  } finally {
    sb.cleanup();
  }
});

/** 시간 초과로 끝낸 가짜 claude가 정말 끝났는지 봐요 (잠깐 기다려요) */
function await_gone(calls: FakeCall[]): void {
  const until = Date.now() + 5000;
  for (const c of calls) {
    while (!gone(c.pid)) {
      if (Date.now() > until) assert.fail(`시간 초과한 claude(PID ${c.pid})가 아직 살아 있어요`);
      const t = Date.now() + 50;
      while (Date.now() < t) {
        /* 잠깐 기다려요 */
      }
    }
  }
}

// ---- A24: 상한·순서·이어서 채우기 ----

test('A24·Q26: 부를 세션이 50개보다 많으면 claude는 50번만, 날짜가 늦은 세션부터 동시에 2개까지 불리고, 다시 실행하면 남은 세션만 이어서 채워요(그날이 끝난 뒤 만든 일지여도). --from도 같은 상한과 순서예요', () => {
  const sb = sandbox();
  try {
    const plan: Array<[string, number]> = [
      [ago(3), 20],
      [ago(2), 20],
      [ago(1), 13],
    ];
    for (const [date, n] of plan) for (let i = 0; i < n; i++) chat(sb, date, `T-${date}-${String(i).padStart(2, '0')}`, `${String(8 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 9).padStart(2, '0')}`);
    // 부르는 순서: ago(1) 13개 → ago(2) 20개 → ago(3)은 그날 마지막 줄 시각이 늦은 17개. ago(3)의 이른 3개(00~02)가 남아요.
    const expectFirst = new Set<string>();
    for (const [date, n] of plan) for (let i = 0; i < n; i++) if (date !== ago(3) || i >= 3) expectFirst.add(`T-${date}-${String(i).padStart(2, '0')}`);
    assert.equal(expectFirst.size, CALL_LIMIT);

    const r1 = runCli(sb, ['--summary'], { FAKE_CLAUDE_DELAY_MS: '60' });
    assert.equal(r1.code, 0, r1.stderr);
    const c1 = fakeCalls(sb);
    assert.equal(c1.length, CALL_LIMIT, '실행마다 50번까지예요');
    assert.deepEqual(new Set(titlesOf(c1)), expectFirst);
    const startOf = (date: string) => c1.filter((c) => titlesOf([c])[0]!.startsWith(`T-${date}`)).map((c) => c.start);
    assert.ok(Math.max(...startOf(ago(1))) <= Math.min(...startOf(ago(3))), '날짜가 늦은 일지의 세션부터 불러요');
    // 동시에 실행된 수: 두 개까지, 실제로 두 개가 겹쳐요.
    const events = c1.flatMap((c) => [
      [c.start, 1],
      [c.end ?? c.start, -1],
    ]) as Array<[number, number]>;
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let max = 0;
    for (const [, d] of events) max = Math.max(max, (cur += d));
    assert.equal(max, 2, '동시에 2개까지 불러요');
    assert.ok(md(sb, ago(3)).includes('세션 20개 중 17개 요약'));
    assert.ok(md(sb, ago(1)).includes('세션 13개 중 13개 요약'));
    assert.equal(
      rowText(r1.stdout, 'AI 요약'),
      oneSpace(`AI 요약 켜짐 — 요약한 세션 50개 (새로 부름 50개) (못 한 세션 3개 — 50번 상한으로 미룸 3개) ${SUMMARY_TEXT.remainingCap(3, 1)}`),
      r1.stdout,
    );
    assert.ok(!r1.stdout.includes('[알림]'), '상한으로 미룸은 [알림]이 없어요');
    assert.ok(rowText(r1.stdout, '보냄').includes('(세션 50개,'));

    // 다시 기본 실행: 이미 받은 요약은 부르지 않고 남은 3개만 같은 순서로 불러요. ago(3) 일지는 그날이 끝난 뒤 만든 일지지만 다시 만들어요(A18 ③).
    clearFakeCalls(sb);
    const r2 = runCli(sb, ['--summary']);
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(titlesOf(fakeCalls(sb)).sort(), [`T-${ago(3)}-00`, `T-${ago(3)}-01`, `T-${ago(3)}-02`]);
    assert.ok(md(sb, ago(3)).includes('세션 20개 중 20개 요약'));
    assert.ok(!flat(r2.stdout).includes('요약이 빈 세션'), '남은 세션이 없으면 그 줄이 없어요');
    clearFakeCalls(sb);
    assert.equal(runCli(sb, ['--summary']).code, 0);
    assert.deepEqual(fakeCalls(sb), [], '모두 채워지면 더 부르지 않아요');

    // --from도 같은 상한과 순서예요(요약 저장 파일과 일지를 지우고 처음부터).
    rmSync(join(sb.dataDir, 'summaries'), { recursive: true, force: true });
    rmSync(join(sb.dataDir, 'worklogs'), { recursive: true, force: true });
    clearFakeCalls(sb);
    const r3 = runCli(sb, ['--from', ago(3), '--summary']);
    assert.equal(r3.code, 0, r3.stderr);
    assert.deepEqual(new Set(titlesOf(fakeCalls(sb))), expectFirst);
  } finally {
    sb.cleanup();
  }
});

// ---- A24 (취합 20회차 차이 1·2): 상한은 실제로 실행한 수, 상한에 닿음 ----

test('A24 (차이 1): 재료를 만들지 못한 세션은 상한에 세지 않고 다음 세션을 더 불러 claude를 50번 실행하고, 더 부른 세션이 다시 만들지 않기로 했던 ③ 일지에 있으면 그 일지도 다시 만들어 받은 요약이 들어가요', async () => {
  const sb = sandbox();
  const savedEnv = { ...process.env };
  try {
    const plan: Array<[string, number]> = [
      [ago(3), 10],
      [ago(2), 25],
      [ago(1), 25],
    ];
    for (const [date, n] of plan) for (let i = 0; i < n; i++) chat(sb, date, `M-${date}-${String(i).padStart(2, '0')}`, slot(i));
    // 먼저 claude를 찾지 못한 채 요약을 켜고 만들어, 세 날짜 모두 요약이 빈 요약 일지(그날이 끝난 뒤 만든 일지)로 둬요.
    const first = runCli(sb, ['--summary'], { CC_WORKLOG_CLAUDE: join(sb.root, 'none.exe') });
    assert.equal(first.code, 0, first.stderr);
    for (const [date, n] of plan) assert.ok(md(sb, date).includes(`세션 ${n}개 중 0개 요약`));

    // 다음 요약을 켠 기본 실행(같은 프로세스): ago(1)의 가장 늦은 두 세션(먼저 부를 세션)은 재료를 만들지 못해요(보관본을 읽지 못한 것처럼).
    // 예전에는 상한 안에 든 앞 50개(ago(1)·ago(2))만 골라 48번만 실행하고 ago(3) 일지는 다시 만들지 않았어요.
    process.env.FAKE_CLAUDE_LOG_DIR = sb.env.FAKE_CLAUDE_LOG_DIR;
    const broken = new Set([`M-${ago(1)}-24`, `M-${ago(1)}-23`]);
    const cfg = resolveConfig({ claudeDir: sb.claudeDir, dataDir: sb.dataDir, summary: true });
    const r = await captureRun(() =>
      runMake(
        cfg,
        { kind: 'default' },
        {
          material: async (c, build) => {
            if (broken.has(c.input.title ?? '')) throw Object.assign(new Error('보관본을 읽지 못함'), { code: 'EBUSY' });
            return build();
          },
        },
      ),
    );
    assert.equal(r.code, 0, r.stderr);
    const calls = fakeCalls(sb);
    assert.equal(calls.length, CALL_LIMIT, '재료를 만들지 못한 세션은 상한에 세지 않고 실제로 50번 실행해요');
    const titles = new Set(titlesOf(calls));
    for (const t of broken) assert.ok(!titles.has(t), '재료를 만들지 못한 세션은 보내지 않아요');
    // 늦은 날짜부터: ago(1) 23개 + ago(2) 25개 + 그만큼 더 부른 ago(3)의 가장 늦은 2개
    assert.equal(titlesOf(calls).filter((t) => t.startsWith(`M-${ago(3)}`)).length, 2);
    assert.ok(titles.has(`M-${ago(3)}-09`) && titles.has(`M-${ago(3)}-08`));
    assert.ok(md(sb, ago(3)).includes('세션 10개 중 2개 요약'), '더 부른 세션의 ③ 일지도 다시 만들어 받은 요약이 들어가요');
    assert.ok(md(sb, ago(3)).includes(`작업 내용(AI 요약): M-${ago(3)}-09 작업을 마무리했어요.`));
    assert.ok(md(sb, ago(2)).includes('세션 25개 중 25개 요약'));
    assert.ok(md(sb, ago(1)).includes('세션 25개 중 23개 요약'));
    // S3: 재료를 만들지 못한 세션은 그 밖의 실패, 상한에 닿았어요(50번 실행 + ago(3)에 부를 세션 8개가 더 남음).
    assert.equal(
      rowText(r.stdout, 'AI 요약'),
      oneSpace(`AI 요약 켜짐 — 요약한 세션 50개 (새로 부름 50개) (못 한 세션 10개 — 50번 상한으로 미룸 8개 · 그 밖의 실패 2개) ${SUMMARY_TEXT.remainingCap(10, 2)}`),
      r.stdout,
    );
    assert.ok(rowText(r.stdout, '보냄').includes('(세션 50개,'), '재료를 만들지 못한 세션은 보낸 세션에 들지 않아요');
    assert.ok(flat(r.stdout).includes(oneSpace(`[알림] ${SUMMARY_TEXT.todo.other(2)}`)), r.stdout);
    assert.ok(SUMMARY_TEXT.todo.other(2).startsWith('보낼 글을 만들지 못했거나'));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    sb.cleanup();
  }
});

test('A24 (차이 2): 50번을 다 실행했고 부를 세션이 다시 만들지 않은 ③ 일지에만 남아도 상한에 닿은 것이에요(요약 일지 넷 25·25·10·10). 다음 실행이 남은 세션을 채우면 그 줄은 없어요', () => {
  const sb = sandbox();
  try {
    const plan: Array<[string, number]> = [
      [ago(4), 10],
      [ago(3), 10],
      [ago(2), 25],
      [ago(1), 25],
    ];
    for (const [date, n] of plan) for (let i = 0; i < n; i++) chat(sb, date, `C-${date}-${String(i).padStart(2, '0')}`, slot(i));
    assert.equal(runCli(sb, ['--summary'], { CC_WORKLOG_CLAUDE: join(sb.root, 'none.exe') }).code, 0);
    const untouched = [ago(4), ago(3)].map((d) => ({ md: fingerprint(files(sb, d).md), json: fingerprint(files(sb, d).json) }));

    const r = runCli(sb, ['--summary']);
    assert.equal(r.code, 0, r.stderr);
    const calls = fakeCalls(sb);
    assert.equal(calls.length, CALL_LIMIT);
    assert.ok(titlesOf(calls).every((t) => t.startsWith(`C-${ago(1)}`) || t.startsWith(`C-${ago(2)}`)), '최근 두 날짜에 딱 맞게 50번');
    assert.deepEqual(
      [ago(4), ago(3)].map((d) => ({ md: fingerprint(files(sb, d).md), json: fingerprint(files(sb, d).json) })),
      untouched,
      '꺼낸 세션이 없는 ③ 일지는 다시 만들지 않아요',
    );
    // 미룸은 0(이번에 쓴 일지의 세션은 모두 받음)이지만, 부를 세션 20개가 다시 만들지 않은 일지에 남아 상한 문장이에요(DESIGN 예시 그대로).
    assert.equal(rowText(r.stdout, 'AI 요약'), oneSpace(`AI 요약 켜짐 — 요약한 세션 50개 (새로 부름 50개) ${SUMMARY_TEXT.remainingCap(20, 2)}`), r.stdout);
    assert.ok(!r.stdout.includes('못 한 세션'));
    assert.ok(rowText(r.stdout, '보냄').includes('(세션 50개,'));
    assert.equal(rowText(r.stdout, '결과').split(' 일지 폴더')[0], '결과 일지 2개 — 다시 만듦 2개 · 그대로 둠 2개', r.stdout);

    // 다음 실행이 남은 20개를 채워요. 남은 세션이 없으면 그 줄이 없어요.
    clearFakeCalls(sb);
    const r2 = runCli(sb, ['--summary']);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(fakeCalls(sb).length, 20);
    assert.ok(!flat(r2.stdout).includes('요약이 빈 세션'), r2.stdout);
    assert.ok(md(sb, ago(4)).includes('세션 10개 중 10개 요약') && md(sb, ago(3)).includes('세션 10개 중 10개 요약'));
  } finally {
    sb.cleanup();
  }
});

test('A24 (차이 1·2) 단위: runSummaryCalls는 실제로 실행한 수로 50번(여기서는 limit)을 세고, 꺼내지 않은 세션이 남았을 때만 상한에 닿았다고 봐요', async () => {
  const sb = sandbox();
  try {
    const cmd = resolveClaude({ CC_WORKLOG_CLAUDE: FAKE_CLAUDE });
    assert.ok(cmd);
    const list = (n: number): Candidate[] =>
      Array.from({ length: n }, (_, i) => ({
        date: '2026-10-20',
        range: { start: '2026-10-19T18:00:00.000Z', end: '2026-10-20T18:00:00.000Z' },
        input: {
          sessionId: `u${i}`,
          target: true,
          files: [],
          title: `U${i}`,
          mark: { userLines: 1, assistantLines: 1, lastLineAt: `2026-10-20T0${i}:00:00.000Z` },
        },
      }));
    const run = (n: number, limit: number, fail: string[]) =>
      runSummaryCalls(orderCandidates(list(n)), {
        dataDir: sb.dataDir,
        workDir: sb.root,
        dayStartHour: 3,
        redactor: new Redactor([]),
        stop: new StopSignal(),
        limit,
        command: cmd,
        material: async (c) => {
          if (fail.includes(c.input.sessionId)) throw Object.assign(new Error('x'), { code: 'EBUSY' });
          return `제목: ${c.input.title}\n[요청]\n고쳐 줘`;
        },
      });
    const statusOf = (r: SummaryRun) => Object.fromEntries([...r.outcomes].map(([k, o]) => [k.split('\u0000')[1], `${o.status}${o.reason ? `:${o.reason}` : ''}`]));

    // 후보 6, 상한 4, 먼저 부를 둘(u5·u4)의 재료 실패 → 4번 실행(u3~u0), 꺼내지 않은 세션 없음 → 상한에 닿지 않음
    const a = await run(6, 4, ['u5', 'u4']);
    assert.equal(a.stats.executed, 4);
    assert.equal(a.stats.capReached, false, '50번(4번)을 실행했어도 더 부를 세션이 없으면 닿은 것이 아니에요');
    assert.deepEqual(statusOf(a), { u5: 'failed:other', u4: 'failed:other', u3: 'ok', u2: 'ok', u1: 'ok', u0: 'ok' });
    for (const k of ['u5', 'u4']) {
      const o = [...a.outcomes].find(([key]) => key.endsWith(k))![1];
      assert.deepEqual({ executed: o.executed, sent: o.sent, attempted: o.attempted }, { executed: false, sent: false, attempted: true });
    }
    assert.deepEqual(tallyOutcomes(a.outcomes.keys(), a.outcomes), { newly: 4, failed: { 'not-found': 0, auth: 0, 'rate-limit': 0, timeout: 0, other: 2 }, deferred: 0, sent: 4 });

    // 후보 7, 상한 4, 재료 실패 하나 → 4번 실행, 남은 둘은 미룸 → 상한에 닿음
    const b = await run(7, 4, ['u6']);
    assert.equal(b.stats.executed, 4);
    assert.equal(b.stats.capReached, true);
    assert.deepEqual(statusOf(b), { u6: 'failed:other', u5: 'ok', u4: 'ok', u3: 'ok', u2: 'ok', u1: 'deferred', u0: 'deferred' });
    assert.equal(tallyOutcomes(b.outcomes.keys(), b.outcomes).deferred, 2);

    // 후보 4, 상한 4 → 딱 맞게 실행, 남은 세션 없음 → 닿지 않음
    const c = await run(4, 4, []);
    assert.equal(c.stats.executed, 4);
    assert.equal(c.stats.capReached, false);

    // 사용량 제한으로 멈춤 → 상한(4)보다 후보가 많아도 닿은 것이 아니고, 남은 세션은 모두 사용량 제한이에요(미룸 0).
    process.env.FAKE_CLAUDE_MODE = 'rate';
    try {
      const e = await run(6, 4, []);
      assert.equal(e.stats.halted, 'rate-limit');
      assert.equal(e.stats.capReached, false);
      const t = tallyOutcomes(e.outcomes.keys(), e.outcomes);
      assert.equal(t.deferred, 0);
      assert.equal(t.failed['rate-limit'], 6);
      assert.ok(e.stats.executed >= 1 && e.stats.executed <= 2);
      assert.equal(t.sent, e.stats.executed, '사용량 제한은 보낸 것으로 세요');
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }

    // 찾지 못함 → 실행 0, 모두 찾지 못함, 꺼낸 세션 없음, 닿지 않음
    const d = await runSummaryCalls(orderCandidates(list(3)), { dataDir: sb.dataDir, workDir: sb.root, dayStartHour: 3, redactor: new Redactor([]), stop: new StopSignal(), command: null });
    assert.equal(d.stats.halted, 'not-found');
    assert.deepEqual(statusOf(d), { u2: 'failed:not-found', u1: 'failed:not-found', u0: 'failed:not-found' });
    assert.ok([...d.outcomes.values()].every((o) => !o.attempted && !o.sent));
  } finally {
    sb.cleanup();
  }
});

// ---- A28·A18: 요약을 끄고 다시 만들 때 ----

test('A28·A18: 요약을 켜고 만든 일지를 끈 채 다시 만들면 요약 줄이 빠지고 S3가 알리며, 기본 실행은 요약 일지를 요약 일지로 다시 만들되 요약을 끈 실행은 claude를 부르지 않고 저장해 둔 요약만 써요', () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    chat(sb, D, '어제 일');
    assert.equal(runCli(sb, ['--date', D, '--summary']).code, 0);
    assert.equal(fakeCalls(sb).length, 1);

    clearFakeCalls(sb);
    const off = runCli(sb, ['--date', D]);
    assert.equal(off.code, 0);
    assert.deepEqual(fakeCalls(sb), []);
    assert.ok(!md(sb, D).includes('AI 요약'));
    assert.equal(day(sb, D).summaryEnabled, undefined);
    assert.equal(rowText(off.stdout, 'AI 요약'), `AI 요약 ${SUMMARY_TEXT.droppedHead(1)} ${SUMMARY_TEXT.droppedTodo}`, off.stdout);
    assert.ok(!off.stdout.includes('새로 부름') && !off.stdout.split('\n').some((l) => l.startsWith('보냄')), '요약을 끈 실행에는 요약한 세션 수와 보냄 칸이 없어요');

    const back = runCli(sb, ['--date', D, '--summary']);
    assert.equal(back.code, 0);
    assert.deepEqual(fakeCalls(sb), [], '저장해 둔 요약을 다시 써요');
    assert.ok(md(sb, D).includes('작업 내용(AI 요약): 어제 일 작업을 마무리했어요.'));

    // 오늘 일지: 요약을 켠 기본 실행으로 만든 뒤 새 세션이 늘고, 요약을 끈 기본 실행이 다시 만들어요(A18 ②).
    chat(sb, TODAY, '오늘 하나', '04:00');
    clearFakeCalls(sb);
    assert.equal(runCli(sb, ['--summary']).code, 0);
    assert.deepEqual(titlesOf(fakeCalls(sb)), ['오늘 하나']);
    chat(sb, TODAY, '오늘 둘', '04:30');
    clearFakeCalls(sb);
    const plain = runCli(sb, []);
    assert.equal(plain.code, 0, plain.stderr);
    assert.deepEqual(fakeCalls(sb), [], '요약을 끈 실행은 부르지 않아요');
    const today = day(sb, TODAY);
    assert.equal(today.summaryEnabled, true, '요약을 켜고 만든 일지는 기본 실행이 요약 일지로 다시 만들어요');
    const byTitle = new Map(sessionsOf(today).map((s) => [s.title, s]));
    assert.equal(byTitle.get('오늘 하나')!.summary, '오늘 하나 작업을 마무리했어요.', '줄이 늘지 않은 세션은 저장해 둔 요약을 써요');
    assert.equal(byTitle.get('오늘 둘')!.summary, null, '새 세션은 요약 줄을 비워요');
    assert.equal(rowText(plain.stdout, 'AI 요약'), `AI 요약 ${SUMMARY_TEXT.remainingOffHead(1, 1)} ${SUMMARY_TEXT.remainingOffTodo}`, plain.stdout);
    clearFakeCalls(sb);
    assert.equal(runCli(sb, ['--summary']).code, 0);
    assert.deepEqual(titlesOf(fakeCalls(sb)), ['오늘 둘'], '다음에 요약을 켠 실행이 이어서 채워요');
  } finally {
    sb.cleanup();
  }
});

test('A21·A24: 손으로 고친 요약 일지의 날짜는 부르지 않고(A18 ③로도 다시 만들지 않아요), 남은 세션 수에도 세지 않아요', () => {
  const sb = sandbox();
  try {
    const D = ago(2);
    chat(sb, D, '메모 날');
    assert.equal(runCli(sb, ['--date', D, '--summary'], { CC_WORKLOG_CLAUDE: join(sb.root, 'none.exe') }).code, 0);
    assert.ok(md(sb, D).includes('세션 1개 중 0개 요약'));
    appendFileSync(files(sb, D).md, '\n내 메모\n');
    const fp = { md: fingerprint(files(sb, D).md), json: fingerprint(files(sb, D).json) };

    const r = runCli(sb, ['--summary']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fakeCalls(sb), [], '손으로 고친 요약 일지는 부르지 않아요');
    assert.deepEqual({ md: fingerprint(files(sb, D).md), json: fingerprint(files(sb, D).json) }, fp);
    assert.ok(!flat(r.stdout).includes('요약이 빈 세션'), '손으로 고친 일지의 세션은 세지 않아요');

    const d = runCli(sb, ['--date', D, '--summary']);
    assert.equal(d.code, 0);
    assert.deepEqual(fakeCalls(sb), []);
    assert.ok(d.stdout.includes('손으로 고친 일지 1개는 덮어쓰지 않고 그대로 뒀어요.'));
  } finally {
    sb.cleanup();
  }
});

// ---- A26: Ctrl+C ----

test('A26: Ctrl+C로 멈추면 부르던 claude를 끝내고, 받은 요약은 요약 저장 파일에 남기며, 일지는 쓰지 않고(한쪽만 바뀐 일지 없음) 작업 폴더도 지워요([취소] 표준 오류만, 화면·검사·보냄 줄 없음, 종료 코드 1)', async () => {
  const sb = sandbox();
  const saved = { ...process.env };
  try {
    const D = ago(1);
    for (let i = 0; i < 6; i++) chat(sb, D, `멈춤${i}`, `1${i}:00`);
    process.env.FAKE_CLAUDE_LOG_DIR = sb.env.FAKE_CLAUDE_LOG_DIR;
    process.env.FAKE_CLAUDE_DELAY_MS = '400';
    const cfg = resolveConfig({ claudeDir: sb.claudeDir, dataDir: sb.dataDir, summary: true });
    const stop = new StopSignal();
    // 요약 하나를 받아 저장한 뒤, 다음 호출이 도는 동안 멈춰요. (같은 프로세스라 저장 파일을 날짜 없이 찾아요.)
    const summariesDir = join(sb.dataDir, 'summaries');
    const saved = () =>
      existsSync(summariesDir) ? readdirSync(summariesDir).reduce((n, f) => n + readJson<{ sessions: unknown[] }>(join(summariesDir, f)).sessions.length, 0) : 0;
    const out = await captureRun(async () => {
      const done = runMake(cfg, { kind: 'range', from: ago(5), to: TODAY }, { stop });
      await waitFor(() => saved() > 0 && fakeCalls(sb).some((c) => c.end === null), 15_000);
      stop.request();
      return done;
    });
    assert.equal(out.code, 1);
    // PRD S3·A26 (취합 20회차 차이 4): 결과 요약 대신 표준 오류에 [취소] 안내만이에요. 화면·검사 줄과 보냄 칸이 없어요.
    assert.equal(out.stdout, '', '표준 출력에는 아무것도 쓰지 않아요(화면·검사·보냄 줄 없음)');
    assert.equal(out.stderr, renderSummaryInterrupted(saved(), painterFor(false)), out.stderr);
    assert.ok(!/화면|검사|보냄|\[실패\]/.test(out.stderr));
    const calls = fakeCalls(sb);
    assert.ok(calls.length < 6, '남은 세션은 부르지 않아요');
    await waitFor(() => calls.every((c) => gone(c.pid)), 5000);
    const kept = saved();
    assert.ok(kept >= 1 && kept <= calls.filter((c) => c.end !== null).length, '받은 요약은 받는 대로 남겨요');
    const store = { sessions: { length: kept } };
    assert.ok(!existsSync(join(sb.dataDir, 'worklogs')) || readdirSync(join(sb.dataDir, 'worklogs')).length === 0, '일지는 쓰지 않아요');
    assert.ok(!existsSync(summaryWorkDir(sb.dataDir)));
    // 다시 실행하면 남은 세션만 불러요.
    clearFakeCalls(sb);
    process.env.FAKE_CLAUDE_DELAY_MS = '0';
    const r = runCli(sb, ['--date', D, '--summary']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fakeCalls(sb).length, 6 - store.sessions.length);
    assert.ok(md(sb, D).includes('세션 6개 중 6개 요약'));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    sb.cleanup();
  }
});

// ---- Windows: npm으로 깐 claude.cmd ----

test('A26 (Windows): npm으로 깐 claude.cmd 모양도 cmd.exe로 고정 옵션이 그대로(빈 값·한국어 시스템 프롬프트 포함) 넘어가고, 시간 초과면 그 아래 프로세스까지 끝내요', { skip: process.platform !== 'win32' }, () => {
  const sb = sandbox();
  try {
    const D = ago(1);
    chat(sb, D, '윈도우');
    const bin = join(sb.root, 'bin');
    mkdirSync(bin, { recursive: true });
    const cmd = join(bin, 'claude.cmd');
    // npm이 만드는 claude.cmd와 같은 모양: node로 스크립트를 실행하고 인자는 %*로 넘겨요.
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
    const r = runCli(sb, ['--date', D, '--summary'], { CC_WORKLOG_CLAUDE: cmd });
    assert.equal(r.code, 0, r.stderr);
    const calls = fakeCalls(sb);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.argv, [...CLAUDE_ARGS], '빈 값과 한국어 시스템 프롬프트가 그대로 넘어가요');
    assert.ok(md(sb, D).includes('작업 내용(AI 요약): 윈도우 작업을 마무리했어요.'));

    clearFakeCalls(sb);
    rmSync(join(sb.dataDir, 'summaries'), { recursive: true, force: true });
    const t = runCli(sb, ['--date', D, '--summary'], { CC_WORKLOG_CLAUDE: cmd, FAKE_CLAUDE_MODE: 'timeout', CC_WORKLOG_CLAUDE_TIMEOUT_MS: '1500' });
    assert.equal(t.code, 0);
    assert.ok(rowText(t.stdout, 'AI 요약').includes('시간 초과 1개'));
    await_gone(fakeCalls(sb));
  } finally {
    sb.cleanup();
  }
});

// ---- 단위 ----

test('A26: claude 결과 해석(성공·로그인 안 됨·사용량 제한·그 밖), PATH에서 찾기(.exe 먼저·.cmd), 고정 옵션, 요약 작업 폴더 이름', () => {
  const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '요약이에요' });
  assert.deepEqual(interpretOutput(0, ok, ''), { ok: true, text: '요약이에요' });
  assert.deepEqual(interpretOutput(1, ok, ''), { ok: false, reason: 'other', ran: true, sent: true }, '종료 코드가 0이 아니면 실패예요');
  const err = (result: string, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result, ...extra });
  assert.equal((interpretOutput(1, err('Invalid API key · Please run /login'), '') as { reason: string }).reason, 'auth');
  assert.equal((interpretOutput(1, err('Not logged in'), '') as { reason: string }).reason, 'auth');
  assert.equal((interpretOutput(1, err('x', { api_error_status: 401 }), '') as { reason: string }).reason, 'auth');
  assert.equal((interpretOutput(1, err('Claude AI usage limit reached|1760000000'), '') as { reason: string }).reason, 'rate-limit');
  assert.equal((interpretOutput(1, err('x', { api_error_status: 429 }), '') as { reason: string }).reason, 'rate-limit');
  assert.equal((interpretOutput(0, 'not json', '') as { reason: string }).reason, 'other');
  assert.equal((interpretOutput(0, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '  ' }), '') as { reason: string }).reason, 'other');
  assert.equal((interpretOutput(1, '', 'Error: Rate limit exceeded') as { reason: string }).reason, 'rate-limit');

  // 보낸 세션 가르기 (A28, 취합 20회차 차이 3): 보내기 전에 멈춘 것이 확실한 로컬 로그인 안 됨만 sent false, 서버 거절·가릴 수 없는 글은 true
  const sentOf = (o: ReturnType<typeof interpretOutput>) => (o.ok ? true : o.sent);
  const reasonOf = (o: ReturnType<typeof interpretOutput>) => (o.ok ? 'ok' : o.reason);
  assert.equal(sentOf(interpretOutput(1, err('Not logged in · Please run /login'), '')), false, '로컬 로그인 안 됨은 보내지 않았어요');
  assert.equal(sentOf(interpretOutput(1, '', 'Error: Could not resolve authentication method. Expected either apiKey or authToken to be set.')), false);
  assert.equal(sentOf(interpretOutput(1, 'Not logged in · Please run /login\n', '')), false, 'JSON이 아닌 출력이어도 같아요');
  for (const o of [
    interpretOutput(1, err('x', { api_error_status: 401 }), ''),
    interpretOutput(1, err('Not logged in', { api_error_status: 403 }), ''),
    interpretOutput(1, err('Invalid API key · Please run /login'), ''),
    interpretOutput(1, err('Not logged in · 401 authentication_error'), ''),
    interpretOutput(1, err('OAuth token has expired. Please run /login'), ''),
  ]) {
    assert.equal(reasonOf(o), 'auth');
    assert.equal(sentOf(o), true, '서버가 거절했거나 가릴 수 없으면 보낸 것으로 세요');
  }
  for (const o of [interpretOutput(1, err('Claude AI usage limit reached'), ''), interpretOutput(1, 'garbage', ''), interpretOutput(0, err('x'), '')]) {
    assert.equal(sentOf(o), true, '사용량 제한·그 밖의 실패는 보낸 것으로 세요');
  }

  // 고정 옵션: 재료·경로 없음, cmd.exe가 바꾸는 글자 없음
  for (const a of CLAUDE_ARGS) assert.ok(!/["%^&|<>\r\n]/.test(a), a);
  assert.deepEqual(claudeArgs({ file: 'node', prefix: ['fake.mjs'], viaCmd: false }), ['fake.mjs', ...CLAUDE_ARGS]);

  // PATH에서 찾기 (실행하지 않고 파일만 봐요)
  const sb = sandbox();
  try {
    const a = join(sb.root, 'a');
    const b = join(sb.root, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'claude.cmd'), '');
    writeFileSync(join(a, 'claude.exe'), '');
    writeFileSync(join(b, 'claude.cmd'), '');
    const env = (dirs: string[]) => ({ PATH: dirs.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    assert.deepEqual(resolveClaude(env([a]), 'win32'), { file: join(a, 'claude.exe'), prefix: [], viaCmd: process.platform === 'win32' && false });
    const viaCmd = resolveClaude(env([b, a]), 'win32')!;
    assert.equal(viaCmd.file, join(b, 'claude.cmd'));
    assert.equal(viaCmd.viaCmd, process.platform === 'win32', 'Windows의 .cmd는 cmd.exe로 실행해요');
    assert.equal(resolveClaude(env([join(sb.root, 'none')]), 'win32'), null);
    assert.equal(resolveClaude({ CC_WORKLOG_CLAUDE: join(sb.root, 'none.exe') }), null, '가짜 실행 파일이 없으면 찾지 못함이에요');
    assert.deepEqual(resolveClaude({ CC_WORKLOG_CLAUDE: process.env.CC_WORKLOG_CLAUDE }), { file: process.execPath, prefix: [process.env.CC_WORKLOG_CLAUDE], viaCmd: false });

    // 요약 작업 폴더: OS 임시 폴더 안, 이름에 경로·사용자 이름 없음, 같은 데이터 폴더면 같은 이름
    const w = summaryWorkDir(sb.dataDir);
    assert.match(basename(w), /^cc-worklog-summary-[0-9a-f]{16}$/);
    assert.equal(summaryWorkDir(sb.dataDir), w);
    assert.notEqual(summaryWorkDir(join(sb.root, 'other')), w);
    assert.ok(WORK_DIR_PROJECT.test(`C--Users-x-AppData-Local-Temp-${basename(w)}`));
  } finally {
    sb.cleanup();
  }

  // 마크다운 머리 줄·Ctrl+C 출력 (DESIGN 3장 "일지 마크다운", S3 가·나 오류 글자 그대로)
  assert.equal(SUMMARY_MD.head(12, 14), '- AI 요약: 켜짐 (세션 14개 중 12개 요약)');
  assert.equal(SUMMARY_MD.head(0, 0), '- AI 요약: 켜짐 (요약할 세션 없음)');
  // Ctrl+C (DESIGN S3 가·나 오류 정리 회차, 취합 20회차 차이 4): 일지를 만들지 않았다는 말, 받은 요약 줄(7칸, 1개 이상일 때만), 다음:
  const p = painterFor(false);
  assert.equal(
    renderSummaryInterrupted(12, p),
    '[취소] Ctrl+C를 받아 요약을 멈췄어요. 이번 실행은 일지를 만들지 않았어요.\n       받은 요약 12개는 저장해 뒀어요.\n다음: 요약을 켜고 다시 실행하면 빠진 세션만 이어서 불러 일지를 만들어요.\n',
  );
  assert.equal(
    renderSummaryInterrupted(0, p),
    '[취소] Ctrl+C를 받아 요약을 멈췄어요. 이번 실행은 일지를 만들지 않았어요.\n다음: 요약을 켜고 다시 실행하면 빠진 세션만 이어서 불러 일지를 만들어요.\n',
  );
  assert.equal(renderSummaryInterrupted(1234, p).split('\n')[1], '       받은 요약 1,234개는 저장해 뒀어요.');

  // 다시 만드는 명령의 --summary (A28·A16)
  assert.equal(remakeCommand({ date: '2026-10-20', hideIdentity: true, summary: true, dayStartHour: 5 }, { dayStartHour: 3 }), 'cc-worklog --date 2026-10-20 --hide-identity --summary --day-start 5');
  assert.equal(remakeCommand(remakeDayOf('2026-10-20', { summaryEnabled: true, dayStartHour: 3 }), { dayStartHour: 3 }), 'cc-worklog --date 2026-10-20 --summary');
  assert.equal(remakeCommand(remakeDayOf('2026-10-20', { dayStartHour: 3 }), { dayStartHour: 3 }), 'cc-worklog --date 2026-10-20');
  assert.equal(rerunHideCommand(['--date', '2026-10-20'], { dayStartHour: 3, summary: true }), 'cc-worklog --date 2026-10-20 --hide-identity --summary');
});

test('A25·A27: 재료가 길면 요청은 앞부분만, 답변은 최근 것부터 담고 줄였다는 표시를 하며 2만 자를 넘지 않아요. 받은 요약은 표시 모양 글자를 바꾼 뒤 가려요. 부르는 순서는 늦은 날짜·늦은 세션부터예요', () => {
  const items: MaterialItem[] = [];
  let order = 0;
  for (let i = 0; i < 30; i++) {
    items.push({ kind: 'request', ts: i * 10, order: order++, text: `요청${String(i).padStart(2, '0')} ${'가'.repeat(3000)}` });
    items.push({ kind: 'answer', ts: i * 10 + 5, order: order++, text: `답변${String(i).padStart(2, '0')} ${'나'.repeat(3000)}[가림:GitHub 토큰]` });
  }
  const { text, trimmed } = fitMaterial('긴 세션', items);
  assert.ok(trimmed && text.includes(MATERIAL_TEXT.trimmed));
  assert.ok(text.length <= MATERIAL_MAX, `${text.length}`);
  for (let i = 0; i < 30; i++) assert.ok(text.includes(`요청${String(i).padStart(2, '0')} `), `요청${i}의 앞부분이 남아요`);
  assert.ok(text.includes('답변29') && text.includes('답변28'), '최근 답변부터 담아요');
  assert.ok(!text.includes('답변00'), '오래된 답변은 빠져요');
  assert.ok(text.indexOf('답변28') < text.indexOf('요청29'), '보낼 때는 시각 순서예요');
  assert.equal((text.match(/\[가림:/g) ?? []).length, (text.match(/\[가림:[^\]\n]{1,60}\]/g) ?? []).length, '가림 표시를 끊지 않아요');
  const short = fitMaterial('짧은 세션', items.slice(0, 2));
  assert.ok(!short.trimmed && !short.text.includes(MATERIAL_TEXT.trimmed) && short.text.includes('제목: 짧은 세션'));

  const redactor = new Redactor([{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}' }]);
  assert.equal(
    sanitizeReceived(`  고쳤어요\n${S.githubToken} CORP-12345678 [가림:토큰]  `, redactor),
    '고쳤어요 [가림:GitHub 토큰] [가림:사내 토큰] ［가림:토큰]',
  );
  assert.equal(sanitizeReceived('   \n ', redactor), null, '빈 결과는 실패예요');

  const cand = (date: string, sid: string, last: string): Candidate => ({
    date,
    range: { start: '', end: '' },
    input: { sessionId: sid, target: true, files: [], title: null, mark: { userLines: 1, assistantLines: 1, lastLineAt: last } },
  });
  const ordered = orderCandidates([
    cand('2026-10-19', 'b', '2026-10-19T05:00:00.000Z'),
    cand('2026-10-20', 'a', '2026-10-20T01:00:00.000Z'),
    cand('2026-10-20', 'c', '2026-10-20T09:00:00.000Z'),
    cand('2026-10-20', 'b', '2026-10-20T09:00:00.000Z'),
  ]).map((c) => `${c.date}/${c.input.sessionId}`);
  assert.deepEqual(ordered, ['2026-10-20/b', '2026-10-20/c', '2026-10-20/a', '2026-10-19/b']);
});
