#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BROWSER_CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

cd "$ROOT_DIR"

read -r CHROMIUM_REVISION CHROMIUM_VERSION HEADLESS_SHELL_REVISION HEADLESS_SHELL_VERSION < <(
  node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const candidates = [
  path.join(root, 'node_modules/playwright-core/browsers.json'),
  path.join(root, 'apps/web/node_modules/playwright-core/browsers.json'),
];

const pnpmRoot = path.join(root, 'node_modules/.pnpm');
if (fs.existsSync(pnpmRoot)) {
  for (const entry of fs.readdirSync(pnpmRoot)) {
    if (entry.startsWith('playwright-core@')) {
      candidates.push(path.join(pnpmRoot, entry, 'node_modules/playwright-core/browsers.json'));
    }
  }
}

const browsersJson = candidates.find(candidate => fs.existsSync(candidate));
if (!browsersJson) {
  throw new Error('Could not find playwright-core browsers.json');
}

const browsers = JSON.parse(fs.readFileSync(browsersJson, 'utf8')).browsers;
const chromium = browsers.find(browser => browser.name === 'chromium');
const headlessShell = browsers.find(browser => browser.name === 'chromium-headless-shell');
if (!chromium || !headlessShell) {
  throw new Error('Could not find Playwright chromium metadata');
}

console.log(`${chromium.revision} ${chromium.browserVersion} ${headlessShell.revision} ${headlessShell.browserVersion}`);
NODE
)

case "$(uname -m)" in
  x86_64 | amd64)
    CHROMIUM_URL="https://cdn.playwright.dev/builds/cft/${CHROMIUM_VERSION}/linux64/chrome-linux64.zip"
    EXECUTABLE_PATH="chrome-linux64/chrome"
    HEADLESS_SHELL_URL="https://cdn.playwright.dev/builds/cft/${HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip"
    HEADLESS_SHELL_EXECUTABLE_PATH="chrome-headless-shell-linux64/chrome-headless-shell"
    ;;
  aarch64 | arm64)
    CHROMIUM_URL="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${CHROMIUM_REVISION}/chromium-linux-arm64.zip"
    EXECUTABLE_PATH="chrome-linux/chrome"
    HEADLESS_SHELL_URL="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${HEADLESS_SHELL_REVISION}/chromium-headless-shell-linux-arm64.zip"
    HEADLESS_SHELL_EXECUTABLE_PATH="chrome-linux/headless_shell"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

install_browser() {
  local name="$1"
  local revision="$2"
  local url="$3"
  local executable_path="$4"
  local browser_dir="${BROWSER_CACHE_DIR}/${name}-${revision}"
  local zip_path="${TMP_DIR}/${name}.zip"

  if [[ -f "${browser_dir}/INSTALLATION_COMPLETE" && -x "${browser_dir}/${executable_path}" ]]; then
    echo "Playwright ${name} ${revision} is already installed."
    return
  fi

  rm -rf "$browser_dir"
  mkdir -p "$browser_dir"

  curl -fL --retry 5 --retry-delay 2 --connect-timeout 30 --max-time 300 \
    -o "$zip_path" "$url"
  timeout 5m unzip -q "$zip_path" -d "$browser_dir"
  chmod 0755 "${browser_dir}/${executable_path}"
  touch "${browser_dir}/INSTALLATION_COMPLETE"

  echo "Installed Playwright ${name} ${revision} to ${browser_dir}."
}

install_browser "chromium" "$CHROMIUM_REVISION" "$CHROMIUM_URL" "$EXECUTABLE_PATH"
install_browser "chromium_headless_shell" "$HEADLESS_SHELL_REVISION" "$HEADLESS_SHELL_URL" "$HEADLESS_SHELL_EXECUTABLE_PATH"
