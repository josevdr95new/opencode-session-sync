// opencode-session-sync · GUI PART (./gui-experimental export, experimental)
// Fase 2 — dashboard visual del Panel 'main' + Command + ComposerPill + TitlebarItem + SettingsPage.
// El núcleo NO se toca: todo pasa por el RPC del server part (src/rpc.ts, contrato exacto).
// Los errores declarados ('failed', { message }) llegan como rechazo del tipo MethodError.
import {
  Command,
  ComposerPill,
  createKeyed,
  createLatest,
  createVisitState,
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  Style,
  usePlugin,
} from '@opencode/plugin/gui'
import type {
  ComposerPillProps,
  ComposerPillView,
  Context as GuiContext,
  MenuItem as MenuItemView,
  PanelProps,
  ServerRef,
} from '@opencode/plugin/gui'
// De 'solid-js' quedan Show (JSX) y onCleanup (solo para matar el timer pendiente del
// auto-retry: registrations end with the component). El path de datos usa las
// primitivas del HOST (createVisitState / createLatest / createKeyed) — la doc de GUI
// plugins ('Reactive primitives') manda preferir estos helpers a
// createStore/createEffect/onMount, cuyas mutaciones nunca re-disparaban el render del
// host entre copias del bundle.
import { Show, onCleanup } from 'solid-js'
import { SessionSync } from './rpc.ts'
import panelCss from './gui/sync.css?inline'

// === Shapes del RPC (JSON Schema output -> unknown, se acotan una sola vez) ================
interface SyncCfg {
  provider?: string
  localDir?: string
  parts?: string | number
  encrypt?: boolean
  owner?: string
  repo?: string
  /** Solo con provider 'gdrive' (src/rpc.ts setup): usuario y carpeta raíz validados. */
  user?: string
  folderId?: string
}
interface ManifestLike {
  date?: string
  machine?: string
  counts?: { files?: number; bytes?: number }
  parts?: number
  size?: number
  encrypted?: boolean
  checksum?: string
}
interface BackupEntry {
  dir: string
  stamp: string
  manifest: ManifestLike | null
}
interface StatusInfo {
  cfg?: SyncCfg
  configDir?: string
  dataDir?: string
  last?: BackupEntry | null
}
interface StatusOutput {
  lines: string
  info: StatusInfo
}
interface RestoreResultLike {
  files?: number
  skipped?: number
  bytes?: number
}
interface RestorePlan {
  message: string
  res?: RestoreResultLike
}
/** Evento 'progress' del RPC, acotado localmente (mismo estilo que SessionCreatedEvent):
 * el EventData de un schema JSON llega como Record<string, unknown> en los d.ts del
 * client, así que la forma exacta se declara aquí (contrato: src/rpc.ts events.progress). */
interface ProgressEventData {
  op: 'backup' | 'restore'
  phase: string
  percent: number
  bytes: number
  total: number
  detail?: string
}

/** Acotación en runtime del payload 'progress' (el schema JSON llega sin tipos en los
 * d.ts del client): valida los campos requeridos del contrato y descarta lo ajeno. */
function progressShape(raw: Readonly<Record<string, unknown>>): ProgressEventData | null {
  const { op, phase, percent, bytes, total, detail } = raw
  if (
    (op === 'backup' || op === 'restore') &&
    typeof phase === 'string' &&
    typeof percent === 'number' &&
    Number.isFinite(percent) &&
    typeof bytes === 'number' &&
    Number.isFinite(bytes) &&
    typeof total === 'number' &&
    Number.isFinite(total)
  ) {
    return {
      op,
      phase,
      percent,
      bytes,
      total,
      ...(typeof detail === 'string' ? { detail } : {}),
    }
  }
  return null
}

// === Estado POR INSTANCIA con primitivas reactivas del HOST ================================
// La doc oficial de GUI plugins ('Reactive primitives') manda preferir los helpers del
// host (createVisitState / createLatest / createKeyed) frente a createStore/createEffect
// de 'solid-js': sus mutaciones nunca re-disparaban el render del host (fetch y vista
// quedaban en copias distintas del bundle). Cada componente crea su propio
// createVisitState + createLatest: fetch y vista comparten SIEMPRE la misma instantánea
// reactiva. createLatest fetchea inmediatamente para el valor actual del source y otra
// vez en cada cambio (0 es key válido: Falsy = undefined|null|false), aborta la petición
// previa vía signal y expone latest/loading/error para leer en render.
type Busy = null | 'backup' | 'restore-plan' | 'restore-run'

/** Op del RPC que emite los eventos 'progress' de cada acción en curso: un evento cuyo
 * op no coincide con la acción en curso (o sin acción) se ignora. 'restore-plan' y
 * 'restore-run' viajan ambos como op 'restore' (dryRun incluido). */
const BUSY_OP: Record<Exclude<Busy, null>, ProgressEventData['op']> = {
  backup: 'backup',
  'restore-plan': 'restore',
  'restore-run': 'restore',
}

/** Fases conocidas del progreso (src/rpc.ts + emisiones del server): las fases futuras
 * que el core añada se muestran tal cual en vez de romper la GUI. */
const PROGRESS_PHASES = ['scan', 'pack', 'parts', 'read', 'unpack', 'extract'] as const

/** Fase de progreso localizada (i18n inline del plugin, claves progress.*). */
function progressPhase(ctx: Ctx, phase: string): string {
  return (PROGRESS_PHASES as readonly string[]).includes(phase)
    ? ctx.t(`progress.${phase}`)
    : phase
}

/** Snapshot que devuelve fetchSync: acotación local del output JSON del RPC. */
interface SyncData {
  status: StatusOutput | undefined
  list: BackupEntry[]
}

/** Forma del store que devuelve createLatest del host; se lee por campos en render. */
interface SyncSnapshot {
  readonly latest: SyncData | undefined
  readonly loading: boolean
  readonly error: unknown
}

type Ctx = GuiContext

/** Código HTTP que el auto-retry de arranque trata como "el server sigue arrancando".
 * En esa ventana el sidecar responde 503 a TODAS las rutas. */
const STARTING_STATUS = '503'

/** Mensaje de error para la UI. Errores tipados 'failed': el texto del server. Error de
 * transporte 'UnexpectedStatus: NNN': se parsea el código y, si es uno conocido (503),
 * se traduce con contexto ('error.starting') en vez del crudo 'ClientError: …'. Sin ctx
 * (logs de fetchSync, Pill) devuelve siempre el mensaje crudo. */
function errMessage(err: unknown, ctx?: Ctx): string {
  const shaped = err as { message?: string; data?: { message?: string } } | undefined
  const raw = String(shaped?.data?.message || shaped?.message || err || 'error')
  const status = /UnexpectedStatus: (\d+)/.exec(raw)?.[1]
  if (ctx && status === STARTING_STATUS) return ctx.t('error.starting')
  return raw
}

// rpc(SessionSync) tipa el output como unknown vía JSON Schema: acotamos al hacer la llamada.
function rpc(ctx: Ctx) {
  return ctx.client.rpc(SessionSync)
}

/** ¿El rechazo de una llamada fue por abort del cliente (botón Cancelar)? El transporte
 *  puede traer un error nominal 'AbortError' o un fallo genérico con la signal ya
 *  marcada: cubrimos ambos antes de tratarlo como error grave. */
function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  return (err as { name?: string } | null | undefined)?.name === 'AbortError'
}

// Una llamada colgada no puede dejar 'loading' en true para siempre: cada fetchSync
// acota ambas llamadas con un AbortController propio (timeout 15s) y hereda el abort
// del host (createLatest aborta por cambio de source o owner destruido vía signal).
const RPC_TIMEOUT_MS = 15_000

/** Motor de datos compartido (module-level, puro y sin estado): status + listLocal bajo
 * un único timeout. El rechazo sube como error de createLatest; el warn queda trazado. */
async function fetchSync(ctx: Ctx, signal: AbortSignal): Promise<SyncData> {
  const timeout = new AbortController()
  const inherit = () => timeout.abort(signal.reason)
  if (signal.aborted) timeout.abort(signal.reason)
  else signal.addEventListener('abort', inherit, { once: true })
  let timedOut = false
  const abort = setTimeout(() => {
    timedOut = true
    timeout.abort(new Error('RPC timeout (15s)'))
  }, RPC_TIMEOUT_MS)
  try {
    let out: [StatusOutput, BackupEntry[]]
    try {
      out = await Promise.all([
        rpc(ctx).status({}, { signal: timeout.signal }) as Promise<StatusOutput>,
        rpc(ctx).listLocal({}, { signal: timeout.signal }) as Promise<BackupEntry[]>,
      ])
    } catch (err) {
      // Traza remota: si la petición nunca sale de la ventana (o el server no responde),
      // el log de consola es lo único visible desde fuera. El renderer aplana objetos a
      // '[object Object]': JSON.stringify conserva el mensaje real en los logs.
      console.warn('session-sync: rpc failed', JSON.stringify({ message: errMessage(err) }))
      if (timedOut) throw new Error('RPC timeout (15s)')
      throw err
    }
    const [status, list] = out
    return { status, list: Array.isArray(list) ? list : [] }
  } finally {
    clearTimeout(abort)
    signal.removeEventListener('abort', inherit)
  }
}

// === Auto-reintento de la fase de arranque =================================================
// Al arrancar la app el sidecar tarda ~1-2s en estar listo y TODAS las rutas responden
// 503 en esa ventana: el primer fetch cae como 'ClientError: UnexpectedStatus: 503'.
// En vez de pintar el error de inmediato, se repite el fetch con backoff corto.

/** Backoff del auto-reintento: 4 intentos (1s → 2s → 4s → 8s). Con holgura cubre los
 * ~1-2s que el sidecar tarda en estar listo al arrancar. */
const BOOT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]

/** Tras el último intento, un chequeo corto para bajar `retrying` cuando el fetch final
 * se asienta; si aún está en vuelo, el spinner natural de loading lo sigue cubriendo. */
const BOOT_SETTLE_MS = 2_000

/** ¿Error de servidor-no-listo (reintentable en la fase de arranque)? El client de
 * transporte (@opencode/client) falla como ClientError con reason 'UnexpectedStatus'
 * (p.ej. 503 mientras el sidecar arranca), 'Transport' (red caída) o
 * 'MalformedResponse'; el timeout propio de fetchSync sale como 'RPC timeout (15s)'.
 * Los errores tipados 'failed' del RPC son respuestas LEGÍTIMAS del server (ya
 * arrancó): nunca se reintentan. */
function isBootError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'ClientError') return true
  const msg = err.message
  return (
    msg.startsWith('UnexpectedStatus:') || msg.startsWith('Transport') || msg.startsWith('RPC timeout')
  )
}

/** Auto-reintento del arranque con primitivas del host (factory compartida por el panel
 * y Settings). Si el PRIMER fetch (version 0) falla con un isBootError, repite el fetch
 * bumping la version con backoff BOOT_RETRY_DELAYS_MS (4 intentos). Cada tick solo
 * actúa si aún no hay snapshot exitoso (data.latest) y la version sigue siendo la que
 * la cadena dejó (guard contra bumps ajenos, con el valor esperado capturado).
 * `retrying` mantiene el spinner durante las esperas; el error solo se muestra al
 * agotar los intentos o si nunca fue reintentable. El timer pendiente muere con el
 * dueño del componente (onCleanup). */
function createBootRetry(input: {
  data: SyncSnapshot
  version: () => number
  setVersion: (next: number) => undefined
}): { retrying: () => boolean } {
  const { data, version, setVersion } = input
  const [retrying, setRetrying] = createVisitState(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let fired = false // UNA cadena por montaje: el auto-retry es solo la fase de arranque
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
  const attempt = (step: number, expected: number): void => {
    timer = setTimeout(
      () => {
        timer = undefined
        if (data.latest != null || version() !== expected) {
          setRetrying(false) // éxito, o la version cambió por otro camino: fin de la cadena
          return
        }
        if (step >= BOOT_RETRY_DELAYS_MS.length) {
          setRetrying(false) // agotado: el error pasa a verse con su botón Reintentar
          return
        }
        setVersion(version() + 1) // refetch reactivo: createLatest aborta el intento previo
        attempt(step + 1, expected + 1)
      },
      step < BOOT_RETRY_DELAYS_MS.length ? BOOT_RETRY_DELAYS_MS[step] : BOOT_SETTLE_MS,
    )
  }
  // Arranque de la cadena: la PRIMERA vez que aparece un error reintentable en la fase
  // de arranque (version 0). createKeyed es la forma doc-approved de reaccionar sin
  // createEffect; los re-fires con el mismo mensaje tras cada intento fallido no
  // re-arrancan nada: `fired` y el guard de version lo impiden.
  createKeyed(
    () => (data.error != null && isBootError(data.error) ? errMessage(data.error) : false),
    () => {
      if (fired || version() !== 0) return
      fired = true
      setRetrying(true)
      attempt(0, version())
    },
    { otherwise() {} },
  )
  return { retrying }
}

// === Abrir el panel (Command /sync y MenuItem comparten este helper) =======================
// En Home `sessions.current()` es undefined (también lo es sobre un draft). APIs oficiales
// del host (d.ts + doc GUI plugins): Servers.get('sidecar') / Sessions.list() (pestañas
// shell abiertas, no montadas) / Layout.open sobre sesiones no montadas / Layout.draft
// ({ server, directory, prompt }) y, para el directorio, el Data sincronizado del server
// (location.default / session.list / project.list). Si algo no se puede obtener con API
// oficial, no se inventa: toast 'command.need_session' (fallback inocuo).

/**
 * Evento 'session.created' del Data del server, acotado localmente (mismo estilo que el
 * resto de shapes del RPC): el proyecto no depende de @opencode/client y la inferencia
 * contextual del handler no llega desde los d.ts del host.
 */
interface SessionCreatedEvent {
  data: { sessionID: string; location?: { directory: string } }
}

/** Directorio real para el draft, del Data sincronizado del server (sin inventar rutas). */
async function draftDirectory(server: ServerRef): Promise<string | undefined> {
  const ok = (dir: unknown): string | undefined =>
    typeof dir === 'string' && dir.length > 0 ? dir : undefined
  // 1) El directorio por defecto del app en este server (LocationRef.directory).
  try {
    const def = ok(server.data.location.default()?.directory)
    if (def) return def
  } catch (err) {
    console.info('session-sync: data.location.default() unavailable', err)
  }
  // 2) La sesión más recientemente actualizada que el server conoce.
  try {
    const sessions = [...server.data.session.list()]
      .filter((s) => s.location?.directory)
      .sort((a, b) => b.time.updated - a.time.updated)
    const fromSession = ok(sessions[0]?.location?.directory)
    if (fromSession) return fromSession
  } catch (err) {
    console.info('session-sync: data.session.list() unavailable', err)
  }
  // 3) El proyecto con actividad más reciente (sync único, sin reintentos).
  try {
    await server.data.project.sync()
  } catch (err) {
    console.info('session-sync: data.project.sync() failed', err)
  }
  try {
    const projects = [...server.data.project.list()]
      .filter((p) => p.canonical)
      .sort((a, b) => b.time.active - a.time.active)
    return ok(projects[0]?.canonical)
  } catch (err) {
    console.info('session-sync: data.project.list() unavailable', err)
    return undefined
  }
}

/** Tras pedir el draft: escucha UNA VEZ 'session.created' en el Data del server y abre el
 * panel sobre la pestaña nueva cuando aparezca en sessions.list() (por id). Un poll corto
 * respalda el evento por si llega antes de registrarlo. Acotado a ~5s; sin listeners ni
 * timers huérfanos entre invocaciones repetidas de /sync. */
function watchDraftOpen(ctx: Ctx, server: ServerRef, directory: string): void {
  const known = new Set(ctx.sessions.list().map((s) => s.key)) // tomado ANTES del draft
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let off: (() => void) | undefined
  const finish = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    off?.()
  }
  const openIfId = (id: string): boolean => {
    const ref = ctx.sessions.list().find((s) => s.id === id)
    if (!ref) return false
    ctx.layout.open(`${ctx.id}:main`, ref)
    finish()
    return true
  }
  off = server.data.on('session.created', (event: SessionCreatedEvent) => {
    if (event.data.location?.directory !== directory) return
    if (!openIfId(event.data.sessionID)) console.info('session-sync: draft session not listed yet')
  })
  const deadline = Date.now() + 5_000 // acotado: el usuario puede re-invocar /sync
  const tick = () => {
    if (closed || Date.now() > deadline) {
      finish()
      return
    }
    const fresh = ctx.sessions
      .list()
      .find((s) => !known.has(s.key) && s.server.id === server.id)
    if (fresh) {
      ctx.layout.open(`${ctx.id}:main`, fresh)
      finish()
      return
    }
    timer = setTimeout(tick, 250)
  }
  tick()
}

/** Abre el panel 'main'. Orden: sesión montada → pestaña shell ya abierta (sin routing:
 * { tab: 'select', background: true }) → draft en el server del app → toast fallback. */
async function openPanel(ctx: Ctx): Promise<void> {
  // Sesión montada: camino normal, idéntico al previo (y sync: no hay await antes).
  const session = ctx.sessions.current()
  if (session) {
    ctx.layout.open(`${ctx.id}:main`, session)
    return
  }
  // Pestañas shell abiertas aunque ninguna esté montada (Home con pestañas):
  // 'select' + 'background' documentados en OpenOptions: mantiene la vista y abre la región.
  const tabs = ctx.sessions.list()
  if (tabs.length > 0) {
    // `list()` no documenta orden: la última como heurística de más reciente.
    ctx.layout.open(`${ctx.id}:main`, tabs[tabs.length - 1]!, { tab: 'select', background: true })
    return
  }
  // Home sin pestañas: draft en el server propio del Desktop (id 'sidecar').
  const server = ctx.servers.get('sidecar')
  if (!server || !server.connected) {
    console.info('session-sync: sidecar server not available/connected for a draft')
    ctx.toast.show({ title: ctx.t('command.need_session') })
    return
  }
  const directory = await draftDirectory(server)
  if (!directory) {
    console.info('session-sync: no directory from server data; keeping current behavior')
    ctx.toast.show({ title: ctx.t('command.need_session') })
    return
  }
  watchDraftOpen(ctx, server, directory) // listener registrado antes del draft
  ctx.layout.draft({ server: server.id, directory, prompt: '' })
}

// === Formato ==============================================================================
function parseStamp(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!m) return null
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
}

/** Fecha legible es/en: preferimos manifest.date (ISO) y degradamos al stamp. */
function backupDate(entry: BackupEntry, tag: string): string {
  const stamped =
    entry.manifest?.date && !Number.isNaN(new Date(entry.manifest.date).getTime())
      ? new Date(entry.manifest.date)
      : parseStamp(entry.stamp)
  if (!stamped) return entry.stamp
  return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }).format(stamped)
}

function humanBytes(n: number | undefined, tag: string): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n <= 0) return '0 B'
  const steps = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < steps.length - 1) {
    v /= 1024
    i++
  }
  const formatted = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(v)
  return `${formatted} ${steps[i]}`
}

function shortSha(checksum: string | undefined): string {
  const hex = String(checksum ?? '').replace(/^.*:/, '')
  return hex ? hex.slice(0, 8) : '—'
}

function localeTag(ctx: Ctx): string {
  const full = ctx.locale.locale()
  return full.startsWith('es') ? 'es' : 'en'
}

/** Colores propios de la vista: el resto del panel hereda color y tipografía del host. */
function accentVars(ctx: Ctx): Record<string, string> {
  const dark = ctx.appearance.mode() !== 'light'
  return {
    '--oss-ok': dark ? '#4ade80' : '#15803d',
    '--oss-bad': dark ? '#f87171' : '#b91c1c',
    '--oss-mono': ctx.appearance.font('mono'),
  }
}

const SETUP_HINT = 'npx opencode-session-sync setup'

// === Componentes ============================================================================
function SyncDashboard(_props: PanelProps) {
  const ctx = usePlugin()
  const tag = Math.random().toString(36).slice(2, 7)
  const [version, setVersion] = createVisitState(0)
  const [busy, setBusy] = createVisitState<Busy>(null)
  const [plan, setPlan] = createVisitState<RestorePlan | null>(null)
  const [progress, setProgress] = createVisitState<ProgressEventData | null>(null)
  // createLatest fetchea YA para version=0 (key válido: Falsy = undefined|null|false) y
  // otra vez en cada bump: sin boot local ni reintentos manuales (doc: prefer the
  // helpers to raw createEffect/createRenderEffect/createComputed).
  const data = createLatest(version, (v, signal) => fetchSync(ctx, signal))
  // Con ctx el mensaje gana contexto traducido (503 → 'error.starting'); el crudo queda
  // para los logs.
  const failed = (): string | null => (data.error != null ? errMessage(data.error, ctx) : null)
  const refresh = (): undefined => setVersion(version() + 1)
  // Auto-reintento de arranque: los 503 del sidecar (ventana de ~1-2s al arrancar la
  // app) se reintentan solos con backoff; mientras, el panel sigue en 'Cargando…'.
  const { retrying } = createBootRetry({ data, version, setVersion })
  // Spinner mientras el primer fetch sigue en vuelo Y durante las esperas del
  // auto-retry: el error solo se pinta tras agotar los intentos (o si nunca fue
  // reintentable).
  const showing = (): boolean => (retrying() && !data.latest) || (data.loading && !data.latest)
  // Diagnóstico del ciclo reactivo con createKeyed (forma doc-approved de reaccionar sin
  // createEffect): cada cambio del triple genera una línea 'render state' con su tag.
  // `equals` compara campo a campo porque el array es identidad nueva en cada lectura.
  createKeyed(
    () => [data.loading, data.latest != null, failed() != null] as const,
    (s) =>
      console.info(
        'session-sync: render state',
        JSON.stringify({ tag, loading: s[0], hasLatest: s[1], failed: s[2] }),
      ),
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] },
  )

  // Suscripción a los eventos 'progress' del RPC (API oficial del client:
  // events.on(name, handler) -> unsubscribe, d.ts de @opencode/client promise/rpc).
  // createKeyed sobre ctx.client: 'Read ctx.client where you call it. It changes after
  // that server restarts' — cada identidad de client re-arranca la suscripción y cada
  // run tiene su propio owner, cuyo onCleanup desuscribe. Los eventos solo aplican si
  // hay una acción en curso (busy) y su op coincide (BUSY_OP): sin acción o con un op
  // ajeno (o un evento tardío tras terminar) se descartan sin tocar el estado.
  createKeyed(
    () => ctx.client,
    (client) => {
      const off = client.rpc(SessionSync).events.on('progress', (event) => {
        const p = progressShape(event.data)
        if (!p) return
        const current = busy()
        if (current === null || BUSY_OP[current] !== p.op) return
        setProgress(p)
      })
      onCleanup(off)
    },
  )

  return (
    <div class="oss" style={accentVars(ctx)}>
      <div class="oss-head">
        <div class="oss-head-main">
          <span class={'oss-dot ' + (showing() ? 'muted' : failed() ? 'dead' : data.latest ? 'live' : 'muted')} />
          <span class="oss-provider">{ctx.t('title')}</span>
        </div>
        <span class="oss-provider-sub">
          {ctx.t('provider')}: {data.latest?.status?.info.cfg?.provider ?? 'local'}
        </span>
      </div>
      <Show
        when={showing()}
        fallback={
          <DashboardBody
            ctx={ctx}
            data={data}
            failed={failed}
            busy={busy}
            setBusy={setBusy}
            progress={progress}
            setProgress={setProgress}
            refresh={refresh}
            plan={plan}
            setPlan={setPlan}
            tag={tag}
          />
        }
      >
        <Loading ctx={ctx} />
      </Show>
    </div>
  )
}

/** Contenido cuando la primera carga terminó (con datos o con error declarado). Las
 * acciones viven aquí: cierran sobre props.setBusy / props.refresh / props.setPlan. */
function DashboardBody(props: {
  ctx: Ctx
  data: SyncSnapshot
  failed: () => string | null
  busy: () => Busy
  setBusy: (busy: Busy) => undefined
  progress: () => ProgressEventData | null
  setProgress: (progress: ProgressEventData | null) => undefined
  refresh: () => undefined
  plan: () => RestorePlan | null
  setPlan: (plan: RestorePlan | null) => undefined
  tag: string
}) {
  const ctx = props.ctx
  const data = props.data
  // Diagnóstico: si el flujo llega aquí, el <Show> del dashboard reaccionó al helper del
  // host. El cuerpo del componente corre una vez por montaje (sin hooks de solid-js).
  console.info(
    'session-sync: body render',
    JSON.stringify({ tag: props.tag, hasLatest: data.latest != null, failed: props.failed() != null }),
  )
  const last = (): BackupEntry | null =>
    data.latest?.status?.info.last ?? data.latest?.list[0] ?? null
  const list = (): BackupEntry[] => (data.latest?.list ?? []).slice(0, 10)
  // Cancelación (F2): UN AbortController POR operación; el botón Cancelar (visible solo
  // con progreso en marcha) ejecuta abort() sobre el de la acción en curso.
  const [ctrl, setCtrl] = createVisitState<AbortController | null>(null)
  const cancelCurrent = (): void => ctrl()?.abort()
  // Copia objetivo del plan de restauración (F1): stamp de la fila 'Restaurar esta
  // copia' o null = la más reciente (botón general). Vive SOLO mientras hay un plan
  // abierto: se guarda al planificar (planRestore) y se consume/limpia al confirmar
  // (runRestore), cancelar (cancelPlan), fallar el plan o borrar la copia (removeCopy).
  const [fromStamp, setFromStamp] = createVisitState<string | null>(null)
  const toastError = (err: unknown) => {
    ctx.toast.show({ variant: 'error', title: ctx.t('title'), description: errMessage(err, ctx) })
  }
  const toastCancelled = () => ctx.toast.show({ title: ctx.t('toast.cancelled') })

  // Restaurar solo tiene sentido con copias: sin ellas, los botones de restauración
  // (plan y confirmación) van deshabilitados; el server además respondería con su
  // error tipado 'failed'. Backup queda siempre disponible. La lib no expone prop
  // 'title' en Ui.Button (solo disabled/busy/class…): sin tooltip nativo.
  const hasCopies = (): boolean => (props.data.latest?.list.length ?? 0) > 0

  const backup = async () => {
    const busyToast = ctx.toast.show({ variant: 'loading', title: ctx.t('busy.backup'), persistent: true })
    props.setBusy('backup')
    const ctl = new AbortController()
    setCtrl(ctl)
    try {
      const res = (await rpc(ctx).backup({ dryRun: false }, { signal: ctl.signal })) as { message: string; info: object }
      props.refresh() // refetch reactivo: createLatest trae el estado con la copia nueva
      props.setPlan(null)
      busyToast.dismiss()
      ctx.toast.show({ variant: 'success', title: ctx.t('toast.backup.done'), description: res.message })
    } catch (err) {
      busyToast.dismiss()
      if (isAbort(err, ctl.signal)) toastCancelled()
      else toastError(err)
    } finally {
      props.setProgress(null) // la barra muere con la acción (éxito, fallo o cancelación)
      props.setBusy(null)
      setCtrl(null)
    }
  }

  // Plan de restauración: sin `from` (botón general) apunta a la copia más reciente;
  // con `from` (acción de fila 'Restaurar esta copia') a ESA copia. El stamp queda en
  // fromStamp hasta que el plan se confirma, cancela o falla.
  const planRestore = async (from?: string) => {
    props.setBusy('restore-plan')
    setFromStamp(from ?? null)
    const ctl = new AbortController()
    setCtrl(ctl)
    try {
      const res = (await rpc(ctx).restore(
        // rpc.restore: input { from?, dryRun?, overwrite? } (src/rpc.ts) — claves vacías
        // no viajan: sin from el server restaura la más reciente.
        { ...(from ? { from } : {}), dryRun: true },
        { signal: ctl.signal },
      )) as { message: string; res?: RestoreResultLike }
      props.setPlan(res)
      props.refresh()
    } catch (err) {
      setFromStamp(null) // sin plan no hay copia reservada
      if (isAbort(err, ctl.signal)) toastCancelled()
      else toastError(err)
    } finally {
      props.setProgress(null) // el plan (dryRun) también emite progreso op 'restore'
      props.setBusy(null)
      setCtrl(null)
    }
  }

  const runRestore = async () => {
    const from = fromStamp() // el MISMO stamp guardado al planificar (null = más reciente)
    props.setBusy('restore-run')
    const busyToast = ctx.toast.show({ variant: 'loading', title: ctx.t('busy.restore'), persistent: true })
    const ctl = new AbortController()
    setCtrl(ctl)
    try {
      const res = (await rpc(ctx).restore(
        { overwrite: true, ...(from ? { from } : {}) },
        { signal: ctl.signal },
      )) as { message: string; res?: RestoreResultLike }
      props.setPlan(null)
      setFromStamp(null) // plan cerrado: la copia deja de estar reservada
      props.refresh()
      busyToast.dismiss()
      ctx.toast.show({ variant: 'success', title: ctx.t('toast.restore.done'), description: res.message })
    } catch (err) {
      busyToast.dismiss()
      if (isAbort(err, ctl.signal)) toastCancelled()
      else toastError(err)
    } finally {
      props.setProgress(null)
      props.setBusy(null)
      setCtrl(null)
    }
  }

  const cancelPlan = () => {
    props.setPlan(null)
    setFromStamp(null) // plan descartado: la copia deja de estar reservada
  }

  /** Borrar una copia (acción de fila, F1): confirmación con la API oficial del host
   *  (host-apis.d.ts, 'Ask the user' → Dialogs.confirm: Promise<boolean>, opción danger
   *  para estilo destructivo), luego rpc.deleteLocal({ name }) → toast success con el
   *  message del server → refresco de la lista (el mismo bump de version que usa
   *  backup). El error tipado not_found (y failed) sube como rechazo: toast de error.
   *  Si la copia borrada era la del plan/fromStamp —o era la última y el plan apuntaba
   *  a 'latest'—, el plan queda huérfano y se limpia. */
  const removeCopy = async (name: string): Promise<void> => {
    if (props.busy() !== null) return
    const ok = await ctx.dialogs.confirm({ title: ctx.t('del.confirm', { name }), danger: true })
    if (!ok) return
    try {
      const res = (await rpc(ctx).deleteLocal({ name })) as { message: string }
      ctx.toast.show({ variant: 'success', title: ctx.t('del.done'), description: res.message })
      props.refresh()
      // data.latest aún es la instantánea PRE-refresco: length <= 1 = era la última copia.
      if (props.plan() !== null && (fromStamp() === name || (data.latest?.list.length ?? 0) <= 1)) {
        props.setPlan(null)
        setFromStamp(null)
      }
    } catch (err) {
      toastError(err)
    }
  }

  /** Abrir el dir de copias local en el explorador (F1): rpc.reveal con el enum CERRADO
   *  del core ('backups' — el server resuelve el path; nunca viaja uno del cliente).
   *  Toast solo en error. */
  const revealBackups = async (): Promise<void> => {
    if (props.busy() !== null) return
    try {
      await rpc(ctx).reveal({ kind: 'backups' })
    } catch (err) {
      toastError(err)
    }
  }

  return (
    <Show
      when={!props.failed()}
      fallback={
        <div class="oss-error">
          <div class="oss-label">{ctx.t('error.title')}</div>
          <div class="oss-error-msg">{props.failed()}</div>
          <div>
            <RetryButton ctx={ctx} onRetry={props.refresh} />
          </div>
        </div>
      }
    >
      <div class="oss-block">
        <div class="oss-label">{ctx.t('last.label')}</div>
        <Show
          when={last()}
          fallback={<span class="oss-provider-sub" style={{ 'font-style': 'italic' }}>{ctx.t('last.none')}</span>}
        >
          {(entry) => (
            <>
              <div class="oss-last-date">{backupDate(entry(), localeTag(ctx))}</div>
              <div class="oss-meta">
                <span class="oss-meta-item">{humanBytes(entry().manifest?.size, localeTag(ctx))}</span>
                <span class="oss-meta-item">{ctx.t('parts.count', { n: entry().manifest?.parts ?? 0 })}</span>
                <span class="oss-meta-item">
                  {entry().manifest?.encrypted ? ctx.t('encrypted.yes') : ctx.t('encrypted.no')}
                </span>
                <span class="oss-meta-item" style={{ 'font-family': 'var(--oss-mono)' }}>
                  sha {shortSha(entry().manifest?.checksum)}
                </span>
              </div>
              <Show when={(entry().manifest?.counts?.files ?? 0) > 0}>
                <div class="oss-provider-sub">
                  {ctx.t('files.count', { n: entry().manifest?.counts?.files ?? 0 })}
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>

      <div class="oss-actions">
        <ctx.ui.Button
          variant="contrast"
          icon="archive"
          busy={props.busy() === 'backup'}
          disabled={props.busy() !== null}
          onClick={() => void backup()}
        >
          {ctx.t('action.backup')}
        </ctx.ui.Button>
        <ctx.ui.Button
          icon="reset"
          busy={props.busy() === 'restore-plan' || props.busy() === 'restore-run'}
          disabled={props.busy() !== null || !hasCopies()}
          onClick={() => void planRestore()}
        >
          {ctx.t('action.restore')}
        </ctx.ui.Button>
        {/* Abre la SettingsPage del plugin ('sync'): API ctx.layout.settings(page) con el
            id contribuido en ctx.add(SettingsPage, { id: 'sync' }). Icono 'settings-gear'
            del catálogo del host (no existe 'settings' a secas en icon-name.d.ts). */}
        <ctx.ui.Button
          variant="ghost-muted"
          size="small"
          icon="settings-gear"
          onClick={() => ctx.layout.settings('sync')}
        >
          {ctx.t('settings.open')}
        </ctx.ui.Button>
      </div>

      {/* Progreso real (eventos RPC 'progress'): solo con acción en curso Y primer evento
          recibido; hasta entonces sigue viéndose el texto de busy existente (toast
          persistente + spinner del botón). El plan dryRun emite op 'restore' igual.
          El botón Cancelar vive aquí: solo existe mientras hay progreso en marcha y
          aborta el controlador de la acción en curso (la promesa libera al cliente). */}
      <Show when={props.busy() !== null ? props.progress() : null}>
        {(p) => (
          <div class="oss-progress-wrap">
            <div class="oss-progress-body">
              <div class="oss-progress">
                <div class="oss-progress-bar" style={{ width: `${p().percent}%` }} />
              </div>
              <div class="oss-progress-label">
                {Math.floor(p().percent)}% · {progressPhase(ctx, p().phase)} (
                {humanBytes(p().bytes, localeTag(ctx))} / {humanBytes(p().total, localeTag(ctx))})
              </div>
            </div>
            <ctx.ui.Button variant="ghost-muted" size="small" onClick={() => cancelCurrent()}>
              {ctx.t('action.cancel')}
            </ctx.ui.Button>
          </div>
        )}
      </Show>

      <Show when={props.plan() !== null}>
        <div class="oss-plan">
          <div class="oss-label">{ctx.t('plan.title')}</div>
          {/* plan.from (F1): solo cuando el plan vino de una fila concreta (fromStamp). */}
          <Show when={fromStamp()}>
            {(stamp) => <div class="oss-plan-from">{ctx.t('plan.from', { name: stamp() })}</div>}
          </Show>
          <pre>{props.plan()?.message}</pre>
          <div class="oss-plan-foot">
            <ctx.ui.Button
              variant="danger"
              busy={props.busy() === 'restore-run'}
              disabled={props.busy() !== null || !hasCopies()}
              onClick={() => void runRestore()}
            >
              {ctx.t('action.confirmRestore')}
            </ctx.ui.Button>
            <ctx.ui.Button variant="ghost-muted" disabled={props.busy() === 'restore-run'} onClick={() => cancelPlan()}>
              {ctx.t('action.cancel')}
            </ctx.ui.Button>
          </div>
        </div>
      </Show>

      <Show when={list().length > 0}>
        <div>
          <div class="oss-list-head">
            <div class="oss-label">{ctx.t('list.title')}</div>
            <span class="oss-provider-sub">{list().length}</span>
          </div>
          {list().map((entry, i) => (
            <div class="oss-item">
              <div class="oss-row">
                <span class="oss-row-date">{backupDate(entry, localeTag(ctx))}</span>
                <Show when={i === 0 || entry.stamp === last()?.stamp}>
                  <span class="oss-badge current">{ctx.t('list.current')}</span>
                </Show>
                <span class="oss-row-size">{humanBytes(entry.manifest?.size, localeTag(ctx))}</span>
              </div>
              {/* Acciones por copia (F1): plan sobre ESA copia / borrar con confirmación
                  del host / abrir el dir de copias (reveal, enum cerrado). Las tres
                  deshabilitadas mientras hay una acción en curso — mismo patrón disabled
                  que los botones generales. Iconos del catálogo: 'reset', 'trash' y
                  'folder' ('folder-open' NO existe en icon-name.d.ts). */}
              <div class="oss-row-actions">
                <ctx.ui.Button
                  variant="ghost-muted"
                  size="small"
                  icon="reset"
                  disabled={props.busy() !== null}
                  onClick={() => void planRestore(entry.stamp)}
                >
                  {ctx.t('row.restore')}
                </ctx.ui.Button>
                <ctx.ui.Button
                  variant="danger"
                  size="small"
                  icon="trash"
                  disabled={props.busy() !== null}
                  onClick={() => void removeCopy(entry.stamp)}
                >
                  {ctx.t('row.delete')}
                </ctx.ui.Button>
                <ctx.ui.Button
                  variant="ghost-muted"
                  size="small"
                  icon="folder"
                  disabled={props.busy() !== null}
                  onClick={() => void revealBackups()}
                >
                  {ctx.t('row.open')}
                </ctx.ui.Button>
              </div>
            </div>
          ))}
        </div>
      </Show>

      <Show when={(data.latest?.list.length ?? 0) === 0 && props.plan() === null}>
        <div class="oss-empty">
          <div class="oss-empty-icon">
            <ctx.ui.Icon name="archive" size="normal" />
          </div>
          <div class="oss-empty-title">{ctx.t('empty.title')}</div>
          <div class="oss-empty-desc">{ctx.t('empty.desc')}</div>
          <div class="oss-empty-cmd">{SETUP_HINT}</div>
        </div>
      </Show>
    </Show>
  )
}

function Loading(props: { ctx: Ctx }) {
  // Diagnóstico: cuántas veces (re)renderiza el spinner visible (el cuerpo corre una vez
  // por montaje, sin hooks de solid-js en el path de datos).
  console.info('session-sync: loading render')
  return (
    <div class="oss-loading">
      <props.ctx.ui.Loader size="small" />
      <span>{props.ctx.t('loading')}</span>
    </div>
  )
}

function RetryButton(props: { ctx: Ctx; onRetry: () => undefined }) {
  return (
    <props.ctx.ui.Button variant="neutral" size="small" icon="refresh" onClick={() => props.onRetry()}>
      {props.ctx.t('action.retry')}
    </props.ctx.ui.Button>
  )
}

/** Página de ajustes: tarjeta de conexión con las TRES secciones de proveedor SIEMPRE
 *  visibles y apiladas (sin condicionales de estado), encima del resumen de la config
 *  del status RPC. Este superficie pinta el contenido UNA VEZ al montar y NO
 *  re-renderiza (los onClick sí disparan; los <Show> de estado nunca cambian), así que:
 *  - el feedback es EXCLUSIVAMENTE por toasts (ctx.toast.show vive fuera del render);
 *  - los inputs son NO CONTROLADOS: el DOM del campo conserva el texto del usuario y
 *    `onInput` solo lo espeja en una signal para leerlo en el onClick — sin binding
 *    reactivo de `value` (aquí no reaccionaría; value va fijo y vacío);
 *  - tras un setup exitoso NO se refresca nada en pantalla: el toast basta y el estado
 *  conectado se verá al reabrir Settings. Los SECRETS (token, clientId/clientSecret/
 *  refreshToken) viajan SOLO en la llamada setup: nunca se registran en logs ni en
 *  toasts; el server enmascara el token en el message de éxito. */
function SyncSettings() {
  const ctx = usePlugin()
  const tag = Math.random().toString(36).slice(2, 7)
  const [version, setVersion] = createVisitState(0)
  // Patrón idéntico al dashboard con SU createVisitState+createLatest propios:
  // createLatest fetchea solo al montar. Mismo auto-retry de arranque que el panel
  // (factory compartida createBootRetry): la página se auto-repara si abrió antes de
  // que el sidecar estuviera listo; agotados los intentos, sus filas quedan con los
  // '—' de siempre.
  const data = createLatest(version, (v, signal) => fetchSync(ctx, signal))
  const { retrying } = createBootRetry({ data, version, setVersion })
  // Traza de montaje equivalente al 'settings boot local' viejo: el cuerpo del
  // componente corre una vez por montaje, sin onMount.
  console.info('session-sync: settings init', JSON.stringify({ tag }))
  const cfg = (): SyncCfg => data.latest?.status?.info.cfg ?? {}
  const boolTell = (b: boolean | undefined) => (b ? ctx.t('settings.on') : ctx.t('settings.off'))
  // Línea de estado conectado según el proveedor guardado (gdrive: 'Conectado a Google
  // Drive · {{user}}', con cfg.user o, si falta, folderId — igual que el core).
  const statusText = (): string => {
    const provider = cfg().provider
    if (provider === 'github')
      return ctx.t('settings.connected', { repo: `${cfg().owner ?? '?'}/${cfg().repo ?? '?'}` })
    if (provider === 'gdrive') return ctx.t('settings.gdrive.connected', { user: cfg().user ?? cfg().folderId ?? '?' })
    return `${ctx.t('settings.local.active')}${cfg().localDir ? ` · ${cfg().localDir}` : ''}`
  }

  // === Campos de las secciones (UNCONTROLLED, espejo del texto del DOM) ======================
  // Sin binding reactivo de `value` (value fijo ''): el usuario teclea, el DOM del input
  // guarda su propio texto y onInput lo copia a la signal; el onClick de cada botón lee
  // la signal. Campos vacíos no viajan: el server conserva los previos de sync.json.
  const [owner, setOwner] = createVisitState('')
  const [repo, setRepo] = createVisitState('')
  const [token, setToken] = createVisitState('')
  // Credenciales OAuth de Google Drive: los TRES primeros son secrets (campos password,
  // jamás logueados ni incluidos en toasts); folderName es opcional y no sensible.
  const [clientId, setClientId] = createVisitState('')
  const [clientSecret, setClientSecret] = createVisitState('')
  const [refreshToken, setRefreshToken] = createVisitState('')
  const [folderName, setFolderName] = createVisitState('')

  // Conectar un proveedor: rpc.setup + feedback SOLO por toast (éxito con el message del
  // server —ya enmascarado—, fallo con el error traducido). Sin busy ni refresco de
  // pantalla: este superficie no re-renderiza y el estado conectado se verá al reabrir
  // Settings. La traza queda en consola como diagnóstico remoto (renderer.log).
  const connect = async (provider: 'local' | 'github' | 'gdrive'): Promise<void> => {
    console.info('session-sync: connect', provider)
    try {
      // Campos vacíos no viajan: el server conserva los previos de sync.json.
      const input: {
        provider: 'local' | 'github' | 'gdrive'
        owner?: string
        repo?: string
        token?: string
        clientId?: string
        clientSecret?: string
        refreshToken?: string
        folderName?: string
        test?: boolean
      } =
        provider === 'github'
          ? {
              provider,
              ...(owner() ? { owner: owner() } : {}),
              ...(repo() ? { repo: repo() } : {}),
              token: token(),
              test: true,
            }
          : provider === 'gdrive'
            ? {
                provider,
                clientId: clientId(),
                clientSecret: clientSecret(),
                refreshToken: refreshToken(),
                ...(folderName() ? { folderName: folderName() } : {}),
                test: true,
              }
            : { provider, test: true }
      const res = (await rpc(ctx).setup(input)) as { lines: string; cfg: SyncCfg; message?: string }
      ctx.toast.show({
        variant: 'success',
        title: ctx.t('settings.save.done'),
        description: res.message, // el server ya enmascara los secrets (solo cola visible)
      })
    } catch (err) {
      ctx.toast.show({
        variant: 'error',
        title: ctx.t('settings.save.error'),
        description: errMessage(err, ctx),
      })
    }
  }

  return (
    <div class="oss-settings" style={accentVars(ctx)}>
      <Show when={retrying() && data.latest == null}>
        <Loading ctx={ctx} />
      </Show>

      {/* Tarjeta de conexión: acción principal de la página, encima del resumen. La línea
          de estado conectado solo aparece con datos (cfg provider/localDir). */}
      <div class="oss-setup">
        <div class="oss-label">{ctx.t('settings.setup')}</div>
        <Show when={data.latest != null}>
          <div class="oss-setup-status">
            <ctx.ui.Icon
              name={cfg().provider === 'github' ? 'github' : cfg().provider === 'gdrive' ? 'cloud-upload' : 'folder'}
              size="small"
            />
            {/* El login/user del último setup no se persiste en la GUI: se muestra del
                cfg (owner/repo para github; user o folderId para gdrive — formato
                documentado en settings.connected / settings.gdrive.connected). */}
            <span>{statusText()}</span>
          </div>
        </Show>
        {/* --- Las TRES secciones siempre visibles y apiladas: cero condicionales de
            estado (este superficie no re-renderiza; cualquier <Show> de picked nunca
            cambiaría). El título visible es nuestro (el prop label del host es solo
            para screen readers); el prop label se pasa igual para accesibilidad. Los
            inputs son NO CONTROLADOS: value fijo vacío (el DOM conserva el texto del
            usuario) + onInput espejando a la signal que lee el onClick. */}
        <div class="oss-field">
          <span class="oss-field-label">{ctx.t('settings.section.local')}</span>
          <span class="oss-provider-sub">{ctx.t('settings.section.local.desc')}</span>
          <Show when={cfg().localDir}>
            <span class="oss-provider-sub">{ctx.t('settings.local.dir', { dir: cfg().localDir ?? '' })}</span>
          </Show>
          <div class="oss-setup-foot">
            <ctx.ui.Button variant="contrast" icon="folder" onClick={() => void connect('local')}>
              {ctx.t('settings.local.use')}
            </ctx.ui.Button>
          </div>
        </div>
        <div class="oss-field">
          <span class="oss-field-label">{ctx.t('settings.section.github')}</span>
          <span class="oss-provider-sub">{ctx.t('settings.section.github.desc')}</span>
        </div>
        <div class="oss-setup-fields">
          <div class="oss-field">
            <span class="oss-field-label">{ctx.t('settings.gh.owner')}</span>
            <ctx.ui.TextInput
              label={ctx.t('settings.gh.owner')}
              value=""
              onInput={setOwner}
              placeholder={cfg().owner || 'owner'}
            />
          </div>
          <div class="oss-field">
            <span class="oss-field-label">{ctx.t('settings.gh.repo')}</span>
            <ctx.ui.TextInput
              label={ctx.t('settings.gh.repo')}
              value=""
              onInput={setRepo}
              placeholder={cfg().repo || 'repo'}
            />
          </div>
          <div class="oss-field">
            <span class="oss-field-label">{ctx.t('settings.gh.token')}</span>
            <ctx.ui.TextInput
              label={ctx.t('settings.gh.token')}
              type="password"
              value=""
              onInput={setToken}
              placeholder="ghp_… / github_pat_…"
            />
          </div>
          <div class="oss-setup-foot">
            <ctx.ui.Button variant="contrast" icon="github" onClick={() => void connect('github')}>
              {ctx.t('settings.connect')}
            </ctx.ui.Button>
          </div>
        </div>
        <div class="oss-field">
          <span class="oss-field-label">{ctx.t('settings.section.gdrive')}</span>
          <span class="oss-provider-sub">{ctx.t('settings.section.gdrive.desc')}</span>
        </div>
        <div class="oss-setup-fields">
          <div class="oss-field">
            <span class="oss-field-label">{ctx.t('settings.gdrive.client.id')}</span>
            <ctx.ui.TextInput
              label={ctx.t('settings.gdrive.client.id')}
              value=""
              onInput={setClientId}
              placeholder="…apps.googleusercontent.com"
            />
          </div>
          <div class="oss-field">
            <span class="oss-field-label">{ctx.t('settings.gdrive.client.secret')}</span>
            <ctx.ui.TextInput
              label={ctx.t('settings.gdrive.client.secret')}
              type="password"
              value=""
              onInput={setClientSecret}
              placeholder="GOCSPX-…"
            />
          </div>
          <div class="oss-field">
            <span class="oss-field-label">{ctx.t('settings.gdrive.refresh.token')}</span>
            <ctx.ui.TextInput
              label={ctx.t('settings.gdrive.refresh.token')}
              type="password"
              value=""
              onInput={setRefreshToken}
              placeholder="1//…"
            />
          </div>
          <div class="oss-field">
            <span class="oss-field-label">{ctx.t('settings.gdrive.folder.name')}</span>
            <ctx.ui.TextInput
              label={ctx.t('settings.gdrive.folder.name')}
              value=""
              onInput={setFolderName}
              placeholder="OpenCode"
            />
          </div>
          <div class="oss-setup-foot">
            <ctx.ui.Button variant="contrast" icon="cloud-upload" onClick={() => void connect('gdrive')}>
              {ctx.t('settings.connect')}
            </ctx.ui.Button>
          </div>
        </div>
      </div>

      <div class="oss-settings-row">
        <span class="oss-settings-key">{ctx.t('settings.provider')}</span>
        <span class="oss-settings-val">{cfg().provider ?? 'local'}</span>
      </div>
      <div class="oss-settings-row">
        <span class="oss-settings-key">{ctx.t('settings.localDir')}</span>
        <span class="oss-settings-val">{cfg().localDir ?? '—'}</span>
      </div>
      <div class="oss-settings-row">
        <span class="oss-settings-key">{ctx.t('settings.parts')}</span>
        <span class="oss-settings-val">{String(cfg().parts ?? '—')}</span>
      </div>
      <div class="oss-settings-row">
        <span class="oss-settings-key">{ctx.t('settings.encrypt')}</span>
        <span class="oss-settings-val">{boolTell(cfg().encrypt)}</span>
      </div>
      <div class="oss-settings-row">
        <span class="oss-settings-key">{ctx.t('settings.dataDir')}</span>
        <span class="oss-settings-val">{data.latest?.status?.info.dataDir ?? '—'}</span>
      </div>
    </div>
  )
}

// === Definición del plugin ==================================================================
export default Plugin.define({
  i18n: {
    es: {
      title: 'Session Sync',
      'command.open': 'Abrir Session Sync',
      'menu.open': 'Session Sync',
      'menu.open.description': 'Respaldos y restauración',
      'command.need_session': 'Abre una sesión para ver el panel de Session Sync',
      'panel.title': 'Session Sync',
      provider: 'Proveedor',
      'last.label': 'Última copia',
      'last.none': 'Aún no hay copias',
      'parts.count': '{{n}} partes',
      'files.count': '{{n}} archivos',
      'encrypted.yes': 'Cifrado (AES-256-GCM)',
      'encrypted.no': 'Sin cifrar',
      'action.backup': 'Respaldar ahora',
      'action.restore': 'Restaurar',
      'settings.open': 'Configuración',
      'action.confirmRestore': 'Restaurar ahora',
      'action.cancel': 'Cancelar',
      'action.retry': 'Reintentar',
      'busy.backup': 'Respaldando copia…',
      'busy.restore': 'Restaurando copia…',
      'progress.scan': 'escaneando',
      'progress.pack': 'comprimiendo',
      'progress.parts': 'escribiendo partes',
      'progress.read': 'leyendo copia',
      'progress.unpack': 'descifrando',
      'progress.extract': 'restaurando ficheros',
      'plan.title': 'Plan de restauración',
      'plan.from': 'Restaurando la copia {{name}}',
      'list.title': 'Copias',
      'list.current': 'vigente',
      'row.restore': 'Restaurar esta copia',
      'row.delete': 'Borrar',
      'row.open': 'Abrir carpeta',
      'del.confirm': '¿Eliminar la copia {{name}}? Esta acción no se puede deshacer.',
      'del.done': 'Copia eliminada',
      'empty.title': 'Configura tu primera copia',
      'empty.desc': 'Sin copias todavía. Prepara la configuración y aquí aparecerá tu historial con fecha, tamaño y cifrado.',
      'toast.backup.done': 'Copia de respaldo completada',
      'toast.restore.done': 'Restauración completada',
      'toast.cancelled': 'Operación cancelada',
      'pill.synced': 'Al día',
      'pill.none': 'Sin copia',
      'pill.error': 'Error de sync',
      'pill.title': 'Session Sync',
      'error.title': 'Session Sync no disponible',
      'error.starting': 'El server está arrancando… reintentando',
      loading: 'Cargando…',
      'settings.title': 'Session Sync',
      'settings.overview': 'Resumen',
      'settings.setup': 'Conexión',
      'settings.provider': 'Proveedor',
      'settings.section.local': 'Almacenamiento local',
      'settings.section.local.desc': 'Guarda las copias en una carpeta de este equipo.',
      'settings.section.github': 'GitHub',
      'settings.section.github.desc': 'Sube las copias cifradas a un repo privado tuyo.',
      'settings.section.gdrive': 'Google Drive',
      'settings.section.gdrive.desc': 'Sube las copias a una carpeta de tu Drive.',
      'settings.gh.owner': 'Usuario u organización',
      'settings.gh.repo': 'Repositorio',
      'settings.gh.token': 'Token de acceso (GitHub)',
      'settings.gdrive.client.id': 'ID de cliente (OAuth)',
      'settings.gdrive.client.secret': 'Secreto de cliente',
      'settings.gdrive.refresh.token': 'Refresh token',
      'settings.gdrive.folder.name': 'Nombre de carpeta (opcional)',
      'settings.connect': 'Conectar',
      'settings.connected': 'Conectado a GitHub · {{repo}}',
      'settings.gdrive.connected': 'Conectado a Google Drive · {{user}}',
      'settings.local.active': 'Almacenamiento local activo',
      'settings.local.use': 'Usar local',
      'settings.local.dir': 'Carpeta actual: {{dir}}',
      'settings.save.done': 'Configuración guardada',
      'settings.save.error': 'No se pudo guardar la configuración',
      'settings.localDir': 'Carpeta local',
      'settings.parts': 'Tamaño de parte',
      'settings.encrypt': 'Cifrado AES-256-GCM',
      'settings.dataDir': 'Carpeta de datos',
      'settings.on': 'sí',
      'settings.off': 'no',
    },
    en: {
      title: 'Session Sync',
      'command.open': 'Open Session Sync',
      'menu.open': 'Session Sync',
      'menu.open.description': 'Backups and restore',
      'command.need_session': 'Open a session to see the Session Sync panel',
      'panel.title': 'Session Sync',
      provider: 'Provider',
      'last.label': 'Last copy',
      'last.none': 'No copies yet',
      'parts.count': '{{n}} parts',
      'files.count': '{{n}} files',
      'encrypted.yes': 'Encrypted (AES-256-GCM)',
      'encrypted.no': 'Plain',
      'action.backup': 'Back up now',
      'action.restore': 'Restore',
      'settings.open': 'Settings',
      'action.confirmRestore': 'Restore now',
      'action.cancel': 'Cancel',
      'action.retry': 'Retry',
      'busy.backup': 'Backing up…',
      'busy.restore': 'Restoring…',
      'progress.scan': 'scanning',
      'progress.pack': 'compressing',
      'progress.parts': 'writing parts',
      'progress.read': 'reading backup',
      'progress.unpack': 'decrypting',
      'progress.extract': 'restoring files',
      'plan.title': 'Restore plan',
      'plan.from': 'Restoring backup {{name}}',
      'list.title': 'Copies',
      'list.current': 'current',
      'row.restore': 'Restore this copy',
      'row.delete': 'Delete',
      'row.open': 'Open folder',
      'del.confirm': 'Delete backup {{name}}? This cannot be undone.',
      'del.done': 'Backup deleted',
      'empty.title': 'Set up your first copy',
      'empty.desc': 'No backups yet. Run the setup wizard and your history — date, size and encryption — will show up here.',
      'toast.backup.done': 'Backup completed',
      'toast.restore.done': 'Restore completed',
      'toast.cancelled': 'Operation cancelled',
      'pill.synced': 'Synced',
      'pill.none': 'No copy yet',
      'pill.error': 'Sync error',
      'pill.title': 'Session Sync',
      'error.title': 'Session Sync unavailable',
      'error.starting': 'Server is starting… retrying',
      loading: 'Loading…',
      'settings.title': 'Session Sync',
      'settings.overview': 'Overview',
      'settings.setup': 'Connection',
      'settings.provider': 'Provider',
      'settings.section.local': 'Local storage',
      'settings.section.local.desc': 'Keep backups in a folder on this machine.',
      'settings.section.github': 'GitHub',
      'settings.section.github.desc': 'Upload encrypted backups to your own private repo.',
      'settings.section.gdrive': 'Google Drive',
      'settings.section.gdrive.desc': 'Upload backups to a folder in your Drive.',
      'settings.gh.owner': 'User or organization',
      'settings.gh.repo': 'Repository',
      'settings.gh.token': 'Access token (GitHub)',
      'settings.gdrive.client.id': 'Client ID (OAuth)',
      'settings.gdrive.client.secret': 'Client secret',
      'settings.gdrive.refresh.token': 'Refresh token',
      'settings.gdrive.folder.name': 'Folder name (optional)',
      'settings.connect': 'Connect',
      'settings.connected': 'Connected to GitHub · {{repo}}',
      'settings.gdrive.connected': 'Connected to Google Drive · {{user}}',
      'settings.local.active': 'Local storage active',
      'settings.local.use': 'Use local',
      'settings.local.dir': 'Current folder: {{dir}}',
      'settings.save.done': 'Settings saved',
      'settings.save.error': 'Could not save settings',
      'settings.localDir': 'Local folder',
      'settings.parts': 'Part size',
      'settings.encrypt': 'AES-256-GCM encryption',
      'settings.dataDir': 'Data folder',
      'settings.on': 'yes',
      'settings.off': 'no',
    },
  },
  setup(ctx) {
    // Pill espejo del setup con primitivas del host (SIN estado global de módulo): el
    // Desktop puede cargar el composer en copias separadas del bundle y esta instancia
    // vive y muere con el setup. createLatest fetchea YA (pv=0 es key válido) y otra vez
    // en cada bump; createKeyed sobre ctx.client re-arranca el fetch cuando el server
    // cambia (sustituye al boot con reintentos de la store rota).
    const [pv, setPv] = createVisitState(0)
    const pill = createLatest(pv, (v, signal) => fetchSync(ctx, signal))

    ctx.add(Style, panelCss)

    // Re-arranque en cambio de server: ctx.client cambia de identidad → bump → refetch.
    createKeyed(
      () => ctx.client,
      () => setPv(pv() + 1),
    )

    ctx.add(Command, (): Command => ({
      id: 'open',
      title: ctx.t('command.open'),
      group: ctx.t('title'),
      slash: { name: 'sync' },
      // Siempre en el menú: en home no hay sesión y filtering lo sacaba; run resuelve el
      // camino (montada / pestaña abierta / draft desde home) vía openPanel(ctx).
      enabled: true,
      // Descubrimiento en la paleta: se lista al abrirla sin escribir nada.
      featured: true,
      run: () => openPanel(ctx),
    }))

    // Lanzador en el menú **+** del lateral (session.panel): segunda vía visible para
    // abrir el panel. keybind = id publicado del Command (`<plugin>.open`) → el menú
    // muestra su atajo. El id 'open' (mismo que el Command) es válido: único en el plugin.
    ctx.add(
      MenuItem,
      (): MenuItemView => ({
        menu: 'session.panel',
        id: 'open',
        title: ctx.t('menu.open'),
        icon: 'archive',
        description: ctx.t('menu.open.description'),
        keybind: `${ctx.id}.open`,
        // Getters: `opened` lo lee el host en su scope reactivo (la pestaña ya está
        // abierta → los lanzadores la omiten; el menú + la sigue listando).
        get opened() {
          const session = ctx.sessions.current()
          return !!session && ctx.layout.state(`${ctx.id}:main`, session) !== 'closed'
        },
        run: () => {
          void openPanel(ctx)
        },
      }),
    )

    const mainTab = {
      id: 'main',
      get title() {
        return ctx.t('panel.title')
      },
      closable: 'compact' as const,
      fallback: true,
    }

    ctx.add(Panel, {
      id: 'main',
      region: 'side',
      mobile: {
        get title() {
          return ctx.t('panel.title')
        },
        order: 45,
        kind: 'menu',
        icon: 'archive',
      },
      list: (input) => (input.open.includes('main') ? [mainTab] : []),
      render: (props) => <SyncDashboard {...props} />,
    })

    // TitlebarItem 'busysync' retirado: era cosmético y dependía de un estado global de
    // busy imposible entre instancias separadas del bundle (la doc permite retirar la
    // contribución). Su clave i18n huérfana 'syncing' se borró con él.

    ctx.add(ComposerPill, {
      id: 'sync-status',
      show: (input: ComposerPillProps): ComposerPillView | undefined => {
        const failed = pill.error != null ? errMessage(pill.error) : null
        const base: Pick<ComposerPillView, 'icon' | 'title'> = { icon: 'archive', title: ctx.t('pill.title') }
        if (failed) return { ...base, label: ctx.t('pill.error'), tone: 'danger' }
        if (pill.loading && pill.latest == null) return undefined // primer fetch en vuelo: no pill hasta saber nada
        const hasCopies = (pill.latest?.list.length ?? 0) > 0
        if (!hasCopies) return { ...base, label: ctx.t('pill.none'), tone: 'warning' }
        return {
          ...base,
          label: ctx.t('pill.synced'),
          tone: 'success',
          run: () => ctx.layout.open(`${ctx.id}:main`, input.session),
        }
      },
    })

    ctx.add(SettingsPage, {
      id: 'sync',
      icon: 'archive',
      get title() {
        return ctx.t('settings.title')
      },
      get entries() {
        return [{ id: 'overview', title: ctx.t('settings.overview'), keywords: 'sync backup restore encryption provider' }]
      },
      render: () => <SyncSettings />,
    })
  },
})
