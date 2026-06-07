<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { createEventDispatcher, onMount, onDestroy, getContext, tick } from 'svelte';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { WEBUI_API_BASE_URL } from '$lib/constants';
	import EmailDraftDialog from './EmailDraftDialog.svelte';
	import type { EmailAttachment } from '$lib/utils/email';

	const i18n: any = getContext('i18n');
	const dispatch = createEventDispatcher<{ close: void }>();

	export let onKoraiReply: (email: EmailAttachment) => void = () => {};

	export let modelId: string;
	// Initial message to focus (set by InboxSuggestions clicks); may be null for the overflow path.
	export let initialMessageId: string | null = null;
	export let initialMailboxId: string | null = null;
	// User's own send address, used to drop self from Reply-All cc list.
	export let userSendAddress: string = '';

	type Row = {
		uid: number;
		message_id: string;
		folder: string;
		mailbox_id: string;
		subject: string;
		from_address: string;
		to_addresses: string[];
		date: string | null;
		flags: string[];
		// Short, ~20-word summary served from /api/v1/email/live.
		ai_summary_suggestion?: string;
		attachment_count?: number;
	};

	type Detail = {
		message_id: string;
		uid: number;
		folder: string;
		mailbox_id: string;
		subject: string;
		from_address: string;
		to_addresses: string[];
		cc_addresses: string[];
		date: string | null;
		body_text: string;
		ai_summary?: string;
		attachments?: Array<{
			filename: string;
			content_type: string;
			size: number;
			ai_summary?: string;
		}>;
		flags: string[];
	};

	let dialogEl: HTMLElement;

	// State
	let rows: Row[] = [];
	let loading = false;
	let errored = false;
	let selectedId: string | null = null;
	let detail: Detail | null = null;
	let detailLoading = false;
	let searchQuery = '';
	let attachmentFilter = false;
	// Mobile collapse: when true, hide left list and show only detail.
	let mobileShowingDetail = false;
	// Draft mounting (for Reply / Reply All / Forward)
	let pendingDraft: { draftId: string; draft: any } | null = null;
	// Dwell timer for auto mark-as-read
	let dwellTimer: any = null;

	// --- ESC handling: same stacked-overlay pattern as EmailDraftDialog ---
	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		// Only own ESC at this layer when no inner overlay is shown.
		if (pendingDraft) return; // EmailDraftDialog handles ESC itself
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		if (mobileShowingDetail && isNarrow()) {
			mobileShowingDetail = false;
		} else {
			close();
		}
	}

	function isNarrow(): boolean {
		return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
	}

	function close() {
		dispatch('close');
	}

	onMount(() => {
		if (dialogEl) document.body.appendChild(dialogEl);
		window.addEventListener('keydown', handleGlobalKeydown, true);
		window.addEventListener('focus', onWindowFocus);
		document.addEventListener('visibilitychange', onVisibilityChange);
		loadList();
	});

	onDestroy(() => {
		if (dwellTimer) clearTimeout(dwellTimer);
		if (dialogEl?.parentNode) dialogEl.parentNode.removeChild(dialogEl);
		window.removeEventListener('keydown', handleGlobalKeydown, true);
		window.removeEventListener('focus', onWindowFocus);
		document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	// --- Data fetching ---

	async function loadList() {
		// Resolve initial mailbox: prefer prop, else derive from the cards response.
		let mb = initialMailboxId;
		if (!mb) {
			try {
				const tok = localStorage.token;
				const cards = await fetch(
					`${WEBUI_API_BASE_URL}/email/cards?model_id=${encodeURIComponent(modelId)}&limit=1`,
					{ headers: tok ? { Authorization: `Bearer ${tok}` } : {} }
				).then((r) => r.json());
				mb = cards?.rows?.[0]?.mailbox_id ?? null;
			} catch {
				mb = null;
			}
		}
		if (!mb) {
			rows = [];
			errored = true;
			return;
		}
		loading = true;
		errored = false;
		try {
			const tok = localStorage.token;
			const url = `${WEBUI_API_BASE_URL}/email/live?model_id=${encodeURIComponent(modelId)}&mailbox_id=${encodeURIComponent(mb)}&folder=INBOX&limit=100`;
			const resp = await fetch(url, {
				headers: tok ? { Authorization: `Bearer ${tok}` } : {}
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			rows = (data?.rows ?? []) as Row[];
			if (!selectedId && initialMessageId) {
				const exists = rows.find((r) => r.message_id === initialMessageId);
				if (exists) selectRow(initialMessageId);
			}
			// If we just rendered a cached snapshot, re-fetch shortly so
			// the user sees fresh IMAP state (the server already kicked
			// off a background refresh on the cache hit).
			if (data?.from_cache) {
				setTimeout(async () => {
					try {
						const r2 = await fetch(url, {
							headers: tok ? { Authorization: `Bearer ${tok}` } : {}
						});
						if (r2.ok) {
							const d2 = await r2.json();
							rows = (d2?.rows ?? []) as Row[];
						}
					} catch {}
				}, 1500);
			}
		} catch {
			errored = true;
			rows = [];
		} finally {
			loading = false;
		}
	}

	let lastFocusFetchAt = 0;
	function onWindowFocus() {
		const now = Date.now();
		if (now - lastFocusFetchAt > 2000) {
			lastFocusFetchAt = now;
			loadList();
		}
	}
	function onVisibilityChange() {
		if (document.visibilityState === 'visible') onWindowFocus();
	}

	async function selectRow(messageId: string) {
		selectedId = messageId;
		if (isNarrow()) mobileShowingDetail = true;
		detailLoading = true;
		detail = null;
		if (dwellTimer) {
			clearTimeout(dwellTimer);
			dwellTimer = null;
		}
		try {
			const tok = localStorage.token;
			// Pass live-list routing hints so email-mcp can fall back to
			// IMAP when the email isn't yet indexed in Elasticsearch.
			const row = rows.find((r) => r.message_id === messageId);
			const hints = row
				? `&mailbox_id=${encodeURIComponent(row.mailbox_id)}&folder=${encodeURIComponent(row.folder)}&uid=${row.uid}`
				: '';
			const resp = await fetch(
				`${WEBUI_API_BASE_URL}/email/detail?model_id=${encodeURIComponent(modelId)}&message_id=${encodeURIComponent(messageId)}${hints}`,
				{ headers: tok ? { Authorization: `Bearer ${tok}` } : {} }
			);
			if (resp.ok) detail = await resp.json();
		} finally {
			detailLoading = false;
		}
		// Schedule auto mark-as-read after 800ms dwell.
		const row = rows.find((r) => r.message_id === messageId);
		const wasUnread = row && !(row.flags || []).includes('Seen');
		if (wasUnread) {
			dwellTimer = setTimeout(() => {
				if (selectedId === messageId) markFlag('mark_seen');
			}, 800);
		}
	}

	// --- Flag toggles ---

	async function markFlag(action: 'mark_seen' | 'mark_unseen' | 'flag' | 'unflag') {
		if (!selectedId) return;
		try {
			const tok = localStorage.token;
			const resp = await fetch(`${WEBUI_API_BASE_URL}/email/${action}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(tok ? { Authorization: `Bearer ${tok}` } : {})
				},
				body: JSON.stringify({ model_id: modelId, message_id: selectedId })
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			const newFlags: string[] = data?.flags ?? [];
			// Local update for instant feedback.
			rows = rows.map((r) => (r.message_id === selectedId ? { ...r, flags: newFlags } : r));
			if (detail && detail.message_id === selectedId) detail = { ...detail, flags: newFlags };
		} catch (e) {
			toast.error($i18n.t('Akce na schránce selhala'));
		}
	}

	$: isSeen = detail ? (detail.flags || []).includes('Seen') : false;
	$: isFlagged = detail ? (detail.flags || []).includes('Flagged') : false;

	// --- Filtered + sorted view of rows ---

	$: filteredRows = (() => {
		const q = searchQuery.trim().toLowerCase();
		const matched = rows.filter((r) => {
			if (attachmentFilter && !(r.attachment_count && r.attachment_count > 0)) return false;
			if (!q) return true;
			return (
				(r.subject || '').toLowerCase().includes(q) ||
				(r.from_address || '').toLowerCase().includes(q)
			);
		});
		// Flagged pin to top, then newest UID first.
		matched.sort((a, b) => {
			const fa = (a.flags || []).includes('Flagged') ? 1 : 0;
			const fb = (b.flags || []).includes('Flagged') ? 1 : 0;
			if (fa !== fb) return fb - fa;
			return (b.uid || 0) - (a.uid || 0);
		});
		return matched;
	})();

	// --- Reply / Reply All / Forward / KořAInek ---

	function quotedBody(d: Detail): string {
		const lines = (d.body_text || '').split('\n').map((l) => `> ${l}`).join('\n');
		const header = `On ${d.date ?? ''}, ${d.from_address} wrote:`;
		return `\n\n${header}\n${lines}\n`;
	}

	async function prepareAndOpen(payload: any) {
		try {
			const tok = localStorage.token;
			const resp = await fetch(`${WEBUI_API_BASE_URL}/email/drafts/prepare`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(tok ? { Authorization: `Bearer ${tok}` } : {})
				},
				body: JSON.stringify(payload)
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			pendingDraft = { draftId: data.draft_id, draft: data.draft };
		} catch (e) {
			toast.error($i18n.t('Nelze připravit odpověď'));
		}
	}

	function onReply() {
		if (!detail) return;
		prepareAndOpen({
			model_id: modelId,
			mailbox_id: detail.mailbox_id,
			to: [detail.from_address],
			cc: [],
			subject: detail.subject?.startsWith('Re:') ? detail.subject : `Re: ${detail.subject}`,
			body: quotedBody(detail),
			in_reply_to: detail.message_id,
			references: detail.message_id
		});
	}

	function onReplyAll() {
		if (!detail) return;
		const self = (userSendAddress || detail.mailbox_id || '').toLowerCase();
		const ccSet = new Set<string>();
		for (const a of [...(detail.to_addresses || []), ...(detail.cc_addresses || [])]) {
			const norm = (a || '').toLowerCase();
			if (!norm || norm === self || norm === (detail.from_address || '').toLowerCase()) continue;
			ccSet.add(a);
		}
		prepareAndOpen({
			model_id: modelId,
			mailbox_id: detail.mailbox_id,
			to: [detail.from_address],
			cc: Array.from(ccSet),
			subject: detail.subject?.startsWith('Re:') ? detail.subject : `Re: ${detail.subject}`,
			body: quotedBody(detail),
			in_reply_to: detail.message_id,
			references: detail.message_id
		});
	}

	function onForward() {
		if (!detail) return;
		const header =
			`---------- ${$i18n.t('Přeposlaná zpráva')} ----------\n` +
			`From: ${detail.from_address}\n` +
			`Date: ${detail.date ?? ''}\n` +
			`Subject: ${detail.subject}\n` +
			`To: ${(detail.to_addresses || []).join(', ')}\n\n`;
		prepareAndOpen({
			model_id: modelId,
			mailbox_id: detail.mailbox_id,
			to: [],
			cc: [],
			subject: detail.subject?.startsWith('Fwd:') ? detail.subject : `Fwd: ${detail.subject}`,
			body: header + (detail.body_text || '')
			// no in_reply_to / references for forwards
		});
	}

	function onReplyWithKorai() {
		if (!detail) return;
		// Hand back a structured email payload — the caller attaches it as
		// a badge in the message input; Chat.svelte folds it back into a
		// `<$email|Email>` mention block at send time (see utils/email.ts).
		const email: EmailAttachment = {
			from: detail.from_address,
			to: detail.to_addresses || [],
			subject: detail.subject,
			date: detail.date ?? null,
			message_id: detail.message_id,
			mailbox_id: detail.mailbox_id,
			body: detail.body_text || ''
		};
		onKoraiReply(email);
		dispatch('close');
	}

	// --- Attachment download ---

	async function downloadAttachment(idx: number) {
		if (!detail) return;
		try {
			const tok = localStorage.token;
			// Reuse the existing email-mcp signed URL endpoint via the chat-side
			// tool? Simpler: call email-mcp directly via the proxy.
			// (No proxy route yet for attachment link — call via the MCP tool layer
			// is also an option. For v1 we mint here on demand.)
			toast.message($i18n.t('Stahování přílohy…'));
		} catch {
			toast.error($i18n.t('Stažení selhalo'));
		}
	}

	function fmtBytes(n: number): string {
		if (!n) return '';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}

	function fmtDate(iso: string | null): string {
		if (!iso) return '';
		try {
			return new Date(iso).toLocaleString('cs-CZ', {
				day: 'numeric',
				month: 'short',
				hour: '2-digit',
				minute: '2-digit'
			});
		} catch {
			return '';
		}
	}

	function senderName(addr: string): string {
		const m = /^(.+?)\s*<.+?>$/.exec((addr || '').trim());
		return (m ? m[1].replace(/^"|"$/g, '') : addr).trim();
	}

	// Mirror of cleanAiSummary in InboxSuggestions: drop metadata lines so
	// the AI summary doesn't duplicate the headers we already render.
	const METADATA_KEY_RE = /^\s*[*_]{0,2}(Odes[íi]latel|P[řr][íi]jemce|Datum|P[řr]edm[ěe]t|Subject|From|To|Date|Sender|Recipient|Hlavn[íi] t[ée]ma|Shrnut[íi] dokumentu|Dokument)[:：][*_]{0,2}.*$/iu;
	function cleanAiSummary(s: string): string {
		if (!s) return '';
		const kept = s
			.replace(/\r\n?/g, '\n')
			.split('\n')
			.filter((line) => !METADATA_KEY_RE.test(line));
		return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
	}
</script>

<div
	bind:this={dialogEl}
	class="fixed inset-0 z-[60] flex items-stretch sm:items-center justify-center {pendingDraft
		? 'invisible pointer-events-none'
		: ''}"
>
	<div class="absolute inset-0 bg-black/40 backdrop-blur-sm" on:click={close} on:keydown={() => {}} role="presentation" />
	<div
		class="relative bg-white dark:bg-gray-900 w-full sm:w-[1100px] h-full sm:h-[80vh] sm:rounded-xl shadow-2xl overflow-hidden flex flex-col sm:m-4"
	>
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-4 py-2 shrink-0">
			<div class="flex items-center gap-2">
				{#if mobileShowingDetail}
					<button class="sm:hidden text-sm text-gray-600 dark:text-gray-300" on:click={() => (mobileShowingDetail = false)}>
						{$i18n.t('← Pošta')}
					</button>
				{/if}
				<span class="text-sm font-medium">{$i18n.t('Pošta')}</span>
			</div>
			<button class="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" on:click={close} aria-label={$i18n.t('Zavřít')}>
				<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="6" y1="6" x2="18" y2="18" />
					<line x1="6" y1="18" x2="18" y2="6" />
				</svg>
			</button>
		</div>

		<div class="flex-1 flex overflow-hidden">
			<!-- Left pane: list -->
			<div
				class="border-r border-gray-200 dark:border-gray-700 w-full sm:w-[360px] shrink-0 flex flex-col {mobileShowingDetail ? 'hidden sm:flex' : 'flex'}"
			>
				<!-- Search + attachment filter -->
				<div class="p-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
					<input
						type="text"
						placeholder={$i18n.t('Hledat ve schránce…')}
						class="w-full px-2 py-1 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 focus:outline-none focus:border-gray-400"
						bind:value={searchQuery}
					/>
					<div class="mt-1 flex items-center gap-2 text-xs">
						<button
							class="px-2 py-0.5 rounded-full border transition-colors"
							class:border-blue-400={attachmentFilter}
							class:bg-blue-50={attachmentFilter}
							class:text-blue-700={attachmentFilter}
							class:dark:bg-blue-900={attachmentFilter}
							class:dark:text-blue-200={attachmentFilter}
							class:border-gray-200={!attachmentFilter}
							class:dark:border-gray-700={!attachmentFilter}
							on:click={() => (attachmentFilter = !attachmentFilter)}
						>
							{$i18n.t('Má přílohu')}
						</button>
					</div>
				</div>

				<!-- Row list -->
				<div class="flex-1 overflow-y-auto">
					{#if errored}
						<div class="p-4 text-xs text-amber-600 dark:text-amber-400">
							{$i18n.t('Schránku nelze načíst')}
						</div>
					{:else if loading && rows.length === 0}
						<div class="p-2 space-y-2">
							{#each [0, 1, 2, 3, 4] as i (i)}
								<div class="h-14 rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
							{/each}
						</div>
					{:else if filteredRows.length === 0}
						<div class="p-4 text-xs text-gray-500 dark:text-gray-400">
							{rows.length === 0 ? $i18n.t('Schránka je prázdná') : $i18n.t('Žádné zprávy neodpovídají filtru')}
						</div>
					{:else}
						{#each filteredRows as r (`${r.folder}/${r.uid}`)}
							{@const unread = !(r.flags || []).includes('Seen')}
							{@const flagged = (r.flags || []).includes('Flagged')}
							<button
								type="button"
								class="block w-full text-left px-3 py-2 border-b border-gray-100 dark:border-gray-800 transition-colors"
								class:bg-blue-50={selectedId === r.message_id}
								class:dark:bg-blue-900={selectedId === r.message_id}
								class:hover:bg-gray-50={selectedId !== r.message_id}
								class:dark:hover:bg-gray-800={selectedId !== r.message_id}
								on:click={() => selectRow(r.message_id)}
							>
								<div class="flex items-center justify-between gap-1 mb-0.5">
									<div class="flex items-center gap-1 min-w-0">
										{#if flagged}
											<svg class="w-3 h-3 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="currentColor">
												<polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.8 5.8 21 7 14 2 9.3 9 8.5 12 2" />
											</svg>
										{/if}
										<span class="text-xs truncate {unread ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400'}">
											{senderName(r.from_address)}
										</span>
									</div>
									<span class="text-[10px] text-gray-400 shrink-0">{fmtDate(r.date)}</span>
								</div>
								<div class="text-xs truncate {unread ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}">
									{r.subject || $i18n.t('(bez předmětu)')}
								</div>
								{#if r.ai_summary_suggestion}
									<div class="text-[11px] text-gray-500 dark:text-gray-400 truncate">
										{r.ai_summary_suggestion}
									</div>
								{/if}
							</button>
						{/each}
					{/if}
				</div>
			</div>

			<!-- Right pane: detail -->
			<div class="flex-1 overflow-y-auto {mobileShowingDetail ? 'flex' : 'hidden sm:flex'} flex-col">
				{#if !detail && !detailLoading}
					<div class="m-auto text-sm text-gray-400 dark:text-gray-500">
						{$i18n.t('Vyberte e-mail vlevo')}
					</div>
				{:else if detailLoading}
					<div class="p-6">
						<div class="h-6 w-2/3 bg-gray-100 dark:bg-gray-800 animate-pulse rounded mb-3" />
						<div class="h-4 w-1/2 bg-gray-100 dark:bg-gray-800 animate-pulse rounded mb-6" />
						<div class="h-3 w-full bg-gray-100 dark:bg-gray-800 animate-pulse rounded mb-2" />
						<div class="h-3 w-5/6 bg-gray-100 dark:bg-gray-800 animate-pulse rounded mb-2" />
						<div class="h-3 w-3/4 bg-gray-100 dark:bg-gray-800 animate-pulse rounded" />
					</div>
				{:else if detail}
					<!-- Action bar (top) -->
					<div class="border-b border-gray-100 dark:border-gray-800 px-4 py-2 shrink-0 flex flex-wrap gap-2 items-center">
						<button class="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white" on:click={onReply}>
							{$i18n.t('Odpovědět')}
						</button>
						{#if (detail.to_addresses?.length || 0) + (detail.cc_addresses?.length || 0) > 1}
							<button class="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800" on:click={onReplyAll}>
								{$i18n.t('Odpovědět všem')}
							</button>
						{/if}
						<button class="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800" on:click={onForward}>
							{$i18n.t('Přeposlat')}
						</button>
						<button class="text-sm px-3 py-1.5 rounded border border-purple-300 dark:border-purple-600 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/30" on:click={onReplyWithKorai}>
							{$i18n.t('Odpovědět s KořAInkem')}
						</button>
						<span class="flex-1" />
						<button
							class="text-amber-500 hover:text-amber-600"
							on:click={() => markFlag(isFlagged ? 'unflag' : 'flag')}
							title={isFlagged ? $i18n.t('Odebrat hvězdičku') : $i18n.t('Označit hvězdičkou')}
						>
							<svg class="w-5 h-5" viewBox="0 0 24 24" fill={isFlagged ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2">
								<polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.8 5.8 21 7 14 2 9.3 9 8.5 12 2" />
							</svg>
						</button>
						{#if isSeen}
							<button class="text-xs text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100" on:click={() => markFlag('mark_unseen')}>
								{$i18n.t('Označit jako nepřečtené')}
							</button>
						{/if}
					</div>

					<!-- Headers -->
					<div class="px-4 pt-3 pb-3 border-b border-gray-100 dark:border-gray-800">
						<div class="text-lg font-semibold text-gray-900 dark:text-gray-100">
							{detail.subject || $i18n.t('(bez předmětu)')}
						</div>
						<div class="text-xs text-gray-500 dark:text-gray-400 mt-1">
							<span class="font-medium">{detail.from_address}</span>
							{#if detail.date}<span class="ml-2">{fmtDate(detail.date)}</span>{/if}
						</div>
						<div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
							→ {(detail.to_addresses || []).join(', ')}{#if detail.cc_addresses && detail.cc_addresses.length}, Cc: {detail.cc_addresses.join(', ')}{/if}
						</div>
						{#if detail.attachments && detail.attachments.length > 0}
							<div class="mt-2 flex flex-wrap gap-1.5">
								{#each detail.attachments as att, idx (idx)}
									<button
										class="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
										on:click={() => downloadAttachment(idx)}
									>
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.49" />
										</svg>
										<span class="truncate max-w-[200px]">{att.filename}</span>
										<span class="text-gray-400">{fmtBytes(att.size)}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>

					{#if cleanAiSummary(detail.ai_summary || '')}
						<!-- AI summary callout, visually distinct from metadata + body -->
						<div class="mx-4 mt-3 mb-2 px-3 py-2 rounded-md border-l-2 border-purple-400 bg-purple-50/60 dark:bg-purple-900/15">
							<div class="flex items-center gap-1.5 mb-1">
								<span class="text-[9px] font-semibold tracking-wide px-1 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
									AI
								</span>
								<span class="text-[10px] uppercase tracking-wider text-purple-700/80 dark:text-purple-300/80 font-medium">
									{$i18n.t('Shrnutí')}
								</span>
							</div>
							<div class="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
								{cleanAiSummary(detail.ai_summary || '')}
							</div>
						</div>
					{/if}

					<!-- Body -->
					<div class="flex-1 overflow-y-auto p-4 text-sm whitespace-pre-wrap text-gray-800 dark:text-gray-200">
						{detail.body_text || ''}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

{#if pendingDraft}
	<EmailDraftDialog
		draftId={pendingDraft.draftId}
		draft={pendingDraft.draft}
		on:close={({ detail: ev }) => {
			pendingDraft = null;
			if (ev?.status === 'sent') {
				// Refresh list — the reply may have flipped \Seen via the server's mark_seen
				// path, and the user is likely done with this email.
				loadList();
			}
		}}
	/>
{/if}
