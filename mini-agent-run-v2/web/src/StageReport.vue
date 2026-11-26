<script setup>
defineProps({
  events: Array,
  title: { type: String, default: '修复过程与测评' },
})
function pretty(value) {
  return JSON.stringify(value, null, 2)
}
</script>
<template>
  <section v-if="events.length" class="panel stages">
    <h2>{{ title }}</h2>
    <article v-for="e in events" :key="e.id">
      <header>
        <strong>{{ e.data.stage }}</strong
        ><time>{{
          new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })
        }}</time>
      </header>
      <p>{{ e.data.note }}</p>
      <div v-for="edit in e.data.edits" class="change">
        <code>{{ edit.path }}</code>
        <pre class="removed">− {{ edit.before }}</pre>
        <pre class="added">+ {{ edit.after }}</pre>
      </div>
      <div v-if="e.data.rows" class="scores">
        <table>
          <thead>
            <tr>
              <th>用例 / 导出函数</th>
              <th>输入</th>
              <th>预期</th>
              <th>实际</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in e.data.rows" :key="i">
              <td>
                {{ r.name }}<br /><code>{{ r.fn }}</code>
              </td>
              <td>
                <code>{{ pretty(r.args) }}</code>
              </td>
              <td>
                <code>{{ pretty(r.expected) }}</code>
              </td>
              <td>
                <code>{{ r.error || pretty(r.actual) }}</code>
              </td>
              <td :class="r.pass ? 'good' : 'bad'">
                {{ r.pass ? '通过' : '失败' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <details v-if="e.data.checks">
        <summary>查看冻结的断言 · {{ e.data.origin }}</summary>
        <pre>{{ pretty(e.data.checks) }}</pre>
      </details>
    </article>
  </section>
</template>
