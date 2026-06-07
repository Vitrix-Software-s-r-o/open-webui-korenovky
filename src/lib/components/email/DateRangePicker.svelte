<script lang="ts">
	import { createEventDispatcher, getContext, onDestroy } from 'svelte';

	const i18n: any = getContext('i18n');
	const dispatch = createEventDispatcher<{
		change: { from: string | null; to: string | null; preset: string | null };
	}>();

	// Parent-owned value (Prague-midnight ISO 8601 UTC bounds, `to` is exclusive).
	export let value: { from: string | null; to: string | null } = { from: null, to: null };
	// Preset id the parent thinks is active. Lets the chip highlighting survive
	// a re-mount and lets `clear()` from outside reset the chips.
	export let preset: string | null = null;

	type Preset = { id: string; label: string };
	const PRESETS: Preset[] = [
		{ id: 'today', label: 'Dnes' },
		{ id: 'yesterday', label: 'Včera' },
		{ id: '7d', label: '7 dní' },
		{ id: '30d', label: '30 dní' },
		{ id: 'this_month', label: 'Tento měsíc' },
		{ id: 'last_month', label: 'Minulý měsíc' }
	];

	let popoverOpen = false;
	let wrapperEl: HTMLElement;
	let viewYear: number;
	let viewMonth: number; // 0-based
	let pendingFrom: Date | null = null; // civil Prague-day Date (constructed in local TZ but treated as Prague date)
	let pendingTo: Date | null = null;
	let hoverDate: Date | null = null;

	// --- Prague timezone helpers ---

	function pragueTodayParts(): { y: number; m: number; d: number } {
		const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
		const [y, m, d] = fmt.format(new Date()).split('-').map(Number);
		return { y, m: m - 1, d };
	}

	function pragueOffsetMs(year: number, month: number, day: number): number {
		const probe = new Date(Date.UTC(year, month, day, 12, 0, 0));
		const fmt = new Intl.DateTimeFormat('en-US', {
			timeZone: 'Europe/Prague',
			timeZoneName: 'shortOffset'
		});
		const tzName =
			fmt.formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
		const m = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
		const sign = m && m[1] === '-' ? -1 : 1;
		const hrs = m ? parseInt(m[2], 10) : 1;
		const mins = m && m[3] ? parseInt(m[3], 10) : 0;
		return sign * (hrs * 3600 + mins * 60) * 1000;
	}

	function pragueMidnightUTC(year: number, month: number, day: number): string {
		const offsetMs = pragueOffsetMs(year, month, day);
		return new Date(Date.UTC(year, month, day, 0, 0, 0) - offsetMs).toISOString();
	}

	(() => {
		const t = pragueTodayParts();
		viewYear = t.y;
		viewMonth = t.m;
	})();

	// --- Preset → range conversion ---

	function rangeForPreset(id: string): { from: string; to: string } {
		const t = pragueTodayParts();
		const today = new Date(t.y, t.m, t.d);
		const tomorrow = new Date(t.y, t.m, t.d + 1);
		let fromY = t.y,
			fromM = t.m,
			fromD = t.d;
		let toY = tomorrow.getFullYear(),
			toM = tomorrow.getMonth(),
			toD = tomorrow.getDate();
		if (id === 'yesterday') {
			const y = new Date(t.y, t.m, t.d - 1);
			fromY = y.getFullYear();
			fromM = y.getMonth();
			fromD = y.getDate();
			toY = today.getFullYear();
			toM = today.getMonth();
			toD = today.getDate();
		} else if (id === '7d') {
			const y = new Date(t.y, t.m, t.d - 6);
			fromY = y.getFullYear();
			fromM = y.getMonth();
			fromD = y.getDate();
		} else if (id === '30d') {
			const y = new Date(t.y, t.m, t.d - 29);
			fromY = y.getFullYear();
			fromM = y.getMonth();
			fromD = y.getDate();
		} else if (id === 'this_month') {
			fromY = t.y;
			fromM = t.m;
			fromD = 1;
			const next = new Date(t.y, t.m + 1, 1);
			toY = next.getFullYear();
			toM = next.getMonth();
			toD = next.getDate();
		} else if (id === 'last_month') {
			const lm = new Date(t.y, t.m - 1, 1);
			fromY = lm.getFullYear();
			fromM = lm.getMonth();
			fromD = lm.getDate();
			toY = t.y;
			toM = t.m;
			toD = 1;
		}
		return {
			from: pragueMidnightUTC(fromY, fromM, fromD),
			to: pragueMidnightUTC(toY, toM, toD)
		};
	}

	function selectPreset(id: string) {
		if (preset === id) {
			dispatch('change', { from: null, to: null, preset: null });
			return;
		}
		const { from, to } = rangeForPreset(id);
		dispatch('change', { from, to, preset: id });
	}

	function clearAll() {
		pendingFrom = null;
		pendingTo = null;
		popoverOpen = false;
		dispatch('change', { from: null, to: null, preset: null });
	}

	function togglePopover() {
		popoverOpen = !popoverOpen;
		if (popoverOpen) {
			// Seed the calendar with the current custom range if any.
			if (preset === 'custom' && value.from && value.to) {
				const f = new Date(value.from);
				const t = new Date(new Date(value.to).getTime() - 24 * 3600 * 1000);
				pendingFrom = new Date(f.getFullYear(), f.getMonth(), f.getDate());
				pendingTo = new Date(t.getFullYear(), t.getMonth(), t.getDate());
				viewYear = pendingFrom.getFullYear();
				viewMonth = pendingFrom.getMonth();
			} else {
				pendingFrom = null;
				pendingTo = null;
			}
		}
	}

	function pickDay(year: number, month: number, day: number) {
		const d = new Date(year, month, day);
		if (!pendingFrom || (pendingFrom && pendingTo)) {
			pendingFrom = d;
			pendingTo = null;
			hoverDate = null;
		} else if (d.getTime() < pendingFrom.getTime()) {
			pendingTo = pendingFrom;
			pendingFrom = d;
		} else {
			pendingTo = d;
		}
	}

	function applyCustom() {
		if (!pendingFrom || !pendingTo) return;
		const fromIso = pragueMidnightUTC(
			pendingFrom.getFullYear(),
			pendingFrom.getMonth(),
			pendingFrom.getDate()
		);
		// `to` is exclusive — pick start of the *next* day after pendingTo.
		const next = new Date(pendingTo.getFullYear(), pendingTo.getMonth(), pendingTo.getDate() + 1);
		const toIso = pragueMidnightUTC(next.getFullYear(), next.getMonth(), next.getDate());
		popoverOpen = false;
		dispatch('change', { from: fromIso, to: toIso, preset: 'custom' });
	}

	function clearCustomPopover() {
		pendingFrom = null;
		pendingTo = null;
		hoverDate = null;
	}

	function prevMonth() {
		const d = new Date(viewYear, viewMonth - 1, 1);
		viewYear = d.getFullYear();
		viewMonth = d.getMonth();
	}
	function nextMonth() {
		const d = new Date(viewYear, viewMonth + 1, 1);
		viewYear = d.getFullYear();
		viewMonth = d.getMonth();
	}

	// 6×7 day grid, Mon-first.
	$: gridDays = (() => {
		const first = new Date(viewYear, viewMonth, 1);
		const dow = (first.getDay() + 6) % 7;
		const start = new Date(viewYear, viewMonth, 1 - dow);
		const arr: Date[] = [];
		for (let i = 0; i < 42; i++) {
			arr.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
		}
		return arr;
	})();

	const WEEKDAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
	const MONTHS = [
		'Leden',
		'Únor',
		'Březen',
		'Duben',
		'Květen',
		'Červen',
		'Červenec',
		'Srpen',
		'Září',
		'Říjen',
		'Listopad',
		'Prosinec'
	];

	function sameDay(a: Date, b: Date): boolean {
		return (
			a.getFullYear() === b.getFullYear() &&
			a.getMonth() === b.getMonth() &&
			a.getDate() === b.getDate()
		);
	}

	// Precompute the state of every cell in the visible grid as a reactive
	// derived value, so cell colors update the instant pendingFrom/pendingTo/
	// hoverDate change. Doing this as `$:` (rather than `{@const}` inside the
	// each block) guarantees Svelte tracks all dependencies and re-renders
	// every cell in lockstep.
	$: daysWithState = gridDays.map((d) => {
		const isCurrentMonth = d.getMonth() === viewMonth;
		let start: Date | null = pendingFrom;
		let end: Date | null = pendingTo;
		// While picking the end, preview the range under the cursor.
		if (start && !end && hoverDate) {
			if (hoverDate.getTime() < start.getTime()) {
				end = start;
				start = hoverDate;
			} else {
				end = hoverDate;
			}
		}
		let inRange = false;
		if (start && end) {
			const lo = Math.min(start.getTime(), end.getTime());
			const hi = Math.max(start.getTime(), end.getTime());
			inRange = d.getTime() >= lo && d.getTime() <= hi;
		} else if (start && sameDay(d, start)) {
			inRange = true;
		}
		const isStart = !!(start && sameDay(d, start));
		const isEnd = !!(end && sameDay(d, end));
		return { d, inRange, isStart, isEnd, isCurrentMonth };
	});

	const fmtDay = new Intl.DateTimeFormat('cs-CZ', {
		day: 'numeric',
		month: 'numeric',
		timeZone: 'Europe/Prague'
	});
	const fmtDayYear = new Intl.DateTimeFormat('cs-CZ', {
		day: 'numeric',
		month: 'numeric',
		year: 'numeric',
		timeZone: 'Europe/Prague'
	});

	function customChipLabel(): string {
		if (preset === 'custom' && value.from && value.to) {
			const f = new Date(value.from);
			const tIncl = new Date(new Date(value.to).getTime() - 24 * 3600 * 1000);
			return `${fmtDay.format(f)} – ${fmtDayYear.format(tIncl)}`;
		}
		return $i18n.t('Vlastní');
	}

	// --- ESC + click-outside (capture-phase, so it intercepts before the
	//     EmailInboxDialog's own ESC handler when the popover is open) ---

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !popoverOpen) return;
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		popoverOpen = false;
	}

	function handleDocClick(e: MouseEvent) {
		if (!popoverOpen) return;
		if (wrapperEl && !wrapperEl.contains(e.target as Node)) {
			popoverOpen = false;
		}
	}

	if (typeof window !== 'undefined') {
		window.addEventListener('keydown', handleKeydown, true);
		window.addEventListener('mousedown', handleDocClick, true);
	}
	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('keydown', handleKeydown, true);
			window.removeEventListener('mousedown', handleDocClick, true);
		}
	});
</script>

<div bind:this={wrapperEl} class="flex flex-wrap items-center gap-1 relative">
	{#each PRESETS as p (p.id)}
		<button
			type="button"
			class="px-2 py-0.5 text-xs rounded-full border transition-colors"
			class:border-blue-400={preset === p.id}
			class:bg-blue-50={preset === p.id}
			class:text-blue-700={preset === p.id}
			class:dark:bg-blue-900={preset === p.id}
			class:dark:text-blue-200={preset === p.id}
			class:border-gray-200={preset !== p.id}
			class:dark:border-gray-700={preset !== p.id}
			on:click={() => selectPreset(p.id)}
		>
			{$i18n.t(p.label)}
		</button>
	{/each}

	<button
		type="button"
		class="px-2 py-0.5 text-xs rounded-full border transition-colors inline-flex items-center gap-1"
		class:border-blue-400={preset === 'custom'}
		class:bg-blue-50={preset === 'custom'}
		class:text-blue-700={preset === 'custom'}
		class:dark:bg-blue-900={preset === 'custom'}
		class:dark:text-blue-200={preset === 'custom'}
		class:border-gray-200={preset !== 'custom'}
		class:dark:border-gray-700={preset !== 'custom'}
		on:click={togglePopover}
	>
		<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="3" y="4" width="18" height="18" rx="2" />
			<line x1="16" y1="2" x2="16" y2="6" />
			<line x1="8" y1="2" x2="8" y2="6" />
			<line x1="3" y1="10" x2="21" y2="10" />
		</svg>
		<span>{customChipLabel()}</span>
		<svg class="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</button>

	{#if preset}
		<button
			type="button"
			class="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 ml-1"
			on:click={clearAll}
			title={$i18n.t('Vymazat období')}
			aria-label={$i18n.t('Vymazat období')}
		>
			×
		</button>
	{/if}

	{#if popoverOpen}
		<div
			class="absolute top-full mt-1 left-0 z-20 w-72 p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg"
		>
			<div class="flex items-center justify-between mb-2">
				<button
					type="button"
					class="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
					on:click={prevMonth}
					aria-label={$i18n.t('Předchozí měsíc')}
				>
					<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="15 18 9 12 15 6" />
					</svg>
				</button>
				<div class="text-sm font-medium">{MONTHS[viewMonth]} {viewYear}</div>
				<button
					type="button"
					class="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
					on:click={nextMonth}
					aria-label={$i18n.t('Další měsíc')}
				>
					<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="9 18 15 12 9 6" />
					</svg>
				</button>
			</div>
			<div class="grid grid-cols-7 gap-0.5 text-[10px] text-gray-400 mb-1 text-center">
				{#each WEEKDAYS as w (w)}<div>{w}</div>{/each}
			</div>
			<div
				class="grid grid-cols-7 gap-0.5"
				on:mouseleave={() => (hoverDate = null)}
				role="grid"
			>
				{#each daysWithState as item (item.d.getFullYear() + '-' + item.d.getMonth() + '-' + item.d.getDate())}
					<button
						type="button"
						class={
							'text-xs h-7 rounded-md transition-colors ' +
							(item.isStart || item.isEnd
								? 'bg-blue-600 text-white font-semibold ring-1 ring-blue-700'
								: item.inRange
									? 'bg-blue-100 text-blue-900 dark:bg-blue-500/25 dark:text-blue-100'
									: !item.isCurrentMonth
										? 'text-gray-300 dark:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
										: 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800')
						}
						on:click={() => pickDay(item.d.getFullYear(), item.d.getMonth(), item.d.getDate())}
						on:mouseenter={() => (hoverDate = item.d)}
					>
						{item.d.getDate()}
					</button>
				{/each}
			</div>
			<div class="mt-2 text-[11px] text-gray-500 dark:text-gray-400 text-center min-h-[16px]">
				{#if pendingFrom && pendingTo}
					<span class="text-gray-700 dark:text-gray-200 font-medium">
						{fmtDayYear.format(pendingFrom)} – {fmtDayYear.format(pendingTo)}
					</span>
				{:else if pendingFrom}
					<span class="text-gray-700 dark:text-gray-200 font-medium">
						{fmtDayYear.format(pendingFrom)}
					</span>
					<span class="text-gray-400 dark:text-gray-500">
						— {$i18n.t('vyberte konec období')}
					</span>
				{:else}
					{$i18n.t('Vyberte začátek období')}
				{/if}
			</div>
			<div class="mt-2 flex justify-end gap-2">
				<button
					type="button"
					class="text-xs px-2 py-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
					on:click={clearCustomPopover}
				>
					{$i18n.t('Vymazat')}
				</button>
				<button
					type="button"
					class="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={!pendingFrom || !pendingTo}
					on:click={applyCustom}
				>
					{$i18n.t('Použít')}
				</button>
			</div>
		</div>
	{/if}
</div>
