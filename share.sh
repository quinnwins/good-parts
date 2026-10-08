#!/bin/sh
# Makes a zip to send friends, saved to the Desktop. It lists the extension's files by name, so
# key.txt, claude-key.txt, or any other key file never goes out with it.
set -e
cd "$(dirname "$0")"
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)
out="$HOME/Desktop/good-parts-$version.zip"
tmp=$(mktemp -d)
mkdir "$tmp/good-parts"
cp manifest.json background.js captions.js content.js content.css options.html options.js icon16.png icon48.png icon128.png "$tmp/good-parts/"
rm -f "$out"
(cd "$tmp" && zip -qr "$out" good-parts)
rm -rf "$tmp"
echo "$out"
