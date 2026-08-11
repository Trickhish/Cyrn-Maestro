/* Fixture data for the round-one demo.
   Every string here comes from the design doc, so the screens read as one
   coherent afternoon of work rather than lorem. When the socket layer lands,
   this module is what gets replaced — nothing else should need to change. */

export type TaskState = "running" | "needs-you" | "idle" | "done" | "offline";

export interface Project {
  id: string;
  name: string;
  state: TaskState;
  running?: number;
}

export const projects: Project[] = [
  { id: "maestro-web", name: "maestro-web", state: "running", running: 2 },
  { id: "auster-api", name: "auster-api", state: "needs-you", running: 3 },
  { id: "infra", name: "infra", state: "running", running: 1 },
  { id: "design-tokens", name: "design-tokens", state: "idle" },
  { id: "billing-svc", name: "billing-svc", state: "idle" },
];

export const moreProjects = 7;

export interface ToolCall {
  id: string;
  name: "Read" | "Grep" | "Edit" | "Bash" | "Write";
  target: string;
  meta?: string;
  added?: number;
  removed?: number;
  detail?: string[];
}

export const toolCalls: ToolCall[] = [
  {
    id: "t1",
    name: "Read",
    target: "src/auth/__tests__/session.test.ts",
    meta: "148 lines",
    detail: [
      "describe('session', () => {",
      "  it('refreshes before expiry', async () => {",
      "    const s = makeSession({ ttl: 100 })",
      "    await sleep(90)",
      "    expect(isExpired(s)).toBe(false)",
      "  })",
    ],
  },
  {
    id: "t2",
    name: "Read",
    target: "src/auth/session.ts",
    meta: "92 lines",
    detail: [
      "export function isExpired(s: Session) {",
      "  const now = Date.now()",
      "  return s.cachedNow < now - TTL",
      "}",
    ],
  },
  {
    id: "t3",
    name: "Grep",
    target: "Date.now|setTimeout",
    meta: "6 matches",
    detail: [
      "src/auth/session.ts:42       const now = Date.now()",
      "src/auth/session.ts:58       setTimeout(refresh, TTL / 2)",
      "src/auth/clock.ts:9          return Date.now()",
      "…3 more",
    ],
  },
  {
    id: "t4",
    name: "Edit",
    target: "src/auth/session.ts",
    added: 12,
    removed: 4,
    detail: ["Replaced the ambient clock with an injected one.", "2 hunks written, 1 pending."],
  },
];

export const bashStream = {
  command: "bun test src/auth",
  tail: [
    "(pass) session · refreshes before expiry [4.11ms]",
    "(pass) session · rejects a revoked token [1.02ms]",
    "(pass) session · survives a slow clock [12.40ms]",
    "(pass) session · concurrent refresh is idempotent [8.90ms]",
  ],
  totalLines: 214,
};

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export const changedFiles: ChangedFile[] = [
  { path: "src/auth/session.ts", added: 12, removed: 4 },
  { path: "src/auth/__tests__/session.test.ts", added: 31, removed: 6 },
  { path: "src/auth/clock.ts", added: 5, removed: 2 },
];

export type DiffKind = "ctx" | "add" | "del" | "hunk";

export interface DiffRow {
  kind: DiffKind;
  num?: number;
  text: string;
}

export const diff: DiffRow[] = [
  { kind: "hunk", text: "@@ -41,9 +41,17 @@ export function isExpired" },
  { kind: "ctx", num: 41, text: "export function isExpired(s: Session) {" },
  { kind: "del", num: 42, text: "-  const now = Date.now()" },
  { kind: "del", num: 43, text: "-  return s.cachedNow < now - TTL" },
  { kind: "add", num: 42, text: "+  const now = s.clock.now()" },
  { kind: "add", num: 43, text: "+  return now - s.issuedAt >= TTL" },
  { kind: "ctx", num: 44, text: "}" },
  { kind: "ctx", num: 45, text: "" },
  { kind: "hunk", text: "@@ -58,4 +66,12 @@ export function refresh" },
  { kind: "ctx", num: 66, text: "export async function refresh(s: Session) {" },
  { kind: "add", num: 67, text: "+  if (s.pending) return s.pending" },
  { kind: "add", num: 68, text: "+  s.pending = doRefresh(s)" },
  { kind: "add", num: 69, text: "+  try { return await s.pending }" },
  { kind: "add", num: 70, text: "+  finally { s.pending = undefined }" },
  { kind: "ctx", num: 71, text: "}" },
];

export interface LiveTask {
  id: string;
  title: string;
  project: string;
  state: TaskState;
  action: string;
  elapsed: string;
  cost?: string;
  model?: string;
  node?: string;
  progress?: number;
  added?: number;
  removed?: number;
  command?: string;
  waiting?: string;
}

export const needsYouTask: LiveTask = {
  id: "k1",
  title: "Rotate the staging DB credentials",
  project: "auster-api",
  state: "needs-you",
  action: "blocked on approval",
  elapsed: "9m",
  waiting: "needs you · 9m",
  command: 'psql -h staging -c "ALTER ROLE app …"',
};

export const runningTask: LiveTask = {
  id: "k2",
  title: "Fix flaky auth test in CI",
  project: "maestro-web",
  state: "running",
  action: "re-running bun test src/auth · 3/20",
  elapsed: "4m 41s",
  cost: "$0.12",
  model: "opus-5",
  node: "mac-studio-01",
  progress: 34,
  added: 48,
  removed: 12,
};

export interface RouterChoice {
  choice: string;
  picked: string;
  because: string;
  alternatives: string;
}

export const routerPlan: RouterChoice[] = [
  { choice: "Project", picked: "infra", because: "You named it", alternatives: "—" },
  {
    choice: "Machine",
    picked: "linux-03",
    because: "Idle, has the VPN route",
    alternatives: "linux-02 · mac-mini-04",
  },
  {
    choice: "Model",
    picked: "opus-5",
    because: "Irreversible DB change",
    alternatives: "sonnet-5 · haiku-5",
  },
  {
    choice: "Approvals",
    picked: "ask on write",
    because: "Production data in reach",
    alternatives: "ask on all · auto",
  },
];

export interface Machine {
  name: string;
  state: TaskState;
  tasks?: string;
  load?: number;
  spec: string;
  note?: string;
  routerPick?: boolean;
}

export const machines: Machine[] = [
  {
    name: "mac-studio-01",
    state: "running",
    tasks: "2 tasks",
    load: 62,
    spec: "macOS · 24 cores · load 62%",
  },
  {
    name: "linux-01",
    state: "running",
    tasks: "3 tasks",
    load: 88,
    spec: "Ubuntu 24.04 · 16 cores · load 88%",
  },
  {
    name: "linux-02",
    state: "running",
    tasks: "1 task",
    load: 24,
    spec: "Ubuntu 24.04 · 16 cores · load 24%",
  },
  {
    name: "linux-03",
    state: "idle",
    note: "router pick",
    load: 4,
    spec: "Ubuntu 24.04 · 16 cores · idle · VPN",
    routerPick: true,
  },
  { name: "mac-mini-02", state: "offline", note: "offline 2h", spec: "" },
];

export const fleet = { online: 6, total: 8, spendToday: "$4.18", idleHidden: 3 };
