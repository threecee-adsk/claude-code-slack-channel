#!/usr/bin/env -S npx tsx
/**
 * slack-supervisor — keeps the router and the Claude Code sessions alive.
 *
 * Reads a config describing the router + a list of sessions. On each tick it
 * checks liveness and respawns anything that died, with backoff. Sessions are
 * launched inside tmux (a persistent pty — a long-lived `claude` channel
 * session needs a terminal; tmux also matches the plugin's SLACK_TMUX_SESSION
 * admin integration). The router is a plain server, run as a direct child.
 *
 * Liveness is ground-truthed against the router's /health endpoint: a session
 * counts as healthy only when its tmux session exists AND it is registered and
 * live in the router. That confirms the whole chain (claude up → slack-session
 * MCP up → registered).
 *
 * Resume: each session gets a stable UUID. First launch uses --session-id; every
 * respawn uses --resume <uuid> so the conversation persists across crashes.
 *
 * Usage:
 *   npx tsx slack-supervisor.ts [up|down|status] [--config <path>] [--once]
 *     up      (default) supervise forever, respawning dead pieces
 *     down    stop the router child + kill session tmux windows, then exit
 *     status  print one health snapshot and exit
 *
 * Config default: ~/.claude/slack-router/supervisor.json  (see supervisor.example.json)
 *
 * NOTE: the exact `claude` channel-launch flags are a configurable template
 * (`launchTemplate`) because the channels flags are a Research-Preview feature
 * hidden from `claude --help`. The default mirrors the reference repo's
 * `claude --dangerously-load-development-channels server:slack-session`. If the
 * flag syntax differs in your Claude Code build, edit the template — no code
 * change needed.
 */

import { spawn, execFileSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { isValidSessionName, validateBotCwd } from './lib.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTER_DIR = join(homedir(), '.claude', 'slack-router')
const STATE_FILE = join(ROUTER_DIR, 'supervisor-state.json')
const PIDFILE = join(ROUTER_DIR, 'supervisor.pid')
mkdirSync(ROUTER_DIR, { recursive: true })

function log(msg: string): void {
  // ISO-ish timestamp without Date.now sensitivity issues at module load.
  process.stderr.write(`[supervisor] ${msg}\n`)
}

// ── Config ────────────────────────────────────────────────────────────────────
interface SessionConfig {
  name: string
  cwd: string
  bind?: string[]
  resume?: boolean
  extraArgs?: string
}
interface SupervisorConfig {
  checkIntervalMs: number
  minRespawnMs: number
  /** Grace window after a (re)spawn during which a live-but-unregistered tmux
   *  session is assumed to still be booting (claude cold start + channel
   *  connect), NOT dead. Prevents killing sessions before they can register. */
  bootGraceMs: number
  /** Cap on how many sessions to (re)spawn per tick, to avoid a cold-start
   *  storm when several sessions need launching at once. */
  maxSpawnPerTick: number
  routerPort: number
  /** Loopback port for the operator control API (router → supervisor) that
   *  backs the Slack `!status` / `!kill` / `!restart` / `!new-channel-bot`
   *  commands. Bound to 127.0.0.1 only. */
  supervisorPort: number
  /** Default working directory a `!new-channel-bot` session spawns in when the
   *  operator doesn't pass an explicit path. Empty → `/sessions/add` with no
   *  cwd is rejected (fail loud rather than guess a path). */
  defaultCwd: string
  /** Allow-set that confines the cwd a new channel-bot may spawn in (plus
   *  `defaultCwd` and its subdirectories, which are always allowed). A path
   *  from a Slack message that resolves outside these roots is rejected. */
  allowedCwdRoots: string[]
  /** Visibility of channels created by `!new-channel-bot`. Passed to the
   *  router via env; default `private` (smaller exposure surface). */
  newChannelVisibility: 'public' | 'private'
  router: { enabled: boolean }
  claudeBin: string
  /** Path to the minimal --mcp-config JSON defining only the slack-session
   *  server (used by {mcpConfig} in the launch template). */
  mcpConfigPath: string
  /** Template for the claude launch line run inside tmux. Placeholders:
   *  {cwd} {name} {bind} {tmux} {routerPort} {claudeBin} {mcpConfig} {resumeArg} {extra} */
  launchTemplate: string
  skipPermissions: boolean
  sessions: SessionConfig[]
}

// Full-plugin launch: each session loads the user's complete plugin set
// (forma-memory, m365, telegram, discord) plus the slack-session channel.
// server:slack-session resolves the user-scoped MCP server registered via
// `claude mcp add -s user slack-session`. Orphaned plugin MCP servers (left by
// a killed/crashed session) are swept by reapOrphans() so they can't pile up.
const DEFAULT_TEMPLATE =
  'cd {cwd} && SESSION_NAME={name} SLACK_BIND={bind} ' +
  'SLACK_TMUX_SESSION={tmux} ROUTER_PORT={routerPort} ' +
  '{claudeBin} --dangerously-load-development-channels server:slack-session {resumeArg} {extra}'

function defaultConfig(): SupervisorConfig {
  return {
    checkIntervalMs: 5000,
    minRespawnMs: 20_000,
    bootGraceMs: 90_000,
    maxSpawnPerTick: 2,
    routerPort: 8801,
    supervisorPort: 8802,
    defaultCwd: '',
    allowedCwdRoots: [],
    newChannelVisibility: 'private',
    router: { enabled: true },
    claudeBin: 'claude',
    mcpConfigPath: join(ROUTER_DIR, 'slack-session.mcp.json'),
    launchTemplate: DEFAULT_TEMPLATE,
    skipPermissions: false,
    sessions: [],
  }
}

/** Path of the config currently loaded — captured so the control API can
 *  persist runtime mutations (`/sessions/add` and `/sessions/kill`) back to
 *  the same file. */
let activeCfgPath = ''

function loadConfig(path: string): SupervisorConfig {
  activeCfgPath = path
  if (!existsSync(path)) {
    log(`No config at ${path} — copy supervisor.example.json there and edit it.`)
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SupervisorConfig>
  return { ...defaultConfig(), ...raw, router: { ...defaultConfig().router, ...(raw.router ?? {}) } }
}

/** Persist the full in-memory config atomically (tmp + chmod 0o600 + rename).
 *  NOTE: once the control API mutates sessions this rewrites the operator's
 *  hand-edited supervisor.json — comments/formatting are lost and
 *  defaultConfig() defaults are merged in. The file becomes partly
 *  machine-managed from that point on. */
function saveConfig(cfg: SupervisorConfig): void {
  if (!activeCfgPath) return
  const tmp = `${activeCfgPath}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  chmodSync(tmp, 0o600)
  renameSync(tmp, activeCfgPath)
}

// ── Persisted state (router pid, per-session uuid) ───────────────────────────
interface SupervisorState {
  routerPid: number | null
  sessions: Record<string, { sessionId: string; spawnedOnce: boolean; lastSpawnAt: number }>
}
let state: SupervisorState = { routerPid: null, sessions: {} }
function loadState(): void {
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    /* fresh */
  }
}
function saveState(): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ── Liveness helpers ──────────────────────────────────────────────────────────
function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function tmuxHas(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function tmuxKill(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
  } catch {
    /* not running */
  }
}
function tmuxCapture(name: string): string {
  try {
    return execFileSync('tmux', ['capture-pane', '-t', name, '-p'], { encoding: 'utf8' })
  } catch {
    return ''
  }
}
function tmuxSend(name: string, keys: string): void {
  try {
    execFileSync('tmux', ['send-keys', '-t', name, keys], { stdio: 'ignore' })
  } catch {
    /* pane gone */
  }
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ── Serialization lock ─────────────────────────────────────────────────────
// tick() iterates cfg.sessions; the control API mutates it. Node is
// single-threaded, but both yield at await points — a mutation landing
// mid-iteration could skip or double-visit a session. Funnel tick() and every
// mutating endpoint through one promise chain so they never interleave.
let lock: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = lock.then(() => fn())
  lock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** `--dangerously-load-development-channels` shows a one-time interactive
 *  confirmation ("1. I am using this for local development / Enter to confirm").
 *  Option 1 is preselected, so a bare Enter accepts it. We poll the pane and
 *  send Enter when the prompt appears. Fire-and-forget. */
async function confirmDevChannelPrompt(tmuxName: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await delay(1500)
    const pane = tmuxCapture(tmuxName)
    if (!pane) return // pane gone
    if (/Loading development channels|local development|Enter to confirm/i.test(pane)) {
      tmuxSend(tmuxName, 'Enter')
      return
    }
  }
}

async function routerHealth(port: number): Promise<{ sessions: Array<{ name: string }> } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return (await res.json()) as { sessions: Array<{ name: string }> }
  } catch {
    return null
  }
}

// ── Router child ──────────────────────────────────────────────────────────────
function ensureRouter(cfg: SupervisorConfig): void {
  if (!cfg.router.enabled) return
  if (pidAlive(state.routerPid)) return
  const tsx = join(HERE, 'node_modules', '.bin', 'tsx')
  const routerScript = join(HERE, 'slack-router.ts')
  const out = openSync(join(ROUTER_DIR, 'router.log'), 'a')
  const child = spawn(tsx, [routerScript], {
    cwd: HERE,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      ROUTER_PORT: String(cfg.routerPort),
      // Let the router reach the control API and know the channel-visibility
      // policy — supervisor.json stays the single source of operator config.
      SUPERVISOR_PORT: String(cfg.supervisorPort),
      NEW_CHANNEL_VISIBILITY: cfg.newChannelVisibility,
    },
  })
  child.unref()
  state.routerPid = child.pid ?? null
  saveState()
  log(`spawned router (pid ${state.routerPid}) → ${join(ROUTER_DIR, 'router.log')}`)
}

// ── Session children (tmux) ──────────────────────────────────────────────────
function buildLaunch(cfg: SupervisorConfig, s: SessionConfig, tmuxName: string): string {
  const st = state.sessions[s.name]
  const resumeArg =
    s.resume && st.spawnedOnce ? `--resume ${st.sessionId}` : `--session-id ${st.sessionId}`
  const extra = [s.extraArgs ?? '', cfg.skipPermissions ? '--dangerously-skip-permissions' : '']
    .filter(Boolean)
    .join(' ')
  return cfg.launchTemplate
    .replaceAll('{cwd}', s.cwd)
    .replaceAll('{name}', s.name)
    .replaceAll('{bind}', (s.bind ?? []).join(','))
    .replaceAll('{tmux}', tmuxName)
    .replaceAll('{routerPort}', String(cfg.routerPort))
    .replaceAll('{claudeBin}', cfg.claudeBin)
    .replaceAll('{mcpConfig}', cfg.mcpConfigPath)
    .replaceAll('{resumeArg}', resumeArg)
    .replaceAll('{extra}', extra)
}

/** Returns true if it (re)spawned this tick. */
function ensureSession(cfg: SupervisorConfig, s: SessionConfig, healthyNames: Set<string>): boolean {
  const tmuxName = `slack-${s.name}`
  if (!state.sessions[s.name]) {
    state.sessions[s.name] = { sessionId: randomUUID(), spawnedOnce: false, lastSpawnAt: 0 }
    saveState()
  }
  const st = state.sessions[s.name]

  // Registered + live in the router = healthy. Mark spawnedOnce here (NOT at
  // spawn time) — only once a session has actually registered do we know its
  // conversation exists, so future respawns can safely --resume it. Marking it
  // at spawn caused --resume against a never-created conversation after a crash.
  if (healthyNames.has(s.name)) {
    if (!st.spawnedOnce) {
      st.spawnedOnce = true
      saveState()
    }
    return false
  }

  const now = Date.now()
  const tmuxAlive = tmuxHas(tmuxName)
  // Live tmux but not yet registered → still booting (claude cold start +
  // channel connect). Be patient up to bootGraceMs before assuming it's wedged.
  if (tmuxAlive && now - st.lastSpawnAt < cfg.bootGraceMs) return false
  // Hard floor between (re)spawns.
  if (now - st.lastSpawnAt < cfg.minRespawnMs) return false

  // tmux crashed, or alive-but-wedged past the grace → (re)spawn.
  tmuxKill(tmuxName)
  const launch = buildLaunch(cfg, s, tmuxName)
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxName], { stdio: 'ignore' })
    execFileSync('tmux', ['send-keys', '-t', tmuxName, launch, 'Enter'], { stdio: 'ignore' })
  } catch (err) {
    log(`failed to (re)spawn session "${s.name}": ${err}`)
    return false
  }
  void confirmDevChannelPrompt(tmuxName) // auto-answer the dev-channel warning
  st.lastSpawnAt = now
  saveState()
  log(`(re)spawned session "${s.name}" in tmux "${tmuxName}" (${st.spawnedOnce ? 'resume' : 'fresh'})`)
  return true
}

// ── Tick ──────────────────────────────────────────────────────────────────────
/** Kill orphaned (PPID 1) plugin MCP servers left behind when a session's
 *  claude was killed/crashed. Without this, plugins (esp. telegram/discord) can
 *  spin at high CPU after their parent dies. Scoped to plugin MCP patterns;
 *  never reaps the router or the supervisor itself. */
function reapOrphans(): void {
  let out = ''
  try {
    out = execFileSync('ps', ['-Ao', 'pid,ppid,command'], { encoding: 'utf8' })
  } catch {
    return
  }
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const [, pid, ppid, cmd] = m
    if (ppid !== '1') continue
    if (/slack-router\.ts|slack-supervisor\.ts/.test(cmd)) continue // never our own management procs
    if (/\/plugins\/cache\/|forma-memory\/mcp-server|server\.ts|slack-session\.ts/.test(cmd)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
        log(`reaped orphan pid ${pid}: ${cmd.slice(0, 70)}`)
      } catch {
        /* already gone */
      }
    }
  }
}

async function tick(cfg: SupervisorConfig): Promise<void> {
  reapOrphans()
  ensureRouter(cfg)
  const health = await routerHealth(cfg.routerPort)
  const healthyNames = new Set((health?.sessions ?? []).map(x => x.name))
  let budget = cfg.maxSpawnPerTick
  for (const s of cfg.sessions) {
    const spawned = ensureSession(cfg, s, healthyNames)
    if (spawned) {
      budget--
      if (budget <= 0) break // stagger remaining (re)spawns to the next tick
    }
  }
}

// ── Subcommands ────────────────────────────────────────────────────────────────
async function status(cfg: SupervisorConfig): Promise<void> {
  const health = await routerHealth(cfg.routerPort)
  log(`router pid ${state.routerPid ?? '—'} alive=${pidAlive(state.routerPid)} healthEndpoint=${health ? 'up' : 'down'}`)
  const live = new Set((health?.sessions ?? []).map(x => x.name))
  for (const s of cfg.sessions) {
    const tmuxName = `slack-${s.name}`
    log(`session ${s.name}: tmux=${tmuxHas(tmuxName)} registered=${live.has(s.name)} bind=[${(s.bind ?? []).join(',')}]`)
  }
}

function down(cfg: SupervisorConfig): void {
  for (const s of cfg.sessions) tmuxKill(`slack-${s.name}`)
  if (pidAlive(state.routerPid)) {
    try {
      process.kill(state.routerPid!, 'SIGTERM')
    } catch {
      /* ignore */
    }
  }
  state.routerPid = null
  saveState()
  reapOrphans() // sweep any MCP servers orphaned by the killed sessions
  log('down: killed session tmux windows + router + swept orphans')
}

// ── Control API (Slack !commands → router → supervisor) ─────────────────────
// Loopback-only HTTP. The router is the only caller; it translates operator
// Slack verbs into these calls. Mutating endpoints run under withLock so they
// never interleave with a tick().
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function statusSnapshot(cfg: SupervisorConfig): Record<string, unknown> {
  return {
    ok: true,
    routerPid: state.routerPid,
    routerAlive: pidAlive(state.routerPid),
    sessions: cfg.sessions.map(s => ({
      name: s.name,
      tmux: tmuxHas(`slack-${s.name}`),
      bind: s.bind ?? [],
      cwd: s.cwd,
      uuid: state.sessions[s.name]?.sessionId,
    })),
  }
}

/** Side-effect-free validation of a prospective new session. The router calls
 *  this BEFORE creating a Slack channel so a bad name/cwd fails loudly without
 *  leaving an orphaned empty channel behind. Read-only — no lock needed. */
function precheckSession(cfg: SupervisorConfig, body: Record<string, unknown>, res: ServerResponse): void {
  const name = String(body.name ?? '')
  const cwdArg = body.cwd === undefined ? undefined : String(body.cwd)
  if (!isValidSessionName(name)) {
    return sendJson(res, 400, { ok: false, error: `invalid session name: ${name}` })
  }
  if (cfg.sessions.some(s => s.name === name) || tmuxHas(`slack-${name}`)) {
    return sendJson(res, 400, { ok: false, error: `session "${name}" already exists` })
  }
  const cwd = validateBotCwd(cwdArg, cfg.defaultCwd, cfg.allowedCwdRoots)
  if (!cwd.ok) return sendJson(res, 400, { ok: false, error: cwd.error })
  return sendJson(res, 200, { ok: true, name, cwd: cwd.cwd })
}

function addSession(cfg: SupervisorConfig, body: Record<string, unknown>, res: ServerResponse): void {
  const name = String(body.name ?? '')
  const bind = Array.isArray(body.bind) ? (body.bind as unknown[]).map(String) : []
  const cwdArg = body.cwd === undefined ? undefined : String(body.cwd)
  const resume = body.resume === undefined ? true : Boolean(body.resume)

  if (!isValidSessionName(name)) {
    return sendJson(res, 400, { ok: false, error: `invalid session name: ${name}` })
  }
  if (cfg.sessions.some(s => s.name === name) || tmuxHas(`slack-${name}`)) {
    return sendJson(res, 400, { ok: false, error: `session "${name}" already exists` })
  }
  const cwd = validateBotCwd(cwdArg, cfg.defaultCwd, cfg.allowedCwdRoots)
  if (!cwd.ok) {
    return sendJson(res, 400, { ok: false, error: cwd.error })
  }
  const session: SessionConfig = { name, cwd: cwd.cwd, bind, resume }
  cfg.sessions.push(session) // in place — the tick() closure shares this array
  saveConfig(cfg)
  ensureSession(cfg, session, new Set()) // spawn now, don't wait for the next tick
  if (!tmuxHas(`slack-${name}`)) {
    return sendJson(res, 500, {
      ok: false,
      error: `session "${name}" was added to config but its tmux window did not start (is tmux installed?)`,
    })
  }
  return sendJson(res, 200, { ok: true, name, cwd: cwd.cwd })
}

function killSession(cfg: SupervisorConfig, body: Record<string, unknown>, res: ServerResponse): void {
  const name = String(body.name ?? '')
  const idx = cfg.sessions.findIndex(s => s.name === name)
  if (idx < 0) return sendJson(res, 404, { ok: false, error: `unknown session: ${name}` })
  cfg.sessions.splice(idx, 1) // removing from config is what stops the respawn loop
  saveConfig(cfg)
  tmuxKill(`slack-${name}`)
  // Keep state.sessions[name] so the --resume UUID survives an accidental
  // kill + re-add. Sweep the killed session's orphaned plugin MCP children.
  reapOrphans()
  return sendJson(res, 200, { ok: true, name })
}

function restartSession(cfg: SupervisorConfig, body: Record<string, unknown>, res: ServerResponse): void {
  const name = String(body.name ?? '')
  const s = cfg.sessions.find(x => x.name === name)
  if (!s) return sendJson(res, 404, { ok: false, error: `unknown session: ${name}` })
  tmuxKill(`slack-${name}`)
  const st = state.sessions[name]
  if (st) st.lastSpawnAt = 0 // skip the minRespawnMs floor so it comes back immediately
  ensureSession(cfg, s, new Set()) // respawns with --resume (spawnedOnce already true)
  return sendJson(res, 200, { ok: true, name })
}

function startControlServer(cfg: SupervisorConfig): void {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/status') {
        return sendJson(res, 200, statusSnapshot(cfg))
      }
      if (req.method !== 'POST') {
        res.writeHead(404)
        return res.end('not found')
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad json' })
      }
      try {
        switch (url.pathname) {
          case '/sessions/precheck':
            return precheckSession(cfg, body, res)
          case '/sessions/add':
            return await withLock(() => addSession(cfg, body, res))
          case '/sessions/kill':
            return await withLock(() => killSession(cfg, body, res))
          case '/sessions/restart':
            return await withLock(() => restartSession(cfg, body, res))
          default:
            res.writeHead(404)
            return res.end('not found')
        }
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err) })
      }
    })()
  })
  server.listen(cfg.supervisorPort, '127.0.0.1', () => {
    log(`control API on http://127.0.0.1:${cfg.supervisorPort} (/status, /sessions/{add,kill,restart})`)
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv.find(a => !a.startsWith('-')) ?? 'up'
  const cfgIdx = argv.indexOf('--config')
  const cfgPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : join(ROUTER_DIR, 'supervisor.json')
  const once = argv.includes('--once')

  loadState()
  const cfg = loadConfig(cfgPath)

  if (cfg.sessions.length > 0 && !tmuxAvailable()) {
    log('tmux is required to supervise sessions but was not found. Install it: brew install tmux')
    if (cmd === 'up') process.exit(1)
  }

  if (cmd === 'status') return status(cfg)
  if (cmd === 'down') {
    down(cfg)
    try {
      unlinkSync(PIDFILE)
    } catch {
      /* none */
    }
    return
  }

  // up — singleton guard: refuse to start if another supervisor is alive.
  // Without this, repeated launches stack up (each spawns its own router and
  // fights over the same tmux sessions) — a runaway cascade.
  if (existsSync(PIDFILE)) {
    const oldPid = Number(readFileSync(PIDFILE, 'utf8').trim())
    if (pidAlive(oldPid)) {
      log(`another supervisor is already running (pid ${oldPid}). Refusing to start a second one.`)
      log(`Stop it first:  ./node_modules/.bin/tsx slack-supervisor.ts down   (or: kill ${oldPid})`)
      process.exit(1)
    }
  }
  writeFileSync(PIDFILE, String(process.pid))
  const clearPidfile = () => {
    try {
      unlinkSync(PIDFILE)
    } catch {
      /* already gone */
    }
  }
  process.on('exit', clearPidfile)

  log(`supervising (router:${cfg.router.enabled} sessions:${cfg.sessions.length} interval:${cfg.checkIntervalMs}ms)`)
  startControlServer(cfg)
  await withLock(() => tick(cfg))
  if (once) return
  const timer = setInterval(() => {
    void withLock(() => tick(cfg)).catch(err => log(`tick error: ${err}`))
  }, cfg.checkIntervalMs)
  // Keep the supervisor alive; leave children running on supervisor exit
  // (use `down` to tear them down explicitly).
  process.on('SIGTERM', () => {
    clearInterval(timer)
    log('supervisor stopping (children left running; use `down` to tear down)')
    process.exit(0)
  })
  process.on('SIGINT', () => {
    clearInterval(timer)
    log('supervisor stopping (children left running)')
    process.exit(0)
  })
}

main().catch(err => {
  log(`fatal: ${err}`)
  process.exit(1)
})
