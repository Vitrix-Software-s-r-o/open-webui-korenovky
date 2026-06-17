<script lang="ts">
	import { onMount } from 'svelte';
	import { ingestAiDocumentDraft, openDraftId } from '$lib/stores/email';

	// Emitted by the seeded `background_agent` Tool after a run produces an
	// editable .docx/.xlsx, so the docked editor pops automatically (same UX as
	// the chat model calling prepare_document_draft):
	//   <details type="document_draft" payload="<base64(document_draft_dialog)>">
	//     <summary>Dokument připraven k úpravě</summary></details>
	export let attributes: Record<string, string> = {};

	let draftId = '';
	let title = 'Dokument';
	let ready = false;

	function decodePayload(b64: string): any | null {
		try {
			// base64 → UTF-8 JSON (filenames are ASCII today, but decode safely).
			const bin = atob(b64);
			const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
			const json = new TextDecoder().decode(bytes);
			return JSON.parse(json);
		} catch (e) {
			console.error('[document_draft] bad payload', e);
			return null;
		}
	}

	onMount(() => {
		const payload = decodePayload(attributes?.payload ?? '');
		const draft = payload?.draft;
		draftId = payload?.draft_id ?? '';
		if (!draft || !draftId) return;
		title = draft.title ?? draft.filename ?? 'Dokument';

		// Pop the editor when this is a NEW draft (a fresh agent run); a chat
		// reload re-mounts this block but the draft was hydrated from chat storage
		// first, so the same content key dedupes to a silent no-op (no resurrect).
		// A later revision (new key) refreshes an open window. Policy lives in the
		// store — see ingestAiDocumentDraft.
		ingestAiDocumentDraft(draftId, draft, { open: true, replaces: payload?.replaces });
		ready = true;
	});
</script>

{#if ready && draftId}
	<button
		type="button"
		on:click={() => openDraftId.set(draftId)}
		class="my-1.5 inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
		title="Otevřít dokument v editoru"
	>
		<svg class="size-4 shrink-0 text-gray-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
			<path d="M5 2.5h6l4 4V17a.5.5 0 01-.5.5h-9A.5.5 0 015 17V2.5z" />
			<path d="M11 2.5V6.5h4" />
		</svg>
		<span class="truncate">Otevřít „{title}" v editoru →</span>
	</button>
{/if}
