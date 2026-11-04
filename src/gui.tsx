// opencode-session-sync · GUI PART (./gui-experimental export, experimental)
// Fase 2 — dashboard visual del Panel 'main' + Command + ComposerPill + TitlebarItem + SettingsPage.
// El núcleo NO se toca: todo pasa por el RPC del server part (src/rpc.ts, contrato exacto).
// Los errores declarados ('failed', { message }) llegan como rechazo del tipo MethodError.
import {
  Command,
  ComposerPill,
  createKeyed,
  Panel,
  Plugin,
  SettingsPage,
  Style,
  TitlebarItem,
  usePlugin,
} from '@opencode/plugin/gui'
import type {
  ComposerPillProps,
  ComposerPillView,
  Context as GuiContext,
  PanelProps,
  TitlebarItem as TitlebarItemView,
} from '@opencode/plugin/gui'
import { onMount, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
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

// === Estado compartido por ventana (pill, titlebar y panel leen lo mismo) =================
type Busy = null | 'backup' | 'restore-plan' | 'restore-run'
interface View {
  loading: boolean
  failed: string | null
  status: StatusOutput | null
  list: BackupEntry[] | null
  busy: Busy
  plan: RestorePlan | null
}

// Store a nivel de módulo: setup (ventana) lo crea antes de que renderice cualquier
// contribución. En el proceso main los componentes nunca se renderizan.
let view: View | undefined
let actions: SyncActions | undefined

const viewStore = (): View => {
  if (!view) throw new Error('session-sync: setup did not run')
  return view
}
const syncActions = (): SyncActions => {
  if (!actions) throw new Error('session-sync: setup did not run')
  return actions
}

interface SyncActions {
  refresh(ctx: Ctx, options?: { silent?: boolean }): Promise<void>
  /** Carga inicial con reintentos: el server puede tardar en registrar el RPC al arrancar. */
  boot(ctx: Ctx): void
  /** Refetch al abrir panel/ajustes: si no hay datos, no hay copia o pasaron >30s desde la última carga. */
  refreshIfStale(ctx: Ctx): void
  backup(ctx: Ctx): Promise<void>
  planRestore(ctx: Ctx): Promise<void>
  runRestore(ctx: Ctx): Promise<void>
  cancelPlan(): void
}
type Ctx = GuiContext

function errMessage(err: unknown): string {
  const shaped = err as { message?: string; data?: { message?: string } } | undefined
  return String(shaped?.data?.message || shaped?.message || err || 'error')
}

// rpc(SessionSync) tipa el output como unknown vía JSON Schema: acotamos al hacer la llamada.
function rpc(ctx: Ctx) {
  return ctx.client.rpc(SessionSync)
}

function createSyncActions(): SyncActions {
  // Reintentos de arranque: si la única refresh inicial rechaza (race con el registro
  // del RPC en el server), sin esto view.failed queda en true y el panel muestra '—'
  // para siempre. Backoff corto acotado: 8 intentos, ~15s de espera como máximo.
  const BOOT_ATTEMPTS = 8
  const BOOT_DELAYS_MS = [500, 1000, 2000, 4000, 4000, 4000, 4000]
  // Refetch al abrir panel/ajustes: a lo sumo uno cada 30s (sin timers infinitos cuando
  // todo va bien: si last != null y los datos tienen <30s, no se vuelve a pedir nada).
  const REFRESH_MIN_GAP_MS = 30_000
  let bootSeq = 0
  let bootTimer: ReturnType<typeof setTimeout> | undefined
  let lastOk = 0
  let lastTry = 0

  const fetchAll = async (ctx: Ctx) => {
    const [status, list] = await Promise.all([
      rpc(ctx).status({}) as Promise<StatusOutput>,
      rpc(ctx).listLocal({}) as Promise<BackupEntry[]>,
    ])
    viewStore().status = status
    viewStore().list = Array.isArray(list) ? list : []
    // La llamada respondió: se limpia el error (✗ ERR pasa a estado normal aunque
    // last sea null — sin copias todavía no es error).
    viewStore().failed = null
  }

  const load = async (ctx: Ctx, silent: boolean) => {
    lastTry = Date.now()
    if (!silent && !viewStore().status) viewStore().loading = true
    try {
      await fetchAll(ctx)
      lastOk = Date.now()
    } catch (err) {
      viewStore().failed = errMessage(err)
    } finally {
      viewStore().loading = false
    }
  }

  const boot = (ctx: Ctx) => {
    const seq = ++bootSeq
    clearTimeout(bootTimer)
    const attempt = (tries: number): void => {
      if (seq !== bootSeq) return // ctx.client cambió: otro boot tomó el relevo
      lastTry = Date.now()
      void fetchAll(ctx).then(
        () => {
          if (seq !== bootSeq) return
          lastOk = Date.now()
        },
        (err: unknown) => {
          if (seq !== bootSeq) return
          viewStore().failed = errMessage(err)
          if (tries + 1 >= BOOT_ATTEMPTS) return // el panel y su Retry quedan a cargo
          bootTimer = setTimeout(() => attempt(tries + 1), BOOT_DELAYS_MS[tries])
        },
      )
    }
    attempt(0)
  }

  const refreshIfStale = (ctx: Ctx) => {
    const v = viewStore()
    if (v.loading) return
    const now = Date.now()
    // Sin datos, sin copias o con datos de hace >30s: refetch silencioso, y como
    // mucho uno cada 30s (montes repetidos del panel no generan tormenta de RPC).
    if (now - lastTry < REFRESH_MIN_GAP_MS) return
    const stale =
      v.status === null ||
      (v.status.info.last ?? null) === null ||
      now - lastOk > REFRESH_MIN_GAP_MS
    if (!stale) return
    void load(ctx, true)
  }

  const toastError = (ctx: Ctx, err: unknown) => {
    ctx.toast.show({ variant: 'error', title: ctx.t('title'), description: errMessage(err) })
  }

  return {
    refresh: (ctx, options) => load(ctx, options?.silent === true),

    boot,

    refreshIfStale,

    async backup(ctx) {
      const busyToast = ctx.toast.show({ variant: 'loading', title: ctx.t('busy.backup'), persistent: true })
      viewStore().busy = 'backup'
      try {
        const res = (await rpc(ctx).backup({ dryRun: false })) as { message: string; info: object }
        await load(ctx, true)
        viewStore().plan = null
        busyToast.dismiss()
        ctx.toast.show({ variant: 'success', title: ctx.t('toast.backup.done'), description: res.message })
      } catch (err) {
        busyToast.dismiss()
        toastError(ctx, err)
      } finally {
        viewStore().busy = null
      }
    },

    async planRestore(ctx) {
      viewStore().busy = 'restore-plan'
      try {
        const res = (await rpc(ctx).restore({ dryRun: true })) as { message: string; res?: RestoreResultLike }
        viewStore().plan = res
        await load(ctx, true)
      } catch (err) {
        toastError(ctx, err)
      } finally {
        viewStore().busy = null
      }
    },

    async runRestore(ctx) {
      viewStore().busy = 'restore-run'
      const busyToast = ctx.toast.show({ variant: 'loading', title: ctx.t('busy.restore'), persistent: true })
      try {
        const res = (await rpc(ctx).restore({ overwrite: true })) as { message: string; res?: RestoreResultLike }
        viewStore().plan = null
        await load(ctx, true)
        busyToast.dismiss()
        ctx.toast.show({ variant: 'success', title: ctx.t('toast.restore.done'), description: res.message })
      } catch (err) {
        busyToast.dismiss()
        toastError(ctx, err)
      } finally {
        viewStore().busy = null
      }
    },

    cancelPlan() {
      viewStore().plan = null
    },
  }
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

function tag(ctx: Ctx): string {
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
  const v = viewStore()
  // Al abrir el panel: si la carga inicial nunca concluyó (race del arranque), no hay
  // copia aún o los datos son viejos, refetch silencioso (a lo sumo 1 cada 30s).
  onMount(() => syncActions().refreshIfStale(ctx))

  return (
    <div class="oss" style={accentVars(ctx)}>
      <div class="oss-head">
        <div class="oss-head-main">
          <span class={'oss-dot ' + (v.failed ? 'dead' : v.status ? 'live' : 'muted')} />
          <span class="oss-provider">{ctx.t('title')}</span>
        </div>
        <span class="oss-provider-sub">
          {ctx.t('provider')}: {v.status?.info.cfg?.provider ?? 'local'}
        </span>
      </div>
      <Show when={v.loading && !v.status} fallback={<DashboardBody ctx={ctx} />}>
        <Loading ctx={ctx} />
      </Show>
    </div>
  )
}

/** Contenido cuando la primera carga terminó (con datos o con error declarado). */
function DashboardBody(props: { ctx: Ctx }) {
  const ctx = props.ctx
  const v = viewStore()
  const last = (): BackupEntry | null => v.status?.info.last ?? v.list?.[0] ?? null
  const list = (): BackupEntry[] => (v.list ?? []).slice(0, 10)
  const cfg = (): SyncCfg => v.status?.info.cfg ?? {}

  return (
    <Show
      when={!v.failed}
      fallback={
        <div class="oss-error">
          <div class="oss-label">{ctx.t('error.title')}</div>
          <div class="oss-error-msg">{v.failed}</div>
          <div>
            <RetryButton ctx={ctx} />
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
              <div class="oss-last-date">{backupDate(entry(), tag(ctx))}</div>
              <div class="oss-meta">
                <span class="oss-meta-item">{humanBytes(entry().manifest?.size, tag(ctx))}</span>
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
          busy={v.busy === 'backup'}
          disabled={v.busy !== null}
          onClick={() => void syncActions().backup(ctx)}
        >
          {ctx.t('action.backup')}
        </ctx.ui.Button>
        <ctx.ui.Button
          icon="reset"
          busy={v.busy === 'restore-plan' || v.busy === 'restore-run'}
          disabled={v.busy !== null}
          onClick={() => void syncActions().planRestore(ctx)}
        >
          {ctx.t('action.restore')}
        </ctx.ui.Button>
      </div>

      <Show when={v.plan !== null}>
        <div class="oss-plan">
          <div class="oss-label">{ctx.t('plan.title')}</div>
          <pre>{v.plan?.message}</pre>
          <div class="oss-plan-foot">
            <ctx.ui.Button variant="danger" busy={v.busy === 'restore-run'} onClick={() => void syncActions().runRestore(ctx)}>
              {ctx.t('action.confirmRestore')}
            </ctx.ui.Button>
            <ctx.ui.Button variant="ghost-muted" disabled={v.busy === 'restore-run'} onClick={() => syncActions().cancelPlan()}>
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
            <div class="oss-row">
              <span class="oss-row-date">{backupDate(entry, tag(ctx))}</span>
              <Show when={i === 0 || entry.stamp === last()?.stamp}>
                <span class="oss-badge current">{ctx.t('list.current')}</span>
              </Show>
              <span class="oss-row-size">{humanBytes(entry.manifest?.size, tag(ctx))}</span>
            </div>
          ))}
        </div>
      </Show>

      <Show when={(v.list?.length ?? 0) === 0 && v.plan === null}>
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
  return (
    <div class="oss-loading">
      <props.ctx.ui.Loader size="small" />
      <span>{props.ctx.t('loading')}</span>
    </div>
  )
}

function RetryButton(props: { ctx: Ctx }) {
  return (
    <props.ctx.ui.Button variant="neutral" size="small" icon="refresh" onClick={() => void syncActions().refresh(props.ctx)}>
      {props.ctx.t('action.retry')}
    </props.ctx.ui.Button>
  )
}

/** Página de ajustes: resumen de la config sincronizada del status RPC (solo lectura). */
function SyncSettings() {
  const ctx = usePlugin()
  const v = viewStore()
  // La página lee view.status: si la carga inicial falló, sin esto mostraría '—' /
  // 'Cifrado: no' para siempre. Al abrirla, refetch silencioso si toca (≤1 cada 30s).
  onMount(() => syncActions().refreshIfStale(ctx))
  const cfg = (): SyncCfg => v.status?.info.cfg ?? {}
  const boolTell = (b: boolean | undefined) => (b ? ctx.t('settings.on') : ctx.t('settings.off'))
  return (
    <div class="oss-settings" style={accentVars(ctx)}>
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
        <span class="oss-settings-val">{v.status?.info.dataDir ?? '—'}</span>
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
      'command.need_session': 'Abre una sesión para ver el panel de Session Sync',
      'panel.title': 'Session Sync',
      provider: 'Proveedor',
      'last.label': 'Última copia',
      'last.none': 'Aún no hay copias',
      'parts.count': '{n} partes',
      'files.count': '{n} archivos',
      'encrypted.yes': 'Cifrado (AES-256-GCM)',
      'encrypted.no': 'Sin cifrar',
      'action.backup': 'Respaldar ahora',
      'action.restore': 'Restaurar',
      'action.confirmRestore': 'Restaurar ahora',
      'action.cancel': 'Cancelar',
      'action.retry': 'Reintentar',
      'busy.backup': 'Respaldando copia…',
      'busy.restore': 'Restaurando copia…',
      'plan.title': 'Plan de restauración',
      'list.title': 'Copias',
      'list.current': 'vigente',
      'empty.title': 'Configura tu primera copia',
      'empty.desc': 'Sin copias todavía. Prepara la configuración y aquí aparecerá tu historial con fecha, tamaño y cifrado.',
      'toast.backup.done': 'Copia de respaldo completada',
      'toast.restore.done': 'Restauración completada',
      'pill.synced': 'Al día',
      'pill.none': 'Sin copia',
      'pill.error': 'Error de sync',
      'pill.title': 'Session Sync',
      syncing: 'Sincronizando',
      'error.title': 'Session Sync no disponible',
      loading: 'Cargando…',
      'settings.title': 'Session Sync',
      'settings.overview': 'Resumen',
      'settings.provider': 'Proveedor',
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
      'command.need_session': 'Open a session to see the Session Sync panel',
      'panel.title': 'Session Sync',
      provider: 'Provider',
      'last.label': 'Last copy',
      'last.none': 'No copies yet',
      'parts.count': '{n} parts',
      'files.count': '{n} files',
      'encrypted.yes': 'Encrypted (AES-256-GCM)',
      'encrypted.no': 'Plain',
      'action.backup': 'Back up now',
      'action.restore': 'Restore',
      'action.confirmRestore': 'Restore now',
      'action.cancel': 'Cancel',
      'action.retry': 'Retry',
      'busy.backup': 'Backing up…',
      'busy.restore': 'Restoring…',
      'plan.title': 'Restore plan',
      'list.title': 'Copies',
      'list.current': 'current',
      'empty.title': 'Set up your first copy',
      'empty.desc': 'No backups yet. Run the setup wizard and your history — date, size and encryption — will show up here.',
      'toast.backup.done': 'Backup completed',
      'toast.restore.done': 'Restore completed',
      'pill.synced': 'Synced',
      'pill.none': 'No copy yet',
      'pill.error': 'Sync error',
      'pill.title': 'Session Sync',
      syncing: 'Syncing',
      'error.title': 'Session Sync unavailable',
      loading: 'Loading…',
      'settings.title': 'Session Sync',
      'settings.overview': 'Overview',
      'settings.provider': 'Provider',
      'settings.localDir': 'Local folder',
      'settings.parts': 'Part size',
      'settings.encrypt': 'AES-256-GCM encryption',
      'settings.dataDir': 'Data folder',
      'settings.on': 'yes',
      'settings.off': 'no',
    },
  },
  setup(ctx) {
    // Estado compartido de la ventana. Al ser módulo, también lo leen pill y titlebar.
    const [shared] = createStore<View>({
      loading: true,
      failed: null,
      status: null,
      list: null,
      busy: null,
      plan: null,
    })
    view = shared
    actions = createSyncActions()

    ctx.add(Style, panelCss)

    // Carga inicial y re-arranque cuando el server cambia (leemos ctx.client reactivo).
    // boot reintenta con backoff corto: una única llamada que rechaza (p. ej. el server
    // aún no registró el RPC) no puede dejar el panel en '—' para siempre.
    createKeyed(
      () => ctx.client,
      () => syncActions().boot(ctx),
    )

    ctx.add(Command, (): Command => ({
      id: 'open',
      title: ctx.t('command.open'),
      group: ctx.t('title'),
      slash: { name: 'sync' },
      // Siempre en el menú: en home no hay sesión y filtering lo sacaba; el run
      // decide qué hacer (abrir el panel en su sesión, o avisar con un toast).
      enabled: true,
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:main`, session)
        else ctx.toast.show({ title: ctx.t('command.need_session') })
      },
    }))

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

    ctx.add(
      TitlebarItem,
      (): TitlebarItemView | undefined => {
        const v = viewStore()
        // Pill solo mientras hay trabajo: no ruido permanente en la titlebar.
        if (v.busy === null) return undefined
        return { id: 'busysync', label: ctx.t('syncing'), icon: 'archive', busy: true, run: () => undefined }
      },
    )

    ctx.add(ComposerPill, {
      id: 'sync-status',
      show: (input: ComposerPillProps): ComposerPillView | undefined => {
        const v = viewStore()
        const base: Pick<ComposerPillView, 'icon' | 'title'> = { icon: 'archive', title: ctx.t('pill.title') }
        if (v.failed) return { ...base, label: ctx.t('pill.error'), tone: 'danger' }
        if (v.loading && !v.status) return undefined // primer arranque: no pill hasta saber nada
        const hasCopies = (v.list?.length ?? 0) > 0
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
