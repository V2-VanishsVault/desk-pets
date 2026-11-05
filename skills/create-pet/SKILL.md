---
name: create-pet
description: Make a new desk pet for the desk-pets plugin from a picture or a description: its still pose, and clips for working, reading, waving, cheering and oops. Use when the person asks to create, add, make or change a desk pet, or to give a pet new reactions.
---

# Make a desk pet

A pet is a folder in `~/.claude/pets/<id>/` (the id is lowercase letters, digits and hyphens). The pane reads it at runtime, so a finished pet is one `/pet <id>` away. A pet needs only `pet.json` and `still.webp`. Every clip is optional, and a clip the pet doesn't have shows the still.

The plugin's folder is `${CLAUDE_PLUGIN_ROOT}`. Its `scripts/make-pet.ts` does the image work and needs `bun`, `ffmpeg`, `magick` (ImageMagick 7) and `cwebp`. Check with `which bun ffmpeg magick cwebp` first. If any are missing, tell the person (`brew install ffmpeg imagemagick webp`, and bun from bun.sh) and don't install them yourself.

## 1. Choose the kind of pet

- **Standing pet (the default):** the character stands and reacts. While Claude works it plays a `working` clip, such as stirring a cauldron, sketching or tinkering.
- **Typing pet:** the character sits with a laptop on its lap, with both hands visible on the keyboard at the sides. While Claude works, the pane taps its hands in turn over the still, which needs no clip. The plugin's ninja is one.

## 2. The picture

The picture should show one character, whole body, facing the viewer in a neutral resting pose (or the laptop pose), on a plain white or transparent background, with margin around it.

- **The person has a picture:** use it. If the pose or background is wrong, offer to generate one from it.
- **They only describe the pet:** generate the picture. With the Higgsfield connector, use `generate_image` (`gpt_image_2_5`, 1:1, two variants). The prompt names the character, the pose, a stylised 3D animated-film or clean cartoon look, centred with margin, a pure white background, no floor shadow and no text. Show both and let the person pick. Without an image tool, ask them for a picture.

Keep it original or theirs. Don't make pets of trademarked characters, brand mascots or real people.

## 3. The still

```sh
bun "${CLAUDE_PLUGIN_ROOT}/scripts/make-pet.ts" still <picture> ~/.claude/pets/<id>
```

That writes `still.webp` (the character cut out and fitted into 192 x 208, standing on the bottom edge) and `start-end.png` (the still on a white 1024 square, the first and last frame of every clip). Look at both. If the cut-out lost something light or kept a white patch, the background wasn't plain enough: regenerate the picture on pure white, or ask for one with a transparent background.

## 4. pet.json

```json
{
  "name": "Grumpy wizard",
  "emoji": "🧙",
  "lines": ["Muttering incantations…", "Don't rush the magic…"],
  "helper": "Apprentice",
  "summon": "Summoning an apprentice:"
}
```

- `lines`: 6 to 10 short in-character lines shown while it works, each ending in `…`.
- `helper`: what a subagent's helper is called, shown as "<helper>: <task>".
- `summon`: the line shown when a subagent starts, followed by the task.
- `hands`, for a typing pet only: look at the still and give an ellipse around each hand where it rests on the keyboard, in still-frame pixels (192 wide, 208 high, origin top left), about 15 x 13, left hand first: `"hands": [{ "cx": 52, "cy": 131, "rx": 17, "ry": 14 }, { "cx": 143, "cy": 131, "rx": 16, "ry": 14 }]`.

Every field but `hands` has a default. The person can type `/pet list` to see the pet and what it is missing, and `/pet <id>` to show it.

## 5. Clips

Each clip is 4 seconds and square. It starts and ends on `start-end.png`, so it flows out of the still and back.

| Clip | When it plays | The motion |
|---|---|---|
| `working` | while Claude works (standing pets) | a calm in-character activity that loops, such as casting, sketching or tinkering |
| `review` | reading or searching | leans in, squints and scans, nods once, settles back |
| `waving` | a question or permission prompt | waves at the viewer twice, hand back down |
| `jumping` | a turn finishes, a subagent starts | celebrates (fists up, a hop, a flourish), settles back |
| `failed` | an error | startled, then a facepalm or head shake, settles back |

Every prompt starts with "Static camera, locked off, plain white background." and says the character stays in place and returns to exactly the same pose. Keep effects small and close to the body. Smoke, sparks or anything that flies far gets cut off at the frame's edge; prefer "no smoke, no particles" unless the effect stays near the hands.

**With the Higgsfield connector:** upload `start-end.png` (`media_upload`, a curl PUT of the file, `media_confirm`), then `generate_video_batch` with `model: "seedance1_5"`, `duration: 4`, `aspect_ratio: "1:1"`, `resolution: "480p"`, `generate_audio: false`, and the uploaded media as both `start_image` and `end_image`. Tell the person the cost first: about 2.4 credits a clip, which you can preflight with `generate_video` and `get_cost: true`. Higgsfield runs about three at a time and answers others with a `429`. Submit three, then the rest as those finish. A "preset was recommended" answer is not a failure: resubmit with `declined_preset_id`. Download each result with `curl -o`.

**Without it:** ask the person for clips made the same way in any image-to-video tool (both the start and end frame are `start-end.png`, with a white background and a static camera), or skip the clips.

For each clip:

```sh
bun "${CLAUDE_PLUGIN_ROOT}/scripts/make-pet.ts" clip ~/.claude/pets/<id> <clip> <clip.mp4>
```

The script does the following:

- Keys out the white.
- Cancels the video model's camera drift.
- Samples 10 frames a second at full size.
- Cuts the frames into as few pieces as fit the pane's size cap, usually three. The pane plays the pieces in turn.
- Replaces any older pieces of that clip.

Look at a few frames of the result. Regenerate a clip whose first frame isn't the still (the model ignored the start image), or one that has white specks or cut-off effects.

If the pet has a white marking inside its outline, such as a white logo, belly or patch, and that marking comes out with holes, run the clip again with `--keep-white` at the end. The script then removes only the white reached from the frame's corners and keeps everything inside the outline. A gap the background can't reach, such as between legs held together over a floor shadow, then stays white. If that shows, regenerate the clip with a pose that keeps the legs apart.

## 6. Show it

Tell the person to type `/pet <id>`. The pane picks up the pet at once, and `/pet <id>` again reloads it after a change. Offer to tweak the lines or any one clip.
