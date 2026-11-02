# clens

[English](README.md)

코딩 에이전트는 세션이 끝나면 거기서 있었던 일을 잊어버립니다. 그래서 지난주에 정한 걸 또 묻고, 안 돼서 접은 방법을 다시 들고 옵니다. clens는 Claude Code와 Codex에서 나눈 대화를 모두 색인해 두고 에이전트가 필요할 때 직접 찾아보게 해 주는 플러그인입니다.

다른 프로젝트에서 한 얘기도 찾고, Claude Code에서 하다가 Codex로 넘어간 작업도 같이 찾습니다. 한국어는 단어 단위로 찾기 때문에 조사나 어미가 달라도 걸립니다. LLM은 부르지 않고 기록은 내 컴퓨터 밖으로 나가지 않습니다.

이렇게 물어보면 됩니다.

```txt
지난번에 retry 로직 왜 뺐지?
```

```txt
이 프로젝트 어디까지 했지? src/app.ts 마지막에 누가 고쳤어?
```

```txt
어제 뭐 했더라?
```

```txt
압축 전에 고친 파일이랑 커밋 알려 줘
```

아직 초기 버전입니다.

## 하는 일

- 모든 프로젝트의 지난 대화에서 논의와 결정을 찾습니다. "지난번에", "전에 해 봤는데" 같은 말이 나오면 시키지 않아도 에이전트가 먼저 찾아보도록 해 뒀습니다.
- 어디까지 했는지 보여 줍니다. 프로젝트나 파일을 하나 고르면 최근 세션마다 마지막 요청과 답, 고친 파일이 나옵니다.
- 기간을 주면 그동안 나눈 대화를 시간 순서대로 보여 줍니다.
- `/compact`로 대화가 압축되면 요약에서 잘 빠지는 것들을 바로 다시 넣어 줍니다. 내가 한 요청, 고친 파일, git 명령, 실패한 호출, 훅에 막힌 호출입니다.
- 에이전트가 실행한 명령이 다시 돌려도 안 되는 이유로 실패하면(명령이 없음, 권한 거부, 호스트를 찾지 못함), 다른 세션에서 같은 실패가 났을 때 에이전트가 그다음에 한 말을 바로 알려 줍니다. 같은 시도를 되풀이하지 않게 하려는 것입니다.
- Claude Code는 기본 설정에서 30일 지난 대화 기록을 지웁니다. clens에 한 번 들어간 세션은 원본이 지워져도 계속 찾을 수 있습니다.
- 어떤 도구와 스킬을 많이 쓰는지, 어떤 파일을 자주 고치는지, 훅이 뭘 막았는지, 컨텍스트를 뭐가 많이 먹는지 숫자로 보여 줍니다.
- 이 프로젝트에서 최근에 한 일을 세션별로 정리합니다(`/clens:recap`).
- Codex에서 하던 일을 Claude Code에서, 또는 그 반대로 이어서 합니다(`/clens:continue`).
- 코드 한 줄이 왜 이렇게 됐는지 알려 줍니다. 그 줄을 써 넣은 세션을 찾아서 그때 한 요청과 내가 받아들인 제안을 보여 줍니다(`/clens:why`).
- 같은 지적을 몇 번이나 했는지 지난 세션에서 확인하고, CLAUDE.md나 AGENTS.md, 스킬에 넣을 문장으로 만들어 줍니다(`/clens:reflect`).

## 설치

Node.js 20 이상이 있어야 합니다.

### Claude Code

```sh
claude plugin marketplace add wonwoo/clens
claude plugin install clens@clens
```

이미 켜 둔 세션에서는 `/plugin marketplace add wonwoo/clens`와 `/plugin install clens@clens`로 설치하고 `/reload-plugins`를 실행하세요.

### Codex

```sh
codex plugin marketplace add wonwoo/clens
codex plugin add clens@clens
```

설치한 다음 Codex에서 `/hooks`를 열고 clens 훅을 신뢰해 주세요. 신뢰하기 전에는 압축 뒤 복구와 실패한 명령 안내가 동작하지 않습니다.

처음 세션을 열면 지난 기록을 백그라운드에서 색인합니다. 기록이 많으면 몇 분 걸리고, 그동안은 색인이 끝난 만큼만 찾을 수 있습니다.

### 한국어·일본어·중국어 검색

한국어, 일본어, 중국어를 단어 단위로 찾으려면 언어별 분석기를 한 번 받아야 합니다(`ko`, `ja`, `zh`). Claude Code에서는 에이전트에게 `clens install ko`를 실행해 달라고 하면 되고, Codex에서는 npm으로 CLI를 설치한 뒤 직접 실행하세요.

```sh
npm i -g @clens/cli
clens install ko
```

받은 다음에는 열려 있는 Claude Code와 Codex 세션을 모두 닫았다가 다시 여세요. 이미 열려 있던 세션은 분석기 없이 계속 색인합니다. 분석기를 받지 않아도 글자로는 찾을 수 있고, 영어는 따로 받을 게 없습니다.

### 업데이트

```sh
claude plugin marketplace update clens && claude plugin update clens@clens
codex plugin marketplace upgrade clens && codex plugin add clens@clens
```

전에 clens를 손으로 설정해 둔 적이 있으면 그 설정은 지워 주세요. `claude mcp add`나 `codex mcp add`로 등록한 서버, 설정 파일에 넣은 압축 훅, 링크해 둔 스킬 같은 것들입니다. 남겨 두면 clens가 두 번씩 돕니다.

## 스킬

`/clens:recap`은 이 프로젝트에서 최근에 한 일을 세션별로 정리합니다. 세션마다 무엇을 했고 어디서 멈췄고 뭐가 남았는지, 그 세션에서 만든 커밋까지 보여 줍니다.

`/clens:continue`는 이 프로젝트의 다른 세션에서 하던 일을 이어서 합니다. 그 세션에서 무엇을 하다 멈췄는지 다시 설명하지 않아도 됩니다. Codex에서 하다가 Claude Code로 옮겨 올 때처럼 도구를 바꿔 가며 일할 때 씁니다.

`/clens:why`는 코드가 왜 이렇게 됐는지 알려 줍니다. 그 줄을 써 넣은 편집을 기록에서 찾기 때문에 커밋을 합치거나 rebase한 뒤에도 찾을 수 있습니다. 그 턴의 요청과 바로 앞에서 내가 받아들인 제안을 읽어서 이유를 답합니다. 편집 기록에 없으면 `git blame`으로 커밋을 찾아 그 커밋을 만든 세션을 봅니다.

`/clens:reflect`는 이번 세션에서 내가 바로잡거나 설명해야 했던 것을 CLAUDE.md, AGENTS.md나 스킬 수정안으로 바꿉니다. 수정안마다 예전 세션에서도 같은 일이 있었는지 찾아서 근거로 붙이고, 내가 고른 것만 반영합니다. 글로 적는 것보다 훅이나 스크립트로 막는 게 나은 건 따로 모아서, 언제 어떤 명령에서 문제가 났는지와 함께 보여 줍니다. `/clens:reflect 2w`나 `/clens:reflect 10주`처럼 기간을 주면(최대 10주) 그동안 이 프로젝트에서 나눈 대화를 모두 봅니다. 결과와 내 결정은 `~/.clens/reflect/`에 남아서 다음에 돌릴 때 참고합니다. 거절한 건 같은 문제가 다시 생기기 전에는 또 올라오지 않습니다. 세션 하나에 10~20분쯤 걸리고, 기간을 주면 더 걸립니다.

`clens:stats`는 직접 부르는 스킬이 아닙니다. "요즘 무슨 스킬 많이 써?", "컨텍스트 뭐가 많이 먹어?" 같은 질문에 에이전트가 답할 때 참고합니다.

Codex에서는 `$clens:recap`처럼 앞에 `$`를 붙여서 부릅니다.

## 동작 방식

clens는 Claude Code가 `~/.claude/projects/`에, Codex가 `~/.codex/sessions/`에 남기는 대화 기록을 읽어서 `~/.clens/index.db`(SQLite)에 색인합니다. 세션이 열려 있는 동안에는 새로 쌓이는 기록도 따라가며 색인합니다. 에이전트는 MCP 도구 다섯 개로 이 색인을 읽습니다.

| 도구 | 하는 일 |
|---|---|
| `clens_search` | 단어로 지난 메시지를 찾습니다 |
| `clens_session` | 세션 하나의 대화를 앞뒤로 읽습니다 |
| `clens_left_off` | 프로젝트나 파일의 최근 세션과 멈춘 곳을 보여 줍니다 |
| `clens_recent` | 기간 안의 메시지를 시간 순서대로 보여 줍니다 |
| `clens_stats` | 도구, 파일, 훅, 컨텍스트 사용량을 셉니다 |

대화가 압축되면 훅(`hooks/compact.mjs`)이 그 세션의 작업 기록을 대화에 다시 넣습니다. 셸 명령이 실패하면 다른 훅(`hooks/tool_failure.mjs`)이 색인에 저장된 실패 기록과 비교합니다. Claude Code에서는 실패했을 때만, Codex에서는 실패 전용 이벤트가 없어서 명령마다 돕니다. 네트워크는 처음 실행할 때 npm 패키지를 설치하거나 언어 분석기를 받을 때만 씁니다.

## 한계

- 뜻이 아니라 단어로 찾습니다. 대화할 때와 다른 표현으로 물으면 못 찾을 수 있는데, 그러면 에이전트가 다른 단어로 다시 찾아봅니다.
- 명령 실행 결과나 읽은 파일 내용 같은 도구 출력은 저장하지 않습니다. 메시지와 도구 호출만 남습니다. 실패한 호출만 출력의 앞 100자와 뒤 200자를 남겨 세션 기록에 보여 주고, 검색 대상에는 넣지 않습니다.
- 4KB가 넘는 어시스턴트 답은 앞뒤 약 2KB씩만 저장합니다. 그래서 가운데에 있는 단어로는 찾을 수 없습니다.
- 스크립트로 바꾼 파일이나 `$VAR`, glob처럼 실행해 봐야 경로가 정해지는 파일은 고친 파일 목록에서 빠질 수 있습니다. 스크립트 안에서 돌린 git 명령도 마찬가지입니다.
- Codex에서는 훅을 신뢰해야 압축 뒤 복구가 동작하고, 서브에이전트가 압축했을 때는 동작하지 않습니다.

## 개발

```sh
git clone https://github.com/wonwoo/clens && cd clens
npm install                    # plugin/ 빌드까지 합니다
node plugin/dist/cli.js index  # ~/.clens/index.db에 첫 색인을 만듭니다
claude --plugin-dir plugin     # 이 세션에서만 저장소의 플러그인을 띄웁니다
npm test && npm run typecheck
```

MCP 서버를 직접 등록할 때는 `clens mcp` 말고 `plugin/dist/server.js`를 등록하세요. `clens mcp`로 등록하면 `/clear`나 `/resume` 뒤에도 `session_id: "current"`가 서버가 처음 뜬 세션을 가리킵니다.

```sh
claude mcp add -s user clens -- node /절대/경로/clens/plugin/dist/server.js
codex mcp add clens -- node /절대/경로/clens/plugin/dist/server.js
```

압축 훅은 `src/hooks/compact.ts`를 빌드한 `plugin/hooks/compact.mjs`이고, 실패한 명령 훅은 `src/hooks/tool_failure.ts`를 빌드한 `plugin/hooks/tool_failure.mjs`입니다. 어떻게 등록하는지는 Claude Code는 `plugin/hooks/hooks.json`, Codex는 `plugin/.codex-plugin/hooks.json`에 있습니다.

CLI 명령은 이렇습니다.

```
clens index [--rebuild]     색인을 만들거나 새로 고칩니다
clens install ko|ja|zh      한국어, 일본어, 중국어 분석기를 받습니다
clens stats [--digest]      색인의 행 수나 테이블마다 SHA-256 digest를 출력합니다
clens mcp                   MCP 서버를 띄웁니다
```

`CLENS_HOME`, `CLENS_CODEX_HOME`, `CLENS_INDEX_DIR`로 `~/.claude`, `~/.codex`, `~/.clens` 위치를 바꿀 수 있습니다. 테스트는 이 셋을 임시 폴더로 돌려 놓고 돌기 때문에 실제 폴더는 건드리지 않습니다. 코드를 고칠 때 지켜야 할 규칙과 불변 조건은 [AGENTS.md](AGENTS.md)에 있습니다.

Claude Code도 Codex도 플러그인을 직접 빌드하지 않고 저장소의 `plugin/`을 그대로 설치합니다. 그래서 `npm run build`가 `src/`를 `plugin/`에 번들로 묶고, 코드를 고치면 빌드 결과도 같이 커밋합니다. 릴리스할 때는 `plugin/.claude-plugin/plugin.json`과 `plugin/.codex-plugin/plugin.json`의 `version`을 올리세요. Claude Code 쪽은 `claude plugin validate plugin`으로 검사할 수 있습니다.

## 라이선스

MIT
