<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		emailDrafts,
		draftHistoryOpen,
		restoreDraft,
		currentVersion,
		type ChatDraft
	} from '$lib/stores/email';

	let el: HTMLElement;

	onMount(() => {
		if (el) document.body.appendChild(el);
	});
	onDestroy(() => {
		if (el?.parentNode) el.parentNode.removeChild(el);
	});

	$: archived = $emailDrafts
		.filter((d) => d.status !== 'active')
		.slice()
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

	function subjectOf(d: ChatDraft): string {
		const s = currentVersion(d)?.subject?.trim();
		return s && s.length ? s : 'Bez předmětu';
	}
	function fmt(ts?: number): string {
		if (!ts) return '';
		try {
			return new Date(ts).toLocaleString('cs-CZ', {
				day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
			});
		} catch {
			return '';
		}
	}
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
	bind:this={el}
	class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
	on:click|self={() => draftHistoryOpen.set(false)}
	on:keydown={(e) => e.key === 'Escape' && draftHistoryOpen.set(false)}
	role="dialog"
	aria-label="Historie konceptů"
>
	<div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col">
		<div class="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
			<h2 class="text-base font-semibold text-gray-900 dark:text-white">Historie konceptů</h2>
			<button
				on:click={() => draftHistoryOpen.set(false)}
				class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-xl leading-none"
				aria-label="Zavřít"
			>×</button>
		</div>

		<div class="flex-1 overflow-y-auto p-3 space-y-1.5">
			{#if archived.length === 0}
				<div class="text-center text-sm text-gray-400 dark:text-gray-500 py-8">
					Žádné odeslané ani zahozené koncepty.
				</div>
			{:else}
				{#each archived as d (d.id)}
					<div class="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-850">
						<span
							class="size-2 rounded-full shrink-0 {d.status === 'sent' ? 'bg-green-500' : 'bg-gray-400'}"
							title={d.status === 'sent' ? 'Odesláno' : 'Zahozeno'}
						></span>
						<div class="flex-1 min-w-0">
							<div class="text-sm text-gray-800 dark:text-gray-200 truncate" title={subjectOf(d)}>
								{subjectOf(d)}
							</div>
							<div class="text-[11px] text-gray-400 dark:text-gray-500">
								{d.status === 'sent' ? 'Odesláno' : 'Zahozeno'} · {fmt(d.updatedAt)}
							</div>
						</div>
						<button
							on:click={() => restoreDraft(d.id)}
							class="shrink-0 text-xs px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950"
						>
							Obnovit
						</button>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>
