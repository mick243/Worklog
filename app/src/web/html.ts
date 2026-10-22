// HTML 만들기 도우미. 넣는 값은 모두 글자 그대로 보이게 바꿔서(escape), 세션 기록 속 글이 화면 모양을 바꾸거나 실행되지 않아요.
// 색·글꼴·간격·모서리는 styles/tokens.css 의 CSS 변수로만 써요. 여기에는 색 값을 직접 쓰지 않아요.
import { MARKER_SOURCE } from '../redact/marker.js';

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function piece(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(piece).join('');
  return esc(String(v));
}

/** html`<p>${값}</p>` — 값은 escape하고, Html 값은 그대로 넣어요. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += piece(v) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

export const raw = (s: string) => new Html(s);

/** 글을 escape한 뒤, 가림 표시([가림:종류])를 칩으로 감싸요. 칩 안 글자는 마크다운과 같아요. */
export function withMarkers(text: string): Html {
  const re = new RegExp(MARKER_SOURCE, 'g');
  return new Html(esc(text).replace(re, (m) => `<span class="redacted" title="가린 자리">${m}</span>`));
}

export interface PageOptions {
  title: string;
  body: Html;
  footer: Html;
}

/** S1·S2 공통 틀: 맨 위 막대 + 본문 + 맨 아래 */
export function page(o: PageOptions): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(o.title)}</title>
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/base.css">
</head>
<body>
<header class="topbar">
  <a class="topbar__brand" href="/"><span class="mono">cc-worklog</span> 작업일지</a>
  <span class="topbar__note">읽기 전용 · 이 컴퓨터에서만</span>
</header>
<main class="content">
${o.body.value}
</main>
<footer class="footer muted">
${o.footer.value}
</footer>
</body>
</html>
`;
}
