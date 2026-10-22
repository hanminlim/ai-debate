// 앱(Rust) 백엔드 호출. 모델 값은 "제공자:모델ID" 한 문자열로 다닌다(예: claude:claude-opus-5-5)
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const splitModel = (value) => {
  const i = value.indexOf(':')
  return [value.slice(0, i), value.slice(i + 1)]
}

let seq = 0

const aborted = () => Object.assign(new Error('토론을 중단했습니다'), { aborted: true })

// 중단하면 실행 중인 CLI 프로세스까지 끊는다. 한도 오류는 limit 표시를 붙여 기절 처리로 넘긴다.
// 이미 중단된 신호에는 리스너가 불리지 않으므로 호출 전후에 직접 확인해, 중단 뒤 다음 호출로 새지 않게 한다
export async function ask(req, signal) {
  if (signal?.aborted) throw aborted()
  const id = `ask-${Date.now()}-${seq++}`
  const [provider, model] = splitModel(req.model)
  const onAbort = () => invoke('cancel', { id })
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await invoke('ask', { req: { ...req, id, provider, model, codebase: req.codebase || '' } })
    if (signal?.aborted) throw aborted()
    return res
  } catch (e) {
    if (e.aborted || signal?.aborted) throw aborted()
    const msg = String(e)
    if (msg.startsWith('LIMIT:')) throw Object.assign(new Error(msg.slice(6)), { limit: true })
    throw new Error(msg)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export const envCheck = () => invoke('env_check')
export const claudeModels = (force = false) => invoke('claude_models', { force })
export const codexModels = () => invoke('codex_models')
export const listProjects = (problem) => invoke('list_projects', { problem })
export const ttsStatus = () => invoke('tts_status')
export const ttsInstall = () => invoke('tts_install')
export const ttsAudio = (text, voice) => invoke('tts', { text, voice })
export const openUrl = (url) => invoke('open_url', { url })
export const onTtsProgress = (cb) => listen('tts-progress', (e) => cb(e.payload))
