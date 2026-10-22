import { useEffect, useRef, useState } from 'react'
import { avatarUri, randomSeed } from './avatar.js'
import { PHASES, runDebate } from './engine.js'
import { applyEvent, initialView, toPrompt } from './script.js'
import { VOICES, play, setRate, stopSpeaking, synthesize, ttsHealth } from './voice.js'

const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const COLORS = ['#FF4F81', '#2FB5F0', '#3DCB7A', '#A27BFF', '#FF8A2B']
const PRESETS = [
  { name: '한민', stance: '실용주의 — 당장 실행 가능한 답을 찾는다' },
  { name: '다정', stance: '회의론 — 숨은 위험과 반례를 먼저 본다' },
  { name: '성욱', stance: '낙관론 — 기회와 가능성에 무게를 둔다' },
  { name: '성현', stance: '원칙주의 — 일관된 기준과 장기 영향을 따진다' },
  { name: '원이', stance: '발산형 — 남들이 안 본 대안을 꺼낸다' },
]

const SEAT_VOICES = ['M2', 'F1', 'M3', 'M4', 'F3'] // 한민·다정·성욱·성현·원이 순. 다정·원이는 여성 목소리
const seatFor = (i) => ({
  id: `d${i + 1}`,
  ...PRESETS[i],
  model: 'sonnet',
  voice: SEAT_VOICES[i],
  color: COLORS[i],
  seed: randomSeed(),
})

async function ask(req, signal) {
  // shortcut: 실패하면 한 번만 다시 부른다. 잦으면 지수 백오프로 바꾼다
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    })
    const body = await res.json()
    if (res.ok) return body
    if (body.limit) throw Object.assign(new Error(body.error), { limit: true }) // 한도는 다시 불러도 안 풀린다
    if (attempt >= 1) throw new Error(body.error || `요청 실패 (${res.status})`)
  }
}

export default function App() {
  const [config, setConfig] = useState({
    problem: '',
    moderator: { model: 'opus', voice: 'M1', seed: randomSeed() },
    debaters: [0, 1, 2].map(seatFor),
    maxRounds: 3,
  })
  const [auth, setAuth] = useState(null)
  const [audio, setAudio] = useState({ rate: 1.2, muted: false })
  const [view, setView] = useState(initialView)
  const [computing, setComputing] = useState(null) // 지금 계산 중인 사람: 'mod' | 토론자 id
  const [speaking, setSpeaking] = useState(null)
  const [status, setStatus] = useState('setup') // setup | running | done | stopped | fainted | error
  const [error, setError] = useState('')

  const run = useRef(null)
  const audioRef = useRef(audio)
  audioRef.current = audio // 재생 중에 바꾼 속도·음소거가 다음 문장부터 반영되게 한다

  useEffect(() => {
    fetch('/api/auth')
      .then((r) => r.json())
      .then(setAuth)
      .catch(() => setAuth({ loggedIn: false, installed: true }))
  }, [])

  // 재생기: 엔진이 쌓은 대본을 한 줄씩 꺼내 화면에 올리고 다 읽을 때까지 기다린다
  const pump = async (r) => {
    if (r.playing) return
    r.playing = true
    while (r.queue.length && !r.ctrl.signal.aborted) {
      const e = r.queue.shift()
      setView((v) => applyEvent(v, e))
      if (e.type !== 'say') continue
      setSpeaking(e.from)
      const who = config.debaters.findIndex((d) => d.id === e.from) + 1 // 사회자는 0
      await play(e.text, e.audio, { ...audioRef.current, who, signal: r.ctrl.signal })
      setSpeaking(null)
    }
    r.playing = false
    if (r.engineDone && !r.queue.length && !r.ctrl.signal.aborted) setStatus(r.endStatus ?? 'done')
  }

  const voiceOf = (from) => (from === 'mod' ? config.moderator : config.debaters.find((d) => d.id === from)).voice

  const start = async () => {
    const r = { ctrl: new AbortController(), queue: [], playing: false, engineDone: false }
    run.current = r
    setView(initialView)
    setError('')
    setStatus('running')
    try {
      // 문제가 가리키는 프로젝트를 사회자가 고를 수 있게 이 맥의 프로젝트 폴더 목록을 넘긴다
      const { projects } = await fetch(`/api/projects?problem=${encodeURIComponent(config.problem)}`).then((x) => x.json())
      await runDebate(
        { ...config, projects },
        {
          ask: (req) => ask(req, r.ctrl.signal),
          emit: (e) => {
            if (e.type === 'say') e.audio = synthesize(e.text, voiceOf(e.from))
            r.queue.push(e)
            pump(r)
          },
          live: setComputing,
        },
      )
      r.engineDone = true
      pump(r)
    } catch (e) {
      if (r.ctrl.signal.aborted) return
      if (e.faint) {
        // 사회자 기절: 남은 대본(기절 장면)까지 재생한 뒤 멈춘다
        r.endStatus = 'fainted'
        r.engineDone = true
        pump(r)
        return
      }
      setError(e.message)
      setStatus('error')
    }
  }

  const stop = () => {
    run.current?.ctrl.abort()
    stopSpeaking()
    setComputing(null)
    setSpeaking(null)
    setStatus('stopped')
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">토론 무대</h1>
        <AudioControls audio={audio} setAudio={setAudio} />
        <AuthBadge auth={auth} />
        {status === 'running' && (
          <button className="btn ghost" onClick={stop}>
            토론 중단
          </button>
        )}
        {status !== 'setup' && status !== 'running' && (
          <button className="btn ghost" onClick={() => setStatus('setup')}>
            설정으로
          </button>
        )}
      </header>
      {status === 'setup' ? (
        <Setup config={config} setConfig={setConfig} auth={auth} onStart={start} />
      ) : (
        <Stage
          config={config}
          view={view}
          computing={computing}
          speaking={speaking}
          status={status}
          error={error}
          onRetry={start}
        />
      )}
    </div>
  )
}

function AudioControls({ audio, setAudio }) {
  const [engine, setEngine] = useState(null)
  useEffect(() => {
    ttsHealth().then((h) => setEngine(h?.status === 'ok' ? 'Supertonic' : '브라우저 음성'))
  }, [])
  useEffect(() => setRate(audio.rate), [audio.rate]) // 말하는 도중에도 바로 반영한다

  const toggleMute = () => {
    if (!audio.muted) stopSpeaking() // 지금 읽던 발언도 바로 끊는다
    setAudio((a) => ({ ...a, muted: !a.muted }))
  }

  return (
    <div className="audio">
      {engine && <span className="engine">{engine}</span>}
      <button className="btn ghost small" aria-pressed={!audio.muted} onClick={toggleMute}>
        {audio.muted ? '음성 꺼짐' : '음성 켜짐'}
      </button>
      <label className="rate">
        <span>말하기 속도</span>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={audio.rate}
          onChange={(e) => setAudio((a) => ({ ...a, rate: Number(e.target.value) }))}
        />
        <output>{audio.rate.toFixed(1)}배</output>
      </label>
    </div>
  )
}

function AuthBadge({ auth }) {
  if (!auth) return <span className="badge">계정 확인 중</span>
  if (auth.loggedIn) {
    const sub = auth.method === 'claude.ai'
    return (
      <span className={`badge ${sub ? 'ok' : 'warn'}`} title={sub ? '각자 로그인한 구독 사용량에서 차감됩니다' : ''}>
        {sub ? `내 구독 사용 중 (${auth.plan})` : `${auth.method} 인증 — 과금될 수 있습니다`}
      </span>
    )
  }
  return <span className="badge warn">{auth.installed === false ? 'claude 미설치' : 'claude 로그인 필요'}</span>
}

// 로그인 안 된 사람에게 시작 전에 할 일을 알려 준다
function AuthGuide({ auth }) {
  if (!auth || auth.loggedIn) return null
  return (
    <section className="guide" role="alert">
      <strong>{auth.installed === false ? 'Claude Code 가 설치돼 있지 않습니다' : 'Claude 에 로그인해야 토론을 시작할 수 있습니다'}</strong>
      <p>
        토론자는 이 컴퓨터에 로그인한 각자의 Claude 구독으로 말합니다. 터미널에서 아래를 실행한 뒤 이 페이지를 새로고침하세요.
      </p>
      <pre>
        {auth.installed === false ? 'npm install -g @anthropic-ai/claude-code\nclaude auth login' : 'claude auth login'}
      </pre>
    </section>
  )
}

function Setup({ config, setConfig, auth, onStart }) {
  const set = (patch) => setConfig((c) => ({ ...c, ...patch }))
  const setDebater = (i, patch) =>
    set({ debaters: config.debaters.map((d, j) => (j === i ? { ...d, ...patch } : d)) })
  const resize = (n) =>
    set({ debaters: Array.from({ length: n }, (_, i) => config.debaters[i] ?? seatFor(i)) })
  const n = config.debaters.length
  const ready = config.problem.trim() && auth?.loggedIn

  return (
    <main className="setup">
      <AuthGuide auth={auth} />
      <section className="caption-box setup-problem">
        <label htmlFor="problem">토론에 맡길 문제</label>
        <textarea
          id="problem"
          rows={4}
          placeholder="예: 다섯 명짜리 팀이 주 4일제를 도입해도 될까? / xpert-creative-lab 의 인증 구조, 지금 이대로 괜찮을까?"
          value={config.problem}
          onChange={(e) => set({ problem: e.target.value })}
        />
      </section>

      <section className="setup-row">
        <div className="mod-card">
          <Face seed={config.moderator.seed} size={64} />
          <button
            className="btn small"
            onClick={() => set({ moderator: { ...config.moderator, seed: randomSeed() } })}
            aria-label="사회자 얼굴 바꾸기"
          >
            얼굴 바꾸기
          </button>
        </div>
        <div className="field">
          <label htmlFor="mod-model">사회자 모델</label>
          <select
            id="mod-model"
            value={config.moderator.model}
            onChange={(e) => set({ moderator: { ...config.moderator, model: e.target.value } })}
          >
            {MODELS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field-label">사회자 목소리</span>
          <VoicePicker
            label="사회자 목소리"
            value={config.moderator.voice}
            onChange={(voice) => set({ moderator: { ...config.moderator, voice } })}
          />
        </div>
        <div className="field">
          <span className="field-label">토론자 수</span>
          <div className="stepper">
            <button className="btn small" onClick={() => resize(n - 1)} disabled={n <= 2} aria-label="토론자 줄이기">
              −
            </button>
            <strong>{n}명</strong>
            <button className="btn small" onClick={() => resize(n + 1)} disabled={n >= 5} aria-label="토론자 늘리기">
              +
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="rounds">최대 라운드</label>
          <select id="rounds" value={config.maxRounds} onChange={(e) => set({ maxRounds: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((r) => (
              <option key={r} value={r}>
                {r}라운드
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="setup-seats" style={{ '--cols': n }}>
        {config.debaters.map((d, i) => (
          <div className="seat-card" key={d.id} style={{ '--c': d.color }}>
            <div className="seat-face">
              <Face seed={d.seed} size={88} />
              <button className="btn small" onClick={() => setDebater(i, { seed: randomSeed() })} aria-label={`${d.name} 얼굴 바꾸기`}>
                얼굴 바꾸기
              </button>
            </div>
            <input
              className="seat-name"
              aria-label={`토론자 ${i + 1} 이름`}
              value={d.name}
              onChange={(e) => setDebater(i, { name: e.target.value })}
            />
            <select
              aria-label={`${d.name} 모델`}
              value={d.model}
              onChange={(e) => setDebater(i, { model: e.target.value })}
            >
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <VoicePicker label={`${d.name} 목소리`} value={d.voice} onChange={(voice) => setDebater(i, { voice })} />
            <textarea
              aria-label={`${d.name} 관점`}
              rows={3}
              value={d.stance}
              onChange={(e) => setDebater(i, { stance: e.target.value })}
            />
          </div>
        ))}
      </section>

      <button className="btn primary start" disabled={!ready} onClick={onStart}>
        토론 시작
      </button>
    </main>
  )
}

const SAMPLE = '안녕하세요. 이 목소리로 토론에 참여하겠습니다.'

function VoicePicker({ label, value, onChange }) {
  const [busy, setBusy] = useState(false)
  const preview = async () => {
    stopSpeaking()
    setBusy(true)
    await play(SAMPLE, synthesize(SAMPLE, value), { rate: 1 })
    setBusy(false)
  }
  return (
    <div className="voice-pick">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {VOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
      <button className="btn small" onClick={preview} disabled={busy}>
        {busy ? '재생 중' : '미리 듣기'}
      </button>
    </div>
  )
}

function CopyResult({ config, view }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(toPrompt(config, view))
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <button className="btn small copy" onClick={copy}>
      {copied ? '복사했습니다' : '결과 복사'}
    </button>
  )
}

function Stage({ config, view, computing, speaking, status, error, onRetry }) {
  const [viewed, setViewed] = useState(null)
  const finalRef = useRef(null)
  const { rounds } = view
  const shown = viewed ?? rounds.length - 1
  const round = rounds[shown]
  const live = shown === rounds.length - 1
  const byId = Object.fromEntries(config.debaters.map((d) => [d.id, d]))
  const modFainted = view.fainted.includes('mod')

  useEffect(() => setViewed(null), [rounds.length]) // 새 라운드가 열리면 최신으로 따라간다
  useEffect(() => {
    if (view.final) finalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [view.final])

  const phaseIdx = PHASES.findIndex((p) => p.key === view.phase)
  const ended = view.phase === 'final'
  const canCopy = rounds.length > 0 && status !== 'running'

  return (
    <main className="stage">
      <section className="caption-box user-cut">
        <span className="who">사용자</span>
        <p>{config.problem}</p>
        {view.codebase && <p className="code-path">대상 코드: {view.codebase} (읽기 전용)</p>}
      </section>

      <section className={`moderator-cut ${speaking === 'mod' ? 'speaking' : ''} ${modFainted ? 'fainted' : ''}`}>
        <div className="mod-avatar">
          <Face seed={config.moderator.seed} size={64} talking={speaking === 'mod'} fainted={modFainted} />
          <span className="mic-badge" aria-hidden>
            <Mic />
          </span>
        </div>
        <div className="mod-body">
          <span className="who">
            사회자 <span className="chip">{config.moderator.model}</span>
          </span>
          <p className={`mod-line ${computing === 'mod' ? 'busy' : ''}`}>
            {modFainted
              ? '사회자가 사용량 한도에 걸려 기절했습니다.'
              : view.modLine || (computing === 'mod' ? '사용자의 문제를 읽고 첫 논제를 정하고 있습니다' : '무대를 준비하고 있습니다')}
          </p>
        </div>
        <ol className="phases" aria-label="진행 단계">
          {PHASES.map((p, i) => (
            <li key={p.key} className={ended || i < phaseIdx ? 'past' : i === phaseIdx ? 'now' : ''}>
              {p.label}
            </li>
          ))}
        </ol>
      </section>

      {status === 'error' && (
        <div className="alert" role="alert">
          호출이 실패해 토론이 멈췄습니다: {error}
          <button className="btn small" onClick={onRetry}>
            처음부터 다시
          </button>
          {canCopy && <CopyResult config={config} view={view} />}
        </div>
      )}
      {status === 'stopped' && (
        <div className="alert">
          토론을 중단했습니다.
          {canCopy && <CopyResult config={config} view={view} />}
        </div>
      )}
      {status === 'fainted' && (
        <div className="alert faint-alert" role="alert">
          사회자가 기절해 토론이 멈췄습니다. 사용량 한도가 풀린 뒤 다시 시작하세요.
          {canCopy && <CopyResult config={config} view={view} />}
        </div>
      )}

      {round && (
        <>
          <nav className="round-bar">
            <div className="round-tabs" role="tablist">
              {rounds.map((_, i) => (
                <button key={i} role="tab" aria-selected={i === shown} className={i === shown ? 'on' : ''} onClick={() => setViewed(i)}>
                  라운드 {i + 1}
                </button>
              ))}
            </div>
            <p className="topic">{round.topic}</p>
          </nav>

          <section className="strip" style={{ '--cols': config.debaters.length }}>
            {config.debaters.map((d, i) => (
              <Panel
                key={`${shown}-${d.id}`}
                d={d}
                i={i}
                seat={round.seats[d.id]}
                thinking={live && computing === d.id}
                speaking={live && speaking === d.id}
                fainted={view.fainted.includes(d.id)}
              />
            ))}
          </section>

          <Messenger
            round={round}
            byId={byId}
            moderator={config.moderator}
            next={live && computing && status === 'running' ? (computing === 'mod' ? '사회자' : byId[computing].name) : null}
            speaking={live ? speaking : null}
          />
        </>
      )}

      {view.final && (
        <section className="final-cut" ref={finalRef}>
          <div className="final-head">
            <span className="who">최종 결론</span>
            <CopyResult config={config} view={view} />
          </div>
          <h2>{view.final.headline}</h2>
          <p className="final-answer">{view.final.answer}</p>
          {view.final.keyPoints.length > 0 && (
            <ul>
              {view.final.keyPoints.map((k, i) => (
                <li key={i}>{k}</li>
              ))}
            </ul>
          )}
          {view.final.dissent && (
            <p className="dissent">
              <strong>남은 이견</strong> {view.final.dissent}
            </p>
          )}
        </section>
      )}
    </main>
  )
}

function Panel({ d, i, seat, thinking, speaking, fainted }) {
  const [open, setOpen] = useState(false)
  const lit = seat?.lit || fainted

  return (
    <article
      className={`panel ${lit ? 'lit' : 'dark'} ${speaking ? 'speaking' : ''} ${fainted ? 'fainted' : ''}`}
      style={{ '--c': d.color, '--tilt': `${i % 2 ? 0.6 : -0.6}deg` }}
    >
      <header className="panel-head">
        <strong>{d.name}</strong>
        <span className="chip">{d.model}</span>
      </header>
      <div className="figure">
        <Face seed={d.seed} size={132} silhouette={!lit} talking={speaking} fainted={fainted} />
        {!lit && <span className={`thinking ${thinking ? 'on' : ''}`}>{thinking ? '생각 중…' : '차례를 기다리는 중'}</span>}
        {lit && !fainted && <span className="burst" aria-hidden>짜잔!</span>}
        {fainted && <span className="ko">기절</span>}
        {speaking && <span className="on-air">발언 중</span>}
      </div>
      {fainted && <p className="faint-note">사용량 한도에 걸려 쓰러졌습니다</p>}
      {seat?.summary && (
        <div className="bubbles">
          <div className="bubble">
            {seat.summary}
            <button className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? '전문 접기' : '전문 보기'}
            </button>
            {open && <p className="full">{seat.opinion}</p>}
          </div>
        </div>
      )}
    </article>
  )
}

const KIND_LABEL = { briefing: '쟁점 정리', verdict: '라운드 정리', conclusion: '결론', question: '질문', answer: '답변' }

function Messenger({ round, byId, moderator, next, speaking }) {
  const listRef = useRef(null)
  const { messages } = round

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, next])

  return (
    <section className="messenger" aria-label="토론 대화">
      <header className="messenger-head">
        <strong>토론 대화</strong>
        <span>라운드 {round.n}</span>
      </header>
      <ol className="messages" ref={listRef} aria-live="polite">
        {messages.length === 0 && <li className="empty">첫 의견이 모두 나오면 사회자가 쟁점을 정리하며 대화가 시작됩니다.</li>}
        {messages.map((m, i) => {
          const mod = m.from === 'mod'
          const d = byId[m.from]
          const isLive = speaking === m.from && i === messages.length - 1
          return (
            <li key={i} className={`msg ${mod ? 'from-mod' : ''} ${isLive ? 'live' : ''}`} style={{ '--c': d?.color }}>
              <span className="avatar" aria-hidden>
                <Face seed={mod ? moderator.seed : d.seed} size={40} talking={isLive} />
              </span>
              <div className="msg-body">
                <span className="msg-meta">
                  <strong>{mod ? '사회자' : d.name}</strong>
                  {m.to && <span className="to">→ {byId[m.to].name}</span>}
                  {KIND_LABEL[m.kind] && <span className="kind">{KIND_LABEL[m.kind]}</span>}
                </span>
                <div className="msg-bubble">
                  {m.quote && <blockquote>{m.quote}</blockquote>}
                  {m.changed && <span className="stamp">입장 변화</span>}
                  {m.text}
                </div>
              </div>
            </li>
          )
        })}
        {next && (
          <li className="msg typing-row">
            <span className="typing-label">{next} 님이 다음 발언을 준비하고 있습니다</span>
            <Dots />
          </li>
        )}
      </ol>
    </section>
  )
}

// 말하는 동안 입을 여닫는다
function useMouth(talking) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!talking) return setOpen(false)
    const t = setInterval(() => setOpen((o) => !o), 170)
    return () => clearInterval(t)
  }, [talking])
  return open
}

function Face({ seed, size, talking = false, fainted = false, silhouette = false }) {
  const open = useMouth(talking && !fainted)
  const mood = fainted ? 'faint' : open ? 'talk' : 'idle'
  return (
    <img
      className={`face ${silhouette ? 'silhouette' : ''} ${fainted ? 'down' : ''}`}
      src={avatarUri(seed, mood)}
      width={size}
      height={size}
      alt=""
    />
  )
}

const Dots = () => (
  <span className="dots" aria-hidden>
    <i />
    <i />
    <i />
  </span>
)

const Mic = () => (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
  </svg>
)
