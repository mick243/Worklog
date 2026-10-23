// 시험용 가짜 claude (PRD A26). 실제 Claude Code를 부르지 않아요(사용량·네트워크 없음).
// cc-worklog가 CC_WORKLOG_CLAUDE로 이 스크립트를 실행해요(.mjs라 Node로 실행돼요). 받은 인자·표준 입력·작업 폴더·시각을
// FAKE_CLAUDE_LOG_DIR 폴더에 호출마다 파일 하나로 남겨, 시험이 보내는 재료와 안전 옵션, 실행 횟수·순서·동시 실행 수를 확인해요.
//
// 환경 변수 (cc-worklog는 환경 변수를 바꾸지 않고 물려줘요):
//  FAKE_CLAUDE_LOG_DIR   호출 기록 폴더 (없으면 기록하지 않아요)
//  FAKE_CLAUDE_MODE      ok(기본) · auth · auth401 · auth403 · auth-text · rate · rate429 · timeout · garbage · empty · exit1 · error-json
//                        auth: 로그인 정보가 없어 보내기 전에 멈춤("Not logged in", 상태 코드 없음)
//                        auth401·auth403: 서버가 인증을 거절함(api_error_status 401·403, 재료는 이미 나감)
//                        auth-text: 로그인 글뿐이라 보내기 전에 멈췄는지 가릴 수 없음("Invalid API key", 상태 코드 없음)
//  FAKE_CLAUDE_MODE_MAP  JSON {"표준 입력에 든 글": "모드"} — 맞는 글이 있으면 그 모드예요(세션마다 다르게 흉내 낼 때)
//  FAKE_CLAUDE_TEXT      ok일 때 돌려줄 요약 글. {title}은 재료의 제목으로 바꿔요. 기본 "{title} 작업을 마무리했어요."
//  FAKE_CLAUDE_DELAY_MS  답하기 전에 기다리는 시간 (동시 실행 수를 볼 때)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const started = Date.now();
const logDir = process.env.FAKE_CLAUDE_LOG_DIR;
const logFile = logDir ? join(logDir, `call-${started}-${process.pid}-${Math.random().toString(16).slice(2, 8)}.json`) : null;

function log(extra) {
  if (!logFile) return;
  mkdirSync(logDir, { recursive: true });
  writeFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, start: started, ...extra }));
}

const chunks = [];
process.stdin.on('data', (b) => chunks.push(b));
process.stdin.on('end', async () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  let mode = process.env.FAKE_CLAUDE_MODE || 'ok';
  try {
    const map = JSON.parse(process.env.FAKE_CLAUDE_MODE_MAP || '{}');
    for (const [needle, m] of Object.entries(map)) if (stdin.includes(needle)) mode = m;
  } catch {
    /* 모드 표가 틀렸으면 기본 모드예요 */
  }
  const title = /^제목: (.*)$/m.exec(stdin)?.[1] ?? '';
  log({ stdin, mode, end: null });
  const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const result = (obj, code) => {
    log({ stdin, mode, end: Date.now() });
    process.stdout.write(`${JSON.stringify({ session_id: 'fake-session', total_cost_usd: 0, duration_ms: 1, ...obj })}\n`);
    process.exitCode = code;
  };
  switch (mode) {
    case 'ok': {
      const text = (process.env.FAKE_CLAUDE_TEXT ?? '{title} 작업을 마무리했어요.').replaceAll('{title}', title);
      return result({ type: 'result', subtype: 'success', is_error: false, result: text }, 0);
    }
    case 'auth':
      return result({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login FAKE-RAW-AUTH-OUTPUT' }, 1);
    case 'auth401':
      return result({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key · Please run /login FAKE-RAW-401' }, 1);
    case 'auth403':
      return result({ type: 'result', subtype: 'success', is_error: true, api_error_status: 403, result: 'OAuth token revoked · Please run /login FAKE-RAW-403' }, 1);
    case 'auth-text':
      return result({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login FAKE-RAW-AUTH-TEXT' }, 1);
    case 'rate':
      return result({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1760000000 FAKE-RAW-RATE-OUTPUT' }, 1);
    case 'rate429':
      return result({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error FAKE-RAW-429' }, 1);
    case 'error-json':
      return result({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'FAKE-RAW-ERROR' }, 1);
    case 'empty':
      return result({ type: 'result', subtype: 'success', is_error: false, result: '   ' }, 0);
    case 'garbage':
      log({ stdin, mode, end: Date.now() });
      process.stdout.write('FAKE-RAW-GARBAGE this is not json\n');
      return;
    case 'exit1':
      log({ stdin, mode, end: Date.now() });
      process.stderr.write('FAKE-RAW-STDERR boom\n');
      process.exitCode = 1;
      return;
    case 'timeout':
      // 시간 초과를 흉내 내요. cc-worklog가 끝내지 않으면 10분 뒤에 스스로 끝나요.
      setTimeout(() => result({ type: 'result', subtype: 'success', is_error: false, result: 'too late' }, 0), 600_000);
      return;
    default:
      return result({ type: 'result', subtype: 'success', is_error: true, result: `unknown fake mode ${mode}` }, 1);
  }
});
