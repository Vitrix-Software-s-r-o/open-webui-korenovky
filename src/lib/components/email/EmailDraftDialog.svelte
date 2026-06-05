<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import EmailBodyEditor from './EmailBodyEditor.svelte';

  let dialogEl: HTMLElement;

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (previewState) {
        closePreview();
      } else if (!sending) {
        handleCancel();
      }
    }
  }

  onMount(() => {
    if (dialogEl) document.body.appendChild(dialogEl);
    window.addEventListener('keydown', handleGlobalKeydown);
  });

  onDestroy(() => {
    if (dialogEl?.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    window.removeEventListener('keydown', handleGlobalKeydown);
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
  let dropboxResults: Array<{ name: string; path_lower: string }> = [];
  let dropboxSearching = false;

  async function searchDropbox() {
    if (!dropboxQuery.trim()) return;
    dropboxSearching = true;
    try {
      const resp = await fetch(`/api/dropbox-search?q=${encodeURIComponent(dropboxQuery)}`);
      const data = await resp.json();
      dropboxResults = (data.results ?? []).map((r: any) => ({
        name: r.name ?? r.filename ?? r.path?.split('/').pop() ?? 'file',
        path_lower: r.path ?? r.path_lower ?? '',
      }));
    } catch {
      toast.error('Chyba při hledání v Dropboxu');
    } finally {
      dropboxSearching = false;
    }
  }

  function addDropboxFile(file: { name: string; path_lower: string }) {
    attachments = [...attachments, { type: 'dropbox', filename: file.name, ref: file.path_lower }];
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
          {#each dropboxResults as file}
            <button
              on:click={() => addDropboxFile(file)}
              class="w-full text-left text-xs py-1 px-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
            >
              📄 {file.name}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Attachment chips (only when there are attachments) -->
      {#if attachments.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each attachments as att, i}
            <span class="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs rounded px-2 py-1">
              <button
                on:click={() => openPreview(att)}
                class="flex items-center gap-1 hover:text-blue-600 dark:hover:text-blue-400 transition max-w-[160px]"
                title="Zobrazit náhled"
              >
                📎 <span class="truncate">{att.filename}</span>
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
          on:click={() => (showDropbox = !showDropbox)}
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
