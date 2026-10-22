// 토론 진행 엔진. 발언을 "대본 이벤트"로 emit 하고, 화면은 그걸 한 줄씩 재생한다.
// 엔진은 재생을 기다리지 않으므로 앞사람 발언을 읽는 동안 다음 사람을 계산한다.
export const PHASES = [
  { key: 'topic', label: '논제' },
  { key: 'opinion', label: '의견' },
  { key: 'briefing', label: '쟁점 정리' },
  { key: 'question', label: '질문' },
  { key: 'conclusion', label: '결론' },
  { key: 'verdict', label: '판정' },
]

const str = { type: 'string' }
// codex 의 구조화 출력은 additionalProperties:false 와 전 필드 required 를 요구한다(claude 도 그대로 받는다)
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const NO_MARKDOWN = ' 화면 말풍선에 그대로 뜨고 음성으로 읽히므로 마크다운 기호(**, #, -)를 쓰지 않는다.'

const CODE_NOTE =
  ' 토론 대상 코드베이스가 현재 작업 폴더에 있다. 주장할 때는 Read·Grep·Glob 으로 실제 코드를 확인하고 파일 경로를 근거로 든다. 탐색은 필요한 만큼만 짧게 한다.'

const MODERATOR_SYSTEM =
  '너는 AI 토론 프로그램의 사회자다. 사용자가 맡긴 문제를 풀기 위해 논제를 설계하고, 토론자들의 의견 차이를 드러내고, 결론으로 이끈다. 공정하고 간결하게 한국어로 말한다.' +
  NO_MARKDOWN

const debaterSystem = (d, code) =>
  `너는 AI 토론 프로그램의 토론자 "${d.name}"이다. 너의 관점: ${d.stance || '자유'}. ` +
  '한국어 구어체로 말한다. 자기 관점을 분명히 하되 근거를 든다. 앞사람의 좋은 논거는 인정하고 입장을 바꿀 수도 있다.' +
  NO_MARKDOWN +
  (code ? CODE_NOTE : '')

const roster = (debaters) => debaters.map((d) => `- ${d.id}: ${d.name} (관점: ${d.stance || '자유'})`).join('\n')

// caughtUp: 화면 재생이 지금까지의 대본을 다 읽을 때까지 기다린다. 라운드가 겹쳐 진행되지 않게 라운드 경계에서만 쓴다
export async function runDebate(config, { ask, emit, live = () => {}, caughtUp = async () => {} }) {
  const { problem, moderator, debaters, maxRounds, projects = [] } = config
  let codebase = config.codebase || '' // 비어 있으면 아래에서 사회자가 프로젝트 목록 중에 고른다
  const byId = Object.fromEntries(debaters.map((d) => [d.id, d]))
  const rounds = []
  const fainted = new Set() // 사용량 한도에 걸려 쓰러진 토론자

  // live: 지금 누가 계산 중인지. 재생 대기열을 건너뛰고 바로 화면에 반영된다.
  // 구조화 응답이 비어 오면 그 단계만 한 번 더 부른다(토론 전체를 다시 하지 않게)
  const call = async (who, req) => {
    live(who)
    try {
      for (let attempt = 0; ; attempt++) {
        const { data } = await ask({ ...req, who }) // who: 화면이 로그인 끊김 안내에 누구 차례인지 보여 줄 때 쓴다
        if (data) return data
        if (attempt >= 1) throw new Error('모델 응답이 형식에 맞지 않습니다')
      }
    } finally {
      live(null)
    }
  }
  const say = (from, kind, text, extra = {}) => emit({ type: 'say', from, kind, text, ...extra })
  // 사회자가 쓰러지면 토론을 멈춘다. 호출부는 faint 표시가 붙은 오류를 받는다
  const askModerator = async (prompt, schema) => {
    try {
      return await call('mod', { model: moderator.model, system: MODERATOR_SYSTEM, prompt, schema })
    } catch (e) {
      if (e.limit) {
        emit({ type: 'faint', who: 'mod' })
        e.faint = true
      }
      throw e
    }
  }
  // 토론자가 쓰러지면 null 을 돌려주고, 그 사람을 빼고 계속한다.
  // 코드는 의견·답변처럼 근거가 필요한 단계에서만 연다. 호출마다 저장소를 새로 읽어 토큰이 크기 때문
  const askDebater = async (d, prompt, schema, withCode = false) => {
    // codex 샌드박스는 디스크 읽기를 막지 못해, 저장소 속 지시에 끌려 폴더 밖을 읽을 수 있다. 폴더에 가둘 수 있는 claude 만 코드를 연다
    const code = withCode && !d.model.startsWith('codex:') ? codebase : ''
    try {
      return await call(d.id, { model: d.model, system: debaterSystem(d, code), prompt, schema, codebase: code })
    } catch (e) {
      if (!e.limit) throw e
      fainted.add(d.id)
      emit({ type: 'faint', who: d.id, reason: e.reason ?? 'limit' })
      const why = { auth: '로그인이 끊겨 자리를 떠났습니다', error: '연결 문제로 자리를 떠났습니다' }[e.reason] ?? '기절했습니다'
      say('mod', 'relay', `${d.name} 님이 ${why}. 남은 분들로 계속하겠습니다.`)
      return null
    }
  }
  const standing = (list) => list.filter((d) => !fainted.has(d.id))
  const phase = (key) => emit({ type: 'phase', phase: key })

  const pastRounds = (seatId) =>
    rounds
      .filter((r) => r.verdict)
      .map((r, i) => {
        const mine = seatId && r.conclusions[seatId] ? `\n  내 결론: ${r.conclusions[seatId]}` : ''
        return `라운드 ${i + 1} 논제: ${r.topic}\n  사회자 정리: ${r.verdict.roundSummary}${mine}`
      })
      .join('\n')
  const context = (d, round) => {
    const past = pastRounds(d.id)
    return `사용자가 풀려는 문제: ${problem}\n${past ? `\n지난 라운드:\n${past}\n` : ''}\n이번 논제: ${round.topic}`
  }

  phase('topic')
  if (!codebase && projects.length) {
    // 사회자는 번호와 폴더 이름만 보고 고른다. 홈 경로는 보내지 않고, 내용은 고른 뒤에야 읽을 수 있다
    const names = projects.map((p, i) => `${i}. ${p.split('/').slice(-2).join('/')}`).join('\n')
    const pick = await askModerator(
      `사용자가 풀려는 문제:\n${problem}\n\n이 컴퓨터의 프로젝트 폴더:\n${names}\n\n문제가 이 중 특정 프로젝트의 코드에 대한 것이면 가장 알맞은 폴더 번호를 index 로 골라라. 프로젝트 이름이 정확히 같지 않아도 줄임말·한글 이름·비슷한 이름이면 고른다. 코드와 무관한 문제면 -1.`,
      obj({ index: { type: 'integer', enum: [-1, ...projects.keys()] } }),
    )
    if (projects[pick.index]) {
      codebase = projects[pick.index]
      emit({ type: 'codebase', path: codebase })
      say('mod', 'relay', `${codebase.split('/').at(-1)} 프로젝트 코드를 직접 보면서 토론하겠습니다.`)
    }
  }
  const opening = await askModerator(
    `사용자가 풀려는 문제:\n${problem}\n\n토론자:\n${roster(debaters)}\n\n이 문제를 풀기 위한 첫 라운드 논제를 하나 정하라. topic 은 제목처럼 짧은 한 문장(40자 이내)이고 근거나 세부 내용은 intro 에 넣는다. intro 는 토론자들에게 논제를 던지는 사회자의 한두 문장 멘트다.`,
    obj({ topic: str, intro: str }),
  )
  let next = opening

  for (let n = 1; n <= maxRounds; n++) {
    if (n > 1) await caughtUp() // 앞 라운드를 다 들은 뒤에 다음 라운드 계산을 시작한다
    // 라운드마다 첫 발언자를 한 칸씩 돌린다
    const alive = standing(debaters)
    if (!alive.length) break
    const start = (n - 1) % alive.length
    const order = [...alive.slice(start), ...alive.slice(0, start)]
    const spoke = () => order.filter((d) => round.opinions[d.id] && !fainted.has(d.id))
    const round = { topic: next.topic, opinions: {}, summaries: {}, qa: [], conclusions: {}, verdict: null }
    rounds.push(round)
    emit({ type: 'round', n, topic: round.topic })
    say('mod', 'intro', next.intro)

    phase('opinion')
    for (const d of order) {
      const heard = order
        .filter((o) => round.opinions[o.id])
        .map((o) => `[${o.name}] ${round.opinions[o.id]}`)
        .join('\n\n')
      const data = await askDebater(
        d,
        `${context(d, round)}\n\n${heard ? `앞서 발언한 토론자:\n${heard}\n\n앞사람 발언을 들었다. 동의하거나 반박할 지점이 있으면 짚으면서 ` : ''}이 논제에 대한 너의 의견을 밝혀라. opinion 은 근거를 포함한 전문(400자 안팎), summary 는 말로 읽을 한두 문장 요약이다.`,
        obj({ opinion: str, summary: str }),
        true,
      )
      if (!data) continue
      round.opinions[d.id] = data.opinion
      round.summaries[d.id] = data.summary
      say('mod', 'call', `${d.name} 님, 의견 부탁드립니다.`)
      say(d.id, 'opinion', data.summary, { opinion: data.opinion })
    }

    if (!spoke().length) break
    phase('briefing')
    const opinions = spoke().map((d) => `[${d.id} ${d.name}] ${round.opinions[d.id]}`).join('\n\n')
    const briefing = await askModerator(
      `문제: ${problem}\n논제: ${round.topic}\n\n토론자 의견:\n${opinions}\n\noverview 는 쟁점을 정리한 사회자 멘트(두 문장 이내)다. briefings 에는 토론자마다 그와 다른 의견을 그 토론자에게 들려줄 말로 두 문장 이내에 담아라(id 는 토론자 id).`,
      obj({ overview: str, briefings: { type: 'array', items: obj({ id: str, contrast: str }) } }),
    )
    const contrast = Object.fromEntries(briefing.briefings.filter((b) => byId[b.id]).map((b) => [b.id, b.contrast]))
    say('mod', 'briefing', briefing.overview)

    // 질문: 사회자가 한 명에게 다른 의견을 전하면 그 사람이 묻고 바로 답을 듣는다.
    // 다른 의견을 한꺼번에 쏟지 않고 차례마다 전해야 대화가 이어진다
    phase('question')
    const summaries = spoke()
      .map((d) => `[${d.id} ${d.name}] ${round.summaries[d.id]}`)
      .join('\n')
    const qaLog = () =>
      round.qa.map((q) => `${byId[q.from].name} → ${byId[q.to].name}: ${q.question}\n  답: ${q.answer}`).join('\n')
    for (const d of spoke()) {
      if (fainted.has(d.id)) continue
      const others = spoke()
        .filter((o) => o.id !== d.id)
        .map((o) => o.id)
      // 질문을 계산하는 동안 사회자가 다른 의견을 읽어 준다
      if (contrast[d.id]) say('mod', 'contrast', contrast[d.id], { to: d.id })
      const asked = await askDebater(
        d,
        `${context(d, round)}\n\n너의 의견: ${round.opinions[d.id]}\n\n토론자 요약:\n${summaries}\n\n사회자가 전한 너와 다른 의견: ${contrast[d.id] ?? ''}\n\n${round.qa.length ? `앞선 질의응답:\n${qaLog()}\n\n` : ''}너와 의견이 가장 다른 토론자 한 명을 골라, 그 차이를 파고드는 질문을 한 문장으로 하나 하라(ask=true, to=상대 id). 앞선 질의응답과 겹치면 다른 지점을 물어라. 상대 의견에 이미 완전히 동의할 때만 ask=false 로 두고 to·question 은 빈 문자열.`,
        obj({ ask: { type: 'boolean' }, to: { type: 'string', enum: [...others, ''] }, question: str }),
      )
      if (!asked) continue
      if (!(asked.ask && others.includes(asked.to) && asked.question)) {
        say('mod', 'relay', `${d.name} 님은 질문 없이 넘어갑니다.`)
        continue
      }
      const target = byId[asked.to]
      say(d.id, 'question', asked.question, { to: target.id })
      const reply = await askDebater(
        target,
        `${context(target, round)}\n\n너의 의견: ${round.opinions[target.id]}\n\n사회자를 통해 ${d.name}의 질문이 왔다: ${asked.question}\n\n세 문장 이내로 성실하게 답하라.`,
        obj({ answer: str }),
        true,
      )
      if (!reply) continue
      round.qa.push({ from: d.id, to: target.id, question: asked.question, answer: reply.answer })
      say('mod', 'relay', `${target.name} 님, ${d.name} 님의 질문에 답해 주세요.`)
      say(target.id, 'answer', reply.answer, { to: d.id, quote: asked.question })
    }

    phase('conclusion')
    say('mod', 'relay', '질의응답을 마쳤습니다. 이번 라운드의 결론을 차례로 말씀해 주세요.')
    for (const d of spoke()) {
      if (fainted.has(d.id)) continue
      const heard = order
        .filter((o) => round.conclusions[o.id])
        .map((o) => `[${o.name}] ${round.conclusions[o.id]}`)
        .join('\n')
      const data = await askDebater(
        d,
        `${context(d, round)}\n\n너의 처음 의견: ${round.opinions[d.id]}\n\n토론자 요약:\n${summaries}\n\n질의응답:\n${qaLog() || '(없음)'}\n\n${heard ? `앞서 말한 결론:\n${heard}\n\n` : ''}이번 라운드에 대한 너의 결론을 두세 문장으로 말하라. changed 는 처음 의견에서 입장이 바뀌었는지 여부다.`,
        obj({ conclusion: str, changed: { type: 'boolean' } }),
      )
      if (!data) continue
      round.conclusions[d.id] = data.conclusion
      say(d.id, 'conclusion', data.conclusion, { changed: data.changed })
    }

    phase('verdict')
    const last = n === maxRounds
    const conclusions = order
      .filter((d) => round.conclusions[d.id])
      .map((d) => `[${d.name}] ${round.conclusions[d.id]}`)
      .join('\n')
    const past = pastRounds()
    const verdict = await askModerator(
      `문제: ${problem}\n${past ? `지난 라운드:\n${past}\n` : ''}이번 논제: ${round.topic}\n\n토론자 결론:\n${conclusions}\n\n질의응답:\n${qaLog() || '(없음)'}\n\n` +
        (last
          ? '이번이 마지막 라운드다. done=true 로 두고 nextTopic·nextIntro 는 빈 문자열.'
          : '사용자 문제에 답하기에 논의가 충분하면 done=true. 더 따져야 할 쟁점이 남았으면 done=false 와 함께 nextTopic(다음 논제, 40자 이내 한 문장)·nextIntro(논제를 던지는 멘트)를 채워라.') +
        ' roundSummary 는 이번 라운드 정리(세 문장 이내), reason 은 판단 이유를 한 문장으로.',
      obj({ roundSummary: str, done: { type: 'boolean' }, reason: str, nextTopic: str, nextIntro: str }),
    )
    round.verdict = verdict
    say('mod', 'verdict', `${verdict.roundSummary} ${verdict.reason}`)
    if (verdict.done || last || !verdict.nextTopic) break
    next = { topic: verdict.nextTopic, intro: verdict.nextIntro }
    phase('topic')
  }

  phase('final')
  const final = await askModerator(
    `사용자가 풀려는 문제:\n${problem}\n\n토론 경과:\n${pastRounds()}\n\n사용자에게 줄 최종 결론을 써라. headline 은 한 줄 결론, answer 는 본문(근거 포함, 다섯 문장 이내), keyPoints 는 핵심 근거 3~5개, dissent 는 끝까지 남은 이견 한두 문장(없으면 빈 문자열).`,
    obj({ headline: str, answer: str, keyPoints: { type: 'array', items: str }, dissent: str }),
  )
  emit({ type: 'final', final })
  say('mod', 'final', `${final.headline} ${final.answer}`)
  return { rounds, final }
}
