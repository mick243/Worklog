// 파일 쓰기·찾기 도우미예요.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * 데이터 폴더에 쓰지 못했어요 (DESIGN S3 오류 `[실패] 데이터 폴더에 쓰지 못했어요`). cli.ts가 경로 줄과 `다음:` 줄로 보여 줘요.
 * 오류 문구에는 데이터 폴더 경로와 오류 코드만 넣어요(파일 내용 조각은 넣지 않아요).
 */
export class DataDirWriteError extends Error {
  constructor(
    readonly dataDir: string,
    readonly code: string,
  ) {
    super(`데이터 폴더에 쓰지 못했어요 (${code})`);
  }
}

/** fn이 파일 시스템 오류(오류 코드가 있는 오류)로 실패하면 DataDirWriteError로 바꿔 던져요. 그 밖의 오류는 그대로 던져요. */
export function writingDataDir<T>(dataDir: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) throw new DataDirWriteError(dataDir, code);
    throw err;
  }
}

/** 임시 파일에 쓴 뒤 이름을 바꿔서, 쓰다 멈춰도 반쯤 쓴 파일이 남지 않게 해요. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf8');
  renameWithRetry(tmp, path);
}

export function renameWithRetry(from: string, to: string): void {
  // Windows에서는 다른 프로그램이 파일을 잠깐 열고 있으면 이름 바꾸기가 실패할 수 있어요.
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(from, { force: true });
        throw err;
      }
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) {
        /* 잠깐 기다려요 */
      }
    }
  }
}

function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* 잠깐 기다려요 */
  }
}

/**
 * 이름 바꾸기(덮어쓰기)를 다시 시도해요. renameWithRetry와 달리 끝내 실패해도 원래 파일을 지우지 않아요.
 * 보관본 다시 가리기에서 새 내용이 든 파일을 잃지 않으려고 써요.
 */
export function renameStrict(from: string, to: string, tries = 20): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= tries || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      sleepSync(25 * (i + 1));
    }
  }
}

/** 파일을 쓰고 디스크에 내려보낸 뒤 닫아요 (전원이 꺼져도 다음 실행이 이어서 끝낼 수 있게). */
export function writeFileDurable(path: string, data: string | Buffer): void {
  const fd = openSync(path, 'w');
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 임시 파일에 쓰고 내려보낸 뒤 이름을 바꿔요. 다시 가리기 기록(저널)처럼 반쯤 쓴 채 남으면 안 되는 작은 파일에 써요. */
export function writeFileAtomicDurable(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileDurable(tmp, data);
    renameStrict(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * 폴더 아래 파일을 재귀로 찾아 정렬해서 돌려줘요. 심볼릭 링크는 따라가지 않아요.
 * onError: 폴더를 읽지 못했을 때(없음·폴더 아님 말고, 권한 없음 등) 불러요. 주지 않으면 그 폴더는 말없이 건너뛰어요.
 */
export function walkFiles(root: string, accept: (name: string) => boolean, onError?: (dir: string, code: string) => void): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = errorCode(err);
      if (onError && code !== 'ENOENT' && code !== 'ENOTDIR') onError(dir, code);
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && accept(e.name)) out.push(full);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 기준 폴더에서 본 상대 경로를 / 구분자로 바꿔요. */
export function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 파일 앞부분 n바이트의 해시. 원본이 통째로 바뀌었는지 알아볼 때 써요. */
export function headHash(path: string, n: number): string {
  if (n <= 0) return sha256('');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got);
      if (r === 0) break;
      got += r;
    }
    return sha256(buf.subarray(0, got));
  } finally {
    closeSync(fd);
  }
}

export function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 오류 코드(EBUSY 등). 코드가 없는 오류는 이름을 돌려줘요. 오류 문구(파일 내용 조각이 섞일 수 있어요)는 쓰지 않아요. */
export function errorCode(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return typeof e?.code === 'string' ? e.code : (e?.name ?? 'Error');
}

/** 다른 프로그램이 잡고 있거나 권한이 없어 파일을 열지 못한 오류인지 (Windows 공유 위반은 EBUSY, 읽기 전용·권한은 EPERM·EACCES) */
export function isAccessError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ETXTBSY';
}

/**
 * 파일을 읽기·쓰기로 열 수 있는지 봐요. 연 뒤 아무것도 쓰지 않고 바로 닫아서 내용·크기·수정 시각은 그대로예요.
 * 열 수 있으면 null, 없으면 오류 코드(EBUSY·EPERM·EACCES 등)예요. 파일이 없으면(ENOENT) 쓸 수 있는 것으로 봐요(새로 만들어요).
 * 다른 프로그램이 공유 없이 연 파일(Windows), 읽기 전용 파일, 권한 없는 파일을 바꾸기 전에 알아보려고 써요(F2-23).
 * 한계: Windows에서 쓰기는 허락하고 지우기·이름 바꾸기만 막은 프로그램은 여기서 알아보지 못해요(그때는 이름을 바꿀 때 실패해요).
 */
export function probeWritable(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch (err) {
    const code = errorCode(err);
    return code === 'ENOENT' ? null : code;
  }
  closeSync(fd);
  return null;
}
