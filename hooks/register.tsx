import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Anim, Clone, Mood } from '../types'
import { cloneSvg, petSvg } from './drawing'
import { clipOf, DEFAULT_PET, FRAME_MS, FRAME_WIDTH, listPets, loadPet, REACTIONS } from './pets'
import type { Pet } from './pets'

// A mood as the hooks ask for it; setMood stamps it and starts it on its first piece.
type MoodSpec = Omit<Mood, 'stamp' | 'part'>

const IDLE: Mood = { anim: 'idle', line: '', stamp: 0, part: 0 }
const NO_CLONES: Clone[] = []

const mood = atom({ plugin: 'desk-pets', key: 'mood' } as const, IDLE)
// One helper per running subagent, typing away beside the pet.
const clones = atom({ plugin: 'desk-pets', key: 'clones' } as const, NO_CLONES)
// The pet shown, by id; /pet <id> changes it, remembered across sessions under PET_KEY.
const petId = atom({ plugin: 'desk-pets', key: 'pet' } as const, DEFAULT_PET)

// The pet lives in a pane beside the chat. Closing it with /pet is
// remembered across sessions under CLOSED_KEY.
const PANE = { id: 'desk-pet', title: 'Desk pet' } as const
const CLOSED_KEY = 'isPaneClosed'
const PET_KEY = 'pet'

// How long a passing mood shows before the pet settles again.
const WELCOME_MS = 4_000
const SUCCESS_MS = 5_000
const ERROR_MS = 4_000
const TOOL_ERROR_MS = 2_500

// Helpers are drawn at half size, at most this many, with a "+n" for the rest.
const CLONE_SHRINK = 2
const CLONE_WIDTH = FRAME_WIDTH / CLONE_SHRINK
const MAX_CLONES_SHOWN = 4

const DETAIL_LENGTH = 36
const TASK_LENGTH = 22

// Each pet is read once per load of the module, and again when /pet picks it.
const loaded = new Map<string, Promise<Pet>>()

const readPet = async ($: EngineInterface, id: string): Promise<Pet> => {
  const folder = (await listPets($)).find(pet => pet.id === id)
  if (folder === undefined) {
    throw new Error(`there is no pet named "${id}"`)
  }
  return loadPet($, folder)
}

const getPet = async ($: EngineInterface, id: string): Promise<Pet> => {
  const cached = loaded.get(id)
  if (cached !== undefined) {
    return cached
  }
  const loading = readPet($, id)
  loaded.set(id, loading)
  try {
    return await loading
  } catch (error) {
    loaded.delete(id)
    throw error
  }
}

/** The pet, or why it can't be loaded. */
const tryPet = async ($: EngineInterface, id: string): Promise<Pet | string> => {
  try {
    return await getPet($, id)
  } catch (error) {
    return error instanceof Error ? error.message : 'unreadable'
  }
}

// The chosen pet, falling back to the default one when it no longer loads.
const currentPet = async ($: EngineInterface): Promise<Pet> => {
  const pet = await tryPet($, await read($, petId))
  return typeof pet === 'string' ? getPet($, DEFAULT_PET) : pet
}

const working = (pet: Pet): MoodSpec => ({
  anim: 'typing',
  line: pet.lines[Math.floor(Math.random() * pet.lines.length)] ?? 'Working…',
})

type ToolLook = { anim: Anim; verb: string }

const TOOL_LOOKS: Record<string, ToolLook> = {
  Read: { anim: 'review', verb: 'Reading' },
  Grep: { anim: 'review', verb: 'Searching' },
  Glob: { anim: 'review', verb: 'Looking for' },
  WebSearch: { anim: 'review', verb: 'Searching the web' },
  WebFetch: { anim: 'review', verb: 'Reading' },
  ToolSearch: { anim: 'review', verb: 'Finding tools' },
  Edit: { anim: 'typing', verb: 'Editing' },
  MultiEdit: { anim: 'typing', verb: 'Editing' },
  Write: { anim: 'typing', verb: 'Writing' },
  NotebookEdit: { anim: 'typing', verb: 'Editing' },
  Bash: { anim: 'typing', verb: 'Running' },
  AskUserQuestion: { anim: 'waving', verb: 'Has a question for you' },
  ExitPlanMode: { anim: 'waving', verb: 'Has a plan for you' },
}

const lookOf = (pet: Pet, tool: string): ToolLook =>
  tool === 'Agent' ? { anim: 'jumping', verb: pet.summon } : (TOOL_LOOKS[tool] ?? { anim: 'typing', verb: 'Working on' })

const textField = (e: object, name: string): string | undefined => {
  const value: unknown = name in e ? Reflect.get(e, name) : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const shorten = (text: string, length: number): string => {
  const line = text.split('\n')[0] ?? ''
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

// What the tool is working on, in a few words: a file's name, a command's description.
const detailOf = (e: object): string => {
  const path = textField(e, 'file_path') ?? textField(e, 'notebook_path')
  const detail =
    (path === undefined ? undefined : path.split('/').pop()) ??
    textField(e, 'description') ??
    textField(e, 'pattern') ??
    textField(e, 'query') ??
    textField(e, 'command')
  return detail === undefined ? '' : ` ${shorten(detail, DETAIL_LENGTH)}`
}

// Runs the pet's side of a hook that gates Claude's work (a prompt, a tool
// call): a pet that fails to load or draw must never hold that work up.
const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {
    // The pet just misses this mood.
  }
}

// Swaps in a clip's next piece as the one showing ends, round and round, for
// as long as the mood lasts. A clip in one piece loops by itself.
const playPieces = async ($: EngineInterface, stamp: number) => {
  const now = await read($, mood)
  if (now.stamp !== stamp) {
    return
  }
  const pieces = clipOf(await currentPet($), now.anim)
  const piece = pieces[now.part]
  if (pieces.length <= 1 || piece === undefined) {
    return
  }
  $.clock.after(piece.frames * FRAME_MS, async () => {
    await update($, mood, current =>
      current.stamp === stamp ? { ...current, part: (current.part + 1) % pieces.length } : current,
    )
    await playPieces($, stamp)
  })
}

const setMood = async ($: EngineInterface, next: MoodSpec): Promise<number> => {
  const stamp = await $.clock.now()
  await update($, mood, () => ({ ...next, stamp, part: 0 }))
  await playPieces($, stamp)
  return stamp
}

// Shows a passing mood, then settles on `after` unless something newer came in.
const flash = async ($: EngineInterface, next: MoodSpec, ms: number, after: MoodSpec = IDLE) => {
  const stamp = await setMood($, next)
  $.clock.after(ms, async () => {
    if ((await read($, mood)).stamp === stamp) {
      await setMood($, after)
    }
  })
}


// What `/pet list` shows: each pet, which one is shown, where it comes from and what's missing.
const describePets = async ($: EngineInterface): Promise<string> => {
  const shown = await read($, petId)
  const rows = await Promise.all(
    (await listPets($)).map(async folder => {
      const mark = folder.id === shown ? '▸' : ' '
      const pet = await tryPet($, folder.id)
      if (typeof pet === 'string') {
        return `${mark} ${folder.id}: can't load (${pet})`
      }
      const missing = REACTIONS.filter(reaction => pet.clips[reaction] === undefined)
      const notes = [
        folder.isMine ? 'yours' : 'built in',
        ...(missing.length > 0 ? [`no ${missing.join(', ')}`] : []),
        ...(pet.hands.length === 0 && pet.clips.working === undefined ? ['no hands or working clip'] : []),
        ...pet.problems,
      ]
      return `${mark} ${pet.emoji} ${folder.id}: ${pet.name} (${notes.join('; ')})`
    }),
  )
  return [...rows, '', 'Switch with /pet <id>. Make your own with /desk-pets:create-pet.'].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'pet',
      description: 'Show or hide your desk pet, list pets, or switch to another',
      argumentHint: '[list | <pet id>]',
    })
    const saved = await $.store.get(PET_KEY)
    if (typeof saved === 'string') {
      await update($, petId, () => saved)
    }
    if ((await $.store.get(CLOSED_KEY)) !== true) {
      void $.ui.open(PANE)
    }
    await flash($, { anim: 'waving', line: 'Ready when you are' }, WELCOME_MS)
    return started
  })

  // `/pet` shows or hides the pane, `/pet list` lists the pets, `/pet <id>` switches.
  on('command.run', { command: 'pet' }, async ($, e) => {
    const choice = e.args.trim()
    if (choice === '') {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE.id)
      await $.store.set(CLOSED_KEY, isOpen)
      if (isOpen) {
        await $.ui.close({ id: PANE.id })
        return { text: 'Your pet is napping. /pet brings it back.' }
      }
      await $.ui.open(PANE)
      return { text: 'Your pet is back.' }
    }
    if (choice === 'list') {
      return { text: await describePets($) }
    }
    // Read it afresh, so a pet just made or changed shows as it is now.
    loaded.delete(choice)
    const pet = await tryPet($, choice)
    if (typeof pet === 'string') {
      return { text: `Couldn't switch: ${pet}. /pet list shows the pets there are.` }
    }
    await $.store.set(PET_KEY, pet.id)
    await $.store.set(CLOSED_KEY, false)
    await update($, petId, () => pet.id)
    void $.ui.open(PANE)
    await flash($, { anim: 'waving', line: `${pet.name}, reporting for duty` }, WELCOME_MS)
    return { text: `${pet.emoji} ${pet.name} is your desk pet now.` }
  })

  on('prompt.submit', async ($, e, next) => {
    await quietly(async () => setMood($, working(await currentPet($))))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A subagent's tools belong to its helper; the pet keeps to its own work.
    const isMine = textField(e, 'agentId') === undefined
    if (isMine) {
      await quietly(async () => {
        const look = lookOf(await currentPet($), e.tool)
        await setMood($, { anim: look.anim, line: `${look.verb}${detailOf(e)}` })
      })
    }
    const ran = await next(e)
    if (!isMine) {
      return ran
    }
    const isFailed = ran.deny === undefined && ran.isError === true
    await quietly(async () => {
      const pet = await currentPet($)
      if (isFailed) {
        await flash($, { anim: 'failed', line: `${e.tool} hit a snag` }, TOOL_ERROR_MS, working(pet))
      } else {
        await setMood($, working(pet))
      }
    })
    return ran
  })

  // Each subagent gets a helper; its last turn sends the helper away.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const { agentId } = spawned
    if (agentId !== undefined) {
      const task = shorten(e.description, TASK_LENGTH)
      await quietly(async () =>
        update($, clones, list => [...list.filter(clone => clone.id !== agentId), { id: agentId, task }]),
      )
    }
    return spawned
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') {
      await quietly(async () => setMood($, { anim: 'waving', line: 'Needs your OK' }))
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await quietly(async () => flash($, { anim: 'failed', line: 'Something went wrong' }, ERROR_MS))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const { agentId } = e
    if (agentId !== undefined) {
      await update($, clones, list => list.filter(clone => clone.id !== agentId))
      return done
    }
    if (e.isAborted) {
      await setMood($, IDLE)
    } else {
      await flash($, { anim: 'jumping', line: 'Done!' }, SUCCESS_MS)
    }
    return done
  })

  // The id is written out (PANE.id) so the matcher reads as a literal.
  on('ui.render', { component: 'Pane', requestId: 'desk-pet' }, async ($, e) => {
    const now = await read($, mood)
    const team = await read($, clones)
    const pet = await currentPet($)
    const label = now.line === '' ? pet.name : now.line
    const extra = team.length - MAX_CLONES_SHOWN
    const helpers = `${pet.helper.toLowerCase()}${team.length === 1 ? '' : 's'}`

    if (e.surface === 'terminal') {
      const { Text } = $.ui.resolve(e)
      const helperNote = team.length === 0 ? '' : ` · ${team.length} ${helpers}`
      return (
        <Text dimColor>
          {pet.emoji} {label}
          {helperNote}
        </Text>
      )
    }

    const { Box, Svg, Text } = $.ui.resolve(e)
    // Drawn as images, not `isInteractive`: the desktop's sandboxed frame
    // blocks the embedded WebP, while the image mode shows it and still runs
    // the CSS animation. With no width given the pet takes the frame's own
    // size, shrunk to fit a narrow pane.
    return (
      <Box flexDirection="column" alignItems="center" gap={1}>
        <Svg source={petSvg(pet, now.anim, now.part)} alt={label} />
        <Text dimColor>{label}</Text>
        {team.length === 0 ? null : (
          <Box flexDirection="row" flexWrap="wrap" justifyContent="center" gap={1}>
            {team.slice(0, MAX_CLONES_SHOWN).map(clone => (
              <Box key={clone.id} flexDirection="column" alignItems="center">
                <Svg source={cloneSvg(pet)} alt={`${pet.helper}: ${clone.task}`} width={CLONE_WIDTH} />
                <Text dimColor>{clone.task}</Text>
              </Box>
            ))}
            {extra > 0 ? <Text dimColor>+{extra} more</Text> : null}
          </Box>
        )}
      </Box>
    )
  })
}
