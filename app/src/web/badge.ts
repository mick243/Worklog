// S1·S2 공통 보관 상태 배지. 모양·글자·색을 함께 써서 색만으로 뜻을 전하지 않아요.
// 모양(●○▲■—)은 CSS 도형으로 그려요(글꼴에 따라 기호가 네모로 깨지지 않게). 기호 글자는 CSS가 없을 때를 위해 남겨 두고 화면에서는 숨겨요.
import type { DayState, DayStatus, SessionStatus } from './data.js';
import { html, type Html } from './html.js';

const SHAPE: Record<DayState, { glyph: string; kind: string }> = {
  archived: { glyph: '●', kind: 'circle' },
  pending: { glyph: '○', kind: 'ring' },
  imminent: { glyph: '▲', kind: 'triangle' },
  'archive-only': { glyph: '■', kind: 'square' },
  'no-sessions': { glyph: '—', kind: 'dash' },
};

/** 상태 모양 하나 (배지 안, 삭제 임박 배너 앞) */
export function stateShape(state: DayState, extraClass = ''): Html {
  const s = SHAPE[state];
  return html`<span class="${extraClass ? `${extraClass} ` : ''}shape shape--${s.kind}" aria-hidden="true">${s.glyph}</span>`;
}

function dayLabel(st: DayStatus): string {
  const n = st.counts;
  const mixed = [n.archived, n.pending, n.imminent, n['archive-only']].filter((x) => x > 0).length > 1;
  switch (st.state) {
    case 'imminent':
      // 섞인 날은 `삭제 임박 2개 · D-3`, 삭제 임박만 있는 날은 `삭제 임박 D-3` (DESIGN S1·S2 공통 배지)
      return mixed
        ? `삭제 임박 ${n.imminent}개${st.daysLeft !== null ? ` · D-${st.daysLeft}` : ''}`
        : `삭제 임박${st.daysLeft !== null ? ` D-${st.daysLeft}` : ''}`;
    case 'pending':
      return `보관 실패${mixed ? ` ${n.pending}개` : ''}`;
    case 'archived':
      return `보관됨${mixed ? ` ${n.archived}개` : ''}`;
    case 'archive-only':
      return '보관본만 남음';
    case 'no-sessions':
      return '세션 없음';
  }
}

/**
 * "보관본만 남음" 풀이 줄 (DESIGN S1·S2 공통 "보관 상태 배지", I-11). 그 화면에 `보관본만 남음` 배지가 하나라도 보일 때만 한 번 보여 줘요.
 * 자리는 S1 요약 줄 바로 아래, S2 알림 줄의 "(세션 전체)" 풀이 다음이에요.
 */
export const ARCHIVE_ONLY_HELP =
  '보관본만 남음은 원본 세션 기록이 지워지고, cc-worklog가 비밀 값을 가려 옮겨 둔 사본(보관본)만 남았다는 뜻이에요. 일지는 보관본으로 만들어서 그대로 볼 수 있어요.';

export function archiveOnlyHelp(): Html {
  return html`<p class="archive-only-help muted">${ARCHIVE_ONLY_HELP}</p>`;
}

export function dayBadge(st: DayStatus): Html {
  return html`<span class="badge badge--${st.state}">${stateShape(st.state, 'badge__shape')} ${dayLabel(st)}</span>`;
}

export function sessionBadge(st: SessionStatus): Html | null {
  if (st.state !== 'imminent' && st.state !== 'pending') return null;
  const label = st.state === 'imminent' ? `삭제 임박${st.daysLeft !== null ? ` D-${st.daysLeft}` : ''}` : '보관 실패';
  return html`<span class="badge badge--${st.state}">${stateShape(st.state, 'badge__shape')} ${label}</span>`;
}
