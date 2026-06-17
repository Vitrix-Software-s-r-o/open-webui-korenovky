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

		// Liveness: open the editor only the FIRST time this exact document
		// version is seen in this tab session — so a fresh agent run pops it,
		// but a chat reload (which re-mounts the block) only re-ingests the chip
		// without resurrecting the window. The key changes when the file's bytes
		// change, so a later revision pops again.
		const verKey =
			'docdraft-opened:' + (draft.editor_config?.document?.key ?? draftId);
		let live = false;
		try {
			live = sessionStorage.getItem(verKey) === null;
			if (live) sessionStorage.setItem(verKey, '1');
		} catch {
			live = true; // sessionStorage unavailable → treat as live
		}
		ingestAiDocumentDraft(draftId, draft, { open: live });
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
