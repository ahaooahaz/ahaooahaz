import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatStats, updateGist } from "./update-wakatime-gist.mjs";

const env = {
  WAKATIME_ACCESS_TOKEN: "waka_tok_test-token",
  GH_TOKEN: "test-github-token",
  GIST_ID: "test-gist"
};
const language = { name: "JavaScript", percent: 100, text: "1 hr" };
const stats = { data: { languages: [language] } };

function mockResponses(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(responses.length, "Unexpected extra API request");
    const { status = 200, body } = responses.shift();
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  };
  return { calls, fetchImpl };
}

test("keeps the original waka-box formatting and top-five limit", () => {
  assert.equal(formatStats([language]),
    ["JavaScript", "1 hr".padEnd(14), "█".repeat(21), "100.0%"].join(" "));
  assert.equal(formatStats([{ name: "LongLanguageName", percent: 0, text: "0 secs" }]),
    ["LongLan...", "0 secs".padEnd(14), "░".repeat(21), "  0.0%"].join(" "));
  assert.equal(formatStats([{ ...language, percent: 12.5 }]).split(" ").filter(Boolean).at(-2),
    `██▋${"░".repeat(18)}`);
  assert.equal(formatStats(Array(6).fill(language)).split("\n").length, 5);
  assert.equal(formatStats([]), "");
});

test("rejects missing or invalid language stats", () => {
  assert.throws(() => formatStats(undefined), /missing language stats/);
  for (const percent of [NaN, Infinity, -1, 101, "100"]) {
    assert.throws(() => formatStats([{ ...language, percent }]), /invalid language stats/);
  }
});

test("uses OAuth Bearer auth and updates the existing gist file", async () => {
  const { calls, fetchImpl } = mockResponses([
    { body: stats },
    { body: { files: { "original.txt": {} } } },
    { body: { files: {} } }
  ]);
  await updateGist({ ...env, WAKATIME_ACCESS_TOKEN: ` ${env.WAKATIME_ACCESS_TOKEN}\n` }, fetchImpl);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://wakatime.com/api/v1/users/current/stats/last_7_days");
  assert.equal(calls[0].headers.Authorization, `Bearer ${env.WAKATIME_ACCESS_TOKEN}`);
  assert.equal(calls[0].headers["User-Agent"], "ahaooahaz-wakatime-gist");
  assert.equal(calls[1].url, "https://api.github.com/gists/test-gist");
  assert.equal(calls[1].headers.Authorization, `Bearer ${env.GH_TOKEN}`);
  assert.equal(calls[2].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[2].body), {
    files: {
      "original.txt": {
        filename: "📊 Weekly development breakdown",
        content: formatStats([language])
      }
    }
  });
  for (const call of calls) {
    assert.equal(call.redirect, "error");
    assert.ok(call.signal instanceof AbortSignal);
  }
});

test("requires all secrets before making requests; an old API key is not a fallback", async () => {
  for (const name of Object.keys(env)) {
    const missing = { ...env, [name]: " ", WAKATIME_API_KEY: "old-plugin-api-key" };
    await assert.rejects(updateGist(missing, () => assert.fail("Must not send a request")),
      error => error.message.includes(`Missing required secret: ${name}`));
  }
});

test("reports WakaTime 401/403 with OAuth guidance without calling GitHub", async () => {
  for (const status of [401, 403]) {
    const reason = "API Key authentication is only allowed for supported plugin endpoints.";
    const { calls, fetchImpl } = mockResponses([{ status, body: { error: reason } }]);
    await assert.rejects(updateGist(env, fetchImpl), error => {
      assert.ok(error.message.includes(`WakaTime API returned HTTP ${status}`));
      assert.ok(error.message.includes(reason));
      assert.match(error.message, /OAuth token.*read_stats/);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("does not overwrite the gist while stats are being calculated (202)", async () => {
  const { calls, fetchImpl } = mockResponses([{ status: 202, body: {} }]);
  await assert.rejects(updateGist(env, fetchImpl), /still being calculated.*HTTP 202/);
  assert.equal(calls.length, 1);
});

test("leaves the gist unchanged when language stats are empty", async () => {
  const { calls, fetchImpl } = mockResponses([{ body: { data: { languages: [] } } }]);
  await updateGist(env, fetchImpl);
  assert.equal(calls.length, 1);
});

test("fails safely on malformed stats and non-JSON responses", async () => {
  const { calls, fetchImpl } = mockResponses([{ body: { data: {} } }]);
  await assert.rejects(updateGist(env, fetchImpl), /missing language stats/);
  assert.equal(calls.length, 1);
  await assert.rejects(updateGist(env, async () => new Response("<html>not JSON</html>")),
    /invalid JSON response/);
});

test("reports GitHub read errors and does not try to update a gist without files", async () => {
  const forbidden = mockResponses([
    { body: stats },
    { status: 404, body: { message: "Not Found" } }
  ]);
  await assert.rejects(updateGist(env, forbidden.fetchImpl), /GitHub API returned HTTP 404: Not Found/);
  assert.equal(forbidden.calls.length, 2);

  const empty = mockResponses([{ body: stats }, { body: { files: {} } }]);
  await assert.rejects(updateGist(env, empty.fetchImpl), /does not contain a file/);
  assert.equal(empty.calls.length, 2);
});

test("propagates gist update failures rather than silently succeeding", async () => {
  const { fetchImpl } = mockResponses([
    { body: stats },
    { body: { files: { "original.txt": {} } } },
    { status: 403, body: { message: "Resource not accessible by personal access token" } }
  ]);
  await assert.rejects(updateGist(env, fetchImpl), /GitHub API returned HTTP 403/);
});

test("redacts secrets and prevents response messages from injecting log lines", async () => {
  const { fetchImpl } = mockResponses([{
    status: 403,
    body: { error: `${env.WAKATIME_ACCESS_TOKEN}\n::warning:: ${env.GH_TOKEN}` }
  }]);
  await assert.rejects(updateGist(env, fetchImpl), error => {
    assert.ok(!error.message.includes(env.WAKATIME_ACCESS_TOKEN));
    assert.ok(!error.message.includes(env.GH_TOKEN));
    assert.ok(!error.message.includes("\n"));
    assert.ok(error.message.includes("[REDACTED]"));
    return true;
  });
});

test("the workflow entry point exits nonzero with an actionable missing-token error", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./update-wakatime-gist.mjs", import.meta.url))], {
    env: { ...process.env, WAKATIME_ACCESS_TOKEN: "", GH_TOKEN: env.GH_TOKEN, GIST_ID: env.GIST_ID },
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required secret: WAKATIME_ACCESS_TOKEN/);
  assert.match(result.stderr, /https:\/\/wakatime.com\/oauth/);
  assert.equal(result.stdout, "");
});
