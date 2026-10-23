// S3 실행 요약 (터미널)
// 일지 만들기·보관 명령이 끝난 뒤의 출력이에요. 비밀 값 원문은 어떤 줄에도 나오지 않아요.
import type { ArchiveResult } from '../archive/archive.js';
import type { RootOrigin } from '../config.js';
import type { RootIssue } from '../git/repo.js';
import type { RecoveryResult } from '../redact/journal.js';
import { sortedCounts, totalCount, type Counts } from '../redact/redact.js';
import { FORMAT_BASELINE } from '../session/format.js';
import { FAIL_REASONS, type FailReason } from '../summary/claude.js';
import type { StoreWriteFailure } from '../summary/run.js';
import { num } from '../util/text.js';
import { displayWidth, padW, painter, wrapParts, wrapText, type Painter } from './format.js';
import { BROKEN_FULL } from './notices.js';
import { checkLine } from './s3-redact.js';

export interface RunSummary {
  mode: 'make' | 'archive';
  date?: string;
  dayStartHour: number;
  archive: ArchiveResult;
  /** make일 때만 */
  day?: {
    sessions: number;
    subagentFiles: number;
    repos: number;
    commits: number;
    redactions: Counts;
    identity: Counts;
    gitAvailable: boolean;
    mdPath: string | null;
  };
  hideIdentity: boolean;
  viewCommand: string;
  /** 세션 기록 폴더 (없을 때 [알림]에 찾아본 경로로 보여 줘요) */
  projectsDir: string;
  /** 시작할 때 지난번에 멈춘 보관본 다시 가리기를 마무리했는지 (broken이면 다시 쓰기 기록이 깨져 마무리하지 못했어요) */
  recovered?: RecoveryResult;
  /** make일 때만: --root·config.json의 roots 중 건너뛴 경로 (F1-20, A4). 경로마다 [알림]을 띄워요. */
  rootIssues?: RootIssue[];
  /** 건너뛴 경로가 어디서 왔는지 (resolve한 경로 → --root / config.json) */
  rootOrigins?: Record<string, RootOrigin>;
  /** 상위 폴더 아래를 몇 단계까지 찾았는지 (저장소를 찾지 못한 경로 [알림]에 써요) */
  rootDepth?: number;
  /** make일 때만: 만든 날짜와 건너뛴 날짜 (A18·A20·A21) */
  make?: MakeSummary;
  /** make일 때만: AI 요약 한 줄 (A24·A28). 요약을 끈 실행은 남은 세션·빠진 날짜 안내만 나올 수 있어요. */
  summary?: SummaryRunInfo;
}

/** 읽지 못하거나 깨진 요약 저장 파일 하나 (S3 [알림], A27). 파일 내용은 담지 않아요. */
export interface StoreProblem {
  /** 절대 경로 */
  path: string;
  /** 원인 코드(EBUSY 등). 열었는데 내용을 읽을 수 없으면(깨진 파일) 없어요. */
  code?: string;
}

/** S3에 보여 줄 AI 요약 결과 (A24·A27·A28). 출력·오류 원문과 요약 글은 담지 않아요(수만). */
export interface SummaryRunInfo {
  /** 이번 실행이 요약을 켰는지 (--summary 또는 config.json의 summary) */
  on: boolean;
  /** 요약 대상 세션 수 (이번 실행이 쓴 요약 일지의 세션 중 그날 요청·답변 글이 있는 세션). 요약한 + 못 한 = 대상이에요. */
  targets: number;
  /** 새로 불러 받은 요약 수 */
  newly: number;
  /** 요약 저장 파일에서 다시 쓴 요약 수 (그날 줄이 늘지 않은 세션) */
  reused: number;
  /** 요약하지 못한 세션 수 (까닭별, 0인 까닭은 보여 주지 않아요) */
  failed: Record<FailReason, number>;
  /** 50번 상한으로 미룬 세션 수 (못 한 세션의 첫 까닭). 이번에 쓴 일지의 세션만이에요. */
  deferred: number;
  /**
   * 이번 실행이 상한에 닿았는지 (PRD A24 "상한에 닿음", 취합 20회차 차이 2): claude를 50번 실행했고 부를 세션이 더 남았어요.
   * 남은 세션이 이번에 다시 만들지 않은 요약 일지(A18 ③)에만 있어도 닿은 거예요. 그래서 deferred가 0이어도 true일 수 있어요.
   * 없으면(옛 호출) deferred > 0으로 봐요.
   */
  capReached?: boolean;
  /** 가린 대화 글을 Claude Code로 보낸 세션 수 (실행한 세션 중 보내기 전에 멈춘 것이 확실한 세션(찾지 못함·로컬 로그인 안 됨)을 뺀 수, A28) */
  sent: number;
  /** 이번 실행 뒤에도 요약이 빈 채 남은 세션 수와 그 일지(날짜) 수 (기본 실행이면 다시 만들지 않은 요약 일지 포함) */
  remaining: { sessions: number; days: number } | null;
  /** 요약을 켜고 만든 일지를 요약을 끈 채 다시 만들어 요약 줄이 빠진 날짜 (A28 ①, --date·--from) */
  droppedDays: string[];
  /** 읽지 못하거나 깨진 요약 저장 파일 (저장한 요약이 없는 것으로 봤어요, A27) */
  storeProblems: StoreProblem[];
  /** 받은 요약을 쓰지 못한 요약 저장 파일 (날짜 순서, 파일마다 쓰지 못한 요약 수와 원인 코드). 받은 요약은 일지에 넣었어요(A27). */
  storeWriteFailed: StoreWriteFailure[];
  /** 남은 세션 안내를 보여 줄지 (요약을 켠 실행, 또는 요약을 끈 기본 실행, A24·A28 ②) */
  showRemaining: boolean;
  /**
   * 찾지 못함·로그인 안 됨·사용량 제한으로 남은 세션을 부르지 않고 멈췄으면 그 까닭과, 그 까닭으로 부르지 않은 세션 중 이번에 쓰지 않은
   * 요약 일지(기본 실행이 다시 만들지 않은 A18 ③ 일지)에 있는 수예요(취합 22회차 차이 1). S3 수에 넣는 규칙은 summaryCounts 한 곳이에요.
   * 없으면(옛 호출·멈추지 않음) 지금처럼 이번에 쓴 일지의 수만 보여 줘요.
   */
  halted?: { reason: FailReason; outside: number } | null;
}

/**
 * S3 `AI 요약` 칸 1·2줄과 이유별 [알림]에 쓰는 수 (PRD S3·A28, 취합 22회차 차이 1). 수를 세는 규칙을 바꿀 때는 여기만 바꾸면 돼요.
 * 기본은 이번에 쓴 일지의 요약 대상 세션 수예요(DESIGN S3 가·나 "이 절의 말", 요약한 + 못 한 = 요약 대상).
 * 찾지 못함·로그인 안 됨·사용량 제한으로 멈췄는데 이번에 쓴 일지의 못 한 세션에 그 까닭이 하나도 없으면(쓴 일지가 없음, 쓴 일지의 요약 대상이 0,
 * 쓴 일지의 세션은 모두 저장해 둔 요약 등 — claude를 찾지 못하면 한 세션도 꺼내지 않아 ③ 일지를 다시 만들지 않아서 생겨요), 그 까닭으로
 * 부르지 않은 세션(다시 만들지 않은 ③ 일지의 빈 세션)을 그 까닭의 수로 세고 요약 대상에도 더해요. 그래야 까닭과 할 일([알림])이 빠지지 않고
 * `요약할 세션이 없었어요`로 보이지 않으며, 요약한 + 못 한 = 요약 대상도 맞아요. 그 세션들은 남은 세션 줄에도 그대로 들어요.
 * 쓴 일지에 그 까닭이 1개 이상이면 더하지 않아요(로그인 안 됨·사용량 제한의 지금 수, `50번 상한으로 미룸`이 쓴 일지만 세는 규칙과 맞춰요).
 * (DESIGN 6장 "정리 회차" 끝 "덧붙임 — 멈춘 이유가 쓴 일지 밖에만 있을 때", S3 가·나 6-1 2줄·10번, 2026-10-23)
 */
export function summaryCounts(sm: SummaryRunInfo): { targets: number; failed: Record<FailReason, number> } {
  const failed = { ...sm.failed };
  let targets = sm.targets;
  const h = sm.halted;
  if (h && h.outside > 0 && failed[h.reason] === 0) {
    failed[h.reason] = h.outside;
    targets += h.outside;
  }
  return { targets, failed };
}

/** 못 한 세션의 까닭 순서 (DESIGN S3 가·나 6-1 2줄): 50번 상한으로 미룸 → 찾지 못함 → 로그인 안 됨 → 사용량 제한 → 시간 초과 → 그 밖의 실패 */
export const SUMMARY_REASON_ORDER: ReadonlyArray<FailReason | 'deferred'> = ['deferred', 'not-found', 'auth', 'rate-limit', 'timeout', 'other'];

/**
 * AI 요약 문구 (PRD A24·A27·A28, DESIGN S3 가·나 6-1·6-2·10번·로딩·오류 글자 그대로). 문구를 바꿀 때는 여기만 바꾸면 돼요.
 * 위험이 아니라 예상한 동작이라 [경고]를 쓰지 않아요.
 */
export const SUMMARY_TEXT = {
  /** 6-1 칸 이름 (S3 전체가 "실행 요약"이라 `요약`만 쓰면 헷갈려서 `AI 요약`) */
  label: 'AI 요약',
  /** 6-1 1줄 (켠 실행): 요약한 세션 = 새로 부름 + 저장해 둔 요약, 괄호 안은 0인 덩어리를 빼요 */
  onHead: (summarized: number) => `켜짐 — 요약한 세션 ${num(summarized)}개`,
  onParts: (newly: number, reused: number) => [newly ? `새로 부름 ${num(newly)}개` : '', reused ? `저장해 둔 요약 ${num(reused)}개` : ''].filter(Boolean),
  /** 6-1 1줄: 요약 대상 세션이 하나도 없음 */
  noTargets: '켜짐 — 요약할 세션이 없었어요',
  /** 6-1 2줄: 못 한 세션 (까닭은 SUMMARY_REASON_ORDER 순서, 0인 까닭은 빼요) */
  failedHead: (total: number) => `(못 한 세션 ${num(total)}개 — `,
  reason: {
    deferred: '50번 상한으로 미룸',
    'not-found': 'claude를 찾지 못함',
    auth: '로그인 안 됨',
    'rate-limit': '사용량 제한',
    timeout: '시간 초과',
    other: '그 밖의 실패',
  } as Record<FailReason | 'deferred', string>,
  /** 6-1 3줄: 남은 세션 (상한에 닿았는지에 따라 두 모양) */
  remainingCap: (sessions: number, days: number) =>
    `이번 실행은 claude 50번 상한에 닿아 요약이 빈 세션 ${num(sessions)}개(일지 ${num(days)}개)가 남았어요. 다음에 요약을 켜고 실행하면 최근 날짜부터 이어서 채워요.`,
  remaining: (sessions: number, days: number) =>
    `요약이 빈 세션 ${num(sessions)}개(일지 ${num(days)}개)가 남았어요. 다음에 요약을 켜고 실행하면 최근 날짜부터 이어서 채워요.`,
  /** 6-1 끈 실행 ① (--date·--from): 요약 일지를 요약을 끈 채 다시 만들어 요약 줄이 빠진 날짜 수 */
  droppedHead: (n: number) => `꺼짐 (요약을 켜고 만들었던 일지 ${num(n)}개는 요약 줄 없이 다시 만들었어요)`,
  droppedTodo: '(이번 명령에 --summary를 붙여 다시 실행하면 요약이 돌아와요)',
  /** 6-1 끈 실행 ② (기본 실행): 요약 일지에 요약이 빈 세션이 남음 */
  remainingOffHead: (days: number, sessions: number) => `꺼짐 (요약을 켜고 만든 일지 ${num(days)}개에 요약이 빈 세션 ${num(sessions)}개가 남았어요)`,
  remainingOffTodo: '(--summary로 실행하면 최근 날짜부터 이어서 채워요)',
  /** 6-2 `보냄` 칸 (켠 실행에서 보낸 세션이 1개 이상일 때만, 괄호는 늘 다음 줄) */
  sentLabel: '보냄',
  sent: '가린 대화 글을 Claude Code로 Anthropic에 보냈어요',
  sentNote: (n: number) => `(세션 ${num(n)}개, Claude Code 사용량을 써요)`,
  /** 10번 [알림] 요약 저장 파일을 읽지 못함: 1줄 · 파일 줄(절대 경로 + 괄호) · 정해진 두 줄 */
  storeHead: (n: number) => `요약 저장 파일 ${num(n)}개를 읽지 못해 그 날짜는 저장해 둔 요약 없이 만들었어요.`,
  storeBroken: '깨진 파일',
  storeTodo: ['다른 프로그램이 잡고 있으면 닫고 다시 실행하세요.', '깨진 파일은 지워도 일지는 그대로예요.'],
  /** 10번 [알림] AI 요약을 하지 못함 (켠 실행만, 까닭마다 한 덩어리, 50번 상한으로 미룸은 [알림]이 없어요) */
  todo: {
    'not-found': (n: number) => `claude를 찾지 못해 세션 ${num(n)}개를 요약하지 못했어요. Claude Code가 설치돼 있고 claude가 PATH에 있는지 확인한 뒤 다시 실행하세요.`,
    // 서버가 인증을 거절한 세션(401·403)도 이 까닭으로 세고 보낸 세션에 들어서 "거절돼"를 함께 적어요(DESIGN S3 10번 정리 회차, 취합 20회차 차이 3).
    auth: (n: number) =>
      `Claude Code에 로그인돼 있지 않거나 로그인이 거절돼 세션 ${num(n)}개를 요약하지 못했어요. 터미널에서 claude를 한 번 실행해 로그인한 뒤 다시 실행하세요.`,
    'rate-limit': (n: number) => `Claude Code 사용량 제한에 걸려 세션 ${num(n)}개를 요약하지 못했어요. 나중에 요약을 켜고 다시 실행하면 빠진 세션만 다시 불러요.`,
    timeout: (n: number) => `60초 안에 답이 오지 않아 세션 ${num(n)}개를 요약하지 못했어요. 나중에 요약을 켜고 다시 실행하면 빠진 세션만 다시 불러요.`,
    // 재료(가린 보관본의 그날 글)를 만들지 못해 claude를 실행하지 않은 세션도 이 까닭이에요(PRD A24·A28, DESIGN S3 10번 정리 회차).
    other: (n: number) =>
      `보낼 글을 만들지 못했거나 claude가 요약을 돌려주지 못해 세션 ${num(n)}개를 요약하지 못했어요. 나중에 요약을 켜고 다시 실행하면 빠진 세션만 다시 불러요.`,
  } as Record<FailReason, (n: number) => string>,
  /**
   * 받은 요약을 요약 저장 파일에 쓰지 못함 (PRD S3·A27, DESIGN S3 10번 정리 회차, 취합 20회차 차이 8). 멈추지 않는 [알림]이고 종료 코드는 그대로예요.
   * 1줄(수는 쓰지 못한 요약 수 = 세션 수) · 파일마다 절대 경로 + 원인 코드 괄호(7칸, 날짜 순서) · 끝 세 줄(7칸, 문장마다 한 줄).
   * 그 세션은 요약 저장 파일에 없어서 요약을 켜고 그 날짜를 다시 만들 때 다시 불러요. 그날이 끝난 뒤 만든 지난 일지는 일지에 요약이 들어 있어
   * 기본 실행이 다시 만들지 않아서(A18 ③ 대상이 아님) --date·--from으로 다시 만들 때만이에요.
   */
  storeWriteFailed: (n: number) => `받은 요약 ${num(n)}개를 요약 저장 파일에 쓰지 못했어요. 이번 일지에는 넣었어요.`,
  storeWriteFailedTodo: [
    '다른 프로그램이 잡고 있으면 닫으세요.',
    '저장하지 못한 요약은 요약을 켜고 그 날짜를 다시 만들 때 다시 불러요.',
    '지난 날짜는 --date나 --from으로 다시 만들 때만 다시 불러요.',
  ],
  /** 로딩: 진행 표시 `요약하는 중 12/50 세션 (Claude Code)` */
  progressLabel: '요약하는 중',
  progressUnit: '세션 (Claude Code)',
  /**
   * 요약 중 Ctrl+C ([취소], 표준 오류, 종료 코드 1, PRD S3·A26, DESIGN S3 가·나 오류 정리 회차): 1줄 · 받은 요약이 1개 이상이면 2줄(7칸) · 다음:.
   * 받은 요약 수는 요약 저장 파일에 저장한 수예요(받았지만 저장하지 못한 요약은 일지도 쓰지 않아 남지 않아서 세지 않아요).
   */
  interrupted: 'Ctrl+C를 받아 요약을 멈췄어요. 이번 실행은 일지를 만들지 않았어요.',
  interruptedKept: (kept: number) => `받은 요약 ${num(kept)}개는 저장해 뒀어요.`,
  interruptedNext: '요약을 켜고 다시 실행하면 빠진 세션만 이어서 불러 일지를 만들어요.',
} as const;

/**
 * 요약 중 Ctrl+C로 멈춘 출력 (표준 오류, 종료 코드 1, PRD S3·A26). 부르던 claude는 끝냈고 일지는 하나도 쓰지 않았어요(한쪽만 바뀐 일지 없음).
 * 결과 요약 대신 이것만이라 `화면`·`검사` 줄과 `보냄` 칸이 없어요. 둘째 줄은 낱말 사이 자동 줄바꿈 대신 문장 뒤에서 끊어요(DESIGN).
 */
export function renderSummaryInterrupted(kept: number, p: Painter): string {
  const L: string[] = [];
  L.push(...wrapText(SUMMARY_TEXT.interrupted, `${p.bold('[취소]')} `, '       '));
  if (kept > 0) L.push(`       ${SUMMARY_TEXT.interruptedKept(kept)}`);
  L.push(...wrapText(SUMMARY_TEXT.interruptedNext, '다음: ', '      '));
  return `${L.join('\n')}\n`;
}

/** 이번 실행이 쓴 일지 하나 */
export interface MadeDay {
  date: string;
  /** new = 새로 만듦(마크다운이 없던 날짜), remade = 다시 만듦(이미 있던 일지를 새 내용으로 바꿈, A21) */
  status: 'new' | 'remade';
  mdPath: string;
  /** 이 일지에 쓴 이름·이메일 가리기 */
  hideIdentity: boolean;
}

export interface MakeSummary {
  /** 날짜를 정한 방법: 날짜 옵션 없음 / --date / --from[·--to] (A18) */
  kind: 'default' | 'date' | 'range';
  /** --from·--to로 준 기간 (range일 때만) */
  span: { from: string; to: string } | null;
  /** 이번에 쓴 일지 (날짜 순서) */
  made: MadeDay[];
  /** 기본 실행에서 그대로 둔 일지 수: 일지 폴더에 이미 있던 일지 중 대상 날짜가 아니라서 건드리지 않은 일지 (DESIGN S3 "이 절의 말") */
  kept: number;
  /** 손으로 고친 일지 마크다운이라 덮어쓰지 않고 건너뛴 날짜 (A21) */
  skippedEdited: string[];
  /** --date·--from으로 이름·이메일 가리기가 켜져 있던 일지를 끈 채 다시 만든 날짜 (A21) */
  identityOff: string[];
  /** identityOff가 있을 때 보여 줄 명령 (이번 실행 + --hide-identity) */
  rerunHideCommand: string | null;
  /** A20: --root도 config.json의 roots도 없고 git을 찾았으면 true */
  noRootsHint: boolean;
  /** 일지 폴더 (여러 날을 만들었을 때 결과 칸에 보여 줘요) */
  worklogsDir: string;
}

/**
 * 일지 만들기 S3의 새 문구 (A18·A19·A20·A21, I-01~I-05·I-09). 모두 DESIGN S3 가·나(2026-10-22 개선 회차판)의 글 그대로예요.
 * 문구를 바꿀 때는 여기만 바꾸면 돼요.
 */
export const MAKE_TEXT = {
  /** A20 (DESIGN S3 가·나 3번): --root·roots가 없을 때 읽음 칸 1줄의 저장소 덩어리 뒤에 띄어 쓰지 않고 붙여요 */
  reposOnlyWithSessions: '(세션이 있던 곳만)',
  /** A20 (DESIGN S3 가·나 3번): 그 바로 다음 줄(값 칸 위치) 안내. 경고가 아니라 안내, 여러 날이어도 한 번 */
  noRootsHint: '(세션 없던 저장소는 --root나 config.json의 roots로 알려 주세요)',
  /** 보관 칸 아래 (DESIGN S3 가·나 4번, I-09): 일지 만들기에서 이번 보관 중 새로 가린 값 */
  archivedNewly: (n: number) => `(보관하며 새로 가린 값 ${num(n)}개)`,
  /** 가림 칸 앞말 (DESIGN S3 가·나 5번, I-09) */
  redactWorklog: (n: number) => `일지에 ${num(n)}개`,
  redactArchive: (n: number) => `보관본에 새로 ${num(n)}개`,
  /** 이름·이메일 섞임 (DESIGN S3 가·나 6번, A18 설정, I-03): 이번 실행은 꺼짐인데 켜고 만들었던 일지를 켠 채로 다시 만듦 */
  identityKept: (n: number) => `꺼짐 (켜고 만들었던 일지 ${num(n)}개는 켠 채로 다시 만들었어요)`,
  /** 결과 칸 (DESIGN S3 가·나 12번): 만든 일지가 1개 (A21: 새로 만들었는지 다시 만들었는지) */
  resultNew: '일지 (새로 만듦)',
  resultRemade: '일지 (다시 만듦 — 이미 있던 일지를 새 내용으로 바꿨어요)',
  /**
   * 결과 칸: 만든 일지가 2개 이상 (날짜 수: 새로 만듦·다시 만듦, 기본 실행이면 그대로 둠, 0인 덩어리는 빼요).
   * 덩어리로 돌려줘서 80칸을 넘으면 덩어리 목록 줄바꿈 규칙대로 ` · ` 뒤에서 끊어요.
   */
  resultMany: (n: number, made: number, remade: number, kept: number | null): string[] => {
    const parts = [made ? `새로 만듦 ${num(made)}개` : '', remade ? `다시 만듦 ${num(remade)}개` : '', kept ? `그대로 둠 ${num(kept)}개` : ''].filter(Boolean);
    return [`일지 ${num(n)}개 — ${parts[0] ?? ''}`, ...parts.slice(1)];
  },
  /** 결과 칸 아래 폴더 이름표 */
  worklogsDir: '일지 폴더',
  /** 결과 칸: 만든 일지가 없을 때 (DESIGN S3 가·나 "빈 상태" 표, 위에서부터 처음 맞는 것) */
  resultNoneSkipped: '만든 일지 없음 — 손으로 고친 일지라 덮어쓰지 않았어요',
  resultNoneDate: '만든 일지 없음 — 이 날짜에 읽을 세션과 커밋이 없어요',
  resultNoneRange: '만든 일지 없음 — 이 기간에 읽을 세션과 커밋이 없어요',
  resultNoneKept: (kept: number) => `만든 일지 없음 — 새로 만들 날짜가 없어요 · 그대로 둠 ${num(kept)}개`,
  resultNoneDefault: '만든 일지 없음 — 읽을 세션과 커밋이 없어요',
  /** A21 [알림] (DESIGN S3 가·나 10번): 손으로 고친 일지. 1줄 / 날짜 줄 / 정해진 자리에서 끊는 두 줄 */
  editedHead: (n: number) => `손으로 고친 일지 ${num(n)}개는 덮어쓰지 않고 그대로 뒀어요.`,
  editedTodo: ['메모를 다른 곳에 옮긴 뒤 그 .md 파일을 옮기거나 지우고 다시 실행하면', '새로 만들어져요.'],
  /** A21 [알림]: 이름·이메일 가리기가 켜져 있던 일지를 끈 채 다시 만듦 (--date·--from만). 1줄 / 날짜 줄 / 할 일 / 명령(9칸) */
  identityOffHead: (n: number) => `이름·이메일 가리기를 켜고 만들었던 일지 ${num(n)}개를 끈 채 다시 만들었어요.`,
  identityOffTodo: '공개용으로 되돌리려면 아래처럼 --hide-identity를 붙여 다시 만드세요.',
  /** A19 (DESIGN S3 가·나 14번): 이번에 이름·이메일 가리기를 끈 채 만든 일지가 있을 때 검사 줄 바로 아래(12칸), [알림] 이름표 없음 */
  checkIdentityAll: '이번 일지는 이름·이메일을 가리지 않았어요. 검사는 비밀 값만 판정해요. 공개할 날짜는 --hide-identity를 붙여 다시 만드세요.',
  checkIdentitySome: (n: number) => `이번 일지 중 ${num(n)}개는 이름·이메일을 가리지 않았어요. 검사는 비밀 값만 판정해요. 공개할 날짜는 --hide-identity를 붙여 다시 만드세요.`,
} as const;

/**
 * 건너뛴 --root·roots 경로 [알림] 한 덩어리의 1줄(head)과 3줄(todo) 문장 (DESIGN S3 가·나 10번). 2줄은 실제로 찾아본 절대 경로예요.
 * 1줄은 `[알림] <출처> 경로를 건너뛰었어요 (까닭).`이고, 까닭은 없는 경로 / 폴더가 아닌 파일 / git 저장소를 찾지 못한 폴더 중 하나예요.
 * 출처는 DESIGN의 `--root·roots` 대신 `--root` / `config.json의 roots`로 나눠 적어요. 설정 파일에 남은 옛 경로는 --root를 주지 않아도
 * 알림이 나와서, 어디를 고칠지 알려 주려는 거예요(DEV.md "PRD와 다르게 한 것" 7회차, 취합 13회차 차이 목록).
 */
export function rootIssueText(issue: RootIssue, origin: RootOrigin | undefined, depth: number): { head: string; todo: string } {
  const where = origin === 'config' ? 'config.json의 roots' : '--root';
  switch (issue.kind) {
    case 'missing':
      return { head: `${where} 경로를 건너뛰었어요 (없는 경로).`, todo: '경로를 고친 뒤 다시 실행하면 그 아래 저장소의 커밋도 들어가요.' };
    case 'not-dir':
      return { head: `${where} 경로를 건너뛰었어요 (폴더가 아닌 파일).`, todo: '저장소가 든 폴더를 주면 그 아래 저장소의 커밋도 들어가요.' };
    case 'no-repo':
      return {
        head: `${where} 경로를 건너뛰었어요 (git 저장소를 찾지 못한 폴더).`,
        todo: `그 아래 ${num(depth)}단계까지 찾아봤어요. 저장소가 더 깊이 있으면 그 폴더를 주세요.`,
      };
  }
}

const LABEL_W = 12;
/** [알림] 이름표 뒤 위치 */
const AFTER = ' '.repeat(7);
const pad2 = (n: number) => String(n).padStart(2, '0');

/** 버전 번호 뒤 조사 "이/가": 마지막 숫자를 읽은 소리에 받침이 있으면 "이"(0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔), 없으면 "가"(2 이, 4 사, 5 오, 9 구) */
function subjectParticle(version: string): string {
  const last = version.trim().slice(-1);
  return '2459'.includes(last) && /\d/.test(last) ? '가' : '이';
}

function ymdOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function renderRunSummary(r: RunSummary, stream: NodeJS.WriteStream = process.stdout): string {
  const p = painter(stream);
  const L: string[] = [];
  const row = (label: string, value: string) => L.push(`${p.bold(padW(label, LABEL_W))}${value}`);
  const cont = (value: string) => L.push(`${' '.repeat(LABEL_W)}${value}`);
  const a = r.archive;

  const mk = r.mode === 'make' ? r.make : undefined;
  const made = mk?.made ?? [];
  // 머리 줄의 날짜 자리 (DESIGN S3 가·나 1번 표, I-05): --date는 그 날짜, --from[·--to]는 준 기간 그대로(--to가 없으면 오늘까지),
  // 날짜 옵션 없음은 대상 날짜(새로 만듦·다시 만듦·손으로 고쳐 건너뜀) 중 가장 이른 날짜 ~ 가장 늦은 날짜(하나면 그 날짜, 없으면 오늘)예요.
  let headDates = r.date;
  if (mk?.kind === 'range' && mk.span) headDates = mk.span.from === mk.span.to ? mk.span.from : `${mk.span.from} ~ ${mk.span.to}`;
  else if (mk?.kind === 'default') {
    const targets = [...made.map((m) => m.date), ...mk.skippedEdited].sort();
    if (targets.length > 0) headDates = targets[0] === targets[targets.length - 1] ? targets[0] : `${targets[0]} ~ ${targets[targets.length - 1]}`;
  }
  L.push(r.mode === 'make' ? `cc-worklog 일지 만들기 — ${headDates} (하루 경계 ${pad2(r.dayStartHour)}:00)` : 'cc-worklog 보관');
  L.push('');

  if (r.mode === 'make' && r.day) {
    // 여러 날짜면 만든 일지 전체의 합계예요. 합계라는 표시는 따로 붙이지 않아요(DESIGN S3 가·나 3번).
    // A20: --root도 roots도 없으면 저장소 덩어리에 (세션이 있던 곳만)을 붙이고 다음 줄에 안내 한 줄(경고 아님, 여러 날이어도 한 번,
    // git을 찾지 못했으면 빼요). 서브 에이전트 줄보다 위예요(DESIGN S3 가·나 3번, I-02).
    const repos = `저장소 ${num(r.day.repos)}개${mk?.noRootsHint ? MAKE_TEXT.reposOnlyWithSessions : ''}`;
    row('읽음', `세션 ${num(r.day.sessions)}개 · ${repos} · 커밋 ${num(r.day.commits)}개`);
    if (mk?.noRootsHint) L.push(...wrapText(MAKE_TEXT.noRootsHint, ' '.repeat(LABEL_W), ' '.repeat(LABEL_W + 1)));
    if (r.day.subagentFiles > 0) cont(`(서브 에이전트 기록 ${num(r.day.subagentFiles)}개는 부모 세션에 묶음)`);
  } else {
    row('읽음', `세션 ${num(a.sessionsTotal)}개 · 파일 ${num(a.filesTotal)}개 · 줄 ${num(a.linesRead)}개(새로 읽은 부분)`);
    if (a.subagentFiles > 0) cont(`(서브 에이전트 기록 ${num(a.subagentFiles)}개는 부모 세션에 묶음)`);
  }
  row('보관', `새로 ${num(a.sessions.new)}개 · 이어 붙임 ${num(a.sessions.appended)}개 · 그대로 ${num(a.sessions.unchanged)}개`);
  if (a.originalsMissingSessions > 0) cont(`(원본은 지워지고 보관본만 남은 세션 ${num(a.originalsMissingSessions)}개)`);
  // 일지 만들기: 이번 보관 중 새로 가린 값은 보관 칸 아래에 둬요(보관본의 수는 보관 칸, 일지의 수는 가림 칸, DESIGN S3 가·나 4번, I-09).
  if (r.mode === 'make') {
    const newly = totalCount(a.redactions);
    if (newly > 0) cont(MAKE_TEXT.archivedNewly(newly));
  }

  // 가림: make는 일지에 들어간 가린 자리(일지에 N개), archive는 이번에 보관하며 새로 가린 값(보관본에 새로 N개) (DESIGN S3 가·나 5번, I-09)
  const counts = r.mode === 'make' && r.day ? r.day.redactions : a.redactions;
  const total = totalCount(counts);
  row('가림', r.mode === 'make' ? MAKE_TEXT.redactWorklog(total) : MAKE_TEXT.redactArchive(total));
  const list = sortedCounts(counts);
  const kw = Math.max(0, ...list.map(([k]) => displayWidth(k)));
  for (const [k, v] of list) cont(`  ${padW(k, Math.min(kw, 24))}  ${num(v)}`);

  // 이름·이메일 (DESIGN S3 가·나 6번): 이번에 쓴 일지가 있으면 그 일지들의 설정으로 보여 줘요. 기본 실행은 켜고 만들었던 일지를
  // 켠 채 다시 만들어서(A18 설정, I-03) 이번 실행 옵션이 꺼져 있어도 켜진 일지가 있을 수 있어요(섞임). 쓴 일지가 없으면 이번 실행 설정이에요.
  // 이번 실행이 켜짐이면 쓴 일지도 모두 켜짐이에요(A18 설정). 이번 실행이 꺼짐인데 켜진 일지가 있으면 켜고 만들었던 일지를 지킨 것이에요.
  const idOn = made.length > 0 ? made.filter((m) => m.hideIdentity).length : r.hideIdentity ? 1 : 0;
  if (idOn > 0 && r.hideIdentity) {
    // 한 줄로 쓰면 80칸을 넘을 수 있어서 괄호 부분은 늘 다음 줄(값 칸 위치)로 내려요.
    const id = r.day?.identity ?? {};
    const parts = sortedCounts(id).map(([k, v]) => `${k} ${num(v)}개`);
    L.push(...wrapText(`켜짐 — 일지에서 ${parts.length ? parts.join(' · ') : '0개'} 가림`, p.bold(padW('이름·이메일', LABEL_W)), ' '.repeat(LABEL_W)));
    cont('(보관본엔 적용 안 함)');
  } else if (idOn > 0) {
    row('이름·이메일', MAKE_TEXT.identityKept(idOn));
  } else {
    row('이름·이메일', '꺼짐');
  }

  // 6-1 AI 요약 (DESIGN S3 가·나 6-1, PRD S3·A24·A28): 켠 실행이면 늘 세 줄까지(요약한 세션 / 못 한 세션 / 남은 세션 문장),
  // 끈 실행은 ① 요약 줄이 빠진 날짜(--date·--from)나 ② 요약이 빈 세션이 남은 요약 일지(기본 실행)일 때만 두 줄. 그 밖의 끈 실행은 칸이 없어요.
  // 6-2 보냄: 켠 실행에서 보낸 세션이 1개 이상일 때만(괄호는 늘 다음 줄). 여러 날짜여도 합계 한 번이에요.
  const sm = r.mode === 'make' ? r.summary : undefined;
  const label = p.bold(padW(SUMMARY_TEXT.label, LABEL_W));
  const indent = ' '.repeat(LABEL_W);
  // 1·2줄과 이유별 [알림]의 수 (멈춘 까닭이 이번에 쓴 일지 밖에만 있어도 빠지지 않게, 취합 22회차 차이 1)
  const smCounts = sm ? summaryCounts(sm) : null;
  if (sm?.on && smCounts) {
    const summarized = sm.newly + sm.reused;
    if (smCounts.targets === 0) {
      L.push(`${label}${SUMMARY_TEXT.noTargets}`);
    } else {
      const parts = SUMMARY_TEXT.onParts(sm.newly, sm.reused);
      const head = SUMMARY_TEXT.onHead(summarized);
      const one = parts.length ? `${head} (${parts.join(' · ')})` : head;
      // 80칸을 넘으면 괄호를 통째로 다음 줄(값 칸)로 내려요(공통 규칙).
      if (displayWidth(`${padW(SUMMARY_TEXT.label, LABEL_W)}${one}`) <= 80 || !parts.length) L.push(`${label}${one}`);
      else L.push(`${label}${head}`, `${indent}(${parts.join(' · ')})`);
      const counts = SUMMARY_REASON_ORDER.map((k) => [k, k === 'deferred' ? sm.deferred : smCounts.failed[k]] as const).filter(([, n]) => n > 0);
      if (counts.length > 0) {
        const total = counts.reduce((n, [, c]) => n + c, 0);
        // 80칸을 넘으면 덩어리 사이에서 끊고 줄 끝에 ·를 남겨 괄호 안쪽(값 칸 + 1칸)에 맞춰요.
        const chunks = counts.map(([k, n], i) => `${i === 0 ? SUMMARY_TEXT.failedHead(total) : ''}${SUMMARY_TEXT.reason[k]} ${num(n)}개${i === counts.length - 1 ? ')' : ''}`);
        L.push(...wrapParts(chunks, ' · ', indent, `${indent} `));
      }
    }
    if (sm.remaining) {
      // 상한에 닿았는지는 "50번을 다 실행했고 부를 세션이 더 남았는지"예요(PRD A24, 취합 20회차 차이 2). 미룬 세션이 다시 만들지 않은 ③ 일지에만
      // 있으면 2줄에 `50번 상한으로 미룸`이 없어도 이 문장이 상한 모양이에요.
      const capped = sm.capReached ?? sm.deferred > 0;
      const text = capped ? SUMMARY_TEXT.remainingCap(sm.remaining.sessions, sm.remaining.days) : SUMMARY_TEXT.remaining(sm.remaining.sessions, sm.remaining.days);
      L.push(...wrapText(text, indent, indent));
    }
    if (sm.sent > 0) {
      L.push(`${p.bold(padW(SUMMARY_TEXT.sentLabel, LABEL_W))}${SUMMARY_TEXT.sent}`);
      cont(SUMMARY_TEXT.sentNote(sm.sent));
    }
  } else if (sm && sm.droppedDays.length > 0) {
    L.push(`${label}${SUMMARY_TEXT.droppedHead(sm.droppedDays.length)}`);
    cont(SUMMARY_TEXT.droppedTodo);
  } else if (sm && sm.showRemaining && sm.remaining) {
    L.push(`${label}${SUMMARY_TEXT.remainingOffHead(sm.remaining.days, sm.remaining.sessions)}`);
    cont(SUMMARY_TEXT.remainingOffTodo);
  }

  // 기록 형식 (A13, DESIGN S3 7번): 이 도구의 기준 버전과 수만 적어요. 기준보다 옛 버전은 [알림] 없이 "옛 형식 파일 N개"로 수만 보여 줘요.
  // 건너뛴 줄은 모르는 줄 종류 + 읽을 수 없는 줄 + 꼭 필요한 값(timestamp·cwd·sessionId)이 없어 버린 요청·답변 줄을 합쳐 세고,
  // 다음 줄에 이유별로 나눠 보여 줘요(0인 이유는 빼요). 2026-10-20에 처음 본 12가지는 아는 줄이라 세지 않아요(A13).
  const skipped = a.skipped.broken + a.skipped.unknownType + a.skipped.missingFields;
  const fmt = a.format;
  const older = fmt.olderFiles > 0 ? ` · 옛 형식 파일 ${num(fmt.olderFiles)}개` : '';
  row('기록 형식', `기준 ${FORMAT_BASELINE}${older} · 건너뛴 줄 ${num(skipped)}개`);
  if (skipped > 0) {
    const parts = [
      a.skipped.unknownType ? `모르는 줄 종류 ${num(a.skipped.unknownType)}` : '',
      a.skipped.broken ? `읽을 수 없는 줄 ${num(a.skipped.broken)}` : '',
      a.skipped.missingFields ? `시각·폴더·세션 값이 없는 줄 ${num(a.skipped.missingFields)}` : '',
    ].filter(Boolean);
    // 80칸을 넘으면 덩어리 단위로 다음 줄에 넘겨요(괄호 안쪽 위치에 맞춰요).
    const indent = ' '.repeat(LABEL_W);
    const inner = ' '.repeat(LABEL_W + 1);
    const enclose = (xs: string[]) => xs.map((x, i) => `${i === 0 ? '(' : ''}${x}${i === xs.length - 1 ? ')' : ''}`);
    L.push(...wrapParts(enclose(parts), ' · ', indent, inner));
    const names = a.skipped.unknownTypeNames;
    if (names.length) L.push(...wrapParts(enclose(names.map((n, i) => (i === 0 ? `모르는 줄 종류: ${n}` : n))), ', ', indent, inner));
  }

  // 삭제 임박: 보관 전 기준으로 알려요(PRD F3·A9). 이 칸은 늘 찍어요.
  // 보관 전 위험 세션(atRiskBefore) 중 보관에 실패한 것(atRiskAfter, 그 부분집합)을 뺀 수가 "이번에 보관한" 수예요.
  const before = a.atRiskBefore.sessions;
  const failed = a.atRiskAfter.sessions;
  const risk =
    before === 0
      ? '없음'
      : failed === 0
        ? `삭제 예상일이 7일 안이던 세션 ${num(before)}개를 이번에 보관했어요`
        : failed >= before
          ? `삭제 예상일이 7일 안이던 세션 ${num(before)}개를 보관하지 못했어요`
          : `삭제 예상일이 7일 안이던 세션 ${num(before)}개 중 ${num(before - failed)}개를 이번에 보관했어요`;
  L.push(...wrapText(risk, p.bold(padW('삭제 임박', LABEL_W)), ' '.repeat(LABEL_W)));

  // [알림] 줄: 80칸을 넘으면 이름표 뒤 위치에 맞춰 다음 줄로 넘겨요.
  const notices: string[] = [];
  const notice = (text: string) => notices.push(...wrapText(text, `${p.bold('[알림]')} `, '       '));
  if (!a.projectsDirExists) {
    // 멈추지 않아요(종료 코드 0). 찾아본 폴더 경로는 줄이지 않고 자기 줄에 둬요.
    notice(r.mode === 'make' ? '세션 기록 폴더를 찾지 못해 커밋만으로 만들었어요. 세션은 0개로 셌어요.' : '세션 기록 폴더를 찾지 못해 보관할 세션이 없어요.');
    notices.push(`       ${r.projectsDir}`);
    notices.push(...wrapText('다른 곳에 있으면 --claude-dir로 알려 주세요.', '       ', '       '));
  }
  if (r.day && !r.day.gitAvailable) notice('git을 찾지 못해 세션만으로 만들었어요. 커밋은 0개로 셌어요.');
  // --root·config.json의 roots 중 없는 경로·파일 경로·저장소가 없는 폴더: 멈추지 않고 건너뛴 뒤 경로마다 세 줄 한 덩어리로 알려요(F1-20, A4, DESIGN S3 10번).
  // 1줄 까닭, 2줄 실제로 찾아본 절대 경로(줄이지 않고 자기 줄, 세션 기록 폴더 [알림]과 같은 모양), 3줄 할 일. 여러 개면 준 순서로 빈 줄 없이 이어요.
  for (const issue of r.rootIssues ?? []) {
    const t = rootIssueText(issue, r.rootOrigins?.[issue.path], r.rootDepth ?? 4);
    notice(t.head);
    notices.push(`       ${issue.path}`);
    notices.push(...wrapText(t.todo, '       ', '       '));
  }
  if (r.recovered?.action === 'rolled-forward') notice(`지난번에 멈춘 보관본 다시 가리기를 마저 끝냈어요 (파일 ${num(r.recovered.files)}개).`);
  if (r.recovered?.action === 'rolled-back') notice('지난번에 멈춘 보관본 다시 가리기를 되돌렸어요. 그때 바뀐 파일은 없어요.');
  // 다시 쓰기 기록이 깨졌으면 하던 일은 그대로 끝내고(종료 코드 그대로) 알리기만 해요. 기록과 남은 임시 파일은 건드리지 않아요(A16, Q21).
  // 깨진 기록에서 시작한 다시 가리기를 방금 되돌려 "깨짐" 표시를 다시 남긴 경우도 같아요(되돌림 [알림] 바로 다음, A16).
  if (r.recovered?.broken) notice(BROKEN_FULL);
  // 기준보다 새 버전이 있을 때만 알리고, 그중 가장 새 버전 하나를 보여 줘요(A13, S3).
  if (fmt.newerFiles > 0 && fmt.newest) {
    notice(
      `기록 형식 ${fmt.newest}${subjectParticle(fmt.newest)} 이 도구의 기준(${FORMAT_BASELINE})보다 새로워요. 건너뛴 줄이 많으면 도구를 새 버전으로 바꿔 주세요.`,
    );
  }

  // 손으로 고친 일지 (DESIGN S3 가·나 10번, PRD A21, I-04): 1줄 / 이름표 뒤 위치(7칸)에 날짜를 줄이지 않고 모두(날짜 순서, ", "로 잇고
  // 80칸을 넘으면 날짜 사이에서 끊어 줄 끝에 ","를 남겨요) / 정해진 자리에서 끊는 두 줄. 종료 코드는 그대로예요.
  const dateLines = (dates: string[]) => wrapParts([...dates].sort(), ', ', AFTER, AFTER);
  if (mk && mk.skippedEdited.length > 0) {
    notice(MAKE_TEXT.editedHead(mk.skippedEdited.length));
    notices.push(...dateLines(mk.skippedEdited));
    for (const t of MAKE_TEXT.editedTodo) notices.push(`${AFTER}${t}`);
  }
  // --date·--from으로 켜져 있던 이름·이메일 가리기를 끈 채 다시 만든 날짜 (DESIGN S3 가·나 10번, PRD A21, I-03): 1줄 / 날짜 줄 / 할 일 /
  // 이번 명령에 --hide-identity를 붙인 명령 한 줄(9칸, 끊지 않아요). 손으로 고친 일지 [알림] 다음이에요.
  if (mk && mk.identityOff.length > 0) {
    notice(MAKE_TEXT.identityOffHead(mk.identityOff.length));
    notices.push(...dateLines(mk.identityOff));
    notices.push(...wrapText(MAKE_TEXT.identityOffTodo, AFTER, AFTER));
    if (mk.rerunHideCommand) notices.push(`${AFTER}  ${mk.rerunHideCommand}`);
  }
  // AI 요약 [알림] (DESIGN S3 가·나 10번, PRD A27·A28): 이름·이메일 끈 채 다시 만듦 [알림] 다음, `결과` 칸 바로 위예요.
  // 요약 저장 파일을 읽지 못함(1줄 · 파일마다 절대 경로와 괄호 · 정해진 두 줄) → 요약을 하지 못한 까닭마다 한 덩어리(켠 실행만, 6-1 2줄 순서,
  // 50번 상한으로 미룸은 6-1 3줄이 알려서 [알림]이 없어요). 종료 코드는 그대로예요(요약 실패를 일지 만들기 실패로 보지 않아요).
  if (sm) {
    if (sm.storeProblems.length > 0) {
      notice(SUMMARY_TEXT.storeHead(sm.storeProblems.length));
      for (const sp of sm.storeProblems) notices.push(`${AFTER}${sp.path} (${sp.code ?? SUMMARY_TEXT.storeBroken})`);
      for (const t of SUMMARY_TEXT.storeTodo) notices.push(`${AFTER}${t}`);
    }
    if (sm.on && smCounts) for (const k of FAIL_REASONS) if (smCounts.failed[k] > 0) notice(SUMMARY_TEXT.todo[k](smCounts.failed[k]));
    // 받은 요약을 요약 저장 파일에 쓰지 못함 (PRD A27, DESIGN S3 10번 정리 회차, 취합 20회차 차이 8): 요약 [알림]의 맨 끝이에요(실행에서 일어난 순서).
    // 1줄(쓰지 못한 요약 수) · 파일마다 절대 경로와 원인 코드 괄호(알 수 없으면 괄호 없음, 날짜 순서) · 끝 세 줄.
    if (sm.storeWriteFailed.length > 0) {
      notice(SUMMARY_TEXT.storeWriteFailed(sm.storeWriteFailed.reduce((n, f) => n + f.sessions, 0)));
      for (const f of sm.storeWriteFailed) notices.push(`${AFTER}${f.path}${f.code ? ` (${f.code})` : ''}`);
      for (const t of SUMMARY_TEXT.storeWriteFailedTodo) notices.push(`${AFTER}${t}`);
    }
  }

  if (a.atRiskAfter.sessions > 0 || a.errors.length > 0) {
    L.push('');
    if (a.atRiskAfter.sessions > 0) {
      L.push(`${p.warn('[경고]')} 삭제 임박: 보관에 실패한 세션 ${num(a.atRiskAfter.sessions)}개가 7일 안에 지워질 수 있어요`);
      if (a.atRiskAfter.earliestDeleteAt) L.push(`       가장 빠른 삭제 예상일 ${ymdOf(a.atRiskAfter.earliestDeleteAt)}`);
    }
    if (a.errors.length > 0) {
      L.push(`${p.warn('[경고]')} 보관하지 못한 파일 ${num(a.errors.length)}개 (다음 실행 때 다시 시도해요)`);
      for (const e of a.errors.slice(0, 5)) L.push(`       ${e.file} (${e.code})`);
      if (a.errors.length > 5) L.push(`       외 ${num(a.errors.length - 5)}개`);
      L.push('       지금 하려면 cc-worklog archive를 다시 실행하세요.');
    }
  }
  if (notices.length) {
    L.push('');
    L.push(...notices);
  }

  L.push('');
  if (r.mode === 'make') {
    // 결과 칸 (DESIGN S3 가·나 12번, I-04·I-05): 만든 일지 수에 따라 세 모양이에요. 각 경로는 자기 줄(값 칸 + 2칸)이고 줄이지 않아요.
    if (made.length >= 2 && mk) {
      // 2개 이상: 날짜마다 늘어놓지 않고 일지 수(새로 만듦·다시 만듦, 기본 실행이면 그대로 둠)와 일지 폴더만 (PRD S3·A18)
      const remade = made.filter((m) => m.status === 'remade').length;
      const chunks = MAKE_TEXT.resultMany(made.length, made.length - remade, remade, mk.kind === 'default' ? mk.kept : null);
      L.push(...wrapParts(chunks, ' · ', p.bold(padW('결과', LABEL_W)), ' '.repeat(LABEL_W)));
      cont(MAKE_TEXT.worklogsDir);
      cont(`  ${mk.worklogsDir}`);
    } else if (r.day?.mdPath) {
      // 1개: 그 일지 위치와 새로 만들었는지·다시 만들었는지 (A21). 기본 실행이어도 그대로 둠 수는 붙이지 않아요.
      // make 칸이 없으면(옛 호출) 전처럼 "일지"예요.
      row('결과', made.length === 1 ? (made[0]!.status === 'remade' ? MAKE_TEXT.resultRemade : MAKE_TEXT.resultNew) : '일지');
      cont(`  ${r.day.mdPath}`);
    } else {
      // 0개: 까닭은 위에서부터 처음 맞는 것 하나예요(DESIGN S3 가·나 "빈 상태" 표). 손으로 고친 일지를 건너뛰었으면 일지 폴더도 보여 줘요.
      const skipped = mk !== undefined && mk.skippedEdited.length > 0;
      const none = skipped
        ? MAKE_TEXT.resultNoneSkipped
        : mk?.kind === 'range'
          ? MAKE_TEXT.resultNoneRange
          : mk?.kind === 'default'
            ? mk.kept > 0
              ? MAKE_TEXT.resultNoneKept(mk.kept)
              : MAKE_TEXT.resultNoneDefault
            : MAKE_TEXT.resultNoneDate;
      row('결과', none);
      if (skipped) {
        cont(MAKE_TEXT.worklogsDir);
        cont(`  ${mk.worklogsDir}`);
      }
    }
    cont('보관 폴더');
    cont(`  ${a.archiveDir}`);
  } else {
    row('결과', '보관 폴더');
    cont(`  ${a.archiveDir}`);
  }
  row('화면', `${r.viewCommand}   (브라우저에서 날짜 목록이 열려요)`);
  // PRD S3: 끝에 검사 명령 안내 한 줄. 이번 일지 만들기가 이름·이메일 가리기를 끈 채 만든(다시 만든 것 포함) 일지가 있으면
  // 그 줄 바로 아래(값 칸 위치, 12칸)에 그 일지는 이름·이메일을 가리지 않았고 공개할 날짜는 --hide-identity로 다시 만들라는 말을 더해요
  // (A19, DESIGN S3 가·나 14번, I-01). [알림] 이름표·명령 없이 80칸 안에서 낱말 사이에 끊어요. 이 글이 출력의 마지막 줄이에요.
  L.push(checkLine(p));
  const offMade = made.filter((m) => !m.hideIdentity).length;
  if (offMade > 0) {
    const text = offMade === made.length ? MAKE_TEXT.checkIdentityAll : MAKE_TEXT.checkIdentitySome(offMade);
    L.push(...wrapText(text, ' '.repeat(LABEL_W), ' '.repeat(LABEL_W)));
  }
  return `${L.join('\n')}\n`;
}
