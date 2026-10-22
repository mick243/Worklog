// 설정 읽기. 우선순위: CLI 옵션 > 데이터 폴더의 config.json > 기본값.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseJsonText } from './util/json.js';

export const DEFAULT_DAY_START = 3;
export const DEFAULT_CLEANUP_DAYS = 30;
export const DEFAULT_PORT = 4848;
export const DEFAULT_ROOT_DEPTH = 4;
/** 삭제 예상일까지 이만큼 남으면 경고해요 (A9) */
export const WARN_DAYS = 7;

export interface CliOptions {
  claudeDir?: string;
  dataDir?: string;
  roots?: string[];
  dayStart?: number;
  hideIdentity?: boolean;
}

/** --root와 config.json의 roots에 준 경로가 어디서 왔는지 (잘못된 경로 [알림]에 써요, F1-20) */
export type RootOrigin = 'cli' | 'config';

export interface Config {
  claudeDir: string;
  projectsDir: string;
  dataDir: string;
  roots: string[];
  /** roots의 경로마다 어디서 왔는지 (resolve한 경로 → 출처). 둘 다에 있으면 'cli'예요. */
  rootOrigins?: Record<string, RootOrigin>;
  rootDepth: number;
  dayStartHour: number;
  hideIdentity: boolean;
  cleanupPeriodDays: number;
  /** cleanupPeriodDays를 Claude Code 설정에서 읽었는지 */
  cleanupFromSettings: boolean;
  /**
   * 이번 실행에 --data-dir·--claude-dir로 폴더를 줬는지 (환경 변수·기본 폴더면 false).
   * 한쪽만 가려진 일지를 다시 만드는 명령에 그 폴더를 붙일지 정할 때 써요(PRD S3·S4·A16, Q23).
   */
  dataDirFromCli?: boolean;
  claudeDirFromCli?: boolean;
}

export interface FileConfig {
  roots?: string[];
  rootDepth?: number;
  dayStartHour?: number;
  hideIdentity?: boolean;
}

export class ConfigError extends Error {}

export function dataPaths(dataDir: string) {
  return {
    configFile: join(dataDir, 'config.json'),
    patternsFile: join(dataDir, 'patterns.json'),
    archiveDir: join(dataDir, 'archive'),
    archiveProjectsDir: join(dataDir, 'archive', 'projects'),
    indexFile: join(dataDir, 'archive', 'index.json'),
    worklogsDir: join(dataDir, 'worklogs'),
  };
}

export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
}

export function defaultDataDir(): string {
  return process.env.CC_WORKLOG_HOME ? resolve(process.env.CC_WORKLOG_HOME) : join(homedir(), '.cc-worklog');
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    // Windows PowerShell 5.1 등이 붙이는 맨 앞 UTF-8 BOM은 떼고 읽어요(X-01, PRD 5장).
    return parseJsonText(raw);
  } catch {
    throw new ConfigError(`설정 파일이 올바른 JSON이 아니에요: ${path}`);
  }
}

/** Claude Code 설정(settings.json)에서 cleanupPeriodDays만 읽어요. 설정 파일은 읽기만 해요. */
function readCleanupDays(claudeDir: string): number | null {
  try {
    const v = (readJson(join(claudeDir, 'settings.json')) as { cleanupPeriodDays?: unknown } | undefined)?.cleanupPeriodDays;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function resolveConfig(cli: CliOptions): Config {
  const claudeDir = cli.claudeDir ? resolve(cli.claudeDir) : defaultClaudeDir();
  const dataDir = cli.dataDir ? resolve(cli.dataDir) : defaultDataDir();
  const file = (readJson(dataPaths(dataDir).configFile) ?? {}) as FileConfig;
  if (typeof file !== 'object' || Array.isArray(file)) throw new ConfigError('config.json은 { ... } 모양이어야 해요');

  const fileRoots = Array.isArray(file.roots) ? file.roots.filter((r): r is string => typeof r === 'string') : [];
  const rootOrigins: Record<string, RootOrigin> = {};
  for (const r of fileRoots) rootOrigins[resolve(r)] = 'config';
  for (const r of cli.roots ?? []) rootOrigins[resolve(r)] = 'cli';
  const roots = [...new Set([...fileRoots, ...(cli.roots ?? [])].map((r) => resolve(r)))];

  const dayStartHour = cli.dayStart ?? (typeof file.dayStartHour === 'number' ? file.dayStartHour : DEFAULT_DAY_START);
  if (!Number.isInteger(dayStartHour) || dayStartHour < 0 || dayStartHour > 23) {
    throw new ConfigError('하루가 바뀌는 시각(--day-start)은 0~23 사이 정수여야 해요');
  }
  const rootDepth = typeof file.rootDepth === 'number' && file.rootDepth >= 1 && file.rootDepth <= 10 ? Math.floor(file.rootDepth) : DEFAULT_ROOT_DEPTH;
  const fromSettings = readCleanupDays(claudeDir);

  return {
    claudeDir,
    projectsDir: join(claudeDir, 'projects'),
    dataDir,
    roots,
    rootOrigins,
    rootDepth,
    dayStartHour,
    hideIdentity: cli.hideIdentity ?? file.hideIdentity === true,
    cleanupPeriodDays: fromSettings ?? DEFAULT_CLEANUP_DAYS,
    cleanupFromSettings: fromSettings !== null,
    dataDirFromCli: Boolean(cli.dataDir),
    claudeDirFromCli: Boolean(cli.claudeDir),
  };
}
