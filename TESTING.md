# Testing

```bash
bun test                     # everything, from the repo root
bun test src/lib/crypto      # one file or directory
bun test --watch             # while working
```

Tests live next to the code they cover as `*.test.ts`. `bun test` from the root
walks every workspace, so a new package is picked up without configuration.

## What gets a test

A feature is not done until the thing that would break it silently is covered.
In practice that means:

- **Boundaries between the three deployables.** The protocol schemas are the
  only contract the server, the node and the web app share; a change that
  breaks one of them fails at runtime, in production, on a socket frame. Those
  get tests first.
- **Security properties.** Not "does login work" but "does a wrong password
  fail", "does an instance admin stay out of another user's project", "does a
  tampered ciphertext throw instead of decrypting to garbage", "does a path
  escape the workspace". These are the assertions that are cheap now and
  archaeology later.
- **Anything with a rule I had to think about.** Sequence numbers being
  gap-free, tokens being single-use, output truncation reporting the true size.

## What does not

Rendering. Layout. Whether a token file has the right hex value. Those are
verified by looking at the screen, and a snapshot test of them would only ever
fail for reasons nobody wants to read.

## Conventions

- Test names read as claims: `an instance admin gets no access to another
  user's work`, not `test can()`.
- A test that only restates the implementation is worse than no test. If the
  assertion is `expect(add(1,2)).toBe(3)` on a function that returns `a+b`,
  delete it.
- Where a test guards something non-obvious, say why in a comment. The next
  person to see it fail needs to know whether it is protecting something or
  just being brittle.
- Tests touching the database use their own file under `data/` and clean up
  after themselves. Never the dev database.
