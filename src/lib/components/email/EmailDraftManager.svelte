<script lang="ts">
	import { onMount } from 'svelte';
	import DraftHistoryPanel from './DraftHistoryPanel.svelte';
	import EmailDraftDialog from './EmailDraftDialog.svelte';
	import DocumentDraftDialog from './DocumentDraftDialog.svelte';
	import {
		emailDrafts,
		openDraftId,
		draftHistoryOpen,
		currentVersion,
		patchCurrentVersion,
		revertDraftTo,
		setDraftStatus,
		ingestAiDraft,
		ingestAiDocumentDraft,
		viewportW,
		pruneOldEmailAttachmentFiles
	} from '$lib/stores/email';

	$: openDraft = $emailDrafts.find((d) => d.id === $openDraftId && d.status === 'active') ?? null;

	onMount(() => {
		// Automation/QA hook: seed an AI `email_draft_dialog` payload programmatically.
		// Client-side only (manipulates draft UI state); sending still requires the
		// user to confirm and the backend, so this is benign to leave exposed.
		(window as any).__seedEmailDraft = (draftId: string, payload: any) =>
			ingestAiDraft(draftId, payload);
		(window as any).__seedDocumentDraft = (draftId: string, payload: any) =>
			ingestAiDocumentDraft(draftId, payload, { open: true, force: true });

		// Keep the shared viewport width current (drives the chat-side reservation).
		const onResize = () => viewportW.set(window.innerWidth);
		onResize();
		window.addEventListener('resize', onResize);

		// Opportunistic janitor: drop this user's email-attachment files older than
		// a month (throttled to once/day per browser).
		void pruneOldEmailAttachmentFiles();

		return () => window.removeEventListener('resize', onResize);
	});
</script>

{#if openDraft}
	{#key openDraft.id}
		{#if openDraft.kind === 'document'}
			<DocumentDraftDialog draft={openDraft} on:close={() => openDraftId.set(null)} />
		{:else}
			<EmailDraftDialog
				draftId={openDraft.id}
				mailboxId={openDraft.mailbox_id}
				version={currentVersion(openDraft)}
				status={openDraft.status}
				versionIndex={openDraft.currentVersion}
				versionCount={openDraft.versions.length}
				on:edit={(e) => patchCurrentVersion(openDraft.id, e.detail)}
				on:revert={(e) => revertDraftTo(openDraft.id, e.detail.index)}
				on:sent={() => setDraftStatus(openDraft.id, 'sent')}
				on:drop={() => setDraftStatus(openDraft.id, 'dropped')}
				on:close={() => openDraftId.set(null)}
			/>
		{/if}
	{/key}
{/if}

{#if $draftHistoryOpen}
	<DraftHistoryPanel />
{/if}
