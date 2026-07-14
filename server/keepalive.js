// Free hosting tiers (Render.com) idle out a web service after ~15 minutes with
// no inbound HTTP traffic, which drops every relay socket. Pinging our own public
// URL counts as inbound traffic, so the service stays warm. Render exposes that URL
// as RENDER_EXTERNAL_URL (RENDER_EXTERNAL_HOSTNAME on older services); without it
// we are not on a host that needs this and keep-alive stays off.

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // under Render's ~15 min idle window
const HEALTH_PATH = '/healthz';

function resolveKeepAlive(env = {}) {
  const base = env.KEEPALIVE_URL || env.RENDER_EXTERNAL_URL
    || (env.RENDER_EXTERNAL_HOSTNAME && `https://${env.RENDER_EXTERNAL_HOSTNAME}`);
  if (!base) return null;

  const intervalMs = env.KEEPALIVE_INTERVAL_MS ? Number(env.KEEPALIVE_INTERVAL_MS) : DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;

  return { url: new URL(HEALTH_PATH, base).toString(), intervalMs };
}

function startSelfPing({ url, intervalMs, fetchImpl = fetch, log = () => {} }) {
  const ping = async () => {
    try {
      const res = await fetchImpl(url);
      log(`keepalive ${url} -> ${res.status}`);
    } catch (err) {
      log(`keepalive ${url} failed: ${err.message}`);
    }
  };
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  return { ping, stop: () => clearInterval(timer) };
}

module.exports = { resolveKeepAlive, startSelfPing, DEFAULT_INTERVAL_MS, HEALTH_PATH };
