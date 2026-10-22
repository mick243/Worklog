// S2 하루 일지 (로컬 화면)
// 고른 날짜의 일지를 프로젝트별로 읽는 화면이에요. 프로젝트마다 세션과 커밋을 시간순으로 함께 보여 주고,
// 가려진 자리는 종류와 함께 칩으로 표시해요. 같은 내용의 마크다운 파일 위치도 알려 줘요.
// 요청 글은 마크다운·HTML로 해석하지 않고 글자 그대로 보여 줘요.
import { num } from '../util/text.js';
import { clockLabel, dateWithWeekday, duration, isNextCalendarDay, localDateTime } from '../util/time.js';
import { projectTotals, totalsNote, usageText } from '../worklog/markdown.js';
import type { CommitLog, DayLog, ProjectLog, SessionLog } from '../worklog/types.js';
import { archiveOnlyHelp, dayBadge, sessionBadge, stateShape } from './badge.js';
import { basisLine } from './basis-line.js';
import type { DayStatus, SessionStatus } from './data.js';
import { html, page, withMarkers, type Html } from './html.js';
import { redactBanner } from './redact-banner.js';
import type { PendingNotice } from '../redact/journal.js';

export interface S2Data {
  date: string;
  /** 일지가 없으면 null */
  day: DayLog | null;
  /** 일지를 읽지 못했으면 true */
  unreadable?: boolean;
  status: DayStatus | null;
  sessionStatus: (sessionId: string) => SessionStatus;
  mdPath: string;
  prevDate: string | null;
  nextDate: string | null;
  dataDir: string;
  version: string;
  archiveCommand: string;
  /** 일지 만들기 명령 (일지를 읽지 못했을 때 `… make --date 날짜`로 안내해요). 없으면 cc-worklog */
  makeCommand?: string;
  /** 보관 상태의 기준인 마지막 실행 시각 (보관 실패 배너 문장에 써요) */
  lastRunAt?: string | null;
  /** 멈춘 보관본 다시 가리기 (페이지를 만들 때 다시 쓰기 기록을 읽어 정해요, A16) */
  redact?: PendingNotice;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const cmds = (d: S2Data) => ({ makeCommand: d.makeCommand ?? 'cc-worklog', archiveCommand: d.archiveCommand });

function footer(d: S2Data): Html {
  return html`<p>데이터 폴더 <span class="mono path">${d.dataDir}</span> · cc-worklog ${d.version}${
    d.day ? html` · 일지를 만든 시각 ${localDateTime(Date.parse(d.day.generatedAt))}` : null
  }</p>`;
}

/** 보관 실패 배너 (S1과 같은 모양): 삭제 임박이 섞이면 ▲ 노랑, 보관 실패만 있으면 ○ 흰 바탕. 문장은 늘 "마지막 실행에서 보관하지 못한 세션"이에요. */
function failBanner(st: DayStatus, d: S2Data): Html {
  const imminent = st.state === 'imminent';
  const when = d.lastRunAt ? `마지막 실행(${localDateTime(Date.parse(d.lastRunAt)).slice(5)})에서` : '마지막 실행에서';
  let del = '';
  if (st.earliestDeleteAt != null) {
    const x = new Date(st.earliestDeleteAt);
    del = ` 가장 빠른 삭제 예상일은 ${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}예요${st.daysLeft !== null ? `(D-${st.daysLeft})` : ''}.`;
  }
  return html`<div class="banner ${imminent ? 'banner--warning' : 'banner--pending'}" role="status"><strong class="banner__title">${stateShape(st.state)} ${imminent ? '삭제 임박' : '보관 실패'}</strong>
이 날 세션 중 ${num(st.counts.imminent + st.counts.pending)}개를 ${when} 보관하지 못했어요.${del} 터미널에서 <code>${d.archiveCommand}</code>를 다시 실행하세요.</div>`;
}

/** 세션 카드에 "(세션 전체)"가 붙은 값이 하나라도 있는지 (있으면 설명 줄을 한 번 보여 줘요) */
function hasWholeSession(day: DayLog): boolean {
  return day.projects.some((p) =>
    p.sessions.some(
      (s) =>
        (s.usage !== null && s.usage.source !== 'estimate' && s.usage.wholeSession) ||
        (s.lines !== null && s.lines.wholeSession && (s.lines.added !== null || s.lines.removed !== null)),
    ),
  );
}

function timeCell(ms: number, date: string): Html {
  return html`<span class="mono">${clockLabel(ms, date).replace('(다음 날)', '')}</span>${
    isNextCalendarDay(ms, date) ? html` <span class="muted next-day">다음 날</span>` : null
  }`;
}

function sessionCard(s: SessionLog, date: string, noRepo: boolean, st: SessionStatus): Html {
  const t0 = clockLabel(Date.parse(s.start), date);
  const t1 = clockLabel(Date.parse(s.end), date);
  const usage = usageText(s.usage);
  const lines = s.lines && (s.lines.added !== null || s.lines.removed !== null) ? s.lines : null;
  const badge = sessionBadge(st);
  const same = s.firstRequest && s.firstRequest === s.lastRequest;
  return html`<article class="session">
<p class="session__title"><span class="tag">세션</span> ${s.title ? withMarkers(s.title) : html`<span class="muted">(제목 없음)</span>`}</p>
<p class="session__meta muted"><span class="mono">${t0}–${t1}</span>${usage ? html` · ${usage}` : null}${
    lines
      ? html` · <span class="add">+${num(lines.added ?? 0)}</span> <span class="del">−${num(lines.removed ?? 0)}</span>${lines.wholeSession ? '(세션 전체)' : ''}`
      : null
  }${s.branches.length ? html` · 브랜치 ${s.branches.map((b, i) => html`${i ? ', ' : ''}<code class="branch">${withMarkers(b)}</code>`)}` : null} · 요청 ${num(s.requests)}개</p>
${noRepo && s.cwd ? html`<p class="session__cwd"><span class="label muted">작업 폴더</span> <span class="mono path">${withMarkers(s.cwd)}</span></p>` : null}
${
  same
    ? html`<p class="session__req"><span class="label muted">요청</span> ${withMarkers(s.firstRequest!)}</p>`
    : html`${s.firstRequest ? html`<p class="session__req"><span class="label muted">첫 요청</span> ${withMarkers(s.firstRequest)}</p>` : null}
${s.lastRequest ? html`<p class="session__req"><span class="label muted">마지막 요청</span> ${withMarkers(s.lastRequest)}</p>` : null}`
}
${s.subagents > 0 || badge ? html`<p class="session__extra muted">${s.subagents > 0 ? `서브 에이전트 기록 ${num(s.subagents)}개 포함` : ''} ${badge}</p>` : null}
</article>`;
}

function commitLine(c: CommitLog): Html {
  return html`<div class="commit">
<p class="commit__head"><span class="tag">커밋</span> <code class="hash" title="${c.hash}">${c.hash.slice(0, 7)}</code>${
    c.branch ? html` <code class="branch">${withMarkers(c.branch)}</code>` : null
  } <span class="commit__subject">${withMarkers(c.subject)}</span></p>
</div>`;
}

function projectSection(p: ProjectLog, i: number, d: S2Data, day: DayLog): Html {
  const t = projectTotals(p);
  const items: Array<{ ms: number; order: number; html: Html }> = [];
  p.sessions.forEach((s, k) =>
    items.push({ ms: Date.parse(s.start), order: k, html: sessionCard(s, day.date, p.noRepo, d.sessionStatus(s.sessionId)) }),
  );
  p.commits.forEach((c, k) => items.push({ ms: Date.parse(c.time), order: 100000 + k, html: commitLine(c) }));
  items.sort((a, b) => a.ms - b.ms || a.order - b.order);
  return html`<section class="project${p.noRepo ? ' project--none' : ''}" id="p-${i + 1}">
<header class="project__head">
<h2>${withMarkers(p.name)}</h2>
${p.path ? html`<p class="mono path muted">${withMarkers(p.path)}</p>` : html`<p class="muted">작업 폴더가 git 저장소가 아니거나 지금은 없는 세션이에요</p>`}
<p class="muted">세션 ${num(p.sessions.length)} · 커밋 ${num(p.commits.length)}${t.usageMs > 0 ? ` · 사용 ${duration(t.usageMs)}` : ''}${
    t.hasLines ? html` · <span class="add">+${num(t.added)}</span> <span class="del">−${num(t.removed)}</span>` : null
  }${totalsNote(t)}</p>
${p.notes.map((n) => html`<p class="note">${n}</p>`)}
</header>
<ol class="timeline">
${items.map((it) => html`<li class="timeline__item"><div class="timeline__time">${timeCell(it.ms, day.date)}</div><div class="timeline__body">${it.html}</div></li>
`)}
</ol>
</section>`;
}

export function renderS2(d: S2Data): string {
  const title = `${dateWithWeekday(d.date)} — cc-worklog`;
  // 맨 위 기준 줄(I-12)은 빈 상태·오류 화면에도 같은 자리, "← 날짜 목록" 링크보다 위예요(DESIGN S1·S2 공통 "기준 줄").
  const back = html`${basisLine(d.lastRunAt, cmds(d).makeCommand)}
<p class="back"><a href="/">← 날짜 목록</a></p>`;
  if (d.unreadable) {
    return page({
      title,
      body: html`${back}<h1>${dateWithWeekday(d.date)}</h1>
<div class="banner banner--error" role="alert"><strong>오류</strong> ${d.date} 일지를 읽지 못했어요.
<span class="mono path">${d.mdPath}</span> 터미널에서 <code>${d.makeCommand ?? 'cc-worklog'} make --date ${d.date}</code>로 그날 일지를 다시 만들어 보세요.</div>
${redactBanner(d.redact, cmds(d))}`,
      footer: footer(d),
    });
  }
  if (!d.day) {
    return page({
      title,
      body: html`${back}${redactBanner(d.redact, cmds(d))}<section class="empty"><p>이 날짜의 일지가 없어요</p></section>`,
      footer: footer(d),
    });
  }
  const day = d.day;
  const redTotal = Object.values(day.redactions).reduce((a, b) => a + b, 0) + Object.values(day.identity ?? {}).reduce((a, b) => a + b, 0);
  const pending = d.status && (d.status.state === 'imminent' || d.status.state === 'pending') ? d.status : null;

  const body = html`${back}
<header class="day-head">
<h1>${dateWithWeekday(day.date)} ${d.status ? dayBadge(d.status) : null}</h1>
<p class="muted">${pad2(day.dayStartHour)}:00 ~ 다음 날 ${pad2(day.dayStartHour)}:00 · 프로젝트 ${num(day.totals.projects)} · 세션 ${num(day.totals.sessions)} · 커밋 ${num(day.totals.commits)} · 가린 자리 ${num(redTotal)}</p>
</header>
<nav class="pager" aria-label="다른 날짜">
${d.prevDate ? html`<a class="pager__prev" href="/day/${d.prevDate}">‹ ${d.prevDate}</a>` : html`<span></span>`}
${d.nextDate ? html`<a class="pager__next" href="/day/${d.nextDate}">${d.nextDate} ›</a>` : html`<span></span>`}
</nav>
<div class="md-path"><span class="label muted">같은 내용의 마크다운 파일</span> <span class="mono path md-path__value">${d.mdPath}</span></div>
${redactBanner(d.redact, cmds(d))}
${pending ? failBanner(pending, d) : null}
${!day.gitAvailable ? html`<div class="banner banner--info">git을 찾지 못해 커밋 없이 만든 일지예요.</div>` : null}
${redTotal > 0 ? html`<p class="redacted-help muted">${withMarkers('[가림:종류]')} 이 모양은 비밀 값을 종류 표시로 바꾼 자리예요. 원문은 어디에도 저장하지 않았어요.</p>` : null}
${hasWholeSession(day) ? html`<p class="whole-help muted">(세션 전체)는 여러 날에 걸친 세션이라 그날 값이 아니라 세션 전체 값이라는 뜻이에요.</p>` : null}
${d.status?.state === 'archive-only' ? archiveOnlyHelp() : null}
${
  day.projects.length >= 2
    ? html`<nav class="toc" aria-label="프로젝트 목차"><span class="label muted">목차</span> ${day.projects.map(
        (p, i) => html`${i ? ' · ' : ''}<a href="#p-${i + 1}">${withMarkers(p.name)} ${num(p.sessions.length + p.commits.length)}</a>`,
      )}</nav>`
    : null
}
${day.projects.map((p, i) => projectSection(p, i, d, day))}`;
  return page({ title, body, footer: footer(d) });
}
