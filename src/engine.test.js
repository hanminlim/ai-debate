import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDebate } from './engine.js'
import { applyEvent, initialView, toPrompt } from './script.js'

const debaters = [
  { id: 'd1', name: '루나', model: 'haiku', stance: '실용' },
  { id: 'd2', name: '솔', model: 'haiku', stance: '회의' },
]
const config = (maxRounds) => ({ problem: '문제', moderator: { model: 'opus' }, debaters, maxRounds })

// 스키마 필드만 보고 그럴듯한 응답을 만든다. 판정은 doneAt 번째에 끝낸다
function fakeAsk({ doneAt = 1, question } = {}) {
  let verdicts = 0
  const prompts = []
  const ask = async (req) => {
    prompts.push(req)
    const keys = Object.keys(req.schema.properties)
    if (keys.includes('done')) {
      verdicts++
      return { data: { roundSummary: `정리${verdicts}`, done: verdicts >= doneAt, reason: '이유', nextTopic: `논제${verdicts + 1}`, nextIntro: '다음' } }
    }
    if (keys.includes('ask')) return { data: question?.(req) ?? { ask: false, to: '', question: '' } }
    const name = req.system.match(/"(.+?)"/)?.[1]
    const data = {
      topic: { topic: '논제1', intro: '시작' },
      path: { path: '/repo/app' },
      opinion: { opinion: `${name} 의견 전문`, summary: `${name} 요약` },
      overview: { overview: '쟁점', briefings: [{ id: 'd1', contrast: '솔은 반대' }, { id: 'zz', contrast: '없는 id' }] },
      answer: { answer: '답' },
      conclusion: { conclusion: `${name} 결론`, changed: false },
      headline: { headline: '최종', answer: '본문', keyPoints: ['a'], dissent: '' },
    }[keys[0]]
    return { data }
  }
  return { ask, prompts }
}

async function play(maxRounds, opts) {
  const { ask, prompts } = fakeAsk(opts)
  const events = []
  const result = await runDebate(config(maxRounds), { ask, emit: (e) => events.push(e) })
  return { result, events, prompts, says: events.filter((e) => e.type === 'say') }
}

test('판정이 done 이면 그 라운드에서 끝내고 최종 결론을 낸다', async () => {
  const { result, events } = await play(5, { doneAt: 2 })
  assert.deepEqual(
    events.filter((e) => e.type === 'round').map((e) => e.topic),
    ['논제1', '논제2'],
  )
  assert.equal(result.final.headline, '최종')
  assert.equal(events.at(-2).type, 'final')
})

test('maxRounds 에 닿으면 판정과 무관하게 끝낸다', async () => {
  const { events } = await play(1, { doneAt: 99 })
  assert.equal(events.filter((e) => e.type === 'round').length, 1)
})

test('의견은 차례로 말하고 뒷사람은 앞사람 의견을 듣는다. 첫 발언자는 라운드마다 돈다', async () => {
  const { says, prompts } = await play(2, { doneAt: 2 })
  const opinionOrder = says.filter((s) => s.kind === 'opinion').map((s) => s.from)
  assert.deepEqual(opinionOrder, ['d1', 'd2', 'd2', 'd1'])
  const solFirst = prompts.find((p) => p.system.includes('"솔"') && 'opinion' in p.schema.properties)
  assert.match(solFirst.prompt, /\[루나\] 루나 의견 전문/)
  // 발언 직전에 사회자가 지목한다
  const i = says.findIndex((s) => s.kind === 'opinion')
  assert.equal(says[i - 1].kind, 'call')
})

test('재생하면 의견은 컷에 켜지고, 이후 발언만 메신저에 쌓인다', async () => {
  const { events } = await play(1)
  const view = events.reduce(applyEvent, initialView)
  const round = view.rounds[0]
  assert.deepEqual(round.seats.d2, { lit: true, summary: '솔 요약', opinion: '솔 의견 전문' })
  const kinds = new Set(round.messages.map((m) => m.kind))
  for (const k of ['intro', 'call', 'opinion', 'final']) assert.ok(!kinds.has(k), k)
  assert.ok(kinds.has('briefing') && kinds.has('conclusion') && kinds.has('verdict'))
  assert.equal(view.final.headline, '최종')
  assert.equal(view.phase, 'final')
  assert.equal(round.intro, '시작') // 논제 소개 멘트는 라운드에 남는다
})

test('결과 복사는 "~를 논의한 결과 ~ 결론" 형식의 프롬프트가 된다', async () => {
  const question = (req) =>
    req.system.includes('"솔"') ? { ask: true, to: 'd1', question: '근거가 뭔가요?' } : { ask: false, to: '', question: '' }
  const { events } = await play(1, { question })
  const view = events.reduce(applyEvent, initialView)
  const text = toPrompt(config(1), view)
  assert.ok(text.startsWith('「문제」를 두고 AI 토론자 2명이 1라운드 논의한 결과, 다음 결론이 났다.'))
  assert.match(text, /## 결론\n최종\n\n본문/)
  assert.match(text, /- 루나\(실용\): 루나 요약 → 결론: 루나 결론/)
  assert.match(text, /- 솔 → 루나 질문: 근거가 뭔가요\? \/ 답: 답/)

  // 결론 전에 멈춘 토론도 복사할 수 있다
  const partial = toPrompt(config(1), { ...view, final: null })
  assert.match(partial, /최종 결론 전에 멈췄다/)
})

const limitError = () => Object.assign(new Error('usage limit reached'), { limit: true })

test('토론자가 한도에 걸리면 기절하고 나머지끼리 끝까지 간다', async () => {
  const base = fakeAsk({ doneAt: 2 }).ask
  const ask = async (req) => {
    if (req.system.includes('"솔"') && 'conclusion' in req.schema.properties) throw limitError()
    return base(req)
  }
  const events = []
  const result = await runDebate(config(2), { ask, emit: (e) => events.push(e) })
  assert.deepEqual(
    events.filter((e) => e.type === 'faint').map((e) => e.who),
    ['d2'],
  )
  assert.equal(result.final.headline, '최종')
  // 2라운드에는 솔이 발언하지 않는다
  const round2 = events.slice(events.findIndex((e) => e.type === 'round' && e.n === 2))
  assert.ok(!round2.some((e) => e.type === 'say' && e.from === 'd2'))
  const view = events.reduce(applyEvent, initialView)
  assert.deepEqual(view.fainted, ['d2'])
})

test('사회자가 한도에 걸리면 기절 이벤트를 내고 토론을 멈춘다', async () => {
  const base = fakeAsk().ask
  const ask = async (req) => {
    if ('overview' in req.schema.properties) throw limitError()
    return base(req)
  }
  const events = []
  await assert.rejects(runDebate(config(1), { ask, emit: (e) => events.push(e) }), (e) => e.faint === true)
  assert.equal(events.at(-1).type, 'faint')
  assert.equal(events.at(-1).who, 'mod')
})

test('코드 폴더를 주면 모든 호출에 실어 보내고 프롬프트에 코드 확인 지시를 넣는다', async () => {
  const { ask, prompts } = fakeAsk()
  await runDebate({ ...config(1), codebase: '/repo' }, { ask, emit: () => {} })
  assert.ok(prompts.every((p) => p.codebase === '/repo' && p.system.includes('Read·Grep·Glob')))
})

test('프로젝트 목록을 주면 사회자가 하나 골라 이후 모든 호출을 그 폴더로 보낸다', async () => {
  const { ask, prompts } = fakeAsk()
  const events = []
  await runDebate({ ...config(1), projects: ['/repo/app', '/repo/other'] }, { ask, emit: (e) => events.push(e) })
  assert.deepEqual(prompts[0].schema.properties.path.enum, ['/repo/app', '/repo/other', ''])
  assert.equal(prompts[0].codebase, '') // 고르기 전에는 아무 폴더도 열지 않는다
  assert.ok(prompts.slice(1).every((p) => p.codebase === '/repo/app'))
  assert.deepEqual(events.find((e) => e.type === 'codebase'), { type: 'codebase', path: '/repo/app' })
  assert.equal(events.reduce(applyEvent, initialView).codebase, '/repo/app')
})

test('프로젝트 목록이 없으면 고르는 단계 없이 일반 토론을 한다', async () => {
  const { ask, prompts } = fakeAsk()
  await runDebate(config(1), { ask, emit: () => {} })
  assert.ok(!prompts.some((p) => 'path' in p.schema.properties))
  assert.ok(prompts.every((p) => !p.codebase && !p.system.includes('Read·Grep·Glob')))
})

test('질문은 바로 상대 답으로 이어지고, 자기 자신 지목은 버린다', async () => {
  const question = (req) =>
    req.system.includes('"솔"')
      ? { ask: true, to: 'd1', question: '근거가 뭔가요?' }
      : { ask: true, to: 'd1', question: '자기 자신에게 질문' }
  const { says } = await play(1, { question })
  const qa = says.filter((s) => ['question', 'answer'].includes(s.kind)).map(({ from, kind, to }) => ({ from, kind, to }))
  assert.deepEqual(qa, [
    { from: 'd2', kind: 'question', to: 'd1' },
    { from: 'd1', kind: 'answer', to: 'd2' },
  ])
  assert.ok(says.some((s) => s.kind === 'relay' && s.text.includes('루나 님은 질문 없이')))
  // 다른 의견은 한꺼번에가 아니라 그 사람 차례 직전에 전한다
  const contrastAt = says.findIndex((s) => s.kind === 'contrast')
  assert.equal(says[contrastAt].to, 'd1')
  assert.ok(says[contrastAt + 1].text.includes('루나 님은 질문 없이'))
  assert.equal(says.filter((s) => s.kind === 'contrast').length, 1)
})
