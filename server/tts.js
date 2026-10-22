import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const TTS_URL = 'http://127.0.0.1:7788'
const BIN = new URL('../.venv/bin/supertonic', import.meta.url).pathname

const healthy = () =>
  fetch(`${TTS_URL}/v1/health`)
    .then((r) => r.ok)
    .catch(() => false)

// dev 서버와 함께 Supertonic TTS 서버(이 맥에서만 접근)를 띄운다. 반환값은 정리 함수
export async function startSupertonic() {
  if (await healthy()) return () => {}
  if (!existsSync(BIN)) {
    console.warn('[tts] Supertonic 이 없어 브라우저 음성으로 대신합니다. npm run setup:tts 로 설치하세요')
    return () => {}
  }
  const child = spawn(BIN, ['serve', '--host', '127.0.0.1', '--port', '7788', '--log-level', 'warning'], {
    stdio: 'inherit',
  })
  return () => child.kill()
}
