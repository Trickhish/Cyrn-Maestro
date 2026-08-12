import type { View } from "../components/Rail";

/* The URL is the view. A task thread is the thing people paste to each other,
   so it has to survive a reload and a copied link — and the back button should
   do what it looks like it does. */

export function viewFromHash(hash: string): View | undefined {
  const path = hash.replace(/^#\/?/, "");
  const [kind, id] = path.split("/");

  if (kind === "t" && id) return { name: "task", taskId: id };
  if (kind === "p" && id) return { name: "project", projectId: id };
  if (kind === "conductor") return { name: "conductor" };
  if (kind === "fleet") return { name: "fleet" };
  return undefined;
}

export function hashFor(view: View): string {
  switch (view.name) {
    case "task":
      return `#/t/${view.taskId}`;
    case "project":
      return `#/p/${view.projectId}`;
    case "conductor":
      return "#/conductor";
    case "fleet":
      return "#/fleet";
  }
}
