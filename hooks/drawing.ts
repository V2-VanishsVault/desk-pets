// A pet as SVG markup. Two kinds of drawing:
//
// - Clips (the reactions, and `working` for a pet without hands) are made from
//   the still, starting and ending on it, at full size. A clip too big for one
//   image comes in pieces: each piece slides its frames past a one-frame
//   window (CSS steps) once and holds the last, and the hooks swap in the next
//   piece as it ends (register.tsx). A one-piece clip loops by itself.
// - Typing and idle start from the one still frame, so the body stays put.
//   Typing bounces a soft-edged patch around each hand up and down fast, the
//   hands taking turns, blurred vertically, with flickering speed lines. Idle
//   breathes. A clip the pet doesn't have is drawn idle.
//
// The canvas has STILL_TOP of headroom above the still frame for a raised
// hand. Hand positions are in still-frame pixels (pet.json).
import type { Anim } from '../types'
import { CANVAS_HEIGHT, CANVAS_WIDTH, clipOf, FRAME_HEIGHT, FRAME_MS, FRAME_WIDTH, STILL_TOP } from './pets'
import type { Hand, Pet, Piece } from './pets'

const MS_PER_SECOND = 1_000

const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">`
const CALM = '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'

// A helper is the pet tinted shadow blue and a little see-through, arriving in a puff of smoke.
const CLONE_DEFS =
  '<filter id="clone"><feColorMatrix type="matrix" values="' +
  '0.35 0.15 0.10 0 0.02  0.30 0.35 0.15 0 0.08  0.25 0.35 0.75 0 0.25  0 0 0 0.82 0"/></filter>'
const PUFF =
  '<g class="puff" fill="#cfd8e6">' +
  '<circle cx="62" cy="170" r="26"/><circle cx="96" cy="150" r="34"/><circle cx="132" cy="172" r="26"/>' +
  '<circle cx="80" cy="120" r="22"/><circle cx="116" cy="118" r="22"/></g>'
const PUFF_CSS =
  '.puff{transform-box:fill-box;transform-origin:50% 60%;animation:puff .7s ease-out forwards}' +
  '@keyframes puff{from{opacity:.95;transform:scale(.4)}to{opacity:0;transform:scale(1.5)}}' +
  '.who{animation:arrive .45s ease-out}@keyframes arrive{from{opacity:0}to{opacity:1}}'

const SOFT =
  '<radialGradient id="soft"><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
  '<filter id="blur" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="0.5 1.8"/></filter>'
// One tap is .26s down and back; `.turn` runs half a tap behind, `.ghost` trails a little.
const TYPING_CSS =
  '.tap{animation:tap .26s ease-in-out infinite}.turn{animation-delay:-.13s}' +
  '.ghost{animation-delay:-.05s;opacity:.55}.turn.ghost{animation-delay:-.18s}' +
  '@keyframes tap{0%,100%{transform:translateY(-5px)}50%{transform:translateY(4px)}}' +
  '.lines{animation:flick .18s steps(2) infinite}@keyframes flick{50%{opacity:0}}'
const BREATHE_CSS =
  '.body{transform-box:fill-box;transform-origin:50% 100%;animation:breathe 3.4s ease-in-out infinite}' +
  '@keyframes breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,.988)}}'
// Speed lines: three strokes this far beyond a hand's centre, on its outer
// side, from LINES_ABOVE above it to LINES_BELOW below, each LINES_LENGTH
// long; the middle one starts LINES_STEP further out and runs flat, the
// outer two tilt LINES_TILT away from it.
const LINES_OUT = 22
const LINES_ABOVE = 13
const LINES_BELOW = 7
const LINES_MIDDLE = 3
const LINES_LENGTH = 7
const LINES_STEP = 2
const LINES_TILT = 3

// The still frame's middle: a hand left of it gets its speed lines on the left.
const HALVES = 2
const MIDDLE_X = FRAME_WIDTH / HALVES

const handMask =({ cx, cy, rx, ry }: Hand, index: number): string =>
  `<mask id="hand${index}"><ellipse fill="url(#soft)" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/></mask>`

// Every other hand runs half a tap behind, so the hands take turns.
const TURNS = 2
const handTaps = (_: Hand, index: number): string => {
  const isSecond = index % TURNS === 1
  const kind = isSecond ? 'tap turn' : 'tap'
  return (
    `<g mask="url(#hand${index})" filter="url(#blur)">` +
    `<use href="#still" class="${kind}"/><use href="#still" class="${kind} ghost"/></g>`
  )
}

const speedLines = ({ cx, cy }: Hand): string => {
  const isLeft = cx < MIDDLE_X
  const side = isLeft ? -1 : 1
  const x = cx + side * LINES_OUT
  const end = side * LINES_LENGTH
  return (
    `<path d="M${x} ${cy - LINES_ABOVE}l${end} -${LINES_TILT}` +
    `M${x + side * LINES_STEP} ${cy - LINES_MIDDLE}h${end + side}` +
    `M${x} ${cy + LINES_BELOW}l${end} ${LINES_TILT}"/>`
  )
}

const stillSvg = (pet: Pet, anim: 'idle' | 'typing', isClone: boolean): string => {
  const typing = anim === 'typing' && pet.hands.length > 0
  const hands = typing
    ? pet.hands.map(handTaps).join('') +
      '<g class="lines" stroke="#7f97bd" stroke-width="1.8" stroke-linecap="round" fill="none">' +
      `${pet.hands.map(speedLines).join('')}</g>`
    : ''
  return (
    open +
    `<defs><image id="still" href="data:image/webp;base64,${pet.still}" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}"/>` +
    (typing ? SOFT + pet.hands.map(handMask).join('') : '') +
    (isClone ? CLONE_DEFS : '') +
    '</defs>' +
    `<style>${typing ? TYPING_CSS : BREATHE_CSS}${isClone ? PUFF_CSS : ''}${CALM}</style>` +
    `<g transform="translate(0 ${STILL_TOP})">` +
    `<g class="who"${isClone ? ' filter="url(#clone)"' : ''}><use href="#still" class="body"/>${hands}</g>` +
    (isClone ? PUFF : '') +
    '</g></svg>'
  )
}

// A piece that loops slides past all its frames and starts over; one of
// several plays once, stopping on its last frame (jump-none lands on it).
const pieceSvg = ({ frames, box, webp }: Piece, isLooping: boolean): string => {
  const stripWidth = frames * box.w
  const seconds = (frames * FRAME_MS) / MS_PER_SECOND
  const play = isLooping
    ? `play ${seconds}s steps(${frames}) infinite`
    : `play ${seconds}s steps(${frames},jump-none) forwards`
  const end = isLooping ? stripWidth : stripWidth - box.w
  return (
    open +
    `<style>.strip{animation:${play}}@keyframes play{to{transform:translateX(-${end}px)}}${CALM}</style>` +
    `<clipPath id="frame"><rect width="${box.w}" height="${box.h}"/></clipPath>` +
    `<g transform="translate(${box.x} ${box.y})" clip-path="url(#frame)">` +
    `<image class="strip" href="data:image/webp;base64,${webp}" width="${stripWidth}" height="${box.h}"/></g></svg>`
  )
}

/** The pet doing `anim`; `part` picks the piece of a clip that comes in pieces. */
export const petSvg = (pet: Pet, anim: Anim, part = 0): string => {
  const pieces = clipOf(pet, anim)
  const piece = pieces[part % Math.max(pieces.length, 1)]
  if (piece === undefined) {
    return stillSvg(pet, anim === 'typing' ? 'typing' : 'idle', false)
  }
  return pieceSvg(piece, pieces.length === 1)
}

/** A helper, typing away for a subagent. */
export const cloneSvg = (pet: Pet): string => stillSvg(pet, 'typing', true)
