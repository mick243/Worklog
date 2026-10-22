// 터미널 출력 도우미. 색은 TTY이고 NO_COLOR가 없을 때 이름표에만 써요(글자만으로도 뜻이 읽혀요).
// 기호는 ASCII·한글·가운뎃점만 쓰고, 칸 맞춤은 글자 수가 아니라 표시 폭으로 계산해요.

export interface Painter {
  ok(s: string): string;
  fail(s: string): string;
  warn(s: string): string;
  bold(s: string): string;
}

export function painter(stream: NodeJS.WriteStream = process.stdout): Painter {
  return painterFor(Boolean(stream.isTTY) && !process.env.NO_COLOR);
}

/** 색을 쓸지 직접 정해서 만들어요 (보관본 다시 가리기처럼 출력 대상을 바꿔 끼우는 곳에서 써요). */
export function painterFor(on: boolean): Painter {
  const wrap = (open: string) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[0m` : s);
  return { ok: wrap('1;32'), fail: wrap('1;31'), warn: wrap('1;33'), bold: wrap('1') };
}

/** 터미널 한 줄의 최대 폭 (DESIGN S3·S4: 80칸 안에 들어오게) */
export const MAX_WIDTH = 80;

const ANSI = /\x1b\[[0-9;]*m/g;

/** 한글·한자·전각 글자는 두 칸으로 셈해요. 색 코드는 폭에 넣지 않아요. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) {
    const c = ch.codePointAt(0)!;
    if (c === 0) continue;
    if (
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export function padW(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/**
 * 글을 공백에서 끊어 한 줄이 width(표시 폭)를 넘지 않게 나눠요. 첫 줄 앞에는 first, 다음 줄부터는 rest를 붙여요.
 * 공백 없는 긴 낱말(경로 등)은 자르지 않고 그대로 둬서 복사할 수 있게 해요.
 */
export function wrapText(text: string, first: string, rest: string, width = MAX_WIDTH): string[] {
  const lines: string[] = [];
  let cur = first;
  let hasWord = false;
  for (const word of text.split(' ')) {
    const next = hasWord ? `${cur} ${word}` : `${cur}${word}`;
    if (hasWord && displayWidth(next) > width) {
      lines.push(cur);
      cur = `${rest}${word}`;
    } else {
      cur = next;
    }
    hasWord = true;
  }
  lines.push(cur);
  return lines;
}

/**
 * 덩어리(parts)를 sep으로 이어 붙이되 덩어리 중간에서는 끊지 않아요. 한 줄이 width를 넘으면 sep 끝 글자를 남기고 다음 줄로 넘겨요.
 * 첫 줄 앞에는 first, 다음 줄부터는 rest를 붙여요.
 */
export function wrapParts(parts: string[], sep: string, first: string, rest: string, width = MAX_WIDTH): string[] {
  const lines: string[] = [];
  let cur = first;
  let has = false;
  for (const part of parts) {
    const next = has ? `${cur}${sep}${part}` : `${cur}${part}`;
    if (has && displayWidth(next) > width) {
      lines.push(`${cur}${sep.trimEnd()}`);
      cur = `${rest}${part}`;
    } else {
      cur = next;
    }
    has = true;
  }
  lines.push(cur);
  return lines;
}

/** 진행 표시: TTY일 때만 표준 오류에 한 줄로 덮어쓰고, 1초 안에 끝나면 보이지 않아요. */
export function progress(label: string, unit = '파일') {
  const tty = Boolean(process.stderr.isTTY);
  const started = Date.now();
  let shown = false;
  let lastDraw = 0;
  return {
    update(done: number, total: number, bytesDone?: number, bytesTotal?: number) {
      if (!tty) return;
      const now = Date.now();
      if (now - started < 1000 || now - lastDraw < 100) return;
      lastDraw = now;
      shown = true;
      const size = bytesTotal ? ` (${mb(bytesDone ?? 0)} / ${mb(bytesTotal)})` : '';
      process.stderr.write(`\r${label} ${done}/${total} ${unit}${size}\x1b[K`);
    },
    done() {
      if (tty && shown) process.stderr.write('\r\x1b[K');
    },
  };
}

function mb(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  return `${Math.round(n / 1024 ** 2)}MB`;
}
