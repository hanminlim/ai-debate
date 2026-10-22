// 새 버전 알림: 앱을 열 때 GitHub Release 를 확인하고, 누르면 받아서 서명을 검증한 뒤 다시 실행한다
import { useEffect, useState } from 'react'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'

export default function Update() {
  const [update, setUpdate] = useState(null)
  const [progress, setProgress] = useState(null) // null: 대기, 숫자: 받는 중(%), 'done'
  const [error, setError] = useState('')

  useEffect(() => {
    check()
      .then(setUpdate)
      .catch(() => {}) // 오프라인이거나 릴리즈가 없으면 조용히 넘어간다
  }, [])

  if (!update) return null

  const install = async () => {
    setError('')
    let total = 0
    let got = 0
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0
        if (e.event === 'Progress') {
          got += e.data.chunkLength
          setProgress(total ? Math.round((got / total) * 100) : 0)
        }
        if (e.event === 'Finished') setProgress('done')
      })
      await relaunch()
    } catch (e) {
      setProgress(null)
      setError(String(e))
    }
  }

  return (
    <div className="update" role="status">
      {progress === null ? (
        <button className="btn small" onClick={install} title={error || update.body || ''}>
          새 버전 {update.version} 설치
        </button>
      ) : (
        <span className="badge">{progress === 'done' ? '다시 시작하는 중…' : `받는 중 ${progress}%`}</span>
      )}
      {error && <span className="badge warn">업데이트 실패</span>}
    </div>
  )
}
