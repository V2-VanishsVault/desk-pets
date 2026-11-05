import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The plugin's pets folder holds the ninja; the person's own holds a robot
// without reactions or hands. The images stand in for WebP bytes.
const HOME = '/home/me'
const MY_PETS = `${HOME}/.claude/pets`
const NINJA = `{
  "name": "V2 Ninja", "emoji": "🥷", "hands": [{ "cx": 52, "cy": 131, "rx": 17, "ry": 14 }],
  "lines": ["Frantically working…"], "helper": "Shadow clone", "summon": "Shadow clone jutsu:"
}`
const FOLDERS: Record<string, Record<string, string>> = {
  'v2-ninja': {
    'pet.json': NINJA,
    'still.webp': 'U1RJTEw=',
    'review@2_0_24_192_208.webp': 'UkVWSUVX',
    'waving.1@2_0_24_192_208.webp': 'V0FWRTE=',
    'waving.2@3_0_24_192_208.webp': 'V0FWRTI=',
  },
  robo: { 'pet.json': JSON.stringify({ name: 'Robo' }), 'still.webp': 'Uk9CTw==' },
}
const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })

const fakePets = (on: On) => {
  on('env.get', () => ({ value: HOME }))
  on('fs.list', (_, e) => {
    if (e.path === MY_PETS) {
      return { value: [entry('robo', 'dir')] }
    }
    if (e.path.endsWith('/pets')) {
      return { value: [entry('v2-ninja', 'dir'), entry('.DS_Store', 'file')] }
    }
    const files = FOLDERS[e.path.split('/').pop() ?? ''] ?? {}
    return { value: Object.keys(files).map(name => entry(name, 'file')) }
  })
  on('fs.read', (_, e) => {
    const parts = e.path.split('/')
    const name = parts.pop() ?? ''
    const folder = parts.pop() ?? ''
    const content = FOLDERS[folder]?.[name] ?? ''
    return { value: e.as === 'bytes' ? { base64: content } : content }
  })
}

const PANE_ROWS = 20
const PANE_COLUMNS = 40
const TOOL_MS = 100
const SETTLED_MS = 10_000
const FIRST_PIECE_MS = 200
const SECOND_PIECE_MS = 300
// The two pieces of the ninja's fake wave, by the stand-in bytes in FOLDERS.
const PIECE_IMAGES = [
  { name: 'first', base64: 'V0FWRTE=' },
  { name: 'second', base64: 'V0FWRTI=' },
]
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'desk-pets',
  component: 'Pane',
  requestId: 'desk-pet',
  props: {
    title: 'Desk pet',
    isFocused: false,
    bodyColumns: PANE_COLUMNS,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: PANE_ROWS },
    view: {},
  },
} as const

// How /pet is typed at the prompt, with `args` after it.
const typedPet = (args: string) =>
  ({
    command: 'pet',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: PANE_COLUMNS },
  }) as const

const DONE_TURN = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('the pet reads while Claude reads, and the line says what', async ($, on) => {
  const clock = mock.clock(on)
  fakePets(on)
  // The tool stands for the engine and takes a moment, so the pane is drawn mid-call.
  on('tool.call', { tool: 'Read' }, async (_, e) => {
    await clock.sleep(TOOL_MS)
    return { result: { file: { filePath: e.file_path } } }
  })

  const call = $.tool.call({ tool: 'Read', file_path: '/repo/hooks/register.tsx' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe('Reading register.tsx')
  expect(String(svg?.props.source)).toContain('data:image/webp;base64,')
  await ui.unmount()

  await clock.advance(TOOL_MS)
  await call
})

test('a clip in pieces plays each piece for its frames, then the next, round and round', async ($, on) => {
  const clock = mock.clock(on)
  fakePets(on)
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await clock.sleep(SETTLED_MS)
    return { result: {} }
  })
  // At 10 frames a second, piece 1 (2 frames) shows for 200 ms and piece 2 (3 frames) for 300 ms.
  const pieceShown = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const source = String((await ui.find({ type: 'Svg' }))?.props.source)
    await ui.unmount()
    return PIECE_IMAGES.find(image => source.includes(image.base64))?.name
  }

  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  await clock.settle()
  expect(await pieceShown()).toBe('first')
  await clock.advance(FIRST_PIECE_MS)
  expect(await pieceShown()).toBe('second')
  await clock.advance(SECOND_PIECE_MS)
  expect(await pieceShown()).toBe('first')

  await clock.advance(SETTLED_MS)
  await call
})

test('a finished turn cheers on every surface, then settles back to idle', async ($, on) => {
  const clock = mock.clock(on)
  fakePets(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete(DONE_TURN)

  const cheered = await Promise.all(
    SURFACES.map(async surface => {
      const ui = await $.ui.mount({ ...PANE, surface })
      const texts = await ui.findAll({ type: 'Text' })
      await ui.unmount()
      return texts.some(text => text.text.includes('Done!'))
    }),
  )
  expect(cheered).toEqual(SURFACES.map(() => true))

  await clock.advance(SETTLED_MS)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('V2 Ninja')
  await ui.unmount()
})

test("a subagent gets a helper named for the pet, which leaves when its run ends", async ($, on) => {
  mock.clock(on)
  fakePets(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn({
    prompt: 'Check the open PRs',
    description: 'Review open pull requests',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    tool_use_id: 'toolu_1',
    parentModel: 'opus',
    background: false,
    fork: false,
  })
  const during = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = await during.findAll({ type: 'Svg' })
  expect(drawn.map(svg => svg.props.alt)).toEqual(['V2 Ninja', 'Shadow clone: Review open pull requ…'])
  await during.unmount()

  await $.turn.complete({ ...DONE_TURN, agentId: 'agent-1' })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.findAll({ type: 'Svg' })).toHaveLength(1)
  await after.unmount()
})

test('the pane opens at session start, /pet toggles it, and /pet <id> switches pets', async ($, on) => {
  const clock = mock.clock(on)
  fakePets(on)
  // Stand in for the store and the surface's panes, so the test can read both.
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  const open = new Set<string>()
  on('ui.open', (_, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: 'Desk pet', isPlaced: true, isShown: true, isFocused: false })),
  }))
  on('command.register', () => ({ value: { command: 'pet' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(open.has('desk-pet')).toBe(true)

  const closed = await $.command.run(typedPet(''))
  expect(closed.text).toContain('napping')
  expect(open.has('desk-pet')).toBe(false)
  expect(stored.get('isPaneClosed')).toBe(true)

  const listed = await $.command.run(typedPet('list'))
  expect(listed.text).toContain('▸ 🥷 v2-ninja: V2 Ninja (built in; no jumping, failed)')
  expect(listed.text).toContain('  🐾 robo: Robo (yours; no review, waving, jumping, failed; no hands or working clip)')

  const missing = await $.command.run(typedPet('nobody'))
  expect(missing.text).toContain('no pet named "nobody"')

  const switched = await $.command.run(typedPet('robo'))
  expect(switched.text).toContain('Robo is your desk pet now')
  expect(stored.get('pet')).toBe('robo')
  expect(open.has('desk-pet')).toBe(true)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Robo, reporting for duty')
  await ui.unmount()
})
