// 음성: Supertonic(로컬 TTS 서버)이 만든 오디오를 재생하고, 서버가 없으면 브라우저 내장 음성으로 대신한다.
// 오디오 재생이라 말하는 도중에도 속도를 바로 바꿀 수 있다
export const VOICES = [
  { id: 'F1', label: '여성 1' },
  { id: 'F2', label: '여성 2' },
  { id: 'F3', label: '여성 3' },
  { id: 'F4', label: '여성 4' },
  { id: 'F5', label: '여성 5' },
  { id: 'M1', label: '남성 1' },
  { id: 'M2', label: '남성 2' },
  { id: 'M3', label: '남성 3' },
  { id: 'M4', label: '남성 4' },
  { id: 'M5', label: '남성 5' },
]

let current = null // 지금 재생 중인 것: { audio?, stop }

export function setRate(rate) {
  if (current?.audio) current.audio.playbackRate = rate
}

export function stopSpeaking() {
  current?.stop()
  speechSynthesis.cancel()
}

export const ttsHealth = () =>
  fetch('/api/tts-health')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

// 발언이 대본에 올라오는 즉시 불러 두면, 앞사람이 말하는 동안 다음 음성이 만들어진다
export function synthesize(text, voice) {
  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, lang: 'ko', response_format: 'wav' }),
  })
    .then((r) => (r.ok ? r.blob() : null))
    .catch(() => null)
}

const wait = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

function playBlob(blob, rate, signal) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audio.playbackRate = rate // preservesPitch 기본값이 true 라 빨라져도 목소리 높이는 그대로다
    const stop = () => {
      audio.pause()
      done()
    }
    function done() {
      if (current?.audio === audio) current = null
      URL.revokeObjectURL(url)
      resolve()
    }
    current = { audio, stop }
    audio.onended = done
    audio.onerror = done
    signal?.addEventListener('abort', stop, { once: true })
    audio.play().catch(done)
  })
}

// 브라우저 내장 음성: Supertonic 서버가 없을 때만 쓴다. 속도는 다음 문장부터 반영된다
const ko = () => speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('ko'))

async function speakWeb(text, { rate, signal, who }) {
  const voices = ko()
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    if (signal?.aborted || !sentence.trim()) continue
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(sentence)
      u.lang = 'ko-KR'
      u.voice = voices[who % (voices.length || 1)] ?? null
      u.rate = rate
      // onend 가 안 오는 크롬 버그 대비: 읽는 시간 추정치를 넘기면 다음으로 넘어간다
      const guard = setTimeout(done, (sentence.length * 250) / rate + 4000)
      function done() {
        clearTimeout(guard)
        if (current?.stop === done) current = null
        resolve()
      }
      current = { stop: () => (speechSynthesis.cancel(), done()) }
      u.onend = done
      u.onerror = done
      signal?.addEventListener('abort', current.stop, { once: true })
      speechSynthesis.speak(u)
    })
  }
}

// audio: synthesize() 가 돌려준 Promise. who: 브라우저 음성 대체 시 목소리를 고르는 순번
export async function play(text, audio, { rate, muted, signal, who = 0 }) {
  if (muted) return wait(Math.min(600 + text.length * 30, 5000) / rate, signal)
  const blob = await audio
  if (signal?.aborted) return
  return blob ? playBlob(blob, rate, signal) : speakWeb(text, { rate, signal, who })
}
