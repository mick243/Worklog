// 가림 표시(마커) 모양. 비밀 값 자리는 [가림:종류] 로 바뀌어요.
// S2 화면은 이 모양을 찾아 칩으로 그리고, 검사 명령은 이 모양을 세어요.
//
// 원문(세션 대화·커밋 메시지 등)에 글자 그대로 "[가림:" 이 들어 있으면, 도구가 가린 자리와 섞이지 않게
// 읽는 단계(보관·일지 만들기)에서 "［가림:"(전각 대괄호)으로 바꿔 남겨요(PRD F2·A17).
// 그래서 보관본·일지·화면에 남는 "[가림:종류]"는 모두 도구가 가린 자리이고, 검사·다시 가리기·S2 칩·마크다운이 같은 수를 봐요.

export const MARKER_PREFIX = '[가림:';
/** 원문 속 가림 표시 모양 글자를 바꿔 남기는 모양 (MARKER_SOURCE에 맞지 않아요) */
export const LITERAL_PREFIX = '［가림:';
/** 마커 하나를 찾는 정규식 원본. 종류 이름에는 ] 와 줄바꿈이 들어가지 않아요. */
export const MARKER_SOURCE = '\\[가림:([^\\]\\n]{1,60})\\]';

export function marker(label: string): string {
  return `${MARKER_PREFIX}${label.replace(/[\]\n]/g, ' ')}]`;
}

export function containsMarker(s: string): boolean {
  return s.includes(MARKER_PREFIX);
}

/** 글 속 마커를 종류별로 세요. */
export function countMarkers(s: string, into: Record<string, number> = {}): Record<string, number> {
  const re = new RegExp(MARKER_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const label = m[1]!;
    into[label] = (into[label] ?? 0) + 1;
  }
  return into;
}

/**
 * 원문 글에 든 가림 표시 모양 글자("[가림:")를 "［가림:"으로 바꿔요. 두 번 해도 같아요.
 * 원문을 처음 읽는 곳(보관할 때 세션 기록 줄, 일지를 만들 때 git에서 읽은 커밋 메시지·브랜치·저장소 경로)에서만 써요.
 * 이미 도구가 가린 글(보관본·일지)에 쓰면 도구가 가린 자리까지 바뀌니 쓰지 않아요.
 */
export function neutralizeMarkers(s: string): string {
  return s.includes(MARKER_PREFIX) ? s.split(MARKER_PREFIX).join(LITERAL_PREFIX) : s;
}

/** 객체 안의 모든 글(칸 이름 포함)에 neutralizeMarkers를 써요. 원본 객체는 바꾸지 않아요. */
export function neutralizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return neutralizeMarkers(value);
  if (Array.isArray(value)) return value.map(neutralizeDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = neutralizeMarkers(k);
      const next = neutralizeDeep(v);
      // "__proto__" 칸도 다른 칸처럼 그대로 남겨요(대입하면 칸이 사라지고 프로토타입이 바뀌어요).
      if (key === '__proto__') Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
      else out[key] = next;
    }
    return out;
  }
  return value;
}
