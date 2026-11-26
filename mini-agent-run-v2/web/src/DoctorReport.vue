<script setup>
import { computed } from 'vue'
const props = defineProps({ report: Object, events: Array })
const rows = computed(() =>
  props.events
    .filter((e) => e.type === 'observation' && e.data.ok)
    .map((e) => e.data.output),
)
const trace = computed(() =>
  rows.value
    .find((e) => e.tool === 'get_execution_trace' && Array.isArray(e.value))
    ?.value.find((t) => t.step === props.report.step),
)
const cited = computed(() =>
  rows.value
    .map((e) => ({
      ...e,
      quotes: props.report.evidence
        .filter((c) => c.ref === e.ref)
        .map((c) => c.quote),
    }))
    .filter((e) => e.quotes.length),
)
function locate(ref) {
  const card = document.getElementById('fact-' + ref)
  if (!card) return
  card.querySelector('details').open = true
  card.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
</script>
<template>
  <section class="panel report doctor-report">
    <h2>排查结论</h2>
    <p>
      <strong>{{
        report.confidence === 'supported'
          ? '诊断结论 · 当前现场支持'
          : '诊断结论 · 证据不足'
      }}</strong>
    </p>
    <p>{{ report.root }}</p>
    <h3>关键故障步骤</h3>
    <p>
      {{
        trace
          ? '#' +
            trace.step +
            ' · ' +
            (typeof trace.event === 'string'
              ? trace.event
              : JSON.stringify(trace.event))
          : '当前观测无法确定具体步骤'
      }}
    </p>
    <h3>证据与交叉验证</h3>
    <p>{{ report.alternatives }}</p>
    <div v-for="e in cited" :key="e.ref">
      <button class="linkbtn" @click="locate(e.ref)">
        {{ e.ref }} · 第 {{ e.round }} 轮 · {{ e.tool }} ↗
      </button>
      <pre>{{ e.quotes.join('\n') }}</pre>
    </div>
    <h3>修复方案</h3>
    <ul>
      <li v-for="s in report.fix">{{ s }}</li>
    </ul>
    <h3>修复验收标准</h3>
    <ol>
      <li v-for="s in report.acceptance">{{ s }}</li>
    </ol>
  </section>
</template>
<style scoped>
.doctor-report h3 {
  margin-top: 20px;
}
.doctor-report pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 120px;
  overflow: auto;
  font-size: 12px;
  background: #f5f8f2;
  padding: 8px;
}
.doctor-report li {
  line-height: 1.8;
}
.doctor-report ol,
.doctor-report ul {
  padding-left: 22px;
}
</style>
