import { expect, test, describe } from "bun:test";
import { resolveMcpName } from "./runner";

/* MCP tools are namespaced with a double underscore, and models routinely
 * write one: "web_tools_dns_lookup" for "web_tools__dns_lookup". The call then
 * falls through to the node, which has never heard of it and answers with its
 * own six built-in tools — so a working integration reads as a broken one. */

const tools = [
  { qualifiedName: "web_tools__dns_lookup" },
  { qualifiedName: "web_tools__http_headers" },
  { qualifiedName: "airbnb__search" },
];

describe("matching the MCP tool a call meant", () => {
  test("an exact name is used as-is", () => {
    expect(resolveMcpName("web_tools__dns_lookup", tools)).toBe("web_tools__dns_lookup");
  });

  /* The actual failure, reported from a real run. */
  test("a single underscore still finds the tool", () => {
    expect(resolveMcpName("web_tools_dns_lookup", tools)).toBe("web_tools__dns_lookup");
  });

  test("a name for no tool at all matches nothing", () => {
    expect(resolveMcpName("web_tools__nonexistent", tools)).toBeNull();
  });

  /* Node tools must keep reaching the node — they are not MCP and never were. */
  test("a built-in node tool is left alone", () => {
    expect(resolveMcpName("read_file", tools)).toBeNull();
    expect(resolveMcpName("bash", tools)).toBeNull();
  });

  /* Guessing which remote tool to run is worse than saying the name was
     wrong, so two candidates mean no match. */
  test("an ambiguous name is refused rather than guessed", () => {
    const ambiguous = [{ qualifiedName: "a__b_c" }, { qualifiedName: "a_b__c" }];
    expect(resolveMcpName("a_b_c", ambiguous)).toBeNull();
  });

  test("nothing matches when there are no MCP tools", () => {
    expect(resolveMcpName("web_tools_dns_lookup", [])).toBeNull();
  });
});
