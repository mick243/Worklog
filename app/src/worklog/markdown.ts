// 하루 일지를 마크다운으로 바꿔요. Notion·블로그에 그대로 붙여 넣을 수 있는 모양이에요 (A14).
// 같은 DayLog면 늘 같은 글이 나와요(만든 시각처럼 바뀌는 값은 넣지 않아요).
import { sortedCounts } from '../redact/redact.js';
import { mdCode, mdEscape, num } from '../util/text.js';
import { clockLabel, dateWithWeekday, duration, localDateTime } from '../util/time.js';
import type { CommitLog, DayLog, ProjectLog, SessionLog } from './types.js';

export function usageText(u: SessionLog['usage']): string | null {
  if (!u) return null;
  if (u.source === 'estimate') return `사용 약 ${duration(u.ms)}(추정)`;
  return `사용 ${duration(u.ms)}${u.wholeSession ? '(세션 전체)' : ''}`;
}

export function linesText(l: SessionLog['lines']): string | null {
  if (!l || (l.added === null && l.removed === null)) return null;
  return `+${num(l.added ?? 0)} / -${num(l.removed ?? 0)}${l.wholeSession ? '(세션 전체)' : ''}`;
}

export interface ProjectTotals {
  usageMs: number;
  added: number;
  removed: number;
  hasLines: boolean;
  /** 더한 값 중에 세션 전체 값(여러 날 세션)이 있는지 */
  whole: boolean;
  /** 더한 값 중에 추정 사용 시간이 있는지 */
  estimated: boolean;
}

export function projectTotals(p: ProjectLog): ProjectTotals {
  let usageMs = 0;
  let added = 0;
  let removed = 0;
  let hasLines = false;
  let wholeUsage = false;
  let wholeLines = false;
  let estimated = false;
  for (const s of p.sessions) {
    usageMs += s.usage?.ms ?? 0;
    if (s.usage && s.usage.ms > 0) {
      if (s.usage.source === 'estimate') estimated = true;
      else if (s.usage.wholeSession) wholeUsage = true;
    }
    if (s.lines) {
      hasLines = true;
      added += s.lines.added ?? 0;
      removed += s.lines.removed ?? 0;
      if (s.lines.wholeSession && (s.lines.added !== null || s.lines.removed !== null)) wholeLines = true;
    }
  }
  // 합계를 보여 주는 값에 섞였을 때만 알려요(사용 시간 합계는 0보다 클 때만 보여 줘요).
  return { usageMs, added, removed, hasLines, whole: (wholeUsage && usageMs > 0) || (wholeLines && hasLines), estimated: estimated && usageMs > 0 };
}

/**
 * 프로젝트 합계 끝에 붙이는 표기(DESIGN S2 프로젝트 머리글). 합계는 세션 값을 그대로 더해서,
 * 세션 전체 값이나 추정 값이 섞였으면 알려요. 화면과 마크다운 머리글 줄이 같은 글이에요. 없으면 빈 글.
 */
export function totalsNote(t: ProjectTotals): string {
  if (t.whole && t.estimated) return ' (세션 전체·추정 값 포함)';
  if (t.whole) return ' (세션 전체 값 포함)';
  if (t.estimated) return ' (추정 값 포함)';
  return '';
}

function countsText(c: Record<string, number>): string {
  return sortedCounts(c)
    .map(([k, v]) => `${k} ${num(v)}`)
    .join(' · ');
}

/**
 * AI 요약 한 줄의 마크다운 문구 (PRD A24, DESIGN 3장 "일지 마크다운 — AI 요약 줄" 글자 그대로, S2와 같은 뜻). 문구를 바꿀 때는 여기만 바꾸면 돼요.
 * 요약을 끈 일지에는 머리 줄도 세션 줄도 없어서 기본 일지 모양은 한 글자도 바뀌지 않아요.
 */
export const SUMMARY_MD = {
  /** 머리 줄 (이름·이메일 줄 바로 다음, git 없음 줄보다 위): 요약을 켰다는 것과 요약한 세션 수(전체 세션 중). 세션이 0개면 `(요약할 세션 없음)` */
  head: (summarized: number, sessions: number) =>
    sessions === 0 ? '- AI 요약: 켜짐 (요약할 세션 없음)' : `- AI 요약: 켜짐 (세션 ${num(sessions)}개 중 ${num(summarized)}개 요약)`,
  /** 세션 항목 안 한 줄의 이름표 (AI가 쓴 글이라는 표시). 요약 글은 요청 글처럼 글자 그대로예요. */
  label: '작업 내용(AI 요약)',
} as const;

/** 요약을 켠 일지에서 요약 글이 들어간 세션 수 */
export function summarizedCount(day: Pick<DayLog, 'projects'>): number {
  return day.projects.reduce((n, p) => n + p.sessions.filter((s) => typeof s.summary === 'string' && s.summary).length, 0);
}

function sessionItem(s: SessionLog, date: string, noRepo: boolean): string[] {
  const out: string[] = [];
  const t0 = clockLabel(Date.parse(s.start), date);
  const t1 = clockLabel(Date.parse(s.end), date);
  const title = s.title ? mdEscape(s.title) : '(제목 없음)';
  out.push(`- ${t0}–${t1} **세션** ${title}`);
  const facts = [
    usageText(s.usage),
    linesText(s.lines),
    s.branches.length ? `브랜치 ${s.branches.map(mdCode).join(', ')}` : null,
    `요청 ${num(s.requests)}개`,
    s.subagents > 0 ? `서브 에이전트 기록 ${num(s.subagents)}개 포함` : null,
  ].filter(Boolean);
  out.push(`  - ${facts.join(' · ')}`);
  if (noRepo && s.cwd) out.push(`  - 작업 폴더: ${mdCode(s.cwd)}`);
  // 요약하지 못한 세션은 줄을 비워 둬요(빈 줄이나 "요약 없음"을 넣지 않아요, A24).
  if (typeof s.summary === 'string' && s.summary) out.push(`  - ${SUMMARY_MD.label}: ${mdEscape(s.summary)}`);
  if (s.firstRequest && s.firstRequest === s.lastRequest) out.push(`  - 요청: ${mdEscape(s.firstRequest)}`);
  else {
    if (s.firstRequest) out.push(`  - 첫 요청: ${mdEscape(s.firstRequest)}`);
    if (s.lastRequest) out.push(`  - 마지막 요청: ${mdEscape(s.lastRequest)}`);
  }
  return out;
}

function commitItem(c: CommitLog, date: string): string[] {
  const t = clockLabel(Date.parse(c.time), date);
  const branch = c.branch ? ` ${mdCode(c.branch)}` : '';
  return [`- ${t} **커밋** ${mdCode(c.hash.slice(0, 7))}${branch} ${mdEscape(c.subject)}`];
}

/** 프로젝트 부분만 (가린 자리 수를 이 글에서 세요) */
export function renderProjects(day: DayLog): string {
  const L: string[] = [];
  for (const p of day.projects) {
    L.push('', `## ${mdEscape(p.name)}`, '');
    if (p.path) L.push(`- 경로: ${mdCode(p.path)}`);
    else L.push('- 작업 폴더가 git 저장소가 아니거나 지금은 없는 세션이에요.');
    const t = projectTotals(p);
    const head = [`세션 ${num(p.sessions.length)}개`, `커밋 ${num(p.commits.length)}개`];
    if (t.usageMs > 0) head.push(`사용 ${duration(t.usageMs)}`);
    if (t.hasLines) head.push(`+${num(t.added)} / -${num(t.removed)}`);
    L.push(`- ${head.join(' · ')}${totalsNote(t)}`);
    for (const n of p.notes) L.push(`- 알림: ${n}`);
    L.push('');

    // 세션과 커밋을 시간순으로 섞어요.
    const items: Array<{ ms: number; order: number; lines: string[] }> = [];
    p.sessions.forEach((s, i) => items.push({ ms: Date.parse(s.start), order: i, lines: sessionItem(s, day.date, p.noRepo) }));
    p.commits.forEach((c, i) => items.push({ ms: Date.parse(c.time), order: 100000 + i, lines: commitItem(c, day.date) }));
    items.sort((a, b) => a.ms - b.ms || a.order - b.order);
    for (const it of items) L.push(...it.lines);
  }
  return L.join('\n');
}

/** 머리의 "가린 자리" 줄. 보관본 다시 가리기가 이 줄만 새 수로 바꿀 때도 써요. */
export function redactionLine(day: Pick<DayLog, 'redactions'>): string {
  const red = countsText(day.redactions);
  const redTotal = Object.values(day.redactions).reduce((a, b) => a + b, 0);
  return `- 가린 자리: ${redTotal > 0 ? `모두 ${num(redTotal)}개 (${red})` : '없음'}`;
}

export function renderMarkdown(day: DayLog): string {
  const L: string[] = [];
  const start = Date.parse(day.range.start);
  const end = Date.parse(day.range.end);
  L.push(`# ${dateWithWeekday(day.date)} 작업일지`, '');
  L.push(`- 기간: ${localDateTime(start)} ~ ${localDateTime(end)} (${day.timeZone})`);
  L.push(`- 프로젝트 ${num(day.totals.projects)}개 · 세션 ${num(day.totals.sessions)}개 · 커밋 ${num(day.totals.commits)}개`);
  L.push(redactionLine(day));
  if (day.hideIdentity) {
    const id = countsText(day.identity);
    L.push(`- 이름·이메일 가리기: 켜짐${id ? ` (${id})` : ''}`);
  } else {
    L.push('- 이름·이메일 가리기: 꺼짐');
  }
  if (day.summaryEnabled === true) L.push(SUMMARY_MD.head(summarizedCount(day), day.totals.sessions));
  if (!day.gitAvailable) L.push('- git을 찾지 못해 커밋 없이 세션만 담았어요.');
  L.push(renderProjects(day), '');
  return L.join('\n');
}
