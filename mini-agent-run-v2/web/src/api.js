export async function api(path, options = {}) {
  const r = await fetch('/api/' + path, options)
  const body = await r.json()
  if (!r.ok) throw new Error(body.error || '请求失败')
  return body
}
export const post = (path, body = {}) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export const statusName = {
  clarify: '待补充',
  rejected: '已过滤',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
}
export const clock = (t) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
