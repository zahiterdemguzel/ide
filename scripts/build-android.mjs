#!/usr/bin/env node
// Builds a release APK of the Expo mobile app (mobile/) and drops it in dist/.
// Requires a JDK and the Android SDK (ANDROID_HOME).
//
// The build does not happen in-tree: the Android Gradle Plugin refuses project
// paths containing non-ASCII characters, and Gradle's temp-workspace moves fail
// intermittently inside OneDrive-synced folders. So the sources are staged into
// an ASCII path outside any sync root and built there. The staging dir persists
// between runs to keep Gradle's incremental caches warm.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = join(repoDir, 'mobile');
const stageDir = join(process.env.LOCALAPPDATA || tmpdir(), 'ide-android-build');
const androidDir = join(stageDir, 'android');
const isWindows = process.platform === 'win32';

const apkName = 'app-release.apk';
const builtApk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', apkName);
const distApk = join(repoDir, 'dist', 'ide-remote.apk');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed`);
    process.exit(result.status ?? 1);
  }
}

console.log(`Staging mobile app in ${stageDir}`);
mkdirSync(stageDir, { recursive: true });
cpSync(mobileDir, stageDir, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|android|ios|\.expo)$/.test(src),
});

// node_modules is copied, not junctioned: Node resolves a junction back to its
// real path, which would hand Gradle the non-ASCII source path right back.
const stagedModules = join(stageDir, 'node_modules');
const lockStamp = join(stageDir, '.deps-lock');
const lock = readFileSync(join(mobileDir, 'package-lock.json'), 'utf8');
const staleDeps = !existsSync(stagedModules)
  || !existsSync(lockStamp)
  || readFileSync(lockStamp, 'utf8') !== lock;

if (staleDeps) {
  console.log('Copying node_modules (dependencies changed)');
  rmSync(stagedModules, { recursive: true, force: true });
  cpSync(join(mobileDir, 'node_modules'), stagedModules, { recursive: true });
  writeFileSync(lockStamp, lock);
}

// The native project is generated from app.json, so regenerate it whenever that
// config changes — a stale android/ would silently ignore the edit.
const configStamp = join(stageDir, '.config-stamp');
const config = readFileSync(join(mobileDir, 'app.json'), 'utf8');
const staleConfig = !existsSync(configStamp) || readFileSync(configStamp, 'utf8') !== config;

if (!existsSync(androidDir) || staleConfig) {
  run('npx', ['expo', 'prebuild', '--platform', 'android'], stageDir);
  writeFileSync(configStamp, config);
}

const gradlew = join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
run(isWindows ? `"${gradlew}"` : gradlew, ['assembleRelease'], androidDir);

mkdirSync(dirname(distApk), { recursive: true });
cpSync(builtApk, distApk);
console.log(`\nAPK: ${distApk}`);
