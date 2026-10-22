import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarUri } from './avatar.js'

const colors = (uri) => new Set(decodeURIComponent(uri).match(/fill="#[0-9a-fA-F]{6}"/g))

test('같은 seed 는 표정이 바뀌어도 같은 사람(피부·머리색)이다', () => {
  const idle = avatarUri('luna')
  const faint = avatarUri('luna', 'faint')
  assert.notEqual(idle, faint)
  for (const c of colors(idle)) assert.ok(colors(faint).has(c), c)
  assert.equal(avatarUri('luna'), idle)
  assert.notEqual(avatarUri('sol'), idle)
})
