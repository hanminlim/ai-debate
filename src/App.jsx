import { useEffect, useRef, useState } from 'react'
import { ask, listProjects } from './api.js'
import { ANCHOR, avatarUri, randomSeed } from './avatar.js'
import { PHASES, runDebate } from './engine.js'
import AuthPause from './AuthPause.jsx'
import Gate from './Gate.jsx'
import Remote from './Remote.jsx'
import Update from './Update.jsx'
import { applyEvent, initialView, toPrompt } from './script.js'
import { VOICES, pauseSpeaking, play, resumeSpeaking, setRate, stopSpeaking, synthesize } from './voice.js'

const COLORS = ['#FF4F81', '#2FB5F0', '#3DCB7A', '#A27BFF', '#FF8A2B']
const PRESETS = [
  { name: '한민', stance: '실용주의 — 당장 실행 가능한 답을 찾는다' },
  { name: '다정', stance: '회의론 — 숨은 위험과 반례를 먼저 본다' },
  { name: '성욱', stance: '낙관론 — 기회와 가능성에 무게를 둔다' },
  { name: '성현', stance: '원칙주의 — 일관된 기준과 장기 영향을 따진다' },
  { name: '원이', stance: '발산형 — 남들이 안 본 대안을 꺼낸다' },
]

const SEAT_VOICES = ['M2', 'F1', 'M3', 'M4', 'F3'] // 한민·다정·성욱·성현·원이 순. 다정·원이는 여성 목소리
const seatFor = (i, model = '') => ({
  id: `d${i + 1}`,
  ...PRESETS[i],
  model,
  voice: SEAT_VOICES[i],
  color: COLORS[i],
  seed: randomSeed(),
})

// 연결 확인에서 받은 모델 중 기본값: 사회자는 Opus, 토론자는 Sonnet 계열을 먼저 고른다
const pick = (models, word) => (models.find((m) => m.value.includes(word)) ?? models[0])?.value ?? ''

const ROUND_END = new Set(['verdict', 'final'])

const clampRate = (r) => Math.round(Math.min(2, Math.max(0.5, r)) * 10) / 10

export default function App() {
  const [models, setModels] = useState([])
  const [config, setConfig] = useState({
    problem: '',
    moderator: { model: '', voice: 'M1', seed: ANCHOR },
    debaters: [0, 1, 2].map((i) => seatFor(i)),
    maxRounds: 3,
  })
  const [audio, setAudio] = useState({ rate: 1.2, muted: false })
  const [view, setView] = useState(initialView)
  const [computing, setComputing] = useState(null) // 지금 계산 중인 사람: 'mod' | 토론자 id
  const [speaking, setSpeaking] = useState(null) // 지금 읽는 대본 이벤트
  const [paused, setPaused] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [status, setStatus] = useState('gate') // gate | setup | running | done | stopped | fainted | error
  const [error, setError] = useState('')

  const run = useRef(null)
  const audioRef = useRef(audio)
  audioRef.current = audio

  useEffect(() => setRate(audio.rate), [audio.rate]) // 말하는 도중에도 바로 반영한다

  const ready = ({ models: list }) => {
    setModels(list)
    const has = (v) => list.some((m) => m.value === v)
    setConfig((c) => ({
      ...c,
      moderator: { ...c.moderator, model: has(c.moderator.model) ? c.moderator.model : pick(list, 'opus') },
      debaters: c.debaters.map((d) => ({ ...d, model: has(d.model) ? d.model : pick(list, 'sonnet') })),
    }))
    setStatus('setup')
  }

  // 재생기: 엔진이 쌓은 대본(events)을 cursor 위치부터 한 줄씩 재생한다.
  // 처음 보는 이벤트만 화면에 반영하고, 이전으로 돌아가면 이미 본 발언을 다시 읽기만 한다
  const wake = (r) => {
    r.wake?.()
    r.wake = null
  }
  const sleep = (r) => new Promise((resolve) => (r.wake = resolve))

  const pump = async (r) => {
    if (r.playing) return
    r.playing = true
    while (!r.ctrl.signal.aborted) {
      if (r.paused) {
        await sleep(r)
        continue
      }
      if (r.cursor >= r.events.length) {
        drained(r)
        if (r.engineDone) break
        setWaiting(true)
        await sleep(r)
        setWaiting(false)
        continue
      }
      const i = r.cursor++
      const e = r.events[i]
      if (i >= r.applied) {
        setView((v) => applyEvent(v, e))
        r.applied = i + 1
      }
      if (e.type !== 'say') continue
      r.current = i
      r.item = new AbortController() // 넘기기·이전은 이 발언만 끊는다
      setSpeaking(e)
      const who = config.debaters.findIndex((d) => d.id === e.from) + 1 // 사회자는 0
      await play(e.text, e.audio, { ...audioRef.current, who, signal: r.item.signal })
      setSpeaking(null)
      r.current = -1
    }
    r.playing = false
    setWaiting(false)
    if (r.engineDone && r.cursor >= r.events.length && !r.ctrl.signal.aborted) setStatus(r.endStatus ?? 'done')
  }

  const voiceOf = (from) => (from === 'mod' ? config.moderator : config.debaters.find((d) => d.id === from)).voice

  // 재생이 쌓인 대본을 다 읽었을 때 엔진에 알린다(라운드 경계에서 엔진이 기다린다)
  const drained = (r) => {
    for (const resolve of r.drainWaiters ?? []) resolve()
    r.drainWaiters = []
  }
  const caughtUp = (r) =>
    new Promise((resolve) => {
      if (r.ctrl.signal.aborted || (!r.playing && r.cursor >= r.events.length)) return resolve()
      ;(r.drainWaiters ??= []).push(resolve)
    })

  // 로그인이 끊기면 토론을 세워 두고 사용자의 선택을 기다린다: 다시 로그인해 이어 가기 / 그 토론자 빼기 / 중단
  const [authIssue, setAuthIssue] = useState(null)
  const authRef = useRef(null)
  const askWithLogin = async (req, r) => {
    const { who, ...rest } = req
    for (;;) {
      try {
        return await ask(rest, r.ctrl.signal)
      } catch (e) {
        if (!e.auth || r.ctrl.signal.aborted) throw e
        const name = who === 'mod' ? '사회자' : config.debaters.find((d) => d.id === who)?.name ?? who
        const choice = await new Promise((resolve) => {
          authRef.current = { provider: e.provider, who: name, canSkip: who !== 'mod', resolve }
          setAuthIssue(authRef.current)
        })
        authRef.current = null
        setAuthIssue(null)
        if (choice === 'retry') continue
        if (choice === 'skip') throw Object.assign(new Error(e.message), { limit: true, reason: 'auth' })
        stop()
        throw e
      }
    }
  }

  const start = async () => {
    const r = { ctrl: new AbortController(), events: [], cursor: 0, applied: 0, current: -1, paused: false, engineDone: false }
    r.ctrl.signal.addEventListener('abort', () => r.item?.abort())
    run.current = r
    setView(initialView)
    setError('')
    setPaused(false)
    setStatus('running')
    try {
      // 문제가 가리키는 프로젝트를 사회자가 고를 수 있게 이 맥의 프로젝트 폴더 목록을 넘긴다
      const projects = await listProjects(config.problem)
      if (r.ctrl.signal.aborted) return
      await runDebate(
        { ...config, projects },
        {
          ask: (req) => askWithLogin(req, r),
          caughtUp: () => caughtUp(r),
          emit: (e) => {
            if (r.ctrl.signal.aborted) return
            // 음소거 중에는 음성을 만들지 않는다(다시 켜면 그 발언은 시스템 음성으로 읽는다)
            if (e.type === 'say') e.audio = audioRef.current.muted ? Promise.resolve(null) : synthesize(e.text, voiceOf(e.from))
            r.events.push(e)
            wake(r)
            pump(r)
          },
          live: (who) => !r.ctrl.signal.aborted && setComputing(who),
        },
      )
      r.engineDone = true
      wake(r)
      pump(r)
    } catch (e) {
      if (r.ctrl.signal.aborted) return
      if (e.faint) {
        // 사회자 기절: 남은 대본(기절 장면)까지 재생한 뒤 멈춘다
        r.endStatus = 'fainted'
        r.engineDone = true
        wake(r)
        pump(r)
        return
      }
      setError(e.message)
      setStatus('error')
    }
  }

  const stop = () => {
    authRef.current?.resolve('stop')
    if (run.current) drained(run.current)
    run.current?.ctrl.abort()
    wake(run.current ?? {})
    stopSpeaking()
    setComputing(null)
    setSpeaking(null)
    setWaiting(false)
    setStatus('stopped')
  }

  // 리모컨 동작
  const unpause = (r) => {
    r.paused = false
    setPaused(false)
    resumeSpeaking()
  }
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef(null)
  const notify = (text) => {
    setNotice(text)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(''), 1800)
  }

  // 라운드를 마무리하는 판정·최종 결론은 넘길 수 없다. 연타해도 라운드 경계를 넘지 않게 한다
  const next = () => {
    const r = run.current
    if (!r) return
    if (ROUND_END.has(r.events[r.current]?.kind)) return notify('라운드 정리는 끝까지 들은 뒤 다음 라운드로 넘어갑니다')
    if (r.paused) unpause(r)
    r.item?.abort() // 아직 만드는 중인 음성도 기다리지 않는다. 다음이 없으면 로딩이 뜬다
    wake(r)
  }
  const prev = () => {
    const r = run.current
    if (!r) return
    // 이번 라운드 안에서만 되돌아간다. 라운드 첫 발언이면 그 발언을 다시 듣는다
    const base = r.current >= 0 ? r.current : r.cursor
    let start = base
    while (start > 0 && r.events[start - 1].type !== 'round') start--
    let j = base - 1
    while (j >= start && r.events[j].type !== 'say') j--
    if (j < start) {
      j = r.events.findIndex((e, i) => i >= start && e.type === 'say')
      notify('이번 라운드의 첫 발언입니다')
    }
    if (j < 0) return
    if (r.paused) unpause(r)
    r.cursor = j
    r.item?.abort()
    wake(r)
    pump(r)
  }
  const toggle = () => {
    const r = run.current
    if (!r) return
    if (r.paused) {
      unpause(r)
      wake(r)
    } else {
      r.paused = true
      setPaused(true)
      pauseSpeaking()
    }
  }
  const changeRate = (d) => setAudio((a) => ({ ...a, rate: clampRate(a.rate + d) }))
  const mute = () => {
    if (!audioRef.current.muted) run.current?.item?.abort() // 지금 읽던 발언도 바로 끊는다
    setAudio((a) => ({ ...a, muted: !a.muted }))
  }

  const onStage = !['gate', 'manage', 'setup'].includes(status)
  const keys = useRef({})
  keys.current = { ArrowRight: next, ArrowLeft: prev, ' ': toggle, ArrowUp: () => changeRate(0.1), ArrowDown: () => changeRate(-0.1), m: mute, M: mute }
  useEffect(() => {
    if (!onStage) return
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      const action = keys.current[e.key]
      if (!action) return
      e.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onStage])

  const providers = [...new Set(models.map((m) => m.provider))]

  return (
    <div className={`app ${onStage ? 'with-remote' : ''}`}>
      <header className="topbar">
        <h1 className="logo">토론 무대</h1>
        <Update />
        {providers.length > 0 && (
          <span className="badge ok" title="각자 로그인한 구독 사용량에서 차감됩니다">
            연결됨: {providers.map((p) => (p === 'claude' ? 'Claude' : 'Codex')).join(' · ')}
          </span>
        )}
        {status === 'running' && (
          <button className="btn ghost" onClick={stop}>
            토론 중단
          </button>
        )}
        {status === 'setup' && (
          <button className="btn ghost" onClick={() => setStatus('manage')}>
            연결 관리
          </button>
        )}
        {onStage && status !== 'running' && (
          <button className="btn ghost" onClick={() => setStatus('setup')}>
            설정으로
          </button>
        )}
      </header>
      {status === 'gate' && <Gate onReady={ready} />}
      {status === 'manage' && <Gate manual onReady={ready} />}
      {authIssue && <AuthPause issue={authIssue} />}
      {status === 'setup' && <Setup config={config} setConfig={setConfig} models={models} onStart={start} />}
      {onStage && (
        <>
          <Stage
            config={config}
            models={models}
            view={view}
            computing={computing}
            speaking={speaking}
            status={status}
            error={error}
            onRetry={start}
          />
          <Remote
            audio={audio}
            onRate={changeRate}
            onMute={mute}
            paused={paused}
            waiting={waiting && status === 'running'}
            onPrev={prev}
            onToggle={toggle}
            onNext={next}
            notice={notice}
          />
        </>
      )}
    </div>
  )
}

function ModelSelect({ label, value, onChange, models, id }) {
  const groups = [
    ['claude', 'Claude'],
    ['codex', 'Codex'],
  ].filter(([p]) => models.some((m) => m.provider === p))
  return (
    <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map(([p, name]) => (
        <optgroup key={p} label={name}>
          {models
            .filter((m) => m.provider === p)
            .map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  )
}

const labelOf = (models, value) => models.find((m) => m.value === value)?.label ?? value.split(':').pop()

function Setup({ config, setConfig, models, onStart }) {
  const set = (patch) => setConfig((c) => ({ ...c, ...patch }))
  const setDebater = (i, patch) =>
    set({ debaters: config.debaters.map((d, j) => (j === i ? { ...d, ...patch } : d)) })
  const resize = (n) =>
    set({ debaters: Array.from({ length: n }, (_, i) => config.debaters[i] ?? seatFor(i, config.debaters[0].model)) })
  const n = config.debaters.length
  const ready = config.problem.trim()

  return (
    <main className="setup">
      <section className="caption-box setup-problem">
        <label htmlFor="problem">토론에 맡길 문제</label>
        <textarea
          id="problem"
          rows={4}
          placeholder="예: 다섯 명짜리 팀이 주 4일제를 도입해도 될까?"
          value={config.problem}
          onChange={(e) => set({ problem: e.target.value })}
        />
      </section>

      <section className="setup-row">
        <div className="host-card">
          <Face seed={config.moderator.seed} size={84} />
          <div className="host-fields">
            <strong className="card-title">사회자</strong>
            <div className="field">
              <label htmlFor="mod-model">모델</label>
              <ModelSelect
                id="mod-model"
                label="사회자 모델"
                models={models}
                value={config.moderator.model}
                onChange={(model) => set({ moderator: { ...config.moderator, model } })}
              />
            </div>
            <div className="field">
              <span className="field-label">목소리</span>
              <VoicePicker
                label="사회자 목소리"
                value={config.moderator.voice}
                onChange={(voice) => set({ moderator: { ...config.moderator, voice } })}
              />
            </div>
          </div>
        </div>

        <div className="rule-card">
          <strong className="card-title">진행</strong>
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
            <ModelSelect label={`${d.name} 모델`} models={models} value={d.model} onChange={(model) => setDebater(i, { model })} />
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

function Stage({ config, models, view, computing, speaking, status, error, onRetry }) {
  const [viewed, setViewed] = useState(null)
  const finalRef = useRef(null)
  const { rounds } = view
  const shown = viewed ?? rounds.length - 1
  const round = rounds[shown]
  const live = shown === rounds.length - 1
  const byId = Object.fromEntries(config.debaters.map((d) => [d.id, d]))
  const modFainted = view.fainted.includes('mod')

  const roundRef = useRef(null)
  // 새 라운드가 열리면 최신 탭으로 돌아가고, 두 번째 라운드부터는 화면도 논제로 올린다
  useEffect(() => {
    setViewed(null)
    const el = roundRef.current
    if (rounds.length > 1 && el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 16, behavior: 'smooth' })
  }, [rounds.length])
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

      <section className={`moderator-cut ${speaking?.from === 'mod' ? 'speaking' : ''} ${modFainted ? 'fainted' : ''}`}>
        <div className="mod-avatar">
          <Face seed={config.moderator.seed} size={64} talking={speaking?.from === 'mod'} fainted={modFainted} />
          <span className="mic-badge" aria-hidden>
            <Mic />
          </span>
        </div>
        <div className="mod-body">
          <span className="who">
            사회자 <span className="chip">{labelOf(models, config.moderator.model)}</span>
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
          <nav className="round-bar" ref={roundRef}>
            <div className="round-tabs" role="tablist">
              {rounds.map((_, i) => (
                <button key={i} role="tab" aria-selected={i === shown} className={i === shown ? 'on' : ''} onClick={() => setViewed(i)}>
                  라운드 {i + 1}
                </button>
              ))}
            </div>
            <div className="topic-box">
              <p className="topic">{round.topic}</p>
              {round.intro && <p className="intro">{round.intro}</p>}
            </div>
          </nav>

          <section className="strip" style={{ '--cols': config.debaters.length }}>
            {config.debaters.map((d, i) => (
              <Panel
                key={`${shown}-${d.id}`}
                d={d}
                i={i}
                seat={round.seats[d.id]}
                thinking={live && computing === d.id}
                speaking={speaking?.from === d.id}
                modelLabel={labelOf(models, d.model)}
                fainted={view.fainted.includes(d.id)}
                faintReason={view.faintReason[d.id]}
              />
            ))}
          </section>

          <Messenger
            round={round}
            byId={byId}
            moderator={config.moderator}
            follow={live && status === 'running'}
            next={live && computing && status === 'running' ? (computing === 'mod' ? '사회자' : byId[computing].name) : null}
            speaking={speaking}
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

function Panel({ d, i, seat, thinking, speaking, fainted, faintReason, modelLabel }) {
  const left = faintReason === 'auth' // 로그인이 끊겨 빠진 경우
  const [open, setOpen] = useState(false)
  const lit = seat?.lit || fainted

  return (
    <article
      className={`panel ${lit ? 'lit' : 'dark'} ${speaking ? 'speaking' : ''} ${fainted ? 'fainted' : ''}`}
      style={{ '--c': d.color, '--tilt': `${i % 2 ? 0.6 : -0.6}deg` }}
    >
      <header className="panel-head">
        <strong>{d.name}</strong>
        <span className="chip">{modelLabel}</span>
      </header>
      <div className="figure">
        <Face seed={d.seed} size={132} silhouette={!lit} talking={speaking} fainted={fainted} />
        {!lit && <span className={`thinking ${thinking ? 'on' : ''}`}>{thinking ? '생각 중…' : '차례를 기다리는 중'}</span>}
        {lit && !fainted && <span className="burst" aria-hidden>짜잔!</span>}
        {fainted && <span className="ko">{left ? '퇴장' : '기절'}</span>}
        {speaking && <span className="on-air">발언 중</span>}
      </div>
      {fainted && <p className="faint-note">{left ? '로그인이 끊겨 자리를 떠났습니다' : '사용량 한도에 걸려 쓰러졌습니다'}</p>}
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

function Messenger({ round, byId, moderator, next, speaking, follow }) {
  const listRef = useRef(null)
  const sectionRef = useRef(null)
  const { messages } = round
  const started = messages.length > 0

  // 첫 의견이 끝나고 대화가 시작되면 화면을 대화 창으로 내린다
  useEffect(() => {
    // scrollIntoView 는 안쪽 목록 스크롤과 겹치면 묻혀서 페이지만 직접 내린다
    const el = sectionRef.current
    if (started && follow && el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 16, behavior: 'smooth' })
  }, [started])

  // 읽고 있는 메시지로 따라간다. 이전으로 돌아가 다시 들을 때도 그 메시지를 보여 준다
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const live = el.querySelector('.msg.live')
    el.scrollTo({ top: live ? live.offsetTop - 24 : el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, next, speaking])

  return (
    <section className="messenger" aria-label="토론 대화" ref={sectionRef}>
      <header className="messenger-head">
        <strong>토론 대화</strong>
        <span>라운드 {round.n}</span>
      </header>
      <ol className="messages" ref={listRef} aria-live="polite">
        {messages.length === 0 && <li className="empty">첫 의견이 모두 나오면 사회자가 쟁점을 정리하며 대화가 시작됩니다.</li>}
        {messages.map((m, i) => {
          const mod = m.from === 'mod'
          const d = byId[m.from]
          const isLive = speaking === m
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
