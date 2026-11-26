<script setup>
import { ref } from 'vue'
const props = defineProps({
  files: Array,
  checks: String,
  example: Object,
  diagnosis: Boolean,
})
const emit = defineEmits(['update:files', 'update:checks', 'error'])
const reading = ref(false)
function useExample() {
  emit('update:files', [])
  emit('update:checks', '')
}
async function loadChecks(event) {
  const input = event.target
  try {
    const f = input.files[0]
    if (!f) return
    if (f.size > 64000) throw Error('断言文件过大')
    const parsed = JSON.parse(await f.text())
    if (!Array.isArray(parsed)) throw Error('断言文件应为 JSON 数组')
    emit('update:checks', JSON.stringify(parsed, null, 2))
    emit('error', '')
  } catch (e) {
    emit('error', e.message)
  } finally {
    input.value = ''
  }
}
async function read(event, folder) {
  const input = event.target
  reading.value = true
  try {
    const picked = [...input.files]
      .map((f) => ({
        f,
        path: folder
          ? f.webkitRelativePath.split('/').slice(1).join('/')
          : f.name,
      }))
      .filter(
        ({ path }) =>
          /\.(?:m?[jt]s)$/i.test(path) &&
          !path
            .split('/')
            .some(
              (s) =>
                s.startsWith('.') ||
                ['node_modules', 'dist', 'build', 'coverage'].includes(s),
            ),
      )
    if (
      !picked.length ||
      picked.length > 32 ||
      picked.reduce((n, x) => n + x.f.size, 0) > 81920
    )
      throw Error(
        '请选择 1–32 个相关 JS/TS 源文件，合计不超过 80 KiB。目录会跳过依赖和构建产物。',
      )
    const files = await Promise.all(
      picked.map(async ({ f, path }) => ({
        path,
        content: new TextDecoder('utf-8', { fatal: true }).decode(
          await f.arrayBuffer(),
        ),
      })),
    )
    if (new Set(files.map((f) => f.path.toLowerCase())).size !== files.length)
      throw Error('存在重名文件，请改用目录导入以保留相对路径。')
    emit('update:files', files)
    emit('update:checks', '')
    emit('error', '')
  } catch (e) {
    emit('error', e.message)
  } finally {
    input.value = ''
    reading.value = false
  }
}
</script>
<template>
  <section class="codeinput">
    <div class="sectiontitle">
      <h2>智能体源码</h2>
      <small>{{ files.length ? '上传的源码' : '案例自带源码' }}</small>
    </div>
    <p class="explain">
      选择故障相关的 JS / TS 模块，可连同本地相对导入一起上传。DeepSeek
      模式会将所选源码和问题发送至模型。
    </p>
    <div class="actionrow">
      <label class="upload"
        >选择代码文件<input
          type="file"
          accept=".js,.ts,.mjs,.mts"
          multiple
          :disabled="reading"
          @change="read($event, false)"
      /></label>
      <label class="upload"
        >选择源码目录<input
          type="file"
          webkitdirectory
          multiple
          :disabled="reading"
          @change="read($event, true)"
      /></label>
      <button v-if="files.length" type="button" @click="useExample">
        使用案例代码
      </button>
    </div>
    <div class="chips">
      <code v-for="f in files.length ? files : example?.files" :key="f.path">{{
        f.path
      }}</code>
    </div>
    <details v-if="files.length && !diagnosis">
      <summary>自定义行为断言（可选）</summary>
      <p class="explain">
        数组中每项给出 name、file、fn、args 和 expected。fn
        是导出的同步函数。留空时由真实模型在修改前拟定断言。
      </p>
      <textarea
        :value="checks"
        @input="emit('update:checks', $event.target.value)"
        aria-label="自定义断言"
        rows="4"
        placeholder='[{"name":"容量边界","file":"agent.ts","fn":"canArchive","args":[64,64],"expected":true}]'
      ></textarea>
      <div class="actionrow">
        <label class="upload"
          >读取断言 JSON<input
            type="file"
            accept=".json"
            @change="loadChecks" /></label
        ><button
          type="button"
          @click="
            emit('update:checks', JSON.stringify(example.checks, null, 2))
          "
        >
          填入所选案例断言
        </button>
      </div>
    </details>
  </section>
</template>
