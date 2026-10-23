// S4 가리기 검사 결과 (터미널)
// 값은 절대 보여 주지 않고, 파일·줄 위치와 "어떤 모양인지"만 적어요.
import { DEFAULT_DAY_START } from '../config.js';
import type { PendingNotice } from '../redact/journal.js';
import { sortedCounts, type Counts } from '../redact/redact.js';
import { num } from '../util/text.js';
import { REMAKE_HINT, remakeCommand, shellPath, type RemakeContext, type RemakeDay } from '../worklog/mismatch.js';
import { displayWidth, padW, painter, wrapParts, wrapText } from './format.js';
import { BROKEN_CHECK, UNFINISHED_CHECK } from './notices.js';

/**
 * 검사가 읽지 못한 파일의 종류 이름 (PRD S4, 취합 13회차 차이 5). 남은 의심으로 세지만 일반 비밀 값 의심과 구분해
 * 목록에는 "줄 …" 칸 자리에 `읽지 못함 (EBUSY)`처럼 원인 코드와 함께 보여 줘요("모양" 없음, DESIGN S4 5번, 취합 15회차).
 */
export const UNREADABLE = '읽지 못함';

/** 원인 코드처럼 보이는 값 (EBUSY·EPERM·EACCES 등). 아니면 원인 코드를 알 수 없는 것으로 보고 괄호를 빼요(DESIGN S4 5번). */
const ERROR_CODE = /^E[A-Z0-9]+$/;

/** 읽지 못한 파일이 있을 때의 다음: 줄 (다시 가리기가 아니라 그 파일을 연 프로그램을 닫거나 권한을 확인한 뒤 다시 검사) */
export const UNREADABLE_NEXT = '읽지 못한 파일을 연 프로그램(편집기·화면·백신 등)을 닫거나 파일 권한을 확인한 뒤 다시 검사하세요.';

/**
 * 열리지만 깨진 요약 저장 파일(JSON이 아니거나 요약 저장 파일 모양이 아님)의 표시 (PRD S4·A27, 취합 20회차 차이 7).
 * 읽지 못한 파일 한 건으로 세고, 원인 코드 자리에 이 글을 둬요: `summaries/2026-10-19.json  읽지 못함 (깨진 파일)`.
 * 일지 만들기 S3 [알림]의 `(깨진 파일)`과 같은 말이에요.
 */
export const SUMMARY_BROKEN = '깨진 파일';

/**
 * 이름·이메일 옵션이 켜진 일지에 사용자 이름·이메일이 남았을 때의 다음: 줄. 그 아래 날짜마다 다시 만드는 명령(--hide-identity 늘 붙음)과
 * 안내 한 줄이 와요(PRD S4, 취합 15회차 차이 1). 문구는 DESIGN S4 11번과 같아요(80칸에서 `일지를` 다음에 끊겨요, 취합 17회차 확인).
 */
export const IDENTITY_NEXT = '아래 날짜의 일지에 사용자 이름·이메일이 남아 있어요. 그 날짜 일지를 이름·이메일 가리기를 켜고 다시 만든 뒤 다시 검사하세요.';

/**
 * 이름·이메일 칸과 끈 일지의 이름·이메일 [알림] (PRD F2·S4·A19, I-01, DESIGN S4 5·12번 글 그대로).
 * 옵션이 켜진 일지(켠 일지)와 꺼진 일지(끈 일지)로 나눠 있는 쪽마다 수를 보여 주고, 판정에는 켠 일지만 넣어요.
 * 끈 일지에 남은 수가 있으면 판정(실패면 마지막 다음:) 아래 빈 줄 뒤 맨 끝에 [알림]을 둬요. 끈 일지는 대개 전부라
 * 파일·줄 위치나 날짜마다의 명령은 늘어놓지 않고 명령 모양 한 줄만 보여 줘요.
 */
export const IDENTITY_TEXT = {
  /** 2. 결과물 재검사의 `이름·이메일 (일지만)` 칸: 켠 일지·끈 일지 한 줄씩 (일지 수는 날짜 수) */
  row: (which: '켠' | '끈', worklogs: number, userNames: number, emails: number) =>
    `${which} 일지 ${num(worklogs)}개 — 사용자 이름 ${num(userNames)}건 · 이메일 ${num(emails)}건`,
  /** 그 아래 늘 두는 괄호 줄 */
  rowNote: '(보관본은 이 옵션을 쓰지 않아 세지 않아요)',
  /** 일지가 하나도 없을 때 (괄호 줄 없음) */
  noWorklogs: '일지가 없어 세지 않았어요',
  /** 맨 끝 [알림] 문장 (끈 일지에 1건 이상일 때만) */
  offNotice: (worklogs: number, userNames: number, emails: number) =>
    `이름·이메일 가리기를 끈 일지 ${num(worklogs)}개에 사용자 이름 ${num(userNames)}건 · 이메일 ${num(emails)}건이 남아 있어요. 판정은 비밀 값만 본 결과라 이 수는 넣지 않았어요. 공개할 날짜의 일지는 아래처럼 --hide-identity를 붙여 다시 만드세요.`,
  /** [알림] 아래 명령 모양 (9칸). 이번 검사에 준 --data-dir·--claude-dir는 빠지지 않아요(PRD S4). --day-start는 일지마다 달라 붙이지 않아요. */
  offCommand: (ctx: RemakeContext) => {
    const parts = ['cc-worklog', '--date', '<날짜>', '--hide-identity'];
    if (ctx.dataDir) parts.push('--data-dir', shellPath(ctx.dataDir));
    if (ctx.claudeDir) parts.push('--claude-dir', shellPath(ctx.claudeDir));
    return parts.join(' ');
  },
} as const;

/**
 * AI 요약 한 줄 (A27)의 검사 문구 (DESIGN S4 5·7·12번 글자 그대로). 요약 저장 파일이 있거나 요약을 켜고 만든 일지가 있을 때만 나와요.
 * 요약 저장 파일은 `남은 의심`에만 들어요(가린 자리 칸·이름·이메일 칸에는 넣지 않아요, 보관본처럼 이름·이메일 가리기를 쓰지 않는 재료).
 * 문구를 바꿀 때는 여기만 바꾸면 돼요.
 */
export const SUMMARY_CHECK_TEXT = {
  /** 5번 2. 결과물 재검사 머리 줄 끝 */
  scanned: (n: number) => `요약 저장 파일 ${num(n)}개`,
  /** 7번 참고: 요약을 켰으면 첫 줄 바로 다음 줄(6칸)에 더해요(80칸) */
  mayMiss: '규칙이 놓친 값을 AI 요약이 다른 모양으로 바꿔 쓴 것도 찾지 못할 수 있어요.',
  /** 12번 끈 일지 [알림]: 요약을 켜고 만든 끈 일지가 있으면 명령 줄 아래(7칸) */
  offSummary: '요약을 켜고 만든 일지면 --summary도 붙이세요.',
  /**
   * 깨진 요약 저장 파일이 있을 때의 다음: 줄 (PRD S4·A27, DESIGN S4 11번 정리 회차, 취합 20회차 차이 7). 다시 가리기로 고쳐지지 않아서
   * 다시 가리기를 권하지 않아요. 읽지 못한 파일 다음: 바로 다음(없으면 맨 앞)이에요. 80칸에서 `그대로이고,` 다음에 끊겨요.
   */
  brokenNext: '깨진 요약 저장 파일을 지운 뒤 다시 검사하세요. 지워도 일지는 그대로이고, 요약을 켜고 그 날짜를 다시 만들면 요약을 다시 불러요.',
} as const;

/** 1. 패턴 시험의 머리 줄 합계와 잡힌 패턴 목록 앞말 (DESIGN S4 3번, I-10). 앞말 폭(9칸)이 이어지는 줄의 들여쓰기예요. */
export const PATTERN_TEXT = {
  head: (total: number, caught: number, missed: number) => `내장 가짜 값 ${num(total)}개 — 잡힘 ${num(caught)} · 놓침 ${num(missed)}`,
  caughtLead: '   잡힘  ',
} as const;

/** 2. 결과물 재검사 칸 이름 폭: 가장 긴 "이름·이메일 (일지만)"(20칸). 앞 세 칸 + 이 폭 + 두 칸 = 값이 25칸 뒤에서 시작해요. */
const RECHECK_LABEL_W = 20;

export interface CheckReport {
  dataDir: string;
  builtin: Array<{ label: string; caught: boolean }>;
  negatives: Array<{ what: string; intact: boolean }>;
  user: Array<{ name: string; samples: number; caught: number }>;
  /** summaries: 요약 저장 파일 수 (AI 요약, A27). 없거나 0이면 출력에 넣지 않아요(요약을 켠 적이 없으면 지금 모양 그대로). */
  scanned: { worklogs: number; archives: number; summaries?: number };
  markers: { worklog: Counts; archive: Counts };
  /** 요약을 켜고 만든 일지나 요약 저장 파일이 있는지 (S4 "놓칠 수 있는 것" 줄에 AI 요약을 더해요, A27) */
  summaryUsed?: boolean;
  /**
   * 남은 의심: 파일(데이터 폴더 기준) → 줄 번호(0이면 줄 번호 없음) → 종류.
   * code가 있으면 검사가 읽지 못한 파일·폴더예요(kind는 UNREADABLE, code는 EBUSY 같은 원인 코드).
   */
  findings: Array<{ file: string; line: number; kind: string; code?: string }>;
  /**
   * 이름·이메일 가리기가 켜진 일지(날짜 수)와 거기 남은 사용자 이름·이메일. 판정에 넣어요. 수와 위치 목록은 일지 마크다운에서 찾은 자리이고,
   * 같은 날짜 마크다운에 없는 종류가 화면용 일지 데이터에만 남았으면 그 .json을 그 종류 1건(줄 번호 없음)으로 넣어요(PRD A23, I-29).
   */
  identity: { counted: boolean; worklogs: number; userNames: number; emails: number; findings: Array<{ file: string; line: number; kind: string }> };
  /**
   * 이름·이메일 가리기를 끈 일지(날짜 수)와 거기 남은 사용자 이름·이메일 수 (값·위치 없이, A19). 세는 단위는 켠 일지와 같아요(PRD A23).
   * 판정에는 넣지 않아요. 없으면(옛 호출) 세지 않은 것으로 봐요.
   */
  identityOff?: { worklogs: number; userNames: number; emails: number; summaryWorklogs?: number };
  passed: boolean;
  /**
   * 멈춘 보관본 다시 가리기 (A16): unfinished = 파일을 바꾸기 시작한 뒤 멈춰 다시 쓰기 기록이 남음, broken = 기록이 깨져 읽을 수 없음.
   * 검사는 마저 끝내지 않고 지금 파일을 그대로 검사해요. [알림]만 더하고 판정 기준·종료 코드는 그대로예요.
   */
  journal?: PendingNotice;
  /**
   * 마크다운에 남은 의심이 있는데 화면용 데이터에는 그 자리가 가려진 날짜 (한쪽만 가려진 일지, A16·F2-23).
   * 다시 가리기로는 고쳐지지 않아서, 다음: 줄에 그 날짜 일지를 다시 만들라고 알려요.
   */
  mismatched?: RemakeDay[];
  /**
   * 이름·이메일 옵션이 켜진 일지에 사용자 이름·이메일이 남은 날짜 (날짜 순서, 그 일지의 하루 경계). 다음: 줄에 날짜마다 그 일지를
   * 다시 만드는 명령을 보여 줘요. 이름·이메일을 가리려고 다시 만드는 것이라 hideIdentity는 늘 true예요(PRD S4·A10, 취합 15회차 차이 1).
   */
  identityDays?: RemakeDay[];
  /** 다시 만드는 명령을 정할 때 보는 이번 실행의 설정 (지금 하루 경계, 이번 실행에 준 --data-dir·--claude-dir). 없으면 기본 설정으로 봐요. */
  remake?: RemakeContext;
}

function groupFindings(f: CheckReport['findings']): string[] {
  const byFile = new Map<string, { lines: number[]; kinds: Set<string>; unreadable?: string }>();
  for (const x of f) {
    const g = byFile.get(x.file) ?? { lines: [], kinds: new Set<string>() };
    byFile.set(x.file, g);
    // 읽지 못한 파일·폴더는 따로 모아 "줄 …" 칸 자리에 `읽지 못함 (EBUSY)`로 적어요(DESIGN S4 5번).
    if (x.code) {
      g.unreadable ??= x.code;
      continue;
    }
    if (x.line > 0 && !g.lines.includes(x.line)) g.lines.push(x.line);
    g.kinds.add(`${x.kind} 모양`);
  }
  const out: string[] = [];
  const files = [...byFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // 파일 이름 칸을 같은 폭으로 맞춰 "줄 …" 칸이 세로로 줄 서게 해요(경로는 줄이지 않아요).
  const fileW = Math.min(40, Math.max(0, ...files.map(([file]) => displayWidth(file))));
  for (const [file, g] of files) {
    // 읽지 못한 파일·폴더는 처음부터 열지 못했든 읽다 중간에 멈췄든 늘 `읽지 못함 (코드)` 한 줄이에요. 줄 번호·모양과 섞지 않아요.
    // 검사가 그 파일에서 앞서 찾은 의심은 세지 않고 읽지 못함 1건만 남겨서(commands/check.ts의 collectFile) 수와 목록이 맞아요
    // (DESIGN S4 5번 "세는 법", PRD S4, 취합 17회차). 원인 코드를 알 수 없으면 괄호를 빼요. "모양"은 붙이지 않아요(값의 모양을 본 것이 아니라서예요).
    if (g.unreadable !== undefined) {
      // 깨진 요약 저장 파일은 원인 코드 대신 `(깨진 파일)`이에요(PRD S4·A27).
      const why = ERROR_CODE.test(g.unreadable) || g.unreadable === SUMMARY_BROKEN ? `${UNREADABLE} (${g.unreadable})` : UNREADABLE;
      out.push(`     ${padW(file, fileW)}  ${why}`);
      continue;
    }
    const lines = g.lines.length ? `줄 ${g.lines.slice(0, 10).join(', ')}${g.lines.length > 10 ? ' 외' : ''}` : '줄 번호 없음';
    out.push(`     ${padW(file, fileW)}  ${lines} (${[...g.kinds].sort().join(', ')})`);
  }
  return out;
}

export function renderCheckReport(r: CheckReport, stream: NodeJS.WriteStream = process.stdout): string {
  const p = painter(stream);
  const L: string[] = [];
  L.push('cc-worklog 가리기 검사');
  L.push(`검사한 폴더  ${r.dataDir}`);
  L.push('');

  const caught = r.builtin.filter((b) => b.caught).length;
  const missed = r.builtin.length - caught;
  // 패턴 시험 (DESIGN S4 3번, I-10): 합계는 머리 줄 끝에 두고, 놓친 패턴은 지금처럼 한 줄에 하나(내장 순서, 놓침만 빨강),
  // 잡힌 패턴은 `잡힘  ` 뒤에 이름을 내장 순서로 ` · `로 이어요. 80칸을 넘으면 줄 끝에 ·를 남기고 다음 줄은 이름이 시작하는 9칸에 맞춰요.
  // 하나도 잡히지 않았으면 잡힘 줄은 없어요. 패턴마다 잡혔는지·놓쳤는지는 이름과 함께 모두 보여서 PRD S4 "패턴별 시험 결과"와 같아요.
  L.push(`${p.bold('1. 패턴 시험')}  ${PATTERN_TEXT.head(r.builtin.length, caught, missed)}`);
  for (const b of r.builtin) if (!b.caught) L.push(`   ${p.fail('놓침')}  ${b.label}`);
  const caughtLabels = r.builtin.filter((b) => b.caught).map((b) => b.label);
  if (caughtLabels.length > 0) L.push(...wrapParts(caughtLabels, ' · ', PATTERN_TEXT.caughtLead, ' '.repeat(displayWidth(PATTERN_TEXT.caughtLead))));
  const broken = r.negatives.filter((n) => !n.intact);
  if (broken.length === 0) {
    // 괄호에는 실제로 시험한 값의 이름을 모두 적어요. 80칸을 넘으면 이름 덩어리 사이에서 끊고 줄 끝에 ·를 남겨요.
    const names = r.negatives.map((n) => n.what);
    const parts = names.map((n, i) => (i === names.length - 1 ? `${n})은 그대로 남았어요` : n));
    L.push(...wrapParts(parts, '·', `   가리면 안 되는 값 ${num(r.negatives.length)}종(`, '    '));
  } else {
    L.push(`   ${p.fail('잘못 가림')}  ${broken.map((n) => n.what).join(', ')}`);
  }
  if (r.user.length > 0) {
    // 맨 앞 칸(잡힘 / 놓침 / 시험 값 없음)을 같은 폭으로 맞춰 세로로 훑을 수 있게 해요.
    L.push(`   사용자 패턴 ${num(r.user.length)}개`);
    const noSample = '시험 값 없음';
    const stateW = r.user.some((u) => u.samples === 0) ? displayWidth(noSample) : displayWidth('잡힘');
    for (const u of r.user) {
      if (u.samples === 0) L.push(`   ${padW(noSample, stateW)}  ${u.name}`);
      else L.push(`   ${padW(u.caught === u.samples ? '잡힘' : p.fail('놓침'), stateW)}  ${u.name} (시험 값 ${num(u.caught)}/${num(u.samples)})`);
    }
  }
  L.push('');

  const summaries = r.scanned.summaries ?? 0;
  L.push(`${p.bold('2. 결과물 재검사')}  일지 ${num(r.scanned.worklogs)}개 · 보관본 ${num(r.scanned.archives)}개${summaries > 0 ? ` · ${SUMMARY_CHECK_TEXT.scanned(summaries)}` : ''}`);
  if (r.scanned.worklogs + r.scanned.archives + summaries === 0) {
    L.push('   검사할 일지와 보관본이 없어요 — 패턴 시험만 했어요');
  } else {
    // 네 칸의 값은 모두 같은 자리(가장 긴 칸 이름 "이름·이메일 (일지만)" 뒤 두 칸, 25칸째)에서 시작해요.
    const cell = (label: string) => `   ${padW(label, RECHECK_LABEL_W)}  `;
    const valueIndent = ' '.repeat(displayWidth(cell('')));
    // 가린 자리는 "종류 n" 덩어리를 이어요. 80칸을 넘으면 줄 끝에 ·를 남기고 다음 줄을 값 자리에 맞춰요(자르지 않아요).
    const markerRows = (label: string, c: Counts) => {
      const list = sortedCounts(c);
      if (list.length === 0) return [`${cell(label)}없음`];
      return wrapParts(
        list.map(([k, v]) => `${k} ${num(v)}`),
        ' · ',
        cell(label),
        valueIndent,
      );
    };
    L.push(...markerRows('가린 자리 (일지)', r.markers.worklog));
    L.push(...markerRows('가린 자리 (보관본)', r.markers.archive));
    L.push(`${cell('남은 의심')}${num(r.findings.length)}건`);
    L.push(...groupFindings(r.findings));
    // 이름·이메일 (DESIGN S4 5번, PRD S4·A19, I-01): 켠 일지(판정에 넣음)·끈 일지(값·위치 없이 수만) 중 있는 쪽마다 한 줄, 켠 일지 먼저,
    // 그 아래 늘 괄호 줄, 위치 목록은 켠 일지만이에요. 일지가 하나도 없으면 한 줄뿐이에요. 예전 "옵션이 꺼져 있어 세지 않았어요"는 쓰지 않아요.
    const off = r.identityOff;
    const idRows: string[] = [];
    if (r.identity.counted) idRows.push(IDENTITY_TEXT.row('켠', r.identity.worklogs, r.identity.userNames, r.identity.emails));
    if (off && off.worklogs > 0) idRows.push(IDENTITY_TEXT.row('끈', off.worklogs, off.userNames, off.emails));
    if (idRows.length === 0) {
      L.push(`${cell('이름·이메일 (일지만)')}${IDENTITY_TEXT.noWorklogs}`);
    } else {
      idRows.forEach((t, i) => L.push(`${i === 0 ? cell('이름·이메일 (일지만)') : valueIndent}${t}`));
      L.push(`${valueIndent}${IDENTITY_TEXT.rowNote}`);
      if (r.identity.counted) L.push(...groupFindings(r.identity.findings));
    }
  }
  L.push('');
  // 놓칠 수 있는 것 한 줄. 요약을 켰다면 AI가 규칙이 놓친 값을 다른 모양으로 바꿔 쓴 것도 더해요(A27). 80칸을 넘으면 낱말 사이에서 끊어요.
  L.push('참고: 형식 없는 비밀(문장 속 비밀번호 등)과 문장 속 이름은 찾지 못할 수 있어요.');
  if (r.summaryUsed) L.push(`      ${SUMMARY_CHECK_TEXT.mayMiss}`);
  L.push('');
  // 멈춘 다시 가리기: 판정 바로 위에 [알림] 한 덩어리 (80칸을 넘으면 이름표 뒤 위치로 넘겨요).
  // 판정과 함께 읽히는 자리라 "판정은 지금 파일 기준"과 다시 검사하라는 말을 더한 검사 전용 문장이에요(DESIGN S4 9번).
  if (r.journal) {
    L.push(...wrapText(r.journal === 'broken' ? BROKEN_CHECK : UNFINISHED_CHECK, `${p.bold('[알림]')} `, ' '.repeat(7)));
    L.push('');
  }

  const idLeft = r.identity.counted ? r.identity.userNames + r.identity.emails : 0;
  const userMissed = r.user.filter((u) => u.samples > 0 && u.caught < u.samples).length;
  const head = `남은 의심 ${num(r.findings.length)}건, 놓친 패턴 ${num(missed + userMissed)}개`;
  const extras = [broken.length ? `잘못 가린 값 ${num(broken.length)}종` : '', idLeft ? `남은 이름·이메일 ${num(idLeft)}건` : ''].filter(Boolean);
  if (r.passed) {
    L.push(`${p.ok('[통과]')} ${head}`);
  } else {
    L.push(`${p.fail('[실패]')} ${head}${extras.length ? `, ${extras.join(', ')}` : ''}`);
    // 실패 원인마다 다음: 줄 하나씩, 이 순서로 더해요. 80칸을 넘으면 "다음:" 뒤 위치에 맞춰 다음 줄로 넘겨요.
    // 검사가 읽지 못한 파일이 있으면 맨 먼저, 다시 가리기가 아니라 그 파일을 연 프로그램을 닫거나 권한을 확인한 뒤 다시 검사하라고 안내해요.
    // 다시 가리기도 그 파일을 읽지 못해 [실패]로 멈추기 때문이에요(PRD S4, 취합 13회차 차이 5). 통과·실패 기준은 그대로예요.
    // 남은 의심은 (필요하면 사용자 패턴을 더한 뒤) 보관본 다시 가리기로 고쳐요(PRD S4, A16). 읽지 못한 파일만 있으면 이 줄은 넣지 않아요.
    // 남은 의심 중 한쪽만 가려진 일지에 있는 것은 다시 가리기로 고쳐지지 않을 수 있어서, 다시 가리기 다음: 줄 뒤에 그 날짜 일지를 다시 만드는
    // 명령을 더해요. 다시 가리기 다음: 줄은 지우지 않아요. 보관본이 먼저 지금 규칙으로 가려져 있어야 다시 만든 일지에도 반영되기 때문이에요
    // (PRD S4 "안내도 함께", A16, DESIGN S4 11번). 그래서 "다시 가리기 → 그 날짜 일지 다시 만들기 → 다시 검사" 순서로 읽혀요.
    // 명령은 그 일지를 만든 설정과 같게 다시 만드는 명령이고, 명령 아래에 --root·--claude-dir 한 줄을 둬요(PRD S4, Q22·Q23·Q24).
    // 이름·이메일 옵션이 켜진 일지에 남은 사용자 이름·이메일도 날짜마다 같은 규칙의 명령과 안내 한 줄이에요. 이때는 --hide-identity가
    // 늘 붙어요(identityDays의 hideIdentity, PRD S4·A10, 취합 15회차 차이 1).
    // 같은 날짜가 두 안내에 다 걸리면 명령은 그 날짜에 한 줄만이에요(DESIGN S4 11번 "두 안내에 다 걸린 날짜", 취합 17회차).
    //  - 그 날짜의 명령은 먼저 나오는 한쪽만 가려진 일지 다음: 아래에만 두고, 그 일지를 옵션을 끄고 만들었어도 --hide-identity를 붙여요
    //    (한 번 실행으로 둘 다 고쳐지고, 더 가리는 쪽이라 새어 나가는 것이 없어요). 나머지 옵션은 두 안내가 같은 규칙이라 그대로예요.
    //  - 남은 이름·이메일 다음:에는 문장 바로 다음(여섯 칸)에 "위에 명령이 있는 날짜(…)는 …" 한 줄을 두고, 그 밖의 날짜만 명령으로 둬요.
    //    그 밖의 날짜가 없으면 명령 줄과 안내 한 줄 없이 문장과 이 한 줄만이에요.
    //  - S3 한쪽만 가려진 일지 [알림]의 명령은 이름·이메일을 세지 않아서 전처럼 그 일지 설정만 따라요(term/s3-redact.ts).
    const mismatched = r.mismatched ?? [];
    const identityDays = r.identityDays ?? [];
    const remake = r.remake ?? { dayStartHour: DEFAULT_DAY_START };
    const mismatchedDates = new Set(mismatched.map((d) => d.date));
    const identityDates = new Set(identityDays.map((d) => d.date));
    const overlapDates = identityDays.filter((d) => mismatchedDates.has(d.date)).map((d) => d.date);
    const identityOnly = identityDays.filter((d) => !mismatchedDates.has(d.date));
    // 읽지 못한 파일 중 깨진 요약 저장 파일은 프로그램을 닫거나 권한을 고쳐도 풀리지 않아서 다음: 줄을 따로 둬요(PRD S4·A27, 취합 20회차 차이 7).
    const unreadable = r.findings.some((f) => f.code && f.code !== SUMMARY_BROKEN);
    const brokenSummary = r.findings.some((f) => f.code === SUMMARY_BROKEN);
    const suspects = r.findings.some((f) => !f.code);
    const steps: Array<{ text: string; note?: string; commands?: string[]; after?: string }> = [
      { text: unreadable ? UNREADABLE_NEXT : '' },
      { text: brokenSummary ? SUMMARY_CHECK_TEXT.brokenNext : '' },
      { text: suspects ? '필요하면 사용자 패턴을 더한 뒤 cc-worklog redact를 실행하고 다시 검사하세요.' : '' },
      {
        text:
          mismatched.length > 0
            ? '아래 날짜의 일지는 .md와 화면용 .json 중 한쪽만 가려져 있어서 다시 가리기로 고쳐지지 않을 수 있어요. 그 날짜 일지를 다시 만든 뒤 다시 검사하세요.'
            : '',
        commands: mismatched.map((d) => remakeCommand(identityDates.has(d.date) ? { ...d, hideIdentity: true } : d, remake)),
        after: REMAKE_HINT,
      },
      { text: userMissed > 0 ? 'patterns.json에서 놓친 사용자 패턴이나 시험 값을 고친 뒤 다시 검사하세요.' : '' },
      {
        text: idLeft > 0 ? IDENTITY_NEXT : '',
        note: overlapDates.length > 0 ? `위에 명령이 있는 날짜(${overlapDates.join(', ')})는 그 명령이 이름·이메일도 가려요.` : undefined,
        commands: identityOnly.map((d) => remakeCommand({ ...d, hideIdentity: true }, remake)),
        after: identityOnly.length > 0 ? REMAKE_HINT : undefined,
      },
      { text: missed > 0 || broken.length > 0 ? '내장 규칙 문제예요. 도구를 새 버전으로 바꾼 뒤 다시 검사하세요.' : '' },
    ].filter((s) => s.text);
    for (const step of steps) {
      L.push(...wrapText(step.text, '다음: ', '      '));
      // 두 안내에 다 걸린 날짜 한 줄은 문장 바로 다음, "다음:" 뒤 위치(여섯 칸)예요. 80칸을 넘으면 낱말 사이에서 끊어 같은 자리에 맞춰요.
      if (step.note) L.push(...wrapText(step.note, '      ', '      '));
      // 명령은 한 줄에 하나씩, S3 끝 ④의 명령 줄과 같은 자리(여덟 칸)에 둬요. 경로가 든 명령 줄은 줄이지 않아요.
      for (const c of step.commands ?? []) L.push(`        ${c}`);
      // 명령 아래 한 줄은 "다음:" 뒤 위치(여섯 칸)예요.
      if (step.after) L.push(...wrapText(step.after, '      ', '      '));
    }
  }
  // 끈 일지의 이름·이메일 [알림] (DESIGN S4 12번, PRD S4·A19, I-01): 끈 일지에 1건 이상이면 통과·실패와 관계없이 판정(실패면 마지막 다음:)
  // 다음 빈 줄 하나 뒤 맨 끝에 둬요. 판정·종료 코드는 그대로예요. 문장은 7칸에서 낱말 사이 줄바꿈, 명령 모양은 9칸(끊지 않아요),
  // 그 아래 7칸에 다른 다시 만드는 명령과 같은 안내 한 줄이에요.
  const off = r.identityOff;
  if (off && off.userNames + off.emails > 0) {
    L.push('');
    L.push(...wrapText(IDENTITY_TEXT.offNotice(off.worklogs, off.userNames, off.emails), `${p.bold('[알림]')} `, ' '.repeat(7)));
    L.push(`${' '.repeat(9)}${IDENTITY_TEXT.offCommand(r.remake ?? { dayStartHour: DEFAULT_DAY_START })}`);
    // 명령 모양은 날짜 자리를 바꿔 넣는 한 줄이라 일지마다 다른 --summary를 붙일 수 없어서 글로 알려요(DESIGN S4 12번, PRD A28).
    if ((off.summaryWorklogs ?? 0) > 0) L.push(`${' '.repeat(7)}${SUMMARY_CHECK_TEXT.offSummary}`);
    L.push(...wrapText(REMAKE_HINT, ' '.repeat(7), ' '.repeat(7)));
  }
  return `${L.join('\n')}\n`;
}
