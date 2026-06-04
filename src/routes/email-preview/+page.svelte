<script lang="ts">
  import { onMount } from 'svelte';
  import DOMPurify from 'dompurify';

  type SignatureMap = Record<string, { sender: string; signature_html: string }>;

  let signatures: SignatureMap = {};
  let selectedSender = '';
  let bodyHtml = '<p>Dobrý den,</p><p>zasíláme Vám naší aktuální nabídku produktů.</p><p>S pozdravem</p>';
  let loadError = '';

  onMount(async () => {
    try {
      const resp = await fetch('/api/email-signatures');
      if (resp.ok) {
        signatures = await resp.json();
        const senders = Object.keys(signatures);
        if (senders.length > 0) selectedSender = senders[0];
      } else {
        loadError = `Podpisy nelze načíst (HTTP ${resp.status}). Spusťte stack a přejděte na /email-preview.`;
      }
    } catch {
      loadError = 'Chyba při načítání podpisů — je stack spuštěný?';
    }
  });

  $: currentSignature = signatures[selectedSender]?.signature_html ?? '';

  $: previewHtml = buildPreviewHtml(bodyHtml, currentSignature);

  function buildPreviewHtml(body: string, sig: string): string {
    const sep = sig
      ? `<br><hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0;">${sig}`
      : '';
    const combined = `${body}${sep}`;
    return DOMPurify.sanitize(combined, {
      ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'td', 'th', 'img'],
      ADD_ATTR: [
        'width', 'height', 'cellpadding', 'cellspacing', 'border',
        'bgcolor', 'align', 'valign', 'colspan', 'rowspan',
        'style', 'src', 'href', 'target', 'alt'
      ],
    });
  }

  const exampleKorenovkyBody = `<p>Dobrý den,</p>
<p>děkujeme za Váš zájem o naše produkty. V příloze zasíláme aktuální ceník.</p>
<ul>
  <li>Dýňový olej za studena lisovaný — 350 Kč / 250 ml</li>
  <li>Jablečný ocet z BIO jablek — 180 Kč / 500 ml</li>
</ul>
<p>V případě dotazů nás neváhejte kontaktovat.</p>`;
</script>

<svelte:head>
  <title>Email Preview — Dev Tool</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 p-6">
  <div class="max-w-6xl mx-auto">
    <h1 class="text-2xl font-bold text-gray-900 mb-1">Email Preview</h1>
    <p class="text-sm text-gray-500 mb-6">Dev nástroj pro náhled vygenerovaných emailů s podpisy.</p>

    {#if loadError}
      <div class="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg px-4 py-3 mb-4 text-sm">
        ⚠️ {loadError}
      </div>
    {/if}

    <div class="grid grid-cols-2 gap-6">
      <!-- Left: Controls -->
      <div class="space-y-4">
        <!-- Sender selector -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Odesílatel</label>
          <select
            bind:value={selectedSender}
            class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
          >
            {#each Object.keys(signatures) as sender}
              <option value={sender}>{sender}</option>
            {/each}
            {#if Object.keys(signatures).length === 0}
              <option value="">— Stack není spuštěný —</option>
            {/if}
          </select>
        </div>

        <!-- Body HTML editor -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Tělo emailu (HTML)
          </label>
          <textarea
            bind:value={bodyHtml}
            rows="14"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono bg-white resize-y"
            placeholder="<p>Vložte HTML tělo emailu...</p>"
          />
        </div>

        <!-- Quickload buttons -->
        <div class="flex gap-2 flex-wrap">
          <button
            on:click={() => (bodyHtml = exampleKorenovkyBody)}
            class="text-xs px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50"
          >
            Načíst příklad Korenovky
          </button>
          <button
            on:click={() => (bodyHtml = '')}
            class="text-xs px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 text-red-600"
          >
            Vymazat
          </button>
        </div>

        <!-- Signature HTML (read-only display) -->
        {#if currentSignature}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Podpis — zdrojový HTML
              <span class="font-normal text-gray-400 text-xs">({selectedSender})</span>
            </label>
            <textarea
              value={currentSignature}
              readonly
              rows="6"
              class="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono bg-gray-50 resize-y text-gray-500"
            />
          </div>
        {/if}
      </div>

      <!-- Right: Preview -->
      <div>
        <div class="text-sm font-medium text-gray-700 mb-1">Náhled emailu</div>
        <div
          class="border border-gray-200 rounded-lg bg-white p-4 overflow-auto"
          style="min-height: 500px; max-height: 80vh;"
        >
          <div class="text-xs text-gray-400 mb-3 pb-2 border-b border-gray-100">
            Od: {selectedSender || '—'} &nbsp;·&nbsp; Komu: recipient@example.com
          </div>
          <div class="email-preview-body">
            {@html previewHtml}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .email-preview-body :global(table) {
    border-collapse: collapse;
  }
  .email-preview-body :global(img) {
    max-width: 100%;
  }
  .email-preview-body :global(a) {
    color: #4a7c3f;
  }
</style>
