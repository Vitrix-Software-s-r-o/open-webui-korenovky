<script lang="ts">
	import { createEventDispatcher, getContext } from 'svelte';
	import { settings } from '$lib/stores';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import { emailSenderLabel, type EmailAttachment } from '$lib/utils/email';

	const i18n: any = getContext('i18n');
	const dispatch = createEventDispatcher();

	export let email: EmailAttachment;
	export let dismissible = false;
	export let className = 'w-fit max-w-full';
	export let colorClassName =
		'bg-white dark:bg-gray-850 border border-gray-50/30 dark:border-gray-800/30';

	$: sender = emailSenderLabel(email?.from ?? '');
	$: subject = email?.subject || '(no subject)';
	$: tooltip =
		`${$i18n.t('From') ?? 'From'}: ${email?.from ?? ''}\n` +
		`${$i18n.t('Subject') ?? 'Subject'}: ${subject}`;
</script>

<button
	class="relative group p-1.5 {className} flex items-center gap-1 {colorClassName} rounded-xl p-2 text-left"
	type="button"
	on:click={() =>
		dispatch('click', { message_id: email?.message_id, mailbox_id: email?.mailbox_id })}
>
	<div class="pl-1.5 shrink-0 text-gray-500 dark:text-gray-400">
		<Tooltip content={$i18n.t('Email') ?? 'Email'} placement="top">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 20 20"
				fill="currentColor"
				aria-hidden="true"
				class="size-5"
			>
				<path
					d="M3 4a2 2 0 0 0-2 2v1.161l8.441 4.221a1.25 1.25 0 0 0 1.118 0L19 7.162V6a2 2 0 0 0-2-2H3Z"
				/>
				<path
					d="m19 8.839-7.77 3.885a2.75 2.75 0 0 1-2.46 0L1 8.839V14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.839Z"
				/>
			</svg>
		</Tooltip>
	</div>

	<Tooltip content={tooltip} className="flex flex-col w-full" placement="top-start">
		<div class="flex flex-col justify-center -space-y-0.5 px-1 w-full">
			<div class=" dark:text-gray-100 text-sm flex items-center">
				<div class="font-medium line-clamp-1 flex-1 pr-1">
					{sender}<span class="text-gray-500 font-normal"> • {subject}</span>
				</div>
			</div>
		</div>
	</Tooltip>

	{#if dismissible}
		<div class=" absolute -top-1 -right-1">
			<button
				aria-label={$i18n.t('Remove File') ?? 'Remove'}
				class=" bg-white text-black border border-gray-50 rounded-full {($settings?.highContrastMode ??
				false)
					? ''
					: 'outline-hidden focus:outline-hidden group-hover:visible invisible transition'}"
				type="button"
				on:click|stopPropagation={() => dispatch('dismiss')}
			>
				<XMark className={'size-4'} />
			</button>
		</div>
	{/if}
</button>
