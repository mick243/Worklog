// S1·S2 공통 기준 줄 (DESIGN S1·S2 공통 "기준 줄", I-12, 취합이 옮김).
// 열어 둔 화면은 페이지 안 스크립트가 없어 스스로 바뀌지 않아서(PRD 5장), 터미널에서 다시 실행한 뒤 새로 고침해야 바뀐다는 것을
// 맨 위 막대 바로 아래(본문 맨 앞) 늘 같은 자리에서 알려요. 빈 상태·오류 화면에도 같은 자리예요(S2는 "← 날짜 목록" 위).
// 시각은 보관 색인의 마지막 실행 시각(MM-DD HH:mm)이고 S1 보관 상태의 기준 시각과 같은 값이라, S1의 예전
// "보관 상태는 … 실행 기준이에요" 줄을 이 줄이 대신해요. 명령은 빈 상태의 명령 상자와 같은 일지 만들기 명령이에요.
import { localDateTime } from '../util/time.js';
import { html, type Html } from './html.js';

/** 기준 줄 글 (명령 자리는 <code>로 감싸요). 시각을 모르면(보관 색인이 없음) 둘째 모양이에요. */
export const BASIS_TEXT = {
  known: (when: string, cmd: string) => `화면은 마지막 실행(${when}) 기준이에요. 터미널에서 ${cmd}를 다시 실행한 뒤 새로 고침하면 바뀌어요.`,
  unknown: (cmd: string) => `터미널에서 ${cmd}를 실행한 뒤 새로 고침하면 바뀌어요.`,
} as const;

/** 마지막 실행 시각을 `MM-DD HH:mm`으로 (읽을 수 없으면 null) */
export function lastRunLabel(lastRunAt: string | null | undefined): string | null {
  if (!lastRunAt) return null;
  const ms = Date.parse(lastRunAt);
  return Number.isFinite(ms) ? localDateTime(ms).slice(5) : null;
}

export function basisLine(lastRunAt: string | null | undefined, makeCommand: string): Html {
  const when = lastRunLabel(lastRunAt);
  const cmd = html`<code>${makeCommand}</code>`;
  return when
    ? html`<p class="basis muted">화면은 마지막 실행(${when}) 기준이에요. 터미널에서 ${cmd}를 다시 실행한 뒤 새로 고침하면 바뀌어요.</p>`
    : html`<p class="basis muted">터미널에서 ${cmd}를 실행한 뒤 새로 고침하면 바뀌어요.</p>`;
}
