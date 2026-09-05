import type { EditorView } from "@codemirror/view";
import { MAX_QUOTE_LENGTH } from "../annotations";

export type FileAnnotationRequest = {
  line: number;
  endLine?: number;
  quote: string;
  x: number;
  y: number;
};

/** Tracks gutter drags outside the editor and releases listeners on teardown. */
export class FileAnnotationDrag {
  private startLine: number | null = null;
  private endLine = 1;

  constructor(
    private view: EditorView,
    private onRequest: (request: FileAnnotationRequest) => void,
    private onSelectionTooLarge: () => void,
    private events: Window = window,
  ) {}

  start(line: number, event: MouseEvent) {
    if (event.button !== 0) return false;
    this.destroy();
    event.preventDefault();
    this.startLine = line;
    this.endLine = line;
    this.select();
    this.events.addEventListener("mousemove", this.move);
    this.events.addEventListener("mouseup", this.finish);
    this.events.addEventListener("blur", this.cancel);
    this.events.addEventListener("keydown", this.onKey, true);
    return true;
  }

  private select() {
    if (this.startLine === null) return;
    const doc = this.view.state.doc;
    this.view.dispatch({
      selection: {
        anchor: doc.line(Math.min(this.startLine, this.endLine)).from,
        head: doc.line(Math.max(this.startLine, this.endLine)).to,
      },
    });
  }

  private updateEndLine(event: MouseEvent) {
    const block = this.view.lineBlockAtHeight(
      Math.max(0, event.clientY - this.view.documentTop),
    );
    this.endLine = this.view.state.doc.lineAt(block.from).number;
    this.select();
  }

  private move = (event: MouseEvent) => {
    if (!(event.buttons & 1)) {
      this.destroy();
      return;
    }
    event.preventDefault();
    this.updateEndLine(event);
  };

  private finish = (event: MouseEvent) => {
    if (event.button !== 0 || this.startLine === null) return;
    this.updateEndLine(event);
    const line = Math.min(this.startLine, this.endLine);
    const endLine = Math.max(this.startLine, this.endLine);
    const doc = this.view.state.doc;
    const from = doc.line(line).from;
    const to = doc.line(endLine).to;
    if (to - from > MAX_QUOTE_LENGTH) {
      this.destroy();
      this.onSelectionTooLarge();
      return;
    }
    const request: FileAnnotationRequest = {
      line,
      ...(endLine === line ? {} : { endLine }),
      quote: doc.sliceString(from, to),
      x: event.clientX + 6,
      y: event.clientY + 8,
    };
    this.destroy();
    this.onRequest(request);
  };

  private cancel = () => this.destroy();

  private onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.destroy();
  };

  destroy() {
    this.startLine = null;
    this.events.removeEventListener("mousemove", this.move);
    this.events.removeEventListener("mouseup", this.finish);
    this.events.removeEventListener("blur", this.cancel);
    this.events.removeEventListener("keydown", this.onKey, true);
  }
}
