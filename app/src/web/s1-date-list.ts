// S1 날짜 목록 (로컬 화면)
// 일지가 있는 날짜를 훑고 하루를 고르는 화면이에요. 날짜마다 프로젝트·세션·커밋 수와 보관 상태를 보여 줘요.
import { num } from '../util/text.js';
import { dateWithWeekday } from '../util/time.js';
import { archiveOnlyHelp, dayBadge, stateShape } from './badge.js';
import { basisLine } from './basis-line.js';
import type { DayStatus } from './data.js';
import { html, page, type Html } from './html.js';
import { redactBanner } from './redact-banner.js';
import type { PendingNotice } from '../redact/journal.js';

export interface DateRow {
  date: string;
  projects: number;
  sessions: number;
  commits: number;
  status: DayStatus;
  /** 그날 일지 JSON을 읽지 못했으면 true */
  unreadable?: boolean;
}

export interface S1Data {
  /** 최신 날짜가 앞 */
  rows: DateRow[];
  lastRunAt: string | null;
  dataDir: string;
  version: string;
  makeCommand: string;
  archiveCommand: string;
  /** 일지가 있는 날짜 행에 잡히지 않는 보관 실패 세션 (삭제 임박 포함, 그중 삭제 임박 수와 가장 빠른 삭제 예상일까지 남은 날) */
  failedElsewhere?: { sessions: number; imminent: number; daysLeft?: number | null };
  /** 일지 폴더를 읽지 못했을 때 */
  error?: 'unreadable';
  /** 멈춘 보관본 다시 가리기 (페이지를 만들 때 다시 쓰기 기록을 읽어 정해요, A16) */
  redact?: PendingNotice;
}

function footer(d: S1Data): Html {
  return html`<p>데이터 폴더 <span class="mono path">${d.dataDir}</span> · cc-worklog ${d.version}</p>`;
}

const zero = (n: number) => (n === 0 ? html`<span class="muted">0</span>` : html`${num(n)}`);

/**
 * 보관 실패 배너: 마지막 실행에서 보관하지 못한 세션이 있는 날짜(삭제 임박·보관 실패)를 모두 S2 링크로 나열하고,
 * 일지가 없는 날짜의 보관 실패 세션은 링크 없이 한 줄로 알려요(PRD S1, 일지가 하나도 없어도 보여요). 없으면 null.
 */
function failBanner(d: S1Data): Html | null {
  const failed = d.rows.filter((r) => r.status.state === 'imminent' || r.status.state === 'pending');
  const other = d.failedElsewhere ?? { sessions: 0, imminent: 0 };
  if (failed.length === 0 && other.sessions === 0) return null;
  const anyImminent = failed.some((r) => r.status.state === 'imminent') || other.imminent > 0;
  const lines: Html[] = [];
  if (failed.length > 0) {
    lines.push(html`마지막 실행에서 보관하지 못한 세션이 있는 날짜가 ${num(failed.length)}개 있어요:
${failed.map(
  (r, i) =>
    html`${i > 0 ? ' · ' : ''}<a href="/day/${r.date}">${r.date}</a>${r.status.state === 'imminent' && r.status.daysLeft !== null ? ` (D-${r.status.daysLeft})` : ''}`,
)}`);
  }
  if (other.sessions > 0) {
    // 그중 삭제 임박이 있으면 끝에 "(삭제 임박 N개 · D-n)"을 붙여요. 이름표가 "삭제 임박"인데 날짜 줄에 D-n이 없을 수 있어서예요(DESIGN S1).
    const urgent =
      other.imminent > 0
        ? ` (삭제 임박 ${num(other.imminent)}개${other.daysLeft != null ? ` · D-${other.daysLeft}` : ''})`
        : '';
    lines.push(
      failed.length > 0
        ? html`일지가 없는 날짜의 보관 실패 세션 ${num(other.sessions)}개도 있어요${urgent}`
        : html`일지가 없는 날짜의 보관 실패 세션이 ${num(other.sessions)}개 있어요${urgent}`,
    );
  }
  return html`<div class="banner ${anyImminent ? 'banner--warning' : 'banner--pending'}" role="status"><strong class="banner__title">${
    anyImminent ? html`${stateShape('imminent')} 삭제 임박` : html`${stateShape('pending')} 보관 실패`
  }</strong>
${lines.map((l, i) => html`${i > 0 ? html`<br>` : null}${l}`)}
<br>터미널에서 <code>${d.archiveCommand}</code>를 다시 실행하세요</div>`;
}

export function renderS1(d: S1Data): string {
  const title = '작업일지 — cc-worklog';
  if (d.error === 'unreadable') {
    return page({
      title,
      body: html`${basisLine(d.lastRunAt, d.makeCommand)}
<div class="banner banner--error" role="alert"><strong>오류</strong> 일지 폴더를 읽지 못했어요.
<span class="mono path">${d.dataDir}</span> 터미널에서 <code>${d.makeCommand}</code>를 다시 실행해 보세요.</div>
${redactBanner(d.redact, d)}`,
      footer: footer(d),
    });
  }
  if (d.rows.length === 0) {
    return page({
      title,
      body: html`${basisLine(d.lastRunAt, d.makeCommand)}
${redactBanner(d.redact, d)}
${failBanner(d)}
<section class="empty">
<p>아직 만든 일지가 없어요</p>
<p class="muted">터미널에서 일지 만들기 명령을 실행하면 여기에 날짜가 생겨요</p>
<pre class="command">${d.makeCommand}</pre>
</section>`,
      footer: footer(d),
    });
  }

  const oldest = d.rows[d.rows.length - 1]!.date;
  const newest = d.rows[0]!.date;
  // 달마다 묶어요.
  const months = new Map<string, DateRow[]>();
  for (const r of d.rows) {
    const key = r.date.slice(0, 7);
    const list = months.get(key) ?? [];
    list.push(r);
    months.set(key, list);
  }

  // 맨 위 기준 줄(I-12)이 보관 상태의 기준 시각도 알려서, 예전 "보관 상태는 … 실행 기준이에요" 줄은 두지 않아요(DESIGN S1 배치 2번).
  const body = html`${basisLine(d.lastRunAt, d.makeCommand)}
<section class="summary">
<h1>일지 ${num(d.rows.length)}일 · ${oldest} ~ ${newest}</h1>
${d.rows.some((r) => !r.unreadable && r.status.state === 'archive-only') ? archiveOnlyHelp() : null}
</section>
${redactBanner(d.redact, d)}
${failBanner(d)}
${[...months.entries()].map(
  ([month, rows]) => html`<section class="month">
<h2>${month.slice(0, 4)}년 ${String(Number(month.slice(5, 7)))}월</h2>
<table class="date-list">
<thead><tr><th scope="col">날짜</th><th scope="col" class="num">프로젝트</th><th scope="col" class="num">세션</th><th scope="col" class="num">커밋</th><th scope="col">보관 상태</th></tr></thead>
<tbody>
${rows.map(
  // 640px 미만에서는 숫자 칸 대신 날짜 아래 한 줄 요약(date-row__compact)을 보여 줘요. 행 전체가 링크 하나예요(CSS로 링크를 행 크기로 늘려요).
  (r) => html`<tr class="date-row">
<td class="date-row__date"><a class="date-row__link" href="/day/${r.date}">${dateWithWeekday(r.date)}</a>${
    r.unreadable
      ? null
      : html`<span class="date-row__compact muted">프로젝트 ${zero(r.projects)} · 세션 ${zero(r.sessions)} · 커밋 ${zero(r.commits)}</span>`
  }</td>
<td class="num">${r.unreadable ? '-' : zero(r.projects)}</td>
<td class="num">${r.unreadable ? '-' : zero(r.sessions)}</td>
<td class="num">${r.unreadable ? '-' : zero(r.commits)}</td>
<td class="date-row__status">${r.unreadable ? html`<span class="muted">읽지 못함</span>` : dayBadge(r.status)}</td>
</tr>
`,
)}
</tbody>
</table>
</section>
`,
)}`;
  return page({ title, body, footer: footer(d) });
}
