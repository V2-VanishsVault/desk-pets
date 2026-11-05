// Pets are folders, read at runtime, so adding one needs no rebuild:
//
//   <pets folder>/<id>/pet.json      name, hands and lines (README.md, "Pet folders")
//   <pets folder>/<id>/still.webp    the still pose, FRAME_WIDTH x FRAME_HEIGHT
//   <pets folder>/<id>/<clip>.<part>@<frames>_<x>_<y>_<w>_<h>.webp   optional clip pieces
//
// The plugin's own pets are in its pets/ folder; a person's are in
// ~/.claude/pets/, where a pet with the same id takes the place of the
// plugin's. A clip without pieces falls back to the still.
import type { EngineInterface } from 'claude-code'

import type { Anim } from '../types'

// The pet is drawn on a CANVAS_WIDTH x CANVAS_HEIGHT canvas: the still sits
// STILL_TOP from the top, leaving headroom for a raised hand. A clip comes in
// pieces played in turn, each one image of <frames> frames side by side, each
// frame drawn into the box x, y, w, h of the canvas.
export const FRAME_WIDTH = 192
export const FRAME_HEIGHT = 208
export const STILL_TOP = 24
export const CANVAS_WIDTH = FRAME_WIDTH
export const CANVAS_HEIGHT = FRAME_HEIGHT + STILL_TOP
// An Svg's source is capped at 131,072 characters; this leaves room for the markup.
export const MAX_BASE64 = 120_000
// Clip frames play at this many a second (scripts/make-pet.ts samples them so).
export const CLIP_FPS = 10
const MS_PER_SECOND = 1_000
export const FRAME_MS = MS_PER_SECOND / CLIP_FPS

export const DEFAULT_PET = 'clawde'

export const REACTIONS = ['review', 'waving', 'jumping', 'failed'] as const
export type Reaction = (typeof REACTIONS)[number]
// `working` plays while Claude works, for a pet without hands to type with.
export const CLIPS = [...REACTIONS, 'working'] as const
export type Clip = (typeof CLIPS)[number]

export type Box = { x: number; y: number; w: number; h: number }
/** One piece of a clip: `frames` frames side by side, each drawn into `box`. */
export type Piece = { frames: number; box: Box; webp: string }
/** A soft ellipse around one hand, in still-frame pixels: what moves when the pet types. */
export type Hand = { cx: number; cy: number; rx: number; ry: number }

export type Pet = {
  id: string
  name: string
  emoji: string
  hands: Hand[]
  lines: string[]
  helper: string
  summon: string
  still: string
  clips: Partial<Record<Clip, Piece[]>>
  /** Pieces that were left out, and why. */
  problems: string[]
}

export type PetFolder = { id: string; dir: string; isMine: boolean }

const DEFAULT_LINES = ['Working…', 'On it…', 'Thinking hard…', 'Busy busy…']
const DEFAULT_EMOJI = '🐾'
const DEFAULT_HELPER = 'Helper'
const DEFAULT_SUMMON = 'Calling a helper:'

// A piece's file name: the clip, optionally "." and its place in the clip
// (from 1), then "@", its frame count and its box. Matches
// "waving.2@14_1_26_170_202.webp" (waving, piece 2, 14 frames, box 1, 26,
// 170 x 202) and "review@28_18_28_158_200.webp" (one piece); rejects
// "still.webp" and "Waving@28.png".
// https://regex101.com/?regex=%5E(%3F%3Cclip%3Ereview%7Cwaving%7Cjumping%7Cfailed%7Cworking)(%3F%3A%5C.(%3F%3Cpart%3E%5Cd%2B))%3F%40(%3F%3Cframes%3E%5Cd%2B)_(%3F%3Cx%3E%5Cd%2B)_(%3F%3Cy%3E%5Cd%2B)_(%3F%3Cw%3E%5Cd%2B)_(%3F%3Ch%3E%5Cd%2B)%5C.webp%24&testString=waving.2%4014_1_26_170_202.webp
const PIECE = /^(?<clip>review|waving|jumping|failed|working)(?:\.(?<part>\d+))?@(?<frames>\d+)_(?<x>\d+)_(?<y>\d+)_(?<w>\d+)_(?<h>\d+)\.webp$/
// A pet's id is its folder's name: lowercase letters, digits and hyphens.
// Matches "fat-ninja" and "wizard2"; rejects "Fat Ninja" and "-wizard".
// https://regex101.com/?regex=%5E%5Ba-z0-9%5D%5Ba-z0-9-%5D*%24&testString=fat-ninja
const PET_ID = /^[a-z0-9][a-z0-9-]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : fallback

const isHand = (value: unknown): value is Hand =>
  isRecord(value) && ['cx', 'cy', 'rx', 'ry'].every(key => typeof value[key] === 'number')

/**
 * The clip `anim` plays, or none for the still: a reaction plays its own;
 * typing plays `working` for a pet without hands; idle is always the still.
 */
export const clipOf = (pet: Pet, anim: Anim): Piece[] => {
  if (anim === 'idle') {
    return []
  }
  if (anim === 'typing') {
    return pet.hands.length === 0 ? (pet.clips.working ?? []) : []
  }
  return pet.clips[anim] ?? []
}

// The helpers that take `$` are function declarations: the engine follows `$`
// across files only into those.
async function petsFolders($: EngineInterface): Promise<{ dir: string; isMine: boolean }[]> {
  const home = await $.env.get('HOME')
  const builtIn = { dir: `${$.plugin.root}/pets`, isMine: false }
  return home === undefined ? [builtIn] : [builtIn, { dir: `${home}/.claude/pets`, isMine: true }]
}

/** Every pet folder, a person's own taking the place of the plugin's with the same id. */
export async function listPets($: EngineInterface): Promise<PetFolder[]> {
  const found = await Promise.all(
    (await petsFolders($)).map(async ({ dir, isMine }) =>
      (await $.fs.list(dir).catch(() => []))
        .filter(entry => entry.kind !== 'file' && PET_ID.test(entry.name))
        .map(entry => ({ id: entry.name, dir: `${dir}/${entry.name}`, isMine })),
    ),
  )
  // The person's folder comes last, so its pets replace the plugin's of the same id.
  const byId = new Map(found.flat().map(folder => [folder.id, folder]))
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function readBase64($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.read(path, { as: 'bytes' })).base64
}

/** Reads a pet's folder. Rejects when pet.json or still.webp is missing or malformed. */
export async function loadPet($: EngineInterface, folder: PetFolder): Promise<Pet> {
  const manifest: unknown = JSON.parse(await $.fs.read(`${folder.dir}/pet.json`))
  if (!isRecord(manifest)) {
    throw new Error(`${folder.id}/pet.json is not a JSON object`)
  }
  const still = await readBase64($, `${folder.dir}/still.webp`)
  if (still.length > MAX_BASE64) {
    throw new Error(`${folder.id}/still.webp is too large (${still.length} base64 characters, at most ${MAX_BASE64})`)
  }
  const hands = Array.isArray(manifest.hands) ? manifest.hands.filter(isHand) : []
  const lines = Array.isArray(manifest.lines)
    ? manifest.lines.filter((line): line is string => typeof line === 'string' && line.length > 0)
    : []

  const read = await Promise.all(
    (await $.fs.list(folder.dir)).map(async entry => {
      const groups = PIECE.exec(entry.name)?.groups
      if (groups === undefined) {
        return undefined
      }
      const webp = await readBase64($, `${folder.dir}/${entry.name}`)
      const { clip, part = '1', frames, x, y, w, h } = groups
      const piece: Piece = {
        frames: Number(frames),
        box: { x: Number(x), y: Number(y), w: Number(w), h: Number(h) },
        webp,
      }
      return { name: entry.name, clip: clip as Clip, part: Number(part), piece }
    }),
  )
  const found = read.filter(item => item !== undefined).sort((a, b) => a.part - b.part)
  const isOversized = (piece: Piece) => piece.webp.length > MAX_BASE64
  const problems = found
    .filter(({ piece }) => isOversized(piece))
    .map(({ name, piece }) => `${name} is too large (${piece.webp.length} base64 characters, at most ${MAX_BASE64})`)
  // A clip with an oversized piece is left out whole, so it never plays with a gap.
  const broken = new Set(found.filter(({ piece }) => isOversized(piece)).map(({ clip }) => clip))
  const clips: Partial<Record<Clip, Piece[]>> = Object.fromEntries(
    CLIPS.filter(clip => !broken.has(clip))
      .map(clip => [clip, found.filter(item => item.clip === clip).map(item => item.piece)] as const)
      .filter(([, pieces]) => pieces.length > 0),
  )

  return {
    id: folder.id,
    name: text(manifest.name, folder.id),
    emoji: text(manifest.emoji, DEFAULT_EMOJI),
    hands,
    lines: lines.length > 0 ? lines : DEFAULT_LINES,
    helper: text(manifest.helper, DEFAULT_HELPER),
    summon: text(manifest.summon, DEFAULT_SUMMON),
    still,
    clips,
    problems,
  }
}
