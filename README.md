# Desk pets

An animated pet in a pane beside the Claude Code chat. It works while Claude works, reacts to what's going on, and calls in a helper for every subagent. It comes with six pets, Clawde by default, and you can make your own from any picture.

| Pet | Id | Works by |
| --- | --- | --- |
| 🟧 Clawde (default) | `clawde` | standing and getting stuck in |
| 🥷 V2 Ninja | `v2-ninja` | sitting with his laptop, hands a typing blur |
| 🧙 Grumpy wizard | `grumpy-wizard` | standing and grudgingly casting spells |
| 🦆 Rubber duck | `rubber-duck` | listening while you talk it through, bobbing as it thinks |
| 🐈 Ginger cat | `ginger-cat` | sitting with its laptop, paws on the keys |
| 🐕 Golden pup | `golden-pup` | standing on its hind legs, tail wagging |

On the desktop app, VS Code and mobile the pet is animated. The terminal shows a one-line status instead.

| When | The pet | The line says |
| --- | --- | --- |
| Session starts | waves | Ready when you are |
| Claude is working, editing or running a command | types, or plays its working clip | one of its own lines / Editing register.tsx / Running bun test |
| Claude reads or searches | reads, squinting | Reading README.md |
| A subagent starts | celebrates, and a helper (the pet tinted blue, half size) appears until that subagent finishes | Shadow clone jutsu: <task> |
| A question, a plan, or a permission prompt | waves at you | Has a question for you / Needs your OK |
| A tool fails, or the turn errors | reacts | Bash hit a snag |
| The turn finishes | celebrates | Done! |
| Nothing going on | stands or sits still, breathing | |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install desk-pets --marketplace V2-VanishsVault/desk-pets
```

Answer `y` to add the marketplace, then pick a scope (user scope puts the pet in every session).

From a shell:

```sh
claude plugin install desk-pets --marketplace V2-VanishsVault/desk-pets
```

In the Claude desktop app, where `/plugin` doesn't run: click + next to the prompt box, then Plugins, Add marketplace with `V2-VanishsVault/desk-pets`, then Add plugin.

Then type `/pet` to show the pane, and `/pet <id>` (such as `/pet rubber-duck`) to pick a pet. `/pet list` shows them all.

To update to a new release, then restart Claude:

```sh
claude plugin update desk-pets@vanish-vault
```

Or turn on auto-update in `/plugin`, under Marketplaces, `vanish-vault`.

## Commands

- `/pet` shows or hides the pane. Hiding it is remembered across sessions.
- `/pet list` lists the pets, which one is showing, and what each is missing.
- `/pet <id>` switches pets. That choice is remembered too.
- `/desk-pets:create-pet` has Claude make a new pet with you (see below).

## Make your own pet

Ask Claude to make you a pet, or run `/desk-pets:create-pet`. Claude walks you through it:

1. **A picture:** yours, or one Claude generates from your description. It shows one character, whole body, on a plain white background.
2. **A still:** the character cut out and fitted to the pane.
3. **Clips:** 4-second videos made from the still, for working, reading, waving, celebrating and oops. Claude makes them with the [Higgsfield](https://higgsfield.ai) connector if you have it connected (about 2.4 credits a clip), or you supply clips from any image-to-video tool. Every clip is optional.

Your pets live in `~/.claude/pets/<id>/` and load without a rebuild. A pet there with the same id as a built-in one replaces it.

The image work needs `bun`, `ffmpeg`, ImageMagick 7 and `cwebp`:

```sh
brew install ffmpeg imagemagick webp
```

## Pet folders

```
<id>/
  pet.json        name, emoji, lines, helper, summon, and hands for a typing pet
  still.webp      the still pose, 192 x 208, transparent background
  <clip>.<n>@<frames>_<x>_<y>_<w>_<h>.webp
```

Clips are `working`, `review`, `waving`, `jumping` and `failed`. Each clip plays at 10 frames a second, at full size. It comes in pieces (`.1`, `.2`, …) because one image in the pane is capped at 131,072 characters. The pane plays the pieces in turn. Each piece is its frames side by side, drawn into the box `x, y, w, h` of a 192 x 232 canvas, with the still sitting 24 px from the top to leave headroom for a raised hand.

`scripts/make-pet.ts` makes all of it from a picture and from clips:

```sh
bun scripts/make-pet.ts still <picture> <pet folder>
bun scripts/make-pet.ts clip <pet folder> <clip> <clip.mp4>
```

On macOS the script cuts the pet out with Apple Vision (`scripts/mask.swift`, run with Xcode's `swift`), which leaves out gaps and floor shadows. Elsewhere it keys out the white background. Add `--keep-white` for a pet with white markings inside its outline (Clawde's starburst), so the cleanup of white gaps leaves them alone.

A typing pet lists `hands` in `pet.json`. These are soft ellipses around each hand in still-frame pixels, and the pane taps them in turn while Claude works. A pet without hands plays its `working` clip instead.

## Developing

```sh
claude plugin test .
claude plugin validate .
```

The pets' original videos were made on Higgsfield (Seedance 1.5 Pro, 480p, 1:1, no audio). Each clip uses the pet's `start-end.png` as both its start and end image, so it loops back to the still.

## License

MIT. See [LICENSE](LICENSE). The two pets' artwork is covered by the same license.
