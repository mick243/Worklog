// S3 실행 요약 (터미널) — 보관본 다시 가리기 (F2, A16)
// 다시 쓰기 전에 확인을 묻는 출력(바뀔 자리 목록)과 결과 출력이에요. DESIGN S3 "다. 보관본 다시 가리기" 모양이에요.
// 값은 어떤 줄에도 넣지 않고 파일 위치·종류·개수만 보여 줘요. 사용자 패턴은 패턴마다 따로 세요.
import { dataPaths } from '../config.js';
import type { RecoveryResult } from '../redact/journal.js';
import { sortedCounts, totalCount, type Counts } from '../redact/redact.js';
import type { AccessProblem, CommitResult, FilePlan, RedactPlan } from '../redact/reredact.js';
import { BUILTIN_RULES, NAMED_SECRET_LABEL } from '../redact/rules.js';
import { num } from '../util/text.js';
import { REMAKE_HINT, remakeCommand } from '../worklog/mismatch.js';
import { displayWidth, padW, wrapParts, wrapText, type Painter } from './format.js';
import { BROKEN_NOTICE, BROKEN_WHY } from './notices.js';

const LABEL_W = 12;
const SUB = ' '.repeat(LABEL_W + 2);
/** 이름표([알림]·[경고]·[취소]·[실패]) 뒤 위치 */
const AFTER_TAG = ' '.repeat(7);
const BUILTIN_LABELS = new Set([...BUILTIN_RULES.map((r) => r.label), NAMED_SECRET_LABEL]);
/** 바뀔 보관본 줄의 표시 칸. 원본이 지워져 되돌릴 수 없는 보관본에만 적고, 아니면 같은 폭의 빈칸이에요. */
const GONE = '원본 없음';

export const REDACT_COMMAND = 'cc-worklog redact';
export const CHECK_TEXT = '공개 전에 cc-worklog check로 확인하세요';

/** S3 마지막 줄 (일지 만들기·보관·다시 가리기 공통): 검사 명령 안내 */
export function checkLine(p: Painter): string {
  return `${p.bold(padW('검사', LABEL_W))}${CHECK_TEXT}`;
}

function row(p: Painter, label: string, value: string): string {
  return `${p.bold(padW(label, LABEL_W))}${value}`;
}

function kindName(label: string, userPatterns: string[]): string {
  return userPatterns.includes(label) && !BUILTIN_LABELS.has(label) ? `${label} (사용자 패턴)` : label;
}

const isArchive = (f: FilePlan) => f.kind === 'archive';
const dayOf = (f: FilePlan) => f.rel.replace(/\.(md|json)$/, '');

/** 보관본·일지로 나눠 세요. 일지는 날짜 하나에 .md와 화면용 .json이 있어서 날짜 수로 세요. */
function split(files: FilePlan[]) {
  const archives = files.filter(isArchive).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // 날짜 순서, 같은 날짜는 .md 다음 .json
  const worklogs = files
    .filter((f) => !isArchive(f))
    .sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : a.kind === 'worklog-md' ? -1 : 1));
  const sum = (xs: FilePlan[]) => xs.reduce((n, f) => n + f.total, 0);
  return {
    archives,
    worklogs,
    days: new Set(worklogs.map(dayOf)).size,
    archiveTotal: sum(archives),
    worklogTotal: sum(worklogs),
    gone: archives.filter((f) => !f.originalExists).length,
  };
}

function kindRows(counts: Counts, userPatterns: string[]): string[] {
  const list = sortedCounts(counts).map(([k, v]) => [kindName(k, userPatterns), v] as const);
  const kw = Math.min(30, Math.max(0, ...list.map(([k]) => displayWidth(k))));
  return list.map(([k, v]) => `${SUB}${padW(k, kw)}  ${num(v)}`);
}

/** 한쪽만 가려진 일지를 다시 만드는 명령 한 줄의 들여쓰기 (9번 [알림] 안, 이름표 뒤 위치 + 2칸 = 9칸, DESIGN 다 9번) */
const REMAKE_INDENT = ' '.repeat(9);

/**
 * 9번 [알림] 덩어리. 순서: 마무리(마저 끝냄·되돌림) → 깨진 기록 → (끝 ⑤에서 묻지 않고 지웠으면) 정리 → 고칠 수 없는 의심
 * → 그중 한쪽만 가려진 일지 (날짜와 다시 만드는 명령).
 * clearedStaged: 끝 ⑤에서 깨진 다시 쓰기 기록을 묻지 않고 지웠으면 함께 지운 임시 파일 수 (A16, Q21)
 * countedAll: 바뀔 자리를 끝까지 셌는지. 읽거나 쓰지 못한 파일이 있어 멈출 때(false)는 수가 틀릴 수 있어 고칠 수 없는 의심 [알림]들을 빼고,
 *   깨진 기록 [알림]도 "다시 셌어요" 대신 일지 만들기·보관 [알림]의 앞 두 문장으로 끝내요(DESIGN S3 다 오류 "읽거나 쓰지 못한 파일" ①).
 */
function notices(p: Painter, plan: RedactPlan, recovered?: RecoveryResult, clearedStaged?: number, countedAll = true): string[] {
  const suspects = countedAll;
  const out: string[] = [];
  const notice = (text: string) => out.push(...wrapText(text, `${p.bold('[알림]')} `, AFTER_TAG));
  if (recovered?.action === 'rolled-forward') notice(`지난번에 멈춘 보관본 다시 가리기를 마저 끝냈어요 (파일 ${num(recovered.files)}개).`);
  if (recovered?.action === 'rolled-back') notice('지난번에 멈춘 보관본 다시 가리기를 되돌렸어요. 그때 바뀐 파일은 없어요.');
  // 다시 쓰기 기록이 깨졌으면 기록과 남은 임시 파일을 읽지 않고, 지금 보관본·일지 파일로 바뀔 자리를 다시 셌어요(A16, Q21).
  // 깨진 기록에서 시작한 지난번 다시 가리기를 방금 되돌려 "깨짐" 표시를 다시 남긴 경우도 같아요(되돌림 [알림] 바로 다음, A16).
  // 읽거나 쓰지 못한 파일 때문에 끝까지 세지 못하고 멈출 때는 "다시 셌어요"가 맞지 않아서, 깨진 기록이 뜻하는 것만 알려요(새 문장 없음).
  // 할 일은 이어지는 [실패]의 다음: 줄이 알려요.
  if (recovered?.broken) {
    notice(countedAll ? `${BROKEN_NOTICE} 그래서 이번 실행은 지난번 기록 없이 지금 파일로 바뀔 자리를 다시 셌어요.` : `${BROKEN_NOTICE} ${BROKEN_WHY}`);
  }
  // 끝 ⑤: 깨진 기록 [알림] 바로 다음에 정리했다고 알려요. 고칠 수 없는 의심 [알림]은 그 뒤예요(DESIGN 끝 ⑤).
  if (clearedStaged !== undefined) notice(clearedText(clearedStaged, '지워 정리했어요. 모든 파일이 이미 지금 규칙에 맞아요.'));
  if (suspects && plan.unfixable > 0) {
    notice(
      `다시 가리기로 고칠 수 없는 의심 ${num(plan.unfixable)}건은 그대로 남아요 (날짜·시각·해시 같은 칸, 읽을 수 없는 줄, 손으로 고친 일지 줄 등). cc-worklog check가 계속 위치를 알려 줘요.`,
    );
  }
  // 그중 마크다운과 화면용 데이터 중 한쪽만 가려진 일지(이전 판에서 생긴 어긋남)에 걸린 것은 고치는 법을 알려요(PRD S3·A16, F2-23, DESIGN 다 9번).
  // 고칠 수 없는 의심 [알림]과 같은 덩어리 안, 다음 줄(이름표 뒤 위치)에 이어 쓰고, 그 아래 날짜마다 다시 만드는 명령(이름표 뒤 + 2칸)을 둬요.
  // 명령에 날짜가 들어 있어서 날짜를 따로 나열하지 않아요. (한쪽만 가려진 의심은 고칠 수 없는 의심에 들어 있어서 위 [알림]이 늘 먼저 있어요.)
  // 명령은 그 일지를 만든 설정과 같게 다시 만드는 명령이에요(--hide-identity·--day-start N·이번 실행의 --data-dir·--claude-dir, PRD Q22·Q23).
  // 명령 아래에는 일지에 남지 않아 붙일 수 없는 --root·--claude-dir를 알리는 한 줄을 이름표 뒤 위치에 둬요(PRD Q24).
  // 경로가 든 명령 줄은 줄이지 않아요(80칸을 넘을 수 있어요).
  if (suspects && plan.mismatched.length > 0) {
    const n = plan.mismatched.reduce((a, d) => a + d.suspects, 0);
    out.push(...wrapText(`그중 ${num(n)}건은 .md와 화면용 .json 중 한쪽만 가려진 일지에 있어요. 아래 명령으로 그 날짜 일지를 다시 만들면 고쳐져요.`, AFTER_TAG, AFTER_TAG));
    for (const d of plan.mismatched) out.push(`${REMAKE_INDENT}${remakeCommand(d, plan.remake)}`);
    out.push(...wrapText(REMAKE_HINT, AFTER_TAG, AFTER_TAG));
  }
  return out;
}

/** 머리 줄 + 데이터 폴더, 빈 줄, 읽음·규칙 */
function head(plan: RedactPlan, p: Painter): string[] {
  return [
    'cc-worklog 보관본 다시 가리기',
    row(p, '데이터 폴더', plan.dataDir),
    '',
    row(p, '읽음', `보관본 ${num(plan.scanned.archives)}개 · 일지 ${num(plan.scanned.worklogDays)}개`),
    row(p, '규칙', `내장 ${num(plan.builtinRules)}개 · 사용자 패턴 ${num(plan.userPatterns.length)}개`),
  ];
}

/** 깨진 다시 쓰기 기록을 지운 뒤의 한 문장. staged는 함께 지운 새 내용 임시 파일 수예요. */
function clearedText(staged: number, tail: string): string {
  return `깨진 다시 쓰기 기록${staged > 0 ? `과 남은 임시 파일 ${num(staged)}개를` : '을'} ${tail}`;
}

/**
 * 끝 ⑤ 바뀔 자리가 하나도 없을 때 (묻지 않고 끝나요, 종료 코드 0).
 * clearedStaged: 다시 쓰기 기록이 깨져 있어 묻지 않고 지웠으면 함께 지운 임시 파일 수 (A16, Q21)
 */
export function renderRedactNothing(plan: RedactPlan, p: Painter, recovered?: RecoveryResult, clearedStaged?: number): string {
  const L = head(plan, p);
  const none = plan.scanned.archives + plan.scanned.worklogDays === 0;
  L.push(row(p, '바뀔 자리', none ? '0개 — 다시 가릴 보관본과 일지가 없어요.' : '0개 — 이미 지금 규칙으로 가려져 있어요. 바뀐 파일은 없어요.'));
  const n = notices(p, plan, recovered, clearedStaged);
  if (n.length) L.push('', ...n);
  L.push('', checkLine(p));
  return `${L.join('\n')}\n`;
}

/**
 * 바뀔 자리 목록 (다시 쓰기 전): 바뀔 보관본·일지마다 한 줄(바뀔 자리 수 · 원본 없음 표시 · 경로),
 * 종류별 합계, 되돌릴 수 없는 보관본이 있으면 [경고]. 이 뒤에 확인 질문·--yes 안내·[취소] 중 하나가 이어져요.
 */
export function renderRedactPlan(plan: RedactPlan, p: Painter, recovered?: RecoveryResult): string {
  const L = head(plan, p);
  const s = split(plan.files);
  const numW = Math.max(1, ...plan.files.map((f) => num(f.total).length));
  const fileLine = (f: FilePlan) => {
    const n = num(f.total);
    const mark = isArchive(f) && !f.originalExists ? GONE : '';
    return `   ${' '.repeat(numW - n.length)}${n}  ${padW(mark, displayWidth(GONE))}  ${f.rel}`;
  };

  L.push('');
  if (s.archives.length > 0) {
    L.push(row(p, '바뀔 보관본', `${num(s.archives.length)}개 (${GONE} = 원본이 지워져 되돌릴 수 없어요)`));
    L.push(...s.archives.map(fileLine));
  }
  if (s.worklogs.length > 0) {
    L.push(row(p, '바뀔 일지', `${num(s.days)}개 (날짜 수 · .md와 화면용 .json을 한 줄씩)`));
    L.push(...s.worklogs.map(fileLine));
  }
  const total = `모두 ${num(totalCount(plan.totals))}개 (보관본 ${num(s.archiveTotal)} · 일지 ${num(s.worklogTotal)})`;
  L.push(...wrapParts([total, '값은 보여 주지 않아요'], ' · ', p.bold(padW('바뀔 자리', LABEL_W)), ' '.repeat(LABEL_W)));
  L.push(...kindRows(plan.totals, plan.userPatterns));
  L.push('');

  const n = notices(p, plan, recovered);
  L.push(...n);
  if (s.gone > 0) {
    if (n.length) L.push('');
    L.push(...wrapText(`원본이 지워진 보관본 ${num(s.gone)}개는 다시 쓰면 옛 내용으로 되돌릴 수 없어요.`, `${p.warn('[경고]')} `, AFTER_TAG));
    L.push(...wrapText('옛 내용은 백업하지 않아요. 백업에도 놓친 비밀 값이 남기 때문이에요.', AFTER_TAG, AFTER_TAG));
  }
  return `${L.join('\n')}\n`;
}

/** 끝 ① 확인 질문 바로 앞 안내 (질문 자체는 redactQuestion으로 따로 물어요) */
export function renderRedactQuestionIntro(): string {
  return '다시 쓰려면 y 또는 예, 그만두려면 그냥 Enter를 누르세요.\n';
}

/** 끝 ① 확인 질문: 늘 출력의 마지막 줄이고, 기본값은 거절이에요. */
export function redactQuestion(plan: RedactPlan): string {
  const s = split(plan.files);
  const what = [s.archives.length ? `보관본 ${num(s.archives.length)}개` : '', s.days ? `일지 ${num(s.days)}개` : ''].filter(Boolean).join('와 ');
  return `${what}를 다시 쓸까요? [y/N] `;
}

/** 끝 ② --yes로 묻지 않고 다시 쓸 때 (질문 대신 한 줄) */
export function renderRedactYes(): string {
  return '--yes를 받아 묻지 않고 다시 써요.\n';
}

export type StopReason = 'rejected' | 'aborted' | 'not-interactive' | 'interrupted';

/**
 * 다시 쓰지 않고 끝날 때 (모두 종료 코드 1). 바뀐 파일이 없고 다음 할 일이 따로 있어서 검사 줄은 찍지 않아요.
 * brokenJournal: 다시 쓰기 기록이 깨진 채 시작했으면 그 기록과 임시 파일을 그대로 뒀다는 것과 다시 실행하라는 안내를 더해요(A16, Q21).
 */
export function renderRedactStopped(reason: StopReason, p: Painter, brokenJournal = false): string {
  const L: string[] = [];
  const cancel = (text: string) => L.push(...wrapText(text, `${p.bold('[취소]')} `, AFTER_TAG));
  const tooWide = () => L.push(...wrapText('패턴이 너무 넓으면 patterns.json을 고친 뒤 다시 실행하세요.', AFTER_TAG, AFTER_TAG));
  const keptBroken = () => {
    if (brokenJournal) L.push(...wrapText('깨진 다시 쓰기 기록은 그대로 남아 있어서 검사·화면의 알림도 계속 나와요.', AFTER_TAG, AFTER_TAG));
  };
  const rerun = () => {
    if (brokenJournal) L.push(...wrapText(`일부만 바뀌었을 수 있는 상태를 맞추려면 ${REDACT_COMMAND}를 다시 실행하세요.`, '다음: ', '      '));
  };
  switch (reason) {
    case 'rejected': // 끝 ③ 그냥 Enter·그 밖의 입력
      L.push('');
      cancel('다시 쓰지 않았어요. 바뀐 파일은 없어요.');
      tooWide();
      keptBroken();
      rerun();
      break;
    case 'aborted': // 질문 중 Ctrl+C·입력 끝 (질문 줄이 줄바꿈 없이 끝나서 빈 줄을 하나 더 둬요)
      L.push('', '');
      cancel('확인 질문을 끊어서 다시 쓰지 않았어요. 바뀐 파일은 없어요.');
      tooWide();
      keptBroken();
      rerun();
      break;
    case 'not-interactive': // 끝 ④ 확인을 물을 수 없음 (질문 두 줄 대신)
      cancel('확인을 물을 수 없는 환경이라 다시 쓰지 않았어요. 바뀐 파일은 없어요.');
      L.push(...wrapText('(입력이나 출력이 터미널이 아니에요. 파이프·리디렉션·CI 등)', AFTER_TAG, AFTER_TAG));
      keptBroken();
      L.push(...wrapText('위 수를 확인한 뒤 --yes를 붙여 다시 실행하세요.', '다음: ', '      '));
      L.push(`        ${REDACT_COMMAND} --yes`);
      break;
    case 'interrupted': // 새 내용을 쓰는 중 Ctrl+C: 그 자리에서 되돌려서 바뀐 파일이 없어요
      return renderRedactAborted('Ctrl+C를 받았어요', 'retry', p);
  }
  return `${L.join('\n')}\n`;
}

/**
 * 확정 전에 멈춤 ([실패], 표준 오류, 종료 코드 1): 새 내용을 쓰는 중 Ctrl+C, 확인한 뒤 파일이 바뀜, 쓰기 오류(ENOSPC 등).
 * 그 자리에서 새로 쓰던 내용을 지워서 바뀐 파일이 없어요. 원인 자리에는 까닭이나 오류 코드만 넣고 파일 내용은 넣지 않아요.
 * next: 'retry'는 Ctrl+C·파일 바뀜, 'write-error'는 쓰기 오류의 다음: 줄이에요.
 */
export function renderRedactAborted(cause: string, next: 'retry' | 'write-error', p: Painter): string {
  const L: string[] = [''];
  L.push(...wrapText(`다시 쓰다 멈췄어요 (${cause})`, `${p.fail('[실패]')} `, AFTER_TAG));
  L.push(...wrapText('파일은 깨지지 않았어요. 새로 쓰던 내용은 지웠고 바뀐 파일은 없어요.', AFTER_TAG, AFTER_TAG));
  const todo =
    next === 'retry'
      ? '다시 실행하면 바뀔 자리를 처음부터 다시 세서 보여 줘요.'
      : '디스크 공간과 폴더 권한을 확인한 뒤 다시 실행하세요. 바뀔 자리를 처음부터 다시 세서 보여 줘요.';
  L.push(...wrapText(todo, '다음: ', '      '));
  return `${L.join('\n')}\n`;
}

/**
 * 읽거나 쓰지 못한 파일이 있어 바뀔 자리를 끝까지 세지 못하고 멈출 때의 표준 출력 부분 (머리 줄·읽음·규칙과, 시작할 때 마무리한 [알림]).
 * 바뀔 자리 목록과 고칠 수 없는 의심 수는 읽지 못한 파일 때문에 틀릴 수 있어서 보여 주지 않아요. 이어서 [실패]가 표준 오류로 나와요.
 * 깨진 기록 [알림]은 `[알림] 다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요. 지난번 보관본 다시 가리기가 일부 파일만 바꾼 채
 * 멈췄을 수 있어요.`예요(끝까지 세지 못해서 "다시 셌어요"로 끝내지 않아요, DESIGN S3 다 오류 ①).
 */
export function renderRedactBlocked(plan: RedactPlan, p: Painter, recovered?: RecoveryResult): string {
  const L = head(plan, p);
  const n = notices(p, plan, recovered, undefined, false);
  if (n.length) L.push('', ...n);
  return `${L.join('\n')}\n`;
}

/** 읽거나 쓰지 못한 파일 [실패]의 공통 다음: 줄 (DESIGN S3 다 오류 "읽거나 쓰지 못한 파일": 셀 때·다시 쓰는 중 확정 전 모두 같아요) */
export const FILE_ACCESS_NEXT = '위 파일을 연 프로그램(편집기·화면·백신 등)을 닫거나 파일 권한을 확인한 뒤 다시 실행하세요.';

/** 파일 위치 한 묶음: 데이터 폴더 기준 상대 경로 + 괄호 원인 코드와 읽기·쓰기 구분 (예: `worklogs/2026-10-19.md (EBUSY · 읽지 못함)`) */
function accessText(x: AccessProblem): string {
  return `${x.rel} (${x.code} · ${x.op === 'read' ? '읽지 못함' : '쓰지 못함'})`;
}

/**
 * 읽거나 쓰지 못한 보관본·일지 파일 ([실패], 표준 오류, 종료 코드 1, PRD S3·A16, F2-23, DESIGN S3 다 오류).
 * 파일마다 데이터 폴더 기준 경로와 원인 코드를 줄이지 않고 모두 보여 줘요. 파일 내용은 넣지 않아요.
 * 데이터 폴더 자체에 쓰지 못한 [실패](--data-dir로 다른 폴더를 고르라는 안내)와 달리, 파일을 잡고 있는 프로그램을 닫으라고 안내해요(공통 다음: 줄).
 * stage
 *  - 'plan': 바뀔 자리를 세다 알아봐서 묻지 않고 멈춘 경우 (DESIGN 가 방식 — 확인 전에 멈춤). 1줄 [실패]와 파일 수 / 파일마다 한 줄 /
 *    `바뀐 파일은 없어요. 다시 실행하면 바뀔 자리를 처음부터 다시 세요.` / 다음: 줄. 셀 때 바뀔 파일을 쓸 수 있는지도 미리 열어 봐서,
 *    모두 읽지 못한 파일이면 DESIGN 문장 그대로 "읽지 못해", 쓰지 못한 파일이 섞이면 "읽거나 쓰지 못해"예요.
 *    brokenJournal: 깨진 다시 쓰기 기록에서 시작했으면 그 기록이 그대로 남아 알림이 이어진다는 것을 더해요(A16, 끝 ③·④와 같은 줄).
 *  - 'commit': 확인한 뒤 확정 전에 알아봐서 그 자리에서 되돌린 경우 ("확정 전에 멈춤"과 같은 세 줄). 한 파일이면
 *    `[실패] 다시 쓰다 멈췄어요 (상대 경로, 코드 · 읽기·쓰기)`, 여럿이면 확정 뒤 모양처럼 `(파일 N개)` 다음 이름표 뒤 위치에 파일마다 한 줄.
 *    깨진 기록에서 시작했어도 문구는 보통 때와 같아요(PRD S3 "그 자리의 [실패] 문구는 보통 때와 같아요"). 알림은 남은 "깨짐" 표시로 이어져요.
 */
export function renderRedactInaccessible(problems: AccessProblem[], stage: 'plan' | 'commit', p: Painter, brokenJournal = false): string {
  const L: string[] = [''];
  if (stage === 'plan') {
    const verb = problems.every((x) => x.op === 'read') ? '읽지 못해' : '읽거나 쓰지 못해';
    L.push(...wrapText(`보관본·일지 파일 ${num(problems.length)}개를 ${verb} 다시 쓰지 않았어요`, `${p.fail('[실패]')} `, AFTER_TAG));
    for (const x of problems) L.push(`${AFTER_TAG}${accessText(x)}`);
    L.push(...wrapText('바뀐 파일은 없어요. 다시 실행하면 바뀔 자리를 처음부터 다시 세요.', AFTER_TAG, AFTER_TAG));
    if (brokenJournal) L.push(...wrapText('깨진 다시 쓰기 기록은 그대로 남아 있어서 검사·화면의 알림도 계속 나와요.', AFTER_TAG, AFTER_TAG));
  } else {
    // 괄호 안 경로는 줄이지 않고 그 줄에 그대로 둬요(경로가 든 줄만 80칸을 넘을 수 있어요).
    if (problems.length === 1) {
      const x = problems[0]!;
      L.push(`${p.fail('[실패]')} 다시 쓰다 멈췄어요 (${x.rel}, ${x.code} · ${x.op === 'read' ? '읽지 못함' : '쓰지 못함'})`);
    } else {
      L.push(`${p.fail('[실패]')} 다시 쓰다 멈췄어요 (파일 ${num(problems.length)}개)`);
      for (const x of problems) L.push(`${AFTER_TAG}${accessText(x)}`);
    }
    L.push(...wrapText('파일은 깨지지 않았어요. 새로 쓰던 내용은 지웠고 바뀐 파일은 없어요.', AFTER_TAG, AFTER_TAG));
  }
  L.push(...wrapText(FILE_ACCESS_NEXT, '다음: ', '      '));
  return `${L.join('\n')}\n`;
}

/**
 * 확정 뒤에 멈춤 ([실패], 표준 오류, 종료 코드 1): 원래 이름으로 바꾸는 중 다른 프로그램이 파일을 잡고 있는 등.
 * 확정한 내용은 되돌리지 않고 다음 실행(cc-worklog·archive·redact)이 마저 끝내요. message는 "다시 쓰기를 마저 끝내지 못했어요 (상대 경로, 코드)"예요.
 * 괄호 안 경로는 줄이지 않고 그 줄에 그대로 둬요(경로가 든 줄만 80칸을 넘을 수 있어요).
 */
export function renderRedactUnfinished(message: string, p: Painter): string {
  const L: string[] = ['', `${p.fail('[실패]')} ${message}`];
  L.push(...wrapText('파일은 깨지지 않았어요. 나머지는 다음 실행 때 마저 끝내요.', AFTER_TAG, AFTER_TAG));
  // check·view는 읽기만 해서 마무리하지 않아요. 마무리 전에 검사 결과를 믿고 공개하지 않게 알려요(DESIGN S3).
  L.push(...wrapText('마저 끝낼 때까지 화면과 검사는 일부만 바뀐 모습을 보여 줄 수 있어요.', AFTER_TAG, AFTER_TAG));
  L.push(...wrapText('데이터 폴더의 파일을 연 프로그램(편집기·화면 등)을 닫고 다시 실행하면 이어서 끝내요.', '다음: ', '      '));
  return `${L.join('\n')}\n`;
}

/**
 * 끝 ② 다시 쓴 뒤 결과 (종료 코드 0). 새로 가림은 위 바뀔 자리와 같은 모양이라 두 수를 바로 견줄 수 있어요.
 * clearedStaged: 확인 뒤 깨진 다시 쓰기 기록을 지웠으면 함께 지운 임시 파일 수 (A16, Q21)
 */
export function renderRedactResult(r: CommitResult, plan: RedactPlan, p: Painter, clearedStaged?: number): string {
  const s = split(r.files);
  const dirs = dataPaths(plan.dataDir);
  const L: string[] = [''];
  L.push(row(p, '다시 씀', `보관본 ${num(s.archives.length)}개 · 일지 ${num(s.days)}개`));
  L.push(row(p, '새로 가림', `모두 ${num(totalCount(r.totals))}개 (보관본 ${num(s.archiveTotal)} · 일지 ${num(s.worklogTotal)})`));
  L.push(row(p, '옛 내용', '남기지 않았어요 (임시·백업 파일 없음)'));
  L.push('');
  if (clearedStaged !== undefined) {
    // 끝 ②: 확인 뒤 깨진 기록과 남은 임시 파일을 지웠으면 알려요. 지웠으니 검사·화면의 알림도 사라져요(DESIGN 끝 ②).
    L.push(...wrapText(clearedText(clearedStaged, '지웠어요. 검사·화면의 알림도 더는 나오지 않아요.'), `${p.bold('[알림]')} `, AFTER_TAG), '');
  }
  // 화면은 데이터 폴더를 읽기만 해서 다시 열 필요가 없으니 화면 줄은 찍지 않아요.
  L.push(row(p, '결과', '보관 폴더'), `${SUB}${dirs.archiveDir}`, `${' '.repeat(LABEL_W)}일지 폴더`, `${SUB}${dirs.worklogsDir}`);
  L.push(checkLine(p));
  return `${L.join('\n')}\n`;
}
