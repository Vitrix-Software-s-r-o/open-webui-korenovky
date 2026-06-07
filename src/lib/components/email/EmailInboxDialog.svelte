<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { createEventDispatcher, onMount, onDestroy, getContext, tick } from 'svelte';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { WEBUI_API_BASE_URL } from '$lib/constants';
	import EmailDraftDialog from './EmailDraftDialog.svelte';
	import DateRangePicker from './DateRangePicker.svelte';
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
		// Body excerpt served from /api/v1/email/search.
		body_preview?: string;
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
	let unreadOnly = false;
	let dateRange: { from: string | null; to: string | null } = { from: null, to: null };
	let datePreset: string | null = null;
	let folder = 'INBOX';
	// IMAP names the "Sent" folder differently per provider; we detect it
	// from /folders so the toggle works on Gmail, Seznam, Office365, etc.
	let sentFolder: string | null = null;
	let foldersLoaded = false;
	let currentMailboxId: string | null = null;
	// Hybrid: 'live' uses /inbox/live (cached IMAP snapshot, INBOX-only,
	// client-side filtered); 'search' goes to ES via /api/v1/email/search.
	let mode: 'live' | 'search' = 'live';
	let searchOffset = 0;
	let searchTotal = 0;
	let searchLoadingMore = false;
	let reloadTimer: any = null;
	let fetchSeq = 0;
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

	// Public entry point. Resolves the mailbox on first call, then dispatches
	// to the live or search loader based on `mode`.
	async function loadList() {
		if (!currentMailboxId) {
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
			currentMailboxId = mb;
			// Kick the folder list off — non-blocking, used by the folder picker.
			loadFolders();
		}
		if (mode === 'search') {
			await loadSearch(true);
		} else {
			await loadLive();
		}
	}

	async function loadFolders() {
		if (foldersLoaded || !currentMailboxId) return;
		foldersLoaded = true;
		try {
			const tok = localStorage.token;
			const url = `${WEBUI_API_BASE_URL}/email/folders?model_id=${encodeURIComponent(modelId)}&mailbox_id=${encodeURIComponent(currentMailboxId)}`;
			const resp = await fetch(url, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
			if (!resp.ok) return;
			const data = await resp.json();
			const list = (data?.folders ?? []) as string[];
			sentFolder = detectSentFolder(list);
		} catch {
			// non-fatal — Sent toggle just stays hidden
		}
	}

	function detectSentFolder(list: string[]): string | null {
		// Common IMAP names for the Sent folder, in priority order.
		// Most servers expose one of these verbatim; Gmail uses
		// "[Gmail]/Sent Mail"; Czech webmail occasionally uses
		// "Odeslaná pošta".
		const candidates = [
			/^sent$/i,
			/^sent items$/i,
			/^sent messages$/i,
			/^sent mail$/i,
			/\[gmail\]\/sent mail$/i,
			/^odeslan/i
		];
		for (const re of candidates) {
			const hit = list.find((f) => re.test(f));
			if (hit) return hit;
		}
		return null;
	}

	async function loadLive() {
		if (!currentMailboxId) return;
		loading = true;
		errored = false;
		const seq = ++fetchSeq;
		try {
			const tok = localStorage.token;
			const url = `${WEBUI_API_BASE_URL}/email/live?model_id=${encodeURIComponent(modelId)}&mailbox_id=${encodeURIComponent(currentMailboxId)}&folder=INBOX&limit=100`;
			const resp = await fetch(url, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
			if (seq !== fetchSeq) return; // stale
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			rows = (data?.rows ?? []) as Row[];
			searchTotal = rows.length;
			if (!selectedId && initialMessageId) {
				const exists = rows.find((r) => r.message_id === initialMessageId);
				if (exists) selectRow(initialMessageId);
			}
			if (data?.from_cache) {
				setTimeout(async () => {
					if (mode !== 'live' || seq !== fetchSeq) return;
					try {
						const r2 = await fetch(url, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
						if (r2.ok) {
							const d2 = await r2.json();
							if (mode === 'live' && seq === fetchSeq) {
								rows = (d2?.rows ?? []) as Row[];
								searchTotal = rows.length;
							}
						}
					} catch {}
				}, 1500);
			}
		} catch {
			if (seq === fetchSeq) {
				errored = true;
				rows = [];
			}
		} finally {
			if (seq === fetchSeq) loading = false;
		}
	}

	async function loadSearch(reset: boolean) {
		if (!currentMailboxId) return;
		if (reset) {
			loading = true;
			searchOffset = 0;
		} else {
			searchLoadingMore = true;
		}
		errored = false;
		const seq = ++fetchSeq;
		try {
			const tok = localStorage.token;
			const params = new URLSearchParams();
			params.set('model_id', modelId);
			params.set('mailbox_id', currentMailboxId);
			params.set('limit', '50');
			params.set('offset', String(searchOffset));
			params.set('sort_order', 'desc');
			if (folder) params.set('folder', folder);
			const q = searchQuery.trim();
			if (q.length >= 2) params.append('q', q);
			if (dateRange.from) params.set('date_from', dateRange.from);
			if (dateRange.to) params.set('date_to', dateRange.to);
			if (attachmentFilter) params.set('has_attachments', 'true');
			if (unreadOnly) params.set('unseen_only', 'true');

			const resp = await fetch(`${WEBUI_API_BASE_URL}/email/search?${params.toString()}`, {
				headers: tok ? { Authorization: `Bearer ${tok}` } : {}
			});
			if (seq !== fetchSeq) return;
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			const incoming = ((data?.results ?? []) as any[]).map(
				(r): Row => ({
					uid: r.uid ?? 0,
					message_id: r.message_id,
					folder: r.folder,
					mailbox_id: r.mailbox_id,
					subject: r.subject ?? '',
					from_address: r.from_address ?? '',
					to_addresses: r.to_addresses ?? [],
					date: r.date ?? null,
					flags: r.flags ?? [],
					body_preview: r.body_preview ?? '',
					attachment_count: r.attachment_count ?? 0
				})
			);
			searchTotal = data?.total ?? incoming.length;
			rows = reset ? incoming : [...rows, ...incoming];
			searchOffset += incoming.length;
		} catch {
			if (seq === fetchSeq && reset) {
				errored = true;
				rows = [];
			}
		} finally {
			if (seq === fetchSeq) {
				loading = false;
				searchLoadingMore = false;
			}
		}
	}

	function scheduleReload(immediate = false) {
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = null;
		}
		const run = () => {
			reloadTimer = null;
			if (mode === 'live') loadLive();
			else loadSearch(true);
		};
		if (immediate) run();
		else reloadTimer = setTimeout(run, 300);
	}

	// Derive the mode from the active filter state. The live cached snapshot
	// is preserved for the empty-filter "triage" case.
	$: filterIsStructured = !!(
		dateRange.from ||
		(folder && folder !== 'INBOX') ||
		unreadOnly ||
		attachmentFilter
	);
	$: filterHasQuery = searchQuery.trim().length >= 2;
	$: nextMode = filterIsStructured || filterHasQuery ? 'search' : 'live';
	$: if (nextMode !== mode) {
		mode = nextMode;
		if (currentMailboxId) scheduleReload();
	}

	function onDateChange(e: CustomEvent<{ from: string | null; to: string | null; preset: string | null }>) {
		dateRange = { from: e.detail.from, to: e.detail.to };
		datePreset = e.detail.preset;
		if (currentMailboxId) scheduleReload();
	}

	function setFolder(next: string) {
		if (folder === next) return;
		folder = next;
		if (currentMailboxId) scheduleReload();
	}

	function onSearchInput() {
		// `searchQuery` already bound; just kick a reload.
		if (mode === 'search' && currentMailboxId) scheduleReload();
	}

	function clearSearch() {
		if (!searchQuery) return;
		searchQuery = '';
		// If a structured filter is still active, mode stays in 'search' and the
		// reactive mode-transition guard won't fire — kick the reload manually
		// so the empty `q` propagates.
		if (mode === 'search' && currentMailboxId) scheduleReload();
	}

	function toggleAttachmentFilter() {
		attachmentFilter = !attachmentFilter;
		if (currentMailboxId) scheduleReload();
	}

	function toggleUnreadOnly() {
		unreadOnly = !unreadOnly;
		if (currentMailboxId) scheduleReload();
	}

	function clearAllFilters() {
		searchQuery = '';
		attachmentFilter = false;
		unreadOnly = false;
		dateRange = { from: null, to: null };
		datePreset = null;
		folder = 'INBOX';
		if (currentMailboxId) scheduleReload(true);
	}

	function loadMore() {
		if (mode === 'search' && !searchLoadingMore && rows.length < searchTotal) {
			loadSearch(false);
		}
	}

	let lastFocusFetchAt = 0;
	function onWindowFocus() {
		// Only auto-refresh the cached snapshot — search results are stable and
		// re-running a search on focus would reset pagination.
		if (mode !== 'live') return;
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
	// In live mode we still client-filter for instant feedback while typing
	// short queries (≤ 1 char). Search-mode results are already filtered by ES
	// and we trust the server's date-desc ordering.

	$: filteredRows = (() => {
		if (mode === 'search') return rows;
		const q = searchQuery.trim().toLowerCase();
		const matched = rows.filter((r) => {
			if (attachmentFilter && !(r.attachment_count && r.attachment_count > 0)) return false;
			if (!q) return true;
			return (
				(r.subject || '').toLowerCase().includes(q) ||
				(r.from_address || '').toLowerCase().includes(q)
			);
		});
		matched.sort((a, b) => {
			const fa = (a.flags || []).includes('Flagged') ? 1 : 0;
			const fb = (b.flags || []).includes('Flagged') ? 1 : 0;
			if (fa !== fb) return fb - fa;
			return (b.uid || 0) - (a.uid || 0);
		});
		return matched;
	})();

	// Render a small folder chip on rows when the result set spans multiple
	// folders, so the user knows where each hit came from.
	$: showFolderChips = mode === 'search' && new Set(rows.map((r) => r.folder)).size > 1;

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
			const params = new URLSearchParams({
				model_id: modelId,
				message_id: detail.message_id,
				attachment_index: String(idx),
				mailbox_id: detail.mailbox_id,
				folder: detail.folder,
				uid: String(detail.uid),
			});
			const resp = await fetch(
				`${WEBUI_API_BASE_URL}/email/attachment_link?${params.toString()}`,
				{ headers: tok ? { Authorization: `Bearer ${tok}` } : {} }
			);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			const url: string | undefined = data?.url;
			if (!url) throw new Error('missing url');
			// Force a download navigation in a hidden anchor: links from
			// email-mcp carry Content-Disposition: attachment, so the
			// browser saves rather than navigates away.
			const a = document.createElement('a');
			a.href = url;
			a.rel = 'noopener';
			a.target = '_blank';
			document.body.appendChild(a);
			a.click();
			a.remove();
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
				<!-- Search + filter strip -->
				<div class="p-2 border-b border-gray-100 dark:border-gray-800 shrink-0 space-y-1.5">
					<div class="relative">
						<input
							type="text"
							placeholder={$i18n.t('Hledat ve schránce…')}
							class="w-full px-2 py-1 pr-7 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 focus:outline-none focus:border-gray-400"
							bind:value={searchQuery}
							on:input={onSearchInput}
						/>
						{#if searchQuery}
							<button
								type="button"
								class="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
								on:click={clearSearch}
								aria-label={$i18n.t('Vymazat vyhledávání')}
								title={$i18n.t('Vymazat vyhledávání')}
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<line x1="6" y1="6" x2="18" y2="18" />
									<line x1="6" y1="18" x2="18" y2="6" />
								</svg>
							</button>
						{/if}
					</div>

					<DateRangePicker value={dateRange} preset={datePreset} on:change={onDateChange} />

					<div class="flex items-center gap-2 text-xs flex-wrap">
						<div class="inline-flex rounded-full border border-gray-200 dark:border-gray-700 overflow-hidden">
							<button
								type="button"
								class="px-2 py-0.5 transition-colors"
								class:bg-blue-50={folder === 'INBOX'}
								class:text-blue-700={folder === 'INBOX'}
								class:dark:bg-blue-900={folder === 'INBOX'}
								class:dark:text-blue-200={folder === 'INBOX'}
								class:text-gray-500={folder !== 'INBOX'}
								class:dark:text-gray-400={folder !== 'INBOX'}
								on:click={() => setFolder('INBOX')}
							>
								{$i18n.t('Doručené')}
							</button>
							<button
								type="button"
								class="px-2 py-0.5 transition-colors border-l border-gray-200 dark:border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
								class:bg-blue-50={sentFolder && folder === sentFolder}
								class:text-blue-700={sentFolder && folder === sentFolder}
								class:dark:bg-blue-900={sentFolder && folder === sentFolder}
								class:dark:text-blue-200={sentFolder && folder === sentFolder}
								class:text-gray-500={!sentFolder || folder !== sentFolder}
								class:dark:text-gray-400={!sentFolder || folder !== sentFolder}
								disabled={!sentFolder}
								title={!sentFolder ? $i18n.t('Složka odeslaných není dostupná') : ''}
								on:click={() => sentFolder && setFolder(sentFolder)}
							>
								{$i18n.t('Odeslané')}
							</button>
						</div>

						<button
							class="px-2 py-0.5 rounded-full border transition-colors"
							class:border-blue-400={unreadOnly}
							class:bg-blue-50={unreadOnly}
							class:text-blue-700={unreadOnly}
							class:dark:bg-blue-900={unreadOnly}
							class:dark:text-blue-200={unreadOnly}
							class:border-gray-200={!unreadOnly}
							class:dark:border-gray-700={!unreadOnly}
							on:click={toggleUnreadOnly}
						>
							{$i18n.t('Nepřečtené')}
						</button>

						<button
							class="px-2 py-0.5 rounded-full border transition-colors"
							class:border-blue-400={attachmentFilter}
							class:bg-blue-50={attachmentFilter}
							class:text-blue-700={attachmentFilter}
							class:dark:bg-blue-900={attachmentFilter}
							class:dark:text-blue-200={attachmentFilter}
							class:border-gray-200={!attachmentFilter}
							class:dark:border-gray-700={!attachmentFilter}
							on:click={toggleAttachmentFilter}
						>
							{$i18n.t('Má přílohu')}
						</button>

						{#if filterIsStructured || filterHasQuery}
							<button
								class="ml-auto text-[10px] text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 underline"
								on:click={clearAllFilters}
							>
								{$i18n.t('Vymazat filtry')}
							</button>
						{/if}
					</div>

					{#if mode === 'search'}
						<div class="text-[10px] text-gray-500 dark:text-gray-400">
							{#if loading}
								{$i18n.t('Hledání…')}
							{:else}
								{searchTotal} {$i18n.t('výsledků')}
							{/if}
						</div>
					{/if}
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
						{#each filteredRows as r (`${r.folder}/${r.uid}/${r.message_id}`)}
							{@const unread = !(r.flags || []).includes('Seen')}
							{@const flagged = (r.flags || []).includes('Flagged')}
							{@const previewLine = r.ai_summary_suggestion || r.body_preview || ''}
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
										{#if showFolderChips}
											<span class="text-[9px] uppercase tracking-wider px-1 py-px rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 shrink-0">
												{r.folder}
											</span>
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
								{#if previewLine}
									<div class="text-[11px] text-gray-500 dark:text-gray-400 truncate">
										{previewLine}
									</div>
								{/if}
							</button>
						{/each}
						{#if mode === 'search' && rows.length < searchTotal}
							<div class="p-2">
								<button
									type="button"
									class="w-full text-xs py-2 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
									disabled={searchLoadingMore}
									on:click={loadMore}
								>
									{searchLoadingMore ? $i18n.t('Načítám…') : $i18n.t('Načíst další')}
								</button>
							</div>
						{/if}
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
