<script setup>
import { ref, watch } from 'vue'
import { zipSync, strToU8 } from 'fflate'
import { api, post } from './api.js'
const props = defineProps({ run: String, status: String })
const emit = defineEmits(['continue'])
const info = ref(null),
  selected = ref(''),
  files = ref([]),
  pick = ref(''),
  busy = ref(false),
  error = ref('')
let stamp = 0,
  selection = 0
async function inspect() {
  const id = props.run,
    version = selected.value,
    token = ++selection
  try {
    const content = await api('runs/' + id + '/revision?id=' + version)
    if (token !== selection || id !== props.run) return
    files.value = content
    pick.value = content[0]?.path || ''
  } catch (e) {
    if (token === selection) error.value = e.message
  }
}
async function load() {
  const token = ++stamp
  try {
    const data = await api('runs/' + props.run + '/code')
    if (token !== stamp) return
    info.value = data
    if (data) {
      selected.value = data.head
      await inspect()
    }
  } catch (e) {
    if (token === stamp) error.value = e.message
  }
}
watch(
  () => [props.run, props.status],
  () => {
    info.value = null
    error.value = ''
    files.value = []
    selection++
    load()
  },
  { immediate: true },
)
async function rollback() {
  const id = props.run
  busy.value = true
  error.value = ''
  try {
    await post('runs/' + id + '/rollback', {
      target: selected.value,
      head: info.value.head,
    })
    if (id === props.run) await load()
  } catch (e) {
    if (id === props.run) {
      error.value = e.message
      await load()
    }
  } finally {
    busy.value = false
  }
}
async function download() {
  try {
    const id = props.run,
      v = selected.value
    const list = await api('runs/' + id + '/revision?id=' + v)
    const data = Object.fromEntries(
      list.map((f) => [f.path, strToU8(f.content)]),
    )
    const link = document.createElement('a'),
      url = URL.createObjectURL(
        new Blob([zipSync(data)], { type: 'application/zip' }),
      )
    link.href = url
    link.download = 'agent-source-' + v.slice(0, 8) + '.zip'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  } catch (e) {
    error.value = e.message
  }
}
const names = {
  original: '原始导入',
  repair: '已验证修复',
  rollback: '回滚快照',
}
</script>
<template>
  <section v-if="info" class="panel versionbox">
    <div class="sectiontitle">
      <h2>源码版本</h2>
      <small>{{ info.versions.length }} 个快照</small>
    </div>
    <p class="explain">
      {{ info.name }} · 本次基线 {{ info.base.slice(0, 8) }} · 当前版本
      {{ info.head.slice(0, 8) }}
    </p>
    <div class="actionrow">
      <select aria-label="选择源码版本" v-model="selected" @change="inspect">
        <option v-for="v in info.versions" :value="v.id">
          {{ names[v.kind] }} · {{ v.id.slice(0, 8)
          }}{{ v.id === info.head ? '（当前）' : '' }}
        </option>
      </select>
      <button @click="download">下载所选源码 ZIP</button
      ><button
        :disabled="busy || selected === info.head || status === 'running'"
        @click="rollback"
      >
        回滚到所选版本
      </button>
    </div>
    <details>
      <summary>查看所选版本代码</summary>
      <select aria-label="查看文件" v-model="pick">
        <option v-for="f in files">{{ f.path }}</option>
      </select>
      <pre>{{ files.find((f) => f.path === pick)?.content }}</pre>
    </details>
    <button
      class="linkbtn"
      v-if="status !== 'running'"
      @click="emit('continue', info)"
    >
      基于当前版本继续排查 ↗
    </button>
  </section>
  <p v-if="error" class="alert">{{ error }}</p>
</template>
