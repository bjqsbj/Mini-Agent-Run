import { Worker } from 'node:worker_threads'
import type { Source, Check } from './codebase.ts'
export interface Score extends Check {
  pass: boolean
  actual?: unknown
  error?: string
}
export function evaluate(
  files: Source[],
  checks: Check[],
  signal: AbortSignal,
): Promise<Score[]> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../runtime/verify.cjs', import.meta.url),
      {
        workerData: { files, checks },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      },
    )
    // Settle once and always reclaim the VM, including failed or cancelled evaluations.
    function finish(error: unknown, rows?: Score[]) {
      clearTimeout(limit)
      signal.removeEventListener('abort', cancel)
      void worker.terminate()
      if (error) reject(error)
      else resolve(rows!)
    }
    function cancel() {
      finish(signal.reason)
    }
    const limit = setTimeout(() => finish(Error('隔离测评超过 15 秒')), 15000)
    worker.once('exit', (code) => {
      clearTimeout(limit)
      signal.removeEventListener('abort', cancel)
      if (code) reject(Error('测评工作线程结束：' + code))
    })
    worker.once('message', (m) =>
      finish(m.error ? Error(m.error) : null, m.rows),
    )
    worker.once('error', (e) => finish(e))
    signal.addEventListener('abort', cancel, { once: true })
  })
}
