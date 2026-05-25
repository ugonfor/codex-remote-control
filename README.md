# Codex Remote Control

핸드폰 브라우저에서 내 Mac/서버의 Codex CLI를 원격으로 조종하는 모바일 PWA입니다.
Codex CLI를 fork하지 않고, 공식 `codex app-server` JSON-RPC 인터페이스 앞에 relay와
host agent를 둡니다.

## 현재 구현 상태

구현된 것:

- 모바일 PWA에서 Codex 작업 지시 전송
- `Enter` 전송, `Shift+Enter` 줄바꿈
- Codex-style 모바일 UI
- 비밀번호 로그인/로그아웃
- pairing code/QR fallback
- relay에 붙은 host/device 관리 화면
- host 선택, host shutdown, offline host forget
- 다른 device revoke
- Codex 명령 실행/파일 변경/도구 호출 승인 요청 처리
- 실행 중인 turn interrupt
- 새 작업 시작
- Codex 내부 raw event 필터링
- assistant 응답 delta를 하나의 메시지로 합치기
- 세부 JSON은 접힌 `Details`로 표시
- PWA 설치
- 선택적 Web Push 알림
- tmux 장기 실행 방식

아직 구현하지 않은 것:

- 터미널에서 이미 실행 중인 Codex TUI 세션에 모바일이 그대로 붙는 live handoff
- 모바일 새로고침 뒤 현재 thread 자동 복원
- relay 상태 영속화
- OAuth/multi-user 인증
- HTTPS/도메인 배포 자동화

Codex app-server 프로토콜에는 `thread/list`, `thread/read`, `thread/resume`,
`thread/loaded/list`가 있어서 기존 thread 재개 기능은 구현 가능합니다. 현재 앱은 아직
그 UI와 relay-side session store를 붙이지 않은 상태입니다.

## 구조

```text
Mobile PWA
  |
  | HTTP + WebSocket
  v
Relay server
  |
  | outbound WebSocket
  v
Host agent
  |
  | stdio JSON-RPC
  v
codex app-server
  |
  v
local repo, shell, credentials, MCP, plugins
```

relay는 shell이나 로컬 파일에 접근하지 않습니다. 실제 Codex 실행 권한은 host agent가
떠 있는 개발 머신에만 있습니다.

## 요구사항

- Node.js 20 이상 권장
- npm
- Codex CLI 설치 및 로그인
- `codex app-server` 사용 가능 상태
- 핸드폰에서 Mac/서버의 relay와 mobile app URL에 접근 가능해야 함

같은 Wi-Fi에서 테스트할 때는 Mac의 LAN IP를 사용합니다.

```bash
ipconfig getifaddr en0
```

아래 예시에서는 IP를 직접 박지 않고 `<mac-ip>` 또는 `MAC_IP` 변수로 표현합니다.

## 빠른 시작

의존성 설치와 빌드:

```bash
npm install
npm run build
```

공통 변수:

```bash
export PROJECT_DIR=/path/to/codex-remote-control
export MAC_IP=$(ipconfig getifaddr en0)
export RELAY_URL=http://$MAC_IP:8787
export MOBILE_URL=http://$MAC_IP:5173
export CODEX_CWD=/path/to/repo
export RELAY_PASSWORD=change-me
```

relay 실행:

```bash
cd "$PROJECT_DIR"
PORT=8787 \
PUBLIC_RELAY_URL="$RELAY_URL" \
MOBILE_APP_URL="$MOBILE_URL" \
PAIRING_TTL_MS=86400000 \
CODEX_REMOTE_LOGIN_PASSWORD="$RELAY_PASSWORD" \
npm run dev:relay
```

mobile PWA 실행:

```bash
cd "$PROJECT_DIR"
npm run dev:mobile
```

host agent 실행:

```bash
cd "$PROJECT_DIR"
node apps/host-agent/dist/index.js \
  --relay "$RELAY_URL" \
  --name "My Mac Codex" \
  --cwd "$CODEX_CWD" \
  start
```

핸드폰에서 `http://<mac-ip>:5173`을 열고 relay password로 로그인합니다.

## tmux로 계속 띄워두기

한 번에 재시작하려면 기존 세션을 먼저 종료합니다.

```bash
tmux kill-session -t codex-remote-host 2>/dev/null || true
tmux kill-session -t codex-remote-relay 2>/dev/null || true
tmux kill-session -t codex-remote-mobile 2>/dev/null || true
```

세션 실행:

```bash
PROJECT_DIR=/path/to/codex-remote-control
MAC_IP=$(ipconfig getifaddr en0)
RELAY_URL=http://$MAC_IP:8787
MOBILE_URL=http://$MAC_IP:5173
CODEX_CWD=/path/to/repo
RELAY_PASSWORD=change-me

tmux new-session -d -s codex-remote-relay \
  "cd $PROJECT_DIR && PORT=8787 PUBLIC_RELAY_URL=$RELAY_URL MOBILE_APP_URL=$MOBILE_URL PAIRING_TTL_MS=86400000 CODEX_REMOTE_LOGIN_PASSWORD=$RELAY_PASSWORD npm run dev:relay"

tmux new-session -d -s codex-remote-mobile \
  "cd $PROJECT_DIR && npm run dev:mobile"

sleep 1

tmux new-session -d -s codex-remote-host \
  "cd $PROJECT_DIR && node apps/host-agent/dist/index.js --relay $RELAY_URL --name 'My Mac Codex' --cwd $CODEX_CWD start"
```

상태 확인:

```bash
tmux ls | grep codex-remote
tmux capture-pane -pt codex-remote-relay -S -80
tmux capture-pane -pt codex-remote-mobile -S -80
tmux capture-pane -pt codex-remote-host -S -120
curl "$RELAY_URL/healthz"
```

종료:

```bash
tmux kill-session -t codex-remote-relay
tmux kill-session -t codex-remote-mobile
tmux kill-session -t codex-remote-host
```

relay를 재시작하면 in-memory host/device 상태가 초기화됩니다. 그 경우 host agent도 같이
재시작하는 편이 가장 안전합니다.

## 폰에서 쓰는 법

1. 핸드폰에서 `http://<mac-ip>:5173`을 엽니다.
2. relay password로 로그인합니다.
3. 왼쪽 host 목록에서 `online` host를 선택합니다.
4. 하단 입력창에 Codex에게 시킬 일을 적습니다.
5. `Enter` 또는 Send 버튼으로 전송합니다.
6. 줄바꿈은 `Shift+Enter`를 사용합니다.
7. Codex가 승인 요청을 보내면 승인 카드에서 `Accept`, `Session`, `Decline` 중 하나를 누릅니다.
8. 실행 중인 작업을 멈추려면 `Stop`을 누릅니다.
9. 새 작업으로 분리하려면 `New`를 누릅니다.

Codex app-server는 lazy start 방식입니다. host가 online이어도 첫 작업 전에는
`Codex app-server is stopped`로 보일 수 있고, 첫 `thread/start` 또는 `turn/start` 요청 때
자동으로 켜집니다.

## 로그인과 로그아웃

relay에 `CODEX_REMOTE_LOGIN_PASSWORD`를 설정하면 폰에서 비밀번호로 로그인할 수 있습니다.
로그인한 device는 이 single-user relay에 붙어 있는 모든 host를 볼 수 있습니다.

```bash
CODEX_REMOTE_LOGIN_PASSWORD=change-me npm run dev:relay
```

로그아웃은 앱 왼쪽 아래 연결 아이콘을 누르면 됩니다. 로그아웃하면 relay의 device token도
폐기됩니다.

## 관리 화면

로그인 후 왼쪽 상단의 `Manage`를 누르면 relay 상태를 관리할 수 있습니다.

- `Hosts`: relay에 붙은 Codex host 목록
- `Open`: 해당 host를 현재 작업 화면으로 열기
- `Shutdown`: online host agent에 종료 요청
- `Forget`: offline host 기록 제거
- `Devices`: 로그인된 폰/브라우저 기기 목록
- `Revoke`: 다른 기기의 device token 폐기

Manage 화면은 password login으로 들어온 device에서만 사용할 수 있습니다. pairing fallback으로
연결한 device는 자기 host만 조종할 수 있고 전체 relay 관리는 할 수 없습니다.

## Pairing fallback

기본 사용은 password login을 권장합니다. pairing은 임시 fallback입니다.

pairing code는 1회용입니다. 한 번 성공하거나 만료되면 다시 사용할 수 없습니다.

새 code 발급:

```bash
node apps/host-agent/dist/index.js --relay "$RELAY_URL" pair
```

host agent가 실행 중이면 기존 host에 대한 새 code를 만듭니다. relay가 재시작되어 저장된
host token이 더 이상 유효하지 않으면 host agent가 자동으로 새 host를 만들고 새 pairing
URL을 출력합니다.

폰에서 pair가 안 될 때는 이전 pairing 탭이나 예전 QR을 쓰지 말고, 새로 출력된 URL을 새
탭에서 여세요.

## 세션 모델

현재 모바일 앱은 host-agent가 띄운 Codex app-server를 조종합니다.

- workspace는 host agent 시작 시 `--cwd`로 정합니다.
- 모델, 승인 정책, sandbox 등은 Codex CLI 설정을 따릅니다.
- 모바일 UI에서 경로나 모델을 다시 고르지 않습니다.
- 모바일의 현재 `threadId`는 아직 브라우저 state에만 있습니다.
- 새로고침하면 현재 대화 UI는 비지만, Codex thread는 세션 파일에 남습니다.

아직 Claude Code Remote Control처럼 터미널 TUI와 모바일이 동일 live session에 동시에 붙는
handoff는 구현되어 있지 않습니다. 다음 단계는 `thread/list`, `thread/read`,
`thread/resume`을 모바일 UI와 relay session store에 연결하는 것입니다.

## 앱처럼 설치하기

iPhone:

1. Safari에서 mobile URL을 엽니다.
2. 공유 버튼을 누릅니다.
3. 홈 화면에 추가를 선택합니다.

Android:

1. Chrome에서 mobile URL을 엽니다.
2. 메뉴를 엽니다.
3. 앱 설치 또는 홈 화면에 추가를 선택합니다.

PWA 설정은 `apps/mobile/public/manifest.webmanifest`에 있습니다.

## 개발 명령어

전체 빌드:

```bash
npm run build
```

전체 타입체크:

```bash
npm run typecheck
```

개발 서버:

```bash
npm run dev:relay
npm run dev:mobile
npm run dev:host -- --relay http://localhost:8787 --name "My Mac" --cwd /path/to/repo
```

빌드된 host agent:

```bash
node apps/host-agent/dist/index.js --relay http://localhost:8787 --name "My Mac" --cwd /path/to/repo start
```

## 환경 변수

host agent:

- `CODEX_REMOTE_RELAY_URL`: relay base URL
- `CODEX_REMOTE_HOST_NAME`: host 표시 이름
- `CODEX_REMOTE_HOST_TOKEN`: 기존 host token
- `CODEX_REMOTE_HOST_CONFIG`: host token 저장 경로, 기본값 `~/.codex-remote-control/host.json`
- `CODEX_REMOTE_CODEX_CWD`: `codex app-server` 실행 경로
- `CODEX_COMMAND`: Codex 실행 파일, 기본값 `codex`

relay:

- `PORT`: HTTP port
- `PUBLIC_RELAY_URL`: 폰에서 접근 가능한 relay URL
- `MOBILE_APP_URL`: pairing link에 들어갈 mobile PWA URL
- `PAIRING_TTL_MS`: pairing code 만료 시간
- `CODEX_REMOTE_LOGIN_PASSWORD`: 모바일 로그인 비밀번호
- `CORS_ORIGIN`: browser CORS allow origin
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: Web Push 설정

mobile:

- `VITE_VAPID_PUBLIC_KEY`: 브라우저 push 등록용 공개 VAPID key

VAPID key 생성:

```bash
npx web-push generate-vapid-keys
```

## 문제 해결

로그인이 안 됨:

- relay가 `CODEX_REMOTE_LOGIN_PASSWORD`와 함께 실행 중인지 확인합니다.
- 비밀번호를 바꿨거나 relay를 재시작했다면 폰에서 로그아웃 후 다시 로그인하세요.
- 로그인 비밀번호는 relay 단일 사용자용입니다.

폰에서 아무것도 안 보임:

- 폰과 Mac이 같은 네트워크인지 확인합니다.
- 폰에서 `http://<mac-ip>:5173`가 열리는지 확인합니다.
- `curl http://<mac-ip>:8787/healthz`가 `{"ok":true}`를 반환하는지 확인합니다.
- Mac의 IP가 바뀌었다면 relay/host/mobile tmux 세션을 현재 IP 기준으로 다시 띄우세요.

host가 offline:

- `codex-remote-host` tmux 세션이 살아있는지 확인합니다.
- Mac이 잠자기 상태가 아닌지 확인합니다.
- relay를 재시작했다면 host agent도 재시작하세요.
- host agent가 예전 IP의 relay URL로 실행 중인지 확인하세요.

`pairing_not_found` 또는 404:

- code가 틀렸거나 이미 사용됐거나 만료된 상태입니다.
- 새 pairing code를 발급하세요.
- 예전 QR이나 예전 탭을 쓰지 마세요.

`Relay connection failed`:

- relay URL이 폰에서 접근 가능한 주소인지 확인합니다.
- `localhost`는 폰에서 Mac을 가리키지 않습니다.
- LAN 테스트에서는 `http://<mac-ip>:8787` 형태를 사용합니다.

Codex가 응답하지 않음:

- host agent 로그에서 `starting codex app-server` 이후 에러가 있는지 확인합니다.
- 터미널에서 `codex app-server`가 직접 실행되는지 확인합니다.
- `--cwd` 경로가 실제 repo인지 확인합니다.
- 첫 요청 전 `Codex app-server is stopped`는 정상일 수 있습니다.

## 검증

기본 검증:

```bash
npm run typecheck
npm run build
```

운영 smoke test:

```bash
curl "$RELAY_URL/healthz"
```

확인해야 할 항목:

- password login/logout
- admin session listing
- mobile WebSocket host listing
- host-agent to relay connection
- `thread/start` 요청 성공
- Codex app-server lazy start
- approval card 표시
- noisy internal event 숨김

## 보안 메모

현재 구현은 LAN single-user MVP이고 relay 상태는 in-memory입니다. 외부 사용자를 대상으로
운영하려면 최소한 아래 작업이 필요합니다.

- relay를 HTTPS 뒤에 배치
- OAuth 또는 다른 정식 인증 도입
- host/device token 해시 저장
- Postgres/Redis 등 영속 상태 저장소 사용
- `CORS_ORIGIN` 제한
- pairing/WebSocket rate limit
- audit log 저장

`codex app-server`를 공개 네트워크에 직접 노출하지 마세요. 항상 host agent 뒤에 두고,
host agent가 relay로 outbound WebSocket을 연결하는 구조를 유지하세요.
