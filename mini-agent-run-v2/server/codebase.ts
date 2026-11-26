import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import type { Scenario } from './scenarios.ts'

export interface Source {
  path: string
  content: string
}
export interface Check {
  name: string
  file: string
  fn: string
  args: unknown[]
  expected: unknown
}
export interface Edit {
  path: string
  before: string
  after: string
}
interface Example {
  id: string
  title: string
  scene: Scenario
  question: string
  files: Source[]
  checks: Check[]
  demoEdits: Edit[]
  expected: string
  method: string
}
export const cases: Example[] = JSON.parse(
  readFileSync(new URL('../examples/cases.json', import.meta.url), 'utf8'),
)
export function example(id: string) {
  const c = cases.find((x) => x.id === id)
  if (!c) throw Error('案例不存在')
  return c
}

export function validateFiles(files: Source[]): Source[] {
  if (!Array.isArray(files) || !files.length || files.length > 32)
    throw Error('请选择 1–32 个 JS 或 TS 源码文件')
  let size = 0
  const names = new Set<string>()
  for (const f of files) {
    if (
      !f ||
      typeof f.path !== 'string' ||
      f.path.length > 180 ||
      !/\.(?:m?[jt]s)$/i.test(f.path) ||
      f.path
        .split('/')
        .some(
          (s) =>
            !s ||
            s.startsWith('.') ||
            /[\\:\x00-\x1f<>|"*?]/.test(s) ||
            s === 'node_modules',
        ) ||
      names.has(f.path.toLowerCase())
    )
      throw Error('文件路径无效或重名：' + String(f?.path))
    if (typeof f.content !== 'string' || f.content.includes('\0'))
      throw Error('文件必须为 UTF-8 文本')
    names.add(f.path.toLowerCase())
    size += Buffer.byteLength(f.content)
  }
  if (size > 81920) throw Error('选中源码合计超过 80 KiB，请选择故障相关模块')
  return files.map(({ path, content }) => ({ path, content }))
}
export function validateChecks(checks: Check[], files: Source[]): Check[] {
  if (
    !Array.isArray(checks) ||
    checks.length > 20 ||
    JSON.stringify(checks).length > 24000
  )
    throw Error('最多 20 条断言，合计不超过 24000 字符')
  for (const c of checks)
    if (
      !c ||
      typeof c.name !== 'string' ||
      !c.name.trim() ||
      !files.some((f) => f.path === c.file) ||
      typeof c.fn !== 'string' ||
      !/^[$\w]+$/.test(c.fn) ||
      !Array.isArray(c.args) ||
      !Object.hasOwn(c, 'expected')
    )
      throw Error(
        '断言需要 name、已上传的 file、导出函数 fn、args 数组和 expected',
      )
  return checks
}
export function applyEdits(files: Source[], edits: Edit[]) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 12)
    throw Error('补丁应包含 1–12 处精确替换')
  const result = files.map((f) => ({ ...f }))
  for (const e of edits) {
    const f = result.find((f) => f.path === e?.path)
    if (
      !f ||
      typeof e.before !== 'string' ||
      !e.before ||
      typeof e.after !== 'string' ||
      e.before === e.after
    )
      throw Error('补丁路径或替换内容无效')
    const i = f.content.indexOf(e.before)
    if (i < 0 || f.content.indexOf(e.before, i + 1) >= 0)
      throw Error('补丁上下文缺失或不唯一：' + e.path)
    f.content =
      f.content.slice(0, i) + e.after + f.content.slice(i + e.before.length)
  }
  return validateFiles(result)
}
export interface Input {
  caseId: string
  files?: Source[]
  checks?: Check[]
  project?: string
  name?: string
}
export interface Context {
  project: string
  base: string
  caseId: string
  checks: Check[]
  origin: string
  files: Source[]
}
export class Codebase {
  store: Store
  constructor(store: Store) {
    this.store = store
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,head TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),parent TEXT,kind TEXT,at TEXT,files TEXT,run TEXT);
      CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project);
      CREATE TABLE IF NOT EXISTS assignments(run TEXT PRIMARY KEY REFERENCES runs(id),project TEXT REFERENCES projects(id),base TEXT REFERENCES revisions(id),caseId TEXT,checks TEXT,origin TEXT);
    `)
  }
  attach(run: string, input: Input) {
    const c = example(input.caseId)
    const project = input.project || randomUUID()
    let base: string, files: Source[]
    if (input.project) {
      if (input.files) throw Error('已有项目不能同时导入新文件')
      const p = this.project(project)
      base = p.head
      files = this.files(project, base)
    } else {
      files = validateFiles(input.files ?? c.files)
      base = randomUUID()
      this.store.db
        .prepare('INSERT INTO projects VALUES(?,?,?)')
        .run(project, String(input.name || c.title).slice(0, 100), base)
      this.writeRevision(project, base, null, 'original', files, run)
    }
    const checks = validateChecks(
      input.checks ?? (input.files ? [] : c.checks),
      files,
    )
    const prior = input.project
      ? this.store.db
          .prepare(
            'SELECT origin FROM assignments WHERE project=? AND checks=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(project, JSON.stringify(checks))
      : null
    const origin = String(
      prior?.origin ??
        (input.checks?.length ? '用户' : input.files ? '模型拟定' : '案例清单'),
    )
    this.store.db
      .prepare('INSERT INTO assignments VALUES(?,?,?,?,?,?)')
      .run(run, project, base, c.id, JSON.stringify(checks), origin)
  }
  project(id: string) {
    if (typeof id !== 'string') throw Error('项目编号无效')
    const p = this.store.db
      .prepare('SELECT * FROM projects WHERE id=?')
      .get(id) as unknown as { id: string; name: string; head: string }
    if (!p) throw Error('代码项目不存在')
    return p
  }
  files(project: string, rev: string): Source[] {
    const r = this.store.db
      .prepare('SELECT files FROM revisions WHERE id=? AND project=?')
      .get(rev, project)
    if (!r) throw Error('版本不存在')
    return JSON.parse(String(r.files))
  }
  context(run: string): Context | null {
    const r = this.store.db
      .prepare('SELECT * FROM assignments WHERE run=?')
      .get(run)
    if (!r) return null
    const { project, base, caseId, origin } = r as unknown as Context
    return {
      project,
      base,
      caseId,
      origin,
      checks: JSON.parse(String(r.checks)),
      files: this.files(project, base),
    }
  }
  details(run: string) {
    const c = this.context(run)
    if (!c) return null
    const p = this.project(c.project)
    const versions = this.store.db
      .prepare(
        'SELECT id,parent,kind,at,run FROM revisions WHERE project=? ORDER BY rowid DESC',
      )
      .all(p.id)
    return {
      project: p.id,
      name: p.name,
      head: p.head,
      base: c.base,
      caseId: c.caseId,
      checks: c.checks,
      versions,
    }
  }
  writeRevision(
    project: string,
    id: string,
    parent: string | null,
    kind: string,
    files: Source[],
    run: string,
  ) {
    this.store.db
      .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
      .run(
        id,
        project,
        parent,
        kind,
        new Date().toISOString(),
        JSON.stringify(files),
        run,
      )
  }
  advance(
    project: string,
    expected: string,
    files: Source[],
    kind: string,
    run: string,
  ) {
    const id = randomUUID()
    const changed = this.store.db
      .prepare('UPDATE projects SET head=? WHERE id=? AND head=?')
      .run(id, project, expected).changes
    if (!changed) throw Error('活动版本已变化，请基于最新版本重新执行')
    this.writeRevision(project, id, expected, kind, files, run)
    return id
  }
  rollback(run: string, target: string, head: string) {
    const c = this.context(run)
    if (!c) throw Error('任务没有代码项目')
    if (head === target) throw Error('目标已是活动版本')
    const files = this.files(c.project, target)
    return this.store.transaction(() =>
      this.advance(c.project, head, files, 'rollback', run),
    )
  }
}
