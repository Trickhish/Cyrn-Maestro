# Maestro — UI design brief

An orchestration console for AI coding agents. We need a visual and interaction direction for the app. This is what it does, and what has to stay true whatever the direction.

Self-hosted web app · desktop-first, mobile supervision · React + Tailwind + shadcn/ui

---

## 1. What Maestro is

Maestro runs AI coding agents on your own machines. You describe a task; Maestro decides which machine and which model should handle it, then runs it while you watch — the agent reads files, edits them, runs commands, and you can interrupt or redirect at any point.

Everything is organised in **projects** (a codebase, its machines, its history), owned either by a person or by a team.

**Who uses it:** developers and tech leads who today run a single coding agent in a terminal, and want to run ten of them across several machines without losing track of any one.

## 2. The problem

A terminal coding agent is an intimate thing: one conversation, one machine, your full attention. Maestro breaks that assumption — and attention becomes the scarce resource, not compute.

Our structural answer, which the design needs to express: **a task is a conversation**, and one central chat — **the Conductor** — is the conversation *about* all of them. You drop into a thread when you want to be in the room with one agent; you ask the Conductor when you want the whole picture.

The design problem in one sentence: *make a screen where six agents are working feel calm and legible, rather than like a surveillance wall.*

## 3. What to design, in priority order

1. **Task thread** — the core screen. A live conversation with one agent: messages, collapsed tool calls, streaming command output, inline diffs, a status line, and an input you can type into while it is still working.
2. **The Conductor** — the central chat with the system itself. Answers "what's running?", dispatches work into any project, and embeds live task cards that stream in place and open into their own thread.
3. **Project home** — where you land. A composer at the top, live tasks streaming below it, recent ones under that.
4. **Supporting** — inbox (approvals queue), fleet (machines table), providers (accounts, quota, spend), access & settings.

Our working assumption for the shell, not a requirement:

```
┌──────────┬──────────────────────────────────────┬─────────────┐
│ RAIL     │ CONVERSATION                         │ DETAIL      │
│          │                                      │             │
│ Conductor│ "the auth test is flaky in CI"       │ diff        │
│ Inbox  ³ │                                      │ terminal    │
│          │ ⏺ Read  src/auth/session.ts          │ files       │
│ projects │ ⏺ Edit  session.ts        +12 −4     │             │
│          │ ⏺ Bash  bun test auth                │ 3 files     │
│ fleet    │                                      │ +48 −12     │
│ providers│ ⣾ running · 41s · $0.12 · opus-5     │             │
└──────────┴──────────────────────────────────────┴─────────────┘
```

Challenge it if you have a better structure — the conversation being the primary surface is the part that matters.

## 4. Behaviours that must survive any direction

These come from watching people work with agents. Any visual direction has to accommodate all of them.

- **The input stays alive while the agent works.** Steering a run without stopping it is the single biggest quality-of-life difference between a toy and a tool.
- **Approvals are inline in the thread, never modals.** When an agent asks permission to run a risky command, it lands where it happened. Several can be pending at once, across different projects.
- **Tool calls are one-line summaries that expand.** Long output collapses to its tail. A thread must stay readable after two hundred actions.
- **A live status line** — what it's doing now, elapsed, cost so far, which machine, which model.
- **Provenance is visible.** Model and machine are shown per turn, because Maestro can switch either mid-task.
- **The router shows its work before it acts,** not after — what it *would* pick, each one click to override.
- **No spinner without a subject.** Every waiting state names what it is waiting for.

## 5. Constraints and character

| | |
| --- | --- |
| **Density** | This sits open beside an editor for hours. Dense and quiet beats airy and friendly. It should look like an instrument. |
| **Themes** | Dark first, light fully supported. Not an inversion — both need to hold up. |
| **Two registers** | Machine output (paths, commands, diffs, logs) must be instantly distinguishable from prose the model wrote. Typography is the obvious lever. |
| **Colour is status** | Colour means running, needs-you, failed, done. If it also decorates, there is nothing left to signal with. |
| **Keyboard-first** | A command palette and shortcuts are assumed, not an afterthought. Design the focus states. |
| **Mobile is supervision** | Watch a run, read a diff, approve or deny, reply briefly. Not for authoring. |

## 6. Deliverables and scope

**Round one:** two or three directions, low fidelity, covering the task thread and the Conductor only. We pick one, then extend to project home and the supporting screens.

**Format:** Figma. Desktop 1440 and mobile 390. Dark and light. Show the states that matter — idle, running, blocked on approval, failed — and hand over colour and type tokens we can give to engineering.

**Out of scope:** marketing site, logo and wordmark, illustration, onboarding. Propose a mark if you feel strongly, but it is not what we're buying.

**Useful reference points:** Linear for density and keyboard-first feel, Warp for making terminal output legible, Claude Code for the thread itself, Sentry and Vercel for status at a glance. Deliberately *not*: chat UIs built from big rounded bubbles, or ops dashboards that tile a dozen panes.

## 7. Questions we'd like your view on

- **How should a live task card behave inside the Conductor?** It has to convey progress without turning the chat into a scrolling log of six agents at once.
- **How do ten machines' worth of activity show up in the rail?** A badge per project stops scaling somewhere around five.
- **Where does diff review belong — side panel, full screen, or its own mode?** Reviewing what an agent changed is the second most common thing users do, after reading the thread.

---

*Fuller technical spec available on request — ask for the README.*
