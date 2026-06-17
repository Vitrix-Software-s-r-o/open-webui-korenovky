/**
 * Shared helper for the OnlyOffice document-draft auto-open mechanism.
 *
 * files-link emits an invisible marker on every tool result that produced /
 * imported / edited a supported office file:
 *
 *     <!--KORAI_DOC_DRAFT:<urlsafe-base64(document_draft_dialog)>-->
 *
 * The base64 payload is a `document_draft_dialog` object (the same shape
 * `prepare_document_draft` returns) plus `open` (pop the editor?) and an
 * optional `replaces` (a draft id to drop — e.g. an imported template
 * superseded by its working copy). One scanner, used everywhere a tool result
 * is rendered, so any source/file type flows through identical logic.
 */

// The marker reaches us either raw (`<!--KORAI_DOC_DRAFT:…-->`) or
// HTML-entity-encoded (`&lt;!--KORAI_DOC_DRAFT:…--&gt;`) depending on whether the
// tool-result text was decoded before we see it (ToolCallDisplay's resultContent
// path is NOT decoded). Match both, and key the cheap presence check off the
// stable inner token so it's encoding-agnostic. The base64 body is urlsafe
// ([A-Za-z0-9_-]) so it never contains characters that get entity-encoded.
export const DOC_DRAFT_MARKER_TOKEN = 'KORAI_DOC_DRAFT:';
// The base64 body is urlsafe (-, _) AND may carry `=` padding (Python's
// urlsafe_b64encode keeps it) — the `=` MUST be in the class or the match stops
// before the padding and never reaches the closing `-->`.
const DOC_DRAFT_MARKER_RE = /(?:<!--|&lt;!--)KORAI_DOC_DRAFT:([A-Za-z0-9=_-]+)(?:-->|--&gt;)/;

export interface DocDraftMarker {
	/** Decoded `document_draft_dialog` payload (draft_id, draft, open, replaces). */
	payload: any;
	/** The tool-result text with the marker stripped (for display). */
	cleaned: string;
}

function decodeBase64Url(b64url: string): any | null {
	try {
		// urlsafe → standard base64, then pad.
		let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
		const pad = b64.length % 4;
		if (pad) b64 += '='.repeat(4 - pad);
		const bin = atob(b64);
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (e) {
		console.error('[doc-draft] bad marker payload', e);
		return null;
	}
}

/** Quick test used to decide whether a collapsed tool-call group should
 *  auto-expand (so the ingesting component mounts). Cheap substring check. */
export function hasDocDraftMarker(text: string): boolean {
	return typeof text === 'string' && text.includes(DOC_DRAFT_MARKER_TOKEN);
}

/** Extract + decode the draft marker from a tool result, returning the decoded
 *  payload and the text with the marker removed. `payload` is null when no
 *  (valid) marker is present. */
export function extractDocDraft(text: string): DocDraftMarker {
	if (typeof text !== 'string' || !text.includes(DOC_DRAFT_MARKER_TOKEN)) {
		return { payload: null, cleaned: text };
	}
	const m = text.match(DOC_DRAFT_MARKER_RE);
	if (!m) return { payload: null, cleaned: text };
	const payload = decodeBase64Url(m[1]);
	// Strip the marker (and any leading whitespace we added before it) from the
	// displayed text regardless of decode success.
	const cleaned = text.replace(DOC_DRAFT_MARKER_RE, '').replace(/\n{3,}$/, '\n').trimEnd();
	return { payload, cleaned };
}

/** Decode EVERY draft marker found in a (possibly large, multi-tool) message —
 *  used for a robust message-level scan that doesn't depend on the markdown
 *  tokenizer surfacing the marker in any particular per-tool token (it doesn't,
 *  for tool results with complex/huge bodies). Returns the decoded payloads in
 *  order; invalid markers are skipped. */
export function extractAllDocDrafts(text: string): any[] {
	if (typeof text !== 'string' || !text.includes(DOC_DRAFT_MARKER_TOKEN)) return [];
	const re = new RegExp(DOC_DRAFT_MARKER_RE.source, 'g');
	const out: any[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const payload = decodeBase64Url(m[1]);
		if (payload) out.push(payload);
	}
	return out;
}
