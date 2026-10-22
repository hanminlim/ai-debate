#!/bin/sh
# 토론 무대(AI Debate) 설치: 최신 릴리즈 .dmg 를 받아 /Applications 에 넣고 연다.
# 브라우저로 받은 파일이 아니라서 macOS 의 "확인되지 않은 개발자" 차단에 걸리지 않는다.
#   curl -fsSL https://raw.githubusercontent.com/hanminlim/ai-debate/main/install.sh | sh
set -eu

REPO="hanminlim/ai-debate"
APP="AI Debate.app"

URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*universal\.dmg"' \
  | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
if [ -z "$URL" ]; then
  echo "최신 릴리즈의 .dmg 를 찾지 못했습니다: https://github.com/$REPO/releases" >&2
  exit 1
fi

TMP=$(mktemp -d)
cleanup() {
  hdiutil detach "$TMP/mnt" -quiet 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "받는 중: $URL"
curl -fL --progress-bar "$URL" -o "$TMP/app.dmg"
hdiutil attach "$TMP/app.dmg" -nobrowse -quiet -mountpoint "$TMP/mnt"

# 실행 중이면 끄고 바꾼다
osascript -e 'quit app "AI Debate"' 2>/dev/null || true
rm -rf "/Applications/$APP"
cp -R "$TMP/mnt/$APP" /Applications/
/usr/bin/xattr -dr com.apple.quarantine "/Applications/$APP" 2>/dev/null || true
echo "설치했습니다: /Applications/$APP"

command -v claude >/dev/null 2>&1 || echo "· Claude Code 가 없습니다: npm install -g @anthropic-ai/claude-code && claude auth login"
command -v codex >/dev/null 2>&1 || echo "· Codex 가 없습니다: npm install -g @openai/codex && codex login"

open "/Applications/$APP"
