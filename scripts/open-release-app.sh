#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="$ROOT/src-tauri/target/release/bundle/macos/Maka.app"

if [[ "${MAKA_KILL_STALE:-0}" == "1" ]]; then
  pkill -f '/Volumes/.*/Maka.app/Contents/MacOS/maka' 2>/dev/null || true
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "Maka.app이 없습니다. 먼저 release bundle을 빌드합니다..." >&2
  (cd "$ROOT" && pnpm tauri build)
fi

if pgrep -f '/Volumes/.*/Maka.app/Contents/MacOS/maka' >/dev/null 2>&1; then
  cat >&2 <<'WARN'
경고: /Volumes 아래의 오래된 Maka DMG 앱 프로세스가 아직 실행 중입니다.
최신 앱만 확인하려면 다음처럼 실행하세요:

  MAKA_KILL_STALE=1 pnpm app:open-release

WARN
fi

open -n "$APP_PATH"
echo "opened: $APP_PATH"
