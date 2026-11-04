/** @jsxImportSource @opentui/solid */
// opencode-session-sync · TUI PART (./tui export)
// Fase 2 — dashboard visual (/sync) + badge de estado en el footer de home.
// El núcleo NO se toca: todo pasa por el RPC del server part (src/rpc.ts, contrato exacto).
// Los errores declarados ('failed', data { message }) y los de sistema ('rpc.unavailable'…)
// llegan como rechazo de la llamada: toda RPC va con try/catch.
import { Plugin, usePlugin } from '@opencode/plugin/tui'
import { onCleanup, onMount, Show } from 'solid-js'
import { createSignal } from 'solid-js'
import { SessionSync } from './rpc.ts'

// === i18n local (el contexto TUI no expone ctx.t; dict propio es/en, es primero) ============
// Detección espejo de src/i18n.mjs (OPENCODE_LANG|LANG|LANGUAGE, fallback 'es') sin importar
// el núcleo: el TUI solo depende del RPC, nunca de cli.mjs/actions.mjs/backup.mjs.
// NOTA(presunción declarada): el TUI no expone el idioma del host en su contexto; se
// hereda la convención de entorno del núcleo.
type Lang = 'es' | 'en'
const i18n = {
  es: {
    title: 'Session Sync',
    'command.open': 'Abrir el panel Session Sync',
    'list.current': 'vigente',
    'last.label': 'Última copia',
    'last.none': 'Aún no hay copias — prepara la copia con: npx opencode-session-sync setup',
    plain: 'sin cifrar',
    provider: 'Proveedor',
    'encrypt.on': 'cifrado AES-256-GCM',
    'encrypt.off': 'sin cifrar',
    'status.synced': '● SYNCED',
    'status.none': '○ NO BACKUP',
    'status.error': '✗ ERR',
    'status.loading': '◌ …',
    'status.title.synced': 'Copias al día',
    'status.title.none': 'Sin copia de respaldo',
    'status.title.error': 'Session Sync no responde',
    'footer.help': 'b respaldar · r restaurar · j/k mover · q cerrar',
    'header.sub': 'Copias de respaldo de sesiones de OpenCode',
    'rows.header': 'Copias',
    'parts.count': '{n} partes',
    'error.host': 'Session Sync',
    machine: 'Máquina',
    busy: 'Respaldando copia…',
    busyRestore: 'Restaurando copia…',
    'plan.title': 'Plan de restauración',
    'plan.confirm': '¿Sobrescribir configuración y datos actuales con la copia seleccionada?',
    'restore.confirm': 'Restaurar ahora',
    cancel: 'Cancelar',
  },
  en: {
    title: 'Session Sync',
    'command.open': 'Open the Session Sync panel',
    'list.current': 'current',
    'last.label': 'Last copy',
    'last.none': 'No copies yet — get set up with: npx opencode-session-sync setup',
    plain: 'plain',
    provider: 'Provider',
    'encrypt.on': 'AES-256-GCM encrypted',
    'encrypt.off': 'unencrypted',
    'status.synced': '● SYNCED',
    'status.none': '○ NO BACKUP',
    'status.error': '✗ ERR',
    'status.loading': '◌ …',
    'status.title.synced': 'Copies up to date',
    'status.title.none': 'No backup yet',
    'status.title.error': 'Session Sync unreachable',
    'footer.help': 'b back up · r restore · j/k move · q close',
    'header.sub': 'OpenCode session backups',
    'rows.header': 'Copies',
    'parts.count': '{n} parts',
    'error.host': 'Session Sync',
    machine: 'Machine',
    busy: 'Backing up…',
    busyRestore: 'Restoring…',
    'plan.title': 'Restore plan',
    'plan.confirm': 'Overwrite the current configuration and data with the selected copy?',
    'restore.confirm': 'Restore now',
    cancel: 'Cancel',
  },
} satisfies Record<Lang, Record<string, string>>

function detectLang(): Lang {
  const env = typeof process !== 'undefined' ? process.env : {}
  const cand = (env.OPENCODE_LANG || env.LANG || env.LANGUAGE || '').toLowerCase()
  if (cand.startsWith('es')) return 'es'
  if (cand.startsWith('en')) return 'en'
  return 'es'
}

const LANG: Lang = detectLang()

type Key = keyof (typeof i18n)['es']
const t = (key: Key, params?: Record<string, string | number>): string => {
  let text: string = i18n[LANG][key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${k}}`, String(v))
  }
  return text
}

// === Shapes del RPC (JSON Schema output -> unknown, se acota una sola vez) ==================
interface SyncCfg {
  provider?: string
  localDir?: string
  parts?: string | number
  encrypt?: boolean
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
interface StatusOutput {
  lines: string
  info: { cfg?: SyncCfg; configDir?: string; dataDir?: string; last?: BackupEntry | null }
}

function errMessage(err: unknown): string {
  const shaped = err as { message?: string; data?: { message?: string } } | undefined
  return String(shaped?.data?.message || shaped?.message || err || 'error')
}

// === Estado compartido (badge del footer + dashboard leen lo mismo) =========================
type Busy = null | 'backup' | 'plan' | 'restore'
interface SyncView {
  ready: boolean // algún status/lista ya cargado
  loading: boolean
  failed: string | null
  status: StatusOutput | null
  list: BackupEntry[] | null
  busy: Busy
  selected: number
}

const [view, setView] = createSignal<SyncView>({
  ready: false,
  loading: true,
  failed: null,
  status: null,
  list: null,
  busy: null,
  selected: 0,
})

const patch = (partial: Partial<SyncView>) => setView((prev) => ({ ...prev, ...partial }))

// === Formato ================================================================================
function parseStamp(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!m) return null
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
}

function fmtDate(entry: BackupEntry): string {
  const parsed =
    entry.manifest?.date && !Number.isNaN(new Date(entry.manifest.date).getTime())
      ? new Date(entry.manifest.date)
      : parseStamp(entry.stamp)
  if (!parsed) return entry.stamp
  return new Intl.DateTimeFormat(LANG, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
}

function humanBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '0 B'
  const steps = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < steps.length - 1) {
    v /= 1024
    i++
  }
  return `${new Intl.NumberFormat(LANG, { maximumFractionDigits: 1 }).format(v)} ${steps[i]}`
}

// === API compartida: refresco + acciones, con toasts en todo fallo =========================
interface SyncApi {
  refresh(): Promise<void>
  backup(): Promise<void>
  planAndRestore(): Promise<void>
  move(delta: number): void
}

// La api se fabrica en setup (único sitio con el contexto vivo) y la leen los componentes
// por módulo: cada TUI corre una sola instancia del plugin.
let syncApi: SyncApi | undefined
const api = (): SyncApi => {
  if (!syncApi) throw new Error('session-sync: setup did not run')
  return syncApi
}

type TuiCtx = ReturnType<typeof usePlugin>

function loadInto(prev: SyncView, status: StatusOutput, list: unknown[]): SyncView {
  return {
    ...prev,
    ready: true,
    loading: false,
    failed: null,
    status,
    list: Array.isArray(list) ? (list as BackupEntry[]) : [],
    selected: 0,
  }
}

function createSyncApi(context: TuiCtx): SyncApi {
  const fetch = async () => {
    const [status, list] = await Promise.all([
      context.client.rpc(SessionSync).status({}) as Promise<StatusOutput>,
      context.client.rpc(SessionSync).listLocal({}) as Promise<BackupEntry[]>,
    ])
    return { status, list }
  }

  const silentRefresh = async () => {
    // Actualiza datos sin volver a la pantalla de carga.
    try {
      const { status, list } = await fetch()
      setView((prev) => ({ ...loadInto(prev, status, list), selected: prev.selected }))
    } catch (err) {
      setView((prev) => ({ ...prev, ready: true, loading: false, failed: errMessage(err) }))
    }
  }

  return {
    refresh: async () => {
      patch({ loading: !view().ready })
      await silentRefresh()
    },

    async backup() {
      if (view().busy !== null) return
      patch({ busy: 'backup' })
      context.ui.toast.show({ title: t('title'), message: t('busy'), variant: 'info' })
      try {
        const res = (await context.client.rpc(SessionSync).backup({ dryRun: false })) as { message: string }
        await silentRefresh()
        context.ui.toast.show({ title: t('title'), message: res.message, variant: 'success' })
      } catch (err) {
        context.ui.toast.show({ title: t('error.host'), message: errMessage(err), variant: 'error' })
      } finally {
        patch({ busy: null })
      }
    },

    async planAndRestore() {
      if (view().busy !== null) return
      patch({ busy: 'plan' })
      try {
        const plan = (await context.client.rpc(SessionSync).restore({ dryRun: true })) as { message: string }
        patch({ busy: null })
        // dryRun primero (plan), después confirmación explícita con overwrite.
        await context.ui.dialog.alert({ title: t('plan.title'), message: plan.message })
        const ok = await context.ui.dialog.confirm({
          title: t('plan.title'),
          message: t('plan.confirm'),
          label: { confirm: t('restore.confirm'), cancel: t('cancel') },
        })
        if (ok !== true) return
        patch({ busy: 'restore' })
        context.ui.toast.show({ title: t('title'), message: t('busyRestore'), variant: 'info' })
        const res = (await context.client.rpc(SessionSync).restore({ overwrite: true })) as { message: string }
        await silentRefresh()
        context.ui.toast.show({ title: t('title'), message: res.message, variant: 'success' })
      } catch (err) {
        context.ui.toast.show({ title: t('error.host'), message: errMessage(err), variant: 'error' })
      } finally {
        patch({ busy: null })
      }
    },

    move(delta: number) {
      const length = view().list?.length ?? 0
      if (length > 0) {
        const next = Math.min(length - 1, Math.max(0, view().selected + delta))
        patch({ selected: next })
      }
    },
  }
}

// === Componentes ============================================================================
/** Badge hiperminimal para el footer de la home. */
function SyncBadge() {
  const context = usePlugin()
  const theme = context.theme
  onMount(() => {
    void api().refresh()
  })

  const badge = () => {
    const v = view()
    if (v.loading && !v.ready) {
      return { text: t('status.loading'), fg: theme.text.faint, title: '' }
    }
    if (v.failed) {
      return { text: t('status.error'), fg: theme.text.feedback.error, title: t('status.title.error') }
    }
    if ((v.list?.length ?? 0) === 0) {
      return { text: t('status.none'), fg: theme.text.faint, title: t('status.title.none') }
    }
    return { text: t('status.synced'), fg: theme.text.feedback.success, title: t('status.title.synced') }
  }

  return (
    <text fg={badge().fg}>
      {badge().text}
    </text>
  )
}

/** Dashboard: la ruta de /sync. */
function Dashboard() {
  const context = usePlugin()
  const theme = context.theme
  onMount(() => {
    void api().refresh()
    // Layer del propio dashboard; se retira al desmontar el componente.
    context.keymap.layer(() => ({
      commands: [
        { id: 'opencode-session-sync.up', bind: 'k', run: () => api().move(-1) },
        { id: 'opencode-session-sync.down', bind: 'j', run: () => api().move(1) },
        { id: 'opencode-session-sync.up.arrow', bind: 'up', run: () => api().move(-1) },
        { id: 'opencode-session-sync.down.arrow', bind: 'down', run: () => api().move(1) },
        { id: 'opencode-session-sync.backup', bind: 'b', run: () => void api().backup() },
        { id: 'opencode-session-sync.restore', bind: 'r', run: () => void api().planAndRestore() },
        { id: 'opencode-session-sync.close', bind: 'q', run: () => context.ui.router.navigate({ type: 'home' }) },
        { id: 'opencode-session-sync.close.esc', bind: 'escape', run: () => context.ui.router.navigate({ type: 'home' }) },
      ],
    }))
  })
  onCleanup(() => {
    patch({ selected: 0 })
  })

  const v = () => view()
  const cfg = (): SyncCfg => v().status?.info.cfg ?? {}
  const last = (): BackupEntry | null => v().status?.info.last ?? v().list?.[0] ?? null
  const list = (): BackupEntry[] => (v().list ?? []).slice(0, 10)

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text.base}>{t('title')}</text>
        <text fg={theme.text.faint}>{t('header.sub')}</text>
      </box>

      <Show when={!v().loading || v().ready} fallback={<text fg={theme.text.faint}>{t('status.loading')}</text>}>
        <Show
          when={!v().failed}
          fallback={
            <box flexDirection="column" gap={1}>
              <text fg={theme.text.feedback.error}>{t('error.host')}</text>
              <text fg={theme.text.muted}>{v().failed ?? ''}</text>
              <text fg={theme.text.faint}>{t('footer.help')}</text>
            </box>
          }
        >
          <box flexDirection="column" gap={1}>
            <box flexDirection="column" gap={0}>
              <text fg={theme.text.muted}>
                {t('provider')}: {cfg().provider ?? 'local'} · {cfg().encrypt ? t('encrypt.on') : t('encrypt.off')} ·{' '}
                {t('parts.count', { n: String(cfg().parts ?? '—') })}
              </text>
            </box>

            <Show
              when={last()}
              fallback={<text fg={theme.text.muted}>{t('last.none')}</text>}
            >
              {(entry) => (
                <text fg={theme.text.base}>
                  {t('last.label')}: {fmtDate(entry())} · {humanBytes(entry().manifest?.size)} ·{' '}
                  {entry().manifest?.encrypted ? t('encrypt.on') : t('plain')}
                </text>
              )}
            </Show>

            <text fg={theme.text.muted}>
              {t('rows.header')} ({list().length})
            </text>
            {list().map((entry, i) => {
              const selected = i === v().selected
              return (
                <text fg={i === 0 ? theme.text.feedback.success : theme.text.muted}>
                  {`${selected ? '▸ ' : '  '}${fmtDate(entry)}  ${i === 0 ? t('list.current') : ''}${humanBytes(entry.manifest?.size)}`}
                </text>
              )
            })}
          </box>
        </Show>
      </Show>

      <box marginTop="auto" flexDirection="column" gap={0}>
        <text fg={theme.text.faint}>{t('footer.help')}</text>
      </box>
    </box>
  )
}

// === Definición del plugin ==================================================================
export default Plugin.define({
  id: 'opencode-session-sync',
  setup(context: Plugin.Context) {
    // API compartida (badge + dashboard leen por módulo) y idioma fijo al arranque.
    syncApi = createSyncApi(context as TuiCtx)

    // /sync en la paleta y en el menú slash: abre la ruta dashboard.
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'opencode-session-sync.open',
          title: t('command.open'),
          group: t('title'),
          palette: true,
          slash: { name: 'sync' },
          run: () => {
            context.ui.router.navigate({ type: 'plugin', name: 'dashboard' })
          },
        },
      ],
    }))

    // Ruta JSX del dashboard (la desregistramos al desactivar el plugin).
    const unregister = context.ui.router.register({
      name: 'dashboard',
      render: () => <Dashboard />,
    })

    // Badge del footer de la home: estado a un vistazo.
    const disposeSlot = context.ui.slot({
      append: 'home.footer.status',
      render: () => <SyncBadge />,
    })

    return () => {
      unregister()
      disposeSlot()
    }
  },
})
