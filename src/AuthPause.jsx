// 토론 중 로그인이 끊겼을 때: 토론을 그 자리에 세워 두고, 다시 로그인하면 실패한 호출부터 이어 간다
import { useState } from 'react'
import { openLogin, verifyLogin } from './api.js'

const NAMES = { claude: 'Claude', codex: 'Codex' }
const COMMANDS = { claude: 'claude auth login', codex: 'codex logout && codex login' }

export default function AuthPause({ issue }) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const name = NAMES[issue.provider] ?? issue.provider

  const resume = async () => {
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
        <h2 id="pause-title">{name} 로그인이 끊겼습니다</h2>
        <p>
          {issue.who} 차례에서 멈췄습니다. 다시 로그인하면 이 발언부터 이어서 진행합니다. 앞 발언은 다시 계산하지 않습니다.
        </p>
        <ol>
          <li>
            "다시 로그인"을 누르면 터미널이 열리고 <code>{COMMANDS[issue.provider]}</code> 가 실행됩니다.
          </li>
          <li>브라우저에서 로그인을 마친 뒤 "로그인했어요"를 누르세요.</li>
        </ol>
        {error && <p className="bad-text">{error}</p>}
        <div className="pause-actions">
          <button className="btn" onClick={() => openLogin(issue.provider)}>
            다시 로그인
          </button>
          <button className="btn primary small-primary" onClick={resume} disabled={checking}>
            {checking ? '확인하는 중…' : '로그인했어요, 이어서 진행'}
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
