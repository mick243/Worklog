# COMPETITOR_RESEARCH — 경쟁 서비스 조사

> 상태: 작성됨
> 작성: competitor-researcher, 2026-10-21
> 조사 대상 (메인 세션이 고름)
> 1. **SpecStory**: 세션 기록 저장·내보내기 쪽에서 가장 널리 쓰이고 유료 요금제가 있는 도구 (대안·가격 비교 기준)
> 2. **Entire**: 세션과 커밋을 함께 다루고 비밀 값 가리기가 있는, 기능이 가장 가까운 도구
> 3. **receipts**: 기획 전 조사에서 "Anthropic 공식, 기간 집계만"으로 적은 도구
>
> 따로 적지 않은 숫자·상태는 모두 2026-10-21에 확인했어요.

## 0. 읽는 법

- 공식 README, 공식 문서, 공식 블로그, 공식 패키지·마켓 페이지를 먼저 봤어요. 공식이 아닌 자료는 **[비공식]**으로 표시했어요.
- 확인하지 못한 것은 "확인 못 함"으로 적었고, 6장에 모았어요.
- 강점·약점이나 cc-worklog와 비교한 판단은 넣지 않았어요. 그건 분석 단계(`docs/COMPETITOR_ANALYSIS.md`)에서 해요.

## 1. 한눈에 보기 (사실만)

| 항목 | SpecStory | Entire | receipts |
|---|---|---|---|
| 만든 곳 | SpecStory (공동 창업자 Jake Levirne, Sean Johnson, Greg Ceccarelli) | Entire (전 GitHub CEO Thomas Dohmke가 2026-02-10 발표) | Anthropic |
| 형태 | CLI(래퍼) + Cursor·VS Code 확장 + Cloud(웹) + 스킬(Lore) | CLI(git 훅) + entire.io 웹·호스팅 | Claude Code 플러그인(`/receipts` 스킬 + Node 스크립트) |
| 라이선스 | CLI Apache-2.0, 확장은 비공개 소스 | CLI MIT | Apache-2.0 |
| 가격 | 확장·CLI 무료, Cloud 무료 요금제 + Pro·Team(공식 가격 확인 못 함) | CLI 무료, entire.io 요금 확인 못 함 | 무료 (보고서 작성에 모델 호출 1번) |
| Claude Code 기록 읽기 | `~/.claude/projects/` | 훅 + JSONL 기록, 지난 30일 가져오기 | `~/.claude/projects/**/*.jsonl` |
| git 결합 | 문서에 없음 | 커밋마다 체크포인트 | Claude가 손댄 파일 경로로 거른 `git log` |
| 결과 단위 | 세션마다 마크다운 | 커밋(체크포인트), 기간 요약 명령 있음 | 기간 합계·프로젝트별 합계 (하루별 없음) |
| 비밀 가리기 | 기본 켜짐 (Betterleaks) | 기본 켜짐 (9겹, best-effort) | 없음 (대화 내용을 저장하지 않고 수만 셈) |
| 외부 전송 | 로그인하면 Cloud 동기화, 익명 사용 통계 | git push에 체크포인트 포함(기본), 익명 통계 | 집계 JSON만 모델로 |

## 2. SpecStory

### 2.1 같은 이름 확인

- 조사한 것: Claude Code 등 코딩 에이전트 세션을 마크다운으로 저장하는 SpecStory예요. 공식 사이트 https://specstory.com , 문서 https://docs.specstory.com , 저장소 https://github.com/specstoryai/getspecstory (CLI 소스는 `specstory-cli` 폴더)
- 섞이면 안 되는 것: 같은 회사의 다른 제품 **RunStory**(비공개 알파, 크레딧 요금)와 **BearClaude**(https://bearclaude.specstory.com/pricing, 별도 앱)의 가격은 SpecStory CLI·Cloud 가격이 아니에요.

### 2.2 한 줄 소개·만든 곳·형태·설치

- 한 줄 소개: 코딩 에이전트와 나눈 대화를 세션이 끝난 뒤에도 남도록 자동 저장하고, 검색·공유할 수 있게 하는 도구예요. 저장소 README의 문구는 "Intent is the new source code"예요. (https://specstory.com/specstory , https://github.com/specstoryai/getspecstory)
- 만든 곳: SpecStory. 공동 창업자 Jake Levirne(CEO), Sean Johnson(CTO), Greg Ceccarelli(CPO). GitHub 조직 위치는 미국이에요. 법인 이름·설립 연도는 확인 못 함. (https://specstory.com/about , https://github.com/specstoryai)
- 형태 (https://github.com/specstoryai/getspecstory , https://docs.specstory.com)
  - SpecStory CLI: 터미널 에이전트를 감싸서 실행하는 래퍼, 오픈소스
  - Cursor 확장, VS Code(GitHub Copilot) 확장: README 표에 "Closed" 소스로 적혀 있어요
  - SpecStory Cloud: 동기화한 세션 검색·공유 웹 서비스 (https://cloud.specstory.com)
  - Lore: 저장된 기록에서 재사용할 스킬을 뽑는 에이전트 스킬 (`/lore`)
- 지원 에이전트: Claude Code(v1.0.27+), Codex CLI, Cursor CLI, Gemini CLI, Droid, Antigravity, Qwen Code, Pi, Grok Build, OpenCode 등, Cursor·Copilot IDE, Cursor Cloud Agents (https://github.com/specstoryai/getspecstory)
- 설치 (https://docs.specstory.com/integrations/terminal-coding-agents)
  - macOS·Linux: `curl -fsSL https://specstory.com/install.sh | sh`
  - Homebrew: `brew install specstoryai/tap/specstory`
  - Windows: `powershell -c "irm https://specstory.com/install.ps1 | iex"` (x64·ARM64, PowerShell 5.1·7)
  - GitHub 릴리스의 실행 파일을 직접 받아 PATH에 넣는 방법도 있어요.
  - Claude Code와 쓰기: `specstory check` → `specstory run claude` (https://docs.specstory.com/integrations/claude-code)

### 2.3 주요 기능 (문서에 있는 것만)

1. **세션 자동 저장**: `specstory run claude`로 실행하면 대화가 프로젝트의 `.specstory/history/`에 마크다운으로 저장돼요. `specstory watch claude`는 Claude Code를 그냥 쓰는 동안 뒤에서 기록해요. (https://docs.specstory.com/integrations/claude-code)
2. **지난 세션 내보내기**: `specstory list claude`, `specstory sync claude`(`-s <session-id>`로 하나만)로 SpecStory 없이 했던 세션도 `~/.claude/projects/`에서 읽어 그 프로젝트에 맞춰 마크다운으로 만들어요. (https://docs.specstory.com/integrations/claude-code)
3. **검색·이어 하기**: `specstory search`는 모든 프로젝트·에이전트의 지난 세션을 찾고, `specstory resume`은 같은 에이전트나 다른 에이전트·다른 프로젝트로 세션을 이어 가요. 사용자 폴더의 `~/.specstory/sessions.db`(SQLite)가 색인이에요. (https://docs.specstory.com/integrations/terminal-coding-agents/usage)
4. **저장 시 비밀 값 가리기**: 기본으로 켜져 있어요(2.6 참고). (https://docs.specstory.com/integrations/terminal-coding-agents/usage)
5. **Cloud 동기화·검색·공유**: 로그인하면 세션을 Cloud에 올려 프로젝트·기간으로 좁혀 검색하고, 공개 링크로 공유하고, API로 꺼낼 수 있어요. 분석(Analytics)은 Pro, 스킬은 Pro·Team 요금제에서 돼요. (https://docs.specstory.com/cloud/overview , https://docs.specstory.com/cloud/analytics , https://docs.specstory.com/skills)

- 날짜별 정리나 git 연동은 CLI 문서에 나오지 않아요. 파일 이름과 내용의 시각은 기본이 UTC이고 `--local-time-zone`으로 현지 시각을 쓸 수 있어요. 마크다운 파일 이름 규칙은 확인 못 함. (https://docs.specstory.com/integrations/terminal-coding-agents/usage)

### 2.4 가격

- 공식 문구: "The extensions and CLI are free. The CLI is open source." / "Cloud has a free plan; features such as analytics and skills depend on your plan." (https://docs.specstory.com)
- 공식 홈 제목에도 "FREE EXTENSIONS, CLI & CLOUD"가 있어요. (https://specstory.com)
- 유료 요금제 이름: **Pro**, **Team** (https://docs.specstory.com/cloud/analytics , https://docs.specstory.com/skills). README에는 "SpecStory Cloud for Teams"가 나와요.
- 유료 요금제 가격: 공식 자료에서 확인 못 함 (`specstory.com/pricing` 404, `cloud.specstory.com/pricing`은 내용 없음).
  - [비공식] 가격 모음 사이트 aisotools는 Free $0, Cloud Pro $25/월, Cloud Team $300/월, Enterprise 별도 문의로 적고 있어요(페이지 갱신일 2026-10-21, 출처는 "공개 자료"라고만 적음). https://aisotools.com/pricing/specstory
- 라이선스: getspecstory 저장소 Apache-2.0. 확장은 비공개 소스. (https://github.com/specstoryai/getspecstory)
- 간접 비용: 저장 자체에는 모델 호출이 없어요. 확장의 선택 기능 "Derived Rules"는 프롬프트 기록 등을 LLM으로 보내요. (https://docs.specstory.com/privacy)

### 2.5 타깃

- 문서가 말하는 대상: 코딩 에이전트를 쓰는 개발자. 에이전트 세션에서 나온 요청·결정을 다음 작업에서 다시 쓰고 싶은 상황이에요. (https://specstory.com , https://docs.specstory.com)
- 팀: README에 조직 안에서 지식을 나누는 "SpecStory Cloud for Teams"가 있어요. 한편 Cloud 문서 검색 결과에는 "지금은 1인 작업 공간, 팀 협업은 로드맵"이라는 문장도 보였어요(원문 페이지에서 다시 확인 못 함). (https://github.com/specstoryai/getspecstory)

### 2.6 데이터 처리

- 읽는 것: Claude Code의 `~/.claude/projects/` JSONL, Cursor의 `state.vscdb`, VS Code의 `chatSessions` 폴더. (https://docs.specstory.com/privacy)
- 쓰는 곳: 프로젝트 `.specstory/history/`(마크다운), `.specstory/cli/config.toml`, 사용자 `~/.specstory/sessions.db`, `~/.specstory/cli/auth.json`. (https://docs.specstory.com/integrations/terminal-coding-agents/usage)
- 외부 전송
  - Cloud: 로그인하고 동기화가 켜져 있으면 `run`·`watch`·`sync`가 세션을 올려요. 로그인만으로는 지난 기록을 올리지 않아요. `--no-cloud-sync`나 `[cloud_sync] enabled = false`로 막아요. Cloud를 쓰면 프롬프트와 답변 속 코드가 SpecStory로 가요. (https://docs.specstory.com/cloud/sync-and-store , https://docs.specstory.com/privacy)
  - 사용 통계: CLI `[analytics]`가 기본 켜짐("Send anonymous product usage analytics"), `--no-usage-analytics`로 꺼요. 확장은 PostHog로 활성화·저장·공유 이벤트를 보내고 `specstory.helpUsImprove`로 꺼요. OpenTelemetry 내보내기는 주소를 설정해야만 켜져요. (https://docs.specstory.com/integrations/terminal-coding-agents/usage , https://docs.specstory.com/privacy)
- 비밀 가리기
  - `[redaction] enabled` 기본 `true`, "Redact secrets and API keys from saved markdown history." 탐지는 Betterleaks 규칙 모음(API 키, 토큰, 개인 키 등). `--no-redact-secrets`로 꺼요. (https://docs.specstory.com/integrations/terminal-coding-agents/usage)
  - v2.4.0 릴리스 노트: 기본으로 가린 채 저장하고, "Redaction also covers all the data synced to SpecStory Cloud, not just local markdown." 출시일은 7월 20일로만 보이고 연도는 확인 못 함. (https://github.com/specstoryai/getspecstory/releases/tag/v2.4.0)
  - v2.16.0 노트: Cursor Cloud 세션을 받아 두는 `.specstory/cursorcloud/`에는 가리지 않은 기록이 있어서 `.gitignore`를 넣는다고 적혀 있어요. (https://github.com/specstoryai/getspecstory/releases/tag/v2.16.0)
  - 같은 회사의 별도 스킬 SpecStory Guard는 커밋 전에 `.specstory/history`를 검사하는 pre-commit 훅이에요. [비공식 목록] https://skills.cat/skills/specstoryai/agent-skills/specstory-guard (원 저장소 https://github.com/specstoryai/agent-skills 별 35)

### 2.7 인기·활동 신호 (2026-10-21)

- GitHub 별 1.4k(조직 목록 숫자 1,358), 포크 92 (https://github.com/specstoryai/getspecstory , https://github.com/specstoryai)
- 최근 릴리스: CLI v2.16.0, 2026-10-18 (그 전 v2.15.1 9-24) (https://github.com/specstoryai/getspecstory/releases)
- README 배지(자체 집계): 설치 232,326 / 활성 사용자 11,513 / 저장된 세션 8,175,240 (https://specstory.com/api/badge?stat=installs , `stat=activeUsers`, `stat=sessionsSaved`)

## 3. Entire

### 3.1 같은 이름 확인

- 조사한 것: git 훅으로 에이전트 세션을 커밋과 함께 기록하는 Entire CLI와 그 회사의 entire.io예요. 공식 사이트 https://entire.io , 문서 https://docs.entire.io , 저장소 https://github.com/entireio/cli , Claude Code 연동 문서 https://docs.entire.io/agents/claude-code
- 설치 스크립트 주소가 README는 `entire.com`, 문서는 `entire.io`로 달라요. 둘 다 그대로 적었어요.

### 3.2 한 줄 소개·만든 곳·형태·설치

- 한 줄 소개: git 작업 흐름에 걸려서 에이전트 세션(프롬프트, 답변, 손댄 파일)을 커밋 옆에 기록해, 코드가 어떻게 쓰였는지 나중에 볼 수 있게 하는 도구예요. 사이트 문구는 "Every agent session stored in your repo"예요. (https://github.com/entireio/cli , https://entire.io)
- 만든 곳: Entire. 2026-02-10 Thomas Dohmke(전 GitHub CEO)가 첫 제품 Checkpoints와 6천만 달러 시드 투자(Felicis 주도)를 발표했어요. (https://entire.io/blog/hello-entire-world.md)
- 형태: 오픈소스 CLI + entire.io 웹 앱 + 플랫폼(git 호스팅·미러, 세션 저장, 의미 그래프 `entire-graph`, 에이전트 검색). 데이터 지역은 인도·호주·EU·미국. (https://entire.io , https://entire.io/about)
- 지원 에이전트: Claude Code(기본), Codex, Cursor, Antigravity, Copilot CLI, Factory Droid, OpenCode, Pi(미리보기), Grok(2026-10-16 블로그). (https://github.com/entireio/cli , https://entire.io/blog)
- 설치 (https://docs.entire.io/installation.md , https://github.com/entireio/cli)
  - macOS: `brew install --cask entireio/tap/entire`
  - Linux: `curl -fsSL https://entire.io/install.sh | bash` (README는 `https://entire.com/install.sh`)
  - Windows: `irm https://entire.io/install.ps1 | iex` (README는 `entire.com`), Scoop도 있어요. Windows 지원은 2026-03-30 블로그에서 발표했어요. (https://entire.io/blog/entire-dispatch-0x0007.md)
  - Go: `go install github.com/entireio/cli/cmd/entire@latest`
  - 요구 사항: Git 2.25+, macOS·Linux·Windows
  - 저장소에서 `entire enable`, Claude Code 훅 설치는 `entire agent add claude-code`(`.claude/settings.json`에 훅을 넣고 다른 설정은 그대로 둬요). (https://docs.entire.io/agents/claude-code.md)

### 3.3 주요 기능 (문서에 있는 것만)

1. **커밋마다 체크포인트**: 대화 기록, 프롬프트, 바뀐 파일, 도구 호출, 토큰 사용량을 커밋과 묶어 저장하고, 커밋에 `Entire-Checkpoint` 트레일러를 붙여요. 서브 에이전트 세션도 부모 세션 아래에 기록해요. 브랜치 기록은 깨끗하게 둬요. (https://github.com/entireio/cli , https://docs.entire.io/agents/claude-code.md , https://docs.entire.io/security.md)
2. **찾기·설명**: `entire search`(로컬), `entire checkpoint explain`(`--generate`로 요약 생성), `entire blame`, `entire why`. 여러 저장소 검색은 entire.io 계정이 있어야 해요. (https://github.com/entireio/cli , https://docs.entire.io/platforms/cli-and-entire-io.md)
3. **세션 이어 하기·되감기**: `entire session resume <branch>`가 세션 데이터를 되살리고 `claude -r SESSION_ID`를 알려 줘요. 체크포인트로 되감기(rewind)도 있어요. (https://docs.entire.io/agents/claude-code.md , https://docs.entire.io/guides/sessions/import-past-agent-history.md)
4. **기간 요약**
   - `entire recap`: 에이전트·체크포인트 활동을 시간 단위로 요약. 기본 `--day`(오늘), `--week`, `--month`, `--90`, `--view you|team|both`, `--static`. (https://docs.entire.io/cli-reference/recap.md)
   - `entire dispatch`: 최근 에이전트 작업을 공유용 마크다운으로 요약. 기본 `--since 7d`, 클라우드 모드는 `--repos`로 저장소 5개까지, `--local`은 지금 저장소 데이터를 내 컴퓨터의 에이전트 CLI(`--agent`)로 글을 써요. (https://docs.entire.io/guides/dispatches/dispatches-in-cli.md , https://docs.entire.io/guides/dispatches/overview.md)
   - `entire activity`: entire.io에 올라간 작업의 지난 한 달 활동(저장소별, 최근 세션·커밋). 로그인 필요. (https://docs.entire.io/cli-reference/activity.md)
5. **지난 세션 가져오기**: `entire import claude-code`가 지금 저장소의 지난 Claude Code 기록(지난 30일)을 읽기 전용 체크포인트로 넣어요. 다시 실행해도 이미 넣은 턴은 건너뛰어요. 커밋과는 자동으로 잇지 않고 `entire session attach`로 이어요. (https://docs.entire.io/guides/sessions/import-past-agent-history.md , https://docs.entire.io/agents/claude-code.md)
6. **저장 전 비밀 가리기**: 3.6 참고.

### 3.4 가격

- CLI: MIT 라이선스 오픈소스예요. (https://github.com/entireio/cli , https://entire.io)
- entire.io(호스팅·클라우드 기능) 요금: 확인 못 함. `entire.io/pricing`은 404이고, 홈·about·문서 FAQ·블로그 목록에 요금 이야기가 없어요. (https://entire.io , https://entire.io/about , https://docs.entire.io/faq.md , https://entire.io/blog)
- 간접 비용: `entire checkpoint explain --generate`와 `entire dispatch --local`은 설정한 에이전트 CLI(기본 Claude Code)로 요약을 만들어서, 그 에이전트의 모델 사용량이 들어요. (https://docs.entire.io/security.md , https://docs.entire.io/guides/dispatches/dispatches-in-cli.md)

### 3.5 타깃

- 어떤 에이전트·모델을 쓰든 코딩 에이전트로 일하는 개발자, 그리고 에이전트가 쓴 코드의 추적·리뷰가 필요한 팀이에요. 발표 글은 병목이 "작성"에서 "리뷰"로 옮겨 간다고 말해요. (https://entire.io/blog/hello-entire-world.md , https://entire.io)
- 사용 상황: 코드가 왜 이렇게 쓰였는지 찾기, 세션 공유, 팀원·리뷰어에게 주간 요약 보내기(dispatch). (https://docs.entire.io/guides/dispatches/overview.md , https://entire.io/blog/sharing-sessions-is-the-new-social-coding.md)

### 3.6 데이터 처리

- 읽는 것: Claude Code 훅(세션 경계, 프롬프트, 끝난 턴, 작업 이벤트)과 JSONL 기록에서 대화 전체, 파일 변경, 도구 호출, 토큰 사용량을 읽어요. 저장소의 git 정보도 써요. (https://docs.entire.io/agents/claude-code.md)
- 저장 위치: 내 git 저장소 안. 체크포인트마다 ref(`refs/entire/checkpoints/...`) 또는 `entire/checkpoints/v1` 브랜치(백엔드에 따라), 설정·로그는 `.entire/`. 저장소를 읽을 수 있는 사람은 체크포인트도 읽을 수 있고, 공개 저장소면 공개돼요. (https://docs.entire.io/security.md)
- 외부 전송 (https://docs.entire.io/security.md)
  - `git push` 때 체크포인트도 함께 올라가요. `strategy_options.push_sessions` 기본 `true`, `false`면 로컬에만 둬요. 체크포인트만 다른 저장소로 보낼 수도 있어요.
  - 요약 생성 시 가리고 줄인 대화를 요약 제공자(보통 그 세션의 에이전트)로 보내요.
  - 익명 사용 통계를 PostHog로 보내요. 프롬프트·대화·코드·파일 경로·저장소 이름은 안 보낸다고 적혀 있어요. `"telemetry": false`나 `ENTIRE_TELEMETRY_OPTOUT=1`로 꺼요. 기본값은 문서에 `null`로만 적혀 있어요. (https://docs.entire.io/guides/configuration/privacy-and-redaction.md)
  - entire.io는 GitHub App으로 허락한 저장소를 읽고, 저장소 접근 권한이 있는 사람이 보는 것과 같은 (가려진) 내용을 봐요. 문서는 "대화 기록을 받는 서비스를 따로 돌리지 않는다"고 적어요.
- 비밀 가리기
  - 체크포인트 메타데이터를 쓰기 전에 9겹으로 검사해요. 1~8겹은 엔트로피·패턴·구조 검사, 개인 정보(PII) 탐지는 선택, 9겹 OpenAI Privacy Filter는 선택이고 push 때 브랜치 백엔드에서만 돌아요. 문서는 "best-effort", "a safety net rather than a guarantee"라고 적어요. (https://docs.entire.io/security.md)
  - 비밀 탐지 엔진: Betterleaks(기본 켜짐, 수백 가지 형식), goredact(기본 꺼짐, 길이·체크섬 같은 구조 검사). 기본 범주는 API 키, 접근 토큰, 자격 증명 든 URL, DB 접속 문자열, 개인 키. (https://docs.entire.io/guides/configuration/privacy-and-redaction.md)
  - PII: 기본 꺼짐. 켜면 이메일·전화번호가 기본, 미국 주소는 선택. 사용자 이름·파일 경로는 PII 범주에 없어요. (같은 문서)
  - 사용자 규칙: `redaction.pii.custom_patterns`(`[REDACTED_<LABEL>]`), `redaction.custom_redactions`(`REDACTED`), 규칙 묶음 폴더 `.entire/redactors/`(공유)·`.entire/redactors/local/`(개인). Go RE2 문법. 사용자 정의 가리기는 2026-05-19 블로그에서 발표했어요. (같은 문서, https://entire.io/blog)
  - 가리지 않는 것: 원본 에이전트 세션 파일은 다시 쓰지 않아 그대로예요. 작업 트리 원본 스냅숏(shadow branch, push하지 않고 깨끗한 push 뒤 지움), 진단 로그, 이미지, 짧거나 예측 가능한 비밀, 파일 이름·바이너리도 빠져요. (https://docs.entire.io/security.md)
  - `entire import`로 가져온 기록에 가리기가 적용되는지는 문서에 없어요(확인 못 함).

### 3.7 인기·활동 신호 (2026-10-21)

- GitHub 별 5.2k, 포크 489, 커밋 10,685 (https://github.com/entireio/cli)
- 최근 릴리스: 안정판 v0.11.6(2026-10-20, "Latest"), 야간판 v0.11.7-nightly(2026-10-21) (https://github.com/entireio/cli/releases)
- 최근 블로그: Grok 연동(2026-10-16), Google 계정 로그인(2026-10-08), 세션 공유(2026-10-06) (https://entire.io/blog)
- 다운로드 수: 확인 못 함

## 4. receipts

### 4.1 같은 이름 확인·누가 만들었나

- 조사한 것: Anthropic 공식 플러그인 마켓 `claude-plugins-official`의 `plugins/receipts`예요. https://github.com/anthropics/claude-plugins-official/tree/main/plugins/receipts , 공식 플러그인 페이지 https://claude.com/plugins/receipts
- **Anthropic이 만든 것이 맞아요.** 근거 세 가지:
  1. 마켓 목록 `marketplace.json`의 receipts 항목 작성자가 `"Anthropic"`(support@anthropic.com), 소스는 `./plugins/receipts`예요. (https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json)
  2. 저장소 README가 `/plugins`를 "Internal plugins developed and maintained by Anthropic", `/external_plugins`를 제3자 플러그인으로 나눠요. (https://github.com/anthropics/claude-plugins-official)
  3. claude.com 플러그인 페이지에 만든 곳 Anthropic, "Anthropic verified" 표시가 있어요. (https://claude.com/plugins/receipts)
  - 2026-07-17 `morganl-ant`가 "Add receipts plugin (#4176)"으로 추가했어요. (https://github.com/anthropics/claude-plugins-official/commits/main/plugins/receipts)
- 섞이면 안 되는 것: 제3자 "Receipts"(abhitsian, 토큰·세션 대시보드와 공유용 영수증 카드)는 다른 도구예요. [비공식 목록] https://skillselion.com/skills/abhitsian/receipts/plugin

### 4.2 한 줄 소개·형태·설치

- 한 줄 소개: 내 Claude Code 세션 기록과 로컬 git 기록으로 "Claude Code 사용이 무엇을 만들어 냈는지" 개인 영향 보고서(영수증)를 만드는 플러그인이에요. (https://github.com/anthropics/claude-plugins-official/tree/main/plugins/receipts)
- 형태: Claude Code 플러그인. 스킬 `receipts`(`SKILL.md`)와 Node 스크립트 `scripts/mine-transcripts.mjs` 하나로 돼 있어요. (https://github.com/anthropics/claude-plugins-official/tree/main/plugins/receipts/skills/receipts)
- 설치·사용: `/plugin install receipts@claude-plugins-official` 뒤 `/receipts`(지난 30일), `/receipts week`, `/receipts quarter`, `/receipts 14`, `/receipts for myrepo`. SKILL.md에는 `year`(365일)도 있어요. (README, https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/receipts/skills/receipts/SKILL.md)

### 4.3 주요 기능 (문서·코드에 있는 것만)

1. **만든 것**: 손댄 파일·줄 수, 그 작업이 담긴 커밋, 연 PR 수. (README)
2. **프로젝트별**: 세션 수, 활동한 날 수, 사용 비중. 파일을 건드리지 않은 세션은 "Research & investigation (no project)"로 묶어요. (README)
3. **보여 주는 방법 안내**: 매니저에게 과장 없이 설명하는 문구를 함께 줘요. 금액, "절약한 시간", 활동별 지출은 일부러 넣지 않아요. (README)
4. **결과 파일**: 홈 폴더에 `~/claude-code-receipts-<since>-to-<until>.md`와 같은 이름의 `.html`(혼자 열리는 파일, Export CSV 버튼, PDF 인쇄). HTML은 먼저 `/tmp/cc-receipt.html`에 쓰고 복사해요. 어디에도 올리지 않아요. (SKILL.md, README)
5. **기간·범위 지정**: 기간(일 수)과 프로젝트 이름 일부(`--repo`)로 좁혀요. (SKILL.md)

- 하루별 타임라인·일지는 없어요. 활동한 날은 수(count)로만 나오고, 결과는 기간 합계와 프로젝트별 합계예요. (SKILL.md, https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/receipts/skills/receipts/scripts/mine-transcripts.mjs)
- PR 수는 기록 속 `gh pr create` 명령 수를 센 것이라 실제로 PR이 만들어졌는지는 확인하지 않아요. (SKILL.md)
- 관련 공식 플러그인 `session-report`는 같은 기록으로 토큰 낭비(캐시 적중률, 비싼 프롬프트)를 보여 줘요. (README, marketplace.json)

### 4.4 가격

- 무료. 플러그인 폴더의 `LICENSE`는 Apache License 2.0이에요. (https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/receipts/LICENSE)
- 간접 비용: 기록 분석은 로컬 스크립트라 API 호출이 없고, 마지막에 작은 JSON 요약(약 10~20KB)으로 보고서를 쓰는 모델 호출이 한 번 있어요. Claude Code 사용량에 들어가요. (SKILL.md)
- Claude Code 자체가 필요해요(플러그인).

### 4.5 타깃

- "Claude Code 사용이 무엇을 사 주고 있나"라는 질문을 받은 사람. 매니저에게 사용을 설명하거나 자기 평가·사용 점검을 할 때예요. (README, https://claude.com/plugins/receipts)

### 4.6 데이터 처리 (README·SKILL.md·스크립트)

- 읽는 것
  - `~/.claude/projects/**/*.jsonl` 전체를 다시 훑어요(서브 에이전트 기록 포함, 수정 시각으로 먼저 거름). 모델이 `.jsonl`을 직접 읽지 않게 막아요.
  - 기록 속 `cwd`와 Read·Edit·Write 도구의 파일 경로로 프로젝트를 정하고, `git -C <dir> rev-parse --show-toplevel`로 저장소를 찾아요.
  - 저장소마다 `user.email`을 읽고, Claude가 손댄 파일 경로로 거른 `git log`에서 작성자 이메일이 같고 커미터 날짜가 기간 안인 커밋만 세요. 이름은 `git config --global user.name`.
  - 세션이 닿지 않은 저장소의 git log는 보지 않아요. (스크립트 `gitCommitsWithOurWork`, `byRepo`)
- 외부 전송: 스크립트에는 네트워크 호출이 없어요. 모델에는 git 이름, 집계 수, 프로젝트별 통계, 프로젝트 이름만 가요. 코드·대화 내용·도구·MCP 서버 이름은 안 보내고, 이메일은 로컬에서만 써요. (README, SKILL.md)
- 비밀 가리기: 없어요. 대화나 명령을 저장하지 않고 수만 세는 방식이에요. 프로젝트 이름은 그대로 들어가서, 공유하기 전에 어떤 이름이 들어 있는지 사용자에게 읽어 줘요. HTML 이스케이프와 CSV 수식 방지만 해요. (README, 스크립트 `escapeHtml`, `csvCell`)
- 보관: `cleanupPeriodDays`나 지워진 세션을 다루는 코드는 없어요. 지금 남아 있는 `.jsonl`만 읽어요. (스크립트)
- 결과 파일 권한: HTML을 `0600`으로, 기존 파일·심볼릭 링크는 덮어쓰지 않게 써요. (스크립트)

### 4.7 인기·활동 신호 (2026-10-21)

- claude.com 설치 195 (https://claude.com/plugins/receipts)
- 플러그인 전용 저장소가 없어서 별 수는 마켓 저장소 전체 숫자만 있어요: `anthropics/claude-plugins-official` 별 43.5k (https://github.com/anthropics/claude-plugins-official)
- receipts 경로 커밋: 2026-07-17 추가 → 2026-07-21 README 예시 → 2026-10-08 "query all clones when cross-referencing commits" 등 2건(가장 최근). 버전 번호는 마켓 항목에 없어요. (https://github.com/anthropics/claude-plugins-official/commits/main/plugins/receipts)

## 5. `docs/RESEARCH.md`(2026-10-19)와 달라진 점

"기록 뒤 바뀜"은 10/19 이후에 생긴 변화, "기록과 다름"은 10/19 전부터 그랬지만 RESEARCH.md에 다르게 또는 빠져 적힌 것이에요.

| # | 대상 | RESEARCH.md 기록 | 지금 확인한 내용 | 성격 |
|---|---|---|---|---|
| 1 | SpecStory | 세션 뷰어 묶음(claude-code-log, claude-code-transcripts, SpecStory, cc2md) → "비밀 가리기 없음" | SpecStory CLI는 저장할 때 Betterleaks로 비밀 값을 **기본으로 가려요**. Cloud로 올리는 데이터에도 적용돼요(v2.4.0, 7월 20일). | 기록과 다름 |
| 2 | SpecStory | "세션을 HTML·마크다운으로" | 저장·내보내기 외에 프로젝트·에이전트를 넘나드는 `search`, 다른 에이전트로 `resume`, Cloud 검색·공유·API, 유료 Pro·Team 요금제가 있어요. 날짜별 정리·git 연동은 여전히 문서에 없어요. | 기록과 다름(빠진 기능) |
| 3 | SpecStory | 버전·숫자 기록 없음 | v2.16.0(2026-10-18), 별 1.4k, 자체 집계 설치 232,326 | 참고 |
| 4 | Entire | 세션+git 묶음에서 "커밋 단위" | 커밋 단위 체크포인트 외에 **기간 요약 명령**이 있어요: `recap`(기본 오늘), `dispatch`(기본 7일, 클라우드 모드 저장소 5개까지, 로컬 모드는 에이전트 CLI로 글 생성), `activity`(entire.io, 지난 한 달). 지난 30일 Claude Code 기록 `import`도 돼요. recap은 2026-05-11 블로그에 이미 나와요. | 기록과 다름(빠진 기능) |
| 5 | Entire | 비밀 가리기 묶음 → "올리기·넘기기 전에 키·토큰 가리기" | 체크포인트를 **로컬 git에 쓰기 전에** 9겹으로 가려요. PII(이메일·전화) 선택, 사용자 규칙(2026-05 발표) 있어요. 원본 세션 파일·shadow branch·진단 로그는 가리지 않아요. | 기록과 다름 |
| 6 | Entire | 버전 기록 없음 | 안정판 v0.11.6이 2026-10-20에 나왔어요(10/19 뒤). Grok 연동은 2026-10-16. | 기록 뒤 바뀜(새 릴리스) |
| 7 | receipts | "Anthropic 공식" | 맞아요. 마켓 작성자 Anthropic, `/plugins`(Anthropic 내부 개발), claude.com "Anthropic verified". | 같음(확인) |
| 8 | receipts | "기간 집계만" | 맞아요. 하루별 출력 없음, 활동일은 수로만. 더 확인한 것: git log는 Claude가 손댄 파일 경로로만 거르고, 세션이 닿지 않은 저장소는 안 보며, 비밀 가리기는 없고, PR 수는 `gh pr create` 명령 수예요. | 같음(세부 추가) |
| 9 | receipts | 변경 기록 없음 | 가장 최근 커밋이 2026-10-08이라 10/19 이후 바뀐 것은 없어요. | 바뀐 것 없음 |

- 참고로 `docs/PRD.md` 2장의 두 문장도 위 1·4·5번과 내용이 달라요: "세션 뷰어(… SpecStory …)는 … 비밀 가리기가 없어요", "세션과 커밋을 함께 보는 도구도 … 커밋 단위만(Entire) 다뤄요", "비밀 가리기(Entire, Confab 등)는 기록을 올리거나 넘기기 직전 단계에만 있고". 이 문서는 PRD를 고치지 않아요.

## 6. 확인 못 한 항목

| 대상 | 항목 | 이유 |
|---|---|---|
| SpecStory | Cloud Pro·Team 공식 가격 | 공식 가격 페이지가 없거나(404) 내용이 비어 있어요. [비공식] aisotools만 $25/월·$300/월로 적어요. |
| SpecStory | v2.4.0(비밀 가리기 기본화) 출시 연도 | 릴리스 페이지에 "20 Jul"만 나와요. |
| SpecStory | 마크다운 파일 이름 규칙 | CLI 문서에 없어요. |
| SpecStory | 팀 협업 기능이 지금 있는지 | README는 "Cloud for Teams", 문서 검색 결과는 "로드맵"이라 엇갈려요. |
| SpecStory | 법인 이름·설립 연도·본사 | about 페이지에 없어요. |
| Entire | entire.io 요금(무료 여부, 요금제) | 요금 페이지 404, 다른 공식 페이지에 언급 없어요. |
| Entire | 익명 통계 기본값(켜짐/꺼짐) | 문서에 기본값이 `null`로만 적혀 있어요. |
| Entire | `recap`이 로그인·서버 분석·LLM을 쓰는지, 여러 저장소를 보는지 | 명령 문서에 없어요. 안내 글에 "hosted analysis"만 나와요. |
| Entire | `dispatch` 클라우드 모드가 요약을 어떻게 만드는지 | 문서에 없어요. |
| Entire | `import`로 가져온 기록에 가리기가 적용되는지 | 문서에 없어요. |
| Entire | 다운로드·설치 수 | 공식 숫자를 찾지 못했어요. |
| receipts | Windows에서 동작하는지 | 문서에 OS 언급이 없어요(HTML을 `/tmp`에 먼저 써요). |
| receipts | 버전 번호, 플러그인만의 별 수 | 마켓 항목에 버전이 없고, 전용 저장소가 없어요. |

## 7. 출처 모음

- SpecStory: https://specstory.com , https://specstory.com/specstory , https://specstory.com/about , https://docs.specstory.com , https://docs.specstory.com/integrations/claude-code , https://docs.specstory.com/integrations/terminal-coding-agents , https://docs.specstory.com/integrations/terminal-coding-agents/usage , https://docs.specstory.com/privacy , https://docs.specstory.com/cloud/overview , https://docs.specstory.com/cloud/sync-and-store , https://docs.specstory.com/cloud/analytics , https://docs.specstory.com/skills , https://github.com/specstoryai/getspecstory , https://github.com/specstoryai/getspecstory/releases , https://github.com/specstoryai , [비공식] https://aisotools.com/pricing/specstory
- Entire: https://entire.io , https://entire.io/about , https://entire.io/blog , https://entire.io/blog/hello-entire-world.md , https://docs.entire.io/installation.md , https://docs.entire.io/agents/claude-code.md , https://docs.entire.io/security.md , https://docs.entire.io/guides/configuration/privacy-and-redaction.md , https://docs.entire.io/cli-reference/recap.md , https://docs.entire.io/cli-reference/activity.md , https://docs.entire.io/guides/dispatches/overview.md , https://docs.entire.io/guides/dispatches/dispatches-in-cli.md , https://docs.entire.io/guides/sessions/import-past-agent-history.md , https://docs.entire.io/platforms/cli-and-entire-io.md , https://github.com/entireio/cli , https://github.com/entireio/cli/releases
- receipts: https://github.com/anthropics/claude-plugins-official , https://github.com/anthropics/claude-plugins-official/tree/main/plugins/receipts , https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/receipts/skills/receipts/SKILL.md , https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/receipts/skills/receipts/scripts/mine-transcripts.mjs , https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/receipts/LICENSE , https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json , https://github.com/anthropics/claude-plugins-official/commits/main/plugins/receipts , https://claude.com/plugins/receipts
