// 날짜·시각 계산. 날짜는 사용자 컴퓨터의 시간대 기준이고, 하루는 dayStartHour(기본 새벽 3시)에 바뀌어요.

const pad = (n: number) => String(n).padStart(2, '0');

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 시각(ms)이 속한 일지 날짜. 새벽 3시 전이면 전날로 쳐요. */
export function dayKeyOf(ms: number, dayStartHour: number): string {
  const d = new Date(ms);
  if (d.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
  return ymd(d);
}

export function isDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 일지 날짜의 시작·끝 (끝은 포함하지 않아요). */
export function dayRange(date: string, dayStartHour: number): { start: number; end: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const start = new Date(y, m - 1, d, dayStartHour, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, dayStartHour, 0, 0, 0).getTime();
  return { start, end };
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 2026-10-19 → 2026-10-19 (월) */
export function dateWithWeekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${date} (${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`;
}

/** 일지 날짜 기준 시각 표시. 달력으로 다음 날이면 "(다음 날)"을 붙여요. */
export function clockLabel(ms: number, date: string): string {
  const d = new Date(ms);
  const s = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return ymd(d) !== date ? `${s}(다음 날)` : s;
}

export function isNextCalendarDay(ms: number, date: string): boolean {
  return ymd(new Date(ms)) !== date;
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return ymd(new Date(y, m - 1, d + days));
}

export function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '로컬';
  } catch {
    return '로컬';
  }
}

/** 로컬 시각 HH:mm. 일지 날짜와 달력 날짜가 다르면 (+1)을 붙여요. */
export function clock(ms: number, date?: string): string {
  const d = new Date(ms);
  const s = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (date && ymd(d) !== date) return `${s}(+1)`;
  return s;
}

export function localDateTime(ms: number): string {
  const d = new Date(ms);
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 로컬 시간대 오프셋을 붙인 ISO 문자열 (git --since에 넘겨요). */
export function isoLocal(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function duration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return '1분 미만';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}
