// F1 날짜·프로젝트별 작업일지 만들기.
// 재료는 보관본(F3)만 써요. 그래서 원본 세션 파일이 지워져도 같은 설정이면 똑같은 일지가 나와요.
// 요약은 규칙 기반이고 AI도 네트워크도 쓰지 않아요.
//
// 여러 날을 한 번에 만들 때(A18) 날짜마다 보관본 전체를 처음부터 다시 읽지 않게, 보관본은 실행마다 한 번만 훑어요(PRD 5장).
// 훑으면서 날짜별 세션 재료를 모으고, 파일마다 "이 파일이 걸친 날짜 범위(보관 색인의 첫·마지막 대화 시각)"와 그 파일의 제목·
// 사용 시간 줄, 세션별로 그 파일에 나온 날짜를 기억해 둬요. 날짜 하나를 만들 때는 그 날짜에 걸친 파일의 것만 써서,
// 그 날짜를 --date로 따로 만든 것(그날에 걸친 보관본만 읽던 예전 방법)과 결과가 같아요(F1 완료 기준, 만든 시각 제외).
// 커밋도 저장소마다 git log를 한 번만 읽고 날짜마다 나눠요(git/log.ts의 pickRange).
import { statSync } from 'node:fs';
import { emptyIndex, loadIndex, type ArchiveIndex } from '../archive/archive.js';
import { dataPaths, type Config } from '../config.js';
import { commitRowsSince, gitAvailable, pickRange, SINCE_MARGIN_MS, userEmail, type Commit, type CommitRow } from '../git/log.js';
import { inspectRoots, RepoResolver, type RepoInfo, type RootIssue } from '../git/repo.js';
import { EMAIL_LABEL, maskIdentity, USER_NAME_LABEL } from '../redact/identity.js';
import { countMarkers, neutralizeMarkers } from '../redact/marker.js';
import { type Redactor } from '../redact/redact.js';
import { costFields, userRequestText, type CostFields, type Json } from '../session/format.js';
import { relPosix, walkFiles } from '../util/fs.js';
import { readLines } from '../util/lines.js';
import { oneLine, truncateKeepingMarkers } from '../util/text.js';
import { dayKeyOf, dayRange, timeZoneName } from '../util/time.js';
import { renderProjects } from './markdown.js';
import type { CommitLog, DayLog, ProjectLog, SessionLog } from './types.js';

export const REQUEST_MAX = 100;
const TITLE_MAX = 120;
const SUBJECT_MAX = 200;
/** 사용 시간을 추정할 때, 줄 사이 간격이 이보다 길면 쉰 것으로 봐요 */
const IDLE_GAP_MS = 30 * 60_000;
const NO_REPO_KEY = '\u0000none';

interface Agg {
  sid: string;
  times: number[];
  firstReq: { ts: number; text: string } | null;
  lastReq: { ts: number; text: string } | null;
  requests: number;
  cwd: { ts: number; cwd: string; main: boolean } | null;
  branches: Map<string, number>;
  subagentFiles: Set<string>;
}

interface Meta {
  /** custom-title (사용자가 붙인 제목) */
  customTitle?: string;
  /** ai-title (자동으로 붙은 제목). custom-title이 없을 때만 써요 (A5) */
  aiTitle?: string;
  lastPrompt?: string;
  cost?: CostFields;
  otherDays: boolean;
}

/** 보관본 파일 하나에서 기억해 두는 것 (날짜마다 그 날짜에 걸친 파일의 것만 써요) */
interface FileSummary {
  /** 이 파일이 걸친 날짜 범위 (보관 색인의 첫·마지막 대화 시각). 색인에 없는 파일은 모든 날짜에 걸친 것으로 봐요(null). */
  lo: string | null;
  hi: string | null;
  /** 세션별로 이 파일에서 마지막으로 나온 제목·마지막 요청·사용 시간 줄 */
  metas: Map<string, Omit<Meta, 'otherDays'>>;
  /** 세션별로 이 파일의 요청·답변 줄이 나온 날짜 */
  days: Map<string, Set<string>>;
}

export interface BuildResult {
  day: DayLog;
  empty: boolean;
  reposRead: number;
  /** 읽은 저장소 (여러 날의 합계에서 같은 저장소를 한 번만 세려고 둬요) */
  repoKeys: string[];
  subagentFiles: number;
  /** 그날 활동한 서브 에이전트 기록 (보관본 기준 상대 경로, 여러 날의 합계에서 같은 기록을 한 번만 세려고 둬요) */
  subagentFileKeys: string[];
  /** --root·config.json의 roots 중 건너뛴 경로와 까닭 (S3 [알림], F1-20) */
  rootIssues: RootIssue[];
}

/** 보관본 줄 맨 위의 작업 폴더 칸 ("cwd":"…"). 보관본은 원본 줄의 칸 순서를 지켜서 cwd가 대화 내용보다 앞에 와요. */
const CWD_FIELD = /"cwd":"((?:[^"\\]|\\.)*)"/;

/**
 * 보관본 전체(그날 말고 다른 날짜의 세션, 원본이 지워진 세션 포함)에서 작업 폴더를 모아요(F1-08, A4).
 * 지워진 워크트리의 원래 저장소를 찾을 후보를 얻으려는 것이라, 줄마다 작업 폴더 칸만 빠르게 읽어요(줄 전체를 JSON으로 읽지 않아요).
 * 대화 내용 속 글자는 JSON 안에서 따옴표가 \" 로 바뀌어 있어 이 모양에 맞지 않아요. 맞더라도 후보가 하나 느는 것뿐이에요.
 */
async function archivedCwds(files: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const file of files) {
    let last = '';
    try {
      for await (const { line } of readLines(file)) {
        const m = CWD_FIELD.exec(line);
        if (!m || m[1] === last) continue;
        last = m[1]!;
        try {
          const cwd = JSON.parse(`"${m[1]}"`) as string;
          if (cwd) out.add(cwd);
        } catch {
          /* 모양이 다른 칸이면 건너뛰어요 */
        }
      }
    } catch {
      /* 읽지 못한 보관본은 후보에서 빠져요(일지 만들기를 멈추지 않아요) */
    }
  }
  return [...out].sort();
}

function sessionIdOf(rel: string): string {
  const parts = rel.split('/');
  const i = parts.lastIndexOf('subagents');
  if (i >= 1) return parts[i - 1]!;
  return parts[parts.length - 1]!.replace(/\.jsonl$/i, '');
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 날짜 범위 (양 끝 포함). from이 null이면 아래 끝이 없어요(기본 실행이 보관본의 가장 이른 세션 날짜를 찾을 때). */
export interface DateSpan {
  from: string | null;
  to: string;
}

const inSpan = (d: string, lo: string | null, hi: string | null) => (lo === null || d >= lo) && (hi === null || d <= hi);

/**
 * 일지를 만드는 도구예요. open이 보관본을 한 번 훑고, build가 날짜 하나씩 일지를 만들어요.
 * 같은 날짜면 어느 범위로 열었든 build 결과가 같아요(그 날짜를 --date로 따로 만든 것과 같음, 만든 시각 제외).
 */
export class WorklogBuilder {
  /** 날짜 → 세션 아이디 → 그날 재료 */
  private readonly aggsByDate = new Map<string, Map<string, Agg>>();
  private readonly summaries: FileSummary[] = [];
  private files: string[] = [];
  private earliest: string | null = null;
  private span: { from: string; to: string } = { from: '', to: '' };
  private rootRepos: RepoInfo[] = [];
  private rootIssuesList: RootIssue[] = [];
  private candidates: Promise<string[]> | null = null;
  private hasGit = false;
  /** 저장소 키 → 이메일과 커밋 (실행마다 저장소 하나에 한 번만 읽어요) */
  private readonly commitCache = new Map<string, { email: string | null; rows: CommitRow[] | null }>();
  private sinceMs = 0;
  /** 보관본을 훑은 양 (파일 수·줄 수). 날짜를 몇 개 만들든 open 한 번에만 늘어요(시험에서 날짜 수에 비례해 다시 읽지 않는지 봐요). */
  private readonly stats = { files: 0, lines: 0 };

  private constructor(
    private readonly cfg: Config,
    private readonly redactor: Redactor,
  ) {}

  /** 보관본을 한 번 훑어 span 안 날짜의 재료를 모아요. span.from이 null이면 보관본의 가장 이른 세션 날짜부터예요. */
  static async open(cfg: Config, redactor: Redactor, span: DateSpan): Promise<WorklogBuilder> {
    const b = new WorklogBuilder(cfg, redactor);
    await b.scan(span);
    // 기본 실행은 보관본의 가장 이른 세션 날짜부터 찾아요(A18). 세션이 없으면(또는 모두 오늘 뒤면) 오늘만이에요.
    const from = span.from ?? (b.earliest !== null && b.earliest < span.to ? b.earliest : span.to);
    b.span = { from, to: span.to };
    const { repos, issues } = inspectRoots(cfg.roots, cfg.rootDepth);
    b.rootRepos = repos;
    b.rootIssuesList = issues;
    b.hasGit = gitAvailable();
    b.sinceMs = dayRange(b.span.from, cfg.dayStartHour).start - SINCE_MARGIN_MS;
    return b;
  }

  /** --root·config.json의 roots 중 건너뛴 경로 (S3 [알림], F1-20) */
  get rootIssues(): RootIssue[] {
    return this.rootIssuesList;
  }

  /** git을 찾았는지 (못 찾았으면 커밋 없이 세션만으로 만들어요) */
  get gitAvailable(): boolean {
    return this.hasGit;
  }

  /** 보관본을 훑은 파일 수·줄 수 (open 때 한 번, 지워진 작업 폴더의 저장소를 찾는 작업 폴더 모으기는 빼요) */
  get scanStats(): { files: number; lines: number } {
    return { ...this.stats };
  }

  /**
   * 재료가 있는 날짜 (A18): 보관본에 세션이 있는 날짜와 --root·roots 저장소에 내 커밋이 있는 날짜예요. span 안만, 날짜 순서예요.
   * roots 밖의 저장소 커밋만으로는 날짜가 생기지 않아요(그날 세션이 있을 때만 커밋을 넣어서예요).
   */
  materialDates(): string[] {
    const { from, to } = this.span;
    const out = new Set<string>();
    for (const [d, aggs] of this.aggsByDate) if (aggs.size > 0 && inSpan(d, from, to)) out.add(d);
    if (this.hasGit) {
      for (const repo of this.rootRepos) {
        const c = this.commitsOf(repo);
        if (!c.email || !c.rows) continue;
        for (const row of c.rows) {
          const d = dayKeyOf(row.time, this.cfg.dayStartHour);
          if (!inSpan(d, from, to) || out.has(d)) continue;
          // 그 날짜를 따로 읽을 때와 같은 기준으로 걸러요(작성 시각이 그날 범위 안, 커밋 시각이 그날 시작 - 2일 뒤).
          const { start, end } = dayRange(d, this.cfg.dayStartHour);
          if (pickRange([row], start, end).length > 0) out.add(d);
        }
      }
    }
    return [...out].sort();
  }

  private async scan(span: DateSpan): Promise<void> {
    const cfg = this.cfg;
    const paths = dataPaths(cfg.dataDir);
    let index: ArchiveIndex;
    try {
      index = loadIndex(cfg.dataDir, cfg.cleanupPeriodDays);
    } catch {
      index = emptyIndex(cfg.cleanupPeriodDays);
    }
    this.files = walkFiles(paths.archiveProjectsDir, (n) => n.toLowerCase().endsWith('.jsonl'));
    for (const file of this.files) {
      const rel = relPosix(paths.archiveProjectsDir, file);
      const e = index.files[rel];
      // 이 파일이 걸친 날짜 범위. 날짜 d의 범위 [시작, 끝)과 [첫 대화 시각, 마지막 대화 시각]이 겹치는 d는 정확히
      // dayKeyOf(첫 시각) ~ dayKeyOf(마지막 시각)이에요(하루 범위가 빈틈없이 이어져서예요). 예전처럼 그 날짜에 걸친 파일만 읽은 것과 같아요.
      let lo: string | null = null;
      let hi: string | null = null;
      if (e) {
        if (!e.minTs || !e.maxTs) continue;
        lo = dayKeyOf(Date.parse(e.minTs), cfg.dayStartHour);
        hi = dayKeyOf(Date.parse(e.maxTs), cfg.dayStartHour);
        // 훑는 범위와 겹치지 않으면 읽지 않아요(가장 이른 세션 날짜는 아래 줄에서 모아요).
        if ((span.from !== null && hi < span.from) || lo > span.to) continue;
      }
      const summary: FileSummary = { lo, hi, metas: new Map(), days: new Map() };
      const fileSid = sessionIdOf(rel);
      const subagent = rel.split('/').includes('subagents');
      const metaOf = (sid: string) => {
        let m = summary.metas.get(sid);
        if (!m) summary.metas.set(sid, (m = {}));
        return m;
      };
      this.stats.files++;
      for await (const { line } of readLines(file)) {
        this.stats.lines++;
        let o: Json;
        try {
          o = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        if (!o || typeof o !== 'object') continue;
        // 시각·작업 폴더가 없는 요약 재료 줄(custom-title·ai-title 등)은 sessionId로 세션에 붙여요 (A13).
        const sid = typeof o.sessionId === 'string' && o.sessionId ? o.sessionId : fileSid;
        switch (o.type) {
          // 제목은 세션 본 기록에서만 읽어요. 서브 에이전트 기록도 부모 세션 아이디를 써서, 그 안의 제목이 부모 제목을 덮으면 안 돼요.
          case 'custom-title': {
            const t = typeof o.customTitle === 'string' ? o.customTitle : typeof o.title === 'string' ? o.title : undefined;
            if (!subagent && t && t.trim()) metaOf(sid).customTitle = t;
            break;
          }
          case 'ai-title': {
            const t = typeof o.aiTitle === 'string' ? o.aiTitle : undefined;
            if (!subagent && t && t.trim()) metaOf(sid).aiTitle = t;
            break;
          }
          case 'last-prompt': {
            const t = typeof o.lastPrompt === 'string' ? o.lastPrompt : typeof o.prompt === 'string' ? o.prompt : undefined;
            if (t && t.trim()) metaOf(sid).lastPrompt = t;
            break;
          }
          case 'cost-state':
            metaOf(sid).cost = costFields(o);
            break;
          case 'user':
          case 'assistant': {
            const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : Number.NaN;
            if (Number.isNaN(ts)) break;
            const date = dayKeyOf(ts, cfg.dayStartHour);
            let days = summary.days.get(sid);
            if (!days) summary.days.set(sid, (days = new Set()));
            days.add(date);
            // 이 파일이 걸친 날짜 범위 밖의 줄(색인과 어긋난 줄)은 예전처럼 그 날짜에 넣지 않아요.
            if (!inSpan(date, lo, hi) || !inSpan(date, span.from, span.to)) break;
            // 가장 이른 세션 날짜: 실제로 그 날짜의 재료가 되는 줄만 봐요(기본 실행이 찾기 시작하는 날짜, A18).
            if (span.from === null) this.noteEarliest(date);
            let aggs = this.aggsByDate.get(date);
            if (!aggs) this.aggsByDate.set(date, (aggs = new Map()));
            let a = aggs.get(sid);
            if (!a) {
              a = { sid, times: [], firstReq: null, lastReq: null, requests: 0, cwd: null, branches: new Map(), subagentFiles: new Set() };
              aggs.set(sid, a);
            }
            a.times.push(ts);
            const main = !subagent && o.isSidechain !== true;
            if (subagent) a.subagentFiles.add(rel);
            const cwd = typeof o.cwd === 'string' ? o.cwd : '';
            if (cwd && (!a.cwd || (main && !a.cwd.main) || (main === a.cwd.main && ts < a.cwd.ts))) a.cwd = { ts, cwd, main };
            if (main && typeof o.gitBranch === 'string' && o.gitBranch) {
              const prev = a.branches.get(o.gitBranch);
              if (prev === undefined || ts < prev) a.branches.set(o.gitBranch, ts);
            }
            const req = main ? userRequestText(o) : null;
            if (req) {
              a.requests++;
              if (!a.firstReq || ts < a.firstReq.ts) a.firstReq = { ts, text: req };
              if (!a.lastReq || ts >= a.lastReq.ts) a.lastReq = { ts, text: req };
            }
            break;
          }
          default:
            break;
        }
      }
      this.summaries.push(summary);
    }
  }

  private noteEarliest(date: string): void {
    if (this.earliest === null || date < this.earliest) this.earliest = date;
  }

  /** 날짜 하나의 세션 메타: 그 날짜에 걸친 파일의 것만 파일 순서대로 겹쳐요(뒤 파일이 앞을 덮어요). */
  private metasFor(date: string): Map<string, Meta> {
    const metas = new Map<string, Meta>();
    const metaOf = (sid: string) => {
      let m = metas.get(sid);
      if (!m) metas.set(sid, (m = { otherDays: false }));
      return m;
    };
    for (const s of this.summaries) {
      if (!inSpan(date, s.lo, s.hi)) continue;
      // 파일 안에서 제목·사용 시간 줄과 요청·답변 줄이 섞인 순서는 서로 영향이 없어서(칸이 달라요) 이렇게 나눠 겹쳐도 같아요.
      for (const [sid, m] of s.metas) Object.assign(metaOf(sid), m);
      for (const [sid, days] of s.days) {
        for (const d of days) {
          if (d !== date) {
            metaOf(sid).otherDays = true;
            break;
          }
        }
      }
    }
    return metas;
  }

  private commitsOf(repo: RepoInfo): { email: string | null; rows: CommitRow[] | null } {
    let c = this.commitCache.get(repo.key);
    if (!c) {
      const email = userEmail(repo.root);
      let rows: CommitRow[] | null = [];
      if (email) {
        try {
          rows = commitRowsSince(repo.root, email, this.sinceMs);
        } catch {
          rows = null;
        }
      }
      c = { email, rows };
      this.commitCache.set(repo.key, c);
    }
    return c;
  }

  /**
   * 날짜 하나의 일지를 만들어요. hideIdentity는 이 일지에 쓸 이름·이메일 가리기예요(기본 실행이 이미 있는 일지를 다시 만들 때는
   * 그 일지나 이번 실행 중 한쪽이라도 켜져 있으면 켜요, A18 — 부르는 쪽이 정해요).
   */
  async build(date: string, opts: { hideIdentity: boolean; now?: number }): Promise<BuildResult> {
    const cfg = this.cfg;
    const redactor = this.redactor;
    const hideIdentity = opts.hideIdentity;
    const now = opts.now ?? Date.now();
    const { start, end } = dayRange(date, cfg.dayStartHour);
    const aggs = this.aggsByDate.get(date) ?? new Map<string, Agg>();
    const metas = this.metasFor(date);

    // 2) 글 다듬기: 가리기(F2) → 이름·이메일 가리기(옵션) → 한 줄로 → 자르기
    //    보관본은 이미 가린 상태지만, 나중에 더한 사용자 패턴도 일지에 적용되게 한 번 더 가려요.
    //    보관본 글은 원문 속 가림 표시 모양 글자를 보관할 때 이미 바꿨어요. git에서 바로 읽는 글(커밋 메시지·브랜치·저장소 경로)은
    //    여기서 neutralizeMarkers로 바꾼 뒤 가려요(F2·A17).
    const clean = (s: string | null | undefined, max: number): string | null => {
      if (s === null || s === undefined) return null;
      let t = redactor.redactString(s);
      if (hideIdentity) t = maskIdentity(t);
      t = oneLine(t);
      if (!t) return null;
      return truncateKeepingMarkers(t, max);
    };
    const cleanPath = (p: string) => {
      let t = redactor.redactString(p);
      if (hideIdentity) t = maskIdentity(t);
      return t;
    };

    // 3) 작업 폴더 → 저장소 (있는 폴더부터 찾고, 없어진 폴더는 그다음에). 날짜마다 새로 찾아서 다른 날짜의 결과가 섞이지 않아요.
    //    --root·roots 중 없는 경로·파일 경로·저장소가 없는 폴더는 건너뛰고 S3에 알려요(F1-20).
    const resolver = new RepoResolver();
    for (const r of this.rootRepos) resolver.addKnown(r);
    const cwds = [...new Set([...aggs.values()].map((a) => a.cwd?.cwd).filter((c): c is string => !!c))].sort();
    for (const c of cwds.filter(isDir)) resolver.resolve(c);
    const gone = cwds.filter((c) => !isDir(c));
    for (const c of gone) resolver.resolve(c);
    //    지워진 폴더 중 아직 저장소를 못 찾은 것이 있으면(지워진 워크트리 등), 세션 기록 전체(다른 날짜·원본이 지워진 보관본 포함)의
    //    작업 폴더에서 저장소를 더 찾아 그 워크트리 기록을 살펴봐요. --root 없이도 원래 저장소로 묶으려는 거예요(F1-08, A4).
    //    단서가 전혀 없으면(원래 저장소의 세션이 하나도 없고 상위 폴더로도 지정하지 않음, prune 등) "저장소 없음"이에요.
    //    보관본 전체의 작업 폴더는 실행마다 한 번만 모아요.
    if (gone.some((c) => resolver.resolve(c) === null)) {
      this.candidates ??= archivedCwds(this.files);
      const candidates = await this.candidates;
      for (const c of candidates.filter(isDir)) resolver.resolve(c);
      for (const c of candidates.filter((c) => !isDir(c))) resolver.resolve(c);
      resolver.forgetMisses();
      for (const c of gone) resolver.resolve(c);
    }

    interface Group {
      repo: RepoInfo | null;
      sessions: SessionLog[];
      commits: CommitLog[];
      notes: string[];
    }
    const groups = new Map<string, Group>();
    const groupOf = (repo: RepoInfo | null) => {
      const key = repo ? repo.key : NO_REPO_KEY;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { repo, sessions: [], commits: [], notes: [] }));
      return g;
    };

    let subagentFiles = 0;
    const subagentFileKeys = new Set<string>();
    for (const a of [...aggs.values()].sort((x, y) => (x.sid < y.sid ? -1 : 1))) {
      if (a.times.length === 0) continue;
      a.times.sort((x, y) => x - y);
      const meta = metas.get(a.sid) ?? { otherDays: false };
      const cost = meta.cost ?? {};
      const startMs = a.times[0]!;
      const endMs = a.times[a.times.length - 1]!;
      let usage: SessionLog['usage'];
      if (cost.durationMs !== undefined) usage = { ms: cost.durationMs, source: 'cost-state', wholeSession: meta.otherDays };
      else {
        let ms = 0;
        for (let i = 1; i < a.times.length; i++) {
          const gap = a.times[i]! - a.times[i - 1]!;
          if (gap <= IDLE_GAP_MS) ms += gap;
        }
        usage = { ms, source: 'estimate', wholeSession: false };
      }
      const lines: SessionLog['lines'] =
        cost.linesAdded !== undefined || cost.linesRemoved !== undefined
          ? { added: cost.linesAdded ?? null, removed: cost.linesRemoved ?? null, wholeSession: meta.otherDays }
          : null;
      const lastText = a.lastReq?.text ?? (meta.otherDays ? null : (meta.lastPrompt ?? null));
      const cwd = a.cwd?.cwd ?? '';
      subagentFiles += a.subagentFiles.size;
      for (const f of a.subagentFiles) subagentFileKeys.add(f);
      const session: SessionLog = {
        sessionId: a.sid,
        title: clean(meta.customTitle ?? meta.aiTitle, TITLE_MAX),
        firstRequest: clean(a.firstReq?.text, REQUEST_MAX),
        lastRequest: clean(lastText, REQUEST_MAX),
        requests: a.requests,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        usage,
        lines,
        branches: [...a.branches.entries()].sort((x, y) => x[1] - y[1]).map(([b]) => cleanPath(b)),
        cwd: cleanPath(cwd),
        subagents: a.subagentFiles.size,
      };
      groupOf(cwd ? resolver.resolve(cwd) : null).sessions.push(session);
    }

    // 4) 커밋: 세션이 있던 저장소 + 상위 폴더 아래 저장소
    const hasGit = this.hasGit;
    const repoSet = new Map<string, RepoInfo>();
    for (const g of groups.values()) if (g.repo) repoSet.set(g.repo.key, g.repo);
    for (const r of this.rootRepos) repoSet.set(r.key, r);
    const reposSorted = [...repoSet.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    if (hasGit) {
      for (const repo of reposSorted) {
        const c = this.commitsOf(repo);
        let commits: Commit[] = [];
        let note: string | null = null;
        if (!c.email) note = 'git 사용자 이메일(user.email)이 설정되지 않아 커밋을 가져오지 못했어요.';
        else if (!c.rows) note = 'git log를 읽지 못해 커밋을 가져오지 못했어요.';
        else commits = pickRange(c.rows, start, end);
        // 그날 세션이 없던 저장소는 커밋이 있을 때만 일지에 넣어요.
        if (commits.length === 0 && !groups.has(repo.key)) continue;
        const g = groupOf(repo);
        if (note) g.notes.push(note);
        for (const cm of commits) {
          g.commits.push({
            hash: cm.hash,
            time: new Date(cm.time).toISOString(),
            branch: cm.branch ? cleanPath(neutralizeMarkers(cm.branch)) : null,
            subject: clean(neutralizeMarkers(cm.subject), SUBJECT_MAX) ?? '',
          });
        }
      }
    }

    // 5) 정렬: 그날 첫 활동이 이른 프로젝트부터, "저장소 없음"은 맨 끝
    const firstActivity = (g: Group) =>
      Math.min(...g.sessions.map((s) => Date.parse(s.start)), ...g.commits.map((c) => Date.parse(c.time)), Infinity);
    const projects: ProjectLog[] = [...groups.values()]
      .filter((g) => g.sessions.length > 0 || g.commits.length > 0 || g.notes.length > 0)
      .sort((a, b) => {
        if (!a.repo !== !b.repo) return a.repo ? -1 : 1;
        const d = firstActivity(a) - firstActivity(b);
        if (d !== 0) return d;
        return (a.repo?.key ?? '') < (b.repo?.key ?? '') ? -1 : 1;
      })
      .map((g) => ({
        name: g.repo ? cleanPath(neutralizeMarkers(g.repo.name)) : '저장소 없음',
        path: g.repo ? cleanPath(neutralizeMarkers(g.repo.root)) : null,
        noRepo: !g.repo,
        notes: g.notes,
        sessions: g.sessions.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.sessionId < b.sessionId ? -1 : 1)),
        commits: g.commits,
      }));

    const sessionCount = new Set(projects.flatMap((p) => p.sessions.map((s) => s.sessionId))).size;
    const commitCount = projects.reduce((n, p) => n + p.commits.length, 0);
    const day: DayLog = {
      schema: 1,
      date,
      dayStartHour: cfg.dayStartHour,
      timeZone: timeZoneName(),
      range: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      hideIdentity,
      gitAvailable: hasGit,
      totals: { projects: projects.length, sessions: sessionCount, commits: commitCount },
      redactions: {},
      identity: {},
      projects,
      generatedAt: new Date(now).toISOString(),
    };

    // 6) 가린 자리 세기: 마크다운에 실제로 들어간 표시 기준 (화면도 같은 내용을 보여 줘요)
    for (const [k, v] of Object.entries(countMarkers(renderProjects(day)))) {
      if (k === USER_NAME_LABEL || k === EMAIL_LABEL) {
        if (hideIdentity) day.identity[k] = v;
      } else {
        day.redactions[k] = v;
      }
    }
    return {
      day,
      empty: sessionCount === 0 && commitCount === 0,
      reposRead: hasGit ? reposSorted.length : 0,
      repoKeys: hasGit ? reposSorted.map((r) => r.key) : [],
      subagentFiles,
      subagentFileKeys: [...subagentFileKeys],
      rootIssues: this.rootIssuesList,
    };
  }
}
