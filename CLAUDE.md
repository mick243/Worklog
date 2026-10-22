# 진행 규칙 (메인 세션용)

이 폴더는 서브 에이전트 4개로 프로젝트 하나를 만드는 틀이다. 메인 세션은 직접 기획·디자인·개발하지 않고, 아래 순서대로 에이전트를 부르고 결과를 사용자에게 전한다.

## 에이전트

| 에이전트 | 정의 파일 | 만드는 것 |
|---|---|---|
| planner (기획) | `.claude/agents/planner.md` | `docs/PRD.md` |
| designer (디자인) | `.claude/agents/designer.md` | `docs/DESIGN.md` |
| developer (개발) | `.claude/agents/developer.md` | `app/`, `docs/DEV.md` |
| integrator (취합) | `.claude/agents/integrator.md` | 디자인 반영된 `app/`, `docs/INTEGRATION.md`, 차이 목록 |

## 순서

### 1단계: 기획

1. planner만 실행한다. 사용자가 준 프로젝트 한 줄 설명과 조건을 그대로 넘긴다.
2. 끝나면 PRD 요약(F1~F3, 화면 목록)과 열린 질문을 사용자에게 보여 주고 멈춘다.
3. 사용자가 고칠 점을 말하면 그 내용을 넘겨 planner를 다시 부른다.
4. 사용자가 승인하면 `docs/PRD.md` 맨 위 상태를 `확정`으로 바꾼다.
5. **PRD가 `확정`이 되기 전에는 designer, developer, integrator를 시작하지 않는다.**

### 2단계: 디자인 + 개발 (동시에)

- designer와 developer를 한 메시지에서 동시에 백그라운드로 실행한다.

### 3단계: 취합 (결과가 나올 때마다)

- designer나 developer 중 하나가 끝날 때마다 integrator를 실행한다.
- 넘길 것: 이번에 끝난 쪽(디자인 / 개발 / 둘 다), developer가 아직 실행 중인지.
- developer가 실행 중이면 integrator는 코드를 고치지 않고 비교만 한다.
- integrator는 한 번에 하나만 돌린다. 도는 중에 다른 결과가 나오면 끝난 뒤 다시 실행한다.
- 둘 다 끝난 뒤의 마지막 취합은 반드시 디자인 반영까지 한다.

### 4단계: 차이 정리

1. integrator가 돌려준 차이 목록을 사용자에게 그대로 보여 준다.
2. 어느 쪽을 고칠지(기획 / 디자인 / 개발)는 사용자가 정한다. 정해지면 해당 에이전트를 다시 부르고 3단계를 반복한다.
3. 기획을 고치면 PRD 상태를 `초안`으로 돌리고 1단계부터 다시 한다.

## 경쟁 서비스 비교 리포트 (따로 요청할 때만)

기획·디자인·개발 흐름과 별개로, 아래 세 에이전트를 순서대로 하나씩 실행한다. 하나가 끝날 때마다 무엇을 했는지 사용자에게 요약한다.

| 에이전트 | 정의 파일 | 만드는 것 |
|---|---|---|
| competitor-researcher (리서치) | `.claude/agents/competitor-researcher.md` | `docs/COMPETITOR_RESEARCH.md` |
| competitor-analyst (분석) | `.claude/agents/competitor-analyst.md` | `docs/COMPETITOR_ANALYSIS.md` |
| report-writer (작성) | `.claude/agents/report-writer.md` | `docs/report-a.md` (한 장짜리 리포트) |

## 고도화 (따로 요청할 때만)

이미 만든 결과물을 다듬는 흐름이다. 각 에이전트가 끝날 때마다 무엇을 했는지 사용자에게 짧게 요약한다.

| 에이전트 | 정의 파일 | 만드는 것 |
|---|---|---|
| reviewer (검토) | `.claude/agents/reviewer.md` | `docs/IMPROVEMENT.md` (영향도·난이도·담당으로 나눈 문제 목록) |
| improve-designer (개선 디자인) | `.claude/agents/improve-designer.md` | `docs/DESIGN.md`의 화면·문구·흐름 개선 |
| improve-developer (개선 개발) | `.claude/agents/improve-developer.md` | `app/`, `docs/DEV.md`의 기능·오류·동작 개선 |
| improve-integrator (개선 취합) | `.claude/agents/improve-integrator.md` | 디자인 반영된 `app/`, `docs/IMPROVEMENT.md` 항목별 해결 체크 |

1. reviewer만 실행한다. 사용자가 받은 피드백이 있으면 그대로 넘긴다. 끝나면 영향도×난이도 표, 항목 목록, 추천 우선순위를 보여 주고 멈춘다.
2. **사용자가 우선순위를 확인하기 전에는 다른 에이전트를 시작하지 않는다.** 사용자가 정하면 메인 세션이 `docs/IMPROVEMENT.md`의 우선순위 칸(번호 또는 `보류`)과 맨 위 상태(`우선순위 확정`)를 고친다. 담당이 "기획"인 항목은 planner로 PRD를 먼저 고치고, PRD가 `확정`이 된 뒤에 다룬다.
3. improve-designer와 improve-developer를 한 메시지에서 동시에 백그라운드로 실행한다. 이번 회차 대상 항목 ID를 넘긴다(디자인은 담당 디자인·둘 다, 개발은 담당 개발·둘 다).
4. 둘 중 하나가 끝날 때마다 improve-integrator를 실행한다. 넘길 것은 대상 항목 ID, 끝난 쪽, 개발이 아직 실행 중인지, 각 에이전트가 돌려준 바꾼 것 목록이다. 개발이 실행 중이면 체크만 하고, 둘 다 끝난 뒤의 마지막 취합은 합치기까지 한다.
5. 미해결 항목은 이유와 다음에 고칠 쪽을 사용자에게 보여 주고, 다시 돌릴지는 사용자가 정한다.

## 공통 규칙

- 에이전트끼리는 문서로만 주고받는다: `PRD.md` → `DESIGN.md` / `app/` + `DEV.md` → `INTEGRATION.md` (고도화: `IMPROVEMENT.md` → `DESIGN.md` / `app/` + `DEV.md` → `IMPROVEMENT.md`)
- 기능은 F1~F3, 화면은 S1~ 번호로 가리킨다.
- `PRD.md`는 planner만, `DESIGN.md`는 designer만 고친다. PRD 상태를 `확정`으로 바꾸는 것만 메인 세션이 한다.
- 서브 에이전트는 사용자에게 직접 묻지 못한다. 모르는 것은 가정하고 "열린 질문"에 남기며, 메인 세션이 그 질문을 사용자에게 전한다.
- git push, 배포, 외부 서비스 가입은 사용자가 따로 요청할 때만 한다.
- 사용자에게 하는 말은 한국어 해요체로 한다.
