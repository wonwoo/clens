# clens

[English](README.md)

Claude Code와 Codex에서 나눈 지난 대화를 코딩 에이전트가 찾아볼 수 있게 해 주는 플러그인입니다.

에이전트는 세션이 끝나면 거기서 있었던 일을 기억하지 못합니다. 그래서 예전에 정한 걸 다시 묻거나 이미 해 본 방법을 또 꺼내곤 합니다. clens를 설치하면 에이전트가 지난 대화를 직접 찾아보고 답합니다. 다른 프로젝트에서 한 얘기도, Claude Code와 Codex를 오가며 한 작업도 다 찾습니다. 기록은 내 컴퓨터 밖으로 나가지 않습니다.

이렇게 물어보면 됩니다.

```txt
지난번에 retry 로직 왜 뺐지?
```

```txt
이 프로젝트 어디까지 했지? src/app.ts 마지막에 누가 고쳤어?
```

```txt
압축 전에 고친 파일이랑 커밋 알려 줘
```

아직 초기 버전이고 npm에는 올리지 않았습니다.

## 할 수 있는 것

- 지난 논의와 결정을 찾습니다. 모든 프로젝트의 대화를 뒤지고, 한국어·일본어·중국어는 형태소로 맞춰 보기 때문에 표현이 조금 달라도 걸립니다.
- 어디까지 했는지 보여 줍니다. 프로젝트나 파일 하나를 기준으로 최근 세션을 보여 주는데, 세션마다 마지막 요청과 답, 고친 파일이 같이 나옵니다.
- `/compact` 뒤에도 하던 일을 이어 갈 수 있습니다. 압축 요약에서 잘 빠지는 요청, 고친 파일, git 명령, 실패한 호출, 훅에 막힌 호출을 압축 직후에 다시 넣어 둡니다.
- 내가 어떻게 일하는지 숫자로 볼 수 있습니다. 자주 쓰는 도구와 스킬과 서브에이전트, 많이 고친 파일, 훅이 막은 것, 컨텍스트를 많이 차지한 것을 세션이나 프로젝트, 전체 단위로 봅니다.
- Claude Code가 오래된 대화 기록을 지워도 한 번 색인한 세션은 계속 찾을 수 있습니다.
- LLM을 부르지 않고 모든 데이터를 로컬에 둡니다. 네트워크는 처음 실행할 때 npm 패키지를 설치하거나 한국어 검색 모델을 받을 때만 씁니다.

## 설치

Node.js 20 이상이 필요합니다.

### Claude Code

```sh
claude plugin marketplace add wonwoo/clens
claude plugin install clens@clens
```

이미 켜 둔 세션이라면 `/plugin marketplace add wonwoo/clens`와 `/plugin install clens@clens`로 설치하고 `/reload-plugins`를 실행하세요.

### Codex

```sh
codex plugin marketplace add wonwoo/clens
codex plugin add clens@clens
```

설치한 다음 Codex에서 `/hooks`를 열어 clens 훅을 신뢰해 주세요. 신뢰하기 전까지는 압축 뒤 복구가 동작하지 않습니다.

처음 세션을 열면 지난 기록을 백그라운드에서 색인합니다. 기록이 많으면 몇 분 걸리고, 그동안은 색인된 만큼만 찾을 수 있습니다.

### 한국어 검색

한국어 모델을 한 번 받아야 합니다. Claude Code에서는 에이전트에게 `clens install ko`를 실행해 달라고 하면 되고, Codex에서는 아래 명령을 직접 실행하세요. 받은 뒤 새 세션을 열면 적용됩니다. 일본어와 중국어는 따로 받을 게 없습니다.

```sh
node ~/.codex/plugins/cache/clens/clens/<버전>/plugin/start.mjs install ko
```

### 업데이트

```sh
claude plugin marketplace update clens && claude plugin update clens@clens
codex plugin marketplace upgrade clens && codex plugin add clens@clens
```

전에 clens를 직접 설정해 둔 적이 있다면 그 설정은 지워 주세요. `claude mcp add`나 `codex mcp add`로 등록한 서버, 설정 파일에 넣은 압축 훅, 링크해 둔 스킬 같은 것들입니다. 남겨 두면 clens가 두 번씩 돕니다.

## 스킬

- `/clens:recap`은 이 프로젝트에서 최근에 한 일을 세션별로 정리합니다. 무엇을 했고 어디서 멈췄고 뭐가 남았는지, 그 세션에서 만든 커밋까지 같이 나옵니다.
- `/clens:continue`는 이 프로젝트의 다른 세션에서 하던 일을 이어서 합니다. Codex에서 하던 작업을 Claude Code에서 이어 갈 때처럼, 도구를 바꿔 가며 일할 때 씁니다.
- `/clens:reflect`는 이번 세션에서 지적받은 것들을 CLAUDE.md, AGENTS.md나 스킬 수정안으로 바꿉니다. 수정안마다 예전 세션에서도 같은 일이 있었는지 근거를 붙이고, 승인한 것만 반영합니다. `/clens:reflect 2w`나 `/clens:reflect 10주`처럼 기간을 주면(최대 10주) 그 기간에 이 프로젝트에서 나눈 대화를 전부 봅니다. 결과와 내가 내린 결정은 `~/.clens/reflect/`에 남고 다음 실행 때 참고합니다. 거절한 건 같은 문제가 다시 생기지 않는 한 또 올라오지 않습니다. 세션 하나는 10~20분쯤 걸리고, 기간을 주면 그보다 오래 걸립니다.
- `clens:stats`는 "요즘 무슨 스킬 많이 써?", "컨텍스트 뭐가 많이 먹어?" 같은 질문에 에이전트가 답할 때 참고하는 스킬입니다.

Codex에서는 `$clens:recap`처럼 앞에 `$`를 붙여서 부릅니다.

## 한계

- 뜻이 아니라 단어로 검색합니다. 대화할 때와 다른 표현으로 물으면 못 찾을 수 있는데, 그러면 에이전트가 다른 단어로 다시 찾아봅니다.
- 명령 실행 결과나 읽은 파일 내용 같은 도구 출력은 저장하지 않습니다. 메시지와 도구 호출만 남습니다.
- 스크립트로 바꾼 파일이나 `$VAR`, glob처럼 실행해 봐야 경로가 정해지는 파일은 고친 파일 목록에서 빠질 수 있습니다. 스크립트 안에서 돌린 git 명령도 마찬가지입니다.
- Codex에서는 훅을 신뢰해야 압축 뒤 복구가 동작하고, 서브에이전트가 압축했을 때는 동작하지 않습니다.

## 개발

```sh
git clone https://github.com/wonwoo/clens && cd clens
npm install                    # dist/ 빌드까지 합니다
node dist/cli.js index         # ~/.clens/index.db에 첫 색인을 만듭니다
claude --plugin-dir .          # 이 세션에서만 저장소를 플러그인으로 띄웁니다
npm test && npm run typecheck
```

MCP 서버를 직접 등록할 때는 `clens mcp` 말고 `dist/mcp/server.js`를 등록하세요. `clens mcp`로 등록하면 `/clear`나 `/resume` 뒤에도 `session_id: "current"`가 서버가 처음 뜬 세션을 가리킵니다.

```sh
claude mcp add -s user clens -- node /절대/경로/clens/dist/mcp/server.js
codex mcp add clens -- node /절대/경로/clens/dist/mcp/server.js
```

압축 훅은 `hooks/compact.mjs`입니다. Claude Code는 `hooks/hooks.json`, Codex는 `.codex-plugin/hooks.json`을 보면 어떻게 등록하는지 나와 있습니다.

CLI 명령은 이렇습니다.

```
clens index [--rebuild]     색인을 만들거나 새로 고칩니다
clens install ko            한국어 형태소 모델을 내려받습니다
clens stats [--digest]      색인의 행 수나 테이블마다 SHA-256 digest를 출력합니다
clens mcp                   MCP 서버를 띄웁니다
```

`CLENS_HOME`, `CLENS_CODEX_HOME`, `CLENS_INDEX_DIR`로 `~/.claude`, `~/.codex`, `~/.clens` 위치를 바꿀 수 있습니다. 테스트는 이 셋을 임시 폴더로 돌려 놓고 돌기 때문에 실제 폴더는 건드리지 않습니다. 전체 구조는 [CLAUDE.md](CLAUDE.md)에 있습니다.

릴리스할 때는 `dist/`도 같이 커밋합니다. Claude Code도 Codex도 플러그인을 직접 빌드하지 않아서입니다. `npm run build`로 `dist/`를 만들어 커밋하고, `.claude-plugin/plugin.json`과 `.codex-plugin/plugin.json`의 `version`을 올리세요. Claude Code 쪽은 `claude plugin validate .`로 검사할 수 있습니다.

## 라이선스

MIT
