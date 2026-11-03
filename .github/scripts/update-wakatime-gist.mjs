export function formatStats(languages) {
  if (!Array.isArray(languages)) {
    throw new Error("WakaTime response is missing language stats.");
  }

  return languages.slice(0, 5).map(({ name, percent, text }) => {
    if (typeof name !== "string" || typeof text !== "string" ||
        !Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error("WakaTime returned invalid language stats.");
    }

    const label = name.length > 10 ? `${name.slice(0, 7)}...` : name;
    const fraction = Math.floor(21 * 8 * percent / 100);
    const full = Math.floor(fraction / 8);
    const bar = full >= 21
      ? "█".repeat(21)
      : (`${"█".repeat(full)}${"░▏▎▍▌▋▊▉█"[fraction % 8]}`).padEnd(21, "░");

    return [label.padEnd(10), text.padEnd(14), bar, `${percent.toFixed(1).padStart(5)}%`].join(" ");
  }).join("\n");
}

export async function updateGist(env = process.env, fetchImpl = fetch) {
  const secrets = {};
  for (const name of ["WAKATIME_ACCESS_TOKEN", "GH_TOKEN", "GIST_ID"]) {
    const value = env[name]?.trim();
    if (!value) {
      const hint = name === "WAKATIME_ACCESS_TOKEN"
        ? " Create an OAuth token with read_stats at https://wakatime.com/oauth; plugin API keys cannot read stats."
        : "";
      throw new Error(`Missing required secret: ${name}.${hint}`);
    }
    secrets[name] = value;
  }

  async function requestJson(service, url, options) {
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
    if (service === "WakaTime" && response.status === 202) {
      throw new Error("WakaTime stats are still being calculated (HTTP 202). Run the workflow again later; the gist was not changed.");
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = body?.error ?? body?.message;
      const detail = typeof reason === "string" ? `: ${reason}` : "";
      const hint = service === "WakaTime" && [401, 403].includes(response.status)
        ? " Check WAKATIME_ACCESS_TOKEN: stats require a valid OAuth token with the read_stats scope, not a plugin API key."
        : "";
      throw new Error(`${service} API returned HTTP ${response.status}${detail}.${hint}`);
    }
    if (!body) {
      throw new Error(`${service} API returned an invalid JSON response.`);
    }
    return body;
  }

  try {
    const stats = await requestJson("WakaTime", "https://wakatime.com/api/v1/users/current/stats/last_7_days", {
      headers: {
        Authorization: `Bearer ${secrets.WAKATIME_ACCESS_TOKEN}`,
        Accept: "application/json",
        "User-Agent": "ahaooahaz-wakatime-gist"
      }
    });
    const content = formatStats(stats.data?.languages);
    if (!content) {
      console.log("No language stats available; leaving the gist unchanged.");
      return;
    }

    const gistUrl = `https://api.github.com/gists/${encodeURIComponent(secrets.GIST_ID)}`;
    const headers = {
      Authorization: `Bearer ${secrets.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ahaooahaz-wakatime-gist"
    };
    const gist = await requestJson("GitHub", gistUrl, { headers });
    const filename = Object.keys(gist.files ?? {})[0];
    if (!filename) {
      throw new Error("The target gist does not contain a file to update.");
    }

    await requestJson("GitHub", gistUrl, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        files: {
          [filename]: { filename: "📊 Weekly development breakdown", content }
        }
      })
    });
    console.log("Updated gist with the last 7 days of WakaTime stats.");
  } catch (error) {
    // Never dump request objects or tokens into the Actions log.
    let message = error.message ?? String(error);
    for (const value of Object.values(secrets)) {
      message = message.replaceAll(value, "[REDACTED]");
    }
    throw new Error(message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000));
  }
}

if (import.meta.main) {
  updateGist().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
