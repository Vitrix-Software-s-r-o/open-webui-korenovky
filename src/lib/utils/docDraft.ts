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

export const DOC_DRAFT_MARKER_PREFIX = '<!--KORAI_DOC_DRAFT:';
const DOC_DRAFT_MARKER_RE = /<!--KORAI_DOC_DRAFT:([A-Za-z0-9_-]+)-->/;

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
	return typeof text === 'string' && text.includes(DOC_DRAFT_MARKER_PREFIX);
}

/** Extract + decode the draft marker from a tool result, returning the decoded
 *  payload and the text with the marker removed. `payload` is null when no
 *  (valid) marker is present. */
export function extractDocDraft(text: string): DocDraftMarker {
	if (typeof text !== 'string' || !text.includes(DOC_DRAFT_MARKER_PREFIX)) {
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
