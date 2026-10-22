// 로컬 화면 서버. 127.0.0.1에만 열어서 다른 기기에서는 접속할 수 없어요.
// 읽기 전용이고(GET만), 데이터 폴더의 결과만 읽어요. 페이지에 스크립트를 넣지 않고 서버가 HTML을 통째로 만들어 보내요.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { worklogFiles } from '../commands/make.js';
import { pendingNotice } from '../redact/journal.js';
import { isDateKey } from '../util/time.js';
import { toolVersion } from '../util/version.js';
import { dayStatus, entriesBySession, failedOutsideDays, framePath, listDates, readDay, readIndexSafe, sessionStatus } from './data.js';
import { renderS1, type DateRow } from './s1-date-list.js';
import { renderS2 } from './s2-day-log.js';

export interface ServerOptions {
  dataDir: string;
  port: number;
  /** 설정의 이름·이메일 가리기 (S1 틀의 경로 줄이기에 써요) */
  hideIdentity: boolean;
  makeCommand?: string;
  archiveCommand?: string;
  now?: () => number;
}

const STYLES = new Set(['tokens.css', 'base.css']);
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

export function createHandler(o: ServerOptions, getPort: () => number) {
  const home = homedir();
  const makeCommand = o.makeCommand ?? 'cc-worklog';
  const archiveCommand = o.archiveCommand ?? 'cc-worklog archive';
  const now = o.now ?? Date.now;

  return (req: IncomingMessage, res: ServerResponse) => {
    try {
      // 다른 주소로 위장한 요청(DNS 리바인딩)을 막아요.
      const port = getPort();
      const host = (req.headers.host ?? '').toLowerCase();
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
        send(res, 403, '허용하지 않은 주소예요', 'text/plain; charset=utf-8');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, '읽기 전용 화면이에요', 'text/plain; charset=utf-8');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      const path = url.pathname;

      if (path.startsWith('/styles/')) {
        const name = path.slice('/styles/'.length);
        if (!STYLES.has(name)) {
          send(res, 404, '없는 파일이에요', 'text/plain; charset=utf-8');
          return;
        }
        const css = readFileSync(new URL(`../styles/${name}`, import.meta.url), 'utf8');
        send(res, 200, css, 'text/css; charset=utf-8');
        return;
      }
      if (path === '/favicon.ico') {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }

      const version = toolVersion();
      const index = readIndexSafe(o.dataDir);
      const bySession = entriesBySession(index);
      const t = now();
      // 멈춘 보관본 다시 가리기: 페이지를 만들 때마다 다시 쓰기 기록을 읽기만 해요(마저 끝내지도, 지우지도 않아요, A16).
      const redact = pendingNotice(o.dataDir);

      if (path === '/') {
        let dates: string[] = [];
        let error: 'unreadable' | undefined;
        try {
          dates = listDates(o.dataDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') error = 'unreadable';
        }
        // 날짜 행에 잡힌 세션 (그 밖의 보관 실패 세션은 S1 배너에 한 줄로 알려요)
        const inDays = new Set<string>();
        const rows: DateRow[] = dates
          .slice()
          .reverse()
          .map((date) => {
            try {
              const day = readDay(o.dataDir, date);
              for (const p of day.projects) for (const s of p.sessions) inDays.add(s.sessionId);
              return { date, ...day.totals, status: dayStatus(day, bySession, t) };
            } catch {
              return {
                date,
                projects: 0,
                sessions: 0,
                commits: 0,
                unreadable: true,
                status: { state: 'no-sessions', counts: { archived: 0, pending: 0, imminent: 0, 'archive-only': 0 }, daysLeft: null },
              };
            }
          });
        send(
          res,
          200,
          renderS1({
            rows,
            lastRunAt: index.lastRunAt,
            dataDir: framePath(o.dataDir, o.hideIdentity, home),
            version,
            makeCommand,
            archiveCommand,
            failedElsewhere: failedOutsideDays(bySession, inDays, t),
            error,
            redact,
          }),
        );
        return;
      }

      const m = /^\/day\/(\d{4}-\d{2}-\d{2})\/?$/.exec(path);
      if (m && isDateKey(m[1]!)) {
        const date = m[1]!;
        let dates: string[] = [];
        try {
          dates = listDates(o.dataDir);
        } catch {
          dates = [];
        }
        const pos = dates.indexOf(date);
        const prevDate = pos > 0 ? dates[pos - 1]! : pos === -1 ? (dates.filter((x) => x < date).pop() ?? null) : null;
        const nextDate = pos >= 0 ? (dates[pos + 1] ?? null) : (dates.find((x) => x > date) ?? null);
        let day = null;
        let unreadable = false;
        if (pos >= 0) {
          try {
            day = readDay(o.dataDir, date);
          } catch {
            unreadable = true;
          }
        }
        const hide = day?.hideIdentity ?? o.hideIdentity;
        send(
          res,
          pos >= 0 ? 200 : 404,
          renderS2({
            date,
            day,
            unreadable,
            status: day ? dayStatus(day, bySession, t) : null,
            sessionStatus: (id) => sessionStatus(bySession.get(id), t),
            mdPath: framePath(worklogFiles(o.dataDir, date).md, hide, home),
            prevDate,
            nextDate,
            dataDir: framePath(o.dataDir, hide, home),
            version,
            archiveCommand,
            makeCommand,
            lastRunAt: index.lastRunAt,
            redact,
          }),
        );
        return;
      }
      send(res, 404, '없는 화면이에요', 'text/plain; charset=utf-8');
    } catch {
      // 오류 문구에 일지 내용 조각을 넣지 않아요.
      send(res, 500, '화면을 만들지 못했어요', 'text/plain; charset=utf-8');
    }
  };
}

/** 열어 볼 포트: 요청한 포트와 다음 10개(65535를 넘지 않게). 0이면 빈 번호를 아무거나 써요. 화면 열기의 "빈 포트 없음" [실패]가 이 범위를 적어요. */
export function portCandidates(port: number): number[] {
  return port === 0 ? [0] : Array.from({ length: 11 }, (_, i) => port + i).filter((p) => p <= 65535);
}

/** 127.0.0.1의 port에 서버를 열어요. port가 쓰이는 중이면 다음 번호를 10개까지 시도해요. 0이면 빈 번호를 아무거나 써요. */
export async function startServer(o: ServerOptions): Promise<{ server: Server; url: string; port: number }> {
  let port = 0;
  const server = createServer(createHandler(o, () => port));
  const tryListen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });
  const candidates = portCandidates(o.port);
  let lastErr: unknown;
  for (const p of candidates) {
    try {
      port = await tryListen(p);
      return { server, url: `http://127.0.0.1:${port}/`, port };
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
    }
  }
  throw lastErr;
}
