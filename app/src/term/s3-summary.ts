// S3 실행 요약 (터미널)
// 일지 만들기·보관 명령이 끝난 뒤의 출력이에요. 비밀 값 원문은 어떤 줄에도 나오지 않아요.
import type { ArchiveResult } from '../archive/archive.js';
import type { RootOrigin } from '../config.js';
import type { RootIssue } from '../git/repo.js';
import type { RecoveryResult } from '../redact/journal.js';
import { sortedCounts, totalCount, type Counts } from '../redact/redact.js';
import { FORMAT_BASELINE } from '../session/format.js';
import { num } from '../util/text.js';
import { displayWidth, padW, painter, wrapParts, wrapText } from './format.js';
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
