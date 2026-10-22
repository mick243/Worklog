// 같은 데이터 폴더를 두 실행이 동시에 쓰지 않게 막는 잠금이에요 (PRD 5장: 보관과 다시 가리기가 같은 보관본을 동시에 쓰면 안 돼요).
// 잠금 파일은 데이터 폴더 밖(OS 임시 폴더)에 둬요. 보관본 다시 가리기는 확인 전에 데이터 폴더에 어떤 파일도 만들면 안 되는데,
// 확인을 기다리는 동안에도 다른 실행을 막아야 하기 때문이에요.
// 잠금을 쥔 실행이 갑자기 꺼지면 파일이 남지만, 그 PID가 이미 끝났으면 다음 실행이 지우고 가져가요.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from './fs.js';

export class BusyError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
  ) {
    super(message);
  }
}

/** 데이터 폴더마다 다른 잠금 파일 경로 (경로 자체는 해시로만 넣어요) */
export function lockPathFor(dataDir: string): string {
  const abs = resolve(dataDir);
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return join(tmpdir(), `cc-worklog-${sha256(key).slice(0, 16)}.lock`);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Holder {
  pid: number;
  command?: string;
}

function readHolder(path: string): Holder | 'unreadable' | 'gone' {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable';
  }
  try {
    const h = JSON.parse(raw) as Holder;
    return typeof h?.pid === 'number' ? h : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function recentlyWritten(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < 10_000;
  } catch {
    return false;
  }
}

/**
 * 잠금을 잡아요. 다른 실행이 쥐고 있으면 BusyError를 던져요.
 * 돌려준 함수를 부르면 풀려요(프로세스가 끝날 때도 풀어요).
 */
export function acquireLock(dataDir: string, command: string): () => void {
  const path = lockPathFor(dataDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readHolder(path);
      if (holder === 'gone') continue;
      const busy = holder === 'unreadable' ? recentlyWritten(path) : holder.pid !== process.pid && alive(holder.pid);
      if (busy) {
        const who = holder === 'unreadable' ? '다른 cc-worklog 실행' : `다른 cc-worklog 실행(PID ${holder.pid}${holder.command ? `, ${holder.command}` : ''})`;
        throw new BusyError(`${who}이 같은 데이터 폴더를 쓰고 있어요`, path);
      }
      // 끝난 실행이 남긴 잠금이에요. 지우고 다시 잡아요.
      try {
        unlinkSync(path);
      } catch {
        /* 다른 실행이 먼저 지웠을 수 있어요 */
      }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.off('exit', release);
      try {
        unlinkSync(path);
      } catch {
        /* 이미 없어요 */
      }
    };
    process.on('exit', release);
    return release;
  }
  throw new BusyError('다른 cc-worklog 실행이 같은 데이터 폴더를 쓰고 있어요', path);
}
