#!/usr/bin/env bash
#
# Installs the preprocessing toolchain (SPEC.md §5, TASKS-M1 §3). The apt packages need
# root, so this script uses sudo and will prompt for a password. Idempotent - safe to
# re-run. After it finishes, `npm run smoke -- --tools` (or detectTools) should report
# every tool present.
#
set -euo pipefail

# pip --user installs land in ~/.local/bin (yt-dlp). On a fresh account that dir is not
# on PATH yet - Ubuntu's ~/.profile only adds it once it EXISTS, i.e. from the next login
# on - so extend PATH here or the verification below reports a false MISS (fresh-WSL e2e
# finding, 2026-07-20). The systemd unit template carries ~/.local/bin already.
export PATH="$HOME/.local/bin:$PATH"

echo "==> System packages (apt, needs sudo)"
sudo apt-get update
sudo apt-get install -y \
  poppler-utils \
  ocrmypdf \
  tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng \
  pandoc \
  libimage-exiftool-perl

echo "==> Python extractors (pip)"
# python-pptx / openpyxl / odfpy back scripts/extract-office.py for pptx/xlsx/odf.
# Two fresh-Ubuntu realities (found in the fresh-WSL e2e test, 2026-07-20):
#  - a stock 24.04 ships python3 WITHOUT pip → install it via apt first;
#  - PEP 668 marks the system python "externally managed" and refuses plain --user
#    installs. python-pptx is not packaged by Ubuntu, so pip stays the only path for
#    the libraries; user-site installs with --break-system-packages are the sanctioned
#    non-venv escape for pure-python packages like these.
# `--user` is invalid inside a virtualenv (pyenv/venv/conda), so only add it when we are
# NOT in one - otherwise install into the active environment directly.
if ! python3 -m pip --version >/dev/null 2>&1; then
  sudo apt-get install -y python3-pip
fi
# ...and check that it arrived, because everything below this line is a pip install. Without
# the check `set -e` kills the run at the next command with "No module named pip" and nothing
# that says what to do about it - eleven lines above the step that was supposed to fix it, and
# with four apt packages already installed, so a re-run looks like it got further than it did
# (found in the fresh-environment e2e run, 2026-09-17). The likeliest cause is not a failed
# apt: it is a python3 from pyenv, conda or a venv shadowing the system one, which is why the
# message names the interpreter it actually used.
if ! python3 -m pip --version >/dev/null 2>&1; then
  cat >&2 <<EOF
error: python3 has no pip, and installing python3-pip did not give it one.

  python3 in use: $(command -v python3 || echo '<not on PATH>')
  version:        $(python3 --version 2>&1 || true)

  If that is not /usr/bin/python3, a pyenv, conda or venv interpreter is shadowing the system
  one and apt's python3-pip went to a different python. Either give that interpreter pip
  (python3 -m ensurepip --upgrade) or run this script with the system python first on PATH.
EOF
  exit 1
fi
PIP_FLAGS="--user"
if python3 -c 'import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)' 2>/dev/null; then
  PIP_FLAGS=""  # inside a virtualenv
elif python3 -m pip install --help 2>/dev/null | grep -q break-system-packages; then
  PIP_FLAGS="--user --break-system-packages"
fi
python3 -m pip install ${PIP_FLAGS} --upgrade python-pptx openpyxl odfpy

echo "==> yt-dlp (pip, for YouTube URL ingestion: metadata + subtitles)"
python3 -m pip install ${PIP_FLAGS} --upgrade yt-dlp

echo "==> deno (JS runtime for yt-dlp's YouTube extraction)"
# Since 2025 yt-dlp needs a JS runtime (EJS) to solve YouTube's player challenges; without
# one, extraction is deprecated, degraded, and trips the "Sign in to confirm you're not a
# bot" check far more often. deno is the runtime yt-dlp enables by default. The official
# installer drops it in ~/.deno; symlink it into ~/.local/bin, which is already on PATH
# here and in the systemd unit template.
if ! command -v deno >/dev/null 2>&1; then
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.deno" sh
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.deno/bin/deno" "$HOME/.local/bin/deno"
fi

echo "==> defuddle (npm, for URL/web extraction)"
# Installed globally under the user's npm prefix; no sudo if the prefix is user-owned.
# Ships the `defuddle` binary (the old `defuddle-cli` package merged into it).
npm install -g defuddle

echo "==> Verifying"
missing=0
for tool in pdftotext pdfinfo ocrmypdf tesseract pandoc exiftool defuddle yt-dlp deno; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  ok   %s\n' "$tool"
  else
    printf '  MISS %s\n' "$tool"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "Some tools are still missing - see above." >&2
  exit 1
fi
echo "All preprocessing tools present."
