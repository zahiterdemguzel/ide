#!/usr/bin/env node
// Builds an APK of the Expo mobile app (mobile/) and drops it in dist/.
// Defaults to a fast debug build; pass --release for a shippable minified APK.
// Requires a JDK and the Android SDK (ANDROID_HOME).
//
// The build does not happen in-tree: the Android Gradle Plugin refuses project
// paths containing non-ASCII characters, and Gradle's temp-workspace moves fail
// intermittently inside OneDrive-synced folders. So the sources are staged into
// an ASCII path outside any sync root and built there. The staging dir persists
// between runs to keep Gradle's incremental caches warm.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = join(repoDir, 'mobile');
const stageDir = join(process.env.LOCALAPPDATA || tmpdir(), 'ide-android-build');
const androidDir = join(stageDir, 'android');
const isWindows = process.platform === 'win32';

// Debug builds skip R8/minification and Hermes bytecode compilation, so they
// finish far faster — the default for iterating. Pass --release for a shippable APK.
const isRelease = process.argv.includes('--release');
const variant = isRelease ? 'release' : 'debug';

// Pin Gradle's home (daemon + caches) to a stable ASCII path so the daemon and
// build cache stay warm across runs instead of living under a non-ASCII repo path.
const gradleHome = join(stageDir, '.gradle-home');
process.env.GRADLE_USER_HOME = gradleHome;

const apkName = `app-${variant}.apk`;
const builtApk = join(androidDir, 'app', 'build', 'outputs', 'apk', variant, apkName);
const distApk = join(repoDir, 'dist', 'ide-remote.apk');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed`);
    process.exit(result.status ?? 1);
  }
}

// The launcher icon is generated, not committed: a release APK gets the desktop
// app's mark and a debug one its hue-rotated dev twin, so the two are told apart
// on a phone that has both. app.config.js picks between them off APP_VARIANT.
process.env.APP_VARIANT = isRelease ? 'production' : 'development';
run(process.execPath, [join(repoDir, 'scripts', 'gen-icons.js')], repoDir);

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

// The native project is generated from the app config, so regenerate it whenever
// that changes — a stale android/ would silently ignore the edit. The variant is
// part of the key because it decides which icon prebuild bakes in.
const configStamp = join(stageDir, '.config-stamp');
const config = [
  variant,
  readFileSync(join(mobileDir, 'app.json'), 'utf8'),
  readFileSync(join(mobileDir, 'app.config.js'), 'utf8'),
  createHash('sha1').update(readFileSync(join(mobileDir, 'assets', 'icon.png'))).digest('hex'),
].join('\n');
const staleConfig = !existsSync(configStamp) || readFileSync(configStamp, 'utf8') !== config;

if (!existsSync(androidDir) || staleConfig) {
  run('npx', ['expo', 'prebuild', '--platform', 'android'], stageDir);
  writeFileSync(configStamp, config);
}

// Every APK this script produces must run standalone. React Native's gradle
// plugin skips JS bundling for "debuggable" variants (it expects a Metro dev
// server on the same network), so a stock debug APK installed on a phone dies
// with "Unable to load script … index.android.bundle". Emptying
// debuggableVariants makes the debug variant bundle + Hermes-compile its JS
// like release does, while still skipping R8 minification — so it stays the
// fast build. Re-applied after every prebuild because prebuild regenerates
// build.gradle.
const appGradle = join(androidDir, 'app', 'build.gradle');
const gradleSrc = readFileSync(appGradle, 'utf8');
if (!gradleSrc.includes('debuggableVariants = []')) {
  const anchor = 'bundleCommand = "export:embed"';
  if (!gradleSrc.includes(anchor)) {
    console.error(`Could not find react{} bundleCommand anchor in ${appGradle}`);
    process.exit(1);
  }
  writeFileSync(appGradle, gradleSrc.replace(anchor, `${anchor}\n    debuggableVariants = []`));
}

// Give Gradle a large heap and turn on parallel + build caching. These live in
// GRADLE_USER_HOME (not android/, which prebuild regenerates) so they survive.
mkdirSync(gradleHome, { recursive: true });
writeFileSync(join(gradleHome, 'gradle.properties'), [
  'org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
  'org.gradle.parallel=true',
  'org.gradle.caching=true',
  'org.gradle.daemon=true',
  '',
].join('\n'));

const gradlew = join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
const assembleTask = `assemble${variant[0].toUpperCase()}${variant.slice(1)}`;
run(isWindows ? `"${gradlew}"` : gradlew, [assembleTask, '--build-cache', '--parallel'], androidDir);

mkdirSync(dirname(distApk), { recursive: true });
cpSync(builtApk, distApk);
console.log(`\nAPK: ${distApk}`);
