import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  bindHost,
  clientHost,
  extraAllowedHosts,
  hostForUrl,
  IPV6_LOOPBACK_HOST,
  isWildcardHost,
  LOOPBACK_HOST,
  linkHost,
  resolveConcreteListenHosts,
  resolveListenHosts,
  sanitizeListenHosts,
  stateId,
} from "../src/paths.js";

test("bindHost defaults to loopback and honors LAVISH_AXI_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ LAVISH_AXI_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("isWildcardHost recognizes every spelling of an all-interfaces address", () => {
  for (const host of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]", "::ffff:0.0.0.0", " :: "]) {
    assert.equal(isWildcardHost(host), true, host);
  }
  for (const host of ["127.0.0.1", "::1", "[::1]", "100.64.0.1", "host.example", "", undefined, null]) {
    assert.equal(isWildcardHost(host), false, String(host));
  }
});

test("resolveListenHosts always includes loopback and never a wildcard", () => {
  assert.deepEqual(resolveListenHosts({ env: {} }), [LOOPBACK_HOST]);
  assert.deepEqual(resolveListenHosts({ env: { LAVISH_AXI_HOST: "100.64.0.1" } }), ["100.64.0.1", LOOPBACK_HOST]);
  assert.deepEqual(resolveListenHosts({ env: { LAVISH_AXI_HOST: "0.0.0.0" } }), [LOOPBACK_HOST]);
  assert.deepEqual(resolveListenHosts({ env: { LAVISH_AXI_HOST: "::" } }), [LOOPBACK_HOST]);
  assert.deepEqual(resolveListenHosts({ env: {}, extraHosts: ["::1", "0.0.0.0", "::1"] }), [LOOPBACK_HOST, "::1"]);
  // A detected tailnet address is added only when LAVISH_AXI_HOST is unset.
  const tailscale = { ipv4: "100.64.0.9" };
  assert.deepEqual(resolveListenHosts({ env: {}, tailscale }), [LOOPBACK_HOST, "100.64.0.9"]);
  assert.deepEqual(resolveListenHosts({ env: { LAVISH_AXI_HOST: "::1" }, tailscale }), ["::1", LOOPBACK_HOST]);
});

test("sanitizeListenHosts drops blanks, wildcards and duplicates and falls back to loopback", () => {
  assert.deepEqual(sanitizeListenHosts(["", " ", "0.0.0.0", "::"]), [LOOPBACK_HOST]);
  assert.deepEqual(sanitizeListenHosts([" ::1 ", "::1", "100.64.0.1"]), ["::1", "100.64.0.1"]);
  assert.deepEqual(sanitizeListenHosts(undefined), [LOOPBACK_HOST]);
});

test("resolveConcreteListenHosts resolves names, refuses wildcards, and can keep unresolved names", async () => {
  const lookup = /** @type {any} */ (
    async (host) => {
      if (host === "wild.example") return [{ address: "0.0.0.0", family: 4 }];
      if (host === "gone.example") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      if (host === "box.example") return [{ address: "100.64.0.1", family: 4 }];
      return [{ address: host, family: host.includes(":") ? 6 : 4 }];
    }
  );
  assert.deepEqual(await resolveConcreteListenHosts(["127.0.0.1", "box.example", "100.64.0.1"], { lookup }), [
    "127.0.0.1",
    "100.64.0.1",
  ]);
  await assert.rejects(resolveConcreteListenHosts(["wild.example"], { lookup }), /all-interfaces/);
  await assert.rejects(resolveConcreteListenHosts(["gone.example"], { lookup }), /ENOTFOUND/);
  assert.deepEqual(await resolveConcreteListenHosts(["gone.example", "127.0.0.1"], { lookup, keepUnresolved: true }), [
    "gone.example",
    "127.0.0.1",
  ]);
});

test("clientHost dials the concrete primary listener, which is loopback for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  // A wildcard IPv6 bind is reduced to the IPv4 loopback listener, which is what the server binds.
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "[::]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: IPV6_LOOPBACK_HOST }), IPV6_LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers LAVISH_AXI_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "0.0.0.0", LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  // Wildcard bind with no explicit link host -> links use the concrete loopback listener.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
});

test("stateId identifies an installation by its state file, through symlinks and relative paths", () => {
  const here = stateId(path.join(process.cwd(), "state.json"));
  assert.match(here, /^[0-9a-f]{16}$/);
  assert.equal(stateId("state.json"), here);
  assert.equal(stateId("./state.json"), here);
  assert.notEqual(stateId(path.join(process.cwd(), "other", "state.json")), here);
  // A directory that does not exist yet still has a stable identity.
  assert.equal(stateId("/nonexistent/lavish/state.json"), stateId("/nonexistent/lavish/../lavish/state.json"));
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});
