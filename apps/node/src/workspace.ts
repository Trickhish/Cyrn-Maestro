import { realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep, dirname, relative } from "node:path";

/* Path containment.
 *
 * The node does not trust the server. The server builds paths from text a
 * model produced, and a model will happily emit "../../.ssh/id_rsa" or an
 * absolute path. This is the last check before a real filesystem call, and it
 * is deliberately the node's job rather than the server's: the machine that
 * owns the files is the one that decides what may be touched.
 *
 * Symlinks are the subtle part. A path can be textually inside the workspace
 * and still resolve outside it, so containment is checked after resolution —
 * and for a file that does not exist yet, against its nearest existing parent,
 * because you cannot realpath something that is not there. */

export class PathEscape extends Error {
  constructor(readonly attempted: string) {
    super(`Path is outside the workspace: ${attempted}`);
    this.name = "PathEscape";
  }
}

export class Workspace {
  private constructor(readonly root: string) {}

  static async open(path: string): Promise<Workspace> {
    if (!existsSync(path)) {
      throw new Error(`Workspace path does not exist: ${path}`);
    }
    /* Resolve the root once so every later comparison is symlink-free on both
       sides. On macOS /tmp is itself a symlink, which would otherwise make
       every containment check fail. */
    return new Workspace(await realpath(resolve(path)));
  }

  /* Resolves a caller-supplied path to an absolute one inside the workspace,
     or throws. `mustExist` is false for writes, where the file is about to be
     created but its parent directory must already be contained. */
  async resolve(input: string, { mustExist = false } = {}): Promise<string> {
    if (input.includes("\0")) throw new PathEscape(input);

    /* An absolute path is only acceptable if it is already inside the root.
       Rejecting outright would break legitimate echoes of a path we handed the
       model in an earlier tool result. */
    const candidate = isAbsolute(input) ? resolve(input) : resolve(join(this.root, input));

    const existing = await this.nearestExisting(candidate);
    const realExisting = await realpath(existing);

    if (!this.contains(realExisting)) throw new PathEscape(input);

    if (existing === candidate) {
      if (mustExist && !existsSync(candidate)) throw new Error(`No such file: ${input}`);
      /* The path itself exists and resolved inside — use the resolved form so
         callers never operate on the symlinked alias. */
      return realExisting;
    }

    if (mustExist) throw new Error(`No such file: ${input}`);

    /* The tail does not exist yet. Its nearest existing ancestor is contained,
       so re-attach the remainder to the resolved ancestor. */
    const tail = relative(existing, candidate);
    const target = resolve(join(realExisting, tail));
    if (!this.contains(target)) throw new PathEscape(input);
    return target;
  }

  /* Path shown to the model and the UI: relative to the root, so a transcript
     never leaks the machine's directory layout. */
  display(absolute: string): string {
    const rel = relative(this.root, absolute);
    return rel === "" ? "." : rel;
  }

  contains(absolute: string): boolean {
    if (absolute === this.root) return true;
    /* The separator matters: "/srv/maestro-evil" must not count as inside
       "/srv/maestro". */
    return absolute.startsWith(this.root + sep);
  }

  private async nearestExisting(path: string): Promise<string> {
    let current = path;
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
    return current;
  }
}
