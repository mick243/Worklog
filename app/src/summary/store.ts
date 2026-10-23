// 요약 저장 파일 (PRD A27, 5장): 데이터 폴더의 summaries/<날짜>.json, 날짜마다 하나예요. 요약을 켰을 때만 생겨요.
// 세션마다 세션 아이디, 하루 범위, 그날 재료의 표지(요청·답변 줄 수와 마지막 줄 시각, 원문 없음), F2로 가린 요약 글, 만든 시각만 담아요.
// 보낸 재료나 가리기 전 요약은 담지 않아요. 이름·이메일 가리기는 쓰지 않아요(보관본과 같아요, A10).
// 검사(check)·다시 가리기(redact)는 이 파일을 보관본과 같은 규칙으로 다뤄요(commands/check.ts, redact/reredact.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPaths } from '../config.js';
import { neutralizeMarkers } from '../redact/marker.js';
import type { Redactor } from '../redact/redact.js';
import { errorCode, writeFileAtomic } from '../util/fs.js';
import { parseJsonText } from '../util/json.js';
import { oneLine, truncateKeepingMarkers } from '../util/text.js';
import type { MaterialMark } from '../worklog/build.js';

export interface StoredSummary {
  sessionId: string;
  /** 하루 범위 [start, end) ISO. 하루 경계를 바꾸면 달라져 다시 불러요. */
  range: { start: string; end: string };
  /** 그날 재료의 표지. 그날 줄이 늘면 달라져 다시 불러요. */
  mark: MaterialMark;
  /** F2(내장 규칙 + 사용자 패턴)로 가린 요약 글 한 줄 */
  summary: string;
  createdAt: string;
}

export interface SummaryFile {
  schema: 1;
  date: string;
  sessions: StoredSummary[];
}

/** 저장해 두는 요약 글의 길이 상한. 일지에는 150자로 다시 잘라 넣어요(A24). 너무 긴 답을 다 남기지 않으려는 거예요. */
const STORE_MAX = 600;

export function summaryFilePath(dataDir: string, date: string): string {
  return join(dataPaths(dataDir).summariesDir, `${date}.json`);
}

/** 요약 저장 파일이 있는 날짜 (폴더가 없거나 읽지 못하면 없음) */
export function summaryFileDates(dataDir: string): string[] {
  try {
    return readdirSync(dataPaths(dataDir).summariesDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

const isMark = (m: unknown): m is MaterialMark => {
  const x = m as MaterialMark | null;
  return !!x && typeof x.userLines === 'number' && typeof x.assistantLines === 'number' && (x.lastLineAt === null || typeof x.lastLineAt === 'string');
};

function validEntry(e: unknown): e is StoredSummary {
  const x = e as StoredSummary | null;
  return (
    !!x &&
    typeof x.sessionId === 'string' &&
    typeof x.summary === 'string' &&
    !!x.range &&
    typeof x.range.start === 'string' &&
    typeof x.range.end === 'string' &&
    isMark(x.mark)
  );
}

/**
 * 요약 저장 파일의 글을 읽어요. JSON이 아니거나 요약 저장 파일 모양이 아니면(schema 1·date·sessions 목록이 아니거나, 세션 칸이 하나라도
 * 모양이 다르면) null, 곧 깨진 파일이에요. 일지 만들기(저장한 요약이 없는 것으로 봄)·검사(읽지 못한 파일로 셈)·다시 가리기(고칠 수 없는 의심)가
 * 같은 기준을 써요(PRD A27, 취합 20회차 차이 7).
 */
export function parseSummaryFile(raw: string): SummaryFile | null {
  let data: unknown;
  try {
    data = parseJsonText(raw);
  } catch {
    return null;
  }
  const f = data as SummaryFile | null;
  if (!f || typeof f !== 'object' || Array.isArray(f) || f.schema !== 1 || typeof f.date !== 'string' || !Array.isArray(f.sessions)) return null;
  return f.sessions.every((e) => validEntry(e)) ? f : null;
}

export interface ReadResult {
  /** 세션 아이디 → 저장해 둔 요약 */
  entries: Map<string, StoredSummary>;
  /** 읽지 못했거나(다른 프로그램이 잡고 있음 등) 깨진 파일이면 그 사실 (S3 [알림], A27). 없는 파일은 null이에요. */
  problem: 'unreadable' | 'broken' | null;
  /** 읽지 못한 까닭 (오류 코드) */
  code?: string;
}

/** 날짜 하나의 요약 저장 파일을 읽어요. 읽지 못하거나 깨졌으면 저장한 요약이 없는 것으로 봐요(A27). */
export function readSummaryFile(dataDir: string, date: string): ReadResult {
  const entries = new Map<string, StoredSummary>();
  let raw: string;
  try {
    raw = readFileSync(summaryFilePath(dataDir, date), 'utf8');
  } catch (err) {
    const code = errorCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? { entries, problem: null } : { entries, problem: 'unreadable', code };
  }
  const file = parseSummaryFile(raw);
  if (!file) return { entries, problem: 'broken' };
  for (const e of file.sessions) entries.set(e.sessionId, e);
  return { entries, problem: null };
}

export const sameRange = (a: { start: string; end: string }, b: { start: string; end: string }) => a.start === b.start && a.end === b.end;

export const sameMark = (a: MaterialMark, b: MaterialMark) =>
  a.userLines === b.userLines && a.assistantLines === b.assistantLines && a.lastLineAt === b.lastLineAt;

/**
 * 받은 요약 한 줄을 디스크에 쓰기 전에 다듬어요(A27): 원문 속 가림 표시 모양 글자를 바꾸고(도구가 가린 자리로 세지 않게),
 * F2(내장 규칙 + 사용자 패턴)로 가린 뒤 한 줄로 만들어요. 비면 null(빈 결과, 실패로 세요). 가리기 전 글은 어디에도 쓰지 않아요.
 */
export function sanitizeReceived(raw: string, redactor: Redactor): string | null {
  const t = oneLine(redactor.redactString(neutralizeMarkers(raw)));
  if (!t) return null;
  return t.length <= STORE_MAX ? t : truncateKeepingMarkers(t, STORE_MAX - 1);
}

/**
 * 요약 하나를 그 날짜 파일에 더해요(같은 세션은 바꿔요). 받는 대로 바로 써서, 중간에 멈춰도 다음 실행이 다시 부르지 않아요(A26).
 * 원래 파일이 깨졌으면 새로 써요(남은 내용을 읽을 수 없어서예요). 쓰지 못하면 오류를 던져요.
 */
export function saveSummary(dataDir: string, date: string, entry: StoredSummary): void {
  const cur = readSummaryFile(dataDir, date);
  if (cur.problem === 'unreadable') {
    const e = new Error('요약 저장 파일을 읽지 못했어요') as NodeJS.ErrnoException;
    e.code = cur.code ?? 'EIO';
    throw e;
  }
  cur.entries.set(entry.sessionId, entry);
  const file: SummaryFile = {
    schema: 1,
    date,
    sessions: [...cur.entries.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)),
  };
  writeFileAtomic(summaryFilePath(dataDir, date), `${JSON.stringify(file, null, 1)}\n`);
}
