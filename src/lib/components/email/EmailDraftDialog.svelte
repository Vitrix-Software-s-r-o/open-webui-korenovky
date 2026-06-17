<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import DOMPurify from 'dompurify';
  import EmailBodyEditor from './EmailBodyEditor.svelte';
  import DraftVersionNav from './DraftVersionNav.svelte';
  import PDFViewer from '$lib/components/common/PDFViewer.svelte';
  import { uploadFile } from '$lib/apis/files';
  import {
    emailDraftWindow,
    setDraftWindow,
    chatAttachedFiles,
    materializeOfficeAttachments
  } from '$lib/stores/email';
  import type { DraftAttachment, DraftVersion, DraftStatus } from '$lib/stores/email';

  // --- Props (controlled by EmailDraftManager / the email-drafts store) ---
  export let draftId: string;
  export let mailboxId: string = '';
  export let version: DraftVersion;
  export let status: DraftStatus = 'active';
  export let versionIndex: number = 0;
  export let versionCount: number = 1;

  const dispatch = createEventDispatcher<{
    edit: Partial<DraftVersion>;
    revert: { index: number };
    sent: void;
    drop: void;
    close: void;
  }>();

  let dialogEl: HTMLElement;
  let cardEl: HTMLElement;

  // --- Shared, chat-persisted window geometry (size + position + snap edge).
  // Only one draft window is open at a time, so all drafts share one state. ---
  $: win = $emailDraftWindow;

  // Track the viewport so snapped/clamped geometry recomputes on browser resize.
  let vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  let vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  function onResize() {
    vw = window.innerWidth;
    vh = window.innerHeight;
  }

  // First-open default: snapped to the right at ~1/3 of the viewport width. If
  // that third would be narrower than 400px (small screens), open maximized.
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

  // Resolve the concrete on-screen rectangle from the (possibly snapped) state.
  // Snapped rects derive from the live viewport, so a browser resize re-flows
  // them; free rects are clamped so a resize can't strand them off-screen.
  function computeGeom(s: any, vw0: number, vh0: number) {
    const snap = s?.snap ?? 'none';
    // Snapped left/right keep a full-height column docked to the edge; their width
    // is `s.w` (defaults to half on snap) so it stays user-resizable.
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
  // Free window → all handles; snapped left/right → only the inner edge (width);
  // snapped top (full) → none.
  $: visibleHandles = !snapped
    ? RESIZE_HANDLES
    : effWin.snap === 'left'
      ? RESIZE_HANDLES.filter((h) => h.dir === 'e')
      : effWin.snap === 'right'
        ? RESIZE_HANDLES.filter((h) => h.dir === 'w')
        : [];

  const SNAP_T = 28; // px from an edge that arms a snap while dragging
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
    // Drag from anywhere in the window, except interactive controls so inputs,
    // the editor, buttons, attachments and the signature iframe still work.
    if (
      (e.target as HTMLElement).closest(
        'button, a, input, textarea, select, iframe, [contenteditable="true"], [role="textbox"], .ProseMirror, .tiptap'
      )
    )
      return;
    if (e.button !== 0) return; // primary button only
    const baseX = geom.x;
    const baseY = geom.y;
    const freeW = win && win.snap === 'none' ? win.w : Math.min(480, vw - 32);
    const freeH = win && win.snap === 'none' ? win.h : Math.min(620, Math.round(vh * 0.85));
    const start = { px: e.clientX, py: e.clientY };
    let dragging = false; // becomes true once the pointer clears a small threshold
    function move(ev: PointerEvent) {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (!dragging) {
        if (Math.abs(dx) + Math.abs(dy) < 6) return; // ignore clicks / micro-moves
        dragging = true;
        // Releasing a snapped window into a free one at its current spot.
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
      // New snaps default to a half-viewport-wide column (resizable afterwards).
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
      // Snapped left/right: only the docked width changes; keep the snap + full height.
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

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (previewState) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePreview();
      return;
    }
    if (showDropbox || showChatFiles) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showDropbox = false;
      showChatFiles = false;
      dropboxQuery = '';
      dropboxResults = [];
      return;
    }
    // Focus inside the panel: swallow ESC so it can't abort the chat stream, but
    // otherwise do nothing — closing is via the × button (reopen from the bar).
    const active = document.activeElement;
    if (!sending && dialogEl && active instanceof Node && dialogEl.contains(active)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  onMount(() => {
    if (dialogEl) document.body.appendChild(dialogEl);
    if (!get(emailDraftWindow)) setDraftWindow(defaultWindow(vw, vh));
    window.addEventListener('keydown', handleGlobalKeydown, true);
    window.addEventListener('resize', onResize);
  });

  onDestroy(() => {
    if (dialogEl?.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    window.removeEventListener('keydown', handleGlobalKeydown, true);
    window.removeEventListener('resize', onResize);
    clearTimeout(editTimer);
    clearTimeout(flashTimer);
    for (const u of Object.values(blobUrls)) URL.revokeObjectURL(u);
  });

  // --- Send state ---
  let sending = false;
  let dialogAnimClass = 'dialog-pop-in';
  let showSuccessBadge = false;
  let sendError = '';

  function onSendAnimationEnd(e: AnimationEvent) {
    if ((e.target as HTMLElement)?.classList.contains('dialog-send-out')) {
      showSuccessBadge = true;
      setTimeout(() => dispatch('sent'), 1500);
    }
  }

  // --- Editable state, (re)initialised whenever the bound version changes ---
  let to: string[] = [];
  let cc: string[] = [];
  let subject = '';
  let attachments: DraftAttachment[] = [];
  let bodyInitialHtml = '';
  let signatureHtml = '';
  let signatureSrcdoc = '';
  let bodyEditor: EmailBodyEditor;
  let signatureFrame: HTMLIFrameElement;

  let toInput = '';
  let ccInput = '';

  // Local files kept in memory for fast preview/send. owui_file attachments are
  // durable (OWUI file id); the cache avoids a round-trip for just-added files.
  let uploadedFiles: File[] = [];
  let owuiBlobs: Record<string, File> = {};
  let blobUrls: Record<string, string> = {};

  let initializing = true;
  let versionKey = '';
  let prevAt: number | null = null;
  let showFlash = false;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const SIG_OPTS = {
    ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'td', 'th', 'img'],
    ADD_ATTR: [
      'width', 'height', 'cellpadding', 'cellspacing', 'border', 'bgcolor',
      'align', 'valign', 'colspan', 'rowspan', 'style', 'src', 'href', 'target', 'alt'
    ]
  };

  $: nextKey = `${draftId}:${versionIndex}:${version?.at ?? 0}`;
  $: if (version && nextKey !== versionKey) {
    versionKey = nextKey;
    initFromVersion();
  }

  async function initFromVersion() {
    initializing = true;
    to = [...(version.to ?? [])];
    cc = [...(version.cc ?? [])];
    subject = version.subject ?? '';
    attachments = [...(version.attachments ?? [])];
    bodyInitialHtml = version.body ?? '';
    signatureHtml = DOMPurify.sanitize(version.signature ?? '', SIG_OPTS);
    signatureSrcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; padding: 0; background: #ffffff; color: #1a1a1a; color-scheme: light; }
      body { padding: 6px 8px; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.4; overflow: auto; }
      body:focus { outline: none; }
    </style></head><body contenteditable="true">${signatureHtml}</body></html>`;

    // Flash when the assistant has produced a new version (not on first mount/revert-to-same).
    if (prevAt !== null && version.authoredBy === 'ai' && version.at !== prevAt) {
      showFlash = true;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (showFlash = false), 2000);
    }
    prevAt = version.at;

    await tick();
    initializing = false;

    // Converge external attachment refs into the internal store on open.
    void materializeAttachments();
  }

  // --- Manual-edit sync-back (debounced) -------------------------------
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleEdit() {
    if (initializing) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(emitEdit, 500);
  }
  function emitEdit() {
    if (initializing) return;
    const body = bodyEditor?.getHtml() ?? bodyInitialHtml;
    const signatureRaw = signatureFrame?.contentDocument?.body?.innerHTML ?? signatureHtml;
    const signature = DOMPurify.sanitize(signatureRaw, SIG_OPTS);
    dispatch('edit', {
      to: [...to],
      cc: [...cc],
      subject,
      attachments: [...attachments],
      body,
      signature
    });
  }
  // Recompute on field changes (guarded against the init pass).
  $: void [to, cc, subject, attachments], scheduleEdit();

  // --- Attachment preview ---
  type PreviewState = { filename: string; url: string; isImage: boolean; isPdf: boolean };
  let previewState: PreviewState | null = null;

  function getExt(filename: string): string {
    return filename.split('.').pop()?.toLowerCase() ?? '';
  }

  function getFileMeta(name: string): { color: string; label: string } {
    const ext = getExt(name);
    if (ext === 'pdf') return { color: '#dc2626', label: 'PDF' };
    if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return { color: '#2563eb', label: 'W' };
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return { color: '#16a34a', label: 'X' };
    if (['ppt', 'pptx', 'odp'].includes(ext)) return { color: '#ea580c', label: 'P' };
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp', 'avif', 'tiff'].includes(ext))
      return { color: '#9333ea', label: 'IMG' };
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { color: '#ca8a04', label: 'ZIP' };
    if (['txt', 'md', 'log'].includes(ext)) return { color: '#6b7280', label: 'TXT' };
    if (['eml', 'msg'].includes(ext)) return { color: '#0891b2', label: 'EML' };
    return { color: '#6b7280', label: ext.slice(0, 3).toUpperCase() };
  }

  function isPreviewableExt(ext: string): boolean {
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf'].includes(ext);
  }

  // --- Single convergence point: every attachment ends up in the internal OWUI
  // file store as an `owui_file`. Imports dropbox / office_file / pending-upload
  // sources by fetching their bytes and uploading to /files/. Returns the input
  // unchanged if it's already owui_file or if import fails (so sending still works).
  async function materializeAttachment(att: DraftAttachment): Promise<DraftAttachment> {
    if (att.type === 'owui_file' && att.file_id) return att;
    try {
      let blob: Blob | null = null;
      if (att.type === 'dropbox' && att.ref) {
        const r = await fetch(`/api/dropbox-file?path=${encodeURIComponent(att.ref)}`);
        if (r.ok) blob = await r.blob();
      } else if (att.type === 'office_file' && (att.download_url || att.ref)) {
        // The /files/{token} URL is normally in download_url, but tolerate it
        // landing in ref (an LLM occasionally fills the wrong field).
        const r = await fetch(att.download_url || att.ref);
        if (r.ok) blob = await r.blob();
      } else if (att.type === 'upload' && att.upload_index !== undefined) {
        blob = uploadedFiles[att.upload_index] ?? null;
      }
      if (!blob) return att;
      const file = new File([blob], att.filename, {
        type: blob.type || 'application/octet-stream'
      });
      const res = await uploadFile(localStorage.token, file, { email_attachment: true }, false);
      const id = (res as any)?.id;
      if (!id) return att;
      owuiBlobs[id] = file;
      return { type: 'owui_file', filename: att.filename, file_id: id };
    } catch {
      return att;
    }
  }

  // Converge any not-yet-internal attachments (AI office_file refs, legacy dropbox
  // refs from persisted drafts) into the OWUI store, then persist the normalised
  // list. Guards against the version changing underneath us.
  async function materializeAttachments() {
    // office_file (and legacy dropbox) refs are imported eagerly by the store at
    // ingest (materializeOfficeAttachments) — importing them here too would
    // double-upload. Here we only import the dialog's own in-memory 'upload'
    // files, which the store can't see. The store's conversion flows back via the
    // version prop (initFromVersion re-runs), so office_file chips become owui_file.
    const key = versionKey;
    const snapshot = attachments;
    if (!snapshot.some((a) => a.type === 'upload')) return;
    const out = await Promise.all(
      snapshot.map((a) => (a.type === 'upload' ? materializeAttachment(a) : Promise.resolve(a)))
    );
    if (versionKey !== key) return;
    attachments = attachments.map((a) => {
      const i = snapshot.indexOf(a);
      return i >= 0 ? out[i] : a;
    });
    emitEdit();
  }

  async function fetchOwuiBlob(fileId: string): Promise<File | null> {
    if (owuiBlobs[fileId]) return owuiBlobs[fileId];
    try {
      const resp = await fetch(`/api/v1/files/${fileId}/content`, {
        headers: { authorization: `Bearer ${localStorage.token}` }
      });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return new File([blob], 'file', { type: blob.type });
    } catch {
      return null;
    }
  }

  // Fetch an attachment's bytes from whatever source it has, as a File. The
  // office_file URL is normally in download_url but is tolerated in ref (an
  // LLM occasionally fills the wrong field). Returns null if it can't be read.
  async function resolveAttachmentFile(att: DraftAttachment): Promise<File | null> {
    try {
      if (att.type === 'upload' && att.upload_index !== undefined) {
        return uploadedFiles[att.upload_index] ?? null;
      }
      if (att.type === 'owui_file' && att.file_id) {
        return owuiBlobs[att.file_id] ?? (await fetchOwuiBlob(att.file_id));
      }
      if (att.type === 'office_file') {
        const u = att.download_url || att.ref;
        if (u) {
          const r = await fetch(u);
          if (r.ok)
            return new File([await r.blob()], att.filename, {
              type: r.headers.get('content-type') || ''
            });
        }
      }
      if (att.type === 'dropbox' && att.ref) {
        const r = await fetch(`/api/dropbox-file?path=${encodeURIComponent(att.ref)}`);
        if (r.ok) return new File([await r.blob()], att.filename);
      }
    } catch {
      /* fall through to null */
    }
    return null;
  }

  function downloadBlobUrl(url: string, filename: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // MIME type by extension for previewable files. The bytes can arrive with a
  // generic/wrong content-type (e.g. application/octet-stream from OWUI's
  // /content), which makes a blob <iframe>/<img> fail to render inline and the
  // browser DOWNLOAD it instead — so we re-stamp the blob with the right type.
  function previewMime(ext: string): string {
    const m: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml'
    };
    return m[ext] ?? '';
  }

  // Click an attachment chip: images + PDFs open an in-browser preview (with a
  // download button — download only on request); every other format downloads
  // right away with no dialog. Always works off a fetched blob so a /files/
  // "attachment"-disposition URL still previews.
  async function handleAttachmentClick(att: DraftAttachment) {
    const ext = getExt(att.filename);
    const previewable = isPreviewableExt(ext);

    // If it's still a volatile office_file (e.g. a draft created before the
    // eager copy, or ingest-time import failed), import it into the durable store
    // now via the store, then re-read the (re-init'd) attachment — so a one-off
    // click still gets a stable file while the source is alive.
    if (att.type === 'office_file') {
      await materializeOfficeAttachments(draftId);
      await tick();
      const refreshed = attachments.find((a) => a.filename === att.filename) ?? att;
      if (refreshed.type === 'owui_file') att = refreshed;
    }

    const file = await resolveAttachmentFile(att);
    if (!file) {
      // Couldn't fetch bytes. Only ever open a DURABLE/external URL (Dropbox's
      // open_url) — never the volatile /files/{token}, which 404s with a
      // "File no longer available" page once the source is dropped/pruned.
      const u = att.type === 'dropbox' ? att.open_url || att.ref || '' : '';
      if (u) window.open(u, '_blank', 'noopener,noreferrer');
      else toast.error('Soubor už není dostupný — zdroj byl odstraněn. Vytvořte přílohu znovu.');
      return;
    }

    if (!previewable) {
      // Not previewable in the browser → download immediately, no dialog.
      const url = URL.createObjectURL(file);
      downloadBlobUrl(url, att.filename);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return;
    }

    // Previewable → show in the dialog. Re-stamp the blob with the correct MIME
    // so it renders inline (never auto-downloads); the dialog's button is the
    // only way to download.
    const mime = previewMime(ext);
    const blob = mime ? new Blob([file], { type: mime }) : file;
    const url = URL.createObjectURL(blob);
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext);
    const isPdf = ext === 'pdf';
    previewState = { filename: att.filename, url, isImage, isPdf };
  }

  function closePreview() {
    if (previewState?.url.startsWith('blob:')) URL.revokeObjectURL(previewState.url);
    previewState = null;
  }

  function addTag(arr: string[], val: string): string[] {
    const v = val.trim();
    return v && !arr.includes(v) ? [...arr, v] : arr;
  }

  function handleTagKey(
    e: KeyboardEvent,
    arr: string[],
    setter: (v: string[]) => void,
    inputSetter: (v: string) => void,
    inputVal: string
  ) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      setter(addTag(arr, inputVal));
      inputSetter('');
    }
  }

  // Local uploads are imported into durable OWUI storage so a persisted draft
  // keeps its files across reloads. On failure we fall back to a non-durable
  // in-memory 'upload' attachment so the user can still send right now.
  async function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files) return;
    const newFiles = Array.from(input.files);
    input.value = '';
    for (const f of newFiles) {
      try {
        const res = await uploadFile(localStorage.token, f, { email_attachment: true }, false);
        const id = (res as any)?.id;
        if (!id) throw new Error('no id');
        owuiBlobs[id] = f;
        attachments = [...attachments, { type: 'owui_file', filename: f.name, file_id: id }];
      } catch (err) {
        const idx = uploadedFiles.length;
        uploadedFiles = [...uploadedFiles, f];
        attachments = [...attachments, { type: 'upload', filename: f.name, upload_index: idx }];
        toast.error(`Soubor „${f.name}" se nepodařilo trvale uložit — bude odeslán pouze nyní.`);
      }
    }
  }

  function removeAttachment(idx: number) {
    const att = attachments[idx];
    if (att.type === 'upload' && att.upload_index !== undefined) {
      uploadedFiles = uploadedFiles.filter((_, i) => i !== att.upload_index);
      let counter = 0;
      attachments = attachments
        .filter((_, i) => i !== idx)
        .map((a) => (a.type === 'upload' ? { ...a, upload_index: counter++ } : a));
    } else {
      attachments = attachments.filter((_, i) => i !== idx);
    }
  }

  async function handleSend() {
    if (toInput.trim()) {
      to = addTag(to, toInput);
      toInput = '';
    }
    if (ccInput.trim()) {
      cc = addTag(cc, ccInput);
      ccInput = '';
    }
    if (!to.length) {
      toast.error('Zadejte alespoň jednoho příjemce');
      return;
    }
    sending = true;
    sendError = '';
    try {
      const currentBodyHtml = bodyEditor?.getHtml() ?? bodyInitialHtml;
      const signatureRaw = signatureFrame?.contentDocument?.body?.innerHTML ?? signatureHtml;
      const currentSignatureHtml = DOMPurify.sanitize(signatureRaw, SIG_OPTS);

      // Resolve durable (owui_file) and pending (upload) attachments into bytes;
      // dropbox / office_file refs are resolved server-side at send.
      const sendAttachments: any[] = [];
      const filesToSend: File[] = [];
      for (const att of attachments) {
        if (att.type === 'upload' && att.upload_index !== undefined) {
          const f = uploadedFiles[att.upload_index];
          if (f) {
            sendAttachments.push({ type: 'upload', filename: att.filename, upload_index: filesToSend.length });
            filesToSend.push(f);
          }
        } else if (att.type === 'owui_file' && att.file_id) {
          const f = owuiBlobs[att.file_id] ?? (await fetchOwuiBlob(att.file_id));
          if (f) {
            sendAttachments.push({ type: 'upload', filename: att.filename, upload_index: filesToSend.length });
            filesToSend.push(new File([f], att.filename, { type: f.type }));
          } else {
            throw new Error(`Přílohu „${att.filename}" se nepodařilo načíst`);
          }
        } else {
          sendAttachments.push(att);
        }
      }

      const formData = new FormData();
      formData.append(
        'draft_json',
        JSON.stringify({
          mailbox_id: mailboxId,
          to,
          cc,
          bcc: version.bcc ?? [],
          subject,
          body: currentBodyHtml,
          signature: currentSignatureHtml,
          attachments: sendAttachments,
          in_reply_to: version.in_reply_to ?? null,
          references: version.references ?? null
        })
      );
      filesToSend.forEach((f) => formData.append('files', f));

      const resp = await fetch(`/api/email-drafts/${draftId}/send`, {
        method: 'POST',
        body: formData
      });

      if (!resp.ok) {
        if (resp.status === 410) throw new Error('Náhled vypršel – zkuste znovu');
        const err = await resp.json().catch(() => ({}));
        throw new Error((err as any).detail ?? `HTTP ${resp.status}`);
      }

      dialogAnimClass = 'dialog-send-out';
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      if (raw.includes('410') || raw.toLowerCase().includes('vypršel') || raw.toLowerCase().includes('expired')) {
        sendError = 'Relace vypršela — draft již není dostupný. Požádejte asistenta o nový návrh e-mailu.';
      } else if (raw.toLowerCase().includes('smtp') || raw.includes('502')) {
        sendError = 'E-mail se nepodařilo odeslat (chyba poštovního serveru). Zkuste to prosím znovu.';
      } else {
        sendError = `Chyba při odesílání: ${raw}`;
      }
    } finally {
      sending = false;
    }
  }

  function handleClose() {
    emitEdit();
    dispatch('close');
  }

  function handleDrop() {
    dispatch('drop');
  }

  // --- Dropbox picker ---
  let showDropbox = false;
  let dropboxQuery = '';
  let dropboxQueryInput: HTMLInputElement;
  type DropboxResult = {
    name: string;
    path_display: string;
    path_lower: string;
    folder_path: string;
    modified: string;
    open_url: string;
  };
  let dropboxResults: DropboxResult[] = [];
  let dropboxSearching = false;

  async function toggleDropbox() {
    showDropbox = !showDropbox;
    if (showDropbox) {
      await tick();
      dropboxQueryInput?.focus();
    }
  }

  function formatModified(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('cs-CZ', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function searchDropbox() {
    if (!dropboxQuery.trim()) return;
    dropboxSearching = true;
    try {
      const resp = await fetch(`/api/dropbox-search?q=${encodeURIComponent(dropboxQuery)}`);
      const data = await resp.json();
      dropboxResults = (data.results ?? []).map((r: any): DropboxResult => {
        const display = r.path_display ?? r.path ?? r.path_lower ?? '';
        const folder = r.folder_path ?? display.split('/').slice(0, -1).join('/');
        return {
          name: r.name ?? r.filename ?? display.split('/').pop() ?? 'file',
          path_display: display,
          path_lower: r.path_lower ?? display,
          folder_path: folder,
          modified: r.server_modified ?? r.client_modified ?? '',
          open_url: r.open_url ?? r.dropbox_url ?? ''
        };
      });
    } catch {
      toast.error('Chyba při hledání v Dropboxu');
    } finally {
      dropboxSearching = false;
    }
  }

  let importingAttachment = false;
  async function addDropboxFile(file: DropboxResult) {
    const ref = file.path_display || file.path_lower;
    if (!ref) {
      toast.error('Soubor z Dropboxu nemá platnou cestu');
      return;
    }
    showDropbox = false;
    dropboxQuery = '';
    dropboxResults = [];
    // Import into the internal store immediately so every source converges.
    importingAttachment = true;
    const att = await materializeAttachment({
      type: 'dropbox',
      filename: file.name,
      ref,
      open_url: file.open_url
    });
    importingAttachment = false;
    if (att.type !== 'owui_file') {
      toast.error(`Soubor „${file.name}" se nepodařilo importovat z Dropboxu`);
      return;
    }
    attachments = [...attachments, att];
  }

  // --- Chat-file picker: attach a file already uploaded to this chat. It is
  // already an OWUI file id, so it's added directly as an internal attachment. ---
  let showChatFiles = false;
  function toggleChatFiles() {
    showChatFiles = !showChatFiles;
    if (showChatFiles) showDropbox = false;
  }
  function addChatFile(f: { id: string; name: string }) {
    if (attachments.some((a) => a.type === 'owui_file' && a.file_id === f.id)) {
      toast.error('Tento soubor je již přiložen');
      showChatFiles = false;
      return;
    }
    attachments = [...attachments, { type: 'owui_file', filename: f.name, file_id: f.id }];
    showChatFiles = false;
  }
</script>

<!-- Non-modal floating panel — teleported to document.body on mount to escape CSS
     containment. The wrapper spans the viewport but is click-through
     (pointer-events-none); only the card and its sub-overlays capture pointer
     events, so the chat behind it stays fully interactive. -->
<div
  bind:this={dialogEl}
  class="fixed inset-0 z-50 pointer-events-none"
  role="dialog"
  aria-label="Návrh e-mailu"
>
  <!-- Snap preview — shows the target dock region while dragging near an edge -->
  {#if snapHint}
    <div
      class="absolute z-[1] rounded-2xl bg-blue-500/15 border-2 border-blue-400/70 pointer-events-none"
      style={snapPreviewStyle}
    ></div>
  {/if}

  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    bind:this={cardEl}
    class="pointer-events-auto absolute bg-white dark:bg-gray-900 rounded-2xl shadow-2xl ring-1 flex flex-col overflow-hidden {dialogAnimClass} {showFlash
      ? 'ring-2 ring-violet-400'
      : 'ring-black/5 dark:ring-white/10'}"
    style={cardStyle}
    on:pointerdown={startDrag}
    on:animationend={onSendAnimationEnd}
  >
    <!-- Resize handles — all edges/corners when free; inner edge only when snapped -->
    {#each visibleHandles as h}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="absolute z-20 {h.cls}" on:pointerdown={(e) => startResize(h.dir, e)}></div>
    {/each}

    <!-- Header (title bar) -->
    <div
      class="relative z-10 flex items-center justify-between gap-2 px-5 py-3 border-b border-gray-200 dark:border-gray-700 select-none shrink-0 cursor-move"
    >
      <div class="flex items-center gap-2 min-w-0">
        <h2 class="text-base font-semibold text-gray-900 dark:text-white truncate">Nový e-mail</h2>
        {#if showFlash}
          <span class="text-[11px] text-violet-600 dark:text-violet-300 shrink-0 whitespace-nowrap">upraveno asistentem</span>
        {/if}
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <DraftVersionNav
          index={versionIndex}
          count={versionCount}
          authoredBy={version?.authoredBy ?? 'ai'}
          on:revert
        />
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
          title="Zavřít (koncept zůstane uložený)"
        >×</button>
      </div>
    </div>

    <!-- Scrollable body — min-h-0 lets it shrink within the card so it scrolls
         instead of pushing the footer out. -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4 text-sm" on:focusout={emitEdit}>

      <!-- From (read-only) -->
      <div class="flex items-center gap-3">
        <span class="w-20 shrink-0 select-none font-medium text-gray-600 dark:text-gray-400">Od:</span>
        <span class="text-gray-800 dark:text-gray-200">{version.from}</span>
      </div>

      <!-- To -->
      <div class="flex items-start gap-3">
        <span class="w-20 shrink-0 select-none font-medium text-gray-600 dark:text-gray-400 pt-1.5">Komu:</span>
        <div
          class="flex-1 flex flex-wrap gap-1 border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 min-h-[38px] focus-within:ring-2 focus-within:ring-blue-500"
        >
          {#each to as email, i}
            <span
              class="inline-flex items-center gap-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-sm rounded px-2 py-0.5"
            >
              {email}
              <button on:click={() => (to = to.filter((_, j) => j !== i))} class="hover:text-red-500">×</button>
            </span>
          {/each}
          <input
            bind:value={toInput}
            placeholder="email@example.com"
            class="flex-1 min-w-[150px] outline-none bg-transparent"
            on:keydown={(e) => handleTagKey(e, to, (v) => (to = v), (v) => (toInput = v), toInput)}
          />
        </div>
      </div>

      <!-- CC -->
      <div class="flex items-start gap-3">
        <span class="w-20 shrink-0 select-none font-medium text-gray-600 dark:text-gray-400 pt-1.5">Kopie:</span>
        <div
          class="flex-1 flex flex-wrap gap-1 border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 min-h-[38px] focus-within:ring-2 focus-within:ring-blue-500"
        >
          {#each cc as email, i}
            <span
              class="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm rounded px-2 py-0.5"
            >
              {email}<button on:click={() => (cc = cc.filter((_, j) => j !== i))} class="hover:text-red-500">×</button>
            </span>
          {/each}
          <input
            bind:value={ccInput}
            placeholder="email@example.com"
            class="flex-1 min-w-[150px] outline-none bg-transparent"
            on:keydown={(e) => handleTagKey(e, cc, (v) => (cc = v), (v) => (ccInput = v), ccInput)}
          />
        </div>
      </div>

      <!-- Subject -->
      <div class="flex items-center gap-3">
        <span class="w-20 shrink-0 select-none font-medium text-gray-600 dark:text-gray-400">Předmět:</span>
        <input
          bind:value={subject}
          class="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-transparent outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <!-- Body — Rich Text Editor (keyed so it re-mounts on version change/revert) -->
      <div>
        <div class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 select-none">Obsah zprávy</div>
        {#key versionKey}
          <EmailBodyEditor
            bind:this={bodyEditor}
            initialHtml={bodyInitialHtml}
            minHeight="120px"
            on:change={scheduleEdit}
          />
        {/key}
      </div>

      <!-- Signature -->
      {#if signatureHtml}
        <div>
          <div class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1 select-none">Podpis</div>
          {#key versionKey}
            <iframe
              bind:this={signatureFrame}
              srcdoc={signatureSrcdoc}
              title="Podpis"
              class="w-full border border-gray-200 dark:border-gray-700 rounded-lg bg-white"
              style="height: 120px; min-height: 48px; max-height: 160px; color-scheme: light;"
            ></iframe>
          {/key}
        </div>
      {/if}

    </div>

    <!-- Footer — attachments + actions -->
    <div class="border-t border-gray-200 dark:border-gray-700 px-6 pt-3 pb-4 flex flex-col gap-2 shrink-0">

      <!-- Chat-files picker -->
      {#if showChatFiles}
        <div class="border border-blue-200 dark:border-blue-800 rounded-lg p-2 space-y-1">
          <div class="flex items-center justify-between px-1">
            <span class="text-xs font-medium text-gray-600 dark:text-gray-400">Soubory z chatu</span>
            <button
              on:click={() => (showChatFiles = false)}
              class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
              aria-label="Zavřít"
            >×</button>
          </div>
          <div class="max-h-56 overflow-y-auto -mx-1 px-1">
            {#each $chatAttachedFiles as f (f.id)}
              {@const meta = getFileMeta(f.name)}
              <button
                on:click={() => addChatFile(f)}
                class="w-full flex items-center gap-1.5 text-left py-1.5 px-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-xs text-gray-800 dark:text-gray-200"
              >
                <svg class="shrink-0" width="14" height="17" viewBox="0 0 20 24" aria-hidden="true">
                  <path d="M2 2a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2z" fill={meta.color} />
                  <path d="M12 0v6h6" fill="white" fill-opacity="0.35" />
                  {#if meta.label}
                    <text x="10" y="17" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-weight="700" font-size={meta.label.length >= 3 ? 6 : 8.5}>{meta.label}</text>
                  {/if}
                </svg>
                <span class="truncate flex-1 min-w-0" title={f.name}>{f.name}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Dropbox picker -->
      {#if showDropbox}
        <div class="border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-2">
          <div class="flex gap-2 items-center">
            <button
              on:click={() => { showDropbox = false; dropboxQuery = ''; dropboxResults = []; }}
              class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none shrink-0"
              aria-label="Zavřít"
            >×</button>
            <input
              bind:this={dropboxQueryInput}
              bind:value={dropboxQuery}
              placeholder="Hledat v Dropboxu..."
              class="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-transparent outline-none"
              on:keydown={(e) => e.key === 'Enter' && searchDropbox()}
            />
            <button
              on:click={searchDropbox}
              disabled={dropboxSearching}
              class="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 shrink-0"
            >
              {dropboxSearching ? '...' : 'Hledat'}
            </button>
          </div>
          {#if dropboxResults.length > 0}
          <div class="max-h-56 overflow-y-auto -mx-1 px-1">
          {#each dropboxResults as file}
            {@const meta = getFileMeta(file.name)}
            <div class="flex items-center gap-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
              <button on:click={() => addDropboxFile(file)} class="flex-1 min-w-0 text-left py-1.5 px-2">
                <div class="text-xs flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                  <svg class="shrink-0" width="14" height="17" viewBox="0 0 20 24" aria-hidden="true">
                    <path d="M2 2a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2z" fill={meta.color}/>
                    <path d="M12 0v6h6" fill="white" fill-opacity="0.35"/>
                    {#if meta.label}
                      <text x="10" y="17" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-weight="700" font-size={meta.label.length >= 3 ? 6 : 8.5}>{meta.label}</text>
                    {/if}
                  </svg>
                  <span class="truncate flex-1 min-w-0" title={file.name}>{file.name}</span>
                  {#if file.modified}
                    <span class="shrink-0 text-[10px] text-gray-500 dark:text-gray-400 tabular-nums" title={file.modified}>{formatModified(file.modified)}</span>
                  {/if}
                </div>
                {#if file.folder_path}
                  <div class="text-[10px] text-gray-500 dark:text-gray-400 truncate pl-5" title={file.folder_path}>{file.folder_path}</div>
                {/if}
              </button>
              {#if file.open_url}
                <a
                  href={file.open_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="shrink-0 p-1.5 mr-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded"
                  title="Otevřít v Dropboxu"
                  aria-label="Otevřít v Dropboxu"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="size-4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </a>
              {/if}
            </div>
          {/each}
          </div>
          {/if}
        </div>
      {/if}

      <!-- Attachment chips -->
      {#if attachments.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each attachments as att, i}
            {@const attMeta = getFileMeta(att.filename)}
            <span class="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs rounded px-2 py-1">
              <button
                on:click={() => handleAttachmentClick(att)}
                class="flex items-center gap-1.5 hover:text-blue-600 dark:hover:text-blue-400 transition max-w-[160px]"
                title={att.filename}
              >
                <svg class="shrink-0" width="12" height="15" viewBox="0 0 20 24" aria-hidden="true">
                  <path d="M2 2a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2z" fill={attMeta.color}/>
                  <path d="M12 0v6h6" fill="white" fill-opacity="0.35"/>
                  {#if attMeta.label}
                    <text x="10" y="17" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-weight="700" font-size={attMeta.label.length >= 3 ? 6 : 8.5}>{attMeta.label}</text>
                  {/if}
                </svg>
                <span class="truncate">{att.filename}</span>
              </button>
              <button on:click={() => removeAttachment(i)} class="hover:text-red-500 shrink-0 ml-0.5 text-gray-400">×</button>
            </span>
          {/each}
        </div>
      {/if}

      <!-- Error -->
      {#if sendError}
        <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
          <svg class="size-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm-.75-10.5a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0V7.5zm.75 6a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>
          <span class="flex-1">{sendError}</span>
          <button on:click={() => (sendError = '')} class="text-red-400 hover:text-red-600 shrink-0 leading-none">×</button>
        </div>
      {/if}

      <!-- Action row -->
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0 select-none">Přílohy:</span>
        <label class="cursor-pointer inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition">
          📎 Ze zařízení
          <input type="file" multiple class="hidden" on:change={handleFileInput} />
        </label>
        <button
          on:click={toggleDropbox}
          class="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition
            {showDropbox
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
              : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}"
        >
          📦 Z Dropboxu
        </button>
        {#if $chatAttachedFiles.length > 0}
          <button
            on:click={toggleChatFiles}
            class="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition
              {showChatFiles
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
                : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}"
          >
            💬 Z chatu
          </button>
        {/if}
        {#if importingAttachment}
          <span class="inline-flex items-center gap-1 text-xs text-gray-400"><span class="animate-spin inline-block">⟳</span> importuji…</span>
        {/if}

        <div class="flex-1"></div>

        <button
          on:click={handleDrop}
          disabled={sending}
          class="text-sm px-3 py-2 text-gray-500 dark:text-gray-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
          title="Zahodit koncept (zůstane v historii)"
        >
          Zahodit
        </button>
        <button
          on:click={handleSend}
          disabled={sending || (!to.length && !toInput.trim())}
          class="text-sm px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
        >
          {#if sending}<span class="animate-spin inline-block">⟳</span>{/if}
          Odeslat →
        </button>
      </div>
    </div>
  </div>

  <!-- Attachment preview overlay -->
  {#if previewState}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="fixed inset-0 z-[55] flex items-center justify-center bg-black/80 pointer-events-auto"
      on:click|self={closePreview}
      on:keydown={(e) => e.key === 'Escape' && closePreview()}
    >
      <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <span class="text-sm font-medium text-gray-800 dark:text-white truncate">📎 {previewState.filename}</span>
          <div class="flex items-center gap-2 ml-4 shrink-0">
            {#if previewState.url}
              <a
                href={previewState.url}
                download={previewState.filename}
                class="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                title="Stáhnout"
              >
                <svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16.5h12" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Stáhnout
              </a>
            {/if}
            <button
              on:click={closePreview}
              class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
              aria-label="Zavřít náhled"
            >×</button>
          </div>
        </div>
        <div class="flex-1 overflow-auto p-4 flex items-center justify-center min-h-[300px]">
          {#if !previewState.url}
            <div class="text-center text-gray-500 dark:text-gray-400 text-sm space-y-2">
              <div class="text-4xl">📎</div>
              <div>Náhled není k dispozici.</div>
              {#if previewState.filename}
                <div class="text-xs text-gray-400">{previewState.filename}</div>
              {/if}
            </div>
          {:else if previewState.isImage}
            <img src={previewState.url} alt={previewState.filename} class="max-w-full max-h-[75vh] object-contain rounded" />
          {:else if previewState.isPdf}
            <!-- Render via PDF.js (canvas), not a browser <iframe>, so it always
                 previews inline — even when the browser is set to "download PDFs
                 instead of opening them" (which made the iframe auto-download). -->
            <PDFViewer url={previewState.url} className="w-full h-[75vh]" />
          {:else}
            <div class="text-center text-gray-500 dark:text-gray-400 text-sm space-y-2">
              <div class="text-4xl">📄</div>
              <div class="font-medium text-gray-700 dark:text-gray-300">{previewState.filename}</div>
              <div class="text-xs">Náhled pro tento formát není v prohlížeči dostupný.</div>
              <a href={previewState.url} download={previewState.filename} class="inline-block mt-2 text-blue-600 dark:text-blue-400 hover:underline text-xs">
                Stáhnout soubor
              </a>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Success badge -->
  {#if showSuccessBadge}
    <div class="fixed top-4 right-4 z-[60] flex items-center gap-2.5 bg-green-500 text-white text-sm font-medium px-4 py-3 rounded-xl shadow-xl badge-pop-in">
      <svg class="size-5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
      </svg>
      E-mail byl odeslán
    </div>
  {/if}
</div>

<style>
  .dialog-pop-in {
    animation: dialog-pop-in 0.38s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @keyframes dialog-pop-in {
    0%   { transform: scale(0.82); opacity: 0; }
    100% { transform: scale(1);    opacity: 1; }
  }

  .dialog-send-out {
    animation: dialog-send-out 0.4s cubic-bezier(0.4, 0, 0.8, 0.6) forwards;
    pointer-events: none;
    transform-origin: top right;
  }

  @keyframes dialog-send-out {
    0%   { transform: translateY(0) scale(1);     opacity: 1; }
    100% { transform: translateY(-28px) scale(0.85); opacity: 0; }
  }

  .badge-pop-in {
    animation: badge-pop-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @keyframes badge-pop-in {
    0%   { transform: scale(0.5) translateY(-8px); opacity: 0; }
    100% { transform: scale(1)   translateY(0);    opacity: 1; }
  }
</style>
