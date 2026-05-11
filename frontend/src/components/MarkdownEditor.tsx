// WYSIWYG markdown editor backed by TipTap. The on-disk source of truth is
// markdown — we render markdown into the editor on mount and serialize back
// out on every change. The `tiptap-markdown` extension handles both
// directions so we don't have to maintain a turndown/marked pair ourselves.

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { useEffect, useRef } from "react";

function getMd(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}

export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
}: {
  value: string;
  onChange: (md: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}) {
  // Track the last markdown we emitted so we can distinguish "value changed
  // because we just emitted it" from "value changed because the parent set
  // it externally (agent draft, hydration of an existing skill, etc.)".
  const lastEmitted = useRef<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: { HTMLAttributes: { class: "skill-codeblock" } } }),
      Markdown.configure({ html: false, transformPastedText: true, breaks: false }),
      Placeholder.configure({
        placeholder: placeholder ?? "",
        emptyEditorClass: "is-editor-empty",
      }),
    ],
    editable: !readOnly,
    content: value,
    onUpdate: ({ editor }) => {
      const md = getMd(editor);
      lastEmitted.current = md;
      onChange(md);
    },
    editorProps: {
      attributes: {
        class: "tiptap-prose focus:outline-none min-h-[400px]",
      },
    },
  });

  // External writes (chat draft, hydration) need to land in the editor. We
  // skip the round-trip case where `value` is just our own most recent
  // emission echoed back through state.
  useEffect(() => {
    if (!editor) return;
    if (lastEmitted.current === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [readOnly, editor]);

  return <EditorContent editor={editor} />;
}
