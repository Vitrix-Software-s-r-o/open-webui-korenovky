import { derived, get, writable } from 'svelte/store';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { chatId, temporaryChatEnabled } from '$lib/stores';
import { updateChatById } from '$lib/apis/chats';

// --- Types ---------------------------------------------------------------

export type DraftAttachment = {
	// 'upload' = pending in-memory file (pre-import); 'owui_file' = durable OWUI
	// file id; 'dropbox' = dropbox path ref; 'office_file' = files-link token URL.
	type: 'upload' | 'dropbox' | 'office_file' | 'owui_file';
	filename: string;
	upload_index?: number;
	ref?: string;
	download_url?: string;
	open_url?: string;
	file_id?: string; // durable OWUI file id (kind 'owui_file')
};

export type DraftVersion = {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string; // canonical persisted form = editor HTML
	signature: string; // HTML
	attachments: DraftAttachment[];
	in_reply_to?: string | null;
	references?: string | null;
	authoredBy: 'ai' | 'user';
	at: number;
	// Unique per prepare/revise call — lets us dedupe re-renders (reload) from
	// genuine new AI revisions of the same draft id.
	token?: string;
};

export type DraftStatus = 'active' | 'sent' | 'dropped';

// A document draft shares the draft bar + floating window with email drafts, but
// its body is an OnlyOffice editor (not the email form). `kind: 'document'`
// discriminates; `doc` carries the signed editor config.
export type DocumentDraftData = {
	filename: string;
	title: string;
	documentServerUrl: string; // browser-facing OnlyOffice DS base url
	editorConfig: any; // signed OnlyOffice DocEditor config (incl. document.key)
	key?: string; // editorConfig.document.key — dedupe re-ingest on reload
};

export type ChatDraft = {
	id: string;
	kind?: 'email' | 'document'; // undefined == 'email' (back-compat)
	doc?: DocumentDraftData; // present when kind === 'document'
	status: DraftStatus;
	mailbox_id: string;
	currentVersion: number;
	versions: DraftVersion[];
	// Every AI version token ever ingested for this draft — unlike `versions`
	// this is never pruned, so a chat reload can't mistake an old (pruned) token
	// for a new revision and resurrect a sent/dropped draft.
	seenTokens: string[];
	createdAt: number;
	updatedAt: number;
	sentAt?: number;
	droppedAt?: number;
};

// Shared, chat-persisted geometry for the (single) draft window. Only one draft
// window is open at a time, so all drafts share one state. `snap` records an edge
// dock (left/right half or top = full); when 'none' the free x/y/w/h apply.
export type DraftSnap = 'none' | 'left' | 'right' | 'top';
export type DraftWindowState = { x: number; y: number; w: number; h: number; snap: DraftSnap };

// Keep only the last N versions per draft to bound the persisted chat JSON.
const MAX_VERSIONS = 3;
// At most this many drafts may be active at once (oldest is auto-dropped).
const MAX_ACTIVE_DRAFTS = 3;

// --- Stores --------------------------------------------------------------

export const emailDrafts = writable<ChatDraft[]>([]);
export const openDraftId = writable<string | null>(null);
export const draftHistoryOpen = writable<boolean>(false);
export const emailDraftWindow = writable<DraftWindowState | null>(null);
// Files attached to the current chat (OWUI file ids), surfaced by Chat.svelte so
// the email dialog can attach one directly (it's already in the internal store).
export const chatAttachedFiles = writable<{ id: string; name: string; content_type?: string }[]>(
	[]
);

// Live viewport width, maintained by EmailDraftManager — one source so the chat
// reservation can't drift from the actual snapped window width.
export const viewportW = writable<number>(typeof window !== 'undefined' ? window.innerWidth : 1280);

// Space the open draft window reserves on the chat side (so the messages area
// reflows beside a left/right-snapped window). DERIVED purely from the shared
// window state + which draft is open, so switching drafts (which remounts the
// dialog) can't transiently clear it. Null when free / maximized / closed.
export const emailDraftReserve = derived(
	[openDraftId, emailDrafts, emailDraftWindow, viewportW],
	([$openId, $drafts, $win, $vw]) => {
		if (!$openId || !$win) return null;
		const open = $drafts.find((d) => d.id === $openId && d.status === 'active');
		if (!open) return null;
		if ($win.snap !== 'left' && $win.snap !== 'right') return null;
		return { side: $win.snap as 'left' | 'right', px: Math.max(360, Math.min($win.w, $vw)) };
	}
);

// Signature/body sanitiser config — permissive enough for the HTML signatures
// (tables, inline CSS, images) we render.
const HTML_OPTS = {
	ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'td', 'th', 'img'],
	ADD_ATTR: [
		'width', 'height', 'cellpadding', 'cellspacing', 'border', 'bgcolor',
		'align', 'valign', 'colspan', 'rowspan', 'style', 'src', 'href', 'target', 'alt'
	]
};

// --- Helpers -------------------------------------------------------------

export function currentVersion(draft: ChatDraft): DraftVersion {
	return draft.versions[draft.currentVersion] ?? draft.versions[draft.versions.length - 1];
}

/** Convert an MCP `email_draft_dialog` payload into a normalised version.
 *  AI bodies are Markdown unless `body_format === 'html'`; we store HTML. */
export function payloadToVersion(d: any, authoredBy: 'ai' | 'user' = 'ai'): DraftVersion {
	const isHtml = (d.body_format ?? 'markdown') === 'html';
	const bodyHtml = isHtml
		? DOMPurify.sanitize(d.body ?? '', HTML_OPTS)
		: DOMPurify.sanitize(marked.parse(d.body ?? '') as string);
	return {
		from: d.from ?? '',
		to: [...(d.to ?? [])],
		cc: [...(d.cc ?? [])],
		bcc: [...(d.bcc ?? [])],
		subject: d.subject ?? '',
		body: bodyHtml,
		signature: DOMPurify.sanitize(d.signature ?? '', HTML_OPTS),
		attachments: [...(d.attachments ?? [])],
		in_reply_to: d.in_reply_to ?? null,
		references: d.references ?? null,
		authoredBy,
		at: Date.now(),
		token: d.version_token ?? undefined
	};
}

function appendVersion(draft: ChatDraft, v: DraftVersion): ChatDraft {
	let versions = [...draft.versions, v];
	if (versions.length > MAX_VERSIONS) versions = versions.slice(versions.length - MAX_VERSIONS);
	return { ...draft, versions, currentVersion: versions.length - 1, updatedAt: Date.now() };
}

// --- Persistence ---------------------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Write the current chat's drafts into chat storage. The OWUI backend
 *  shallow-merges, so sending just `{ drafts }` preserves history/messages/etc.
 *  Status changes (drop/send/restore) pass `immediate` so they can't be lost to
 *  the debounce if the user navigates away straight after. */
export function persistDrafts(immediate = false) {
	const id = get(chatId);
	if (!id || get(temporaryChatEnabled)) return;
	clearTimeout(persistTimer);
	const write = () =>
		updateChatById(localStorage.token, id, { drafts: get(emailDrafts) }).catch((e) =>
			console.error('[email-drafts persist]', e)
		);
	if (immediate) write();
	else persistTimer = setTimeout(write, 400);
}

let winTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced write of the shared draft-window geometry into chat storage. */
export function persistDraftWindow() {
	const id = get(chatId);
	if (!id || get(temporaryChatEnabled)) return;
	clearTimeout(winTimer);
	winTimer = setTimeout(() => {
		updateChatById(localStorage.token, id, { draftWindow: get(emailDraftWindow) }).catch((e) =>
			console.error('[email-draft-window persist]', e)
		);
	}, 400);
}

/** Merge a patch into the shared window state and persist it. */
export function setDraftWindow(patch: Partial<DraftWindowState>) {
	emailDraftWindow.update((w) => ({
		x: 24,
		y: 24,
		w: 480,
		h: 600,
		snap: 'none',
		...(w ?? {}),
		...patch
	}));
	persistDraftWindow();
}

/** Delete the current user's email-attachment files older than ~30 days. These
 *  are the files we import into the OWUI store for draft attachments (tagged with
 *  meta.data.email_attachment); we never touch the user's other files. Runs
 *  owner-scoped (the user deletes their own files) and is throttled to once/day
 *  per browser so it's a cheap opportunistic janitor. */
export async function pruneOldEmailAttachmentFiles() {
	const THROTTLE_MS = 24 * 60 * 60 * 1000;
	const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
	try {
		const last = Number(localStorage.getItem('email-attach-prune-at') || 0);
		if (Date.now() - last < THROTTLE_MS) return;
		localStorage.setItem('email-attach-prune-at', String(Date.now()));
		const token = localStorage.token;
		const cutoffMs = Date.now() - MAX_AGE_MS;
		for (let page = 1; page <= 50; page++) {
			const res = await fetch(`/api/v1/files/?page=${page}&content=false`, {
				headers: { authorization: `Bearer ${token}` }
			});
			if (!res.ok) break;
			const data = await res.json();
			const items: any[] = data?.items ?? (Array.isArray(data) ? data : []);
			if (!items.length) break;
			for (const f of items) {
				if (f?.meta?.data?.email_attachment !== true) continue;
				const created = Number(f.created_at ?? 0);
				const createdMs = created > 1e12 ? created : created * 1000; // tolerate s or ms
				if (created && createdMs < cutoffMs) {
					await fetch(`/api/v1/files/${f.id}`, {
						method: 'DELETE',
						headers: { authorization: `Bearer ${token}` }
					}).catch(() => {});
				}
			}
			if (items.length < 50) break; // last (short) page
		}
	} catch (e) {
		console.error('[email-attachment prune]', e);
	}
}

/** Replace the in-memory drafts + window state when a chat loads. */
export function hydrateDrafts(drafts: unknown, windowState?: unknown) {
	emailDrafts.set(Array.isArray(drafts) ? (drafts as ChatDraft[]) : []);
	emailDraftWindow.set(
		windowState && typeof windowState === 'object' ? (windowState as DraftWindowState) : null
	);
	openDraftId.set(null);
	draftHistoryOpen.set(false);
}

// Keep email-mcp's short-lived live mirror in step with the user's current
// (hand-edited / reverted) draft, so the assistant's next revision builds on it.
// Best-effort: the durable copy is in chat storage.
const syncTimers: Record<string, ReturnType<typeof setTimeout>> = {};
export function syncDraftMirror(draftId: string) {
	clearTimeout(syncTimers[draftId]);
	syncTimers[draftId] = setTimeout(() => {
		const d = get(emailDrafts).find((x) => x.id === draftId);
		if (!d) return;
		const v = currentVersion(d);
		if (!v) return;
		fetch(`/api/email-drafts/${draftId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mailbox_id: d.mailbox_id,
				to: v.to,
				cc: v.cc,
				bcc: v.bcc,
				subject: v.subject,
				body: v.body,
				signature: v.signature,
				attachments: v.attachments,
				in_reply_to: v.in_reply_to,
				references: v.references
			})
		}).catch(() => {});
	}, 600);
}

// --- Mutations -----------------------------------------------------------

/** Ingest an AI-authored `email_draft_dialog` payload: create a new draft or,
 *  if the id already exists, append a new (full-replace) version. Opens the
 *  panel on the affected draft. */
export function ingestAiDraft(draftId: string, payload: any) {
	const v = payloadToVersion(payload, 'ai');
	let changed = true;
	emailDrafts.update((list) => {
		const idx = list.findIndex((d) => d.id === draftId);
		if (idx === -1) {
			// Enforce the active-draft cap: auto-drop the oldest active EMAIL draft
			// (document drafts are capped independently in ingestAiDocumentDraft).
			let base = list;
			const active = list.filter((d) => d.status === 'active' && (d.kind ?? 'email') === 'email');
			if (active.length >= MAX_ACTIVE_DRAFTS) {
				const oldest = active.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
				base = list.map((d) =>
					d.id === oldest.id
						? { ...d, status: 'dropped' as DraftStatus, droppedAt: Date.now(), updatedAt: Date.now() }
						: d
				);
			}
			const draft: ChatDraft = {
				id: draftId,
				status: 'active',
				mailbox_id: payload.mailbox_id ?? '',
				currentVersion: 0,
				versions: [v],
				seenTokens: v.token ? [v.token] : [],
				createdAt: Date.now(),
				updatedAt: Date.now()
			};
			return [...base, draft];
		}
		// Only ingest a GENUINELY new AI revision (a token we've never seen for this
		// draft). A re-render on chat reload carries an already-seen token (or none)
		// → no-op, so we never append duplicates or resurrect a sent/dropped draft.
		const draft = list[idx];
		const seen = draft.seenTokens ?? draft.versions.map((x) => x.token).filter(Boolean);
		if (!(v.token && !seen.includes(v.token))) {
			changed = false;
			return list;
		}
		const next = [...list];
		next[idx] = {
			...appendVersion(draft, v),
			status: 'active',
			seenTokens: [...seen, v.token]
		};
		return next;
	});
	if (changed) {
		openDraftId.set(draftId);
		persistDrafts();
	}
}

/** Ingest an AI-emitted `document_draft_dialog` payload as a `kind:'document'`
 *  draft in the same store/bar/window as email drafts. Creates the draft + chip
 *  if new (or refreshes its editor config when the document key changed).
 *
 *  `opts.open` controls whether the editor window pops:
 *   - `true`  → always open (a LIVE tool result / agent emit — an explicit
 *               "open it" intent, even if the bytes/key didn't change, which is
 *               exactly the re-open-an-unchanged-doc case that used to no-op).
 *   - `false` → never open (a chat RELOAD replaying a historic tool call — must
 *               not resurrect the editor window).
 *   - omitted → legacy behaviour: open only when something changed.
 *  Document drafts are capped independently of email drafts. */
export function ingestAiDocumentDraft(
	draftId: string,
	payload: any,
	opts?: { open?: boolean }
) {
	if (!payload?.editor_config) return;
	const doc: DocumentDraftData = {
		filename: payload.filename ?? '',
		title: payload.title ?? payload.filename ?? 'Dokument',
		documentServerUrl: payload.document_server_url ?? '/onlyoffice/',
		editorConfig: payload.editor_config,
		key: payload.editor_config?.document?.key
	};
	let changed = true;
	emailDrafts.update((list) => {
		const idx = list.findIndex((d) => d.id === draftId);
		if (idx === -1) {
			// Cap active document drafts: drop the oldest (removed outright — document
			// drafts have no send/history lifecycle, so dropping = forgetting).
			let base = list;
			const activeDocs = list.filter((d) => d.kind === 'document' && d.status === 'active');
			if (activeDocs.length >= MAX_ACTIVE_DRAFTS) {
				const oldest = activeDocs.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
				base = list.filter((d) => d.id !== oldest.id);
			}
			const draft: ChatDraft = {
				id: draftId,
				kind: 'document',
				doc,
				status: 'active',
				mailbox_id: '',
				currentVersion: 0,
				versions: [],
				seenTokens: [],
				createdAt: Date.now(),
				updatedAt: Date.now()
			};
			return [...base, draft];
		}
		// Existing draft: only refresh + re-open when the content key changed.
		const prev = list[idx];
		if (prev.doc?.key && doc.key && prev.doc.key === doc.key) {
			changed = false;
			return list;
		}
		const next = [...list];
		next[idx] = { ...prev, kind: 'document', status: 'active', doc, updatedAt: Date.now() };
		return next;
	});
	if (changed) persistDrafts();
	// Open on an explicit live intent (opts.open === true) even when nothing
	// changed; never on a reload (false); fall back to "changed" otherwise.
	const shouldOpen = opts?.open ?? changed;
	if (shouldOpen) openDraftId.set(draftId);
}

/** Patch the current version in place (manual edits — does not create a new
 *  version; manual tweaks evolve the latest version). */
export function patchCurrentVersion(draftId: string, fields: Partial<DraftVersion>) {
	emailDrafts.update((list) => {
		const idx = list.findIndex((d) => d.id === draftId);
		if (idx === -1) return list;
		const draft = list[idx];
		const versions = [...draft.versions];
		const cur = versions[draft.currentVersion];
		if (!cur) return list;
		// Keep the version's identity (`at`) stable on manual edits — changing it
		// would alter the dialog's versionKey and remount the editor mid-typing,
		// stealing focus. Only AI revisions / reverts change version identity.
		versions[draft.currentVersion] = { ...cur, ...fields, authoredBy: 'user' };
		const next = [...list];
		next[idx] = { ...draft, versions, updatedAt: Date.now() };
		return next;
	});
	persistDrafts();
	syncDraftMirror(draftId);
}

export function revertDraftTo(draftId: string, index: number) {
	emailDrafts.update((list) => {
		const idx = list.findIndex((d) => d.id === draftId);
		if (idx === -1) return list;
		const draft = list[idx];
		if (index < 0 || index >= draft.versions.length) return list;
		const next = [...list];
		next[idx] = { ...draft, currentVersion: index, updatedAt: Date.now() };
		return next;
	});
	persistDrafts();
	syncDraftMirror(draftId);
}

export function setDraftStatus(draftId: string, status: DraftStatus) {
	emailDrafts.update((list) => {
		const idx = list.findIndex((d) => d.id === draftId);
		if (idx === -1) return list;
		const next = [...list];
		const patch: Partial<ChatDraft> = { status, updatedAt: Date.now() };
		if (status === 'sent') patch.sentAt = Date.now();
		if (status === 'dropped') patch.droppedAt = Date.now();
		next[idx] = { ...next[idx], ...patch };
		return next;
	});
	if (get(openDraftId) === draftId && status !== 'active') openDraftId.set(null);
	persistDrafts(true);
}

export function restoreDraft(draftId: string) {
	// Honour the active-draft cap when restoring from history.
	emailDrafts.update((list) => {
		const idx = list.findIndex((d) => d.id === draftId);
		if (idx === -1) return list;
		let next = [...list];
		const activeCount = next.filter((d) => d.status === 'active').length;
		if (activeCount >= MAX_ACTIVE_DRAFTS) {
			const oldest = next
				.filter((d) => d.status === 'active')
				.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
			next = next.map((d) =>
				d.id === oldest.id
					? { ...d, status: 'dropped' as DraftStatus, droppedAt: Date.now(), updatedAt: Date.now() }
					: d
			);
		}
		next = next.map((d) =>
			d.id === draftId ? { ...d, status: 'active' as DraftStatus, updatedAt: Date.now() } : d
		);
		return next;
	});
	openDraftId.set(draftId);
	draftHistoryOpen.set(false);
	persistDrafts(true);
}
