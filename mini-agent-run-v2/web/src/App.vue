<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { api, post, statusName, clock } from './api.js'
import Icon from './Icon.vue'
import LogViewer from './LogViewer.vue'
import SourceInput from './SourceInput.vue'
import DoctorInput from './DoctorInput.vue'
import DoctorReport from './DoctorReport.vue'
import StageReport from './StageReport.vue'
import CodeVersions from './CodeVersions.vue'
import './repair.css'

const workflow = ref('doctor')
const caseId = ref('gateway-port'),
  uploaded = ref([]),
  checkText = ref(''),
  existing = ref(null)
const selectedCase = computed(() =>
  config.value.cases?.find((c) => c.id === caseId.value),
)
function selectCase(id) {
  const c = config.value.cases?.find((x) => x.id === id)
  if (!c) return
  caseId.value = c.id
  scene.value = c.scene
  question.value = c.question
  existing.value = null
}
function continueProject(p) {
  workflow.value = 'repair'
  const previous = current.value
  compose()
  selectCase(p.caseId)
  existing.value = p
  uploaded.value = []
  checkText.value = ''
  question.value = previous.question
  mode.value = previous.mode
}

const config = ref({ scenarios: {}, liveReady: false }),
  history = ref([]),
  scene = ref('boot'),
  mode = ref('demo'),
  question = ref('')
const current = ref(null),
  events = ref([]),
  error = ref(''),
  busy = ref(false),
  connection = ref(''),
  mobile = ref(false)
const jump = ref(0),
  source = ref(''),
  focus = ref(0),
  logPanel = ref(null),
  filter = ref('all')
const icons = { boot: 'layers', sync: 'sync', export: 'logs' }
let stream = null,
  version = 0,
  poller,
  lastHistory = 0
const info = computed(
  () => config.value.scenarios[current.value?.scenario || scene.value] || {},
)
const logSources = computed(() => [
  ...new Set(
    events.value
      .filter((e) => e.type === 'observation' && e.data.output.logSource)
      .map((e) => e.data.output.logSource),
  ),
])
const turns = computed(() => {
  const list = [],
    map = new Map()
  for (const e of events.value) {
    const d = e.data
    if (e.type === 'turn') {
      const row = { round: d.round, at: e.at, text: '', calls: [] }
      list.push(row)
      map.set(d.round, row)
      continue
    }
    const row = map.get(d.round)
    if (!row) continue
    if (e.type === 'text') row.text += d.text
    if (e.type === 'call') row.calls.push({ ...d, at: e.at })
    if (e.type === 'observation') {
      const c = row.calls.find((x) => x.token === d.token)
      if (c) Object.assign(c, d)
    }
  }
  return list
})
const doctorReport = computed(
  () => events.value.find((e) => e.type === 'doctor.report')?.data.report,
)
const isDoctor = computed(() =>
  events.value.some((e) => e.type === 'stage' && e.data.stage === '理解反馈'),
)
const numCalls = computed(() =>
  turns.value.reduce((n, t) => n + t.calls.length, 0),
)
const filtered = computed(() =>
  history.value.filter(
    (r) => filter.value === 'all' || r.status === filter.value,
  ),
)
function preset(key) {
  selectCase(config.value.cases?.find((c) => c.scene === key)?.id)
}
function setMode() {
  error.value = ''
}
function detach() {
  version++
  stream?.close()
  stream = null
  connection.value = ''
  events.value = []
  source.value = ''
  focus.value = 0
}
function compose() {
  existing.value = null
  detach()
  current.value = null
  error.value = ''
  mobile.value = false
  location.hash = ''
  window.scrollTo(0, 0)
}
async function refresh() {
  const seq = ++lastHistory
  const rows = await api('runs')
  if (seq === lastHistory) history.value = rows
}
async function openRun(id) {
  detach()
  const token = version
  current.value = null
  error.value = ''
  mobile.value = false
  try {
    const run = await api('runs/' + id)
    if (token !== version) return
    current.value = run
    window.history.replaceState(null, '', '#' + id)
    const s = new EventSource('/api/runs/' + id + '/events')
    stream = s
    let cursor = 0
    s.onopen = () => {
      if (token === version) connection.value = '已连接'
    }
    s.onerror = () => {
      if (token === version) connection.value = '连接中断，正在续传…'
    }
    s.onmessage = ({ data }) => {
      if (token !== version) return
      const e = JSON.parse(data)
      if (e.id <= cursor) return
      cursor = e.id
      events.value.push(e)
      if (e.type === 'observation' && e.data.output.logSource && !source.value)
        source.value = e.data.output.logSource
      if (e.type === 'end') {
        Object.assign(current.value, e.data)
        s.close()
        connection.value = ''
        void refresh().catch((e) => {
          error.value = e.message
        })
      }
    }
    window.scrollTo(0, 0)
  } catch (e) {
    if (token === version) error.value = e.message
  }
}
async function act(fn) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
const start = () =>
  act(async () => {
    const r = await post('runs', {
      scenario: scene.value,
      mode: mode.value,
      question: question.value,
      repair: existing.value
        ? {
            caseId: caseId.value,
            project: existing.value.project,
            checks: existing.value.checks,
          }
        : {
            caseId: caseId.value,
            ...(uploaded.value.length
              ? {
                  files: uploaded.value,
                  name: uploaded.value[0].path,
                  ...(checkText.value.trim()
                    ? { checks: JSON.parse(checkText.value) }
                    : {}),
                }
              : {}),
          },
    })
    await openRun(r.id)
    await refresh()
  })
const stop = () =>
  act(async () => {
    await post('runs/' + current.value.id + '/stop')
    await refresh()
  })
const retry = () =>
  act(async () => {
    const r = await post('runs/' + current.value.id + '/retry')
    await openRun(r.id)
    await refresh()
  })
async function showLog(service, line) {
  jump.value++
  source.value = service
  focus.value = line || 0
  await nextTick()
  logPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
onMounted(async () => {
  try {
    config.value = await api('config')
    mode.value = config.value.liveReady ? 'live' : 'demo'
    preset('boot')
    await refresh()
    const id = location.hash.slice(1)
    if (id) await openRun(id)
    poller = setInterval(() => {
      void refresh().catch(() => {})
    }, 4000)
  } catch (e) {
    error.value = e.message
  }
})
onBeforeUnmount(() => {
  detach()
  clearInterval(poller)
})
</script>
<template>
  <div class="shell">
    <button
      v-if="mobile"
      class="scrim"
      aria-label="关闭侧栏"
      @click="mobile = false"
    ></button>
    <aside :class="{ shown: mobile }">
      <div class="brand">
        <span class="brandmark"><Icon name="pulse" :size="27" /></span>
        <div><strong>Mini Agent Run</strong><small>本地诊断控制台</small></div>
      </div>
      <button class="new" @click="compose">
        <Icon name="plus" :size="17" />新建排查
      </button>
      <div class="historyhead">
        <span>任务历史</span><span>{{ history.length }}</span>
      </div>
      <select class="sidefilter" v-model="filter" aria-label="筛选历史任务">
        <option value="all">全部状态</option>
        <option v-for="(label, k) in statusName" :value="k">{{ label }}</option>
      </select>
      <nav>
        <button
          v-for="r in filtered"
          :key="r.id"
          :class="['historyrow', { active: r.id === current?.id }]"
          @click="openRun(r.id)"
        >
          <span class="historytitle">{{ r.question }}</span
          ><small
            ><i :class="r.status"></i>{{ statusName[r.status]
            }}<span>{{ clock(r.created) }}</span></small
          >
        </button>
        <div v-if="!filtered.length" class="nohistory">
          <Icon name="time" :size="17" />{{
            history.length ? '无匹配任务' : '暂无历史任务'
          }}
        </div>
      </nav>
      <div class="sidefoot"><i></i>本地工作区<code>LOCAL</code></div>
    </aside>
    <main>
      <header class="top">
        <div>
          <button class="hamb" @click="mobile = true" aria-label="打开任务历史">
            <Icon name="menu" /></button
          ><Icon name="grid" :size="17" /><span>工作空间</span><em>/</em
          ><b>排查台</b>
        </div>
        <span class="topstatus"><i></i>SQLite 本地存储</span>
      </header>
      <div class="content">
        <p v-if="error" role="alert" class="alert">{{ error }}</p>
        <template v-if="!current">
          <div class="actionrow workflow">
            <button
              :aria-pressed="workflow === 'doctor'"
              @click="workflow = 'doctor'"
            >
              Agent 故障诊断</button
            ><button
              style="visibility: hidden;"
              :aria-pressed="workflow === 'repair'"
              @click="workflow = 'repair'"
            >
              代码修复与回滚
            </button>
          </div>
          <DoctorInput
            v-if="workflow === 'doctor'"
            :config="config"
            @open="
              (id) =>
                act(async () => {
                  await openRun(id)
                  await refresh()
                })
            "
          />
          <template v-else>
            <div class="intro">
              <h1>智能体代码排查台</h1>
              <p>
                选择示例或上传模块，描述故障，比较修复前后的代码和测试结果。
              </p>
            </div>
            <div class="sectiontitle">
              <h2>选择排查现场</h2>
              <small>3 个快捷现场</small>
            </div>
            <div class="scenes">
              <button
                v-for="k in ['boot', 'sync', 'export']"
                :key="k"
                @click="preset(k)"
                :class="['scene', k, { selected: k === scene }]"
                :aria-pressed="k === scene"
              >
                <div class="scenehead">
                  <span class="tileicon"><Icon :name="icons[k]" /></span
                  ><span class="radio"
                    ><Icon v-if="k === scene" name="check" :size="12"
                  /></span>
                </div>
                <strong>{{ config.scenarios[k]?.title }}</strong
                ><small
                  >{{ config.scenarios[k]?.kind }}<em>·</em
                  ><code>{{ config.scenarios[k]?.service }}</code></small
                >
              </button>
            </div>
            <div class="catalog">
              <label
                >测试清单
                <select
                  aria-label="测试清单"
                  :value="caseId"
                  @change="selectCase($event.target.value)"
                >
                  <option v-for="c in config.cases" :value="c.id">
                    {{ c.title }}
                  </option>
                </select></label
              >
            </div>
            <p class="explain">{{ selectedCase?.method }}</p>
            <section v-if="existing" class="codeinput">
              <h2>继续使用 {{ existing.name }}</h2>
              <p class="explain">启动任务时读取该项目的活动版本。</p>
              <button @click="existing = null">切换源码</button>
            </section>
            <SourceInput
              v-else
              v-model:files="uploaded"
              v-model:checks="checkText"
              :example="selectedCase"
              @error="error = $event"
            />
            <form class="panel inputpanel" @submit.prevent="start">
              <div class="sectiontitle">
                <h2><Icon name="terminal" />排查问题</h2>
                <code>{{ question.length }} / 2000</code>
              </div>
              <label for="question" class="inplabel">{{
                '描述触发条件、实际现象和预期行为'
              }}</label>
              <textarea
                id="question"
                v-model="question"
                maxlength="2000"
                rows="4"
                required
              ></textarea>
              <div class="formfoot">
                <label class="engine"
                  >执行引擎<select v-model="mode" @change="setMode">
                    <option value="demo">离线演示</option>
                    <option value="live">DeepSeek</option>
                  </select></label
                ><button class="primary" :disabled="busy || !question.trim()">
                  <Icon name="play" :size="15" />开始排查
                </button>
              </div>
              <p class="hint">
                {{
                  mode === 'demo'
                    ? '离线模式可验证规则和清单中的预置补丁。自定义反馈的语义筛选与代码生成请使用 DeepSeek。'
                    : config.liveReady
                      ? '将使用 ' +
                        config.model +
                        '，模型根据工具返回决定下一步。'
                      : '请在项目 .env 填写 DEEPSEEK_API_KEY 并重启，以启用真实模型。'
                }}
              </p>
            </form>
            <section class="guide">
              <Icon name="list" />
              <div>
                <h3>执行记录</h3>
                <p>
                  开始后可查看模型输出、工具参数和原始日志。已结束的任务可从左侧历史回看。
                </p>
              </div>
            </section>
          </template>
        </template>
        <template v-else>
          <div class="runheading">
            <div>
              <span class="eyeline"
                ><i></i> RUN / {{ current.id.slice(0, 8) }}</span
              >
              <h1>排查详情</h1>
              <span class="runmeta"
                >{{ current.model }} · {{ clock(current.created) }} ·
                {{ info.service }}</span
              >
            </div>
            <span :class="['status', current.status]"
              ><i></i>{{ statusName[current.status] }}</span
            >
          </div>
          <div class="questioncard">
            <small>提交的问题</small>
            <p>{{ current.question }}</p>
            <button
              v-if="current.parent"
              class="linkbtn"
              @click="openRun(current.parent)"
            >
              查看上一次执行 ↗
            </button>
          </div>
          <div class="sectiontitle runbar">
            <h2><Icon name="pulse" />执行过程</h2>
            <div>
              <small>{{ turns.length }} 轮 · {{ numCalls }} 次工具调用</small
              ><button
                v-if="current.status === 'running'"
                @click="stop"
                :disabled="busy"
              >
                <Icon name="stop" :size="13" />停止</button
              ><button v-else @click="retry" :disabled="busy">
                <Icon name="sync" :size="14" />重新执行
              </button>
            </div>
          </div>
          <p v-if="connection && current.status === 'running'" class="conn">
            {{ connection }} · 实时事件流
          </p>
          <div class="timeline">
            <article v-for="t in turns" :key="t.round" class="turn">
              <span class="node"></span>
              <header>
                <strong>第 {{ t.round }} 轮</strong
                ><time>{{ clock(t.at) }}</time>
              </header>
              <p
                class="modeltext"
                v-if="
                  t.text &&
                  !(
                    current.status === 'completed' &&
                    t.round === turns.length &&
                    !t.calls.length
                  )
                "
              >
                {{ t.text }}
              </p>
              <p v-else class="muted">
                {{
                  current.status === 'completed' && t.round === turns.length
                    ? '已生成排查结论'
                    : current.status === 'running' && !t.calls.length
                      ? '等待模型响应…'
                      : '模型决策'
                }}
              </p>
              <div
                class="tool"
                v-for="c in t.calls"
                :key="c.token"
                :id="c.output?.ref ? 'fact-' + c.output.ref : undefined"
              >
                <header>
                  <code>{{ c.name }} {{ c.output?.ref || '' }}</code
                  ><small>{{
                    c.ok === undefined
                      ? current.status === 'running'
                        ? '执行中…'
                        : '已中断'
                      : (c.ok ? '成功' : '工具失败') + ' · ' + c.ms + ' ms'
                  }}</small>
                </header>
                <details>
                  <summary>调用参数与返回值</summary>
                  <pre>{{ c.args }}</pre>
                  <pre v-if="c.output">{{
                    JSON.stringify(c.output, null, 2)
                  }}</pre>
                </details>
                <p v-if="c.output?.error" class="toolerror">
                  {{ c.output.error }}
                </p>
                <button
                  v-if="c.output?.logSource"
                  class="linkbtn"
                  @click="showLog(c.output.logSource, c.output.errors[0]?.n)"
                >
                  查看日志{{
                    c.output.errors[0] ? ' · 定位 #' + c.output.errors[0].n : ''
                  }}
                  ↗
                </button>
              </div>
            </article>
          </div>
          <StageReport
            :events="events.filter((e) => e.type === 'stage')"
            :title="isDoctor ? '调查记录' : '修复过程与测评'"
          />
          <CodeVersions
            :key="current.id"
            :run="current.id"
            :status="current.status"
            @continue="continueProject"
          />
          <DoctorReport
            v-if="doctorReport"
            :report="doctorReport"
            :events="events"
          />
          <section
            v-else-if="current.status !== 'running'"
            :class="['report', current.status]"
          >
            <h2>
              <Icon name="file" />{{
                current.status === 'completed' ? '排查结论' : '执行结果'
              }}
            </h2>
            <p>{{ current.result }}</p>
          </section>
          <div v-if="source" ref="logPanel" class="loganchor">
            <label v-if="logSources.length > 1"
              >日志来源
              <select v-model="source" @change="focus = 0">
                <option v-for="s in logSources">{{ s }}</option>
              </select></label
            ><LogViewer
              :key="current.id + '-' + source + '-' + jump"
              :run="current.id"
              :service="source"
              :focus="focus"
            />
          </div>
        </template>
      </div>
    </main>
  </div>
</template>
