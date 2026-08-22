export type DialogKeyAction = "close" | "contain" | "native";

export function dialogKeyAction(
  key: string,
  focusInsideDialog: boolean,
): DialogKeyAction {
  if (key === "Escape") return "close";
  return focusInsideDialog ? "native" : "contain";
}
