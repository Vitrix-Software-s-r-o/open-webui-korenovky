<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let index: number;
	export let count: number;
	export let authoredBy: 'ai' | 'user' = 'ai';

	const dispatch = createEventDispatcher<{ revert: { index: number } }>();
</script>

{#if count > 1}
	<div class="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
		<button
			on:click={() => dispatch('revert', { index: index - 1 })}
			disabled={index <= 0}
			class="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent"
			aria-label="Předchozí verze"
			title="Předchozí verze"
		>
			<svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5l-5 5 5 5" /></svg>
		</button>
		<span class="tabular-nums select-none">Verze {index + 1}/{count}</span>
		<button
			on:click={() => dispatch('revert', { index: index + 1 })}
			disabled={index >= count - 1}
			class="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent"
			aria-label="Další verze"
			title="Další verze"
		>
			<svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l5 5-5 5" /></svg>
		</button>
		<span
			class="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] {authoredBy === 'ai'
				? 'bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300'
				: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}"
		>
			{authoredBy === 'ai' ? 'asistent' : 'ručně'}
		</span>
	</div>
{/if}
