#!/usr/bin/env node
// cc-worklog CLI 진입점.
// 기본 동작에서 네트워크 요청은 0건이에요. 세션 기록 원본과 git 저장소는 읽기만 해요.
import { IndexError } from './archive/archive.js';
import { makeRequestOf, parseCommandLine, UsageError } from './args.js';
import { runCheck } from './commands/check.js';
import { runArchiveOnly, runMake } from './commands/make.js';
import { runRedact } from './commands/redact.js';
import { runView } from './commands/view.js';
import { ConfigError, DEFAULT_PORT, resolveConfig } from './config.js';
import { RecoveryError } from './redact/journal.js';
import { PatternFileError } from './redact/redact.js';
import { displayWidth, MAX_WIDTH, painter, wrapText } from './term/format.js';
import { USAGE_NEXT, usageText } from './term/usage.js';
import { DataDirWriteError } from './util/fs.js';
import { BusyError } from './util/lock.js';
import { toolVersion } from './util/version.js';

// 도움말 (I-32): DESIGN 3장 "도움말 출력"의 50줄을 글자 그대로 써요. 모든 줄이 80칸(표시 폭, term/format.ts의 displayWidth) 안이에요.
// 80칸을 넘던 설명은 괄호를 통째로 다음 줄 설명 자리(사용법 42칸째, 날짜 옵션·옵션 25칸째)로 내리거나 뜻을 지키며 줄였어요.
// 설정 파일 예시는 파일 줄 다음 줄(2칸 + "예) ")이고, patterns.json 예시는 쉼표 뒤에서 끊어 첫 키 자리(9칸)에 맞춰요(끊어도 JSON 그대로).
const HELP = `cc-worklog — Claude Code 세션과 git log로 비밀 값을 가린 날짜별 일지를 만들어요

사용법
  cc-worklog [make] [날짜 옵션] [옵션]    일지 만들기 (보관을 먼저 해요)
  cc-worklog archive [옵션]               보관만 하기
  cc-worklog check [옵션]                 가리기 검사
  cc-worklog redact [--yes] [옵션]        보관본 다시 가리기 (일지도 함께)
  cc-worklog view [--port 번호]           로컬 화면 열기 (이 컴퓨터에서만)

일지 만들기의 날짜 옵션 (날짜 모양: YYYY-MM-DD, today, yesterday)
  (없음)                 오늘 일지와, 재료는 있는데 일지가 없는 지난 날짜,
                         그날이 끝나기 전에 만든 지난 일지를 모두 만들어요
  --date <날짜>          그날 하나만 만들어요 (이미 있으면 다시 만들어요)
  --from <날짜>          기간 안에서 재료가 있는 날짜를 모두 만들어요
                         (이미 있어도 다시 만들어요)
  --to <날짜>            기간의 끝 날짜 (기본: 오늘). --from과 함께 써요
                         --date와 --from·--to는 함께 쓸 수 없어요
                         손으로 고친 일지 .md는 어느 방식으로도 덮어쓰지 않아요

옵션
  --root <폴더>          이 폴더 아래 저장소는 세션이 없던 날의 커밋도 넣어요
                         (여러 번 쓸 수 있어요)
  --day-start <시>       하루가 바뀌는 시각 0~23 (기본: 3, 새벽 3시)
  --hide-identity        일지에서 경로 속 사용자 이름과 이메일 주소도 가려요
                         (보관본에는 쓰지 않아요)
  --claude-dir <폴더>    Claude Code 폴더
                         (기본: CLAUDE_CONFIG_DIR 또는 ~/.claude)
  --data-dir <폴더>      cc-worklog 데이터 폴더
                         (기본: CC_WORKLOG_HOME 또는 ~/.cc-worklog)
  --port <번호>          view 명령의 포트 (기본: ${DEFAULT_PORT})
  -y, --yes              redact 명령에서 확인을 묻지 않고 바로 다시 써요
                         (되돌릴 수 없어요)
  -h, --help             도움말
  -v, --version          버전

설정 파일   <데이터 폴더>/config.json
  예) { "roots": ["C:/work"], "dayStartHour": 3, "hideIdentity": false }
사용자 패턴 <데이터 폴더>/patterns.json
  예) [{ "name": "사내 토큰", "pattern": "CORP-[0-9]{8}",
         "samples": ["CORP-12345678"] }]

용어
  가림         비밀 값(API 키·토큰 등)을 [가림:종류] 표시로 바꾼 자리예요.
               원문은 일지·보관본·화면 어디에도 남기지 않아요
  보관본       Claude Code가 30일(기본) 뒤 지우는 세션 기록을, 비밀 값을 가려
               데이터 폴더에 옮겨 둔 사본이에요. 일지는 보관본으로 만들어요
  다시 가리기  나중에 더한 패턴으로 이미 만든 보관본과 일지를 다시 가려요
               (cc-worklog redact). 되돌릴 수 없어서 먼저 수를 보여 주고 물어요
  하루 경계    날짜가 바뀌는 시각이에요. 기본은 새벽 3시라 새벽 2시에 한 일은
               전날 일지에 들어가요. --day-start로 바꿔요
`;

/** [실패] 이름표 뒤 위치 (경로 줄, 넘친 괄호 줄) */
const AFTER_TAG = ' '.repeat(7);

async function main(argv: string[]): Promise<number> {
  // 옵션 오류는 종류별 한국어 문구로 알려요(A22). Node 옵션 해석기의 영어 원문은 쓰지 않아요(args.ts).
  const args = parseCommandLine(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${toolVersion()}\n`);
    return 0;
  }
  const cfg = resolveConfig({
    claudeDir: args.claudeDir,
    dataDir: args.dataDir,
    roots: args.roots,
    dayStart: args.dayStart === undefined ? undefined : Number(args.dayStart),
    hideIdentity: args.hideIdentity ? true : undefined,
  });

  switch (args.command) {
    case 'make':
      // 날짜 옵션 없음(기본 실행) / --date / --from[·--to] (A18, Q25 답)
      return runMake(cfg, makeRequestOf(args, cfg.dayStartHour));
    case 'archive':
      return runArchiveOnly(cfg);
    case 'check':
      return runCheck(cfg);
    case 'redact':
      return runRedact(cfg, { yes: args.yes });
    case 'view': {
      const port = args.port === undefined ? DEFAULT_PORT : Number(args.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(usageText.badPort);
      return runView(cfg, port, args.port !== undefined);
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // 오류 문구에는 세션 기록 내용 조각을 넣지 않아요. 우리가 만든 오류만 문구를 보여 주고, 나머지는 종류만 알려요.
    // 모양(DESIGN S3·S4 오류): [실패] 한 줄과 원인, 다음 줄에 "다음:"으로 할 일. [실패] 이름표만 색을 입혀요(TTY이고 NO_COLOR가 없을 때).
    // 다시 가리기가 다시 쓰다 멈춘 [실패](확정 전·뒤)는 commands/redact.ts가 따로 찍어요.
    const fail = painter(process.stderr).fail('[실패]');
    const out = (lines: string[]) => process.stderr.write(`${lines.join('\n')}\n`);
    // 다음: 문장은 80칸을 넘으면 낱말 사이에서 끊고 이름표 뒤 위치에 맞춰요(DESIGN S3·S4 공통 규칙).
    // tail(잠금 파일 경로 등)은 줄이지 않고 마지막 줄 끝에 그대로 붙여요(경로가 든 줄만 80칸을 넘을 수 있어요).
    const next = (text: string, tail?: string): string[] => {
      const lines = wrapText(text, '다음: ', '      ');
      if (tail) lines[lines.length - 1] += ` ${tail}`;
      return lines;
    };
    if (err instanceof DataDirWriteError) {
      // [실패] 한 줄과 오류 코드, 다음 줄에 데이터 폴더 경로(줄이지 않아요), 그다음 다음: 줄 (DESIGN S3 오류 예시)
      // 권한 문제(EACCES 등)와 디스크 가득 참(ENOSPC)은 할 일이 달라서 다음: 줄에 둘 다 적어요(PRD S3, 취합 8회차 차이 2).
      out([
        `${fail} 데이터 폴더에 쓰지 못했어요 (${err.code})`,
        `${AFTER_TAG}${err.dataDir}`,
        ...next('폴더 권한과 디스크 공간을 확인하거나 --data-dir로 다른 폴더를 고르세요.'),
      ]);
    } else if (err instanceof PatternFileError) {
      // [실패] 한 줄과 까닭, 다음 줄에 경로, 그다음 다음: 줄 (DESIGN S3 오류 예시). 패턴 내용과 시험 값은 찍지 않아요.
      // 한 줄이 80칸을 넘으면 괄호 까닭을 통째로 다음 줄(이름표 뒤 위치)로 내려요.
      const head = `${fail} 사용자 패턴 파일을 읽지 못했어요`;
      const one = `${head} (${err.reason})`;
      const first = displayWidth(one) <= MAX_WIDTH ? [one] : [head, ...wrapText(`(${err.reason})`, AFTER_TAG, `${AFTER_TAG} `)];
      out([...first, `${AFTER_TAG}${err.path}`, ...next('patterns.json을 고친 뒤 다시 실행하세요.')]);
    } else if (
      err instanceof UsageError ||
      err instanceof ConfigError ||
      err instanceof IndexError ||
      err instanceof BusyError ||
      err instanceof RecoveryError
    ) {
      const lines = [`${fail} ${err.message}`];
      if (err instanceof UsageError) lines.push(...next(USAGE_NEXT));
      if (err instanceof ConfigError) lines.push(...next('설정 파일(config.json)이나 옵션 값을 고친 뒤 다시 실행하세요.'));
      if (err instanceof IndexError) {
        // 파일을 열지 못한 경우(다른 프로그램이 잡고 있음, 권한 없음)와 내용이 깨진 경우는 할 일이 달라요(F2-23).
        lines.push(
          ...next(
            err.code
              ? '보관 색인 파일(archive/index.json)을 연 프로그램을 닫거나 파일 권한을 확인한 뒤 다시 실행하세요.'
              : '데이터 폴더의 보관 색인 파일(archive/index.json)이 깨지지 않았는지 확인하세요.',
          ),
        );
      }
      if (err instanceof BusyError) {
        lines.push(...next('그 실행이 끝난 뒤 다시 실행하세요. 다른 실행이 없는데도 이 알림이 나오면 잠금 파일을 지우세요:', err.lockPath));
      }
      if (err instanceof RecoveryError) {
        // 지난번에 멈춘 다시 가리기를 이번 실행이 마저 끝내지 못함 (DESIGN S3 가·나 오류, 두 줄 그대로)
        lines.push(...next('데이터 폴더의 파일을 연 프로그램(편집기·화면 등)을 닫고 다시 실행하면 이어서 끝내요.'));
      }
      out(lines);
    } else if ((err as { code?: string })?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      // 옵션 해석기의 영어 원문은 넣지 않아요(A22). args.ts가 먼저 걸러서 여기 올 일은 거의 없어요.
      out([`${fail} ${usageText.unreadable}`, ...next(USAGE_NEXT)]);
    } else {
      const e = err as NodeJS.ErrnoException;
      out([`${fail} 실행하지 못했어요 (${e?.code ?? e?.name ?? 'Error'})`, ...next('폴더 경로와 읽기·쓰기 권한을 확인한 뒤 다시 실행하세요.')]);
    }
    process.exitCode = 1;
  },
);
