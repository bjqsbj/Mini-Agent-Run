import { parentPort, workerData } from 'node:worker_threads'
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import ts from 'typescript'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'

async function evaluate({ files, checks }) {
  const modules = new Map()
  for (const file of files) {
    const out = ts.transpileModule(file.content, {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
      },
    })
    const error = out.diagnostics?.find(
      (d) => d.category === ts.DiagnosticCategory.Error,
    )
    if (error)
      throw Error(
        file.path +
          ' · ' +
          ts.flattenDiagnosticMessageText(error.messageText, ' '),
      )
    modules.set('/' + file.path, out.outputText)
  }
  const engine = await newQuickJSWASMModuleFromVariant(variant)
  return checks.map((check) => {
    const runtime = engine.newRuntime()
    runtime.setMemoryLimit(16 * 1024 * 1024)
    runtime.setMaxStackSize(512 * 1024)
    const deadline = Date.now() + 400
    runtime.setInterruptHandler(() => Date.now() > deadline)
    runtime.setModuleLoader(
      (name) => {
        if (!modules.has(name)) throw Error('未上传依赖：' + name)
        return modules.get(name)
      },
      (base, request) => {
        if (!request.startsWith('.') && !request.startsWith('/'))
          throw Error('不支持外部模块：' + request)
        const path = posix.resolve(posix.dirname(base), request)
        return (
          [
            path,
            path.replace(/\.js$/, '.ts'),
            path.replace(/\.mjs$/, '.mts'),
            path + '.ts',
            path + '.js',
            path + '/index.ts',
            path + '/index.js',
          ].find((p) => modules.has(p)) ?? path
        )
      },
    )
    const vm = runtime.newContext()
    const row = {
      name: check.name,
      file: check.file,
      fn: check.fn,
      args: check.args,
      expected: check.expected,
    }
    try {
      const source =
        'import * as api from ' +
        JSON.stringify('/' + check.file) +
        ';\n' +
        'const fn = api[' +
        JSON.stringify(check.fn) +
        ']; if(typeof fn!=="function") throw Error("缺少导出函数");\n' +
        'const value=fn(...' +
        JSON.stringify(check.args) +
        '); if(value && typeof value.then==="function") throw Error("当前测评仅支持同步返回值");\n' +
        'globalThis.__testValue=JSON.stringify(value);'
      const result = vm.evalCode(source, '/case-entry.mjs', { type: 'module' })
      if (result.error) {
        const err = vm.dump(result.error)
        result.error.dispose()
        throw Error(err?.message || String(err))
      }
      result.value.dispose()
      const value = vm.getProp(vm.global, '__testValue')
      let raw
      try {
        raw = vm.dump(value)
      } finally {
        value.dispose()
      }
      if (typeof raw !== 'string' || raw.length > 8192)
        throw Error('返回值未完成、不可序列化或超出 8 KiB')
      const actual = JSON.parse(raw)
      return { ...row, actual, pass: isDeepStrictEqual(actual, check.expected) }
    } catch (e) {
      return { ...row, pass: false, error: String(e.message).slice(0, 500) }
    } finally {
      vm.dispose()
      runtime.dispose()
    }
  })
}
evaluate(workerData).then(
  (rows) => parentPort.postMessage({ rows }),
  (e) => parentPort.postMessage({ error: String(e.message).slice(0, 800) }),
)
