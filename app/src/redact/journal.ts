// 보관본 다시 가리기(F2, A16)의 다시 쓰기 기록(저널).
// 여러 파일(보관본·일지·보관 색인)을 한 번에 바꾸는 동작이라, 중간에 멈춰도 일부만 바뀐 채 남지 않게 이렇게 해요.
//  1. 확인을 받은 뒤 기록 파일을 "준비 중"으로 써요. (확인 전에는 데이터 폴더에 아무 파일도 만들지 않아요.)
//  2. 바뀔 파일마다 새 내용을 옆 파일(<원래 이름>.cc-redact-new)에 써요. 옛 내용은 어디에도 복사하지 않아요.
//  3. 기록 파일을 "확정"으로 바꿔요. 이 순간부터는 끝까지 가요.
//  4. 새 내용 파일을 원래 이름으로 바꿔 덮어써요. 다 끝나면 기록 파일을 지워요.
// 다음 실행(일지 만들기·보관·다시 가리기)은 시작할 때 기록 파일을 보고,
// "준비 중"이면 새 내용 파일을 지워 되돌리고(바뀐 파일 없음), "확정"이면 남은 이름 바꾸기를 마저 끝내요.
// 검사·화면은 읽기만 해서 마저 끝내지 않고, 기록 상태만 보고 알려요(readJournalState).
// 기록 파일이 깨져 읽을 수 없으면 어느 실행도 마저 끝낼 수 없어서, 다시 가리기만 확인을 받은 뒤 지우고 처음부터 다시 가려요(A16, Q21).
// 깨진 기록에서 시작한 다시 가리기는 "준비 중" 기록에 그 사실(fromBroken)을 남겨요. 확정 전에 되돌리면(그 자리에서든 다음 실행이든)
// 기록을 지우지 않고 "깨짐" 표시(state: 'broken')로 바꿔 남겨서, 검사·화면·다음 실행이 깨진 기록 알림을 계속 보여 줘요(A16, 2026-10-20).
// 되돌리기 전의 그 "준비 중" 기록도 검사·화면은 깨진 기록처럼 알려요. 깨짐 표시에도 옛 내용은 담지 않아요(경로 목록도 비워요).
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { renameStrict, walkFiles, writeFileAtomicDurable } from '../util/fs.js';

export const JOURNAL_NAME = 'redact-journal.json';
export const STAGED_SUFFIX = '.cc-redact-new';

export interface Journal {
  schema: 1;
  state: 'preparing' | 'committed';
  createdAt: string;
  /** 바뀔 파일 (데이터 폴더 기준 / 구분 상대 경로) */
  files: string[];
  /** 깨진 다시 쓰기 기록에서 시작한 다시 가리기예요("준비 중"에만 적어요). 확정 전에 되돌리면 "깨짐" 표시를 다시 남겨요(A16). */
  fromBroken?: true;
}

/** "깨짐" 표시: 깨진 기록에서 시작한 다시 가리기를 확정 전에 되돌린 뒤 남겨요. 읽는 쪽은 깨진 기록과 똑같이 다뤄요. */
interface BrokenMark {
  schema: 1;
  state: 'broken';
  createdAt: string;
  files: [];
}

export class RecoveryError extends Error {}

export function journalPath(dataDir: string): string {
  return join(dataDir, JOURNAL_NAME);
}

/** 데이터 폴더 기준 상대 경로를 절대 경로로. 데이터 폴더 밖을 가리키면 거절해요(손상된 기록 대비). */
export function insideDataDir(dataDir: string, rel: string): string {
  const root = resolve(dataDir);
  const full = resolve(root, ...rel.split('/'));
  if (!full.startsWith(root + sep)) throw new RecoveryError(`다시 가리기 기록에 데이터 폴더 밖 경로가 있어요: ${rel}`);
  return full;
}

export function writeJournal(dataDir: string, j: Journal): void {
  writeFileAtomicDurable(journalPath(dataDir), `${JSON.stringify(j, null, 1)}\n`);
}

export function removeJournal(dataDir: string): void {
  rmSync(journalPath(dataDir), { force: true });
}

/**
 * 기록 파일을 "깨짐" 표시로 바꿔요(원자적으로 덮어써요). 깨진 기록에서 시작한 다시 가리기를 확정 전에 되돌린 뒤 불러요(A16).
 * 쓰지 못해도(디스크 가득 참 등) 던지지 않아요. 그때는 fromBroken이 적힌 "준비 중" 기록이 그대로 남는데,
 * 읽는 쪽(검사·화면)은 그것도 깨진 기록으로 알리고 다음 실행이 다시 되돌리며 표시를 남겨요. 남겼으면 true예요.
 */
export function markBroken(dataDir: string): boolean {
  const mark: BrokenMark = { schema: 1, state: 'broken', createdAt: new Date().toISOString(), files: [] };
  try {
    writeFileAtomicDurable(journalPath(dataDir), `${JSON.stringify(mark, null, 1)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 준비 중에 만든 새 내용 파일을 모두 지워요(되돌리기). */
export function removeStaged(dataDir: string, files: string[]): void {
  for (const rel of files) rmSync(`${insideDataDir(dataDir, rel)}${STAGED_SUFFIX}`, { force: true });
}

/** 기록에 적힌 파일 가운데 새 내용 파일(<파일>.cc-redact-new)이 남은 것이 있는지 봐요. 읽기만 해요(내용도 읽지 않아요). */
export function anyStaged(dataDir: string, files: string[]): boolean {
  return files.some((rel) => existsSync(`${insideDataDir(dataDir, rel)}${STAGED_SUFFIX}`));
}

/**
 * 다시 쓰기 기록의 지금 상태. 읽기만 하고 데이터 폴더의 어떤 파일도 바꾸거나 지우지 않아요.
 * - none: 기록 파일이 없어요 (멈춘 다시 가리기가 없어요)
 * - preparing: 파일을 바꾸기 시작하기 전에 멈췄어요 (바뀐 파일 없음, 검사·화면은 알리지 않아요.
 *   다만 journal.fromBroken이면 깨진 기록에서 시작한 것이라 검사·화면은 깨진 기록처럼 알려요)
 * - committed: 파일을 바꾸기 시작한 뒤에 멈췄어요 (일부 파일만 바뀌었을 수 있어요, 다음 실행이 마저 끝내요)
 * - broken: 기록 파일을 읽을 수 없거나 "깨짐" 표시예요 (일부만 바뀌었을 수 있다고 보고, 다시 가리기를 다시 실행하라고 알려요)
 */
export type JournalState = { state: 'none' } | { state: 'preparing' | 'committed'; journal: Journal } | { state: 'broken' };

export function readJournalState(dataDir: string): JournalState {
  let raw: string;
  try {
    raw = readFileSync(journalPath(dataDir), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 기록 파일이 없거나 데이터 폴더가 없어요(폴더 자리에 파일이 있는 경우 포함).
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'none' };
    return { state: 'broken' };
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { state: 'broken' };
  }
  const o = j as (Omit<Partial<Journal>, 'state' | 'fromBroken'> & { state?: unknown; fromBroken?: unknown }) | null;
  // "깨짐" 표시(markBroken)도 깨진 기록과 같아요. 아래 모양 검사에 걸려도 broken이지만 뜻을 드러내려고 따로 봐요.
  if (o && typeof o === 'object' && o.schema === 1 && o.state === 'broken') return { state: 'broken' };
  if (
    !o ||
    typeof o !== 'object' ||
    o.schema !== 1 ||
    (o.state !== 'preparing' && o.state !== 'committed') ||
    !Array.isArray(o.files) ||
    !o.files.every((f) => typeof f === 'string' && f.length > 0) ||
    (o.fromBroken !== undefined && o.fromBroken !== true)
  ) {
    return { state: 'broken' };
  }
  try {
    for (const rel of o.files) insideDataDir(dataDir, rel);
  } catch {
    return { state: 'broken' };
  }
  return { state: o.state, journal: o as Journal };
}

/** 검사·화면이 알릴 상태: 파일을 바꾸기 시작한 뒤 멈춤(unfinished), 기록이 깨짐(broken), 알릴 것 없음(null). 읽기만 해요. */
export type PendingNotice = 'unfinished' | 'broken' | null;

export function pendingNotice(dataDir: string): PendingNotice {
  const s = readJournalState(dataDir);
  if (s.state === 'committed') return 'unfinished';
  if (s.state === 'broken') return 'broken';
  // 깨진 기록에서 시작한 다시 가리기가 확정 전에 멈춘 채 아직 되돌려지지 않았어요. 되돌리면 "깨짐" 표시가 남을 것이라 미리 같게 알려요(A16).
  if (s.state === 'preparing' && s.journal.fromBroken) return 'broken';
  return null;
}

export interface RecoveryResult {
  /** broken: 기록 파일이 깨져(또는 "깨짐" 표시라) 마저 끝내지 못했어요. 기록·새 내용 파일은 건드리지 않았어요. */
  action: 'none' | 'rolled-back' | 'rolled-forward' | 'broken';
  files: number;
  /**
   * 끝난 뒤 다시 쓰기 기록이 "깨짐"인지예요. action이 broken이거나, 깨진 기록에서 시작한 다시 가리기를 되돌려(rolled-back)
   * "깨짐" 표시를 다시 남겼으면 true예요. S3는 이 값으로 깨진 기록 [알림]을 띄우고, 다시 가리기는 깨진 기록 처리로 가요(A16).
   */
  broken: boolean;
}

/** 기록 파일을 쓰다 멈춰 남은 임시 파일(경로 목록만 들어 있어요)을 치워요. */
function removeJournalTemps(dataDir: string): void {
  try {
    for (const n of readdirSync(dataDir)) {
      if (n.startsWith(`${JOURNAL_NAME}.tmp-`)) rmSync(join(dataDir, n), { force: true });
    }
  } catch {
    /* 데이터 폴더가 아직 없어요 */
  }
}

/**
 * 지난번에 멈춘 다시 가리기가 있으면 마무리해요. 잠금을 쥔 뒤에 불러요.
 * 남은 일이 없으면 기록 파일이 있는지만 보고 끝나요(데이터 폴더를 바꾸지 않아요).
 * 기록 파일이 깨졌으면(또는 "깨짐" 표시면) 아무것도 지우거나 바꾸지 않고 broken을 돌려줘요. 일지 만들기·보관은 하던 일을 그대로 하고 알리기만 해요.
 * 그래야 일부만 바뀌었을 수 있다는 유일한 표시가 다시 가리기 전까지 남아요(A16).
 * 깨진 기록에서 시작한 "준비 중" 기록(fromBroken)을 되돌릴 때는 기록을 지우지 않고 "깨짐" 표시로 바꿔 남겨요(같은 까닭, A16).
 */
export function recoverPending(dataDir: string): RecoveryResult {
  const s = readJournalState(dataDir);
  if (s.state === 'broken') return { action: 'broken', files: 0, broken: true };
  removeJournalTemps(dataDir);
  if (s.state === 'none') return { action: 'none', files: 0, broken: false };
  const j = s.journal;
  if (j.state === 'preparing') {
    removeStaged(dataDir, j.files);
    if (j.fromBroken) {
      markBroken(dataDir);
      return { action: 'rolled-back', files: j.files.length, broken: true };
    }
    removeJournal(dataDir);
    return { action: 'rolled-back', files: j.files.length, broken: false };
  }
  let moved = 0;
  for (const rel of j.files) {
    const target = insideDataDir(dataDir, rel);
    const staged = `${target}${STAGED_SUFFIX}`;
    try {
      renameStrict(staged, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'Error';
      if (code === 'ENOENT') continue; // 이미 바꿨어요
      throw new RecoveryError(`지난번에 멈춘 다시 가리기를 마저 끝내지 못했어요 (${rel}, ${code})`);
    }
    moved++;
  }
  removeJournal(dataDir);
  return { action: 'rolled-forward', files: moved, broken: false };
}

/**
 * 데이터 폴더에 남은 새 내용 임시 파일(*.cc-redact-new)과 기록을 쓰다 남은 임시 파일을 지워요. 깨진 기록 파일 자체는 남겨요.
 * 지운 새 내용 임시 파일 수를 돌려줘요. 임시 파일은 읽지 않아요.
 * 다시 가리기가 깨진 기록에서 확인을 받은 뒤(또는 --yes) 불러요. 깨진 기록은 이어서 commitPlan이 fromBroken "준비 중" 기록으로
 * 원자적으로 덮어써서, 그사이 갑자기 꺼져도 깨진 기록 표시가 사라지는 틈이 없어요(A16).
 * 남은 임시 파일은 지난번 실행이 만든 새 내용이라 그 뒤 보관으로 이어 붙인 줄이 빠져 있을 수 있어서, 쓰지 않고 지워요(A16).
 */
export function clearBrokenLeftovers(dataDir: string): number {
  const staged = walkFiles(dataDir, (n) => n.endsWith(STAGED_SUFFIX));
  for (const f of staged) rmSync(f, { force: true });
  removeJournalTemps(dataDir);
  return staged.length;
}

/**
 * 깨진 기록 파일(또는 "깨짐" 표시)과 남은 임시 파일을 모두 지워요. 지운 새 내용 임시 파일 수를 돌려줘요.
 * 다시 가리기가 바뀔 자리가 0개일 때(묻지 않음) 불러요. 모든 파일이 이미 지금 규칙에 맞아 정리만 하면 돼요(A16).
 */
export function clearBrokenJournal(dataDir: string): number {
  const staged = clearBrokenLeftovers(dataDir);
  removeJournal(dataDir);
  return staged;
}
