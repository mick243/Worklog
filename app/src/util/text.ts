// 글자 다듬기 도우미예요.
import { MARKER_SOURCE } from '../redact/marker.js';

/** 줄바꿈과 연속 공백을 공백 하나로 바꿔요. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 글자 수(코드 포인트) max까지 잘라요. 가림 표시([가림:...]) 중간에서는 자르지 않아요.
 * 가리기를 먼저 한 뒤에 잘라야 비밀 값 일부가 남지 않아요.
 */
export function truncateKeepingMarkers(s: string, max: number): string {
  if ([...s].length <= max) return s;
  const re = new RegExp(MARKER_SOURCE, 'g');
  let out = '';
  let count = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  const takeText = (text: string): boolean => {
    for (const ch of text) {
      if (count >= max) return false;
      out += ch;
      count++;
    }
    return true;
  };
  while ((m = re.exec(s)) !== null) {
    if (!takeText(s.slice(last, m.index))) return `${out.trimEnd()}…`;
    const len = [...m[0]].length;
    if (count + len > max) return `${out.trimEnd()}…`;
    out += m[0];
    count += len;
    last = m.index + m[0].length;
  }
  takeText(s.slice(last));
  return `${out.trimEnd()}…`;
}

/** 마크다운에서 서식으로 읽힐 수 있는 글자를 \로 막아요. */
export function mdEscape(s: string): string {
  return s.replace(/[\\`*_<>]/g, (c) => `\\${c}`);
}

/** mdEscape를 되돌려요 (검사 명령이 마크다운을 다시 훑을 때 써요). */
export function mdUnescape(s: string): string {
  return s.replace(/\\([\\`*_<>[\]|#])/g, '$1');
}

/** 마크다운 코드 표시. 값에 `가 있으면 ``로 감싸요. */
export function mdCode(s: string): string {
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}

export function num(n: number): string {
  return n.toLocaleString('ko-KR');
}

/**
 * 숫자 뒤 조사. 숫자를 한국어로 읽은 마지막 소리에 받침이 있으면 "이"·"으로", 없으면 "가"·"로"예요(받침 ㄹ은 "로").
 * 끝자리가 0이면 십·백·천·만(받침 있음)이나 영으로 끝나서 "이"·"으로"예요. 예: 4000이·4000으로, 4848이·4848로, 4849가·4849로.
 */
export function numberParticles(n: number): { subject: '이' | '가'; toward: '으로' | '로' } {
  const d = Math.abs(Math.trunc(n)) % 10;
  if (d === 0 || d === 3 || d === 6) return { subject: '이', toward: '으로' };
  if (d === 1 || d === 7 || d === 8) return { subject: '이', toward: '로' };
  return { subject: '가', toward: '로' }; // 2 이, 4 사, 5 오, 9 구
}
