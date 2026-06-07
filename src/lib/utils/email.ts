// Shared shape + serializer for the email-reply badge flow.
// The mention block is what the backend's email skill parses;
// keeping it in one place avoids drift between the inbox dialog
// (where badges are created) and Chat.svelte (where they're
// folded back into the outgoing user_message at send time).

export type EmailAttachment = {
	from: string;
	to: string[];
	subject: string;
	date: string | null;
	message_id: string;
	mailbox_id: string;
	body: string;
};

export type EmailFileEntry = {
	id: string;
	type: 'email';
	name: string;
	email: EmailAttachment;
};

export function formatEmailMention(email: EmailAttachment): string {
	return (
		`<$email|Email>\n` +
		`from: ${email.from}\n` +
		`to: ${(email.to || []).join(', ')}\n` +
		`subject: ${email.subject}\n` +
		`date: ${email.date ?? ''}\n` +
		`message_id: ${email.message_id}\n\n` +
		(email.body || '')
	);
}

export function isEmailFileEntry(file: any): file is EmailFileEntry {
	return file && file.type === 'email' && file.email && typeof file.email === 'object';
}

// Strip an angle-bracketed "Name <addr@host>" form down to either Name or addr@host.
export function emailSenderLabel(from: string): string {
	if (!from) return '';
	const m = from.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
	if (m) {
		const name = m[1].trim();
		return name || m[2].trim();
	}
	return from.trim();
}
