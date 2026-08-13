/* What version of the daemon a node is running.
 *
 * One constant, imported by both sides, and that is what makes the comparison
 * trustworthy: the server bundles the node from this same source tree, so the
 * value compiled into the bundle it serves IS the value it holds in memory. A
 * node reporting something else is, by construction, running an older bundle.
 *
 * Deliberately not a hash of the built bundle: two server processes, or the
 * same source built under a different Bun, produce different hashes for
 * identical code, and every node would update in a loop. A hash is still used
 * alongside this, but only to check a download arrived intact.
 *
 * Bump when changing anything a node runs. Forgetting means the fleet page
 * will not offer an update that exists — annoying, and not dangerous. */
export const NODE_VERSION = "0.2.0";
