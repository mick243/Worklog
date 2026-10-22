// 화면 열기 명령: 127.0.0.1에 읽기 전용 로컬 화면(S1·S2)을 열어요. Ctrl+C로 꺼요.
// 터미널에서 직접 실행했을 때만 기본 브라우저로 주소를 열어 줘요(파이프·스크립트에서는 주소만 찍어요).
// 요청한 포트(기본 포트 포함)가 쓰이는 중이면 다음 빈 포트로 열고, 바뀐 사실을 알려요(PRD 5장, 시나리오 실행 F1-21).
import { spawn } from 'node:child_process';
import { DEFAULT_PORT, type Config } from '../config.js';
import { painter, painterFor, wrapText, type Painter } from '../term/format.js';
import { portCandidates, startServer } from '../web/server.js';

/** 이름표([알림]·[실패]) 뒤 위치 */
const AFTER_TAG = ' '.repeat(7);

function openBrowser(url: string): void {
  try {
    const opts = { detached: true, stdio: 'ignore' as const, windowsHide: true };
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', url], opts)
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts);
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* 브라우저를 못 열어도 주소는 이미 찍었어요 */
  }
}

/**
 * 요청한 포트가 쓰이는 중이라 다른 포트로 열었을 때의 [알림] 두 줄 (S1~S4 밖의 짧은 출력, PRD 5장, DESIGN "화면 열기 출력" 3번).
 * 주소를 보지 않고 예전 주소를 다시 열면 앞서 띄운 다른 화면(다른 데이터 폴더일 수 있어요)을 보게 돼서 알려요.
 * 숫자 뒤에 "번 포트"를 붙여서 숫자에 따라 조사를 고르지 않아요. 시작 두 줄 뒤 빈 줄 다음, 맨 끝에 찍어요.
 * explicit: --port로 준 포트인지 (아니면 기본 포트예요)
 */
export function portChangedNotice(requested: number, actual: number, explicit: boolean, p: Painter = painterFor(false)): string {
  const head = `${explicit ? '요청한' : '기본'} ${requested}번 포트가 쓰이는 중이라 ${actual}번 포트로 열었어요.`;
  return [
    ...wrapText(head, `${p.bold('[알림]')} `, AFTER_TAG),
    ...wrapText(`${requested}번 포트는 다른 프로그램(앞서 연 화면 등)이 쓰고 있어요.`, AFTER_TAG, AFTER_TAG),
  ].join('\n');
}

/**
 * 요청한 포트부터 찾아본 범위가 모두 쓰이는 중이라 화면을 열지 못했을 때의 [실패] 두 줄 (표준 오류, 종료 코드 1, DESIGN "화면 열기 출력" 오류).
 * 일반 [실패] 실행하지 못했어요 (EADDRINUSE)는 폴더 권한을 보라고 해서 할 일을 잘못 알려 줘서 따로 둬요.
 * 찾아본 포트가 하나뿐이면(65535) 범위 대신 그 번호만 적어요.
 */
export function noFreePortFailure(tried: number[], p: Painter = painterFor(false)): string {
  const first = tried[0]!;
  const last = tried[tried.length - 1]!;
  const what = first === last ? `${first}번 포트가` : `${first}번부터 ${last}번까지 포트가 모두`;
  return [
    ...wrapText(`${what} 쓰이는 중이라 화면을 열지 못했어요`, `${p.fail('[실패]')} `, AFTER_TAG),
    ...wrapText('--port로 다른 번호를 주거나, 앞서 연 화면을 끈 뒤 다시 실행하세요.', '다음: ', '      '),
  ].join('\n');
}

/** port: 열 포트(0이면 아무 빈 포트), explicit: --port로 준 값인지 */
export async function runView(cfg: Config, port: number, explicit = port !== DEFAULT_PORT): Promise<number> {
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await startServer({ dataDir: cfg.dataDir, port, hideIdentity: cfg.hideIdentity });
  } catch (err) {
    // 찾아본 포트가 모두 쓰이는 중이에요(서버는 쓰이는 중일 때만 다음 번호로 넘어가서, 마지막 오류가 EADDRINUSE면 모두 쓰이는 중이에요).
    if (port !== 0 && (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      process.stderr.write(`${noFreePortFailure(portCandidates(port), painter(process.stderr))}\n`);
      return 1;
    }
    throw err;
  }
  const { server, url, port: actual } = started;
  // 시작 두 줄은 늘 같고, 포트를 바꿨을 때만 빈 줄 하나 뒤 [알림] 두 줄을 맨 끝에 둬요(기다리는 동안 맨 아래가 가장 잘 보여서요).
  const changed = port !== 0 && actual !== port ? `\n${portChangedNotice(port, actual, explicit, painter(process.stdout))}\n` : '';
  process.stdout.write(`로컬 화면을 열었어요: ${url}\n이 컴퓨터에서만 열려요. 끄려면 Ctrl+C를 누르세요.\n${changed}`);
  if (process.stdout.isTTY && process.env.CC_WORKLOG_NO_BROWSER !== '1') openBrowser(url);
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  process.stdout.write('로컬 화면을 껐어요.\n');
  return 0;
}
