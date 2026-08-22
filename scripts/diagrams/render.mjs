#!/usr/bin/env node
// Renders docs/assets/*.svg to light + dark PNGs for the README.
//
// GitHub will not render a hotlinked SVG: raw.githubusercontent.com serves SVG
// with `content-security-policy: default-src 'none'; sandbox`, and any external
// host gets camo-proxied, which rejects image/svg+xml. PNG from raw.* renders
// fine, so the SVGs stay the editable source and the PNGs are what README ships.
//
// Usage: node scripts/diagrams/render.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSETS = 'docs/assets';
const SCALE = 2;

const tmp = mkdtempSync(join(tmpdir(), 'crew-diagrams-'));

function dims(svg) {
  const w = svg.match(/\bwidth="(\d+)"/);
  const h = svg.match(/\bheight="(\d+)"/);
  if (!w || !h) throw new Error('svg root needs literal width/height attributes');
  return { w: Number(w[1]), h: Number(h[1]) };
}

// Strip the media wrapper so the dark custom properties apply unconditionally.
function forceDark(svg) {
  const out = svg.replace(/\s*@media \(prefers-color-scheme: dark\) \{\s*(svg \{[\s\S]*?\})\s*\}/, '\n      $1');
  if (out === svg) throw new Error('no prefers-color-scheme block found');
  return out;
}

function shoot(svgPath, pngPath, { w, h }) {
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--default-background-color=00000000',
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${w},${h}`,
    `--screenshot=${pngPath}`,
    `file://${process.cwd()}/${svgPath}`.replace(`file://${process.cwd()}/${tmp}`, `file://${tmp}`),
  ], { stdio: 'pipe' });
}

for (const file of readdirSync(ASSETS).filter((f) => f.endsWith('.svg')).sort()) {
  const stem = basename(file, '.svg');
  const src = join(ASSETS, file);
  const svg = readFileSync(src, 'utf8');
  const size = dims(svg);

  shoot(src, join(process.cwd(), ASSETS, `${stem}.png`), size);

  const darkSvg = join(tmp, `${stem}.dark.svg`);
  writeFileSync(darkSvg, forceDark(svg));
  shoot(darkSvg, join(process.cwd(), ASSETS, `${stem}-dark.png`), size);

  console.log(`${stem}: ${size.w}x${size.h} @${SCALE}x -> ${stem}.png, ${stem}-dark.png`);
}

rmSync(tmp, { recursive: true, force: true });
