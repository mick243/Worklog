// F3 자동 삭제 전 보관.
// 세션 기록에서 대화 글과 일지 재료 줄, 나중에 PR 기능에 쓸 pr-link 줄만 골라 F2로 가린 뒤 도구 전용 보관 폴더에 옮겨 담아요.
// - 원문에 글자 그대로 든 가림 표시 모양("[가림:")은 가리기 전에 "［가림:"으로 바꿔서, 도구가 가린 자리와 섞이지 않게 해요(F2·A17).
// - 원본은 읽기만 하고 바꾸지 않아요.
// - 이미 보관한 세션은 새로 늘어난 부분만 더해요(중복 없음). 새 기록이 없으면 보관본 파일을 열지도 않아요.
// - 쓰다가 멈추면 다음 실행에서 색인에 적힌 크기로 되돌린 뒤 다시 이어 붙여요.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { dataPaths, WARN_DAYS, type Config } from '../config.js';
import { neutralizeDeep } from '../redact/marker.js';
import { type Counts, type Redactor } from '../redact/redact.js';
import { classifyLine, compareVersion, CONVERSATION_TYPES, FORMAT_BASELINE, safeTypeName, toArchiveShape, type Json } from '../session/format.js';
import { WORK_DIR_PROJECT } from '../summary/claude.js';
import { fileSize, headHash, relPosix, renameWithRetry, walkFiles, writeFileAtomic, writingDataDir } from '../util/fs.js';
import { parseJsonText } from '../util/json.js';
import { readLines } from '../util/lines.js';

const DAY_MS = 86_400_000;
const HEAD_LEN = 1024;
const FLUSH_BYTES = 1 << 20;

export interface IndexEntry {
  sessionId: string;
  subagent: boolean;
  /** 원본에서 보관까지 끝낸 바이트 위치 (마지막 완전한 줄 끝) */
  srcBytes: number;
  /** 마지막 실행 때 원본 크기·수정 시각 */
  srcSize: number;
  srcMtimeMs: number;
  /** 원본 앞부분 해시 (통째로 바뀐 파일을 알아보려고) */
  headLen: number;
  headHash: string;
  /** 보관본 파일 크기 (쓰다 멈춘 부분을 되돌릴 때 기준) */
  archiveBytes: number;
  archivedLines: number;
  /** 보관한 대화 줄(user·assistant)의 가장 이른·늦은 시각 */
  minTs: string | null;
  maxTs: string | null;
  version: string | null;
  /** 마지막 실행 때 원본이 남아 있었는지 */
  originalExists: boolean;
  /** 삭제 예상일 = 원본 마지막 수정 시각 + cleanupPeriodDays */
  deleteAt: string | null;
  /**
   * 마지막 실행에서 이 파일 보관에 실패했는지 (S1·S2 "보관 실패"·"삭제 임박"의 근거, PRD 5장).
   * 한 번도 보관하지 못한 파일도 색인에 남겨서(보관본 없음) 일지가 없는 날짜의 실패 세션까지 S1이 셀 수 있어요.
   * 옛 색인에는 이 칸이 없어서, 없으면 error가 있는지로 봐요.
   */
  failed?: boolean;
  /** 마지막 실행에서 보관하지 못한 이유 (오류 코드만, 내용 조각 없음) */
  error?: string;
}

/** 한 번도 보관하지 못한 파일의 색인 자리인지 (보관본이 없어요) */
export function neverArchived(e: IndexEntry): boolean {
  return e.headHash === '' && e.archiveBytes === 0 && e.srcBytes === 0;
}

/** 마지막 실행에서 보관에 실패했는지 (옛 색인은 error 칸으로 봐요) */
export function lastRunFailed(e: IndexEntry): boolean {
  return e.failed ?? Boolean(e.error);
}

export interface ArchiveIndex {
  schema: 1;
  lastRunAt: string | null;
  cleanupPeriodDays: number;
  files: Record<string, IndexEntry>;
}

export interface ArchiveResult {
  projectsDirExists: boolean;
  filesTotal: number;
  sessionsTotal: number;
  subagentFiles: number;
  sessions: { new: number; appended: number; unchanged: number };
  linesRead: number;
  linesKept: number;
  skipped: { broken: number; unknownType: number; missingFields: number; unknownTypeNames: string[] };
  redactions: Counts;
  /**
   * 이번에 읽은(원본이 있는) 파일의 기록 형식 버전 (A13, S3). 파일마다 그 파일에서 본 가장 새 버전으로 세요.
   * 여러 버전이 섞이는 것이 정상이라, S3는 기준보다 새 버전이 있을 때만 [알림]을 띄우고 옛 버전은 파일 수만 보여 줘요.
   */
  format: { files: Record<string, number>; olderFiles: number; newerFiles: number; newest: string | null };
  /** 보관 전에 "아직 보관 안 됐고 삭제 예상일까지 7일 이하"였던 세션 */
  atRiskBefore: { sessions: number; earliestDeleteAt: string | null };
  /** 보관한 뒤에도 남은 위험 세션 (보관 실패) */
  atRiskAfter: { sessions: number; earliestDeleteAt: string | null };
  originalsMissingSessions: number;
  errors: Array<{ file: string; code: string }>;
  cleanupPeriodDays: number;
  archiveDir: string;
}

export function emptyIndex(cleanupPeriodDays: number): ArchiveIndex {
  return { schema: 1, lastRunAt: null, cleanupPeriodDays, files: {} };
}

/** 보관 색인을 읽지 못했어요. code는 파일을 열지 못한 오류 코드(EBUSY 등)이고, 내용이 깨졌으면 없어요. */
export class IndexError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function loadIndex(dataDir: string, cleanupPeriodDays = 30): ArchiveIndex {
  const path = dataPaths(dataDir).indexFile;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // 색인이 아직 없어요(데이터 폴더가 없거나 그 자리에 파일이 있는 경우 포함). 그 밖의 오류(다른 프로그램이 잡고 있음, 권한 없음)는
    // 빈 색인으로 여기면 보관을 처음부터 다시 하거나 다시 가리기가 색인을 맞추지 못해서 말없이 넘기지 않아요(F2-23).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return emptyIndex(cleanupPeriodDays);
    throw new IndexError(`보관 색인 파일을 읽지 못했어요 (${code ?? 'Error'}): ${path}`, code ?? 'Error');
  }
  try {
    // 손으로 고치며 BOM이 붙어도 읽어요(X-01).
    const data = parseJsonText(raw) as ArchiveIndex;
    if (data && data.schema === 1 && data.files && typeof data.files === 'object') return data;
  } catch {
    /* 아래에서 알려요 */
  }
  throw new IndexError(`보관 색인 파일을 읽지 못했어요: ${path}`);
}

function sessionIdOf(rel: string): { sessionId: string; subagent: boolean } {
  const parts = rel.split('/');
  const i = parts.lastIndexOf('subagents');
  if (i >= 1) return { sessionId: parts[i - 1]!, subagent: true };
  return { sessionId: basename(rel).replace(/\.jsonl$/i, ''), subagent: false };
}

const errCode = (err: unknown): string => {
  const e = err as NodeJS.ErrnoException;
  return typeof e?.code === 'string' ? e.code : e?.name ?? 'Error';
};

export interface ArchiveOptions {
  now?: number;
  onProgress?: (done: number, total: number, bytesDone: number, bytesTotal: number) => void;
}

export async function runArchive(cfg: Config, redactor: Redactor, opts: ArchiveOptions = {}): Promise<ArchiveResult> {
  const now = opts.now ?? Date.now();
  const paths = dataPaths(cfg.dataDir);
  const index = loadIndex(cfg.dataDir, cfg.cleanupPeriodDays);
  index.cleanupPeriodDays = cfg.cleanupPeriodDays;

  let projectsDirExists = true;
  try {
    projectsDirExists = statSync(cfg.projectsDir).isDirectory();
  } catch {
    projectsDirExists = false;
  }
  // 요약 호출용 빈 작업 폴더(summary/claude.ts)의 세션 기록 폴더는 보관하지 않아요. 요약 호출은 --no-session-persistence로
  // 세션 기록을 남기지 않지만, 남기는 판이 있어도 요약 재료와 지시가 "저장소 없음" 세션으로 보관·일지에 섞이지 않게 하는 안전장치예요(A26 3).
  const files = projectsDirExists
    ? walkFiles(cfg.projectsDir, (n) => n.toLowerCase().endsWith('.jsonl')).filter((f) => !WORK_DIR_PROJECT.test(relPosix(cfg.projectsDir, f).split('/')[0] ?? ''))
    : [];

  const result: ArchiveResult = {
    projectsDirExists,
    filesTotal: files.length,
    sessionsTotal: 0,
    subagentFiles: 0,
    sessions: { new: 0, appended: 0, unchanged: 0 },
    linesRead: 0,
    linesKept: 0,
    skipped: { broken: 0, unknownType: 0, missingFields: 0, unknownTypeNames: [] },
    redactions: {},
    format: { files: {}, olderFiles: 0, newerFiles: 0, newest: null },
    atRiskBefore: { sessions: 0, earliestDeleteAt: null },
    atRiskAfter: { sessions: 0, earliestDeleteAt: null },
    originalsMissingSessions: 0,
    errors: [],
    cleanupPeriodDays: cfg.cleanupPeriodDays,
    archiveDir: paths.archiveDir,
  };

  const unknownNames = new Set<string>();
  const sessionStatus = new Map<string, { main: string | null; any: Set<string> }>();
  const riskBefore = new Map<string, number>();
  const riskAfter = new Map<string, number>();
  const seen = new Set<string>();

  const stats = files.map((f) => {
    try {
      return statSync(f);
    } catch {
      return null;
    }
  });
  const bytesTotal = stats.reduce((a, s) => a + (s?.size ?? 0), 0);
  let bytesDone = 0;

  for (let i = 0; i < files.length; i++) {
    const src = files[i]!;
    const st = stats[i];
    const rel = relPosix(cfg.projectsDir, src);
    const { sessionId, subagent } = sessionIdOf(rel);
    if (subagent) result.subagentFiles++;
    seen.add(rel);
    const ss = sessionStatus.get(sessionId) ?? { main: null, any: new Set<string>() };
    sessionStatus.set(sessionId, ss);
    if (!st) {
      result.errors.push({ file: rel, code: 'ENOENT' });
      continue;
    }
    const prev = index.files[rel];
    const deleteAtMs = st.mtimeMs + cfg.cleanupPeriodDays * DAY_MS;
    const hasNew = !prev || st.size > prev.srcBytes || st.size < prev.srcBytes;
    if (hasNew && deleteAtMs - now <= WARN_DAYS * DAY_MS) {
      riskBefore.set(sessionId, Math.min(riskBefore.get(sessionId) ?? Infinity, deleteAtMs));
    }

    try {
      const status = await archiveFile(src, rel, sessionId, subagent, st.size, st.mtimeMs, prev, cfg, redactor, result, unknownNames, index);
      if (subagent) ss.any.add(status);
      else {
        ss.main = status;
        ss.any.add(status);
      }
      index.files[rel]!.deleteAt = new Date(deleteAtMs).toISOString();
      index.files[rel]!.originalExists = true;
      index.files[rel]!.failed = false;
      delete index.files[rel]!.error;
    } catch (err) {
      const code = errCode(err);
      result.errors.push({ file: rel, code });
      // 한 번도 보관하지 못한 파일도 색인에 자리를 만들어 "마지막 실행에서 보관에 실패"를 남겨요(보관본 없음).
      const e: IndexEntry = index.files[rel] ?? {
        sessionId,
        subagent,
        srcBytes: 0,
        srcSize: 0,
        srcMtimeMs: 0,
        headLen: 0,
        headHash: '',
        archiveBytes: 0,
        archivedLines: 0,
        minTs: null,
        maxTs: null,
        version: null,
        originalExists: true,
        deleteAt: null,
      };
      e.originalExists = true;
      e.deleteAt = new Date(deleteAtMs).toISOString();
      e.failed = true;
      e.error = code;
      index.files[rel] = e;
      if (hasNew && deleteAtMs - now <= WARN_DAYS * DAY_MS) {
        riskAfter.set(sessionId, Math.min(riskAfter.get(sessionId) ?? Infinity, deleteAtMs));
      }
    }
    bytesDone += st.size;
    opts.onProgress?.(i + 1, files.length, bytesDone, bytesTotal);
  }

  // 원본이 없어진 파일은 색인에 남기고 "원본 없음"으로 적어요. 이번 실행에서 보관을 시도하지 않았으니 실패도 아니에요.
  // 한 번도 보관하지 못한 채 원본이 없어진 파일은 남길 보관본이 없어서 색인에서 지워요.
  const missingSessions = new Set<string>();
  const presentSessions = new Set<string>();
  for (const [rel, e] of Object.entries(index.files)) {
    if (!seen.has(rel)) {
      if (neverArchived(e)) {
        delete index.files[rel];
        continue;
      }
      e.originalExists = false;
      e.failed = false;
      delete e.error;
    }
    if (!e.subagent) (e.originalExists ? presentSessions : missingSessions).add(e.sessionId);
  }
  for (const s of presentSessions) missingSessions.delete(s);
  result.originalsMissingSessions = missingSessions.size;

  for (const [, ss] of sessionStatus) {
    if (ss.main === 'new') result.sessions.new++;
    else if (ss.any.has('new') || ss.any.has('appended') || ss.any.has('rebuilt')) result.sessions.appended++;
    else if (ss.any.size > 0) result.sessions.unchanged++;
  }
  result.sessionsTotal = sessionStatus.size;
  result.skipped.unknownTypeNames = [...unknownNames].sort().slice(0, 5);

  const summarize = (m: Map<string, number>) => {
    let earliest = Infinity;
    for (const v of m.values()) earliest = Math.min(earliest, v);
    return { sessions: m.size, earliestDeleteAt: m.size ? new Date(earliest).toISOString() : null };
  };
  result.atRiskBefore = summarize(riskBefore);
  result.atRiskAfter = summarize(riskAfter);

  // 기록 형식: 이번에 읽은 파일마다 그 파일의 가장 새 버전으로 세요(A13).
  for (const rel of seen) {
    const v = index.files[rel]?.version;
    if (!v) continue;
    const f = result.format;
    f.files[v] = (f.files[v] ?? 0) + 1;
    const d = compareVersion(v, FORMAT_BASELINE);
    if (d < 0) f.olderFiles++;
    else if (d > 0) f.newerFiles++;
    if (!f.newest || compareVersion(v, f.newest) > 0) f.newest = v;
  }

  index.lastRunAt = new Date(now).toISOString();
  // 보관본 하나하나의 실패는 위에서 "보관 실패"로 남기지만(F3), 색인을 쓰지 못하면 데이터 폴더 자체에 쓰지 못한 거라 [실패]로 멈춰요.
  writingDataDir(cfg.dataDir, () => writeFileAtomic(paths.indexFile, `${JSON.stringify(index, null, 1)}\n`));
  return result;
}

type FileStatus = 'new' | 'appended' | 'unchanged' | 'rebuilt';

async function archiveFile(
  src: string,
  rel: string,
  sessionId: string,
  subagent: boolean,
  size: number,
  mtimeMs: number,
  prev: IndexEntry | undefined,
  cfg: Config,
  redactor: Redactor,
  result: ArchiveResult,
  unknownNames: Set<string>,
  index: ArchiveIndex,
): Promise<FileStatus> {
  const archivePath = join(dataPaths(cfg.dataDir).archiveProjectsDir, ...rel.split('/'));
  const archiveSize = fileSize(archivePath);

  if (prev && size === prev.srcSize && mtimeMs === prev.srcMtimeMs && archiveSize === prev.archiveBytes) {
    return 'unchanged';
  }

  const rebuild =
    !prev ||
    size < prev.srcBytes ||
    archiveSize === null ||
    archiveSize < prev.archiveBytes ||
    headHash(src, prev.headLen) !== prev.headHash;

  const entry: IndexEntry = rebuild
    ? {
        sessionId,
        subagent,
        srcBytes: 0,
        srcSize: 0,
        srcMtimeMs: 0,
        headLen: 0,
        headHash: '',
        archiveBytes: 0,
        archivedLines: 0,
        minTs: null,
        maxTs: null,
        version: null,
        originalExists: true,
        deleteAt: null,
      }
    : { ...prev! };

  mkdirSync(dirname(archivePath), { recursive: true });
  if (!rebuild && archiveSize !== null && archiveSize > entry.archiveBytes) {
    // 지난번에 쓰다 멈춘 부분을 되돌려요.
    truncateSync(archivePath, entry.archiveBytes);
  }

  const target = rebuild ? `${archivePath}.tmp-${process.pid}` : archivePath;
  let fd: number | null = null;
  let buffered: string[] = [];
  let bufferedBytes = 0;
  let written = 0;
  const flush = () => {
    if (buffered.length === 0) return;
    if (fd === null) fd = openSync(target, rebuild ? 'w' : 'a');
    const data = buffered.join('');
    writeSync(fd, data);
    written += Buffer.byteLength(data);
    buffered = [];
    bufferedBytes = 0;
  };

  let lastEnd = entry.srcBytes;
  let minMs = entry.minTs ? Date.parse(entry.minTs) : Infinity;
  let maxMs = entry.maxTs ? Date.parse(entry.maxTs) : -Infinity;
  let added = 0;
  try {
    for await (const { line, end } of readLines(src, entry.srcBytes)) {
      lastEnd = end;
      result.linesRead++;
      const c = classifyLine(line);
      if (c.kind === 'broken') {
        result.skipped.broken++;
        continue;
      }
      if (c.kind === 'unknown') {
        result.skipped.unknownType++;
        const name = safeTypeName(c.type);
        if (name) unknownNames.add(name);
        continue;
      }
      if (c.kind === 'missing') {
        result.skipped.missingFields++;
        continue;
      }
      if (c.kind === 'drop') continue;

      // 원문 속 가림 표시 모양 글자를 먼저 바꾼 뒤 가려요(그래야 보관본의 [가림:…]은 모두 도구가 가린 자리예요).
      const shaped = neutralizeDeep(toArchiveShape(c, sessionId)) as Json;
      const safe = redactor.redactDeep(shaped, result.redactions) as Record<string, unknown>;
      const out = `${JSON.stringify(safe)}\n`;
      buffered.push(out);
      bufferedBytes += out.length;
      added++;
      result.linesKept++;

      if (CONVERSATION_TYPES.has(c.type) && typeof safe.timestamp === 'string') {
        const ms = Date.parse(safe.timestamp);
        if (!Number.isNaN(ms)) {
          if (ms < minMs) minMs = ms;
          if (ms > maxMs) maxMs = ms;
        }
      }
      if (typeof safe.version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,30}$/.test(safe.version)) {
        if (!entry.version || compareVersion(safe.version, entry.version) > 0) entry.version = safe.version;
      }
      if (bufferedBytes >= FLUSH_BYTES) flush();
    }
    if (rebuild && fd === null) fd = openSync(target, 'w'); // 남길 줄이 없어도 빈 보관본을 만들어요.
    flush();
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (rebuild) renameWithRetry(target, archivePath);

  entry.srcBytes = lastEnd;
  entry.srcSize = size;
  entry.srcMtimeMs = mtimeMs;
  entry.headLen = Math.min(HEAD_LEN, lastEnd);
  entry.headHash = headHash(src, entry.headLen);
  entry.archiveBytes = (rebuild ? 0 : entry.archiveBytes) + written;
  entry.archivedLines = (rebuild ? 0 : entry.archivedLines) + added;
  entry.minTs = Number.isFinite(minMs) ? new Date(minMs).toISOString() : null;
  entry.maxTs = Number.isFinite(maxMs) ? new Date(maxMs).toISOString() : null;
  index.files[rel] = entry;

  if (!prev || neverArchived(prev)) return 'new';
  if (rebuild) return 'rebuilt';
  return added > 0 ? 'appended' : 'unchanged';
}
