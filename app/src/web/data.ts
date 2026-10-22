// 로컬 화면이 읽는 데이터. 데이터 폴더(일지 JSON, 보관 색인)만 읽고 원본 세션 기록은 열지 않아요.
// 보관 상태는 "마지막 실행 기준"이에요(화면은 원본을 직접 확인하지 않아요).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyIndex, lastRunFailed, loadIndex, type ArchiveIndex, type IndexEntry } from '../archive/archive.js';
import { dataPaths, WARN_DAYS } from '../config.js';
import { parseJsonText } from '../util/json.js';
import type { DayLog } from '../worklog/types.js';

const DAY_MS = 86_400_000;

/** pending = "보관 실패"(마지막 실행에서 보관에 실패, 삭제 예상일까지 8일 이상), imminent = "삭제 임박"(실패, 7일 이하) */
export type SessionState = 'archived' | 'pending' | 'imminent' | 'archive-only';
export type DayState = SessionState | 'no-sessions';

export interface SessionStatus {
  state: SessionState;
  /** 삭제 예상일까지 남은 날 (보관 실패·삭제 임박일 때만) */
  daysLeft: number | null;
  /** 가장 빠른 삭제 예상일 (보관 실패·삭제 임박일 때만, 화면 배너 문장에 써요) */
  deleteAtMs?: number | null;
}

export interface DayStatus {
  state: DayState;
  /** 상태별 세션 수 */
  counts: Record<SessionState, number>;
  daysLeft: number | null;
  /** 그날 보관 실패·삭제 임박 세션 중 가장 빠른 삭제 예상일 (S2 배너 문장에 써요) */
  earliestDeleteAt?: number | null;
}

/** 일지 파일이 있는 날짜 (오래된 → 최신) */
export function listDates(dataDir: string): string[] {
  const dir = dataPaths(dataDir).worklogsDir;
  const names = readdirSync(dir); // 폴더가 없으면 ENOENT를 던져요 (빈 상태로 처리)
  return names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n)?.[1])
    .filter((d): d is string => !!d)
    .sort();
}

export function readDay(dataDir: string, date: string): DayLog {
  const file = join(dataPaths(dataDir).worklogsDir, `${date}.json`);
  const data = parseJsonText(readFileSync(file, 'utf8')) as DayLog; // 손으로 고치며 붙은 BOM도 읽어요(X-01)
  if (!data || data.schema !== 1 || !Array.isArray(data.projects)) throw new Error('bad worklog');
  return data;
}

export function readIndexSafe(dataDir: string): ArchiveIndex {
  try {
    return loadIndex(dataDir);
  } catch {
    return emptyIndex(30);
  }
}

export function entriesBySession(index: ArchiveIndex): Map<string, IndexEntry[]> {
  const m = new Map<string, IndexEntry[]>();
  for (const e of Object.values(index.files)) {
    const list = m.get(e.sessionId) ?? [];
    list.push(e);
    m.set(e.sessionId, list);
  }
  return m;
}

export function sessionStatus(entries: IndexEntry[] | undefined, now: number): SessionStatus {
  if (!entries || entries.length === 0) return { state: 'archived', daysLeft: null };
  // 마지막 실행에서 보관에 실패했고 원본이 아직 남은 파일 (보관 색인의 failed 칸, PRD 5장)
  const pending = entries.filter((e) => lastRunFailed(e) && e.originalExists);
  if (pending.length > 0) {
    const del = Math.min(...pending.map((e) => (e.deleteAt ? Date.parse(e.deleteAt) : Infinity)));
    const daysLeft = Number.isFinite(del) ? Math.max(0, Math.ceil((del - now) / DAY_MS)) : null;
    return { state: daysLeft !== null && daysLeft <= WARN_DAYS ? 'imminent' : 'pending', daysLeft, deleteAtMs: Number.isFinite(del) ? del : null };
  }
  if (entries.every((e) => !e.originalExists)) return { state: 'archive-only', daysLeft: null };
  return { state: 'archived', daysLeft: null };
}

/** 하루의 보관 상태: 가장 급한 것 하나 (삭제 임박 > 보관 실패 > 보관됨 > 보관본만 남음) */
export function dayStatus(day: DayLog, bySession: Map<string, IndexEntry[]>, now: number): DayStatus {
  const counts: Record<SessionState, number> = { archived: 0, pending: 0, imminent: 0, 'archive-only': 0 };
  let daysLeft: number | null = null;
  let earliestDeleteAt: number | null = null;
  const ids = new Set(day.projects.flatMap((p) => p.sessions.map((s) => s.sessionId)));
  for (const id of ids) {
    const st = sessionStatus(bySession.get(id), now);
    counts[st.state]++;
    if ((st.state === 'imminent' || st.state === 'pending') && st.daysLeft !== null) {
      daysLeft = daysLeft === null ? st.daysLeft : Math.min(daysLeft, st.daysLeft);
    }
    if (st.deleteAtMs != null) earliestDeleteAt = earliestDeleteAt === null ? st.deleteAtMs : Math.min(earliestDeleteAt, st.deleteAtMs);
  }
  if (ids.size === 0) return { state: 'no-sessions', counts, daysLeft: null };
  const state: DayState = counts.imminent
    ? 'imminent'
    : counts.pending
      ? 'pending'
      : counts.archived
        ? 'archived'
        : 'archive-only';
  return { state, counts, daysLeft, earliestDeleteAt };
}

/**
 * 일지가 있는 날짜 행에 잡히지 않는 보관 실패 세션 수 (S1 배너 한 줄, PRD S1).
 * 보관만 했거나 그날 일지를 만들지 않은 날의 세션, 한 번도 보관하지 못한 세션이 여기에 들어요. 삭제 임박도 이 수에 들어요.
 */
export function failedOutsideDays(
  bySession: Map<string, IndexEntry[]>,
  inDays: Set<string>,
  now: number,
): { sessions: number; imminent: number; daysLeft: number | null } {
  let sessions = 0;
  let imminent = 0;
  // 그중 삭제 임박 세션의 가장 빠른 삭제 예상일까지 남은 날 (배너 줄 끝 "(삭제 임박 N개 · D-n)"에만 써요, 상태 판정은 그대로)
  let daysLeft: number | null = null;
  for (const [id, entries] of bySession) {
    if (inDays.has(id)) continue;
    const st = sessionStatus(entries, now);
    if (st.state === 'pending' || st.state === 'imminent') {
      sessions++;
      if (st.state === 'imminent') {
        imminent++;
        if (st.daysLeft !== null) daysLeft = daysLeft === null ? st.daysLeft : Math.min(daysLeft, st.daysLeft);
      }
    }
  }
  return { sessions, imminent, daysLeft };
}

/** 이름·이메일 가리기가 켜졌으면 화면 틀의 경로에서 홈 폴더를 ~ 로 줄여요. */
export function framePath(p: string, hide: boolean, home: string): string {
  if (!hide || !home) return p;
  const lower = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  return lower(p).startsWith(lower(home)) ? `~${p.slice(home.length)}` : p;
}
