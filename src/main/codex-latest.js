// Resolve a family through a fresh Codex app-server catalog before every launch.
const { spawn } = require('child_process');
const readline = require('readline');
const { currentModelId, resolveCurrentModelId } = require('./agent-providers');

function latestCodexModel(exe, id) {
  return new Promise((resolve) => {
    const win32 = process.platform === 'win32';
    const child = spawn(win32 ? `"${exe}"` : exe, ['app-server'], {
      shell: win32, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let done = false;
    let timer;
    const models = [];
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(result || resolveCurrentModelId(id));
    };
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    timer = setTimeout(() => finish(), 15000);
    child.on('error', () => finish());
    child.on('exit', () => finish());
    child.stdin.on('error', () => finish());
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (done) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.error) return finish();
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'model/list', params: { includeHidden: false } });
      } else if (message.id === 2) {
        if (!Array.isArray(message.result?.data)) return finish();
        models.push(...message.result.data.map((model) => ({ slug: model.model || model.id })));
        if (message.result.nextCursor) {
          send({ id: 2, method: 'model/list', params: { cursor: message.result.nextCursor, includeHidden: false } });
        } else {
          finish(currentModelId(id, models));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'session_editor', version: '0.2.0' } } });
  });
}

module.exports = { latestCodexModel };
