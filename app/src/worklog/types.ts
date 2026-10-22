// 하루 일지 데이터 모양. worklogs/<날짜>.json 으로 저장하고, 로컬 화면(S1·S2)이 읽어요.
// 모든 글은 이미 가린 뒤의 값이에요. 이름·이메일 가리기를 켜고 만들었으면 그 결과도 들어 있어요.

export interface DayLog {
  schema: 1;
  /** 일지 날짜 YYYY-MM-DD */
  date: string;
  dayStartHour: number;
  timeZone: string;
  /** [start, end) ISO 문자열 */
  range: { start: string; end: string };
  hideIdentity: boolean;
  gitAvailable: boolean;
  totals: { projects: number; sessions: number; commits: number };
  /** 일지 안 가린 자리 (비밀 값 종류별) */
  redactions: Record<string, number>;
  /** 이름·이메일 가리기로 바꾼 자리 (옵션이 켜졌을 때만) */
  identity: Record<string, number>;
  projects: ProjectLog[];
  /** 일지를 만든 시각. 마크다운에는 넣지 않아요(같은 재료면 같은 마크다운이 나오게). */
  generatedAt: string;
  /**
   * 도구(일지 만들기·다시 가리기)가 마지막으로 쓴 일지 마크다운의 SHA-256 (16진수, 원문 없음, PRD 5장·A21).
   * 지금 마크다운과 다르면 손으로 고친 일지로 보고 일지 만들기가 덮어쓰지 않아요. 이 칸이 없는 옛 일지는 고치지 않은 것으로 봐요.
   */
  markdownHash?: string;
}

export interface ProjectLog {
  name: string;
  /** 저장소 최상위 폴더. "저장소 없음" 묶음이면 null */
  path: string | null;
  noRepo: boolean;
  /** 커밋을 못 가져온 이유 등 */
  notes: string[];
  sessions: SessionLog[];
  commits: CommitLog[];
}

export interface SessionLog {
  sessionId: string;
  title: string | null;
  firstRequest: string | null;
  lastRequest: string | null;
  /** 그날 사용자 요청 수 */
  requests: number;
  /** 그날 첫·마지막 요청·답변 줄 시각 (ISO) */
  start: string;
  end: string;
  usage: { ms: number; source: 'cost-state' | 'estimate'; wholeSession: boolean } | null;
  lines: { added: number | null; removed: number | null; wholeSession: boolean } | null;
  branches: string[];
  cwd: string;
  /** 그날 활동한 서브 에이전트 기록 수 (부모 세션에 묶어 세요, A6) */
  subagents: number;
}

export interface CommitLog {
  hash: string;
  /** 작성 시각 (ISO) */
  time: string;
  branch: string | null;
  /** 커밋 메시지 첫 줄 */
  subject: string;
}
