import { createAvatar } from '@dicebear/core'
import { avataaars } from '@dicebear/collection'

// 같은 seed 면 같은 얼굴. 표정(mood)만 바꿔 말하기·기절을 보여 준다
const CALM = {
  eyes: ['default', 'happy', 'side', 'squint', 'wink', 'surprised'],
  eyebrows: ['default', 'defaultNatural', 'flatNatural', 'raisedExcited', 'upDown'],
  mouth: ['default', 'smile', 'serious', 'twinkle'],
}
const MOODS = {
  idle: {},
  talk: { mouth: ['disbelief'] }, // 입을 벌린 프레임. idle 과 번갈아 그려 말하는 것처럼 보인다
  faint: { eyes: ['xDizzy'], eyebrows: ['sadConcerned'], mouth: ['concerned'] },
}

// 사회자는 얼굴을 고정한다: 단정한 옆가르마 짧은 머리, 정장, 차분한 표정의 뉴스 앵커 차림
export const ANCHOR = 'anchor'
const ANCHOR_LOOK = {
  top: ['shortRound'],
  hairColor: ['2c1b18'],
  skinColor: ['edb98a'],
  clothing: ['blazerAndShirt'],
  clothesColor: ['262e33'],
  eyes: ['default'],
  eyebrows: ['defaultNatural'],
  mouth: ['serious'],
  facialHairProbability: 0,
  accessoriesProbability: 0,
}

const cache = new Map()

export function avatarUri(seed, mood = 'idle') {
  const key = `${seed}:${mood}`
  if (!cache.has(key)) {
    const look = seed === ANCHOR ? ANCHOR_LOOK : CALM
    const svg = createAvatar(avataaars, { seed, ...look, ...MOODS[mood], backgroundColor: ['transparent'] })
    cache.set(key, svg.toDataUri())
  }
  return cache.get(key)
}

export const randomSeed = () => Math.random().toString(36).slice(2, 10)
