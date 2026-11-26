import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  makeLogs,
  type Scenario,
  type Service,
  type Mode,
} from './scenarios.ts'

export type Status =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'clarify'
  | 'rejected'
export interface Run {
  id: string
  question: string
  scenario: Scenario
  mode: Mode
  model: string
  status: Status
  created: string
  finished: string | null
  result: string
  parent: string | null
}
export interface Line {
  n: number
  time: string
  level: string
  message: string
}
export interface Item {
  id: number
  type: string
  at: string
  data: Record<string, unknown>
}
export class Store {
  db: DatabaseSync
  constructor(folder: string) {
    mkdirSync(folder, { recursive: true })
    this.db = new DatabaseSync(join(folder, 'runs.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,question TEXT,scenario TEXT,mode TEXT,model TEXT,status TEXT,created TEXT,finished TEXT,result TEXT,parent TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,run TEXT REFERENCES runs(id),type TEXT,at TEXT,data TEXT);
      CREATE INDEX IF NOT EXISTS event_cursor ON events(run,id);
      CREATE TABLE IF NOT EXISTS logs(run TEXT REFERENCES runs(id),service TEXT,n INTEGER,time TEXT,level TEXT,message TEXT,PRIMARY KEY(run,service,n));
    `)
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = action()
      this.db.exec('COMMIT')
      return value
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  create(
    question: string,
    scenario: Scenario,
    mode: Mode,
    model: string,
    parent: string | null,
    initialize?: (id: string) => void,
  ) {
    const id = randomUUID()
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,?,'running',?,NULL,'',?)")
        .run(
          id,
          question,
          scenario,
          mode,
          model,
          new Date().toISOString(),
          parent,
        )
      this.event(id, 'start', {})
      initialize?.(id)
    })
    return this.get(id)!
  }
  get(id: string) {
    return this.db
      .prepare('SELECT * FROM runs WHERE id=?')
      .get(id) as unknown as Run | undefined
  }
  list() {
    return this.db
      .prepare(
        'SELECT id,question,scenario,mode,status,created,parent FROM runs ORDER BY rowid DESC',
      )
      .all()
  }
  event(run: string, type: string, data: Record<string, unknown>) {
    const at = new Date().toISOString()
    const row = this.db
      .prepare('INSERT INTO events(run,type,at,data) VALUES(?,?,?,?)')
      .run(run, type, at, JSON.stringify(data))
    return { id: Number(row.lastInsertRowid), type, at, data }
  }
  after(run: string, cursor: number): Item[] {
    return this.db
      .prepare(
        'SELECT id,type,at,data FROM events WHERE run=? AND id>? ORDER BY id',
      )
      .all(run, cursor)
      .map((e) => ({ ...e, data: JSON.parse(String(e.data)) }) as Item)
  }
  finish(
    id: string,
    status: Exclude<Status, 'running'>,
    result: string,
    onFinish?: () => void,
  ) {
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE runs SET status=?,result=?,finished=? WHERE id=? AND status='running'",
        )
        .run(status, result, new Date().toISOString(), id).changes
      if (!changed) return null
      onFinish?.()
      return this.event(id, 'end', { status, result })
    })
  }
  recover() {
    for (const r of this.db
      .prepare("SELECT id FROM runs WHERE status='running'")
      .all())
      this.finish(
        String(r.id),
        'failed',
        '服务上次运行中断，已保存中断前的事件。可以重新执行。',
      )
  }
  snapshot(id: string, service: Service) {
    if (
      this.db
        .prepare('SELECT 1 FROM logs WHERE run=? AND service=? LIMIT 1')
        .get(id, service)
    )
      return
    const insert = this.db.prepare('INSERT INTO logs VALUES(?,?,?,?,?,?)')
    this.transaction(() => {
      for (const row of makeLogs(service))
        insert.run(id, service, row.n, row.time, row.level, row.message)
    })
  }
  context(id: string, service: Service, line: number): Line[] {
    return this.db
      .prepare(
        'SELECT n,time,level,message FROM logs WHERE run=? AND service=? AND n BETWEEN ? AND ? ORDER BY n',
      )
      .all(id, service, line - 1, line + 1) as unknown as Line[]
  }
  logs(
    id: string,
    service: string,
    level: string,
    q: string,
    page: number,
    limit: number,
  ) {
    const where =
      " FROM logs WHERE run=? AND service=? AND (?='' OR level=?) AND instr(lower(message),lower(?))>0"
    const args = [id, service, level, level, q]
    const total = Number(
      this.db.prepare('SELECT count(*) AS n' + where).get(...args)!.n,
    )
    const pages = Math.max(1, Math.ceil(total / limit))
    const current = Math.min(page, pages)
    const rows = this.db
      .prepare(
        'SELECT n,time,level,message' + where + ' ORDER BY n LIMIT ? OFFSET ?',
      )
      .all(...args, limit, (current - 1) * limit) as unknown as Line[]
    return { total, page: current, pages, rows }
  }
}
