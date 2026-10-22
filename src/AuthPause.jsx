// 토론 중 호출이 막혔을 때: 토론을 그 자리에 세워 두고, 해결되면 실패한 호출부터 이어 간다.
// kind=auth 는 로그인 끊김(다시 로그인), kind=error 는 그 밖의 오류(네트워크 등, 다시 시도)
import { useState } from 'react'
import { openLogin, verifyLogin } from './api.js'

const NAMES = { claude: 'Claude', codex: 'Codex' }
const COMMANDS = { claude: 'claude auth login', codex: 'codex logout && codex login' }

export default function AuthPause({ issue }) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const name = NAMES[issue.provider] ?? issue.provider
  const auth = issue.kind !== 'error'

  const resume = async () => {
    if (!auth) return issue.resolve('retry')
    setChecking(true)
    setError('')
    try {
      await verifyLogin(issue.provider)
      issue.resolve('retry')
    } catch {
      setError('아직 로그인이 확인되지 않습니다. 터미널에서 로그인을 마쳤는지 확인해 주세요.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="pause-backdrop" role="dialog" aria-modal="true" aria-labelledby="pause-title">
      <section className="pause-card">
        <h2 id="pause-title">{auth ? `${name} 로그인이 끊겼습니다` : `${issue.who} 차례에서 호출이 실패했습니다`}</h2>
        <p>
          {issue.who} 차례에서 멈췄습니다. {auth ? '다시 로그인하면' : '다시 시도하면'} 이 발언부터 이어서 진행합니다. 앞 발언은 다시 계산하지
          않습니다.
        </p>
        {auth ? (
          <ol>
            <li>
              "다시 로그인"을 누르면 터미널이 열리고 <code>{COMMANDS[issue.provider]}</code> 가 실행됩니다.
            </li>
            <li>브라우저에서 로그인을 마친 뒤 "로그인했어요"를 누르세요.</li>
          </ol>
        ) : (
          <p className="error-detail">{issue.message}</p>
        )}
        {error && <p className="bad-text">{error}</p>}
        <div className="pause-actions">
          {auth && (
            <button className="btn" onClick={() => openLogin(issue.provider)}>
              다시 로그인
            </button>
          )}
          <button className="btn primary small-primary" onClick={resume} disabled={checking}>
            {checking ? '확인하는 중…' : auth ? '로그인했어요, 이어서 진행' : '다시 시도'}
          </button>
        </div>
        <div className="pause-actions secondary">
          {issue.canSkip && (
            <button className="link" onClick={() => issue.resolve('skip')}>
              {issue.who} 빼고 진행
            </button>
          )}
          <button className="link" onClick={() => issue.resolve('stop')}>
            토론 중단
          </button>
        </div>
      </section>
    </div>
  )
}
