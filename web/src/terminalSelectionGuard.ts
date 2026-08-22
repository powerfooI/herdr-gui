/**
 * xterm arms document-level mousemove/mouseup listeners on every left
 * mousedown to track a selection drag, and only disarms them on mouseup. When
 * the release is swallowed (released outside the window, or the browser drops
 * the mouseup after the mousedown target was re-rendered mid-gesture), those
 * listeners stay armed and every later move keeps extending the selection
 * without a button pressed.
 *
 * This guard mirrors the gesture with its own tracking and reports when a
 * button-less move means the release was lost, so the caller can dispatch a
 * synthetic mouseup to finalize the drag.
 */
export class TerminalSelectionDragGuard {
  private dragActive = false;

  /** Left button pressed inside the terminal: start watching the gesture. */
  mouseDown(button: number): void {
    if (button === 0) this.dragActive = true;
  }

  /** Any real release ends the gesture. */
  mouseUp(): void {
    this.dragActive = false;
  }

  /**
   * A move with no button held while the drag never saw its release means the
   * mouseup was lost. Returns true once per lost release.
   */
  mouseMoveNeedsRelease(buttons: number): boolean {
    if (!this.dragActive || buttons !== 0) return false;
    this.dragActive = false;
    return true;
  }

  reset(): void {
    this.dragActive = false;
  }
}
