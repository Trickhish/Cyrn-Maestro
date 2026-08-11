import { expect, test, describe } from "bun:test";
import { can } from "./permissions";
import type { Actor } from "./auth";

const alice: Actor = { id: "alice", email: "a@x", instanceRole: "user" };
const bob: Actor = { id: "bob", email: "b@x", instanceRole: "user" };
const admin: Actor = { id: "admin", email: "c@x", instanceRole: "instance_admin" };

describe("can()", () => {
  test("the owner is allowed", () => {
    expect(can(alice, "task.run", { ownerUserId: "alice" })).toBe(true);
  });

  test("another user is not", () => {
    expect(can(bob, "task.read", { ownerUserId: "alice" })).toBe(false);
  });

  test("an anonymous caller is not", () => {
    expect(can(null, "project.read", { ownerUserId: "alice" })).toBe(false);
  });

  /* The load-bearing one. An instance admin runs the server; that is not the
     same as being able to read everyone's source code through the UI. */
  test("an instance admin gets no access to another user's work", () => {
    expect(can(admin, "task.read", { ownerUserId: "alice" })).toBe(false);
    expect(can(admin, "project.read", { ownerUserId: "alice" })).toBe(false);
  });

  test("org-owned scopes fail closed until roles exist", () => {
    expect(can(alice, "task.read", { ownerUserId: "alice", ownerOrgId: "acme" })).toBe(false);
    expect(can(admin, "task.read", { ownerOrgId: "acme" })).toBe(false);
  });

  test("an unowned row is reachable by nobody", () => {
    expect(can(alice, "task.read", { ownerUserId: null })).toBe(false);
  });
});
