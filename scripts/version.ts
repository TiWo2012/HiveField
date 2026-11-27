#!/usr/bin/env bun
/**
 * Single source of truth for the app version.
 *
 * The version is stored in three files that must always agree:
 *   - package.json
 *   - src-tauri/Cargo.toml
 *   - src-tauri/tauri.conf.json
 *
 * `src-tauri/Cargo.lock` is also rewritten on bump so a fresh `cargo build`
 * doesn't report a dirty lockfile.
 *
 * Usage:
 *   bun scripts/version.ts show                 # print the current version
 *   bun scripts/version.ts check                # verify all files agree
 *   bun scripts/version.ts bump patch           # bump (major|minor|patch)
 *   bun scripts/version.ts bump 0.2.0           # set an exact version
 *   bun scripts/version.ts verify-tag v0.2.0    # tag must match the version
 *
 * Build-style tags (`v0.2.0-build.42`) are accepted by `verify-tag`: the
 * trailing `-build.<n>` is stripped before comparing, because it is minted by
 * CI and is not part of the checked-in version.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = join(ROOT, "package.json");
const CARGO_TOML = join(ROOT, "src-tauri", "Cargo.toml");
const TAURI_CONF = join(ROOT, "src-tauri", "tauri.conf.json");
const CARGO_LOCK = join(ROOT, "src-tauri", "Cargo.lock");
const BUN_LOCK = join(ROOT, "bun.lock");

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

type BumpKind = "major" | "minor" | "patch";

function fail(message: string): never {
  console.error(`version: ${message}`);
  process.exit(1);
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function packageVersion(): string {
  return JSON.parse(readText(PACKAGE_JSON)).version;
}

function cargoVersion(): string {
  const match = readText(CARGO_TOML).match(
    /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  );
  if (!match) fail(`could not find [package].version in ${CARGO_TOML}`);
  return match[1];
}

function tauriVersion(): string {
  return JSON.parse(readText(TAURI_CONF)).version;
}

function lockVersion(): string | null {
  if (!existsSync(CARGO_LOCK)) return null;
  const match = readText(CARGO_LOCK).match(
    /^name = "hivefield"\s*\nversion = "([^"]+)"/m,
  );
  return match ? match[1] : null;
}

function versions(): Record<string, string | null> {
  return {
    "package.json": packageVersion(),
    "src-tauri/Cargo.toml": cargoVersion(),
    "src-tauri/tauri.conf.json": tauriVersion(),
    "src-tauri/Cargo.lock": lockVersion(),
  };
}

/** Version of a package in `src-tauri/Cargo.lock`, or null when absent. */
function cargoLockPackageVersion(name: string): string | null {
  if (!existsSync(CARGO_LOCK)) return null;
  const match = readText(CARGO_LOCK).match(
    new RegExp(`^name = "${name}"\\nversion = "([^"]+)"`, "m"),
  );
  return match ? match[1] : null;
}

/** Version of a package resolved in `bun.lock`, or null when absent. */
function jsPackageVersion(name: string): string | null {
  if (!existsSync(BUN_LOCK)) return null;
  const text = readText(BUN_LOCK);
  const marker = `"${name}": ["${name}@`;
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const versionStart = start + marker.length;
  const versionEnd = text.indexOf('"', versionStart);
  return versionEnd === -1 ? null : text.slice(versionStart, versionEnd);
}

/**
 * The Tauri CLI refuses to bundle when a Rust plugin and its NPM counterpart
 * are not on the same major/minor (e.g. `tauri-plugin-dialog` 2.7 vs
 * `@tauri-apps/plugin-dialog` 2.8). The unit tests and `cargo test` never hit
 * that check, so a mismatch only surfaced in the release build. Verify it here
 * so `version:check` — which runs on every CI job and Dependabot PR — catches
 * it before a release.
 */
function checkTauriPackageVersions(): void {
  const pairs: [string, string][] = [["tauri", "@tauri-apps/api"]];
  const dependencies = Object.keys(
    JSON.parse(readText(PACKAGE_JSON)).dependencies ?? {},
  );
  for (const name of dependencies) {
    const prefix = "@tauri-apps/plugin-";
    if (!name.startsWith(prefix)) continue;
    pairs.push([`tauri-plugin-${name.slice(prefix.length)}`, name]);
  }

  const minor = (version: string) =>
    version.split(".").slice(0, 2).join(".");
  const mismatches = pairs.flatMap(([rustName, jsName]) => {
    const rustVersion = cargoLockPackageVersion(rustName);
    const jsVersion = jsPackageVersion(jsName);
    if (!rustVersion || !jsVersion) return [];
    if (minor(rustVersion) === minor(jsVersion)) return [];
    return [`  ${rustName} ${rustVersion} vs ${jsName} ${jsVersion}`];
  });

  if (mismatches.length > 0) {
    fail(
      "Tauri Rust and NPM packages must share a major.minor version:\n" +
        mismatches.join("\n") +
        "\nversion: align the Cargo.lock and bun.lock entries before releasing",
    );
  }
}

/** Compare every file and exit non-zero (with a table) when they differ. */
function check(): string {
  const found = versions();
  const entries = Object.entries(found).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  const unique = new Set(entries.map(([, version]) => version));

  if (unique.size !== 1) {
    console.error("version: files disagree:");
    for (const [file, version] of entries) {
      console.error(`  ${file.padEnd(28)} ${version ?? "(missing)"}`);
    }
    console.error(
      "version: run `bun run version:bump <major|minor|patch|x.y.z>` to align them",
    );
    process.exit(1);
  }

  const [version] = [...unique];
  if (!SEMVER.test(version)) {
    fail(`"${version}" is not a valid semver version`);
  }
  checkTauriPackageVersions();
  return version;
}

function nextVersion(current: string, kind: BumpKind): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) fail(`cannot bump invalid version "${current}"`);
  let [, major, minor, patch] = match.map(Number);
  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function replaceFirst(text: string, pattern: RegExp, next: string): string {
  if (!pattern.test(text)) return text;
  return text.replace(pattern, (_all, prefix: string, suffix: string) =>
    `${prefix}${next}${suffix}`,
  );
}

function bump(target: string): void {
  const current = check();
  let next: string;

  if (target === "major" || target === "minor" || target === "patch") {
    next = nextVersion(current, target);
  } else {
    next = target.replace(/^v/, "");
    if (!SEMVER.test(next)) fail(`"${target}" is not a valid semver version`);
  }

  if (next === current) {
    console.log(`version: already at ${current}; nothing to do`);
    return;
  }

  const packageJson = replaceFirst(
    readText(PACKAGE_JSON),
    /("version"\s*:\s*")[^"]+(")/,
    next,
  );
  writeFileSync(PACKAGE_JSON, packageJson);

  const cargoToml = readText(CARGO_TOML).replace(
    /^\[package\][\s\S]*?^version\s*=\s*"[^"]+"/m,
    (section) =>
      section.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`),
  );
  writeFileSync(CARGO_TOML, cargoToml);

  const tauriConf = replaceFirst(
    readText(TAURI_CONF),
    /("version"\s*:\s*")[^"]+(")/,
    next,
  );
  writeFileSync(TAURI_CONF, tauriConf);

  if (existsSync(CARGO_LOCK)) {
    const lock = readText(CARGO_LOCK).replace(
      /(^name = "hivefield"\s*\nversion = ")[^"]+(")/m,
      `$1${next}$2`,
    );
    writeFileSync(CARGO_LOCK, lock);
  }

  const verified = check();
  console.log(`version: ${current} -> ${verified}`);
  console.log("version: updated package.json, Cargo.toml, tauri.conf.json, Cargo.lock");
}

/** Validate that a release tag refers to the checked-in version. */
function verifyTag(tag: string): void {
  const current = check();
  const normalized = tag.trim().replace(/^v/, "").replace(/-build\.\d+$/, "");
  if (normalized !== current) {
    fail(
      `tag "${tag}" does not match the checked-in version "${current}" ` +
        `(expected v${current}, optionally with -build.<n>)`,
    );
  }
  console.log(`version: tag ${tag} matches ${current}`);
}

function main(argv: string[]): void {
  const [command, argument] = argv;

  switch (command) {
    case "show":
      console.log(check());
      break;
    case "check":
      console.log(`version: ${check()} (all files agree)`);
      break;
    case "bump":
      if (!argument) fail("usage: bun scripts/version.ts bump <major|minor|patch|x.y.z>");
      bump(argument);
      break;
    case "verify-tag":
      if (!argument) fail("usage: bun scripts/version.ts verify-tag <tag>");
      verifyTag(argument);
      break;
    default:
      console.error(
        "usage: bun scripts/version.ts <show|check|bump|verify-tag> [argument]",
      );
      process.exit(1);
  }
}

main(process.argv.slice(2));
