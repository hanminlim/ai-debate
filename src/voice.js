// 음성: Supertonic(로컬 TTS 서버)이 만든 오디오를 재생하고, 엔진이 없으면 시스템 음성으로 대신한다.
// 오디오 재생이라 말하는 도중에도 속도를 바로 바꾸고, 멈췄다 이어 들을 수 있다
import { ttsAudio } from './api.js'

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
let paused = false // 음소거 중 기다리기(wait)도 일시정지에 맞춰 멈추게 한다

export function setRate(rate) {
  if (current?.audio) current.audio.playbackRate = rate
}

export function stopSpeaking() {
  current?.stop()
  speechSynthesis.cancel()
}

export function pauseSpeaking() {
  paused = true
  current?.audio?.pause()
  speechSynthesis.pause()
}

export function resumeSpeaking() {
  paused = false
  current?.audio?.play().catch(() => {})
  speechSynthesis.resume()
}

// 발언이 대본에 올라오는 즉시 불러 두면, 앞사람이 말하는 동안 다음 음성이 만들어진다
export function synthesize(text, voice) {
  return ttsAudio(text, voice)
    .then((buf) => new Blob([buf], { type: 'audio/wav' }))
    .catch(() => null)
}

const aborted = (signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    signal?.addEventListener('abort', () => resolve(), { once: true })
  })

// 음소거일 때 읽는 시간만큼 기다린다. 일시정지된 동안은 시간이 흐르지 않는다
const wait = (ms, signal) =>
  new Promise((resolve) => {
    let left = ms
    const t = setInterval(() => {
      if (!paused) left -= 100
      if (left <= 0) done()
    }, 100)
    function done() {
      clearInterval(t)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
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

// 시스템 음성: 음성 엔진이 없을 때만 쓴다. 속도는 다음 문장부터 반영된다
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
      function done() {
        if (current?.stop === stop) current = null
        resolve()
      }
      const stop = () => (speechSynthesis.cancel(), done())
      current = { stop }
      u.onend = done
      u.onerror = done
      signal?.addEventListener('abort', stop, { once: true })
      speechSynthesis.speak(u)
    })
  }
}

// audio: synthesize() 가 돌려준 Promise. 만드는 중에 넘기기(abort)해도 기다리지 않고 바로 돌아간다
export async function play(text, audio, { rate, muted, signal, who = 0 }) {
  if (muted) return wait(Math.min(600 + text.length * 30, 5000) / rate, signal)
  const blob = await Promise.race([audio, aborted(signal).then(() => null)])
  if (signal?.aborted) return
  return blob ? playBlob(blob, rate, signal) : speakWeb(text, { rate, signal, who })
}
