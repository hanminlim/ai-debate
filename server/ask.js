import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku']

// API 키가 환경에 있으면 claude 가 그걸로 과금 호출한다. 각자 로그인한 구독(claude.ai) 인증만 쓰도록 지운다
function subscriptionEnv() {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

function runClaude(args, { input, cwd, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { env: subscriptionEnv(), cwd: cwd ?? tmpdir() })
    onSpawn?.(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 || out ? resolve({ out, err, code }) : reject(new Error(err || `claude 종료 코드 ${code}`))))
    child.stdin.end(input ?? '')
  })
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

// 토론 대상 코드 폴더: 절대 경로의 실제 디렉터리만 받는다
export function codebaseDir(path) {
  if (!path) return null
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('코드 폴더는 절대 경로여야 합니다')
  let st
  try {
    st = statSync(path)
  } catch {
    throw new Error(`폴더를 찾을 수 없습니다: ${path}`)
  }
  if (!st.isDirectory()) throw new Error(`폴더가 아닙니다: ${path}`)
  return path
}

// 사용량 한도에 걸렸는지: 화면에서 "기절" 이벤트로 보여 준다
export const isLimitError = (status, text = '') =>
  status === 429 || /usage limit|rate limit|hit your limit|limit reached|out of (extra )?usage/i.test(text)

export function claudeArgs({ model, system, schema, codebase }) {
  const args = [
    '-p',
    '--safe-mode', // 각자의 CLAUDE.md·훅·플러그인이 토론자에게 섞이지 않게 한다
    '--restricted', // 파일 도구를 작업 폴더 안으로 가두고 사용자 설정의 허용 범위를 무시한다
    '--permission-prompts', 'none',
    '--tools', codebase ? 'Read,Grep,Glob' : '', // 코드를 볼 때도 읽기 전용
    '--no-session-persistence',
    '--model', model,
    '--system-prompt', system,
    '--output-format', 'json',
  ]
  if (schema) args.push('--json-schema', JSON.stringify(schema))
  return args
}

export async function askHandler(req, res) {
  // JSON content-type 강제: 다른 사이트가 preflight 없이 로컬 claude 를 부르지 못하게 한다
  if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) {
    return send(res, 405, { error: 'POST application/json 만 받습니다' })
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const { model, system, prompt, schema, codebase } = JSON.parse(raw)
  if (!MODELS.includes(model)) return send(res, 400, { error: `알 수 없는 모델: ${model}` })
  if (typeof system !== 'string' || typeof prompt !== 'string') return send(res, 400, { error: 'system·prompt 가 필요합니다' })
  let cwd
  try {
    cwd = codebaseDir(codebase) ?? undefined
  } catch (e) {
    return send(res, 400, { error: e.message })
  }

  let child
  res.on('close', () => child?.exitCode === null && child.kill()) // 화면에서 중단하면 호출도 끊는다
  try {
    const { out, err } = await runClaude(claudeArgs({ model, system, schema, codebase: cwd }), {
      input: prompt,
      cwd,
      onSpawn: (c) => (child = c),
    })
    let result
    try {
      result = JSON.parse(out)
    } catch {
      const text = err || out
      return send(res, isLimitError(0, text) ? 429 : 502, { error: text || 'claude 응답을 읽지 못했습니다', limit: isLimitError(0, text) })
    }
    if (result.is_error) {
      const limit = isLimitError(result.api_error_status, result.result)
      return send(res, limit ? 429 : 502, { error: result.result || 'claude 오류', limit })
    }
    send(res, 200, { text: result.result, data: result.structured_output ?? null })
  } catch (e) {
    if (!res.writableEnded) send(res, isLimitError(0, e.message) ? 429 : 502, { error: e.message, limit: isLimitError(0, e.message) })
  }
}

export async function authHandler(_req, res) {
  try {
    const { out } = await runClaude(['auth', 'status'])
    const status = JSON.parse(out)
    send(res, 200, { loggedIn: status.loggedIn, method: status.authMethod, plan: status.subscriptionType ?? null })
  } catch (e) {
    // spawn ENOENT: claude 가 설치돼 있지 않다
    send(res, 200, { installed: e.code !== 'ENOENT', loggedIn: false, error: e.message })
  }
}
