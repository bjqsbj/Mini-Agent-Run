<script setup>
defineProps({ name: String, size: { type: Number, default: 20 } })
const icons = {
  pulse: 'M2 12h5l3-8 4 16 3-8h5',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  plus: 'M12 5v14 M5 12h14',
  layers: 'm12 3 9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  sync: 'M20 8a8 8 0 0 0-14-2L3 9 M3 4v5h5 M4 16a8 8 0 0 0 14 2l3-3 M21 20v-5h-5',
  logs: 'M4 5h16v14H4z M7 9l2 2-2 2 M12 14h4',
  chev: 'm9 6 6 6-6 6',
  play: 'm7 4 13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  time: 'M12 2a10 10 0 1 0 .01 0 M12 6v6l4 2',
  book: 'M4 4h7l1 2 1-2h7v15h-7l-1 1-1-1H4z',
  check: 'm4 12 5 5L20 6',
  terminal: 'M3 4h18v16H3z M6 9l3 3-3 3 M12 15h5',
  search: 'M10 3a7 7 0 1 0 .01 0 M15 15l6 6',
  list: 'M3 6h3 M9 6h12 M3 12h3 M9 12h12 M3 18h3 M9 18h12',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
}
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="icons[name]" />
  </svg>
</template>
