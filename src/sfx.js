// 효과음: 파일 없이 Web Audio 로 합성한다. 음성을 가리지 않게 짧고 작게, 전체 음량은 master 하나로 묶는다
let ctx = null
let master = null
let enabled = true

export const setSfx = (on) => {
  enabled = on
}

function audio() {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = 0.32
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

// 한 음: 빠르게 올라갔다가 지수로 줄어드는 봉투(envelope). slide 를 주면 음높이가 미끄러진다
function tone(freq, { at = 0, dur = 0.18, type = 'sine', vol = 0.5, slide, attack = 0.006 } = {}) {
  const c = audio()
  const t = c.currentTime + at
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(vol, t + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(gain).connect(master)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

// 잡음: 북·심벌·도장 소리의 "치" 성분. 필터로 결을 바꾼다
function noise({ at = 0, dur = 0.2, vol = 0.4, type = 'highpass', freq = 4000 } = {}) {
  const c = audio()
  const t = c.currentTime + at
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const filter = c.createBiquadFilter()
  filter.type = type
  filter.frequency.value = freq
  const gain = c.createGain()
  gain.gain.setValueAtTime(vol, t)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(filter).connect(gain).connect(master)
  src.start(t)
  src.stop(t + dur)
}

const SOUNDS = {
  // 지목받아 불이 켜질 때: 반짝이는 상승 아르페지오 "짜잔"
  reveal() {
    ;[523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.055, dur: 0.22, type: 'triangle', vol: 0.32 }))
    tone(2093, { at: 0.22, dur: 0.35, vol: 0.12 })
  },
  // 질문: 맑은 종소리 "띵"
  question() {
    tone(1318, { dur: 0.6, vol: 0.35 })
    tone(2637, { dur: 0.35, vol: 0.08 })
    tone(988, { at: 0.12, dur: 0.5, vol: 0.2 })
  },
  // 입장 변화 도장: 낮게 떨어지는 "쿵" 과 종이 치는 소리
  stamp() {
    tone(140, { dur: 0.25, vol: 0.7, slide: 55 })
    noise({ dur: 0.12, vol: 0.3, type: 'lowpass', freq: 1800 })
  },
  // 기절: 빙글 돌며 내려가는 "뿅~"
  faint() {
    tone(880, { dur: 0.7, type: 'square', vol: 0.12, slide: 110 })
    tone(1320, { at: 0.05, dur: 0.6, vol: 0.08, slide: 165 })
  },
  // 라운드 시작: 짧은 스네어 롤 뒤 심벌
  round() {
    for (let i = 0; i < 7; i++) noise({ at: i * 0.045, dur: 0.05, vol: 0.12 + i * 0.03, type: 'bandpass', freq: 2200 })
    tone(98, { at: 0.32, dur: 0.3, vol: 0.6, slide: 60 })
    noise({ at: 0.32, dur: 0.9, vol: 0.28, freq: 6000 })
  },
  // 최종 결론: 짧은 팡파르
  fanfare() {
    const notes = [
      [523, 0],
      [659, 0.12],
      [784, 0.24],
      [1047, 0.38],
    ]
    for (const [f, at] of notes) {
      tone(f, { at, dur: 0.32, type: 'sawtooth', vol: 0.12 })
      tone(f / 2, { at, dur: 0.32, type: 'triangle', vol: 0.2 })
    }
    for (const f of [523, 659, 784, 1047]) tone(f, { at: 0.52, dur: 0.9, type: 'triangle', vol: 0.16 })
    noise({ at: 0.52, dur: 0.8, vol: 0.12, freq: 7000 })
  },
  // 멈춤·오류: 낮은 두 번 알림
  alert() {
    tone(330, { dur: 0.14, type: 'square', vol: 0.12 })
    tone(247, { at: 0.17, dur: 0.22, type: 'square', vol: 0.12 })
  },
}

export function sfx(name) {
  if (!enabled) return
  try {
    SOUNDS[name]?.()
  } catch {
    // 오디오 장치가 없거나 막혀 있어도 토론은 계속한다
  }
}
