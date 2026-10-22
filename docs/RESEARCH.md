# RESEARCH — 기획 전 조사

> 작성: 메인 세션, 2026-10-19
> 기획 에이전트가 PRD를 쓸 때 읽는 입력 자료예요. 기획이 확정된 뒤에는 고치지 않아요.

## 1. 사용자가 정한 것

- 아이디어: Claude Code 세션 기록(`~/.claude/projects/**/*.jsonl`)과 git log를 합쳐 날짜별 작업일지를 만드는 도구
- 기간: 2주, 개인 포트폴리오 프로젝트
- 사용 주체: **공개 도구** (다른 Claude Code 사용자도 설치해서 써요)
- 요약 방식: **기본은 규칙 기반(AI 없음)**, Claude 요약은 사용자가 켤 때만
- 사용자가 고른 차별점 세 가지
  1. 여러 저장소의 실제 `git log`와 세션 기록을 날짜·프로젝트별로 맞추기
  2. 기록을 읽자마자 비밀 값을 기계적으로 가리기
  3. 30일 자동 삭제 전에 기록을 따로 보관하기
- 사용자 선호: Node.js / TypeScript

## 2. 이미 있는 것 (2026-10-19 웹에서 README·공식 문서로 확인)

| 묶음 | 도구 | 하는 일 | 이 프로젝트와 다른 점 |
|---|---|---|---|
| 세션 보기·내보내기 | claude-code-log (MIT, 별 1.2k), claude-code-transcripts (Apache-2.0, 1.7k), SpecStory, cc2md | 세션을 HTML·마크다운으로 | 날짜별 일지, git 결합, 비밀 가리기 없음 |
| 사용량 | ccusage (MIT, 19.1k) | 일·주·월별 토큰 사용량 | 대화 내용은 안 다룸 |
| git 요약 | git-standup (MIT, 7.9k) | 여러 저장소의 커밋을 날짜별로 | 세션 기록은 안 봄 |
| AI 일지 | clerk, claude-daily, remember(공식 마켓), work-log(Notion), daily-log, worklog(tangled) 등 10개 넘음 | 세션을 날짜별로 AI가 요약 | 거의 다 Claude API로 보냄, git log 안 봄, 비밀 가리기 없음, 대부분 별 0~40 |
| 세션+git | gadaj (현재 폴더만, 시간 창), mccm today (한국어·KST, 기록 속 커밋 출력만), receipts (Anthropic 공식, 기간 집계만), Entire (커밋 단위) | 세션과 커밋을 함께 | 여러 저장소의 진짜 git log를 날짜별 일지로 맞추는 도구는 못 찾음 |
| 비밀 가리기 | Entire, Confab, claude-transcript-handoff | 올리기·넘기기 전에 키·토큰 가리기 | 일지 도구에는 없음 |

Claude Code 공식 기능:
- `/export`는 지금 세션 하나만, `/recap`은 지금 세션 한 줄 요약, `/insights`는 일하는 방식 분석 보고서예요. 날짜별 일지는 없어요.
- 일일 보고서 기능 요청(#29585)은 2026-03에 "not planned"로 닫혔어요.
- 공식 문서: 기록은 암호화되지 않고, 명령 출력에 나온 비밀 값이 jsonl에 그대로 남아요.
- `cleanupPeriodDays` 기본값이 30일이라 오래된 세션 기록은 자동으로 지워져요.
- hooks의 모든 이벤트에 `session_id`, `transcript_path`, `cwd`가 들어와요. `SessionEnd` 기본 제한 시간은 1.5초예요.

## 3. 판정

- 나만 쓴다면: 만들 필요 없어요 (Claude에게 시키거나 기존 플러그인 설정).
- 공개 도구라면: 작은 CLI + 로컬 화면으로 만들 가치가 있지만, 위 차별점 세 가지로 범위를 좁혀야 해요.
- 반대 논거: 비슷한 도구가 많고 쓰는 사람이 적다는 신호일 수 있어요. 공식 receipts가 넓어지면 겹쳐요. 세션 기록은 문서 없는 내부 형식이라 바뀔 수 있어요.

## 4. 실제 세션 기록 모양 (사용자 컴퓨터에서 확인, 값은 보지 않음)

- 114개 폴더, 파일 528개, 합계 1.4GB, 가장 큰 파일 88.7MB → 줄 단위 스트리밍으로 읽어야 해요.
- 지금 형식 버전 `2.1.299`, 줄 종류 13가지: `user`, `assistant`, `attachment`, `system`, `custom-title`, `last-prompt`, `cost-state`, `file-history-snapshot`, `file-history-delta`, `queue-operation`, `mode`, `agent-name`, `atis-latch`
- 대화 줄(`user`·`assistant`·`attachment`·`system`)에는 `timestamp`, `cwd`, `gitBranch`, `sessionId`, `version`이 있어요.
- `custom-title`(세션 제목), `last-prompt`(마지막 요청), `cost-state`(추가·삭제 줄 수, 사용 시간)는 AI 없이 요약할 때 쓸 재료예요.
- 서브 에이전트 기록은 `subagents` 폴더에 따로 있어요 (66개).
- 30일 넘은 파일이 68개 남아 있고(설정은 기본값), 8월 기록은 없어요. 언제 지워지는지 정확한 시점은 확인하지 못했어요.

## 5. 참고할 것

| 도구 | 가져올 것 |
|---|---|
| claude-code-log | JSONL 읽기와 HTML 화면 구조 (설계만 참고) |
| ccusage | 날짜별 집계, `--offline` 같은 로컬 우선 옵션 |
| git-standup | 하위 폴더에서 여러 저장소 찾기 |
| Confab, Entire | 비밀 값 패턴 목록, `redaction-test` 같은 검사 명령 |
| worklog (tangled) | 하루 경계를 새벽 3시로, 코드를 바꾼 세션만 일지에 |
| receipts | 대화 내용은 모델에 안 보내고 집계만 보내는 방식 (선택 기능인 Claude 요약 설계에 참고) |
| mccm today | 한국어·KST·30분 단위 타임라인 (라이선스 표기가 없어 아이디어만) |
