# Custom `crew-tail://` URL scheme so dispatch links open Terminal

**Status:** Shipped 2026-05-09. **Anchor commits:** `13e8298` (2026-05-08)
— `feat(tail): clickable crew-tail:// links open Terminal via CrewTail
handler` shipped the URL scheme, the `CrewTail.app` AppleScript handler,
the `crew-mcp install-tail-handler` subcommand, and the new `tail_url`
field on `DispatchEnvelope` with the server-rendered markdown switched
over. `f2994f4` (2026-05-09) — `feat(skill): captains use tail_url
(crew-tail://) for inline dispatch link` closed the gap by updating
`skills/crew-captain.body.md` so captains paste `tail_url` (not the
file:// `tail_command_url` which Claude Code intercepts) into the
inline dispatch confirmation; the original plan called out the server
markdown but missed the skill body.

## Why this plan exists

The dispatch envelope already generates a per-run `tail.command` shell
script that, when run, tails `events.log` indefinitely. On macOS the
`.command` extension is registered to Terminal.app — double-clicking
the file in Finder opens a Terminal window running the tail. The
dispatch markdown surfaces this as a clickable `file://` link.

The problem: when the captain prints that link inside Claude Code,
clicking it opens the `.command` file in the **editor** as text, not
in Terminal. Claude Code (and most IDEs) intercept `file://` links
and route them to their own file-open handlers before LaunchServices
gets a chance to dispatch by extension. So the existing UX is
designed for the right behavior, but the host UI prevents it.

A custom URL scheme bypasses this: `file://` is intercepted, but
`crew-tail://` is not, so macOS will route it through LaunchServices
to whatever app declared the scheme — a tiny `.app` we ship that
launches Terminal running `tail -F`.

A previously discussed alternative (a `PostToolUse` hook that
auto-spawns Terminal whenever `run_agent` fires) was rejected because
it removes user control: dispatching 7 reviews would spawn 7 Terminal
windows whether the user wanted to watch them or not. The click-based
flow keeps the user in charge of which runs are worth opening.

## What ships

1. **`scripts/CrewTail.app`** (committed, source-built): a tiny macOS
   AppleScript application bundle that registers the `crew-tail` URL
   scheme and, when invoked, opens Terminal.app running `tail -F` on
   the path encoded in the URL.
2. **A new `tail_url` field** on `DispatchEnvelope` carrying the
   `crew-tail://` form. The existing `tail_command_url` (`file://`)
   stays for backward compatibility and as a fallback for callers
   that haven't installed the handler.
3. **Updated dispatch markdown** at `src/cli/commands/serve.ts:783`
   to use `tail_url` for the clickable link, with the existing manual
   `tail -F` fallback line unchanged.
4. **`crew-mcp install-tail-handler` CLI subcommand** that copies
   `CrewTail.app` to `~/Applications/CrewTail.app` and runs
   `lsregister` to force registration. Explicit, opt-in — no
   `postinstall` magic.
5. **README section** documenting the install step and what the
   handler does, so users know what they're opting into.

## URL scheme design

Form: `crew-tail:///<absolute-path-to-events.log>`

Three slashes (the third is the leading `/` of the absolute path),
then a percent-encoded absolute filesystem path. The handler
percent-decodes and runs `tail -F` against it directly — no run-id
indirection, because:

- The dispatch already knows the absolute path; encoding it keeps the
  handler stateless (no need to consult `state.json` or look anything
  up).
- A run-id form (`crew-tail://run/<id>`) would force the handler to
  know where crew stores state, which couples the handler to the
  serve binary's `runsBasePath` resolution.
- Path-based URLs are inspectable: a user reading the link in
  conversation can see which file will be tailed.

The path field on the envelope is already `events_log_path`; the new
`tail_url` is just `crew-tail://` + percent-encoded form of that
path. We do **not** point it at `tail.command` — the handler runs
`tail -F` itself, so the helper script only matters for the manual
`open <run-dir>/tail.command` fallback.

**Decision: handler runs `tail -F` directly against the events log
path encoded in the URL.** It does not exec `tail.command`. The
helper script's current contents are literally `exec tail -F <path>`,
so wrapping through it would just add a layer with no behavioral
benefit. If the helper ever grows (e.g., a pretty-printer), revisit —
at that point we'd want the handler to delegate so both entry points
share the implementation.

## Handler implementation: AppleScript bundle

AppleScript is the cheapest way to register a URL scheme on macOS —
it ships in the OS, has a built-in `on open location` event handler,
and `osacompile` produces a `.app` bundle out of the box.

The handler script (conceptual):

```applescript
on open location this_URL
    -- this_URL looks like "crew-tail:///Users/me/.../events.log"
    set the_path to my url_decode(text 13 thru -1 of this_URL)
    tell application "Terminal"
        activate
        do script "tail -F " & quoted form of the_path
    end tell
end open location
```

The `url_decode` helper is a small AppleScript routine (or shells out
to `python3 -c 'import urllib.parse, sys; ...'`).

**Info.plist additions** (over the default `osacompile` output):

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>com.crew.tail</string>
    <key>CFBundleURLSchemes</key>
    <array><string>crew-tail</string></array>
  </dict>
</array>
<key>LSUIElement</key>
<true/>
```

`LSUIElement` keeps the handler out of the Dock — it's a one-shot
launcher, not an app the user interacts with directly.

## Source layout

```
scripts/
  tail-handler/
    handler.applescript     # source, committed
    Info.plist.patch        # plist additions, committed
    build.sh                # osacompile + plist merge → CrewTail.app
    install.sh              # invoked by the CLI subcommand
```

The built `CrewTail.app` is **not** committed — it's binary output of
`osacompile`, regenerated by `build.sh` at install time. The CLI
subcommand runs `build.sh` then `install.sh` so the user never
touches the build directly.

## Code changes

### `src/cli/commands/serve.ts`

- Add `tail_url: string` to `DispatchEnvelope` (line ~155 area).
  Doc-comment explaining: "macOS-only, requires the CrewTail handler
  to be registered (run `crew-mcp install-tail-handler`). Falls back
  to the manual tail line below if the scheme isn't registered."
- Populate it at the dispatch site (line ~741): build from
  `args.runStateStore.eventsLogPath(args.runId)` with a new
  `crewTailUrl(path)` helper.
- Update the markdown emit (line ~783) to use `env.tail_url`. Drop
  the `tail_command_url` from the markdown — it stays in the
  structured envelope for compat, but the human-readable surface
  uses the scheme that actually works.

### New helper

`src/cli/commands/tail-url.ts` (or co-locate near `fileUrlHref`):

```ts
export function crewTailUrl(absolutePath: string): string {
  return 'crew-tail://' + encodeURI(absolutePath);
}
```

`encodeURI` (not `encodeURIComponent`) so the slashes in the path
remain literal — the handler's URL parser then sees a normal absolute
path after the scheme.

### New CLI subcommand

`src/cli/commands/install-tail-handler.ts`. The flow is interactive
on TTY, non-interactive (assume `--yes`) when stdin isn't a TTY so
it composes with scripts.

1. Resolve `scripts/tail-handler/` relative to the package root.
2. Run `build.sh` → produces `CrewTail.app` in a temp dir.
   `build.sh` also runs `codesign --sign - --force --deep` to
   ad-hoc sign the bundle (Tier 1 signing for cdhash stability,
   not Gatekeeper bypass).
3. Copy to `~/Applications/CrewTail.app` (create dir if missing).
4. Run `/System/Library/Frameworks/CoreServices.framework/.../lsregister -f ~/Applications/CrewTail.app`
   to force LaunchServices registration without waiting for the
   first click.
5. **Explain Gatekeeper, then ask.** Print an explanation block
   describing what the user will see, why, and what they need to do.
   Then prompt for consent before triggering the dialog. Sample
   copy:

   ```
   ✓ CrewTail.app installed at ~/Applications/CrewTail.app
   ✓ Registered crew-tail:// scheme with LaunchServices

   Next: macOS Gatekeeper needs to approve the handler.
   Because the app isn't signed with an Apple Developer ID,
   macOS will block the first launch with a dialog that says
   roughly:

       "CrewTail.app cannot be opened because Apple cannot
        check it for malicious software."

   To approve it, you'll need to:
     1. Click "Done" on that dialog
     2. Open System Settings → Privacy & Security
     3. Scroll to Security and click "Open Anyway" next to CrewTail
     4. Confirm in the next dialog

   After that, clicking crew-tail:// links from dispatch output
   will open Terminal directly with no further prompts.

   Skip this and clicking a tail link later will trigger the
   same dialog, but mid-workflow rather than at install time.

   Trigger the Gatekeeper dialog now? [Y/n]
   ```

6. On `y` (or non-TTY): `open ~/Applications/CrewTail.app`,
   wait briefly, then print "If you didn't see a dialog, the app
   may already be approved — try clicking a `crew-tail://` link to
   confirm."
7. On `n`: print "Skipped. Run `crew-mcp install-tail-handler
   --trigger-gatekeeper` later, or just click a tail link and
   approve the dialog when it appears."
8. Smoke-test by running `lsregister -dump | grep crew-tail` and
   reporting success/failure regardless of which branch was taken.

Flags:
- `--yes` / `-y`: skip the prompt, assume yes (also the default
  when stdin isn't a TTY).
- `--no-gatekeeper`: install but don't trigger the dialog.
- `--trigger-gatekeeper`: only run step 6 (for users who installed
  earlier and want to clear Gatekeeper now).

Wired into `bin/crew-mcp.ts` as `crew-mcp install-tail-handler`.

## Tests

- **Unit:** `crewTailUrl()` round-trips through a URL parser
  correctly for paths containing spaces, `#`, `?`, and unicode.
  Mirrors the existing `fileUrlHref` test.
- **Envelope:** existing dispatch envelope tests need a new
  expectation for the `tail_url` field. Snapshot or explicit-string
  assertion — match whatever the surrounding tests do.
- **Markdown:** the captain-facing markdown test needs to assert the
  link uses `crew-tail://` not `file://`.
- **Handler:** no automated test. Manual: install, click a link in
  a real dispatch, confirm Terminal opens running `tail -F`.

## Fallback / non-darwin behavior

- On non-darwin: don't emit the `crew-tail://` markdown line at all
  (mirror the existing `process.platform === 'darwin'` gate). The
  manual `tail -F` line stays as the universal fallback.
- On darwin without the handler installed: clicking the link will
  show macOS's "no application set to open this URL" dialog. That's
  fine — the manual `tail -F` line directly below it is the recovery
  path. Document this in the README.

We deliberately don't try to detect "is the handler installed" at
serve time. Probing LaunchServices from Node is non-trivial
(requires shelling out to `lsregister -dump` and grepping, which is
slow and fragile), and the recovery is one line away in the
markdown.

## Risks and open questions

- **AppleScript URL handling and percent-encoding edge cases.**
  Spaces in run-dir names are the main concern — `encodeURI` will
  produce `%20` and the handler must decode. AppleScript's native
  text handling is byte-oriented, so the URL-decode helper has to
  handle UTF-8 correctly. Easiest path: shell out to `python3 -c
  'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))'`
  inside the handler. Adds ~50ms latency, fine for a click-driven UX.
- **Code signing.** Unsigned `.app` bundles trigger Gatekeeper on
  first open. The install step should print clear instructions for
  the right-click → Open dance, OR we accept that the install
  subcommand opens the app once via `open -a` to trigger the
  Gatekeeper prompt explicitly. Either is acceptable for a personal
  tool; not acceptable if this ships to many users.
- **Terminal vs iTerm.** This plan only handles Terminal.app, per
  the user's preference. If iTerm support is wanted later, the
  handler can branch on a `defaults read` of the user's preferred
  terminal, or we ship a second handler app. Not in scope here.
- **`crew-tail` scheme collisions.** Unlikely (very specific
  string), but worth a quick check that nothing else on the user's
  system claims it before install. The install script can run
  `lsregister -dump | grep crew-tail` first and warn if anything
  else is registered.

## Out of scope

- Linux/Windows equivalents (xdg-mime / registry shell associations).
  The existing manual `tail -F` line covers them.
- A pretty-printer for `events.log` content. The handler runs raw
  `tail -F`; any pretty-printing belongs in the helper script
  (`tail.command`) or a separate viewer, not in the URL scheme
  layer.
- Replacing `tail_command_url` in `DispatchEnvelope` outright. We
  add `tail_url` alongside; deprecation can come later once we're
  confident the new path works for everyone.

## Rollout order

1. Land the handler bundle source (`scripts/tail-handler/`) and the
   `install-tail-handler` CLI subcommand. Test manually on the
   author's machine — click a hand-built `crew-tail://` link, see
   Terminal open.
2. Land the envelope + markdown changes behind the existing
   darwin-only gate, with tests.
3. Update README with the install step.
4. Dogfood for a few days. If solid, consider deprecating
   `tail_command_url` from the markdown (it stays in the structured
   envelope indefinitely).
