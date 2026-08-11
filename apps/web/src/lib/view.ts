export type View = "thread" | "conductor";

export function viewFromHash(hash: string): View {
  return hash.replace(/^#\/?/, "") === "conductor" ? "conductor" : "thread";
}

export function hashForView(view: View): string {
  return view === "conductor" ? "#/conductor" : "#/thread";
}
