// 명령줄 읽기 (A22). Node parseArgs를 엄격하지 않은 모드(tokens)로 돌린 뒤 이 도구가 직접 검사해서, 오류를 종류별 한국어 문구로 보여 줘요.
// 엄격 모드가 던지는 영어 원문(Unknown option '--from'. To specify …)은 쓰지 않아요. 검사하는 것은 엄격 모드와 같아요:
// 모르는 옵션, 값이 필요한 옵션에 값이 없거나 다음 인자가 -로 시작함(값을 -로 시작하게 주려면 --옵션=값), 값을 받지 않는 옵션에 값.
// 그다음 명령·남는 인자, 그 명령에서 받지 않거나 함께 쓸 수 없는 옵션(--yes, --from·--to, A16·A18), 잘못된 값 순서로 봐요.
import { parseArgs } from 'node:util';
import { looksLikeCommandWord, usageText } from './term/usage.js';
import { dayKeyOf, isDateKey, shiftDate } from './util/time.js';

/** 사용법 오류. cli.ts가 [실패] 한 줄과 다음: cc-worklog --help 줄로 보여 줘요(종료 코드 1). 메시지에는 옵션 값을 넣지 않아요. */
export class UsageError extends Error {}

export const OPTIONS = {
  date: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  root: { type: 'string', multiple: true },
  'day-start': { type: 'string' },
  'hide-identity': { type: 'boolean' },
  'claude-dir': { type: 'string' },
  'data-dir': { type: 'string' },
  port: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type OptionName = keyof typeof OPTIONS;

export const COMMANDS = ['make', 'archive', 'check', 'redact', 'view'] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface ParsedArgs {
  command: CommandName;
  help: boolean;
  version: boolean;
  date?: string;
  from?: string;
  to?: string;
  roots?: string[];
  dayStart?: string;
  hideIdentity: boolean;
  claudeDir?: string;
  dataDir?: string;
  port?: string;
  yes: boolean;
}

/**
 * 옵션을 읽어요. 사용법 오류는 UsageError로 던져요. 도움말·버전을 준 경우에도 옵션 모양 오류는 먼저 알려요(전과 같은 순서).
 * 명령·남는 인자 검사는 도움말·버전이 없을 때만 해요.
 */
export function parseCommandLine(argv: string[]): ParsedArgs {
  let tokens;
  try {
    tokens = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true, tokens: true }).tokens;
  } catch {
    throw new UsageError(usageText.unreadable);
  }

  const values: Partial<Record<OptionName, string | string[] | boolean>> = {};
  const positionals: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'positional') {
      positionals.push(t.value);
      continue;
    }
    if (t.kind !== 'option') continue;
    const def = (OPTIONS as Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>)[t.name];
    if (!def) throw new UsageError(usageText.unknownOption(t.rawName));
    if (def.type === 'string') {
      // 엄격 모드와 같아요: 값이 없거나, --옵션=값 모양이 아닌데 다음 인자가 -로 시작하면(다른 옵션을 값으로 먹은 경우) 값이 빠진 것으로 봐요.
      if (t.value === undefined || (!t.inlineValue && t.value.startsWith('-'))) throw new UsageError(usageText.missingValue(t.rawName));
      const name = t.name as OptionName;
      if (def.multiple) values[name] = [...((values[name] as string[] | undefined) ?? []), t.value];
      else values[name] = t.value;
    } else {
      if (t.value !== undefined) throw new UsageError(usageText.noValueAllowed(t.rawName));
      values[t.name as OptionName] = true;
    }
  }

  const parsed: ParsedArgs = {
    command: 'make',
    help: values.help === true,
    version: values.version === true,
    date: values.date as string | undefined,
    from: values.from as string | undefined,
    to: values.to as string | undefined,
    roots: values.root as string[] | undefined,
    dayStart: values['day-start'] as string | undefined,
    hideIdentity: values['hide-identity'] === true,
    claudeDir: values['claude-dir'] as string | undefined,
    dataDir: values['data-dir'] as string | undefined,
    port: values.port as string | undefined,
    yes: values.yes === true,
  };
  if (parsed.help || parsed.version) return parsed;

  const command = positionals[0] ?? 'make';
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(looksLikeCommandWord(command) ? usageText.unknownCommand(command) : usageText.unknownCommandHidden);
  }
  if (positionals.length > 1) throw new UsageError(usageText.extraArgs(positionals.length - 1));
  parsed.command = command as CommandName;

  if (parsed.yes && command !== 'redact') throw new UsageError(usageText.yesOnlyRedact);
  if ((parsed.from !== undefined || parsed.to !== undefined) && command !== 'make') throw new UsageError(usageText.rangeOnlyMake);
  if (parsed.date !== undefined && (parsed.from !== undefined || parsed.to !== undefined)) throw new UsageError(usageText.dateWithRange);
  if (parsed.to !== undefined && parsed.from === undefined) throw new UsageError(usageText.toWithoutFrom);
  // 잘못된 값도 사용법 오류예요(A22). 0~23 밖의 수도 여기서 막아 config.json 오류와 섞이지 않게 해요.
  if (parsed.dayStart !== undefined && !(/^\d{1,2}$/.test(parsed.dayStart) && Number(parsed.dayStart) <= 23)) throw new UsageError(usageText.badDayStart);
  return parsed;
}

/** 일지 만들기가 만들 날짜를 정하는 방법 (A18) */
export type MakeRequest = { kind: 'default' } | { kind: 'date'; date: string } | { kind: 'range'; from: string; to: string };

/** 날짜 글자(YYYY-MM-DD, today, yesterday)를 날짜로 바꿔요. 잘못된 모양이면 undefined예요. */
export function resolveDateWord(raw: string, today: string): string | undefined {
  const date = raw === 'today' ? today : raw === 'yesterday' ? shiftDate(today, -1) : raw;
  return isDateKey(date) ? date : undefined;
}

/**
 * 일지 만들기의 날짜 옵션을 요청으로 바꿔요. today·yesterday는 이번 실행의 하루 경계로 정해요.
 * --to를 빼면 오늘까지예요. 뒤집힌 기간은 사용법 오류예요(A18).
 */
export function makeRequestOf(args: Pick<ParsedArgs, 'date' | 'from' | 'to'>, dayStartHour: number, now = Date.now()): MakeRequest {
  const today = dayKeyOf(now, dayStartHour);
  if (args.date !== undefined) {
    const date = resolveDateWord(args.date, today);
    if (!date) throw new UsageError(usageText.badDate('--date'));
    return { kind: 'date', date };
  }
  if (args.from !== undefined) {
    const from = resolveDateWord(args.from, today);
    if (!from) throw new UsageError(usageText.badDate('--from'));
    const to = args.to === undefined ? today : resolveDateWord(args.to, today);
    if (!to) throw new UsageError(usageText.badDate('--to'));
    if (from > to) throw new UsageError(usageText.reversedRange);
    return { kind: 'range', from, to };
  }
  return { kind: 'default' };
}
