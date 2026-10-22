import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { claudeArgs, codebaseDir, isLimitError } from './ask.js'

test('코드 폴더가 있으면 읽기 전용 도구만, 없으면 도구 없이 부른다. 어느 쪽이든 restricted', () => {
  const base = { model: 'haiku', system: 's' }
  const withCode = claudeArgs({ ...base, codebase: '/repo' })
  const without = claudeArgs(base)
  assert.equal(withCode[withCode.indexOf('--tools') + 1], 'Read,Grep,Glob')
  assert.equal(without[without.indexOf('--tools') + 1], '')
  for (const args of [withCode, without]) assert.ok(args.includes('--restricted') && args.includes('--safe-mode'))
})

test('코드 폴더는 실제로 있는 절대 경로 디렉터리만 받는다', () => {
  assert.equal(codebaseDir(''), null)
  assert.equal(codebaseDir(tmpdir()), tmpdir())
  assert.throws(() => codebaseDir('relative/path'), /절대 경로/)
  assert.throws(() => codebaseDir('/no/such/dir/xyz'), /찾을 수 없습니다/)
  assert.throws(() => codebaseDir(new URL(import.meta.url).pathname), /폴더가 아닙니다/)
})

test('사용량 한도 오류를 알아본다', () => {
  assert.ok(isLimitError(429))
  assert.ok(isLimitError(0, 'Claude AI usage limit reached|1792660800'))
  assert.ok(isLimitError(null, "You've hit your limit · resets 6pm"))
  assert.ok(!isLimitError(500, 'Internal server error'))
})
