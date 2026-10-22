// 재생 리모컨: 이전 다시 듣기 · 일시정지 · 다음 발언 · 속도 · 음소거. 단축키는 App 에서 같은 동작에 묶는다
const Icon = ({ d }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d={d} />
  </svg>
)
const PREV = 'M6 5h2v14H6zM20 5v14l-11-7z'
const NEXT = 'M16 5h2v14h-2zM4 5v14l11-7z'
const PLAY = 'M7 4v16l13-8z'
const PAUSE = 'M6 4h4v16H6zM14 4h4v16h-4z'
const SOUND = 'M4 9v6h4l5 4V5L8 9zm12 3a4 4 0 0 0-2-3.5v7A4 4 0 0 0 16 12zm-2-8v2a6 6 0 0 1 0 12v2a8 8 0 0 0 0-16z'
const NOTE = 'M9 3v10.6A3.5 3.5 0 1 0 11 17V8h6V3z'
const NOTE_OFF = 'M9 3v10.6A3.5 3.5 0 1 0 11 17V8h6V3zM3.3 2 2 3.3l18.7 18.7 1.3-1.3z'
const MUTE = 'M4 9v6h4l5 4V5L8 9zm16.6 0L19 7.4 16.4 10 13.8 7.4 12.4 9l2.6 2.6-2.6 2.6 1.4 1.4 2.6-2.6 2.6 2.6 1.4-1.4-2.6-2.6z'

export default function Remote({ audio, onRate, onMute, onSfx, paused, waiting, onPrev, onToggle, onNext, notice }) {
  return (
    <nav className="remote" aria-label="재생 조작">
      {notice ? (
        <span className="remote-wait" role="status">
          {notice}
        </span>
      ) : waiting && (
        <span className="remote-wait" role="status">
          <span className="spinner" aria-hidden /> 다음 발언을 준비하고 있습니다
        </span>
      )}
      <button className="rbtn" onClick={onPrev} title="이전 발언 다시 듣기 (←)" aria-label="이전 발언 다시 듣기">
        <Icon d={PREV} />
        <kbd>←</kbd>
      </button>
      <button className="rbtn main" onClick={onToggle} title="일시정지 / 재생 (Space)" aria-label={paused ? '재생' : '일시정지'}>
        <Icon d={paused ? PLAY : PAUSE} />
        <kbd>Space</kbd>
      </button>
      <button className="rbtn" onClick={onNext} title="다음 발언 (→)" aria-label="다음 발언">
        <Icon d={NEXT} />
        <kbd>→</kbd>
      </button>
      <span className="rsep" aria-hidden />
      <div className="rrate" role="group" aria-label="말하기 속도">
        <button className="rbtn small" onClick={() => onRate(-0.1)} aria-label="느리게" title="느리게 (↓)">
          −
        </button>
        <output>{audio.rate.toFixed(1)}배</output>
        <button className="rbtn small" onClick={() => onRate(0.1)} aria-label="빠르게" title="빠르게 (↑)">
          +
        </button>
        <kbd>↑↓</kbd>
      </div>
      <button className="rbtn" onClick={onMute} aria-pressed={audio.muted} title="음소거 (M)" aria-label={audio.muted ? '소리 켜기' : '음소거'}>
        <Icon d={audio.muted ? MUTE : SOUND} />
        <kbd>M</kbd>
      </button>
      <button className="rbtn" onClick={onSfx} aria-pressed={!audio.sfx} title="효과음 켜기·끄기 (S)" aria-label={audio.sfx ? '효과음 끄기' : '효과음 켜기'}>
        <Icon d={audio.sfx ? NOTE : NOTE_OFF} />
        <kbd>S</kbd>
      </button>
    </nav>
  )
}
