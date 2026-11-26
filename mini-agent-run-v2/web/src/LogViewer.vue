<script setup>
import { ref, watch, nextTick } from 'vue'
import { api } from './api.js'
import Icon from './Icon.vue'
const props = defineProps({ run: String, service: String, focus: Number })
const q = ref(''),
  level = ref(''),
  page = ref(1),
  data = ref({ rows: [], total: 0, pages: 1 }),
  error = ref(''),
  pending = ref(false)
const viewport = ref(null)
watch(
  () => [props.run, props.service, props.focus],
  () => {
    q.value = ''
    level.value = ''
    page.value = Math.ceil((props.focus || 1) / 50)
  },
  { immediate: true },
)
watch(
  [() => props.run, () => props.service, q, level, page],
  (values, old, cleanup) => {
    const abort = new AbortController()
    pending.value = true
    error.value = ''
    const timer = setTimeout(async () => {
      try {
        const p = new URLSearchParams({
          service: props.service,
          q: q.value,
          level: level.value,
          page: page.value,
        })
        data.value = await api('runs/' + props.run + '/logs?' + p, {
          signal: abort.signal,
        })
        await nextTick()
        const box = viewport.value,
          marked = box?.querySelector('.marked')
        if (box)
          box.scrollTop = marked
            ? box.scrollTop +
              marked.getBoundingClientRect().top -
              box.getBoundingClientRect().top -
              box.clientHeight / 2 +
              marked.clientHeight / 2
            : 0
      } catch (e) {
        if (!abort.signal.aborted) error.value = e.message
      } finally {
        if (!abort.signal.aborted) pending.value = false
      }
    }, 100)
    cleanup(() => {
      clearTimeout(timer)
      abort.abort()
    })
  },
  { immediate: true },
)
</script>
<template>
  <section class="logbox">
    <header>
      <div class="heading">
        <Icon name="logs" />
        <h3>日志浏览器</h3>
        <code>{{ service }}</code>
      </div>
      <small>每页 50 行</small>
    </header>
    <div class="filters">
      <label class="search"
        ><Icon name="search" :size="16" /><input
          v-model="q"
          @input="page = 1"
          maxlength="120"
          aria-label="搜索日志"
          placeholder="搜索消息，如 ENOSPC" /></label
      ><select v-model="level" @change="page = 1" aria-label="日志级别">
        <option value="">全部级别</option>
        <option>ERROR</option>
        <option>WARN</option>
        <option>INFO</option>
      </select>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <div ref="viewport" class="loglines" :aria-busy="pending">
      <div
        v-for="r in data.rows"
        :key="r.n"
        :class="['logline', { marked: r.n === focus }]"
      >
        <span>#{{ r.n }}</span
        ><time>{{ r.time.slice(11, 19) }}Z</time
        ><b :class="r.level">{{ r.level }}</b
        ><samp>{{ r.message }}</samp>
      </div>
      <p v-if="!data.rows.length">
        {{ pending ? '读取中…' : '没有匹配的日志' }}
      </p>
    </div>
    <footer>
      <small
        >{{ pending ? '正在检索…' : '匹配 ' + data.total + ' 行' }} · 第
        {{ data.page || 1 }} / {{ data.pages }} 页</small
      >
      <div>
        <button :disabled="pending || page <= 1" @click="page--">上一页</button
        ><button :disabled="pending || page >= data.pages" @click="page++">
          下一页
        </button>
      </div>
    </footer>
  </section>
</template>
