/** Which animation the pet plays: idle and typing start from its still frame, the rest are clips. */
export type Anim = 'idle' | 'typing' | 'review' | 'waving' | 'jumping' | 'failed'

/**
 * What the pet is doing now. `stamp` tells a timed mood apart from a later
 * one; `part` is the piece of the clip showing, for a clip in pieces.
 */
export type Mood = { anim: Anim; line: string; stamp: number; part: number }

/** A helper (a shadow clone, for the ninja): one per running subagent, by its agent id, with its task. */
export type Clone = { id: string; task: string }

declare module 'claude-code' {
  interface PluginState {
    'desk-pets': { mood: Mood; clones: Clone[]; pet: string }
  }
}
