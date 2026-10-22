// Claude Code 세션 기록(jsonl) 형식 지식을 한곳에 모았어요.
// 문서 없는 내부 형식이라(기준 버전 2.1.299) 모르는 줄·칸을 만나도 멈추지 않고 건너뛰어요.
// 아는 줄 종류는 처음 알려진 13가지 + 2026-10-20 실제 기록에서 처음 본 13가지(ai-title + 아래 12가지)예요(A13·A17).

export const FORMAT_BASELINE = '2.1.299';

/**
 * 2026-10-20 실제 기록에서 처음 본 줄 종류 중 일지 재료가 아닌 12가지 (A13·A17·Q20).
 * 아는 종류라 건너뛴 줄 수에 세지 않아요. 이 중 pr-link만 보관본에 남기고(A7·Q19), 나머지 11가지는 빼요.
 */
export const SEEN_TYPES_2026_10_20 = [
  'pr-link',
  'frame-link',
  'permission-mode',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'started',
  'result',
  'failed',
  'launched',
] as const;

export const KNOWN_TYPES = new Set<string>([
  'user',
  'assistant',
  'attachment',
  'system',
  'custom-title',
  'last-prompt',
  'cost-state',
  'file-history-snapshot',
  'file-history-delta',
  'queue-operation',
  'mode',
  'agent-name',
  'atis-latch',
  'ai-title',
  ...SEEN_TYPES_2026_10_20,
]);

/**
 * 보관본에 남기는 줄 종류 (A7): 대화 글, 일지 재료 줄(custom-title·ai-title·last-prompt·cost-state),
 * 나중에 PR 기능에 쓸 pr-link(이번 일지에는 쓰지 않아요, Q19).
 */
export const KEEP_TYPES = new Set(['user', 'assistant', 'custom-title', 'ai-title', 'last-prompt', 'cost-state', 'pr-link']);

/** timestamp·cwd·sessionId가 꼭 있어야 하는 줄 (A13) */
export const CONVERSATION_TYPES = new Set(['user', 'assistant']);

export type Json = Record<string, unknown>;

export type Classified =
  | { kind: 'broken' }
  | { kind: 'unknown'; type: string }
  | { kind: 'missing'; type: string }
  | { kind: 'drop'; type: string }
  | { kind: 'keep'; type: string; obj: Json };

/** 줄 하나를 읽어 종류를 나눠요. JSON 오류 메시지는 원문 조각이 들어갈 수 있어서 버려요. */
export function classifyLine(line: string): Classified {
  if (!line.trim()) return { kind: 'broken' };
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: 'broken' };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'broken' };
  const o = obj as Json;
  const type = typeof o.type === 'string' ? o.type : '';
  if (!KNOWN_TYPES.has(type)) return { kind: 'unknown', type };
  if (!KEEP_TYPES.has(type)) return { kind: 'drop', type };
  if (CONVERSATION_TYPES.has(type)) {
    if (typeof o.timestamp !== 'string' || Number.isNaN(Date.parse(o.timestamp))) return { kind: 'missing', type };
    if (typeof o.cwd !== 'string' || !o.cwd) return { kind: 'missing', type };
    if (typeof o.sessionId !== 'string' || !o.sessionId) return { kind: 'missing', type };
  }
  return { kind: 'keep', type, obj: o };
}

/** 화면에 보여 줘도 되는 줄 종류 이름인지 (모르는 종류 이름을 S3에 보여 줄 때) */
export function safeTypeName(t: string): string | null {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(t) ? t : null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** 도구 입력 중 코드 본문이 드는 칸 — 보관본에서 빼요 (Q15) */
const LONG_INPUT_KEYS = new Set(['content', 'new_string', 'old_string', 'edits', 'new_source', 'source', 'patch', 'diff', 'code']);
const SHORT_VALUE_MAX = 300;

/** 도구 호출 입력은 도구 이름과 짧은 값(명령, 파일 경로, 검색어 등)만 남겨요 (A7, Q15). */
export function shortToolInput(input: unknown): Json {
  const out: Json = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Json)) {
    if (LONG_INPUT_KEYS.has(k)) {
      out[k] = '[생략: 긴 값]';
    } else if (typeof v === 'string') {
      out[k] = v.length <= SHORT_VALUE_MAX ? v : '[생략: 긴 값]';
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (v !== null && v !== undefined) {
      out[k] = '[생략: 긴 값]';
    }
  }
  return out;
}

function filterBlock(b: unknown): Json | null {
  if (b === null || typeof b !== 'object') return null;
  const block = b as Json;
  const type = str(block.type) ?? '';
  switch (type) {
    case 'text':
      return { type: 'text', text: str(block.text) ?? '' };
    case 'tool_result': {
      const out: Json = { type: 'tool_result', omitted: '도구 출력' };
      if (typeof block.tool_use_id === 'string') out.tool_use_id = block.tool_use_id;
      if (block.is_error === true) out.is_error = true;
      return out;
    }
    case 'tool_use': {
      const out: Json = { type: 'tool_use' };
      if (typeof block.id === 'string') out.id = block.id;
      out.name = str(block.name) ?? '';
      out.input = shortToolInput(block.input);
      return out;
    }
    case 'image':
      return { type: 'image', omitted: '그림' };
    case 'document':
      return { type: 'document', omitted: '첨부 문서' };
    case 'thinking':
    case 'redacted_thinking':
      return { type: 'thinking', omitted: '생각 과정' };
    default:
      return { type: safeTypeName(type) ?? 'unknown', omitted: '알 수 없는 내용' };
  }
}

const CONVERSATION_FIELDS = ['type', 'uuid', 'parentUuid', 'isSidechain', 'isMeta', 'isCompactSummary', 'agentId', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'version'] as const;

/**
 * 보관본에 쓸 모양으로 줄을 줄여요 (가리기 전 단계).
 * - user·assistant: 대화 글과 일지에 필요한 값만 남기고, 도구 출력 본문·그림·생각 과정은 빼고 "무엇이 빠졌는지"만 표시해요.
 * - custom-title·ai-title·last-prompt·cost-state·pr-link: 그대로 남겨요(가리기는 다음 단계에서 해요). sessionId가 없으면 파일의 세션 아이디를 붙여요.
 */
export function toArchiveShape(c: Extract<Classified, { kind: 'keep' }>, fileSessionId: string): Json {
  const o = c.obj;
  if (!CONVERSATION_TYPES.has(c.type)) {
    const copy: Json = { ...o };
    if (typeof copy.sessionId !== 'string') copy.sessionId = fileSessionId;
    return copy;
  }
  const out: Json = {};
  for (const k of CONVERSATION_FIELDS) {
    if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  }
  const msg = o.message as Json | undefined;
  if (msg && typeof msg === 'object') {
    const m: Json = {};
    if (typeof msg.role === 'string') m.role = msg.role;
    const content = msg.content;
    if (typeof content === 'string') m.content = content;
    else if (Array.isArray(content)) m.content = content.map(filterBlock).filter((x): x is Json => x !== null);
    out.message = m;
  }
  return out;
}

/** 사용자가 직접 쓴 요청 글인지 보고, 맞으면 글을 돌려줘요 (도구 결과·명령 출력·메타 줄은 빼요). */
export function userRequestText(o: Json): string | null {
  if (o.type !== 'user' || o.isSidechain === true || o.isMeta === true || o.isCompactSummary === true) return null;
  const content = (o.message as Json | undefined)?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const blocks = content as Json[];
    if (blocks.some((b) => b && b.type === 'tool_result')) return null;
    text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  text = text.trim();
  if (!text) return null;
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return [cmd[1], args].filter(Boolean).join(' ') || null;
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (bash) return `! ${bash[1]!.trim()}`;
  if (/^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|system-reminder|task-notification)/.test(text)) {
    return null;
  }
  if (text.startsWith('[Request interrupted by user')) return null;
  if (text.startsWith('Caveat: The messages below were generated')) return null;
  return text;
}

export interface CostFields {
  linesAdded?: number;
  linesRemoved?: number;
  durationMs?: number;
}

const norm = (k: string) => k.toLowerCase().replace(/[_\-\s]/g, '');

/**
 * cost-state 줄에서 추가·삭제 줄 수와 사용 시간을 찾아요.
 * 실제 칸 이름이 문서에 없어서, 이름에 linesadded / linesremoved / duration 이 든 숫자 칸을 찾아요.
 */
export function costFields(o: Json): CostFields {
  const found: { added: Array<[number, number]>; removed: Array<[number, number]>; dur: Array<[number, number]> } = {
    added: [],
    removed: [],
    dur: [],
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 3 || v === null || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Json)) {
      const n = norm(k);
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
        if (n.includes('linesadded') || n === 'added' || n === 'additions') found.added.push([prio(n, 'linesadded'), val]);
        else if (n.includes('linesremoved') || n.includes('linesdeleted') || n === 'removed' || n === 'deletions') {
          found.removed.push([prio(n, 'linesremoved'), val]);
        } else if (n.includes('duration') && !n.includes('api') && !n.includes('tool')) {
          const ms = /(seconds|secs|sec)$/.test(n) ? val * 1000 : val;
          found.dur.push([prio(n, 'totalduration'), ms]);
        }
      } else if (val && typeof val === 'object') {
        walk(val, depth + 1);
      }
    }
  };
  walk(o, 0);
  const pick = (arr: Array<[number, number]>) => (arr.length ? arr.sort((a, b) => a[0] - b[0])[0]![1] : undefined);
  const out: CostFields = {};
  const a = pick(found.added);
  const r = pick(found.removed);
  const d = pick(found.dur);
  if (a !== undefined) out.linesAdded = a;
  if (r !== undefined) out.linesRemoved = r;
  if (d !== undefined) out.durationMs = d;
  return out;
}

/** 칸 이름이 기대한 이름에 가까울수록 앞에 와요 (total* > 그냥 > last*) */
function prio(n: string, ideal: string): number {
  if (n === ideal) return 0;
  if (n.startsWith('total')) return 1;
  if (n.startsWith('last')) return 3;
  return 2;
}

/** 버전 문자열 비교 (2.1.299 < 2.2.0) */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
