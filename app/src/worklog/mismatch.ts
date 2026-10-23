// 한쪽만 가려진 일지 알아보기 (A16, 시나리오 실행 F2-23).
// 일지 마크다운(.md)과 화면용 일지 데이터(.json)는 같은 내용이라, 마크다운 본문은 화면용 데이터로 renderProjects를 돌린 글과
// 가림 표시 수가 같아야 해요(머리 줄에는 가림 표시가 없어요). 화면용 데이터에만 있는 가림 표시가 있으면 화면용 데이터만 가려진 일지예요.
// 이전 판의 다시 가리기가 잠긴 마크다운을 말없이 건너뛰고 화면용 데이터만 다시 쓴 경우가 그래요.
// 이런 일지의 마크다운에 남은 의심은 다시 가리기로 고쳐지지 않아요. 다시 가리기는 화면용 데이터에서 바뀐 글 조각을 찾아 마크다운의
// 같은 조각만 고치는데(마크다운은 다시 만들지 않아요, A16), 화면용 데이터는 이미 가려져 있어 바뀔 조각이 없어서예요.
// 그 날짜 일지를 다시 만들면(cc-worklog --date 날짜 + 그 일지를 만든 설정) 보관본·커밋에서 다시 만들어 두 파일이 같게 가려져요.
import { DEFAULT_DAY_START, type Config } from '../config.js';
import { countMarkers } from '../redact/marker.js';
import type { Counts } from '../redact/redact.js';
import { renderProjects } from './markdown.js';
import type { DayLog } from './types.js';

/** 다시 만드는 명령에 넣는 그 일지의 설정이에요. 화면용 일지 데이터에 남은 값이에요(PRD 5장). */
export interface RemakeDay {
  date: string;
  /** 그 일지를 이름·이메일 가리기를 켜고 만들었는지 */
  hideIdentity: boolean;
  /** 그 일지를 요약을 켜고 만들었는지 (A28: 빼면 요약 줄이 빠진 일지로 바뀌어서 --summary를 붙여요). 없으면 꺼짐이에요. */
  summary?: boolean;
  /** 그 일지의 하루 경계 (시) */
  dayStartHour: number;
}

/** 다시 만드는 명령을 정할 때 보는 이번 실행(다시 가리기·검사)의 설정 */
export interface RemakeContext {
  /** 지금 설정의 하루 경계: 이번 실행의 --day-start, 없으면 config.json의 dayStartHour, 없으면 기본(3) */
  dayStartHour: number;
  /** 이번 실행에 --data-dir로 준 데이터 폴더 (절대 경로). 주지 않았으면 없어요. */
  dataDir?: string;
  /** 이번 실행에 --claude-dir로 준 세션 기록 폴더 (절대 경로). 주지 않았으면 없어요. */
  claudeDir?: string;
}

/**
 * 다시 만드는 명령 아래 한 줄 (PRD S3·S4·A16, Q24). 옵션으로만 준 --root와, 만들 때만 준 --claude-dir는 일지에 남지 않아
 * 명령에 붙일 수 없어서 알려요. 세션 기록 폴더 경로는 사용자 이름이 들어가서 일지에 남기지 않아요(A10).
 */
export const REMAKE_HINT = '만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요.';

export function remakeContext(cfg: Config): RemakeContext {
  return {
    dayStartHour: cfg.dayStartHour,
    dataDir: cfg.dataDirFromCli ? cfg.dataDir : undefined,
    claudeDir: cfg.claudeDirFromCli ? cfg.claudeDir : undefined,
  };
}

/** 화면용 일지 데이터에서 다시 만드는 명령에 넣을 설정을 꺼내요. 칸이 없는 옛 모양이면 꺼짐·기본 하루 경계로 봐요. */
export function remakeDayOf(date: string, day: Partial<Pick<DayLog, 'hideIdentity' | 'dayStartHour' | 'summaryEnabled'>>): RemakeDay {
  const h = day.dayStartHour;
  return {
    date,
    hideIdentity: day.hideIdentity === true,
    summary: day.summaryEnabled === true,
    dayStartHour: typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_DAY_START,
  };
}

/**
 * 명령에 붙이는 폴더 경로. 공백이 없어도 늘 큰따옴표로 감싸요(DESIGN S3·S4 공통 터미널 규칙, 취합 15회차).
 * 따옴표 없는 Windows 경로(`C:\work\wl`)를 Git Bash에 붙여 넣으면 `\`가 지워져 `C:workwl`이 되는데,
 * 큰따옴표 안의 `\`는 PowerShell·cmd·bash·zsh 모두 그대로 둬요. 감쌀지 말지 갈래를 두지 않아요. 경로는 줄이지 않아요.
 * 큰따옴표만으로 깨지는 경로 두 가지는 글자를 조금 바꿔 써요(DESIGN 공통 터미널 규칙의 예외 표, 취합 17회차).
 *  - `\`로 끝나면(드라이브 맨 위 `D:\`, 공유 폴더 맨 위) 끝 `\`를 하나 더 써요: `"D:\\"`. 끝 `\"`가 닫는 따옴표를 글자로 바꾸지 않게요.
 *  - `\\`로 시작하는 UNC 경로는 맨 앞 두 글자를 `\/`로 써요: `"\/nas\share\cc-worklog"`. bash가 큰따옴표 안 `\\`를 하나로 줄이지 않게요.
 *  - 둘 다면 둘 다예요: `\\nas\share\` → `"\/nas\share\\"`. `//nas/…`·`"D:/"`로는 바꾸지 않아요.
 *  도구는 받은 폴더를 resolve로 정리해서(config.ts) 어느 셸에 붙여 넣어도 원래 폴더로 읽어요. 경로 모양으로만 정해서 운영체제와
 *  관계없이 같아요(POSIX 절대 경로는 `/`로 시작하고, `\`로 끝나는 드문 폴더도 bash·zsh가 `"…\\"`를 `…\`로 읽어 맞아요).
 * `$`·`` ` ``처럼 셸이 큰따옴표 안에서도 바꾸는 글자는 드물어서 따로 다루지 않아요(DESIGN).
 */
export function shellPath(path: string): string {
  let p = path;
  if (p.startsWith('\\\\')) p = `\\/${p.slice(2)}`;
  if (p.endsWith('\\')) p = `${p}\\`;
  return `"${p}"`;
}

/**
 * 그 날짜 일지를 만든 설정과 같게 다시 만드는 명령 (S3·S4 안내, PRD S3·S4·A16, Q22·Q23).
 * 검사(S4)의 남은 이름·이메일 안내도 이 명령을 써요. 그때 부르는 쪽이 hideIdentity를 true로 넘겨요(취합 15회차 차이 1).
 *  - 그 일지를 이름·이메일 가리기를 켜고 만들었으면 --hide-identity
 *  - 그 일지를 요약을 켜고 만들었으면 --summary (A28. 저장해 둔 요약을 다시 쓰므로 대개 새로 부르지 않아요)
 *  - 그 일지의 하루 경계가 기본(3)이나 지금 설정과 다르면 --day-start N (둘 다 같으면 붙이지 않아요)
 *  - 이번 실행에 --data-dir·--claude-dir를 줬으면 그 폴더 (늘 큰따옴표)
 */
export function remakeCommand(day: RemakeDay, ctx: RemakeContext): string {
  const parts = ['cc-worklog', '--date', day.date];
  if (day.hideIdentity) parts.push('--hide-identity');
  if (day.summary) parts.push('--summary');
  if (day.dayStartHour !== DEFAULT_DAY_START || day.dayStartHour !== ctx.dayStartHour) parts.push('--day-start', String(day.dayStartHour));
  if (ctx.dataDir) parts.push('--data-dir', shellPath(ctx.dataDir));
  if (ctx.claudeDir) parts.push('--claude-dir', shellPath(ctx.claudeDir));
  return parts.join(' ');
}

/**
 * 이번 일지 만들기를 이름·이메일 가리기를 켜고 다시 하는 명령 (S3 [알림], PRD A21). `--date`·`--from`으로 켜져 있던 일지를 끈 채
 * 다시 만들었을 때 보여 줘요. 이번 실행의 날짜 옵션과 설정을 그대로 두고 --hide-identity만 더해요:
 * 날짜 옵션(--date 또는 --from·--to) → --hide-identity → (이번 실행에 --summary를 줬으면) --summary → 하루 경계가 기본(3)과 다르면 --day-start N → 옵션으로 준 --root 폴더들 →
 * 옵션으로 준 --data-dir·--claude-dir. 폴더는 늘 큰따옴표예요(shellPath, DESIGN 공통 터미널 규칙).
 */
export function rerunHideCommand(
  dateArgs: string[],
  ctx: RemakeContext & { cliRoots?: string[]; summary?: boolean },
): string {
  const parts = ['cc-worklog', ...dateArgs, '--hide-identity'];
  // 이번 실행에 --summary로 요약을 켰으면 같은 명령이 되게 붙여요(config.json으로 켰으면 그 파일이 다시 켜요).
  if (ctx.summary) parts.push('--summary');
  if (ctx.dayStartHour !== DEFAULT_DAY_START) parts.push('--day-start', String(ctx.dayStartHour));
  for (const r of ctx.cliRoots ?? []) parts.push('--root', shellPath(r));
  if (ctx.dataDir) parts.push('--data-dir', shellPath(ctx.dataDir));
  if (ctx.claudeDir) parts.push('--claude-dir', shellPath(ctx.claudeDir));
  return parts.join(' ');
}

/**
 * 화면용 일지 데이터에는 있고 마크다운(mdMarkers: 마크다운 전체에서 센 가림 표시)에는 없는 가림 표시가 있는지 봐요.
 * 모양이 다른 옛 일지라 마크다운 본문을 다시 그리지 못하면 false예요(알 수 없으면 알리지 않아요).
 * 손으로 마크다운의 가림 표시 줄을 지운 경우도 true가 될 수 있지만, 그때도 그 날짜 일지를 다시 만들면 고쳐져요.
 */
export function maskedOnlyInData(day: DayLog, mdMarkers: Counts): boolean {
  let rendered: Counts;
  try {
    rendered = countMarkers(renderProjects(day));
  } catch {
    return false;
  }
  return Object.entries(rendered).some(([k, v]) => v > (mdMarkers[k] ?? 0));
}
