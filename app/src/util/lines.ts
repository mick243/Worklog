// 큰 jsonl 파일을 한 번에 메모리에 올리지 않고 줄 단위로 읽어요.
// 줄마다 끝 바이트 위치를 함께 돌려줘서, 보관할 때 "어디까지 읽었는지"를 정확히 기억할 수 있어요.
import { open } from 'node:fs/promises';

export interface LineRead {
  /** 줄 내용 (끝의 \r\n, \n 제외) */
  line: string;
  /** 이 줄의 \n 다음 바이트 위치 */
  end: number;
}

/**
 * start 바이트부터 끝까지, \n으로 끝난 줄만 차례로 돌려줘요.
 * 마지막에 \n 없이 끊긴 줄(아직 쓰는 중인 줄)은 돌려주지 않아요.
 * 파일은 읽기 전용('r')으로 열어서 내용과 수정 시각을 바꾸지 않아요.
 */
export async function* readLines(path: string, start = 0, chunkSize = 1 << 20): AsyncGenerator<LineRead> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = start;
    let pending: Buffer[] = [];
    let pendingLen = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, pos);
      if (bytesRead === 0) break;
      let from = 0;
      while (from < bytesRead) {
        const nl = buf.indexOf(10, from);
        if (nl === -1 || nl >= bytesRead) {
          pending.push(Buffer.from(buf.subarray(from, bytesRead)));
          pendingLen += bytesRead - from;
          break;
        }
        const piece = buf.subarray(from, nl);
        const lineBuf = pendingLen > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        pendingLen = 0;
        let line = lineBuf.toString('utf8');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const end = pos + nl + 1;
        from = nl + 1;
        yield { line, end };
      }
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}

export interface RawLineRead {
  /** 줄 바이트 그대로 (끝의 \n 제외, \r은 남겨요). 돌려준 뒤에 바뀌지 않는 복사본이에요. */
  raw: Buffer;
  /** 이 줄의 시작 바이트 위치 */
  start: number;
  /** 이 줄의 \n 다음 바이트 위치 */
  end: number;
}

/**
 * readLines와 같지만 줄을 바이트 그대로 돌려줘요. 보관본을 다시 쓸 때 바뀌지 않는 줄을 한 바이트도 바꾸지 않으려고 써요.
 * 마지막에 \n 없이 끊긴 부분은 돌려주지 않아요(부르는 쪽이 파일 크기로 알아내요).
 */
export async function* readRawLines(path: string, chunkSize = 1 << 20): AsyncGenerator<RawLineRead> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = 0;
    let lineStart = 0;
    let pending: Buffer[] = [];
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, pos);
      if (bytesRead === 0) break;
      let from = 0;
      while (from < bytesRead) {
        const nl = buf.indexOf(10, from);
        if (nl === -1 || nl >= bytesRead) {
          pending.push(Buffer.from(buf.subarray(from, bytesRead)));
          break;
        }
        const piece = Buffer.from(buf.subarray(from, nl));
        const raw = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        const end = pos + nl + 1;
        yield { raw, start: lineStart, end };
        lineStart = end;
        from = nl + 1;
      }
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}
