<script lang="ts">
	export let className = 'w-4 h-4';
	export let strokeWidth = '1.5';
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	fill="none"
	viewBox="0 0 24 24"
	stroke-width={strokeWidth}
	stroke="currentColor"
	class={className}
	aria-hidden="true"
>
	<!-- Envelope body — same outline as Envelope.svelte, slightly tightened
	     so the + glyph in the bottom-right has room to sit clear. -->
	<path
		stroke-linecap="round"
		stroke-linejoin="round"
		d="M21.75 6.75v8.25a2.25 2.25 0 0 1-2.25 2.25H10.5m11.25-10.5A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75m0 0v10.5a2.25 2.25 0 0 0 2.25 2.25H10.5"
	/>
	<!-- Plus badge in the bottom-right corner. -->
	<path stroke-linecap="round" stroke-linejoin="round" d="M17.25 14.25v6m-3-3h6" />
</svg>
