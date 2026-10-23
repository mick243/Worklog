# cc-worklog

[한국어](#한국어) · [English](#english)

---

## 한국어

Claude Code 세션 기록과 여러 저장소의 `git log`를 합쳐, 비밀 값을 가린 날짜별 작업일지를 **내 컴퓨터 안에서** 만들어 주는 CLI예요. 기본 동작은 AI도 네트워크도 쓰지 않아요(켤 때만 쓰는 AI 요약은 아래 "AI 요약").

### 빠른 시작

아직 npm에 내지 않아서 소스(`app` 폴더)에서 설치해요. 자세한 것은 아래 "설치"를 보세요.

```bash
npm install          # app 폴더에서
npm run build
npm link             # cc-worklog 명령을 만들어요
cc-worklog           # 보관하고 일지를 만들어요. 첫 실행은 지난 날짜도 모두 만들어요
cc-worklog view      # 브라우저에서 날짜 목록이 열려요
```

세션 없이 커밋만 한 저장소도 넣으려면 그 저장소가 든 폴더를 `config.json`의 `roots`(또는 `--root`)에 적으세요(아래 "설정과 내 패턴"). 일지를 남과 나누기 전에는 `cc-worklog check`로 검사하고, 경로 속 사용자 이름·이메일까지 가리려면 `--hide-identity`를 붙여 만드세요.

### 하는 일

- **날짜·프로젝트별 작업일지**: 하루 단위로 프로젝트마다 세션(제목, 첫·마지막 요청, 시작~끝 시각, 사용 시간, 추가·삭제 줄 수)과 그 저장소의 실제 커밋(작성 시각, 브랜치, 메시지 첫 줄)을 시간순으로 묶어 날짜마다 마크다운 파일 하나로 저장해요. 하위 폴더·워크트리(이미 지운 워크트리 포함)도 원래 저장소로 묶어요.
- **읽는 즉시 비밀 값 가리기 + 검사**: 기록을 읽는 단계에서, 어디에든 쓰기 전에 알려진 형식의 키·토큰 등을 `[가림:종류]`로 바꾸고, 검사 명령으로 결과물에 남은 의심 문자열을 세요. 나중에 더한 내 패턴은 다시 가리기로 이미 보관한 줄과 일지에도 적용해요.
- **자동 삭제 전 보관**: Claude Code가 30일(기본) 뒤 지우는 세션 기록을, 지워지기 전에 가린 상태로 옮겨 둬서 원본이 지워진 뒤에도 같은 일지를 만들 수 있어요.
- **읽기 전용 로컬 화면**: 날짜 목록과 하루 일지를 이 컴퓨터의 브라우저에서만 봐요.

### 설치

Node.js 22 이상이 필요해요. git이 있으면 커밋도 함께 담아요(없으면 세션만으로 만들어요).

지금은 소스에서 빌드해 써요. 이 저장소의 `app` 폴더에서:

```bash
npm install
npm run build
npm link        # 전역에 cc-worklog 명령을 만들어요 (지울 때: npm uninstall -g cc-worklog)
```

`npm link`를 쓰지 않으려면 `cc-worklog` 자리에 `node <app 폴더>/dist/src/cli.js`를 쓰면 돼요(예: `node dist/src/cli.js --help`). 실행 요약·검사가 보여 주는 `cc-worklog …` 명령도 그렇게 바꿔 실행하세요.

npm에 낸 뒤에는 이렇게 설치해요(아직은 안 돼요):

```bash
npm install -g cc-worklog
```

### 명령

| 명령 | 하는 일 |
|---|---|
| `cc-worklog` (또는 `cc-worklog make`) | 모든 세션을 먼저 보관하고 일지를 만들어요. 날짜 옵션이 없으면 오늘 일지와 함께, 재료(세션, `roots` 저장소의 커밋)는 있는데 일지가 없는 지난 날짜와 그날이 끝나기 전에 만든 지난 일지를 모두 만들어요. 보관본의 가장 이른 세션 날짜부터 찾아서 첫 실행은 길어질 수 있어요. |
| `cc-worklog --date <날짜>` | 그날 하나만 만들어요(이미 있으면 다시 만들어요). 날짜는 `YYYY-MM-DD`, `today`, `yesterday`예요. |
| `cc-worklog --from <날짜> [--to <날짜>]` | 기간 안에서 재료가 있는 날짜를 모두 (이미 있어도) 다시 만들어요. `--to`를 빼면 오늘까지예요. `--date`와 함께 쓸 수 없어요. |
| `cc-worklog archive` | 보관만 해요. |
| `cc-worklog check` | 가리기 검사. 패턴을 시험하고, 결과물(일지·보관본·보관 색인, 요약을 켰으면 요약 저장 파일)을 지금 규칙으로 다시 훑어요. 통과하면 종료 코드 0, 실패하면 1이에요. 이름·이메일 가리기를 끈 일지에 남은 사용자 이름·이메일은 수만 `[알림]`으로 알리고 판정에는 넣지 않아요. 남은 이름·이메일의 수는 공유할 일지 마크다운에서 찾은 자리예요(화면용 데이터에만 남은 종류는 1건으로 세요). |
| `cc-worklog redact [--yes]` | 다시 가리기. 지금 규칙(내장 규칙 + 내 패턴)으로 보관본과 이미 만든 일지를 다시 가려요. 바뀔 자리 수를 먼저 보여 주고 `y`·`yes`·`예`·`네`를 입력해야 다시 써요. `--yes`면 묻지 않아요. |
| `cc-worklog view [--port 4848]` | 읽기 전용 로컬 화면을 `127.0.0.1`에 열어요. Ctrl+C로 꺼요. |

옵션: `--root <폴더>`(이 폴더 아래 저장소는 세션이 없던 날의 커밋도 넣어요, 여러 번 쓸 수 있어요), `--day-start <시>`(하루 경계, 기본 3), `--hide-identity`(일지에서 경로 속 사용자 이름과 이메일도 가려요), `--summary`(일지에 세션마다 AI가 쓴 작업 내용 한 줄을 더해요. 가린 대화 글을 Claude Code로 보내요, 아래 "AI 요약"), `--claude-dir <폴더>`(기본 `CLAUDE_CONFIG_DIR` 또는 `~/.claude`), `--data-dir <폴더>`(기본 `CC_WORKLOG_HOME` 또는 `~/.cc-worklog`). 자세한 것은 `cc-worklog --help`예요.

손으로 고친 일지 마크다운(메모를 더한 것 등)은 어느 일지 만들기도 덮어쓰지 않고 건너뛴 뒤 실행 요약에 날짜를 알려요. 메모를 다른 곳에 옮긴 뒤 그 `.md` 파일을 옮기거나 지우고 다시 실행하면 새로 만들어져요. 날짜 옵션 없는 실행은 `--hide-identity`로 만든 일지를 이름·이메일을 가린 채로 다시 만들어요.

### 용어

- **가림** — 비밀 값(API 키·토큰·비밀번호 등)을 `[가림:종류]` 표시로 바꾼 자리예요. 원문은 일지·보관본·화면 어디에도 남기지 않아요. 실행 요약의 `가림`, 검사의 `가린 자리`가 이 수예요.
- **보관본** — Claude Code는 세션 기록을 30일(기본) 뒤 지워요. cc-worklog는 그 전에 대화 글과 일지 재료만 골라 비밀 값을 가린 뒤 데이터 폴더(`~/.cc-worklog/archive`)에 옮겨 둬요. 이 사본이 보관본이고, 일지는 보관본으로 만들어요. 화면의 `보관본만 남음`은 원본이 지워지고 이 사본만 남았다는 뜻이에요.
- **다시 가리기** — 사용자 패턴을 나중에 더해도 이미 보관한 값에는 닿지 않아요. `cc-worklog redact`가 지금 규칙으로 보관본과 이미 만든 일지를 다시 훑어 가려요. 되돌릴 수 없어서 바뀔 자리 수를 먼저 보여 주고 확인받아요.
- **하루 경계** — 하루가 바뀌는 시각이에요. 기본은 새벽 3시라 새벽 2시에 한 일은 전날 일지에 들어가요. `--day-start`나 `config.json`의 `dayStartHour`로 바꿔요.

### 설정과 내 패턴

`<데이터 폴더>/config.json` (없어도 돼요, CLI 옵션이 앞서요). 자주 쓰는 `--root`는 여기 `roots`에 두면 옵션을 잊어도 같은 일지가 나와요. `roots`를 더한 뒤 이미 만든 지난 일지에도 넣으려면 `cc-worklog --from <날짜>`로 다시 만드세요.

```json
{ "roots": ["C:/work"], "rootDepth": 4, "dayStartHour": 3, "hideIdentity": false, "summary": false }
```

`<데이터 폴더>/patterns.json` (없어도 돼요). `samples`는 검사 명령이 이 패턴을 시험할 때 써요:

```json
[{ "name": "사내 토큰", "pattern": "CORP-[0-9]{8}", "flags": "i", "samples": ["CORP-12345678"] }]
```

패턴을 더한 뒤에는 `cc-worklog redact`로 이미 보관한 줄과 이미 만든 일지에도 적용하고, `cc-worklog check`로 확인하세요. 일지 만들기·보관은 다시 가리기를 자동으로 하지 않아요.

### AI 요약 (선택, 기본은 꺼짐)

기본 동작은 AI도 네트워크도 쓰지 않아요. 요약을 켜면 일지의 세션마다 그날 작업 내용을 AI가 1~2문장으로 쓴 한 줄이 `작업 내용(AI 요약)`이라는 표시와 함께 더해져요. 일지 머리에는 `AI 요약: 켜짐 (세션 N개 중 M개 요약)` 줄이 생겨요. 요약을 끈 일지는 지금 모양 그대로예요.

켜는 법은 둘이에요. 한 번만 쓰려면 `--summary`, 늘 쓰려면 `config.json`에 `"summary": true`예요. 일지 만들기(`cc-worklog`, `cc-worklog make`)에서만 받고, 다른 명령에 `--summary`를 주면 사용법 오류로 멈춰요.

    cc-worklog --summary

**무엇을 보내나요**

- 보내는 것: 가린 보관본에서 꺼낸 그 세션의 그날 제목·요청 글·답변 글이에요. 보내기 직전에 일지와 같은 지금 규칙(내장 규칙 + 내 패턴)으로 한 번 더 가려요. 한 세션에 약 2만 자(20,000자)까지이고, 넘으면 요청 글을 먼저 남기고 답변은 최근 것부터 채워요.
- 보내지 않는 것: 가리기 전 원문, 도구 출력·첨부·그림·생각 과정, 도구 호출 입력(명령·파일 경로·검색어), 서브 에이전트 대화, 커밋 메시지·브랜치·저장소 경로, 사용 시간·줄 수, 다른 날짜와 다른 세션의 글.
- 이름·이메일 가리기(`--hide-identity`)는 보내는 글에는 쓰지 않아요. 그 세션에서 Claude Code가 이미 Anthropic으로 보냈던 대화 글이라서예요. 받은 요약에는 써서, 켠 일지에는 이름·이메일이 남지 않아요.

**어디로 보내나요**

cc-worklog는 직접 네트워크를 쓰지 않고 API 키를 받거나 읽지 않아요. 내 컴퓨터에 설치·로그인한 Claude Code를 `claude -p`(대화 없이 한 번 묻고 답 받기)로 실행하고, Claude Code가 지금 로그인 그대로 Anthropic으로 보내요. 모델은 Haiku로 정해져 있어요. 이 호출은 도구(파일 읽기·명령 실행·웹 검색 등)를 하나도 쓰지 못하고, 내 MCP 서버·훅·플러그인·설정·CLAUDE.md가 끼어들지 않으며, 새 세션 기록을 남기지 않아요. 재료는 명령줄이 아니라 표준 입력으로 넘겨요.

**사용량**

요약은 내 Claude Code 사용량을 써요. 구독으로 로그인했으면 구독 사용 한도에, Claude Code에 API 키를 설정했으면 그 키의 API 요금에 들어가요. 실행마다 `claude`는 50번까지(세션 하나·날짜 하나에 한 번) 부르고, 그날 줄이 늘지 않은 세션은 저장해 둔 요약을 다시 써서 부르지 않아요. 요약을 켜 둔 동안은 실행 요약의 `보냄` 칸이 이번에 보낸 세션 수를 알려 줘요. 요약에 실패했어도 글이 이미 건너갔을 수 있는 세션(시간 초과, 사용량 제한, 로그인이 거절됨 등)은 보낸 것으로 세요.

**처음 켰을 때**

실행마다 50번까지 최근 날짜의 세션부터 불러요. 처음 쓰는 날처럼 만들 일지가 많으면 지난 날짜는 여러 번의 실행에 걸쳐 채워지고, 실행 요약의 `AI 요약` 칸이 요약이 빈 채 남은 세션 수를 알려 줘요. 요약을 켜고 다시 실행하면 이어서 채워요. 요약을 켜기 전에 이미 만든 지난 일지는 날짜 옵션 없는 실행이 다시 만들지 않으니, 거기에도 넣으려면 `cc-worklog --from <날짜> --summary`로 다시 만드세요(이것도 실행마다 50번까지예요). 이름·이메일 가리기를 켜고 만든 일지면 `--hide-identity`도 붙이세요.

**먼저 확인할 것: 회사·조직 정책**

요약을 켜면 세션의 대화 글(가린 뒤)을 외부 AI 요약에 한 번 더 보내요. 회사나 조직의 정책이 업무 대화 글을 외부 AI 서비스에 다시 보내는 것을 허락하는지 먼저 확인하세요. 비밀 값은 정해진 규칙으로 가리지만, 형식 없는 비밀이나 회사 고유의 이름·코드명은 가려지지 않을 수 있어요. 필요하면 내 패턴을 먼저 더하세요.

**요약하지 못했을 때**

`claude`를 찾지 못했거나, 로그인하지 않았거나, 60초 안에 답이 없거나, 사용량 제한에 걸리면 그 세션의 요약 줄만 빠지고 일지는 그대로 만들어져요. 종료 코드도 바뀌지 않아요. 실행 요약의 `[알림]`이 이유마다 할 일을 알려 주고, 나중에 요약을 켜고 다시 실행하면 빠진 세션만 다시 불러요. 요약을 부르는 중 Ctrl+C를 누르면 받은 요약은 저장해 두고 멈추는데, 그 실행은 일지를 하나도 만들지 않아요(종료 코드 1). 요약을 켜고 다시 실행하면 빠진 세션만 이어서 불러 일지를 만들어요.

**끄고 지우기**

1. `config.json`에서 `"summary"`를 지우거나 `false`로 바꿔요(`--summary`만 썼다면 이제 붙이지 않으면 돼요).
2. 요약 줄이 든 일지를 요약 없이 다시 만들어요: `cc-worklog --from <요약을 처음 켠 날짜>`. 날짜 옵션 없는 실행은 요약을 켜고 만든 일지를 요약 일지로 남겨서(저장해 둔 요약만 쓰고 `claude`는 부르지 않아요), 이 단계를 해야 요약 줄이 빠져요. 손으로 고친 일지는 덮어쓰지 않아요.
3. 데이터 폴더의 요약 저장 파일(`<데이터 폴더>/summaries/`, 날짜마다 `YYYY-MM-DD.json`)을 지워요. 지워도 일지는 그대로예요. 지우지 않으면 나중에 다시 켰을 때 저장해 둔 요약이 돌아와요.

**한계**

- 요약은 가린 글로만 쓰여서, 요약에 새로 들어갈 수 있는 비밀 값은 보관본에 이미 남아 있던(규칙이 놓친) 값뿐이에요. 다만 AI가 그런 값을 다른 모양으로 바꿔 쓰면 규칙이 찾지 못할 수 있어요. 받은 요약도 같은 규칙(켰으면 이름·이메일 가리기도)으로 가리고, `cc-worklog check`가 일지의 요약 줄과 요약 저장 파일까지 검사해요.
- AI가 쓴 글이라 틀리거나 빠뜨릴 수 있어요. 일지의 요청 글·커밋과 함께 보세요. 같은 세션을 다시 부르면 다른 글이 나올 수 있어요(그날 줄이 늘지 않으면 저장해 둔 요약을 다시 써요).
- 다시 가리기(`cc-worklog redact`)는 요약 저장 파일도 보관본과 같은 규칙으로 다시 가려요.

**다른 도구와 다른 점**

receipts는 기간 집계(JSON)만 모델로 보내요. cc-worklog는 요약을 켜면 가린 대화 글을 보내서 그보다 많이 보내요. 대신 기본(꺼짐)은 아무것도 보내지 않아요. 요약하는 방식은 Entire처럼 에이전트 CLI(여기서는 내 Claude Code)를 거치는 방식이에요.

### 데이터 폴더

읽는 곳은 `~/.claude/projects/**/*.jsonl`(서브 에이전트 기록 포함)과 로컬 git 저장소뿐이고, 둘 다 읽기만 해요. 쓰는 곳은 데이터 폴더(기본 `~/.cc-worklog`) 한 곳이에요.

```
~/.cc-worklog/
  config.json, patterns.json        내가 만드는 파일 (없어도 돼요)
  archive/index.json                보관 색인: 파일마다 어디까지 보관했는지, 원본이 남았는지, 삭제 예상일,
                                    마지막 실행에서 보관에 실패했는지 (원문 없음)
  archive/projects/**/*.jsonl       가린 보관본 (대화 글, 일지 재료 줄, pr-link 줄만)
  worklogs/YYYY-MM-DD.md            일지 마크다운
  worklogs/YYYY-MM-DD.json          같은 내용의 화면용 일지 데이터 (손으로 고쳤는지 알아보는 해시 포함, 원문 없음)
  summaries/YYYY-MM-DD.json         요약을 켰을 때만: 날짜마다 세션의 가린 AI 요약과 재료 표지(줄 수·시각, 원문 없음)
```

### 드문 경우

- **다시 가리기는 되돌릴 수 없어요.** 원본이 지워진 보관본은 확인 화면에 `원본 없음`으로 표시돼요. 입력이나 출력이 터미널이 아니면(파이프·CI 등) `--yes` 없이는 다시 쓰지 않고 종료 코드 1로 끝나요. 바뀔 자리가 없으면 묻지 않고 종료 코드 0이에요.
- **다른 프로그램이 잡은 파일**: 편집기·동기화 도구·백신 등이 보관본·일지 파일을 잡고 있거나 권한이 없으면, 다시 가리기는 아무 파일도 바꾸지 않고 그 파일 위치와 원인 코드를 `[실패]`로 알린 뒤 종료 코드 1로 끝나요. 그 프로그램을 닫고 다시 실행하세요. 같은 날짜의 일지 마크다운과 화면용 데이터는 늘 함께 바뀌어요.
- **검사가 읽지 못한 파일**은 남은 의심으로 세서 실패로 끝나지만 `읽지 못함 (EBUSY)`처럼 따로 보여 줘요. 읽지 못한 파일 하나는 한 건이고, 읽다 중간에 멈춘 파일에서 앞서 찾은 것은 세지 않아요(다시 검사하면 다시 나와요).
- **다시 만드는 명령**: 이전 판에서 생긴, 화면용 데이터만 가려진 일지는 다시 가리기와 검사가 그 날짜를 다시 만드는 `cc-worklog --date <날짜> …` 명령을 알려 줘요. 명령에는 그 일지를 만든 설정(이름·이메일 가리기, AI 요약, 하루 경계)과 이번 실행에 준 `--data-dir`·`--claude-dir`가 붙어요. `--root`와, 일지를 만들 때만 준 `--claude-dir`는 일지에 남지 않아 자동으로 붙지 않으니, 만들 때 줬으면 같은 값을 붙이세요. 그 일지를 손으로 고쳤으면 이 명령도 덮어쓰지 않아요.
- **이름·이메일 가리기를 켠 일지**에 사용자 이름·이메일이 남아 있으면 검사가 실패하고, 날짜마다 `cc-worklog --date <날짜> --hide-identity …` 명령을 알려 줘요. 같은 날짜가 위의 화면용 데이터만 가려진 일지이기도 하면 그 날짜 명령은 한 번만(`--hide-identity`를 붙여) 보여 주고, 그 명령 하나로 둘 다 고쳐져요.
- **명령 속 폴더 경로**는 늘 큰따옴표로 감싸요. 폴더가 `D:\`처럼 `\`로 끝나면 `"D:\\"`로, `\\nas\share\cc-worklog` 같은 UNC 경로면 맨 앞을 `\/`로 바꿔 `"\/nas\share\cc-worklog"`로 보여 줘요(둘 다면 `"\/nas\share\\"`). 그대로 `"D:\"`로 쓰면 Git Bash·명령 프롬프트가 끝 `\"`를 따옴표 글자로 읽고, `"\\nas\…"`는 Git Bash가 `\\`를 `\` 하나로 줄이기 때문이에요. 바꾼 모양은 Git Bash·PowerShell·명령 프롬프트 어디에 붙여 넣어도 원래 폴더로 읽혀요.
- **BOM**: `config.json`·`patterns.json`은 맨 앞에 UTF-8 BOM이 붙어 있어도 읽어요(Windows PowerShell 5.1의 `Out-File -Encoding utf8`, 메모장 등이 붙여요).
- **다시 쓰는 동안의 파일과 잠금**: `cc-worklog redact`가 다시 쓰는 동안에만 `redact-journal.json`과 `*.cc-redact-new` 파일이 잠깐 생기고, 끝나면 사라져요. 중간에 멈추면 다음 실행이 치우고, 기록이 깨진 경우에는 `cc-worklog redact`가 끝까지 마칠 때까지 남아요. 같은 데이터 폴더를 두 실행이 동시에 쓰지 않게 하는 잠금 파일은 OS 임시 폴더에 둬요.
- **AI 요약 호출용 빈 폴더**: 요약을 켠 실행은 `claude`를 OS 임시 폴더의 빈 폴더(`cc-worklog-summary-<데이터 폴더 경로 해시 16자>`)에서 실행하고, 끝나면(Ctrl+C·실패 포함) 지워요. 남아 있으면 다음 일지 만들기가 지워요.
- **설정 파일로만 하는 Claude Code 인증**: 요약 호출은 사용자·프로젝트 설정 파일을 읽지 않아서(`--setting-sources ""`), Claude Code 설정 파일의 `apiKeyHelper`나 `env`로만 인증하고 있으면 "로그인 안 됨"으로 요약하지 못할 수 있어요. 구독 로그인(`claude`로 로그인)이나 환경 변수 `ANTHROPIC_API_KEY`는 그대로 써요.
- **포트**: `view`가 요청한 포트가 쓰이는 중이면 다음 빈 포트로 열고 바뀐 포트를 알려요.
- **잘못된 `--root`·`roots` 경로**(없는 경로, 파일, 저장소가 없는 폴더)는 건너뛰고 일지 만들기 실행 요약에 `[알림]`으로 알려요.
- **Windows PowerShell에서 `npm link`로 만든 명령이 스크립트 실행 정책에 막히면** `cc-worklog.cmd`로 실행하세요.

### 안전 모델

- **내 컴퓨터 안에서만**: 기본 동작에서 네트워크 요청은 0건이에요. 계정·API 키·외부 서비스가 필요 없어요. 기본 요약(제목·첫·마지막 요청)은 규칙 기반이에요. AI 요약을 켰을 때만 내 Claude Code를 실행해 가린 대화 글을 보내요(아래 "AI 요약").
- **원본은 읽기만**: 세션 기록 원본과 git 저장소의 내용·수정 시각을 바꾸지 않아요. git은 `log`·`config` 같은 읽기 명령만 써요.
- **쓰기 전에 가리기**: 가리기 전 원문은 임시 파일·로그·오류 메시지를 포함해 어디에도 쓰지 않아요. 보관본에는 도구 출력 본문·첨부·생각 과정·그림을 넣지 않아요. 원문에 `[가림:…]` 글자가 그대로 들어 있으면 `［가림:…]`(전각 대괄호)으로 바꿔 남겨서 도구가 가린 자리와 섞이지 않게 해요.
- **스크립트 없는 화면**: 로컬 화면은 서버가 HTML을 통째로 만들고, 페이지에 스크립트를 하나도 넣지 않아요(`Content-Security-Policy: default-src 'none'`). 세션 요청 글은 글자로만 보여요. `127.0.0.1`에만 열고, 다른 주소로 위장한 요청은 막아요. 그래서 서버가 꺼지면 브라우저 기본 오류 화면이 떠요.
- **되돌릴 수 없는 변경은 확인부터**: 다시 가리기는 바뀔 자리 수를 먼저 보여 주고 확인받아요. 옛 내용 백업은 남기지 않아요(백업에는 놓친 비밀이 그대로 남기 때문이에요). 중간에 멈춰도 다음 실행(`cc-worklog`·`archive`·`redact`)이 되돌리거나 마저 끝내서 일부만 바뀐 채 남지 않아요. 파일을 바꾸기 시작한 뒤에 멈췄다면 마저 끝낼 때까지 `check`와 화면이 일부만 바뀌었을 수 있다고 알려 줘요. 다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없을 때는 `cc-worklog redact`를 다시 실행하세요. 지금 규칙으로 전체를 다시 가려 맞춰요.

**놓칠 수 있는 것**

- 형식 없는 비밀(문장 속 비밀번호 등)과 한글 이름의 값(`비밀번호: …`)은 찾지 못할 수 있어요. 필요하면 내 패턴을 더하세요.
- 이름·이메일 가리기는 경로 모양 안의 사용자 이름(`C:\Users\이름`, `/home/이름`, `/Users/이름`)과 이메일 주소만 가려요. 문장 속에 따로 나온 이름이나 커밋 메시지 속 실명은 가리지 않아요. 이 옵션은 일지에만 쓰고 보관본에는 쓰지 않아요. 기본(꺼짐)으로 만든 일지는 검사가 통과해도 이름·이메일이 그대로예요.
- `이름=값` 규칙은 안전 쪽으로 넓게 잡아서, 이름에 key·token이 든 평범한 값도 가려질 수 있어요.
- 세션 기록은 문서 없는 내부 형식(기준 버전 2.1.299)이에요. 형식이 바뀌면 모르는 줄을 건너뛰고 그 수를 실행 요약에 알려요. 여러 버전이 섞이는 것은 정상이라, 기준보다 새 버전이 있을 때만 `[알림]`으로 가장 새 버전을 보여 주고, 옛 버전은 "옛 형식 파일 N개"처럼 파일 수만 알려요.
- 보관에 실패한 세션은 실행 요약에 `[경고]`로, 로컬 화면에 "보관 실패"(삭제 예상일까지 8일 이상)·"삭제 임박"(7일 이하)으로 나와요. 일지가 없는 날짜의 실패 세션은 날짜 목록 배너에 한 줄로 나와요. 다시 `cc-worklog archive`를 실행하세요.
- AI 요약을 켰다면, 규칙이 놓친 값을 AI가 다른 모양으로 바꿔 쓴 것은 찾지 못할 수 있어요.

### 기존 도구와 비교

2026-10-19에 각 도구의 README·공식 문서로 확인한 내용이에요.

| 묶음 | 도구 | 하는 일 | cc-worklog와 다른 점 |
|---|---|---|---|
| 세션 보기·내보내기 | claude-code-log (MIT), claude-code-transcripts (Apache-2.0), SpecStory, cc2md | 세션을 HTML·마크다운으로 보여 주거나 내보내요 | 날짜별 일지, git 결합, 비밀 가리기가 없어요 |
| 사용량 | ccusage (MIT) | 일·주·월별 토큰 사용량 | 대화 내용은 다루지 않아요 |
| git 요약 | git-standup (MIT) | 여러 저장소의 커밋을 날짜별로 | 세션 기록은 보지 않아요 |
| AI 일지 | clerk, claude-daily, remember, work-log, daily-log, worklog 등 | 세션을 날짜별로 AI가 요약해요 | 거의 다 대화 내용을 Claude API로 보내고, git log를 보지 않고, 비밀 가리기가 없어요 |
| 세션+git | gadaj, mccm today, receipts, Entire | 세션과 커밋을 함께 봐요 | 현재 폴더만(gadaj), 기록 속 커밋 출력만(mccm today), 기간 집계만(receipts), 커밋 단위만(Entire) 다뤄요 |
| 비밀 가리기 | Entire, Confab, claude-transcript-handoff | 기록을 올리거나 넘기기 전에 키·토큰을 가려요 | 일지 도구에는 없어요 |
| Claude Code 기본 기능 | `/export`, `/recap`, `/insights` | 지금 세션 내보내기, 지금 세션 한 줄 요약, 일하는 방식 분석 | 날짜별 일지는 없어요 |
| AI 요약을 켰을 때 | receipts, Entire | receipts는 기간 집계(JSON)만 모델로 보내요. Entire는 에이전트 CLI로 요약해요 | 기본은 아무것도 보내지 않아요. 켜면 가린 대화 글(그날 제목·요청·답변)을 내 Claude Code로 보내서 receipts보다 많이 보내요. Entire처럼 에이전트 CLI를 거쳐요 |

대화 뷰어, 사용량 집계처럼 이미 잘하는 도구가 있는 기능은 일부러 만들지 않았어요. AI 요약은 기본으로 쓰지 않고, 켤 때만 세션마다 한 줄을 더해요.

### 라이선스

MIT. [LICENSE](LICENSE)를 보세요.

---

## English

A CLI that combines Claude Code session transcripts with the real `git log` of several repositories into a **daily work log with secrets redacted, entirely on your own machine**. No AI and no network by default (an optional AI summary is described in "AI summary"). CLI, viewer, and work-log text are in Korean; only this README is bilingual.

### Quick start

It is not on npm yet, so install it from source (the `app` folder). See "Install" below for details.

```bash
npm install          # in the app folder
npm run build
npm link             # creates the cc-worklog command
cc-worklog           # archives and builds work logs; the first run also fills in past days
cc-worklog view      # opens the date list in your browser
```

To include commits from repositories you never opened a session in, list the folder that contains them in `roots` in `config.json` (or pass `--root`; see "Configuration and custom patterns"). Before sharing a work log, run `cc-worklog check`, and build it with `--hide-identity` to also mask user names in paths and email addresses.

### What it does

- **Daily, per-project work log**: for each day and project, it lists sessions (title, first and last request, start–end time, active time, lines added/removed) alongside that repository's actual commits (author time, branch, first line of the message) in time order, and saves one Markdown file per day. Subfolders and worktrees (even deleted ones) are grouped with their repository.
- **Redaction at read time, plus a checker**: while reading, before anything is written, known key/token formats and similar secrets are replaced with `[가림:<kind>]` markers, and the `check` command counts suspicious strings left in the output. Your own patterns added later can be applied to already-archived lines and work logs with re-redaction.
- **Archive before automatic deletion**: Claude Code deletes transcripts after 30 days by default. cc-worklog copies them, redacted, before that, so the same work log can be rebuilt after the originals are gone.
- **Read-only local viewer**: browse the date list and a day's log in a browser, on this computer only.

### Install

Requires Node.js 22 or later. If git is installed, commits are included (otherwise sessions only).

For now, build from source. In this repository's `app` folder:

```bash
npm install
npm run build
npm link        # creates a global cc-worklog command (remove it with: npm uninstall -g cc-worklog)
```

Without `npm link`, use `node <app folder>/dist/src/cli.js` wherever this README says `cc-worklog` (e.g. `node dist/src/cli.js --help`), including the `cc-worklog …` commands printed by the run summary and `check`.

Once published to npm, it will install like this (not available yet):

```bash
npm install -g cc-worklog
```

### Commands

| Command | What it does |
|---|---|
| `cc-worklog` (or `cc-worklog make`) | Archives all sessions first, then builds work logs. Without a date option it builds today's log plus every past day that has material (sessions, commits in `roots` repositories) but no work log yet, and past logs that were built before their day ended. It starts from the earliest archived session, so the first run can take a while. |
| `cc-worklog --date <date>` | Builds that one day (rebuilds it if it exists). Dates are `YYYY-MM-DD`, `today`, or `yesterday`. |
| `cc-worklog --from <date> [--to <date>]` | Rebuilds every day in the range that has material, even if a log exists. Without `--to`, the range ends today. Cannot be combined with `--date`. |
| `cc-worklog archive` | Archive only. |
| `cc-worklog check` | Redaction check: tests every pattern, then rescans the output (work logs, archives, archive index, and saved summary files if you used the summary) with the current rules. Exit code 0 on pass, 1 on failure. User names and email addresses left in logs built without identity masking are reported as a count in a `[알림]` notice but do not affect the result. Remaining names and emails are counted as places in the Markdown log you would share (a kind left only in the viewer data counts as one). |
| `cc-worklog redact [--yes]` | Re-redaction: applies the current rules (built-in + your patterns) to archives and existing work logs. It first shows how many spots will change and rewrites only after you answer `y`, `yes`, `예`, or `네`. `--yes` skips the question. |
| `cc-worklog view [--port 4848]` | Opens the read-only viewer on `127.0.0.1`. Stop it with Ctrl+C. |

Options: `--root <dir>` (repositories under this folder also contribute commits on days without sessions; repeatable), `--day-start <hour>` (day boundary, default 3), `--hide-identity` (also mask user names in paths and email addresses in work logs), `--summary` (adds one AI-written line per session; sends redacted conversation text through Claude Code, see "AI summary"), `--claude-dir <dir>` (default `CLAUDE_CONFIG_DIR` or `~/.claude`), `--data-dir <dir>` (default `CC_WORKLOG_HOME` or `~/.cc-worklog`). See `cc-worklog --help` for details.

A work-log Markdown file you edited by hand (for example, to add notes) is never overwritten by any build; it is skipped and its date is listed in the run summary. Move your notes elsewhere, then move or delete that `.md` file and run again to rebuild it. A run without a date option keeps identity masking on for logs that were built with `--hide-identity`.

### Terms

- **Redaction (`가림`)** — a spot where a secret value (API key, token, password, …) was replaced with a `[가림:종류]` marker. The original value is never stored in worklogs, the archive, or the local view. `가림` in the run summary and `가린 자리` in `check` count these spots.
- **Archive (`보관본`)** — Claude Code deletes session logs after 30 days by default. Before that, cc-worklog copies the conversation text and worklog material into the data folder (`~/.cc-worklog/archive`) with secrets redacted. Worklogs are built from this archive. `보관본만 남음` in the local view means the original log is gone and only this copy remains.
- **Re-redaction (`다시 가리기`)** — patterns you add later don't reach values that were already archived. `cc-worklog redact` rescans the archive and existing worklogs with the current rules and redacts them. It can't be undone, so it shows how many spots will change and asks first.
- **Day boundary (`하루 경계`)** — the hour a new day starts. The default is 3 a.m., so work done at 2 a.m. goes into the previous day's worklog. Change it with `--day-start` or `dayStartHour` in `config.json`.

### Configuration and custom patterns

`<data dir>/config.json` (optional; CLI options take precedence). Put `--root` folders you always use in `roots` so a forgotten option does not change the log. To add them to past logs you already built, rebuild with `cc-worklog --from <date>`.

```json
{ "roots": ["C:/work"], "rootDepth": 4, "dayStartHour": 3, "hideIdentity": false, "summary": false }
```

`<data dir>/patterns.json` (optional). `samples` are used by `check` to test the pattern:

```json
[{ "name": "corp token", "pattern": "CORP-[0-9]{8}", "flags": "i", "samples": ["CORP-12345678"] }]
```

After adding a pattern, run `cc-worklog redact` to apply it to existing archives and work logs, then `cc-worklog check`. `make` and `archive` never re-redact automatically.

### AI summary (optional, off by default)

By default cc-worklog uses no AI and no network. When you turn the summary on, each session in a work log gets one line, written by AI in one or two sentences, describing what was done that day, marked `작업 내용(AI 요약)` (work done, AI summary). The log header gets an `AI 요약: 켜짐 (세션 N개 중 M개 요약)` line (M of N sessions summarized). Logs built with the summary off look exactly as before.

Turn it on with `--summary` for one run, or `"summary": true` in `config.json` to keep it on. Only the build command (`cc-worklog`, `cc-worklog make`) accepts it; passing `--summary` to any other command is a usage error.

    cc-worklog --summary

**What is sent**

- Sent: that session's title, request text, and reply text for that day, taken from the redacted archive. Right before sending, it is redacted once more with the current rules (built-in rules + your patterns), the same as work logs. Up to about 20,000 characters per session; beyond that, requests are kept first and replies are filled in from the most recent.
- Not sent: unredacted originals, tool output, attachments, images, thinking, tool-call input (commands, file paths, search terms), subagent conversations, commit messages, branches, repository paths, active time and line counts, and text from other days or other sessions.
- Identity masking (`--hide-identity`) is not applied to what is sent, because it is conversation text Claude Code already sent to Anthropic in that session. It is applied to the summary that comes back, so masked logs keep no names or emails.

**Where it goes**

cc-worklog itself makes no network requests and never takes or reads an API key. It runs the Claude Code you installed and signed in to, as `claude -p` (ask once, get one answer, no chat), and Claude Code sends the text to Anthropic with your current sign-in. The model is fixed to Haiku. These calls cannot use any tools (no file reads, commands, or web search), your MCP servers, hooks, plugins, settings, and CLAUDE.md do not take part, and no new session transcript is left behind. The input goes through standard input, not the command line.

**Usage**

Summaries use your Claude Code usage: your subscription's usage limits if you sign in with a subscription, or that key's API charges if Claude Code is set up with an API key. Each run calls `claude` at most 50 times (once per session per day). Sessions with no new lines that day reuse the saved summary and are not called again. While the summary is on, the `보냄` (sent) row of the run summary tells you how many sessions were sent in that run. Sessions whose summary failed but whose text may already have gone out (timeout, usage limit, sign-in rejected, and so on) count as sent.

**The first time you turn it on**

Each run calls at most 50 sessions, most recent days first. When there are many logs to build, such as on your first day, past days fill in over several runs, and the `AI 요약` row of the run summary shows how many sessions are still waiting. Run again with the summary on to continue. A plain run without date options does not rebuild past logs made before you turned the summary on; to add summaries to them, rebuild with `cc-worklog --from <date> --summary` (still at most 50 calls per run). If those logs were built with identity masking on, add `--hide-identity` as well.

**Check first: company or organization policy**

With the summary on, the (redacted) conversation text of your sessions is sent once more to an external AI for summarizing. Check first whether your company's or organization's policy allows sending work conversations to an external AI service again. Secrets are masked by fixed rules, but secrets without a recognizable format and company-specific names or code names may not be. Add your own patterns first if needed.

**When a summary fails**

If `claude` is not found, you are not signed in, there is no answer within 60 seconds, or you hit a usage limit, only that session's summary line is left out; the work log is still built and the exit code does not change. A `[알림]` notice in the run summary tells you what to do for each reason, and running again later with the summary on calls only the missing sessions. If you press Ctrl+C while summaries are being fetched, the summaries received so far are kept, but that run writes no work log at all (exit code 1). Run again with the summary on to call only the missing sessions and build the logs.

**Turning it off and removing summaries**

1. Remove `"summary"` from `config.json` or set it to `false` (if you only used `--summary`, just stop adding it).
2. Rebuild the logs that contain summary lines without the summary: `cc-worklog --from <the day you first turned it on>`. A plain run keeps logs that were built with the summary as summary logs (using saved summaries only, without calling `claude`), so this step is what removes the lines. Logs you edited by hand are not overwritten.
3. Delete the saved summary files in the data folder (`<data dir>/summaries/`, one `YYYY-MM-DD.json` per day). The work logs stay as they are. If you keep them, the saved summaries come back when you turn the summary on again.

**Limits**

- Summaries are written only from redacted text, so the only secrets that can appear in a summary are values the rules already missed in the archive. However, if the AI rewrites such a value in a different shape, the rules may not catch it. Returned summaries are redacted with the same rules (and identity masking when on), and `cc-worklog check` also scans the summary lines in work logs and the saved summary files.
- It is AI-written text, so it can be wrong or leave things out. Read it together with the requests and commits in the log. Calling the same session again may give different text (with no new lines that day, the saved summary is reused).
- Re-redaction (`cc-worklog redact`) re-redacts the saved summary files with the same rules as the archive.

**How it differs from other tools**

receipts sends only period aggregates (JSON) to a model. With the summary on, cc-worklog sends redacted conversation text, which is more than that; with it off (the default), it sends nothing. The way it summarizes, through an agent CLI (here, your own Claude Code), is similar to Entire.

### Data folder

cc-worklog reads only `~/.claude/projects/**/*.jsonl` (including subagent transcripts) and your local git repositories, and never modifies them. It writes to one data folder (default `~/.cc-worklog`).

```
~/.cc-worklog/
  config.json, patterns.json        files you create (optional)
  archive/index.json                archive index: how far each file is archived, whether the original still exists,
                                    expected deletion date, whether archiving failed in the last run (no content)
  archive/projects/**/*.jsonl       redacted archives (conversation text, work-log inputs, and pr-link lines only)
  worklogs/YYYY-MM-DD.md            work log in Markdown
  worklogs/YYYY-MM-DD.json          the same work log as data for the viewer (with a hash to detect hand edits, no content)
  summaries/YYYY-MM-DD.json         only when the summary is used: per day, each session's redacted AI summary and an input marker (line count, time; no content)
```

### Edge cases

- **Re-redaction cannot be undone.** Archives whose original transcript is already gone are marked `원본 없음` (original gone) in the confirmation output. If stdin or stdout is not a terminal (pipes, CI), nothing is rewritten without `--yes` and it exits with code 1. If nothing would change, it exits with code 0 without asking.
- **Files held by another program**: if an editor, a sync tool, or antivirus holds an archive or work-log file, or permissions prevent access, `redact` changes nothing, lists each such file with its error code under `[실패]`, and exits with code 1. Close that program and run it again. The Markdown and viewer data of the same day are always changed together.
- **Files `check` cannot read** count as remaining suspects and fail the check, but are shown separately as `읽지 못함 (EBUSY)` (could not read). Each unreadable file counts once; if reading stops partway through a file, whatever was found earlier in that file is not counted (it shows up again on the next check).
- **Rebuild commands**: a day whose viewer data was redacted but whose Markdown was not (possible with earlier versions) is reported by `redact` and `check` with a `cc-worklog --date <date> …` command that rebuilds it with the settings that day was made with (identity masking, AI summary, day boundary) plus the `--data-dir`/`--claude-dir` given to that run. `--root`, and a `--claude-dir` given only when the log was made, are not stored in the log, so add the same values yourself if you used them. If you edited that log by hand, this command does not overwrite it either.
- **Logs built with identity masking** that still contain a user name or email address fail `check`, which prints a `cc-worklog --date <date> --hide-identity …` command per day. If the same day is also a log whose viewer data alone was redacted, its command is shown only once (with `--hide-identity`), and that one command fixes both.
- **Folder paths in commands** are always double-quoted. A folder ending in `\` such as `D:\` gets one more `\` (`"D:\\"`), and a UNC path such as `\\nas\share\cc-worklog` starts with `\/` instead (`"\/nas\share\cc-worklog"`; both apply to `\\nas\share\` → `"\/nas\share\\"`). Written as-is, `"D:\"` makes Git Bash and Command Prompt read `\"` as a literal quote, and Git Bash turns `"\\nas\…"` into `\nas\…`. The rewritten forms are read back as the original folder in Git Bash, PowerShell, and Command Prompt.
- **BOM**: `config.json` and `patterns.json` are read even if they start with a UTF-8 BOM (as written by Windows PowerShell 5.1's `Out-File -Encoding utf8`, Notepad, and others).
- **Temporary files and locking**: while `cc-worklog redact` is rewriting, `redact-journal.json` and `*.cc-redact-new` files exist briefly and are removed when it finishes. If it stops midway, the next run cleans them up; when the journal is corrupted, it stays until a `cc-worklog redact` run completes. The lock file that keeps two runs from writing the same data folder lives in the OS temp folder.
- **Empty folder for AI summary calls**: with the summary on, `claude` runs in an empty folder in the OS temp folder (`cc-worklog-summary-<16-character hash of the data folder path>`), which is removed when the run ends (including Ctrl+C and failures). If one is left behind, the next build removes it.
- **Claude Code sign-in through settings files only**: summary calls do not read user or project settings files (`--setting-sources ""`), so if Claude Code authenticates only through `apiKeyHelper` or `env` in its settings file, summaries may fail as "not signed in" (`로그인 안 됨`). A subscription sign-in (signing in with `claude`) or the `ANTHROPIC_API_KEY` environment variable works as usual.
- **Port**: if the port requested by `view` is in use, it opens on the next free port and tells you which one.
- **Invalid `--root`/`roots` paths** (missing, a file, or no repository inside) are skipped and reported with a `[알림]` notice in the `make` summary.
- **If Windows PowerShell's execution policy blocks the command created by `npm link`**, run `cc-worklog.cmd` instead.

### Safety model

- **Local only**: Zero network requests in the default behavior. No account, API key, or external service. The default summary (title, first and last request) is rule-based. Only when you turn on the AI summary does it run your Claude Code and send redacted conversation text (see "AI summary").
- **Originals are read-only**: transcript files and git repositories keep their content and modification time. Only read-only git commands (`log`, `config`) are used.
- **Redact before writing**: unredacted text is never written anywhere, including temp files, logs, and error messages. Archives exclude tool output bodies, attachments, thinking, and images. If the original text literally contains `[가림:…]`, it is kept as `［가림:…]` (full-width bracket) so it is never confused with a real redaction.
- **Script-free viewer**: the server renders complete HTML and the pages contain no scripts at all (`Content-Security-Policy: default-src 'none'`), so session text is shown as plain text. It listens on `127.0.0.1` only and rejects requests with a foreign Host header. When the server stops, the browser shows its own error page.
- **Confirm before irreversible changes**: re-redaction shows the number of spots first and asks for confirmation. It keeps no backup of the old content (a backup would still contain the missed secret). If it is interrupted, the next run (`cc-worklog`, `archive`, or `redact`) rolls back or finishes the rewrite, so files are never left half-changed. If it stopped after it began replacing files, `check` and the viewer warn that some files may not be updated yet until a later run finishes the job. If the rewrite journal itself is corrupted, run `cc-worklog redact` again; it re-redacts everything with the current rules.

**What it can miss**

- Secrets without a recognizable format (e.g. a password inside a sentence) and values with non-ASCII names (e.g. `비밀번호: …`). Add your own patterns if needed.
- Identity masking covers only user names inside path shapes (`C:\Users\<name>`, `/home/<name>`, `/Users/<name>`) and email addresses. Names appearing on their own in sentences or real names in commit messages are not masked. This option applies to work logs only, not to archives. Logs built with the default (off) keep names and emails even when `check` passes.
- The `NAME=value` rule is intentionally broad, so ordinary values whose names contain key or token may be masked too.
- Transcripts use an undocumented internal format (baseline version 2.1.299). If it changes, unknown lines are skipped and their count is reported in the run summary. Mixed versions are normal, so a `[알림]` notice appears only when a version newer than the baseline is found (showing the newest one); older versions are reported only as a file count ("옛 형식 파일 N개").
- Sessions that failed to archive appear as `[경고]` in the run summary and as "보관 실패" (archive failed, 8+ days before expected deletion) or "삭제 임박" (deletion imminent, 7 days or less) in the viewer. Failed sessions on dates without a work log get one line in the date-list banner. Run `cc-worklog archive` again.
- If you use the AI summary, a value the rules missed may not be caught when the AI rewrites it in a different shape.

### Comparison with existing tools

Checked against each tool's README and official docs on 2026-10-19.

| Group | Tools | What they do | How cc-worklog differs |
|---|---|---|---|
| Session viewers / exporters | claude-code-log (MIT), claude-code-transcripts (Apache-2.0), SpecStory, cc2md | Show or export sessions as HTML/Markdown | No daily log, no git, no redaction |
| Usage | ccusage (MIT) | Token usage per day/week/month | Does not handle conversation content |
| git summaries | git-standup (MIT) | Commits across repositories by date | Does not read transcripts |
| AI journals | clerk, claude-daily, remember, work-log, daily-log, worklog, and others | AI summaries of sessions per day | Almost all send conversation content to the Claude API, ignore git log, and do not redact |
| Sessions + git | gadaj, mccm today, receipts, Entire | Look at sessions and commits together | Current folder only (gadaj), only commit output inside transcripts (mccm today), period aggregates only (receipts), per-commit only (Entire) |
| Redaction | Entire, Confab, claude-transcript-handoff | Mask keys/tokens before uploading or handing off transcripts | Not part of a work-log tool |
| Claude Code built-ins | `/export`, `/recap`, `/insights` | Export the current session, one-line recap of the current session, work-style report | No daily work log |
| With the AI summary on | receipts, Entire | receipts sends only period aggregates (JSON) to a model. Entire summarizes through an agent CLI | Sends nothing by default. When on, it sends redacted conversation text (that day's title, requests, replies) through your Claude Code, more than receipts does. Like Entire, it goes through an agent CLI |

Features that existing tools already do well (transcript viewing, usage stats) are intentionally left out. The AI summary is off by default and, when on, adds only one line per session.

### License

MIT. See [LICENSE](LICENSE).
