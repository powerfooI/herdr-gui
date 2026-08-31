import type { EditorView } from "@codemirror/view";

/**
 * True when a keyboard or clipboard event targets a native editable element
 * outside the CodeMirror surface, where select-all and copy keep their
 * default behavior.
 */
export function isEditablePreviewTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".cm-editor")) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * True when a keyboard event comes from inside the preview or from a neutral
 * target (nothing else focused), so the preview may claim select-all.
 */
export function isPreviewKeyboardTarget(
  previewRoot: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (target instanceof Node && previewRoot.contains(target)) return true;
  return (
    target === previewRoot.ownerDocument.body ||
    target === previewRoot.ownerDocument.documentElement
  );
}

/**
 * Select the whole document in a read-only CodeMirror preview and focus the
 * content element so the selection is mirrored to the DOM and can be copied.
 */
export function selectAllInPreviewEditor(view: EditorView | null): void {
  if (!view) return;
  view.contentDOM.focus();
  view.dispatch({
    selection: { anchor: 0, head: view.state.doc.length },
    userEvent: "select",
  });
}

/** Select all rendered content of a plain-HTML preview (markdown mode). */
export function selectAllInPreviewElement(element: HTMLElement | null): void {
  if (!element) return;
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection.addRange(range);
}

/**
 * Decide the clipboard payload for a copy event inside a CodeMirror preview.
 * Returns the exact document slice (including lines outside the rendered
 * viewport) or null to keep the native copy behavior.
 */
export function previewEditorCopyText(
  docText: string,
  from: number,
  to: number,
  selectionInsideEditor: boolean,
): string | null {
  if (!selectionInsideEditor || from === to) return null;
  return docText.slice(from, to);
}

/**
 * Replace the clipboard payload of a copy event with the exact CodeMirror
 * document text when the native selection lives inside the editor content.
 * CodeMirror renders only the visible lines, so a native copy would silently
 * drop everything outside the viewport.
 */
export function handlePreviewEditorCopy(
  view: EditorView | null,
  event: ClipboardEvent,
): boolean {
  if (!view || isEditablePreviewTarget(event.target)) return false;
  const domSelection = view.contentDOM.ownerDocument.getSelection();
  const anchorNode = domSelection?.anchorNode ?? null;
  const text = previewEditorCopyText(
    view.state.doc.toString(),
    view.state.selection.main.from,
    view.state.selection.main.to,
    anchorNode !== null && view.contentDOM.contains(anchorNode),
  );
  if (text === null) return false;
  // Genuine copy events always carry clipboardData; a null value means the
  // event was synthesized, and failing loudly beats silently copying nothing.
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    throw new Error("Cannot handle a copy event without clipboardData");
  }
  clipboardData.setData("text/plain", text);
  event.preventDefault();
  return true;
}
