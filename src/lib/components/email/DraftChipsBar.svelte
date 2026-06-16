<script lang="ts">
	import {
		emailDrafts,
		openDraftId,
		draftHistoryOpen,
		currentVersion,
		type ChatDraft
	} from '$lib/stores/email';

	$: active = $emailDrafts.filter((d) => d.status === 'active');
	$: archived = $emailDrafts.filter((d) => d.status !== 'active');

	function subjectOf(d: ChatDraft): string {
		const s = currentVersion(d)?.subject?.trim();
		return s && s.length ? s : 'Bez předmětu';
	}
</script>

{#if active.length > 0 || archived.length > 0}
	<!-- Same max-width / horizontal padding as MessageInput so the chips line up
	     with the input box (same left/right edges). -->
	<div class="w-full max-w-6xl mx-auto px-2.5">
		<div class="flex items-center gap-1.5 flex-wrap pb-1.5">
			{#each active as d (d.id)}
				<button
					on:click={() => openDraftId.set(d.id)}
					class="inline-flex items-center gap-1.5 max-w-[220px] text-xs rounded-full pl-2 pr-2.5 py-1 border shadow-sm transition
						{$openDraftId === d.id
						? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-200'
						: 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'}"
					title={subjectOf(d)}
				>
					<span class="size-1.5 rounded-full bg-blue-500 shrink-0"></span>
					<svg class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" /><path d="M3 5.5l7 5 7-5" /></svg>
					<span class="truncate">{subjectOf(d)}</span>
					{#if currentVersion(d)?.to?.length}
						<span class="text-gray-400 dark:text-gray-500 shrink-0">· {currentVersion(d).to.length}</span>
					{/if}
				</button>
			{/each}

			{#if archived.length > 0}
				<button
					on:click={() => draftHistoryOpen.set(true)}
					class="inline-flex items-center gap-1 text-xs rounded-full px-2.5 py-1 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800 shrink-0"
					title="Historie konceptů"
				>
					<svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 5v5l3 2" stroke-linecap="round" stroke-linejoin="round" /><circle cx="10" cy="10" r="7" /></svg>
					Historie ({archived.length})
				</button>
			{/if}
		</div>
	</div>
{/if}
