// 연결 확인: CLI 설치·로그인, 폴더 접근 권한, 쓸 수 있는 모델을 시작 전에 모두 확인한다
import { useEffect, useRef, useState } from 'react'
import { claudeModels, codexModels, envCheck, onTtsProgress, openLogin, openUrl, ttsInstall, verifyLogin } from './api.js'

const PRIVACY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'

const PROVIDERS = {
  claude: {
    name: 'Claude Code',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  },
  codex: {
    name: 'Codex CLI',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
  },
}

export const toOptions = (provider, list) => list.map((m) => ({ value: `${provider}:${m.id}`, label: m.label, provider }))

function Mark({ state }) {
  const text = { ok: '연결됨', bad: '필요', wait: '확인 중', off: '선택' }[state]
  return <span className={`mark ${state}`}>{text}</span>
}

function ProviderCard({ id, info, models, onRecheck, onLoggedIn }) {
  const p = PROVIDERS[id]
  const ok = info?.installed && info.logged_in && !info.expired
  const state = !info ? 'wait' : ok ? 'ok' : 'bad'
  return (
    <article className="gate-card">
      <header>
        <strong>{p.name}</strong>
        <Mark state={state} />
      </header>
      {info && !info.installed && (
        <>
          <p>설치돼 있지 않습니다. 터미널에서 설치한 뒤 로그인하세요.</p>
          <pre>{`${p.install}\n${p.login}`}</pre>
        </>
      )}
      {info?.expired && (
        <>
          <p>로그인이 만료됐습니다. 저장된 로그인 정보는 있지만 서버에서 거절합니다. 다시 로그인해 주세요.</p>
          <pre>{p.login}</pre>
          <div className="pause-actions">
            <button className="btn small" onClick={() => openLogin(id)}>
              다시 로그인
            </button>
            <button className="btn small" onClick={onLoggedIn}>
              로그인했어요
            </button>
          </div>
        </>
      )}
      {info?.installed && !info.logged_in && (
        <>
          <p>로그인이 필요합니다. 이 컴퓨터에 로그인한 각자의 구독으로 토론합니다.</p>
          <pre>{p.login}</pre>
        </>
      )}
      {ok && (
        <>
          <p className="detail">{info.detail}</p>
          <div className="model-chips" aria-live="polite">
            {models === null ? (
              <span className="muted">쓸 수 있는 모델을 확인하고 있습니다…</span>
            ) : models.length ? (
              models.map((m) => (
                <span className="model-chip" key={m.id}>
                  {m.label}
                </span>
              ))
            ) : (
              <span className="muted">쓸 수 있는 모델이 없습니다</span>
            )}
          </div>
          {onRecheck && models !== null && (
            <button className="link" onClick={onRecheck} title="후보 모델을 하나씩 짧게 불러 보므로 사용량을 조금 씁니다">
              모델 다시 검사
            </button>
          )}
        </>
      )}
    </article>
  )
}

function TtsCard({ tts, onInstalled }) {
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unlisten = useRef(null)

  useEffect(() => () => unlisten.current?.(), [])

  const install = async () => {
    setBusy(true)
    setError('')
    setLog([])
    unlisten.current = await onTtsProgress((line) => setLog((l) => [...l.slice(-5), line]))
    try {
      await ttsInstall()
      onInstalled()
    } catch (e) {
      setError(String(e))
    } finally {
      unlisten.current?.()
      setBusy(false)
    }
  }

  const usable = tts && (tts.installed || tts.running) // 다른 곳에서 띄운 엔진도 그대로 쓴다
  const state = !tts ? 'wait' : usable ? 'ok' : 'off'
  return (
    <article className="gate-card">
      <header>
        <strong>음성 엔진 (Supertonic)</strong>
        <Mark state={state} />
      </header>
      {usable ? (
        <p className="detail">{tts.running ? '자연스러운 음성으로 읽습니다.' : '설치돼 있습니다. 앱을 다시 열면 켜집니다.'}</p>
      ) : (
        <>
          <p>
            없어도 토론은 됩니다(시스템 음성으로 읽음). 설치하면 사람마다 다른 자연스러운 목소리로 읽습니다. Python 3 이 필요하고
            약 400MB 를 내려받습니다.
          </p>
          <button className="btn small" onClick={install} disabled={busy || !tts}>
            {busy ? '설치하는 중…' : '음성 엔진 설치'}
          </button>
          {log.length > 0 && <pre className="log">{log.join('\n')}</pre>}
          {error && <p className="bad-text">{error}</p>}
        </>
      )}
    </article>
  )
}

// manual: 설정 화면에서 "연결 관리"로 연 경우. 자동으로 넘어가지 않고 계속 보여 준다
export default function Gate({ onReady, manual = false }) {
  const [env, setEnv] = useState(null)
  const [models, setModels] = useState({ claude: null, codex: null })

  // force: Claude 모델 후보를 다시 불러 본다(사용량을 쓴다). 평소에는 저장해 둔 결과를 쓴다
  const check = async (force = false) => {
    setEnv(null)
    setModels({ claude: null, codex: null })
    const report = await envCheck()
    setEnv(report)
    // login status 는 저장된 정보만 봐서 만료를 못 잡는다. 로그인된 쪽은 짧은 호출로 실제로 살아 있는지 확인한다
    const alive = async (id) => {
      if (!report[id].logged_in) return false
      try {
        await verifyLogin(id)
        return true
      } catch (e) {
        if (String(e).startsWith('AUTH:')) report[id] = { ...report[id], expired: true }
        return !String(e).startsWith('AUTH:')
      }
    }
    const [claudeOk, codexOk] = await Promise.all([alive('claude'), alive('codex')])
    setEnv({ ...report })
    // 살아 있는 쪽만 모델을 확인한다. Claude 는 후보를 실제로 짧게 불러 보므로 처음엔 시간이 걸린다
    const [claude, codex] = await Promise.all([claudeOk ? claudeModels(force) : [], codexOk ? codexModels() : []])
    setModels({ claude, codex })
  }

  useEffect(() => {
    check()
  }, [])

  const foldersOk = env?.folders.every((f) => f.ok)
  const options = [...toOptions('claude', models.claude ?? []), ...toOptions('codex', models.codex ?? [])]
  const loading = !env || (env.claude.logged_in && models.claude === null) || (env.codex.logged_in && models.codex === null)
  const ready = !loading && foldersOk && options.length > 0

  // 연결이 덜 된 동안 몇 초마다 다시 본다. 터미널에서 설치·로그인을 마치거나 권한을 켜면 버튼 없이 바로 바뀐다
  const snapshot = (r) =>
    JSON.stringify([r.claude.installed, r.claude.logged_in, r.codex.installed, r.codex.logged_in, r.folders.map((f) => f.ok), r.tts])
  const pending = env && (!foldersOk || !options.length) && !loading
  useEffect(() => {
    if (!pending) return
    const t = setInterval(async () => {
      const r = await envCheck()
      if (snapshot(r) !== snapshot(env)) check()
    }, 4000)
    return () => clearInterval(t)
  }, [pending, env])

  // 필수 연결(모델 하나 이상 + 폴더 권한)이 갖춰지면 이 화면을 건너뛴다. 빠진 게 있을 때만 보여 준다
  const [shown, setShown] = useState(manual)
  useEffect(() => {
    if (ready && !manual) onReady({ models: options, tts: env.tts })
    else if (!loading) setShown(true)
  }, [ready, loading])

  if (!shown) {
    return (
      <main className="gate">
        <p className="gate-checking">연결 확인 중…</p>
      </main>
    )
  }

  return (
    <main className="gate">
      <section className="gate-intro">
        <h2>연결 확인</h2>
        <p>
          토론자는 이 컴퓨터에 로그인한 Claude 또는 Codex 로 말합니다. 둘 중 하나 이상 연결되고, 프로젝트 폴더를 읽을 권한이 있어야
          시작할 수 있습니다.
        </p>
      </section>

      <div className="gate-grid">
        <ProviderCard id="claude" info={env?.claude} models={models.claude} onRecheck={() => check(true)} onLoggedIn={() => check()} />
        <ProviderCard id="codex" info={env?.codex} models={models.codex} onLoggedIn={() => check()} />

        <article className="gate-card">
          <header>
            <strong>폴더 접근 권한</strong>
            <Mark state={!env ? 'wait' : foldersOk ? 'ok' : 'bad'} />
          </header>
          <p>토론할 프로젝트를 찾고 코드를 읽기 전용으로 보려면 문서·데스크탑 폴더 접근이 필요합니다.</p>
          <ul className="folders">
            {env?.folders.map((f) => (
              <li key={f.path} className={f.ok ? 'ok' : 'bad'}>
                {f.name} {f.ok ? '허용됨' : '거부됨'}
              </li>
            ))}
          </ul>
          {env && !foldersOk && (
            <>
              <p>시스템 설정 › 개인정보 보호 및 보안 › 파일 및 폴더에서 "AI Debate" 의 문서·데스크탑을 켠 뒤 다시 확인하세요.</p>
              <button className="btn small" onClick={() => openUrl(PRIVACY_URL)}>
                시스템 설정 열기
              </button>
            </>
          )}
        </article>

        <TtsCard tts={env?.tts} onInstalled={() => check()} />
      </div>

      <div className="gate-actions">
        <button className="btn" onClick={() => check()} disabled={loading}>
          다시 확인
        </button>
        <button className="btn primary" disabled={!ready} onClick={() => onReady({ models: options, tts: env.tts })}>
          {loading ? '확인하는 중…' : ready ? (manual ? '설정으로 돌아가기' : '시작하기') : '연결이 필요합니다'}
        </button>
      </div>
    </main>
  )
}
