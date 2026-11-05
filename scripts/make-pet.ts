// Makes a desk pet's art from a picture and from video clips of it. Needs
// ffmpeg, ImageMagick 7 (magick) and cwebp on the PATH (Homebrew: brew
// install ffmpeg imagemagick webp).
//
//   bun make-pet.ts still <picture> <pet folder>
//     Cuts the character out of <picture> (a transparent PNG, or one on a
//     plain white background), fits it into the still frame, and writes
//     still.webp and start-end.png: the still on a white 1024 square, the
//     start and end image for a clip, so every clip begins and ends on it.
//
//   bun make-pet.ts clip <pet folder> <review|waving|jumping|failed|working> <clip.mp4>
//     Turns a square clip made from start-end.png (white background, static
//     camera) into that clip's pieces. It keys out the white, cancels the
//     model's slow camera drift by pinning the bottom of the figure (a real
//     hop stays in), samples CLIP_FPS frames a second at full size and cuts
//     them into as few pieces as fit the pane's size cap, which the pane
//     plays in turn.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// The pet's canvas (hooks/pets.ts): the still frame with STILL_TOP of headroom.
const FRAME_WIDTH = 192
const FRAME_HEIGHT = 208
const STILL_TOP = 24
const CANVAS_HEIGHT = FRAME_HEIGHT + STILL_TOP
const MAX_BASE64 = 120_000
const CLIPS = ['review', 'waving', 'jumping', 'failed', 'working']

// The start image: the still scaled START_SCALE times on a START_SIZE white
// square, START_LEFT from the left and START_TOP from the top. A clip of any
// square size maps back onto the canvas through these.
const START_SIZE = 1024
const START_SCALE = 4
const START_LEFT = 128
const START_TOP = 96
// The still keeps this many pixels clear around the character.
const STILL_MARGIN = 4

// Keying (keyWhite): colours within FLOOD_FUZZ of the corner white count as
// background; inside the outline, pixels lighter than HOLE_WHITE in a patch
// bigger than HOLE_AREA at HOLE_SIZE do too. Video compression greys white
// a little, and at 97% a narrow gap (staff and robe) breaks into specks too
// small to count, so HOLE_WHITE sits at 93% and HOLE_AREA at 120. Eyes and
// highlights stay, as they aren't that white.
const FLOOD_FUZZ = '8%'
const HOLE_WHITE = '93%'
const HOLE_AREA = 120
const HOLE_SIZE = 640
// Drift: the figure's bottom band, from FEET_BAND of its height above its
// bottom to FEET_BELOW of the clip below it, smoothed over DRIFT_WINDOW frames.
const FEET_BAND = 0.25
const FEET_BELOW = 0.08
const DRIFT_WINDOW = 15

// Packing: CLIP_FPS frames a second (hooks/pets.ts plays them at that rate),
// full size, at QUALITY, in as few pieces as fit, up to MAX_PIECES.
const CLIP_FPS = 10
const QUALITY = '60'
const ALPHA_QUALITY = '70'
const MAX_PIECES = 8
const BASE64_GROUP = 3
const BASE64_CHARS = 4
const PERCENT = 100
// Small sums the code below spells with these names.
const BOTH_SIDES = 2
const SQUARED = 2
const HALVES = 2
const SCALE_DIGITS = 4
const ARGS_START = 2
const STILL_ARGS = 2
const CLIP_ARGS = 3

type Rect = { w: number; h: number; x: number; y: number }

const run = (argv: string[]): string => {
  const done = Bun.spawnSync(argv, { stderr: 'pipe' })
  if (done.exitCode !== 0) {
    throw new Error(`${argv[0]} failed: ${done.stderr.toString().trim()}`)
  }
  return done.stdout.toString().trim()
}

// ImageMagick's "%@" bounding box, "WxH+X+Y".
// Matches "148x198+22+5"; rejects "0x0" (nothing there) and "148x198".
// https://regex101.com/?regex=%5E(%5Cd%2B)x(%5Cd%2B)%2B(-%3F%5Cd%2B)%2B(-%3F%5Cd%2B)%24&testString=148x198%2B22%2B5
const GEOMETRY = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/

const boundsOf = (file: string, crop = ''): Rect | undefined => {
  const args = crop === '' ? [] : ['-crop', crop, '+repage']
  const match = GEOMETRY.exec(run(['magick', file, '-alpha', 'extract', ...args, '-threshold', '50%', '-format', '%@', 'info:']))
  if (match === null) {
    return undefined
  }
  const [w, h, x, y] = match.slice(1).map(Number)
  return { w: w ?? 0, h: h ?? 0, x: x ?? 0, y: y ?? 0 }
}

// Background to transparent: the white reached by flooding in from the four
// corners, plus any pure-white gap inside the outline larger than a hole of
// HOLE_AREA (between an arm and the body). Light fur and small white details
// such as eyes stay.
const keyWhite = (input: string, output: string, size: number) => {
  const area = String(Math.round(HOLE_AREA * (size / HOLE_SIZE) ** SQUARED))
  const far = size - 1
  const floods = [`0,0`, `${far},0`, `0,${far}`, `${far},${far}`].flatMap(corner => ['-draw', `color ${corner} floodfill`])
  run([
    'magick', input, '-alpha', 'off',
    '(', '+clone', '-fuzz', FLOOD_FUZZ, '-fill', 'black', ...floods, '-fuzz', '0', '-fill', 'white', '+opaque', 'black', '-colorspace', 'gray', ')',
    '(', '-clone', '0', '-colorspace', 'gray', '-threshold', HOLE_WHITE,
    '-define', `connected-components:area-threshold=${area}`, '-define', 'connected-components:mean-color=true',
    '-connected-components', '8', '-negate', ')',
    '(', '-clone', '1,2', '-compose', 'multiply', '-composite', '-morphology', 'Erode', 'Disk:1', '-blur', '0x0.7', ')',
    '-delete', '1,2', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', output,
  ])
}

// ImageMagick arguments that pull a cut-out's outline in by one pixel at its
// final size. keyWhite erodes at clip size, about a quarter pixel once the
// frame is shrunk, so the edge pixels still hold the white they were blended
// with and show as a light halo on a dark pane. Outside the image counts as
// transparent. (Eroding an extracted copy and putting it back with
// CopyOpacity breaks after -distort: it comes back all opaque.)
const TRIM_EDGE = ['-virtual-pixel', 'transparent', '-channel', 'A', '-morphology', 'Erode', 'Square:1', '+channel']

const makeStill = (picture: string, petDir: string) => {
  mkdirSync(petDir, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'pet-still-'))
  const cut = join(work, 'cut.png')
  const hasAlpha = run(['magick', picture, '-format', '%[opaque]', 'info:']) === 'False'
  if (hasAlpha) {
    run(['magick', picture, cut])
  } else {
    keyWhite(picture, cut, Number(run(['magick', picture, '-format', '%w', 'info:'])))
  }
  // Trimmed, fitted inside the margin, standing on the frame's bottom, centred.
  const fit = `${FRAME_WIDTH - BOTH_SIDES * STILL_MARGIN}x${FRAME_HEIGHT - BOTH_SIDES * STILL_MARGIN}`
  const still = join(petDir, 'still.png')
  run([
    'magick', cut, '-trim', '+repage', '-resize', fit, '-background', 'none',
    '-gravity', 'south', '-extent', `${FRAME_WIDTH}x${FRAME_HEIGHT - STILL_MARGIN}`,
    '-gravity', 'north', '-extent', `${FRAME_WIDTH}x${FRAME_HEIGHT}`,
    // A picture that came with its own transparency has a clean edge already.
    ...(hasAlpha ? [] : TRIM_EDGE), still,
  ])
  run(['cwebp', '-quiet', '-lossless', still, '-o', join(petDir, 'still.webp')])
  run([
    'magick', '-size', `${START_SIZE}x${START_SIZE}`, 'xc:white',
    '(', still, '-filter', 'point', '-resize', `${START_SCALE * PERCENT}%`, ')',
    '-geometry', `+${START_LEFT}+${START_TOP}`, '-composite', '-alpha', 'off', join(petDir, 'start-end.png'),
  ])
  rmSync(still)
  rmSync(work, { recursive: true })
  console.log(`${petDir}: still.webp and start-end.png`)
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / HALVES)] ?? 0
}

// Each frame's feet box, smoothed: follows slow drift but not a quick hop.
const smoothFeet = (feet: Rect[]): Rect[] =>
  feet.map((_, index) => {
    const around = feet.slice(Math.max(0, index - DRIFT_WINDOW), index + DRIFT_WINDOW + 1)
    return {
      x: median(around.map(rect => rect.x)),
      w: median(around.map(rect => rect.w)),
      y: median(around.map(rect => rect.y + rect.h)),
      h: 0,
    }
  })

// `count` runs of frames as even as they can be: 10 frames in 3 is 4, 3, 3.
const split = <T,>(items: T[], count: number): T[][] => {
  const size = Math.ceil(items.length / count)
  return Array.from({ length: count }, (_, index) => items.slice(index * size, (index + 1) * size)).filter(
    group => group.length > 0,
  )
}

// Packs the frames, cropped to the box all of them cover, into the fewest
// pieces that each fit; writes them as <clip>[.<n>]@<frames>_<x>_<y>_<w>_<h>.webp.
const pack = (frames: string[], petDir: string, clip: string, work: string): string[] => {
  const boxes = frames.map(frame => boundsOf(frame)).filter(rect => rect !== undefined)
  const x0 = Math.min(...boxes.map(rect => rect.x))
  const y0 = Math.min(...boxes.map(rect => rect.y))
  const w = Math.max(...boxes.map(rect => rect.x + rect.w)) - x0
  const h = Math.max(...boxes.map(rect => rect.y + rect.h)) - y0
  const encode = (group: string[], index: number, count: number) => {
    const part = count === 1 ? '' : `.${index + 1}`
    const name = `${clip}${part}@${group.length}_${x0}_${y0}_${w}_${h}.webp`
    const strip = join(work, `strip${index}.png`)
    run(['magick', ...group, '-crop', `${w}x${h}+${x0}+${y0}`, '+repage', '+append', strip])
    run(['cwebp', '-quiet', '-q', QUALITY, '-alpha_q', ALPHA_QUALITY, '-m', '6', strip, '-o', join(work, name)])
    return { name, base64: Math.ceil(statSync(join(work, name)).size / BASE64_GROUP) * BASE64_CHARS }
  }
  const counts = Array.from({ length: MAX_PIECES }, (_, index) => index + 1)
  const pieces = counts
    .map(count => () => split(frames, count).map((group, index, groups) => encode(group, index, groups.length)))
    .reduce<{ name: string; base64: number }[] | undefined>((found, tryCount) => {
      if (found !== undefined) {
        return found
      }
      const made = tryCount()
      console.log(`  ${made.length} piece(s): ${made.map(piece => piece.base64).join(', ')} base64 characters`)
      return made.every(piece => piece.base64 <= MAX_BASE64) ? made : undefined
    }, undefined)
  if (pieces === undefined) {
    throw new Error(`${clip} doesn't fit in ${MAX_PIECES} pieces; try a shorter clip`)
  }
  readdirSync(petDir)
    .filter(file => file.startsWith(`${clip}@`) || file.startsWith(`${clip}.`))
    .map(file => rmSync(join(petDir, file)))
  pieces.map(piece => run(['cp', join(work, piece.name), join(petDir, piece.name)]))
  return pieces.map(piece => piece.name)
}

const makeClip = (petDir: string, clipName: string, clip: string) => {
  if (!CLIPS.includes(clipName)) {
    throw new Error(`the clip is one of ${CLIPS.join(', ')}, not "${clipName}"`)
  }
  const reaction = clipName
  const work = mkdtempSync(join(tmpdir(), `pet-${reaction}-`))
  const full = join(work, 'full')
  const keyed = join(work, 'keyed')
  const canvas = join(work, 'canvas')
  ;[full, keyed, canvas].map(dir => mkdirSync(dir))
  run(['ffmpeg', '-v', 'error', '-i', clip, join(full, '%03d.png')])
  const size = Number(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', clip]))
  const rate = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', clip])
  const [num = 1, den = 1] = rate.split('/').map(Number)
  const names = readdirSync(full).filter(file => file.endsWith('.png')).sort()
  names.map(name => keyWhite(join(full, name), join(keyed, name), size))

  // The feet band comes from the first frame, where the pet is in its still pose.
  const first = boundsOf(join(keyed, names[0] ?? ''))
  if (first === undefined) {
    throw new Error(`${basename(clip)}: no figure found on a white background`)
  }
  const bottom = first.y + first.h
  const top = Math.round(bottom - first.h * FEET_BAND)
  const bandHeight = Math.min(size, Math.round(bottom + size * FEET_BELOW)) - top
  const feet = names.map(name => {
    const rect = boundsOf(join(keyed, name), `${size}x${bandHeight}+0+${top}`) ?? { w: first.w, h: 0, x: first.x, y: bottom - top }
    return { ...rect, y: rect.y + top }
  })
  const smooth = smoothFeet(feet)
  const anchor = smooth[0] ?? { x: 0, y: 0, w: 1, h: 0 }

  // Map each frame's feet onto the first frame's, then crop the canvas out.
  const k = size / START_SIZE
  const crop = `${Math.round(FRAME_WIDTH * START_SCALE * k)}x${Math.round(CANVAS_HEIGHT * START_SCALE * k)}+${Math.round(START_LEFT * k)}+${Math.round((START_TOP - STILL_TOP * START_SCALE) * k)}`
  names.map((name, index) => {
    const { x, y, w } = smooth[index] ?? anchor
    const scale = (anchor.w / w).toFixed(SCALE_DIGITS)
    run([
      'magick', join(keyed, name), '-background', 'none', '-virtual-pixel', 'transparent',
      '-distort', 'SRT', `${x},${y} ${scale} 0 ${anchor.x},${anchor.y}`,
      '-crop', crop, '+repage', '-resize', `${FRAME_WIDTH}x${CANVAS_HEIGHT}!`, ...TRIM_EDGE, join(canvas, name),
    ])
  })

  // Sample CLIP_FPS a second; the last frame repeats the first, so it's dropped.
  const step = num / den / CLIP_FPS
  const count = Math.floor((names.length - 1) / step)
  const picked = Array.from({ length: count }, (_, index) => join(canvas, names[Math.round(index * step)] ?? ''))
  console.log(`${reaction}: ${names.length} frames at ${size}px, ${picked.length} kept`)
  const pieces = pack(picked, petDir, reaction, work)
  rmSync(work, { recursive: true })
  pieces.map(name => console.log(`${petDir}/${name}`))
}

const [command, ...args] = process.argv.slice(ARGS_START)
const usage =
  'usage:\n  bun make-pet.ts still <picture> <pet folder>\n  bun make-pet.ts clip <pet folder> <review|waving|jumping|failed> <clip.mp4>'
const [first = '', second = '', third = ''] = args
if (command === 'still' && args.length === STILL_ARGS && existsSync(first)) {
  makeStill(first, second)
} else if (command === 'clip' && args.length === CLIP_ARGS && existsSync(third)) {
  makeClip(first, second, third)
} else {
  writeFileSync('/dev/stderr', `${usage}\n`)
  process.exit(1)
}
