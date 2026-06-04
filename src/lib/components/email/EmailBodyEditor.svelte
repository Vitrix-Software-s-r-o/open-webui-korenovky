<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import Link from '@tiptap/extension-link';
  import { TableKit } from '@tiptap/extension-table';
  import { ListKit } from '@tiptap/extension-list';

  export let initialHtml: string = '';
  export let placeholder: string = 'Napište tělo zprávy...';
  export let minHeight: string = '120px';

  let editorEl: HTMLElement;
  let editor: Editor | null = null;
  // Incremented on selection/update to trigger reactive active-state recalc
  let editorVersion = 0;

  const dispatch = createEventDispatcher<{ change: string }>();

  export function getHtml(): string {
    return editor?.getHTML() ?? '';
  }

  // Comma trick: forces re-evaluation when editorVersion changes
  $: isBold       = (editorVersion, editor?.isActive('bold') ?? false);
  $: isItalic     = (editorVersion, editor?.isActive('italic') ?? false);
  $: isStrike     = (editorVersion, editor?.isActive('strike') ?? false);
  $: isBullet     = (editorVersion, editor?.isActive('bulletList') ?? false);
  $: isOrdered    = (editorVersion, editor?.isActive('orderedList') ?? false);
  $: activeStyle  = (editorVersion,
    editor?.isActive('heading', { level: 1 }) ? '1' :
    editor?.isActive('heading', { level: 2 }) ? '2' :
    editor?.isActive('heading', { level: 3 }) ? '3' : '0'
  );

  function applyStyle(value: string) {
    if (!editor) return;
    if (value === '0') editor.chain().focus().setParagraph().run();
    else editor.chain().focus().toggleHeading({ level: Number(value) as 1|2|3 }).run();
  }

  function tbBtn(action: () => void) {
    return (e: MouseEvent) => {
      e.preventDefault(); // don't steal focus from editor
      action();
    };
  }

  onMount(() => {
    editor = new Editor({
      element: editorEl,
      extensions: [
        StarterKit,
        Link.configure({ openOnClick: false, autolink: true }),
        TableKit,
        ListKit,
      ],
      content: initialHtml,
      onUpdate({ editor: ed }) {
        dispatch('change', ed.getHTML());
        editorVersion++;
      },
      onSelectionUpdate() {
        editorVersion++;
      },
    });
  });

  onDestroy(() => {
    editor?.destroy();
  });
</script>

<!-- Toolbar -->
<div class="flex items-center gap-0.5 flex-wrap border border-b-0 border-gray-200 dark:border-gray-700 rounded-t-lg px-2 py-1 bg-gray-50 dark:bg-gray-800">
  <select
    value={activeStyle}
    on:change={(e) => applyStyle((e.target as HTMLSelectElement).value)}
    class="h-7 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-300 px-1 pr-6 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer min-w-[96px]"
    title="Styl odstavce"
  >
    <option value="0">Normální</option>
    <option value="1">Nadpis 1</option>
    <option value="2">Nadpis 2</option>
    <option value="3">Nadpis 3</option>
  </select>

  <div class="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1"></div>

  <button
    type="button"
    on:mousedown={tbBtn(() => editor?.chain().focus().toggleBold().run())}
    class="w-7 h-7 rounded text-sm font-bold flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition {isBold ? 'bg-gray-200 dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}"
    title="Tučné (Ctrl+B)"
  >B</button>
  <button
    type="button"
    on:mousedown={tbBtn(() => editor?.chain().focus().toggleItalic().run())}
    class="w-7 h-7 rounded text-sm italic flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition {isItalic ? 'bg-gray-200 dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}"
    title="Kurzíva (Ctrl+I)"
  >I</button>
  <button
    type="button"
    on:mousedown={tbBtn(() => editor?.chain().focus().toggleStrike().run())}
    class="w-7 h-7 rounded text-sm line-through flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition {isStrike ? 'bg-gray-200 dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}"
    title="Přeškrtnutí"
  >S</button>

  <div class="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1"></div>

  <button
    type="button"
    on:mousedown={tbBtn(() => editor?.chain().focus().toggleBulletList().run())}
    class="w-7 h-7 rounded text-sm flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition {isBullet ? 'bg-gray-200 dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}"
    title="Odrážkový seznam"
  >
    <svg viewBox="0 0 16 16" class="size-4" fill="currentColor">
      <circle cx="2" cy="4" r="1.2"/><rect x="5" y="3.2" width="9" height="1.6" rx="0.6"/>
      <circle cx="2" cy="8" r="1.2"/><rect x="5" y="7.2" width="9" height="1.6" rx="0.6"/>
      <circle cx="2" cy="12" r="1.2"/><rect x="5" y="11.2" width="9" height="1.6" rx="0.6"/>
    </svg>
  </button>
  <button
    type="button"
    on:mousedown={tbBtn(() => editor?.chain().focus().toggleOrderedList().run())}
    class="w-7 h-7 rounded text-sm flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition {isOrdered ? 'bg-gray-200 dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}"
    title="Číslovaný seznam"
  >
    <svg viewBox="0 0 16 16" class="size-4" fill="currentColor">
      <text x="0.5" y="5" style="font-size:5px;font-weight:bold">1.</text>
      <rect x="5" y="3.2" width="9" height="1.6" rx="0.6"/>
      <text x="0.5" y="9" style="font-size:5px;font-weight:bold">2.</text>
      <rect x="5" y="7.2" width="9" height="1.6" rx="0.6"/>
      <text x="0.5" y="13" style="font-size:5px;font-weight:bold">3.</text>
      <rect x="5" y="11.2" width="9" height="1.6" rx="0.6"/>
    </svg>
  </button>

  <div class="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1"></div>

  <button
    type="button"
    on:mousedown={tbBtn(() => editor?.chain().focus().undo().run())}
    class="w-7 h-7 rounded text-sm flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition text-gray-700 dark:text-gray-300"
    title="Zpět (Ctrl+Z)"
  >↩</button>
  <button
    type="button"
    on:mousedown={tbBtn(() => editor?.chain().focus().redo().run())}
    class="w-7 h-7 rounded text-sm flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition text-gray-700 dark:text-gray-300"
    title="Znovu (Ctrl+Y)"
  >↪</button>
</div>

<!-- Editor -->
<div
  bind:this={editorEl}
  class="tiptap-email prose dark:prose-invert max-w-none w-full border border-gray-200 dark:border-gray-700 rounded-b-lg px-3 py-2 focus-within:ring-2 focus-within:ring-blue-500 bg-transparent overflow-y-auto"
  style="min-height: {minHeight};"
  data-placeholder={placeholder}
/>

<style>
  :global(.tiptap-email .ProseMirror) {
    outline: none;
    min-height: inherit;
  }

  :global(.tiptap-email .ProseMirror p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    float: left;
    color: #adb5bd;
    pointer-events: none;
    height: 0;
  }

  :global(.tiptap-email .ProseMirror > * + *) {
    margin-top: 0.5em;
  }

  :global(.tiptap-email .ProseMirror > *:first-child) {
    margin-top: 0;
  }
</style>
