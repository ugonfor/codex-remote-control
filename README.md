# Codex Remote Control

핸드폰 브라우저에서 내 Mac/서버의 Codex CLI를 원격으로 조종하는 모바일 PWA입니다.
Codex를 fork하지 않고, 공식 `codex app-server` JSON-RPC 인터페이스 앞에 relay와 host agent를 둡니다.

## 무엇을 제공하나

- 모바일에서 Codex 작업 지시 전송
- Claude Code online과 비슷한 세션 중심 UI
- 비밀번호 로그인/로그아웃
- pairing code/QR 기반 fallback 기기 연결
- 명령 실행, 파일 변경 등 Codex 승인 요청 처리
- 실행 중인 turn 중단 및 새 session 시작
- 홈 화면에 설치 가능한 PWA
- 선택적 Web Push 알림

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
떠 있는 개발 머신에만 있습니다. 공개망에 올릴 때는 relay를 HTTPS 뒤에 두고, host
agent는 신뢰하는 머신에서만 실행하세요.

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

예시에서는 LAN IP를 `172.30.1.24`로 사용합니다.

## 빠른 시작

의존성 설치와 빌드:

```bash
npm install
npm run build
```

relay 실행:

```bash
PORT=8787 \
PUBLIC_RELAY_URL=http://172.30.1.24:8787 \
MOBILE_APP_URL=http://172.30.1.24:5173 \
PAIRING_TTL_MS=86400000 \
CODEX_REMOTE_LOGIN_PASSWORD='change-me' \
npm run dev:relay
```

mobile PWA 실행:

```bash
npm run dev:mobile
```

host agent 실행:

```bash
node apps/host-agent/dist/index.js \
  --relay http://172.30.1.24:8787 \
  --name "Hyogon Mac Codex" \
  --cwd /path/to/repo \
  start
```

핸드폰에서 `http://172.30.1.24:5173`을 열고 relay password로 로그인합니다. pairing
URL과 QR은 fallback 용도로 계속 사용할 수 있습니다.

## tmux로 계속 띄워두기

relay:

```bash
tmux new-session -d -s codex-remote-relay \
  'cd /path/to/codex-remote-control && PORT=8787 PUBLIC_RELAY_URL=http://172.30.1.24:8787 MOBILE_APP_URL=http://172.30.1.24:5173 PAIRING_TTL_MS=86400000 CODEX_REMOTE_LOGIN_PASSWORD=change-me npm run dev:relay'
```

mobile:

```bash
tmux new-session -d -s codex-remote-mobile \
  'cd /path/to/codex-remote-control && npm run dev:mobile'
```

host:

```bash
tmux new-session -d -s codex-remote-host \
  'cd /path/to/codex-remote-control && node apps/host-agent/dist/index.js --relay http://172.30.1.24:8787 --name "Hyogon Mac Codex" --cwd /path/to/repo start'
```

상태 확인:

```bash
tmux ls
tmux capture-pane -pt codex-remote-host -S -120
curl http://172.30.1.24:8787/healthz
```

종료:

```bash
tmux kill-session -t codex-remote-relay
tmux kill-session -t codex-remote-mobile
tmux kill-session -t codex-remote-host
```

## 로그인과 로그아웃

relay에 `CODEX_REMOTE_LOGIN_PASSWORD`를 설정하면 폰에서 비밀번호로 로그인할 수 있습니다.
로그인한 기기는 이 single-user relay에 붙어 있는 모든 host를 볼 수 있습니다.

```bash
CODEX_REMOTE_LOGIN_PASSWORD='change-me' npm run dev:relay
```

로그아웃은 앱 왼쪽 아래 연결 아이콘을 누르면 됩니다. 로그아웃하면 relay의 device token도
폐기됩니다.

## Pairing fallback

pairing code는 1회용입니다. 한 번 성공하거나 만료되면 다시 사용할 수 없습니다.

새 code 발급:

```bash
node apps/host-agent/dist/index.js --relay http://172.30.1.24:8787 pair
```

host agent가 실행 중이면 기존 host에 대한 새 code를 만듭니다. relay가 재시작되어 저장된
host token이 더 이상 유효하지 않으면 host agent가 자동으로 새 host를 만들고 새 pairing
URL을 출력합니다.

폰에서 pair가 안 될 때는 이전 pairing 탭이나 예전 QR을 쓰지 말고, 새로 출력된 URL을 새
탭에서 여세요.

## 폰에서 쓰는 법

1. 핸드폰에서 `http://<mac-ip>:5173`을 엽니다.
2. relay password로 로그인합니다.
3. 왼쪽 Recents에서 online host를 선택합니다.
4. 하단 입력창에 Codex에게 시킬 일을 적고 Send 버튼을 누릅니다.
5. Codex가 명령 실행이나 파일 변경 승인을 요청하면 중앙 세션 화면에 승인 카드가 뜹니다.
6. 새 작업으로 분리하려면 New session 또는 New를 누릅니다.
7. 실행 중인 작업을 멈추려면 Stop을 누릅니다.

pairing URL로 열면 기존 pairing fallback을 사용합니다.

## 관리 화면

로그인 후 왼쪽 상단의 Manage를 누르면 relay에 떠 있는 session들을 관리할 수 있습니다.

- Hosts: relay에 붙은 Codex host 목록입니다.
- Open: 해당 host를 현재 작업 화면으로 엽니다.
- Shutdown: online host agent에 종료 요청을 보냅니다.
- Forget: offline host 기록을 relay에서 제거합니다.
- Devices: 로그인된 폰/브라우저 기기 목록입니다.
- Revoke: 다른 기기의 device token을 폐기하고 연결을 끊습니다.

Manage 화면은 password login으로 들어온 device에서만 사용할 수 있습니다. pairing fallback으로
연결한 device는 자기 host만 조종할 수 있고 전체 relay 관리는 할 수 없습니다.

프로젝트 경로는 host agent를 시작할 때 `--cwd`로 정합니다. 모델과 Codex 설정은 Codex
CLI 설정을 따릅니다. 모바일 UI에서 경로나 모델을 다시 고르지 않습니다.

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

## 명령어

빌드된 host agent:

```bash
node apps/host-agent/dist/index.js --relay http://localhost:8787 --name "My Mac" --cwd /path/to/repo start
```

새 pairing code:

```bash
node apps/host-agent/dist/index.js --relay http://localhost:8787 pair
```

개발 모드:

```bash
npm run dev:relay
npm run dev:mobile
npm run dev:host -- --relay http://localhost:8787 --name "My Mac" --cwd /path/to/repo
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

`pairing_not_found` 또는 404:

- code가 틀렸거나 이미 사용됐거나 만료된 상태입니다.
- `node apps/host-agent/dist/index.js --relay http://172.30.1.24:8787 pair`로 새 code를 발급하세요.
- 예전 QR이나 예전 탭을 쓰지 마세요.

로그인 실패:

- relay가 `CODEX_REMOTE_LOGIN_PASSWORD`와 함께 실행 중인지 확인합니다.
- 비밀번호를 바꿨거나 relay를 재시작했다면 폰에서 로그아웃 후 다시 로그인하세요.
- 로그인 비밀번호는 relay 단일 사용자용입니다. 여러 사용자용으로 운영하려면 OAuth와 DB-backed session으로 바꾸세요.

폰에서 아무것도 안 보임:

- 폰과 Mac이 같은 네트워크인지 확인합니다.
- 폰에서 `http://172.30.1.24:5173`가 열리는지 확인합니다.
- `curl http://172.30.1.24:8787/healthz`가 `{"ok":true}`를 반환하는지 확인합니다.

host가 offline:

- `codex-remote-host` tmux 세션이 살아있는지 확인합니다.
- Mac이 잠자기 상태가 아닌지 확인합니다.
- relay를 재시작했다면 host agent도 재시작하는 편이 가장 안전합니다.

`Relay connection failed`:

- relay URL이 폰에서 접근 가능한 주소인지 확인합니다. `localhost`는 폰에서 Mac을 가리키지 않습니다.
- LAN 테스트에서는 `http://<mac-ip>:8787` 형태를 사용합니다.

Codex가 응답하지 않음:

- host agent 로그에서 `starting codex app-server` 이후 에러가 있는지 확인합니다.
- 터미널에서 `codex app-server`가 직접 실행되는지 확인합니다.
- `--cwd` 경로가 실제 repo인지 확인합니다.

## 검증

```bash
npm run typecheck
npm run build
```

로컬 smoke test:

- relay `/healthz`
- password login/logout
- admin session listing
- pairing creation and claim
- mobile WebSocket host listing
- host-agent to relay connection
- `codex app-server` lazy start

## 보안 메모

현재 구현은 MVP이고 relay 상태는 in-memory입니다. 외부 사용자를 대상으로 운영하려면 최소한
아래 작업이 필요합니다.

- relay를 HTTPS 뒤에 배치
- pairing 생성 API에 인증 추가
- host/device token 해시 저장
- Postgres/Redis 등 영속 상태 저장소 사용
- `CORS_ORIGIN` 제한
- pairing/WebSocket rate limit
- device/host revoke UI
- 승인 요청 audit log

`codex app-server`를 공개 네트워크에 직접 노출하지 마세요. 항상 host agent 뒤에 두고,
host agent가 relay로 outbound WebSocket을 연결하는 구조를 유지하세요.
