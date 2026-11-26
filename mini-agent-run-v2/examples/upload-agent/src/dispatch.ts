import { toolMessage } from './message.js'

export function collect(pending: string[], completed: {id: string, value: string}[]) {
  return completed.map((event, index) => toolMessage(pending[index], event.value))
}
