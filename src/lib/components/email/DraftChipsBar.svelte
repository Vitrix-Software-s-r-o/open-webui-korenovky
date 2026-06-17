<script lang="ts">
	import {
		emailDrafts,
		openDraftId,
		draftHistoryOpen,
		currentVersion,
		dropDocumentDraft,
		setDraftStatus,
		type ChatDraft
	} from '$lib/stores/email';

	// Drop a chip: a document deletes its file from storage and is forgotten
	// (no history); an email is moved to history (recoverable, no file).
	function dropChip(d: ChatDraft) {
		if (d.kind === 'document') dropDocumentDraft(d.id);
		else setDraftStatus(d.id, 'dropped');
	}

	$: active = $emailDrafts.filter((d) => d.status === 'active');
	// History is an email-only concept; document drafts never archive.
	$: archived = $emailDrafts.filter((d) => d.status !== 'active' && d.kind !== 'document');

	function labelOf(d: ChatDraft): string {
		if (d.kind === 'document') return d.doc?.title?.trim() || 'Dokument';
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
				<div
					class="inline-flex items-center max-w-[240px] text-xs rounded-full border shadow-sm transition
						{$openDraftId === d.id
						? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-200'
						: 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'}"
				>
					<button
						on:click={() => openDraftId.set(d.id)}
						class="inline-flex items-center gap-1.5 min-w-0 pl-2 pr-1 py-1 rounded-full"
						title={labelOf(d)}
					>
						<span class="size-1.5 rounded-full {d.kind === 'document' ? 'bg-emerald-500' : 'bg-blue-500'} shrink-0"></span>
						{#if d.kind === 'document'}
							<svg class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h6l4 4V17a.5.5 0 01-.5.5h-9A.5.5 0 015 17V2.5z"/><path d="M11 2.5V6.5h4"/></svg>
						{:else}
							<svg class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" /><path d="M3 5.5l7 5 7-5" /></svg>
						{/if}
						<span class="truncate">{labelOf(d)}</span>
						{#if d.kind !== 'document' && currentVersion(d)?.to?.length}
							<span class="text-gray-400 dark:text-gray-500 shrink-0">· {currentVersion(d).to.length}</span>
						{/if}
					</button>
					<!-- Drop: document → delete file from storage + close editor (no
					     history); email → move to history (recoverable). -->
					<button
						on:click|stopPropagation={() => dropChip(d)}
						class="shrink-0 mr-1 -ml-0.5 p-0.5 rounded-full text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-200/70 dark:hover:bg-gray-700/70 transition"
						title={d.kind === 'document'
							? 'Zahodit dokument (smaže soubor z úložiště)'
							: 'Zahodit koncept (přesune do historie)'}
						aria-label={d.kind === 'document'
							? 'Zahodit dokument a smazat soubor'
							: 'Zahodit koncept do historie'}
					>
						<svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l8 8M14 6l-8 8" stroke-linecap="round"/></svg>
					</button>
				</div>
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
