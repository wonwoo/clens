# clens

[English](README.md)

clens는 코딩 에이전트가 지난 세션을 기억하게 해 줍니다. Claude Code와 Codex의 대화 기록(transcript)을 내 컴퓨터의 SQLite에 색인해 두고 에이전트에게 거기서 찾아볼 MCP 도구를 줍니다. 그래서 에이전트는 예전에 무엇을 정했고 무엇을 해 봤고 무엇을 고쳤는지 짐작하거나 transcript 파일을 grep하지 않고 바로 찾아봅니다.

아직 초기 버전입니다. npm에는 올리지 않았습니다.

## 기능

- 지난 논의와 결정을 찾아 줍니다. "retry 로직 왜 뺐지?"라고 물으면 에이전트가 모든 프로젝트의 대화를 검색한 뒤 찾은 곳 앞뒤 대화를 읽고 답합니다. 한국어, 일본어, 중국어는 형태소 단위로 맞춰 보므로 글자가 똑같지 않아도 걸립니다.
- 어디까지 했는지 알려 줍니다. 프로젝트나 파일 하나를 기준으로 최근 세션을 보여 줍니다. 세션마다 마지막 요청과 마지막 답, 고친 파일이 함께 나옵니다. 셸 명령(`>`, `tee`, `sed -i`, heredoc이나 `-c`/`-e` 스크립트)으로 고친 파일도 들어갑니다.
- 압축(compaction)한 뒤에 하던 작업을 되찾아 줍니다. `session_id: "current"`로 부르면 지금 대화의 작업 기록이 나옵니다. 요청과 마지막 답, 고친 파일, 상태를 바꾼 git 명령, 실패한 도구 호출, 훅이 막은 호출이 들어 있습니다. 모두 압축 요약에서 빠지기 쉬운 것들입니다. 압축 훅(아래 설치 참고)이 있으면 따로 부르지 않아도 압축 직후에 이 기록이 들어옵니다.
- 작업 습관을 보여 줍니다. 도구, 스킬, 슬래시 명령, 서브에이전트를 각각 얼마나 쓰는지와 어떤 파일을 많이 고쳤는지 셉니다. 어떤 훅이 무엇을 막았는지, 어떤 도구의 출력이 컨텍스트를 채우는지도 봅니다. 압축이 몇 번 일어났고 컨텍스트가 얼마나 불어났는지, 오류가 얼마나 나는지, 시간을 어디에 썼는지도 나옵니다. 세션 하나, 프로젝트 하나, 전체 가운데 골라서 볼 수 있습니다.
- Claude Code가 지운 기록도 남겨 둡니다. Claude Code는 오래된 transcript를 지웁니다. 이미 색인한 세션은 파일이 지워진 뒤에도 계속 찾을 수 있습니다.
- 내 컴퓨터 밖으로 나가지 않습니다. transcript 폴더는 읽기만 하고 쓰는 곳은 `~/.clens/`와 npm 의존성을 설치하는 자기 플러그인 폴더뿐입니다. LLM은 부르지 않습니다. 네트워크는 두 경우에만 씁니다. 플러그인이 처음 뜰 때 npm 의존성을 설치하는 경우와 `clens install ko`가 한국어 형태소 모델을 내려받는 경우입니다.

## 동작 방식

```
~/.claude/projects/**/*.jsonl ─┐
                               ├─ 색인기 ─▶ ~/.clens/index.db (SQLite) ─▶ MCP 서버 ─▶ 에이전트
~/.codex/sessions/**/*.jsonl ──┘
```

`clens index`로 처음 한 번 색인을 만듭니다. 그 뒤로는 MCP 서버가 떠 있는 동안 세션 폴더를 지켜보다가 바뀐 파일만 다시 색인합니다.

에이전트가 쓰는 도구는 다섯 개입니다.

- `clens_search`는 지난 메시지를 키워드로 찾아 관련도 순으로 보여 줍니다. 한 번에 검색어를 다섯 개까지 넣을 수 있습니다.
- `clens_session`은 검색 결과 하나의 앞뒤 대화를 가져옵니다.
- `clens_recent`는 기간 안의 메시지를 최신순으로 가져옵니다. 키워드로 거를 수도 있습니다.
- `clens_left_off`는 어디까지 했는지 보여 줍니다. 프로젝트나 파일을 주면 최근 세션 목록을, 세션 하나를 주면 그 세션의 작업 기록을 보여 줍니다. 압축한 뒤에는 `session_id`에 `"current"`를 넣으면 됩니다.
- `clens_stats`는 세션, 프로젝트, 전체 단위로 사용 통계를 보여 줍니다.

서버는 이 도구들을 언제 쓰면 되는지 짧은 안내도 에이전트에게 보냅니다. 그래서 따로 시키지 않아도 에이전트가 알아서 씁니다.

## 설치

Node.js 20 이상과 npm이 있어야 합니다.

### 플러그인으로 설치

clens는 Claude Code와 Codex가 함께 쓰는 플러그인 하나입니다. 설치하면 MCP 서버와 압축 훅, 스킬 네 개가 같이 들어옵니다.

Claude Code:

```sh
claude plugin marketplace add wonwoo/clens
claude plugin install clens@clens
```

이미 열어 둔 세션에서는 `/plugin marketplace add wonwoo/clens`와 `/plugin install clens@clens`로 설치한 뒤 `/reload-plugins`를 실행하세요.

Codex:

```sh
codex plugin marketplace add wonwoo/clens
codex plugin add clens@clens
```

설치한 뒤에는 Codex를 열고 `/hooks`에서 clens 훅을 신뢰해 주세요. Codex는 사용자가 신뢰하기 전에는 플러그인 훅을 실행하지 않습니다. 그전까지는 압축 훅이 돌지 않습니다.

MCP 서버는 처음 뜰 때 npm 의존성을 플러그인 폴더에 설치합니다. 플러그인 버전마다 한 번입니다. 그 뒤 세션이 대화 기록에 무언가를 쓰면 그때 모든 대화 기록을 뒤에서 색인합니다. 기록이 많으면 몇 분 걸리고 그동안에는 색인한 데까지만 답에 나옵니다.

한국어 형태소 검색을 쓰려면 한국어 모델을 한 번 내려받은 뒤 새 세션을 시작하세요.

- Claude Code에서는 에이전트에게 `clens install ko`를 실행해 달라고 하면 됩니다. 플러그인이 에이전트의 셸 경로에 `clens`를 넣어 둡니다.
- Codex에서는 `node ~/.codex/plugins/cache/clens/clens/<버전>/plugin/start.mjs install ko`를 직접 실행하세요.

일본어와 중국어 검색은 따로 설치할 것이 없습니다.

플러그인에는 스킬이 네 개 들어 있습니다.

- `/clens:recap`은 지금 프로젝트에서 최근에 한 일을 정리합니다. 세션마다 무엇을 했고 어디서 멈췄고 무엇이 남았는지 보여 줍니다. 커밋은 그 커밋을 만든 세션 밑에 붙여 줍니다.
- `/clens:continue`는 이 프로젝트의 다른 최근 세션이 하던 일을 이어받습니다. 다른 도구에서 방금 하던 일을 넘겨받을 때 씁니다.
- `/clens:reflect`는 이번 세션에서 바로잡아야 했던 것을 CLAUDE.md나 AGENTS.md, 스킬을 고칠 제안으로 바꿉니다. 제안마다 지난 세션에서 같은 일이 몇 번 있었는지 붙이고, 승인한 것만 반영합니다. 한 번 돌리는 데 10~20분쯤 걸립니다.
- `clens:stats`는 "스킬 뭐 많이 써?", "컨텍스트 뭐가 많이 먹었어?" 같은 사용량 질문에 에이전트가 어떻게 답할지 알려 줍니다.

Codex에서는 `$clens:recap`처럼 앞에 `$`를 붙여 부릅니다.

업데이트는 이렇게 합니다.

```sh
claude plugin marketplace update clens && claude plugin update clens@clens
codex plugin marketplace upgrade clens && codex plugin add clens@clens
```

예전에 clens를 손으로 설정해 두었다면 그 항목을 지워 주세요. `claude mcp add`나 `codex mcp add`로 등록한 서버, 설정 파일에 넣은 압축 훅, 링크해 둔 스킬이 그렇습니다. 그대로 두면 clens가 두 벌씩 돕니다.

### 소스에서 설치

개발할 때는 저장소를 받아 플러그인으로 바로 띄웁니다.

```sh
git clone https://github.com/wonwoo/clens && cd clens
npm install                    # dist/ 빌드까지 합니다
node dist/cli.js index         # 처음 색인을 ~/.clens/index.db에 만듭니다
claude --plugin-dir .          # Claude Code, 이 세션에서만
```

각 부분을 직접 등록해도 됩니다. 이때 MCP 서버는 `clens mcp`가 아니라 `dist/mcp/server.js`를 직접 등록하세요. 서버는 자기를 띄운 부모 프로세스를 보고 지금 Claude Code 대화를 찾습니다. 덕분에 `session_id: "current"`와 검색의 "지금 턴 빼기"가 `/clear`나 `/resume` 뒤에도 맞는 세션을 따라갑니다. `clens mcp`로 띄우면 그 명령이 부모가 되어서 둘 다 서버가 처음 뜬 세션에 머뭅니다. Codex는 도구를 부를 때마다 세션을 알려 주므로 거기서는 `"current"`가 그대로 동작합니다.

```sh
claude mcp add -s user clens -- node /절대/경로/clens/dist/mcp/server.js
codex mcp add clens -- node /절대/경로/clens/dist/mcp/server.js
```

압축 훅은 `hooks/compact.mjs`를 matcher가 `compact`인 `SessionStart` 항목으로 겁니다. Claude Code용 형식은 `hooks/hooks.json`에, Codex용은 `.codex-plugin/hooks.json`에 있습니다. Codex용에는 `additionalContextLimit`을 넣어서 기록이 통째로 들어가게 했습니다(훅이 9,000자에서 자릅니다). 이 값이 없으면 Codex는 약 2,500토큰이 넘는 출력을 파일로 빼 두고 모델에게는 앞뒤 일부만 보여 줍니다.

## 사용 예

| 질문 | 에이전트가 쓰는 도구 |
|---|---|
| "지난번에 retry 로직 왜 뺐지?" | `clens_search` 뒤에 `clens_session` |
| "어디까지 했지?" / "`src/app.ts` 마지막에 누가 고쳤지?" | `clens_left_off` |
| `/compact` 뒤에 "압축 전에 고친 파일이랑 커밋 알려 줘" | `clens_left_off` (`session_id: "current"`) |
| "어제 뭐 했지?" | `since`/`until`을 준 `clens_left_off`나 `clens_recent` |
| "이번 달에 스킬 뭐 제일 많이 썼어?" | `clens_stats` |

## CLI

```
clens index [--rebuild]     색인을 만들거나 새로 고칩니다
clens install ko            한국어 형태소 모델을 내려받습니다
clens stats [--digest]      색인의 행 수나 테이블마다 SHA-256 digest를 출력합니다
clens mcp                   MCP 서버를 띄웁니다
```

경로는 환경 변수로 바꿀 수 있습니다. `CLENS_HOME`은 `~/.claude`를, `CLENS_CODEX_HOME`은 `~/.codex`를, `CLENS_INDEX_DIR`는 `~/.clens`를 대신합니다.

## 제약 사항

- 검색은 뜻이 아니라 단어로 찾습니다. 단어 전체, 부분 문자열, 한국어·일본어·중국어 형태소로 맞춰 봅니다. 그래서 대화에 쓴 말과 다른 말로 물으면 못 찾을 수 있습니다. 그럴 때는 서버 안내에 따라 에이전트가 다른 말로 다시 찾습니다.
- 도구 출력(명령 결과, 읽은 파일 내용)은 저장하지 않습니다. 메시지와 도구 호출만 저장합니다.
- 셸로 고친 파일은 명령 문자열에서 읽어 냅니다. 그래서 실행할 때 정해지는 경로(`$VAR`, `$(…)`, glob)와 앞선 호출에서 만든 스크립트 파일을 이름으로 실행한 경우, `cp`·`mv`·`touch`로 바꾼 파일은 빠집니다. Codex `exec` 코드가 실행 중에 만든 명령은 Codex가 남긴 실행 기록에서 읽습니다. 다만 그 `exec` 호출 하나만 돌고 있을 때만 셉니다.
- 작업 기록의 git 명령도 명령 문자열에서 읽습니다. 따옴표로 감싼 문자열 안의 git은 넣지 않습니다. `node -e`에 준 스크립트가 git 명령을 데이터로 들고 있을 수 있기 때문입니다. 그래서 `os.system("git commit …")`처럼 스크립트가 실행한 git은 빠집니다. `sh -c`, `bash -c`, `zsh -lc` 뒤의 문자열은 명령으로 셉니다. Codex `exec` 코드가 실행 중에 만든 명령의 git도 빠집니다. 64KB가 넘는 셸 입력은 잘린 채 저장되므로 잘린 부분 뒤의 git도 빠집니다.
- Codex에서는 서브에이전트의 대화를 압축한 뒤에 작업 기록을 넣어 주지 못합니다. 그때는 Codex가 훅을 부르지 않습니다. 압축 훅은 `/hooks`에서 신뢰해 준 뒤에만 돕니다.

## 개발

```sh
npm test            # vitest
npm run typecheck
```

테스트는 `~/.claude`와 `~/.clens`를 건드리지 않습니다. `CLENS_HOME`, `CLENS_CODEX_HOME`, `CLENS_INDEX_DIR`를 임시 폴더로 돌려서 씁니다. 구조와 색인기가 지키는 규칙은 [CLAUDE.md](CLAUDE.md)에 있습니다.

릴리스할 때는 `dist/`도 저장소에 함께 올립니다. Claude Code도 Codex도 플러그인을 빌드하지 않기 때문입니다. `npm run build`를 돌려 `dist/`를 커밋하고 `.claude-plugin/plugin.json`과 `.codex-plugin/plugin.json`의 `version`을 올리세요. Codex는 이 버전이 바뀌어야 플러그인을 다시 복사합니다. Claude Code 쪽은 `claude plugin validate .`로 검사합니다.

## 라이선스

MIT
