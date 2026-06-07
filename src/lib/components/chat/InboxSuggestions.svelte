<script lang="ts">
	import { onMount, onDestroy, getContext, createEventDispatcher } from 'svelte';
	import { fade } from 'svelte/transition';
	import { WEBUI_API_BASE_URL } from '$lib/constants';

	const i18n: any = getContext('i18n');
	const dispatch = createEventDispatcher();

	// Either of these is enough — if both are provided, atSelectedModel wins.
	export let atSelectedModel: any = undefined;
	export let effectiveModel: any = undefined;
	export let selectedModelId: string = '';

	type Card = {
		message_id: string;
		mailbox_id: string;
		subject: string;
		from_address: string;
		date: string | null;
		// Backend already trims metadata + clips to ~20 words; render verbatim.
		ai_summary_suggestion: string;
		attachment_count: number;
		flags: string[];
	};

	let rows: Card[] = [];
	let totalUnread = 0;
	let totalUnreadToday = 0;
	let loaded = false;
	let loading = false;
	let errored = false;
	let lastFetchAt: number | null = null;
	let now = Date.now();
	let nowTimer: any = null;

	$: model = atSelectedModel ?? effectiveModel;
	$: skillEnabled =
		Array.isArray(model?.info?.meta?.skillIds) &&
		model.info.meta.skillIds.includes('email');

	$: modelId = selectedModelId || model?.id || '';

	function formatRelative(ms: number): string {
		if (ms < 60_000) return $i18n.t('právě teď');
		const mins = Math.floor(ms / 60_000);
		if (mins < 60) return $i18n.t('před {{n}} min', { n: mins });
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return $i18n.t('před {{n}} h', { n: hrs });
		return $i18n.t('před více než dnem');
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '';
		try {
			const d = new Date(iso);
			const today = new Date();
			const isSameDay =
				d.getFullYear() === today.getFullYear() &&
				d.getMonth() === today.getMonth() &&
				d.getDate() === today.getDate();
			if (isSameDay) {
				return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
			}
			return d.toLocaleDateString('cs-CZ', {
				day: 'numeric',
				month: 'short'
			});
		} catch {
			return '';
		}
	}

	function displaySender(addr: string): string {
		if (!addr) return '';
		const m = /^(.+?)\s*<.+?>$/.exec(addr.trim());
		return (m ? m[1].replace(/^"|"$/g, '') : addr).trim();
	}


	async function load() {
		if (!skillEnabled || !modelId) {
			rows = [];
			totalUnread = 0;
			loaded = true;
			return;
		}
		loading = true;
		errored = false;
		try {
			const token = localStorage.token;
			const resp = await fetch(
				`${WEBUI_API_BASE_URL}/email/cards?model_id=${encodeURIComponent(modelId)}&limit=10`,
				{ headers: token ? { Authorization: `Bearer ${token}` } : {} }
			);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			rows = (data?.rows ?? []) as Card[];
			totalUnread = data?.total_unread ?? rows.length;
			totalUnreadToday = data?.total_unread_today ?? 0;
			lastFetchAt = Date.now();
		} catch (e) {
			errored = true;
			rows = [];
			totalUnread = 0;
			totalUnreadToday = 0;
		} finally {
			loading = false;
			loaded = true;
		}
	}

	// Refetch on tab focus, but debounce so alt-tab spam doesn't hammer the API.
	let lastFocusFetchAt = 0;
	function onFocus() {
		const now = Date.now();
		if (now - lastFocusFetchAt > 2000) {
			lastFocusFetchAt = now;
			load();
		}
	}

	onMount(() => {
		load();
		nowTimer = setInterval(() => (now = Date.now()), 30_000);
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') onFocus();
		});
	});

	onDestroy(() => {
		if (nowTimer) clearInterval(nowTimer);
		window.removeEventListener('focus', onFocus);
	});

	// Re-load if the selected model changes.
	let lastModelId = '';
	$: if (modelId && modelId !== lastModelId) {
		lastModelId = modelId;
		load();
	}

	function openDetail(messageId: string) {
		dispatch('open', { messageId });
	}

	function openOverflow() {
		dispatch('open', { messageId: null });
	}
</script>

{#if skillEnabled && (loading || rows.length > 0 || errored)}
	<div
		class="w-full font-primary mb-4 rounded-3xl border border-gray-100/40 dark:border-gray-800/40 bg-white/40 dark:bg-gray-500/5 backdrop-blur-sm px-4 py-3 shadow-sm"
		in:fade={{ duration: 200, delay: 100 }}
		data-testid="inbox-suggestions"
	>
		<!-- Header row: title + freshness + overflow link + refresh icon (all at the top) -->
		<div class="mb-2 flex gap-2 text-xs font-medium items-center text-gray-600 dark:text-gray-400">
			<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
				<polyline points="22,6 12,13 2,6" />
			</svg>
			<span>{$i18n.t('Pošta')}</span>
			{#if lastFetchAt}
				<span class="text-gray-400 dark:text-gray-500 font-normal">
					·
					{$i18n.t('Aktualizováno')}
					{formatRelative(now - lastFetchAt)}
				</span>
			{/if}
			{#if totalUnreadToday > 0}
				<span
					class="inline-flex items-center h-[1.05rem] px-1.5 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-[1.05rem] whitespace-nowrap"
					aria-label={$i18n.t('{{n}} dnešních nepřečtených', { n: totalUnreadToday })}
					title={$i18n.t('Dnešní pošta — {{n}} nepřečtených', { n: totalUnreadToday })}
				>{totalUnreadToday} dnes</span>
			{/if}
			{#if totalUnread > rows.length}
				<button
					class="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-normal ml-1"
					on:click={openOverflow}
				>
					{$i18n.t('Zobrazit vše')} →
				</button>
			{/if}
			<span class="flex-1" />
			<button
				class="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-50"
				on:click={load}
				disabled={loading}
				aria-label={$i18n.t('Obnovit')}
				title={$i18n.t('Obnovit')}
			>
				{#if loading}
					<svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 12a9 9 0 1 1-3-6.7" />
					</svg>
				{:else}
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 12a9 9 0 1 1-3-6.7" />
						<polyline points="21 4 21 10 15 10" />
					</svg>
				{/if}
			</button>
		</div>

		{#if errored}
			<div class="text-xs text-amber-600 dark:text-amber-400 px-3 py-2 rounded">
				{$i18n.t('Schránku nelze načíst')}
			</div>
		{:else if loading && rows.length === 0}
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-1">
				{#each [0, 1, 2, 3] as i (i)}
					<div class="h-16 rounded-xl bg-black/5 dark:bg-white/5 animate-pulse" />
				{/each}
			</div>
		{:else}
			<div role="list" class="grid grid-cols-1 sm:grid-cols-2 gap-0.5 items-start">
				{#each rows as r, idx (r.message_id)}
					<!-- svelte-ignore a11y-no-interactive-element-to-noninteractive-role -->
					{@const summary = (r.ai_summary_suggestion || '').trim()}
					<button
						type="button"
						role="listitem"
						class="waterfall text-left flex flex-col px-3 py-2 rounded-xl bg-transparent hover:bg-black/5 dark:hover:bg-white/5 transition group"
						style="animation-delay: {idx * 30}ms"
						on:click={() => openDetail(r.message_id)}
					>
						<!-- Metadata header -->
						<div class="flex items-baseline justify-between gap-2">
							<span class="text-xs text-gray-600 dark:text-gray-400 truncate">
								{displaySender(r.from_address)}
							</span>
							<div class="flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
								{#if r.attachment_count > 0}
									<span class="inline-flex items-center gap-0.5" title={$i18n.t('Přílohy: {{n}}', { n: r.attachment_count })}>
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.49" />
										</svg>
										{r.attachment_count}
									</span>
								{/if}
								<span>{formatDate(r.date)}</span>
							</div>
						</div>
						<div class="text-sm font-medium text-gray-800 dark:text-gray-200 dark:group-hover:text-gray-100 transition truncate">
							{r.subject || $i18n.t('(bez předmětu)')}
						</div>
						<!-- ~20-word AI summary, set apart from the metadata. -->
						{#if summary}
							<div class="mt-1 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
								<span class="shrink-0 mt-[2px] inline-flex items-center justify-center text-[9px] font-semibold tracking-wide px-1 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
									AI
								</span>
								<span>{summary}</span>
							</div>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	@keyframes fadeInUp {
		0% {
			opacity: 0;
			transform: translateY(8px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}
	.waterfall {
		opacity: 0;
		animation-name: fadeInUp;
		animation-duration: 200ms;
		animation-fill-mode: forwards;
		animation-timing-function: ease;
	}
</style>
