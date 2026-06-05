<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import EmailBodyEditor from './EmailBodyEditor.svelte';

  let dialogEl: HTMLElement;

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // The dialog owns ESC for as long as it is mounted. Stop the event before
    // any other listener (e.g. OWUI's chat-level ESC handler that aborts the
    // in-flight MCP stream) can see it. Registered in capture phase below so
    // we fire first regardless of registration order.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    // Stacked-overlay precedence: peel off the topmost open layer first.
    if (previewState) {
      closePreview();
    } else if (showDropbox) {
      showDropbox = false;
      dropboxQuery = '';
      dropboxResults = [];
    } else if (!sending) {
      handleCancel();
    }
  }

  onMount(() => {
    if (dialogEl) document.body.appendChild(dialogEl);
    // Capture phase so we beat any outer ESC handler (e.g. OWUI chat stream abort).
    window.addEventListener('keydown', handleGlobalKeydown, true);
  });

  onDestroy(() => {
    if (dialogEl?.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    window.removeEventListener('keydown', handleGlobalKeydown, true);
  });

  const dispatch = createEventDispatcher<{ close: { status: 'sent' | 'cancelled' } }>();

  export let draftId: string;
  export let draft: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    signature: string;
    attachments: Array<{ type: string; filename: string; upload_index?: number; ref?: string; download_url?: string }>;
  };

  let sending = false;
  let dialogAnimClass = 'dialog-pop-in';
  let showSuccessBadge = false;
  let sendError = '';

  function onSendAnimationEnd(e: AnimationEvent) {
    if ((e.target as HTMLElement)?.classList.contains('dialog-send-out')) {
      showSuccessBadge = true;
      setTimeout(() => dispatch('close', { status: 'sent' }), 1800);
    }
  }
  let to = [...draft.to];
  let cc = [...(draft.cc ?? [])];
  let subject = draft.subject;
  let attachments = [...(draft.attachments ?? [])];
  let bodyEditor: EmailBodyEditor;
  let signatureFrame: HTMLIFrameElement;

  // Convert Markdown body from AI to HTML for TipTap editor
  const bodyHtml = DOMPurify.sanitize(marked.parse(draft.body) as string);
  // Signature is already HTML — sanitize permissively to preserve complex tables/inline CSS
  const signatureHtml = DOMPurify.sanitize(draft.signature, {
    ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'td', 'th', 'img'],
    ADD_ATTR: [
      'width', 'height', 'cellpadding', 'cellspacing', 'border',
      'bgcolor', 'align', 'valign', 'colspan', 'rowspan',
      'style', 'src', 'href', 'target', 'alt'
    ],
  });

  // Wrap the signature in a minimal HTML doc so it renders inside an iframe
  // fully isolated from the app's Tailwind/dark-mode CSS — only the
  // signature's own inline styles apply, and the background is always white.
  const signatureSrcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: #ffffff; color: #1a1a1a; color-scheme: light; }
    body { padding: 6px 8px; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.4; overflow: auto; }
    body:focus { outline: none; }
  </style></head><body contenteditable="true">${signatureHtml}</body></html>`;
  let uploadedFiles: File[] = [];

  let toInput = '';
  let ccInput = '';

  // --- Attachment preview ---
  type PreviewState = { filename: string; url: string; isImage: boolean; isPdf: boolean };
  let previewState: PreviewState | null = null;

  function getExt(filename: string): string {
    return filename.split('.').pop()?.toLowerCase() ?? '';
  }

  // Brand-colored badge metadata per file type — used to render file-type icons
  // in the Dropbox picker and the attachment chips.
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

  function openPreview(att: typeof attachments[0]) {
    const ext = getExt(att.filename);
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext);
    const isPdf = ext === 'pdf';
    let url = '';
    if (att.type === 'upload' && att.upload_index !== undefined) {
      const file = uploadedFiles[att.upload_index];
      if (file) url = URL.createObjectURL(file);
    } else if (att.type === 'office_file' && att.download_url) {
      url = att.download_url;
    }
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

  function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files) return;
    const newFiles = Array.from(input.files);
    const startIdx = uploadedFiles.length;
    uploadedFiles = [...uploadedFiles, ...newFiles];
    attachments = [
      ...attachments,
      ...newFiles.map((f, i) => ({
        type: 'upload',
        filename: f.name,
        upload_index: startIdx + i,
      })),
    ];
    input.value = '';
  }

  function removeAttachment(idx: number) {
    const att = attachments[idx];
    if (att.type === 'upload' && att.upload_index !== undefined) {
      uploadedFiles = uploadedFiles.filter((_, i) => i !== att.upload_index);
      let counter = 0;
      attachments = attachments
        .filter((_, i) => i !== idx)
        .map((a) =>
          a.type === 'upload' ? { ...a, upload_index: counter++ } : a
        );
    } else {
      attachments = attachments.filter((_, i) => i !== idx);
    }
  }

  async function handleSend() {
    // Commit any uncommitted typed addresses (user may have typed without pressing Enter/comma)
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
      const formData = new FormData();
      const currentBodyHtml = bodyEditor?.getHtml() ?? bodyHtml;
      const signatureRaw = signatureFrame?.contentDocument?.body?.innerHTML ?? signatureHtml;
      const currentSignatureHtml = DOMPurify.sanitize(
        signatureRaw,
        {
          ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'td', 'th', 'img'],
          ADD_ATTR: ['width', 'height', 'cellpadding', 'cellspacing', 'border', 'bgcolor', 'align', 'valign', 'colspan', 'rowspan', 'style', 'src', 'href', 'target', 'alt'],
        }
      );
      formData.append(
        'draft_json',
        JSON.stringify({ to, cc, bcc: [], subject, body: currentBodyHtml, signature: currentSignatureHtml, attachments })
      );
      uploadedFiles.forEach((f) => formData.append('files', f));

      const resp = await fetch(`/api/email-drafts/${draftId}/send`, {
        method: 'POST',
        body: formData,
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

  async function handleCancel() {
    await fetch(`/api/email-drafts/${draftId}/cancel`, { method: 'POST' }).catch(() => {});
    dispatch('close', { status: 'cancelled' });
  }

  // Dropbox picker
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
          open_url: r.open_url ?? r.dropbox_url ?? '',
        };
      });
    } catch {
      toast.error('Chyba při hledání v Dropboxu');
    } finally {
      dropboxSearching = false;
    }
  }

  function addDropboxFile(file: DropboxResult) {
    const ref = file.path_display || file.path_lower;
    if (!ref) {
      toast.error('Soubor z Dropboxu nemá platnou cestu');
      return;
    }
    attachments = [...attachments, { type: 'dropbox', filename: file.name, ref }];
    showDropbox = false;
    dropboxQuery = '';
    dropboxResults = [];
  }
</script>

<!-- Overlay — bind:this teleports to document.body on mount to escape CSS containment -->
<div
  bind:this={dialogEl}
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
  class:backdrop-fade-out={dialogAnimClass === 'dialog-send-out'}
  role="dialog"
  aria-modal="true"
>
  <div
    class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col {dialogAnimClass}"
    on:animationend={onSendAnimationEnd}
  >
    <!-- Header -->
    <div
      class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700"
    >
      <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Nový e-mail</h2>
      <button
        on:click={handleCancel}
        class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
        aria-label="Zavřít"
      >×</button>
    </div>

    <!-- Scrollable body -->
    <div class="flex-1 overflow-y-auto px-6 py-5 space-y-4 text-sm">

      <!-- From (read-only) -->
      <div class="flex items-center gap-3">
        <span class="w-20 shrink-0 font-medium text-gray-600 dark:text-gray-400">Od:</span>
        <span class="text-gray-800 dark:text-gray-200">{draft.from}</span>
      </div>

      <!-- To -->
      <div class="flex items-start gap-3">
        <span class="w-20 shrink-0 font-medium text-gray-600 dark:text-gray-400 pt-1.5">Komu:</span>
        <div
          class="flex-1 flex flex-wrap gap-1 border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 min-h-[38px] focus-within:ring-2 focus-within:ring-blue-500"
        >
          {#each to as email, i}
            <span
              class="inline-flex items-center gap-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-sm rounded px-2 py-0.5"
            >
              {email}
              <button
                on:click={() => (to = to.filter((_, j) => j !== i))}
                class="hover:text-red-500">×</button
              >
            </span>
          {/each}
          <input
            bind:value={toInput}
            placeholder="email@example.com"
            class="flex-1 min-w-[150px] outline-none bg-transparent"
            on:keydown={(e) =>
              handleTagKey(e, to, (v) => (to = v), (v) => (toInput = v), toInput)}
          />
        </div>
      </div>

      <!-- CC -->
      <div class="flex items-start gap-3">
        <span class="w-20 shrink-0 font-medium text-gray-600 dark:text-gray-400 pt-1.5">Kopie:</span>
        <div
          class="flex-1 flex flex-wrap gap-1 border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 min-h-[38px] focus-within:ring-2 focus-within:ring-blue-500"
        >
          {#each cc as email, i}
            <span
              class="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm rounded px-2 py-0.5"
            >
              {email}<button
                on:click={() => (cc = cc.filter((_, j) => j !== i))}
                class="hover:text-red-500">×</button
              >
            </span>
          {/each}
          <input
            bind:value={ccInput}
            placeholder="email@example.com"
            class="flex-1 min-w-[150px] outline-none bg-transparent"
            on:keydown={(e) =>
              handleTagKey(e, cc, (v) => (cc = v), (v) => (ccInput = v), ccInput)}
          />
        </div>
      </div>

      <!-- Subject -->
      <div class="flex items-center gap-3">
        <span class="w-20 shrink-0 font-medium text-gray-600 dark:text-gray-400">Předmět:</span>
        <input
          bind:value={subject}
          class="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-transparent outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <!-- Body — Rich Text Editor -->
      <div>
        <div class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Obsah zprávy</div>
        <EmailBodyEditor
          bind:this={bodyEditor}
          initialHtml={bodyHtml}
          minHeight="120px"
        />
      </div>

      <!-- Signature — rendered inside an iframe so the parent's Tailwind/dark CSS
           cannot leak in. The iframe body is contenteditable, always light-themed,
           and only the signature's own inline styles apply. -->
      {#if signatureHtml}
        <div>
          <div class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">Podpis</div>
          <iframe
            bind:this={signatureFrame}
            srcdoc={signatureSrcdoc}
            title="Podpis"
            class="w-full border border-gray-200 dark:border-gray-700 rounded-lg bg-white"
            style="height: 120px; min-height: 48px; max-height: 160px; color-scheme: light;"
          ></iframe>
        </div>
      {/if}

    </div>

    <!-- Footer — attachments + actions always visible -->
    <div class="border-t border-gray-200 dark:border-gray-700 px-6 pt-3 pb-4 flex flex-col gap-2 shrink-0">

      <!-- Dropbox picker (expands above action row) -->
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
              <button
                on:click={() => addDropboxFile(file)}
                class="flex-1 min-w-0 text-left py-1.5 px-2"
              >
                <div class="text-xs flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                  <svg class="shrink-0" width="14" height="17" viewBox="0 0 20 24" aria-hidden="true">
                    <path d="M2 2a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2z" fill={meta.color}/>
                    <path d="M12 0v6h6" fill="white" fill-opacity="0.35"/>
                    {#if meta.label}
                      <text x="10" y="17" text-anchor="middle" fill="white"
                            font-family="Arial, sans-serif" font-weight="700"
                            font-size={meta.label.length >= 3 ? 6 : 8.5}>{meta.label}</text>
                    {/if}
                  </svg>
                  <span class="truncate flex-1 min-w-0" title={file.name}>{file.name}</span>
                  {#if file.modified}
                    <span
                      class="shrink-0 text-[10px] text-gray-500 dark:text-gray-400 tabular-nums"
                      title={file.modified}
                    >{formatModified(file.modified)}</span>
                  {/if}
                </div>
                {#if file.folder_path}
                  <div
                    class="text-[10px] text-gray-500 dark:text-gray-400 truncate pl-5"
                    title={file.folder_path}
                  >{file.folder_path}</div>
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

      <!-- Attachment chips (only when there are attachments) -->
      {#if attachments.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each attachments as att, i}
            {@const attMeta = getFileMeta(att.filename)}
            <span class="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs rounded px-2 py-1">
              <button
                on:click={() => openPreview(att)}
                class="flex items-center gap-1.5 hover:text-blue-600 dark:hover:text-blue-400 transition max-w-[160px]"
                title={att.filename}
              >
                <svg class="shrink-0" width="12" height="15" viewBox="0 0 20 24" aria-hidden="true">
                  <path d="M2 2a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2z" fill={attMeta.color}/>
                  <path d="M12 0v6h6" fill="white" fill-opacity="0.35"/>
                  {#if attMeta.label}
                    <text x="10" y="17" text-anchor="middle" fill="white"
                          font-family="Arial, sans-serif" font-weight="700"
                          font-size={attMeta.label.length >= 3 ? 6 : 8.5}>{attMeta.label}</text>
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

      <!-- Action row: add-attachment buttons left, send/cancel right -->
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Přílohy:</span>
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

        <div class="flex-1"></div>

        <button
          on:click={handleCancel}
          disabled={sending}
          class="text-sm px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          Zrušit
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

  <!-- Attachment preview overlay (inside dialogEl so it's inside the portal) -->
  {#if previewState}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="absolute inset-0 z-10 flex items-center justify-center bg-black/80"
      on:click|self={closePreview}
      on:keydown={(e) => e.key === 'Escape' && closePreview()}
    >
      <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <span class="text-sm font-medium text-gray-800 dark:text-white truncate">📎 {previewState.filename}</span>
          <button
            on:click={closePreview}
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none ml-4 shrink-0"
            aria-label="Zavřít náhled"
          >×</button>
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
            <iframe src={previewState.url} title={previewState.filename} class="w-full h-[75vh] rounded border-0" />
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

  <!-- Success badge — appears in top-right corner where animation lands -->
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
  /* Opening pop — spring scale up from slightly smaller */
  .dialog-pop-in {
    animation: dialog-pop-in 0.38s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @keyframes dialog-pop-in {
    0%   { transform: scale(0.82); opacity: 0; }
    100% { transform: scale(1);    opacity: 1; }
  }

  /* Send animation — flies to top-right corner while shrinking */
  .dialog-send-out {
    animation: dialog-send-out 0.42s cubic-bezier(0.4, 0, 0.8, 0.6) forwards;
    pointer-events: none;
  }

  @keyframes dialog-send-out {
    0%   { transform: translate(0, 0) scale(1);                      opacity: 1; }
    100% { transform: translate(calc(50vw - 2rem), calc(-48vh + 2rem)) scale(0); opacity: 0; }
  }

  /* Backdrop fades out */
  .backdrop-fade-out {
    animation: backdrop-fade-out 0.5s ease-in forwards;
  }

  @keyframes backdrop-fade-out {
    0%   { background-color: rgb(0 0 0 / 0.6); }
    100% { background-color: rgb(0 0 0 / 0); }
  }

  /* Success badge pops in */
  .badge-pop-in {
    animation: badge-pop-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @keyframes badge-pop-in {
    0%   { transform: scale(0.5) translateY(-8px); opacity: 0; }
    100% { transform: scale(1)   translateY(0);    opacity: 1; }
  }
</style>
