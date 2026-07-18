// The machine-wide list of running IDE windows, so a phone can see all of them and
// pick the one it wants to drive.
//
// It is a file rather than something in memory because the instances are separate
// processes with no IPC between them: the phone's `list-instances` lands on whichever
// window happens to be serving its socket, and that window can only answer for its
// siblings by reading what they wrote. Each instance keeps its own entry fresh; a
// reader prunes the ones whose process is gone.
//
// It lives in `sharedDataDir` (never the per-instance profile dir, which is wiped on
// quit) alongside the other machine-wide remote state — the paired devices and the
// room id they hold.

const path = require('path');
const fs = require('fs');
const { sharedDataDir, instanceId, startedAt } = require('./instance');
const { liveInstances, upsertInstance, HEARTBEAT_MS } = require('./instance-lib');

const file = path.join(sharedDataDir, 'remote-instances.json');

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

function read() {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(list)) return list;
  } catch {}
  return [];
}

function write(entries) {
  try { fs.writeFileSync(file, JSON.stringify(entries)); } catch (err) { console.error('[instance registry save]', err); }
}

// Publish this instance's entry. Always read-modify-write: siblings write this file
// too, so a list we held in memory would be missing whatever they added since. Two
// instances saving at the same moment can still lose one entry — that self-heals,
// because an instance republishes whenever its project changes and the phone refetches.
function publish(fields) {
  last = fields;
  write(upsertInstance(read(), { id: instanceId, pid: process.pid, startedAt, seenAt: Date.now(), ...fields }));
}

// Keep proving this window is alive. Without it an entry is only as trustworthy as its
// pid, and a dead instance's pid gets reused — see instance-lib.js `liveInstances`.
// Unref'd so a pending beat can never hold the process open at quit.
let last = null;
let timer = null;
function startHeartbeat() {
  if (timer) return;
  timer = setInterval(() => publish(last || {}), HEARTBEAT_MS);
  if (timer.unref) timer.unref();
}
function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}

function remove() {
  stopHeartbeat();
  write(read().filter((e) => e && e.id !== instanceId));
}

// Every window running right now, oldest first. Entries left by a crashed instance are
// dropped here — it never got to remove itself. A pid the OS has since handed to an
// unrelated process reads as alive and lingers for one more launch, the same trade-off
// instance.js makes for its dir sweep; the phone just fails to dial a window that isn't
// there and can pick another.
const list = () => liveInstances(read(), isAlive);

module.exports = { publish, remove, list, startHeartbeat, stopHeartbeat, instanceId };
