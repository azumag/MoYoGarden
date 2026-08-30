const baseUrl = (process.env.MOYO_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const region = process.env.MOYO_REGION || "garden-1";
const token = process.env.MOYO_TOKEN || "";

export async function api(path, options = {}) {
  const url = new URL(path, `${baseUrl}/`);
  url.searchParams.set("region", region);
  const headers = new Headers(options.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
