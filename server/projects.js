import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 프로젝트를 흔히 두는 위치. 여기서 git 저장소 폴더 이름만 모은다(파일 내용은 읽지 않는다)
const ROOTS = ['', 'PycharmProjects', 'Documents', 'Documents/GitHub', 'projects', 'Projects', 'code', 'dev', 'workspace', 'src', 'repos', 'git', 'Desktop', 'personal']
const LIMIT = 300

const exists = (p) => {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}
// 워크트리는 .git 이 파일이라 폴더·파일 모두 저장소로 본다
const isRepo = (dir) => exists(join(dir, '.git'))

const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

// 문제에 직접 적은 경로(~/… 또는 /…)
export function pathsIn(text, home = homedir()) {
  return [...text.matchAll(/(?:^|[\s"'(「])((?:~|\/)[^\s"'),」]+)/g)]
    .map((m) => m[1].replace(/^~(?=\/|$)/, home).replace(/[.,]+$/, ''))
    .filter(isDir)
}

export function listProjects(problem = '', home = homedir()) {
  const found = new Set(pathsIn(problem, home))
  for (const root of ROOTS.map((r) => join(home, r)).filter(isDir)) {
    for (const dir of subdirs(root)) {
      if (found.size >= LIMIT) break
      if (isRepo(dir)) found.add(dir)
      else for (const inner of subdirs(dir)) if (isRepo(inner) && found.size < LIMIT) found.add(inner)
    }
  }
  return [...found]
}

export function projectsHandler(req, res) {
  const problem = new URL(req.url, 'http://x').searchParams.get('problem') ?? ''
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ projects: listProjects(problem) }))
}
