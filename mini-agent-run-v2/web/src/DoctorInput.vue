<script setup>
import { ref, computed, watch } from 'vue'
import { post } from './api.js'
import SourceInput from './SourceInput.vue'
import Icon from './Icon.vue'
const props = defineProps({ config: Object })
const emit = defineEmits(['open'])
const sample = ref('CASE-004'),
  question = ref(''),
  files = ref([]),
  entry = ref(''),
  mode = ref('demo'),
  issue = ref(''),
  error = ref(''),
  busy = ref(false)
const selected = computed(() =>
  props.config.doctorSamples?.find((s) => s.id === sample.value),
)
watch(
  () => props.config.doctorSamples,
  () => {
    if (!question.value) question.value = selected.value?.question || ''
  },
  { immediate: true },
)
watch(
  () => props.config.liveReady,
  (v) => (mode.value = v ? 'live' : 'demo'),
  { immediate: true },
)
function choose(id) {
  sample.value = id
  question.value = selected.value?.question || ''
  files.value = []
  entry.value = ''
  error.value = ''
}
function uploaded(list) {
  const wasExample =
    !question.value ||
    props.config.doctorSamples.some((s) => s.question === question.value)
  files.value = list
  entry.value =
    list.find((f) => /export\s+(?:function|const)\s+observe\b/.test(f.content))
      ?.path || ''
  const match = props.config.doctorSamples.find((s) =>
    list.some((f) => f.path.split('/').at(-1) === s.file),
  )
  if (match) sample.value = match.id
  if (wasExample)
    question.value = list.length
      ? match?.question || ''
      : selected.value?.question || ''
}
async function readIssue() {
  busy.value = true
  error.value = ''
  try {
    const r = await post('doctor/issue', { url: issue.value })
    question.value = r.question
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
async function start() {
  busy.value = true
  error.value = ''
  try {
    const input = files.value.length
      ? { files: files.value, entry: entry.value || undefined }
      : { sample: sample.value }
    const run = await post('doctor', {
      question: question.value,
      mode: mode.value,
      input,
    })
    emit('open', run.id)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="intro">
    <h1>Agent 故障诊断</h1>
    <p>提交反馈和源码，沿运行轨迹核对根因、修复方案与验收标准。</p>
  </div>
  <div class="sectiontitle">
    <h2>选择模拟现场</h2>
    <small>8 个单文件案例</small>
  </div>
  <div class="scenes">
    <button
      v-for="(id, index) in ['CASE-004', 'CASE-003', 'CASE-006']"
      :key="id"
      :class="[
        'scene',
        ['boot', 'sync', 'export'][index],
        { selected: sample === id && !files.length },
      ]"
      @click="choose(id)"
    >
      <div class="scenehead">
        <span class="tileicon"
          ><Icon :name="['terminal', 'sync', 'logs'][index]" /></span
        ><code>{{ id }}</code>
      </div>
      <strong>{{
        config.doctorSamples?.find((s) => s.id === id)?.title
      }}</strong>
    </button>
  </div>
  <div class="catalog">
    <label
      >全部诊断案例
      <select
        aria-label="全部诊断案例"
        :value="sample"
        @change="choose($event.target.value)"
      >
        <option v-for="s in config.doctorSamples" :value="s.id">
          {{ s.id }} · {{ s.title }}
        </option>
      </select></label
    >
  </div>
  <p v-if="!files.length" class="explain">
    合成复现 · 文档参考 {{ selected?.source }}
  </p>
  <SourceInput
    diagnosis
    :files="files"
    :example="{ files: [{ path: selected?.file }] }"
    @update:files="uploaded"
    @error="error = $event"
  />
  <label v-if="files.length > 1"
    >观测入口
    <select v-model="entry">
      <option value="">自动识别 observe()</option>
      <option v-for="f in files" :value="f.path">{{ f.path }}</option>
    </select></label
  >
  <form class="panel inputpanel" @submit.prevent="start">
    <div class="sectiontitle">
      <h2>用户反馈 / GitHub Issue</h2>
      <small>{{ question.length }} / 12000</small>
    </div>
    <label class="inplabel" for="feedback"
      >描述触发条件、异常表现或粘贴 Issue 正文</label
    >
    <textarea
      id="feedback"
      v-model="question"
      required
      maxlength="12000"
      rows="4"
    ></textarea>
    <details>
      <summary>从公开 GitHub Issue 导入</summary>
      <div class="actionrow">
        <input
          v-model="issue"
          aria-label="公开 Issue 链接"
          placeholder="https://github.com/owner/repo/issues/123"
        /><button type="button" :disabled="!issue || busy" @click="readIssue">
          读取标题和正文
        </button>
      </div>
    </details>
    <div class="formfoot">
      <label class="engine"
        >诊断引擎
        <select v-model="mode">
          <option value="demo">离线证据回放</option>
          <option value="live">DeepSeek · 动态工具调用</option>
        </select></label
      ><button class="primary" :disabled="busy || !question.trim()">
        开始诊断
      </button>
    </div>
    <p class="hint">
      {{
        mode === 'live'
          ? '模型会收到反馈、所查询的源码片段和工具观测。'
          : '离线按已观察到的故障特征选择工具；自定义问题可用 DeepSeek 调查。'
      }}
    </p>
  </form>
  <p v-if="error" role="alert" class="alert">{{ error }}</p>
</template>
