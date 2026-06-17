<script lang="ts">
	import { decode } from 'html-entities';
	import { v4 as uuidv4 } from 'uuid';

	import { getContext } from 'svelte';
	const i18n = getContext('i18n');

	import { slide } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';

	import ChevronUp from '../icons/ChevronUp.svelte';
	import ChevronDown from '../icons/ChevronDown.svelte';
	import Spinner from './Spinner.svelte';
	import Markdown from '../chat/Messages/Markdown.svelte';
	import WrenchSolid from '../icons/WrenchSolid.svelte';
	import CheckCircle from '../icons/CheckCircle.svelte';
	import Image from './Image.svelte';
	import FullHeightIframe from './FullHeightIframe.svelte';
	import { ingestAiDraft, ingestAiDocumentDraft, openDraftId } from '$lib/stores/email';
	import { extractDocDraft } from '$lib/utils/docDraft';
	import { settings } from '$lib/stores';

	export let id: string = '';
	export let attributes: {
		type?: string;
		id?: string;
		name?: string;
		arguments?: string;
		result?: string;
		files?: string;
		embeds?: string;
		done?: string;
	} = {};

	export let open = false;
	export let grouped = false;
	export let className = '';

	const RESULT_PREVIEW_LIMIT = 10000;
	let expandedResult = false;

	$: if (!open) expandedResult = false;
	export let buttonClassName =
		'w-fit text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition';

	const componentId = id || uuidv4();

	function parseJSONString(str: string) {
		try {
			return parseJSONString(JSON.parse(str));
		} catch (e) {
			return str;
		}
	}

	function formatJSONString(str: string) {
		try {
			const parsed = parseJSONString(str);
			if (typeof parsed === 'object') {
				return JSON.stringify(parsed, null, 2);
			} else {
				return String(parsed);
			}
		} catch (e) {
			return str;
		}
	}

	function parseArguments(str: string): Record<string, unknown> | null {
		try {
			const parsed = parseJSONString(str);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return null;
		} catch {
			return null;
		}
	}

	$: args = decode(attributes?.arguments ?? '');
	export let resultContent: string = '';

	$: result = resultContent || decode(attributes?.result ?? '');
	$: files = parseJSONString(decode(attributes?.files ?? ''));
	$: embeds = parseJSONString(decode(attributes?.embeds ?? ''));
	$: isDone = attributes?.done === 'true';
	$: isExecuting = attributes?.done && attributes?.done !== 'true';

	$: parsedArgs = parseArguments(args);
	// A files-link tool result may carry an invisible document-draft marker —
	// pull it out and show only the human text. `parsedResult` is parsed from the
	// cleaned text so the marker never bloats the displayed JSON either.
	$: docDraft = extractDocDraft(result);
	$: displayResult = docDraft.cleaned;
	$: parsedResult = parseJSONString(displayResult);

	let _emailDraftIngested = false;

	// When an `email_draft_dialog` tool result is done, hand the AI draft to the
	// per-chat draft store (which dedupes by version token, so a chat reload won't
	// re-ingest or resurrect a sent/dropped draft). The non-modal panel + chips bar
	// are rendered once by EmailDraftManager, not here.
	$: if (
		!_emailDraftIngested &&
		parsedResult &&
		typeof parsedResult === 'object' &&
		(parsedResult as any).type === 'email_draft_dialog' &&
		isDone
	) {
		_emailDraftIngested = true;
		ingestAiDraft((parsedResult as any).draft_id, (parsedResult as any).draft);
	}

	let _documentDraftIngested = false;

	// A document draft reaches us two ways; both feed the shared draft store
	// (EmailDraftManager renders the editor dialog + chips, not here). Pop/refresh
	// policy lives in ingestAiDocumentDraft — robust to mount timing and reloads.
	//  1. `prepare_document_draft` returns the dialog as the whole JSON result —
	//     an explicit "open it" → force-open.
	//  2. files-link's produce/import/edit tools (and the office proxy) append an
	//     invisible marker to their text result → pop if new, refresh if open.
	$: if (!_documentDraftIngested && isDone) {
		if (
			parsedResult &&
			typeof parsedResult === 'object' &&
			(parsedResult as any).type === 'document_draft_dialog'
		) {
			_documentDraftIngested = true;
			const r = parsedResult as any;
			ingestAiDocumentDraft(r.draft_id, r.draft, {
				open: r.open ?? true,
				force: true,
				replaces: r.replaces
			});
		} else if (docDraft.payload) {
			_documentDraftIngested = true;
			const r = docDraft.payload;
			ingestAiDocumentDraft(r.draft_id, r.draft, {
				open: r.open ?? true,
				replaces: r.replaces
			});
		}
	}
</script>

<div {id} class={className}>
	{#if !grouped && embeds && Array.isArray(embeds) && embeds.length > 0}
		<!-- Embed Mode: Show iframes without collapsible behavior -->
		<div class="py-1 w-full cursor-pointer">
			<div class="w-full text-xs text-gray-500">
				{attributes.name}
			</div>
			{#each embeds as embed, idx}
				<div class="my-2" id={`${componentId}-tool-call-embed-${idx}`}>
					<FullHeightIframe
						src={embed}
						{args}
						allowScripts={true}
						allowForms={$settings?.iframeSandboxAllowForms ?? false}
						allowSameOrigin={$settings?.iframeSandboxAllowSameOrigin ?? false}
						allowPopups={true}
					/>
				</div>
			{/each}
		</div>
	{:else}
		<!-- Tool call display -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="{buttonClassName} cursor-pointer"
			on:pointerup={() => {
				open = !open;
			}}
		>
			<div
				class="w-full max-w-full font-medium flex items-center gap-1.5 {isExecuting
					? 'shimmer'
					: ''}"
			>
				<!-- Status icon -->
				{#if isExecuting}
					<div>
						<Spinner className="size-4" />
					</div>
				{:else if isDone}
					<div class="text-emerald-500 dark:text-emerald-400">
						<CheckCircle className="size-4" strokeWidth="2" />
					</div>
				{:else}
					<div class="text-gray-400 dark:text-gray-500">
						<WrenchSolid className="size-3.5" />
					</div>
				{/if}

				<!-- Label -->
				<div class="flex-1 line-clamp-1">
					<!-- Short label (below md) -->
					<span class="@md:hidden text-black dark:text-white">{attributes.name}</span>
					<!-- Full label (md and above) -->
					<span class="hidden @md:inline font-normal">
						{#if isDone}
							<Markdown
								id={`${componentId}-tool-call-title`}
								content={$i18n.t('View Result from **{{NAME}}**', {
									NAME: attributes.name
								})}
							/>
						{:else}
							<Markdown
								id={`${componentId}-tool-call-executing`}
								content={$i18n.t('Executing **{{NAME}}**...', {
									NAME: attributes.name
								})}
							/>
						{/if}
					</span>
				</div>

				<!-- Chevron -->
				<div class="flex shrink-0 self-center translate-y-[1px]">
					{#if open}
						<ChevronUp strokeWidth="3.5" className="size-3.5" />
					{:else}
						<ChevronDown strokeWidth="3.5" className="size-3.5" />
					{/if}
				</div>
			</div>
		</div>

		{#if open}
			<div transition:slide={{ duration: 300, easing: quintOut, axis: 'y' }}>
				<div class="border border-gray-50 dark:border-gray-850/30 rounded-2xl my-1.5 p-3 space-y-3">
					<!-- Input -->
					{#if args}
						<div>
							<div
								class="text-[10px] uppercase tracking-wider font-medium text-gray-400 dark:text-gray-500 mb-1.5 px-1"
							>
								{$i18n.t('Input')}
							</div>

							{#if parsedArgs}
								<div class="px-1 space-y-0.5">
									{#each Object.entries(parsedArgs) as [key, value]}
										<div class="flex gap-2 text-xs py-0.5">
											<span class="font-medium text-gray-600 dark:text-gray-400 shrink-0"
												>{key}</span
											>
											<span class="text-gray-800 dark:text-gray-200 break-all"
												>{typeof value === 'object' ? JSON.stringify(value) : value}</span
											>
										</div>
									{/each}
								</div>
							{:else}
								<div class="tool-call-body w-full max-w-none!">
									<pre
										class="text-xs text-gray-600 dark:text-gray-300 whitespace-pre font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-2.5 overflow-x-auto">{formatJSONString(
											args
										)}</pre>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Output -->
					{#if isDone && result}
						<div>
							<div
								class="text-[10px] uppercase tracking-wider font-medium text-gray-400 dark:text-gray-500 mb-1.5 px-1"
							>
								{$i18n.t('Output')}
							</div>
							<div class="w-full max-w-none!">
								{#if typeof parsedResult === 'object' && parsedResult !== null && (parsedResult as any).type === 'email_draft_dialog'}
									<button
										on:click={() => openDraftId.set((parsedResult as any).draft_id)}
										class="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline px-1"
									>
										<svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" /><path d="M3 5.5l7 5 7-5" /></svg>
										Otevřít koncept e-mailu →
									</button>
								{:else if typeof parsedResult === 'object' && parsedResult !== null}
									<pre
										class="text-xs text-gray-600 dark:text-gray-300 whitespace-pre font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-2.5 overflow-x-auto">{JSON.stringify(
											parsedResult,
											null,
											2
										)}</pre>
								{:else}
									{@const resultStr = String(parsedResult)}
									{@const isTruncated = resultStr.length > RESULT_PREVIEW_LIMIT && !expandedResult}
									<pre
										class="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words font-mono">{isTruncated
											? resultStr.slice(0, RESULT_PREVIEW_LIMIT)
											: resultStr}</pre>
									{#if isTruncated}
										<button
											class="mt-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition"
											on:click|stopPropagation={() => {
												expandedResult = true;
											}}
										>
											{$i18n.t('Show all ({{COUNT}} characters)', {
												COUNT: resultStr.length.toLocaleString()
											})}
										</button>
									{/if}
								{/if}
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	{/if}

	<!-- Files display (images etc.) when done -->
	{#if isDone}
		{#if typeof files === 'object'}
			{#each files ?? [] as file, idx}
				{#if typeof file === 'string'}
					{#if file.startsWith('data:image/')}
						<Image id={`${componentId}-tool-call-result-${idx}`} src={file} alt="Image" />
					{/if}
				{:else if typeof file === 'object'}
					{#if (file.type === 'image' || (file?.content_type ?? '').startsWith('image/')) && file.url}
						<Image id={`${componentId}-tool-call-result-${idx}`} src={file.url} alt="Image" />
					{/if}
				{/if}
			{/each}
		{/if}
	{/if}
</div>

