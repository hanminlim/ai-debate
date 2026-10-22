import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listProjects, pathsIn } from './projects.js'

// 가짜 홈: git 저장소 둘, 일반 폴더 하나, node_modules 안 저장소 하나
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  for (const p of ['PycharmProjects/app-a/.git', 'Documents/GitHub/org/app-b/.git', 'PycharmProjects/notes', 'projects/node_modules/x/.git']) {
    mkdirSync(join(home, p), { recursive: true })
  }
  return home
}

test('흔한 위치에서 git 저장소 폴더만 모은다', () => {
  const home = fakeHome()
  const list = listProjects('', home)
  assert.ok(list.includes(join(home, 'PycharmProjects/app-a')))
  assert.ok(list.includes(join(home, 'Documents/GitHub/org/app-b')))
  assert.ok(!list.some((p) => p.endsWith('notes') || p.includes('node_modules')))
})

test('문제에 적은 경로는 git 이 아니어도 후보에 넣는다', () => {
  const home = fakeHome()
  assert.deepEqual(pathsIn('~/PycharmProjects/notes 구조를 봐줘. /no/such 는 무시', home), [join(home, 'PycharmProjects/notes')])
  assert.ok(listProjects('「~/PycharmProjects/notes」 봐줘', home).includes(join(home, 'PycharmProjects/notes')))
})
