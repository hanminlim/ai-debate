// 엔진이 낸 대본 이벤트를 화면 상태에 하나씩 반영한다
export const initialView = { phase: 'topic', modLine: '', rounds: [], final: null, fainted: [], faintReason: {}, codebase: '' }

// 첫 의견은 컷에, 나머지 발언은 메신저 창에 쌓는다. 지목·논제 멘트는 상단 사회자 띠에만 둔다
const STRIP_ONLY = new Set(['intro', 'call', 'opinion', 'final'])

export function applyEvent(view, e) {
  if (e.type === 'phase') return { ...view, phase: e.phase }
  if (e.type === 'final') return { ...view, final: e.final }
  if (e.type === 'faint')
    return { ...view, fainted: [...view.fainted, e.who], faintReason: { ...view.faintReason, [e.who]: e.reason ?? 'limit' } }
  if (e.type === 'codebase') return { ...view, codebase: e.path }
  if (e.type === 'round') return { ...view, rounds: [...view.rounds, { n: e.n, topic: e.topic, seats: {}, messages: [] }] }
  if (e.type !== 'say') return view

  // 최종 결론 전문은 아래 결론 컷에 있으니 사회자 띠에는 짧게만 띄운다
  const modLine = e.kind === 'final' ? '최종 결론을 발표합니다' : e.text
  const next = e.from === 'mod' ? { ...view, modLine } : { ...view }
  const round = next.rounds.at(-1)
  if (!round) return next
  // 논제 소개 멘트는 사회자 띠에서 곧 덮이므로 라운드에 남겨 논제 아래에 계속 보여 준다
  const updated =
    e.kind === 'intro'
      ? { ...round, intro: e.text }
      : e.kind === 'opinion'
      ? { ...round, seats: { ...round.seats, [e.from]: { lit: true, summary: e.text, opinion: e.opinion } } }
      : STRIP_ONLY.has(e.kind)
        ? round
        : { ...round, messages: [...round.messages, e] }
  return { ...next, rounds: [...next.rounds.slice(0, -1), updated] }
}

// 토론 결과를 다른 AI 에게 그대로 넘길 수 있는 프롬프트로 만든다
export function toPrompt(config, view) {
  const byId = Object.fromEntries(config.debaters.map((d) => [d.id, d]))
  const name = (id) => (id === 'mod' ? '사회자' : byId[id]?.name)
  const code = view.codebase || config.codebase
  const subject = `「${config.problem}」${code ? `(대상 코드: ${code})` : ''}`
  const head = `${subject}를 두고 AI 토론자 ${config.debaters.length}명이 ${view.rounds.length}라운드 논의`
  const lines = []

  if (view.final) {
    const { headline, answer, keyPoints, dissent } = view.final
    lines.push(`${head}한 결과, 다음 결론이 났다.`, '', '## 결론', headline, '', answer)
    if (keyPoints.length) lines.push('', '## 핵심 근거', ...keyPoints.map((k) => `- ${k}`))
    if (dissent) lines.push('', '## 남은 이견', dissent)
  } else {
    lines.push(`${head}했지만 최종 결론 전에 멈췄다. 지금까지의 논의는 다음과 같다.`)
  }

  lines.push('', '## 논의 경과')
  view.rounds.forEach((round, i) => {
    lines.push('', `### 라운드 ${i + 1}: ${round.topic}`)
    for (const d of config.debaters) {
      const seat = round.seats[d.id]
      if (!seat?.summary) continue
      const c = round.messages.find((m) => m.from === d.id && m.kind === 'conclusion')
      const end = c ? ` → 결론: ${c.text}${c.changed ? ' (입장 바뀜)' : ''}` : ''
      lines.push(`- ${d.name}(${d.stance || '자유'}): ${seat.summary}${end}`)
    }
    for (const m of round.messages.filter((x) => x.kind === 'answer')) {
      lines.push(`- ${name(m.to)} → ${name(m.from)} 질문: ${m.quote} / 답: ${m.text}`)
    }
    const verdict = round.messages.find((m) => m.kind === 'verdict')
    if (verdict) lines.push(`- 사회자 정리: ${verdict.text}`)
  })
  if (view.fainted.length) lines.push('', `(사용량 한도로 중간에 빠진 참가자: ${view.fainted.map(name).join(', ')})`)
  return lines.join('\n')
}
