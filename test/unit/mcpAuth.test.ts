import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorMcpServer, isAuthorized, isLocalHost } from "../../src/mcpServer";

test("only the exact bearer token is accepted", () => {
  assert.equal(isAuthorized("Bearer abc123", "abc123"), true);
  assert.equal(isAuthorized("Bearer abc124", "abc123"), false);
  assert.equal(isAuthorized("abc123", "abc123"), false);
  assert.equal(isAuthorized(undefined, "abc123"), false);
  assert.equal(isAuthorized("Bearer ", ""), false);
});

test("only loopback host names are accepted", () => {
  assert.equal(isLocalHost("127.0.0.1:8791"), true);
  assert.equal(isLocalHost("localhost:8791"), true);
  assert.equal(isLocalHost("[::1]:8791"), true);
  assert.equal(isLocalHost("evil.example.com"), false);
  assert.equal(isLocalHost(undefined), false);
});

test("the running server refuses requests without the token", async () => {
  const server = new EditorMcpServer({} as any);
  const port = await server.start(0);
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const anon = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body });
    assert.equal(anon.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body });
    assert.equal(wrong.status, 401);
    assert.equal(server.token.length, 64);
    assert.notEqual(new EditorMcpServer({} as any).token, server.token);
  } finally {
    server.stop();
  }
});
