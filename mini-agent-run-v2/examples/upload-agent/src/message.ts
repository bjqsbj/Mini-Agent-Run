export function toolMessage(id: string, content: string) {
  return { role: 'tool', tool_call_id: id, content }
}
