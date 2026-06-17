<script lang="ts">
	import { createEventDispatcher, onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import {
		emailDraftWindow,
		setDraftWindow,
		ingestAiDocumentDraft,
		type ChatDraft
	} from '$lib/stores/email';

	// Shares the email draft's floating-window shell (geometry / drag / resize /
	// snap / teleport-to-body) but renders an OnlyOffice editor as its body.
	export let draft: ChatDraft;

	const dispatch = createEventDispatcher<{ close: void }>();

	let dialogEl: HTMLElement;
	let holderEl: HTMLDivElement;
	let editor: any = null;
	let loadError = '';

	// True while an MCP edit (a background agent run OR a Word/Excel tools/call via
	// the office proxy) is mutating this file — the editor is shown read-only
	// (overlay) until the lock releases, then reloaded with the fresh content.
	// files-link is polled via the same-origin proxy.
	let agentEditing = false;
	let agentPollTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	// Document key currently loaded in OnlyOffice; when the on-disk content key
	// changes (any MCP edit) we fetch a fresh config and re-init to show it.
	let mountedKey: string | null = null;

	function docKey(): string | null {
		return draft?.doc?.editorConfig?.document?.key ?? null;
	}

	// Reactive mirror of the draft's content key. CRUCIAL: the reload guard below
	// must read `draft` *directly* (here) so Svelte tracks it as a dependency —
	// reading it only inside docKey() would hide the dependency and the editor
	// would never reload when the store swaps in a new-version config.
	$: currentKey = draft?.doc?.editorConfig?.document?.key ?? null;

	// Poll files-link for BOTH the lock state and the current on-disk content
	// version, so the editor locks during ANY MCP edit and refreshes after —
	// independent of the model emitting a new draft.
	async function pollStatus() {
		const fn = draft?.doc?.filename;
		if (!fn) return;
		try {
			const r = await fetch('/editor/status?filename=' + encodeURIComponent(fn));
			if (!r.ok) return;
			const data = await r.json();
			agentEditing = !!data?.editing;
			// Refresh to the latest on-disk bytes when the file changed under us
			// and nothing is mid-edit. Fetch a fresh signed config and feed it
			// through the store so the reactive re-init below picks up the new key.
			if (!agentEditing && data?.key && data.key !== mountedKey && !refreshing) {
				refreshing = true;
				try {
					const dr = await fetch('/editor/draft?filename=' + encodeURIComponent(fn));
					if (dr.ok) {
						const payload = await dr.json();
						if (payload?.draft && payload?.draft_id) {
							ingestAiDocumentDraft(payload.draft_id, payload.draft, { open: false });
						}
					}
				} finally {
					refreshing = false;
				}
			}
		} catch {
			/* transient — keep last state */
		}
	}

	// Re-init the editor when the underlying document version (key) changes
	// after the initial mount — i.e. an MCP edit rewrote the file while it was
	// open. Depends on `currentKey` (which tracks `draft`) so it actually fires
	// on a store refresh. Guarded on `editor` so it only fires post-mount.
	$: if (editor && currentKey && currentKey !== mountedKey) {
		destroyEditor();
		mountEditor();
	}

	// --- Shared, chat-persisted window geometry (same store as email drafts) ---
	$: win = $emailDraftWindow;
	let vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
	let vh = typeof window !== 'undefined' ? window.innerHeight : 800;
	function onResize() {
		vw = window.innerWidth;
		vh = window.innerHeight;
	}

	function defaultWindow(vw0: number, vh0: number) {
		const third = Math.floor(vw0 / 3);
		return {
			x: Math.max(16, vw0 - Math.min(480, vw0 - 32) - 16),
			y: 24,
			w: third,
			h: Math.min(620, Math.round(vh0 * 0.85)),
			snap: (third < 400 ? 'top' : 'right') as const
		};
	}

	function computeGeom(s: any, vw0: number, vh0: number) {
		const snap = s?.snap ?? 'none';
		if (snap === 'left') {
			const w = Math.max(360, Math.min(s.w, vw0));
			return { x: 0, y: 0, w, h: vh0 };
		}
		if (snap === 'right') {
			const w = Math.max(360, Math.min(s.w, vw0));
			return { x: vw0 - w, y: 0, w, h: vh0 };
		}
		if (snap === 'top') return { x: 0, y: 0, w: vw0, h: vh0 };
		const w = Math.min(s.w, vw0);
		const h = Math.min(s.h, vh0);
		const x = Math.max(0, Math.min(s.x, vw0 - Math.min(w, 120)));
		const y = Math.max(0, Math.min(s.y, vh0 - 40));
		return { x, y, w, h };
	}

	$: effWin = win ?? defaultWindow(vw, vh);
	$: geom = computeGeom(effWin, vw, vh);
	$: snapped = (effWin.snap ?? 'none') !== 'none';
	$: cardStyle = `left:${geom.x}px; top:${geom.y}px; width:${geom.w}px; height:${geom.h}px;`;
	$: visibleHandles = !snapped
		? RESIZE_HANDLES
		: effWin.snap === 'left'
			? RESIZE_HANDLES.filter((h) => h.dir === 'e')
			: effWin.snap === 'right'
				? RESIZE_HANDLES.filter((h) => h.dir === 'w')
				: [];

	const SNAP_T = 28;
	let snapHint: 'left' | 'right' | 'top' | null = null;
	$: snapPreviewStyle =
		snapHint === 'left'
			? `left:0; top:0; width:${Math.floor(vw / 2)}px; height:${vh}px;`
			: snapHint === 'right'
				? `left:${vw - Math.floor(vw / 2)}px; top:0; width:${Math.floor(vw / 2)}px; height:${vh}px;`
				: snapHint === 'top'
					? `left:0; top:0; width:${vw}px; height:${vh}px;`
					: '';

	function startDrag(e: PointerEvent) {
		if (
			(e.target as HTMLElement).closest(
				'button, a, input, textarea, select, iframe, [contenteditable="true"], [role="textbox"]'
			)
		)
			return;
		if (e.button !== 0) return;
		const baseX = geom.x;
		const baseY = geom.y;
		const freeW = win && win.snap === 'none' ? win.w : Math.min(480, vw - 32);
		const freeH = win && win.snap === 'none' ? win.h : Math.min(620, Math.round(vh * 0.85));
		const start = { px: e.clientX, py: e.clientY };
		let dragging = false;
		function move(ev: PointerEvent) {
			const dx = ev.clientX - start.px;
			const dy = ev.clientY - start.py;
			if (!dragging) {
				if (Math.abs(dx) + Math.abs(dy) < 6) return;
				dragging = true;
				setDraftWindow({ snap: 'none', x: baseX, y: baseY, w: freeW, h: freeH });
			}
			const x = Math.max(0, Math.min(baseX + dx, vw - 80));
			const y = Math.max(0, Math.min(baseY + dy, vh - 40));
			setDraftWindow({ x, y });
			snapHint =
				ev.clientX <= SNAP_T
					? 'left'
					: ev.clientX >= vw - SNAP_T
						? 'right'
						: ev.clientY <= SNAP_T
							? 'top'
							: null;
		}
		function up() {
			if (dragging && snapHint) setDraftWindow({ snap: snapHint, w: Math.floor(vw / 2) });
			snapHint = null;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		}
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		e.preventDefault();
	}

	const MIN_W = 360;
	const MIN_H = 280;
	const RESIZE_HANDLES = [
		{ dir: 'n', cls: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
		{ dir: 's', cls: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
		{ dir: 'e', cls: 'top-2 bottom-2 right-0 w-1.5 cursor-ew-resize' },
		{ dir: 'w', cls: 'top-2 bottom-2 left-0 w-1.5 cursor-ew-resize' },
		{ dir: 'ne', cls: 'top-0 right-0 size-3 cursor-nesw-resize' },
		{ dir: 'nw', cls: 'top-0 left-0 size-3 cursor-nwse-resize' },
		{ dir: 'se', cls: 'bottom-0 right-0 size-3 cursor-nwse-resize' },
		{ dir: 'sw', cls: 'bottom-0 left-0 size-3 cursor-nesw-resize' }
	];

	function startResize(dir: string, e: PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		const snapMode = effWin.snap ?? 'none';
		const start = { px: e.clientX, py: e.clientY, x: geom.x, y: geom.y, w: geom.w, h: geom.h };
		function move(ev: PointerEvent) {
			const dx = ev.clientX - start.px;
			const dy = ev.clientY - start.py;
			if (snapMode === 'left' || snapMode === 'right') {
				const raw = snapMode === 'left' ? start.w + dx : start.w - dx;
				setDraftWindow({ w: Math.max(MIN_W, Math.min(raw, vw - 40)) });
				return;
			}
			let { x, y, w, h } = start;
			if (dir.includes('e')) w = start.w + dx;
			if (dir.includes('s')) h = start.h + dy;
			if (dir.includes('w')) {
				w = start.w - dx;
				x = start.x + dx;
			}
			if (dir.includes('n')) {
				h = start.h - dy;
				y = start.y + dy;
			}
			if (w < MIN_W) {
				if (dir.includes('w')) x -= MIN_W - w;
				w = MIN_W;
			}
			if (h < MIN_H) {
				if (dir.includes('n')) y -= MIN_H - h;
				h = MIN_H;
			}
			x = Math.max(0, Math.min(x, vw - 60));
			y = Math.max(0, Math.min(y, vh - 40));
			w = Math.min(w, vw - x - 8);
			h = Math.min(h, vh - y - 8);
			setDraftWindow({ snap: 'none', x, y, w, h });
		}
		function up() {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		}
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	function toggleMaximize() {
		setDraftWindow({ snap: (win?.snap ?? 'none') === 'top' ? 'none' : 'top' });
	}

	function handleClose() {
		dispatch('close');
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		// Swallow ESC inside the panel so it can't abort the chat stream; close is
		// via the × button (reopen from the bar).
		const active = document.activeElement;
		if (dialogEl && active instanceof Node && dialogEl.contains(active)) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}

	// --- OnlyOffice editor ---
	// Normalize the Document Server base to the same origin the app is reached
	// on. New drafts already carry the relative `/onlyoffice/` proxy path, but
	// drafts persisted before that change baked in an absolute dev URL
	// (`http://localhost:20081/`) that only resolves from the docker host — so
	// any absolute, cross-origin value is replaced with `/onlyoffice/` so the
	// editor loads wherever the stack is reached (localhost, LAN IP, cloudflared).
	function effectiveDsBase(stored: string): string {
		if (!stored) return '/onlyoffice/';
		try {
			const u = new URL(stored, window.location.href);
			return u.origin === window.location.origin ? stored : '/onlyoffice/';
		} catch {
			return stored; // relative path (e.g. "/onlyoffice/") — use as-is
		}
	}

	function apiScriptUrl(base: string): string {
		const b = base.endsWith('/') ? base : base + '/';
		return b + 'web-apps/apps/api/documents/api.js';
	}

	function loadDocsApi(src: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if ((window as any).DocsAPI) return resolve();
			let s = document.querySelector(`script[data-oo="${src}"]`) as HTMLScriptElement | null;
			if (s) {
				s.addEventListener('load', () => resolve());
				s.addEventListener('error', () => reject(new Error('load failed: ' + src)));
				return;
			}
			s = document.createElement('script');
			s.src = src;
			s.async = true;
			s.dataset.oo = src;
			s.onload = () => resolve();
			s.onerror = () => reject(new Error('Nepodařilo se načíst editor: ' + src));
			document.head.appendChild(s);
		});
	}

	async function mountEditor() {
		const d = draft.doc;
		if (!d) {
			loadError = 'Chybí konfigurace dokumentu.';
			return;
		}
		try {
			await loadDocsApi(apiScriptUrl(effectiveDsBase(d.documentServerUrl)));
			const DocsAPI = (window as any).DocsAPI;
			if (!DocsAPI) throw new Error('DocsAPI nedostupné');
			const holderId = 'oo-editor-' + draft.id;
			holderEl.id = holderId;
			const config = JSON.parse(JSON.stringify(d.editorConfig));
			config.width = '100%';
			config.height = '100%';
			config.events = {
				onError: (e: any) => console.error('[onlyoffice] error', e),
				onWarning: (e: any) => console.warn('[onlyoffice] warning', e)
			};
			editor = new DocsAPI.DocEditor(holderId, config);
			mountedKey = docKey();
		} catch (e) {
			loadError = (e as Error).message;
		}
	}

	function destroyEditor() {
		try {
			editor?.destroyEditor?.();
		} catch {
			/* ignore */
		}
		editor = null;
	}

	onMount(() => {
		if (dialogEl) document.body.appendChild(dialogEl); // escape CSS containment
		if (!get(emailDraftWindow)) setDraftWindow(defaultWindow(vw, vh));
		window.addEventListener('keydown', handleGlobalKeydown, true);
		window.addEventListener('resize', onResize);
		mountEditor();
		pollStatus();
		agentPollTimer = setInterval(pollStatus, 2500);
	});

	onDestroy(() => {
		if (dialogEl?.parentNode) dialogEl.parentNode.removeChild(dialogEl);
		window.removeEventListener('keydown', handleGlobalKeydown, true);
		window.removeEventListener('resize', onResize);
		if (agentPollTimer) clearInterval(agentPollTimer);
		destroyEditor();
	});
</script>

<div
	bind:this={dialogEl}
	class="fixed inset-0 z-50 pointer-events-none"
	role="dialog"
	aria-label="Úprava dokumentu"
>
	{#if snapHint}
		<div
			class="absolute z-[1] rounded-2xl bg-blue-500/15 border-2 border-blue-400/70 pointer-events-none"
			style={snapPreviewStyle}
		></div>
	{/if}

	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="pointer-events-auto absolute bg-white dark:bg-gray-900 rounded-2xl shadow-2xl ring-1 ring-black/5 dark:ring-white/10 flex flex-col overflow-hidden dialog-pop-in"
		style={cardStyle}
		on:pointerdown={startDrag}
	>
		{#each visibleHandles as h}
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div class="absolute z-20 {h.cls}" on:pointerdown={(e) => startResize(h.dir, e)}></div>
		{/each}

		<!-- Header (title bar) -->
		<div
			class="relative z-10 flex items-center justify-between gap-2 px-5 py-3 border-b border-gray-200 dark:border-gray-700 select-none shrink-0 cursor-move"
		>
			<div class="flex items-center gap-2 min-w-0">
				<svg class="size-4 shrink-0 text-gray-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h6l4 4V17a.5.5 0 01-.5.5h-9A.5.5 0 015 17V2.5z"/><path d="M11 2.5V6.5h4"/></svg>
				<h2 class="text-base font-semibold text-gray-900 dark:text-white truncate" title={draft.doc?.filename}>
					{draft.doc?.title ?? 'Dokument'}
				</h2>
			</div>
			<div class="flex items-center gap-1.5 shrink-0">
				<button
					on:click={toggleMaximize}
					class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
					aria-label={effWin.snap === 'top' ? 'Obnovit' : 'Maximalizovat'}
					title={effWin.snap === 'top' ? 'Obnovit' : 'Maximalizovat'}
				>
					{#if effWin.snap === 'top'}
						<svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="9" height="9" rx="1.5" /><path d="M7.5 7V5.5a1.5 1.5 0 011.5-1.5h5.5A1.5 1.5 0 0116 5.5V11a1.5 1.5 0 01-1.5 1.5H13" fill="none" stroke="currentColor" stroke-linecap="round" /></svg>
					{:else}
						<svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
					{/if}
				</button>
				<button
					on:click={handleClose}
					class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-xl leading-none"
					aria-label="Zavřít"
					title="Zavřít (dokument zůstane v liště)"
				>×</button>
			</div>
		</div>

		<!-- Body: OnlyOffice editor -->
		<div class="flex-1 min-h-0 relative">
			{#if loadError}
				<div class="absolute inset-0 flex items-center justify-center p-4 text-sm text-red-600 text-center">
					Chyba editoru: {loadError}
				</div>
			{/if}
			<div class="w-full h-full" bind:this={holderEl}></div>
			{#if agentEditing}
				<!-- Read-only lock while a background agent edits this file. The
				     overlay swallows all pointer input; it clears (and the editor
				     reloads with the new content) when the run releases the lock. -->
				<div
					class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-white/70 dark:bg-gray-900/70 backdrop-blur-[2px] cursor-not-allowed select-none"
					role="status"
					aria-live="polite"
				>
					<div class="flex items-center gap-2.5 rounded-xl bg-white dark:bg-gray-800 px-4 py-2.5 shadow-lg ring-1 ring-black/5 dark:ring-white/10">
						<svg class="size-5 shrink-0 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
							<circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" />
							<path class="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
						</svg>
						<span class="text-sm font-medium text-gray-800 dark:text-gray-100">
							Agent upravuje dokument… editor je uzamčen
						</span>
					</div>
					<span class="text-xs text-gray-500 dark:text-gray-400">Po dokončení se obsah načte automaticky.</span>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.dialog-pop-in {
		animation: dialog-pop-in 0.38s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}
	@keyframes dialog-pop-in {
		0% {
			transform: scale(0.82);
			opacity: 0;
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}
</style>
