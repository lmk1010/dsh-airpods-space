/**
 * AirPods space settings in the macOS System Settings layout: a full-height sidebar of sections with colored icons,
 * and a page of grouped rounded cards on the right. Rows carry only labels, live state and controls; changes apply
 * immediately.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconMicrophoneOutlineRegular, Menu, Modal, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AirpodsSnapshot, DeviceInfo, GestureAction, Preferences } from '@dshub/airpods-space/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AirpodsKey, NS } from './locales.ts'
import { CloudKeyField } from './SourcePicker.tsx'
import { GuidePage } from './GuidePage.tsx'
import css from './SettingsDialog.module.css'

/** A short message with the one action that resolves it. */
export interface SettingsNotice { text: string; action: string; run: () => void }

export interface SettingsDialogProps extends PropsLocale<typeof NS> {
  open: boolean
  onClose: () => void
  snapshot: AirpodsSnapshot
  preferences: Preferences
  onPreferences: (preferences: Preferences) => void
  /** Something blocking talk, with the action that fixes it. */
  status?: SettingsNotice | undefined
  glyph: (size: number) => ReactNode
  deviceImage: (model: string, variant?: 'case' | 'buds') => Promise<string>
  onConnect: (address: string) => void
  onPair: () => void
  onDownload: () => void
  onCancelDownload: () => void
  onSpeak: (text: string) => void
  onChime: (name: 'done' | 'failed' | 'approval') => void
  onGuide: () => void
  onSetup: () => void
  onSaveCloudKey: (apiKey: string) => Promise<boolean>
  onOpenBluetooth: () => void
  /** Local model folder and its size in bytes. */
  modelInfo: () => Promise<{ dir: string; bytes: number }>
  onDeleteModel: () => Promise<void>
  onRevealModel: () => void
  cloudKeyStatus: () => Promise<{ saved: boolean; hint: string }>
  onDeleteCloudKey: () => Promise<void>
  onTestCloud: () => Promise<{ ok: boolean; ms: number; message: string }>
  onOpenLink: (target: 'aliyun-console' | 'aliyun-help') => void
  /** Page shown when the window opens. */
  initialPage?: SettingsPage | undefined
}

/** Settings sections, in sidebar order. */
export type SettingsPage = 'devices' | 'talk' | 'shortcuts' | 'recognition' | 'cloud' | 'model' | 'read' | 'guide'

type Page = SettingsPage

const WAVE = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>
// Sub-pages of Recognition, reached through its Manage buttons.
const SUBPAGES: Partial<Record<Page, Page>> = { cloud: 'recognition', model: 'recognition' }
const BOOK = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 4.5h9a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3V4.5Z" /><path d="M5 17a3 3 0 0 1 3-3h9M9 8.5h5" /></svg>
const BOLT = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" /></svg>
const SPEAKER = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4Z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>

const percent = (value: number | null): string => value === null ? '—' : `${value}%`

/**
 * Settings window opened from the headphone menu.
 * @param props - live state, preferences and actions.
 * @returns the dialog, or nothing while closed.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onClose, status, glyph, initialPage, t } = props
  const [page, setPage] = useState<Page>(initialPage ?? 'devices')
  const guideModel = (props.snapshot.devices.find(item => item.connected) ?? props.snapshot.devices[0])?.model ?? 'airpods-2'
  const [guideImage, setGuideImage] = useState('')
  useEffect(() => { void props.deviceImage(guideModel, 'buds').then(setGuideImage) }, [guideModel, props.deviceImage])
  useEffect(() => { if (open) setPage(initialPage ?? 'devices') }, [open, initialPage])
  const pages: readonly { id: Page; icon: ReactNode }[] = [
    { id: 'devices', icon: glyph(16) },
    { id: 'talk', icon: <IconMicrophoneOutlineRegular size={16} /> },
    { id: 'shortcuts', icon: BOLT },
    { id: 'recognition', icon: WAVE },
    { id: 'read', icon: SPEAKER },
    { id: 'guide', icon: BOOK },
  ]
  return (
    <Modal open={open} onClose={onClose} title={t('settings.title')} headless className={css.dialog ?? ''}>
      <div className={css.layout}>
        <nav className={css.sidebar} aria-label={t('settings.title')} onKeyDown={(event) => {
          // Up/Down walk the sidebar like the macOS settings list.
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const current = pages.findIndex(item => item.id === (SUBPAGES[page] ?? page))
          const next = pages[(current + (event.key === 'ArrowDown' ? 1 : pages.length - 1)) % pages.length]
          if (!next) return
          setPage(next.id)
          event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[pages.indexOf(next)]?.focus()
        }}>
          <div className={css.sidebarTitle}>{t('settings.title')}</div>
          {pages.map(item => (
            <button key={item.id} type="button" className={css.navItem} data-active={(SUBPAGES[page] ?? page) === item.id}
              aria-current={(SUBPAGES[page] ?? page) === item.id ? 'page' : undefined} onClick={() => { setPage(item.id) }}>
              <span className={css.navIcon}>{item.icon}</span>
              {t(`nav.${item.id}`)}
            </button>
          ))}
        </nav>
        <section className={css.pane}>
          <header className={css.paneHeader}>
            {SUBPAGES[page] ? (
              <div className={css.crumbs}>
                <button type="button" className={css.back} aria-label={t('setup.back')} onClick={() => { setPage(SUBPAGES[page] ?? page) }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <button type="button" className={css.crumbLink} onClick={() => { setPage(SUBPAGES[page] ?? page) }}>{t(`nav.${SUBPAGES[page] ?? page}`)}</button>
                <span className={css.crumbSep} aria-hidden>›</span>
                <h2 className={css.paneTitle}>{t(`nav.${page}`)}</h2>
              </div>
            ) : <h2 className={css.paneTitle}>{t(`nav.${page}`)}</h2>}
            <button type="button" className={css.close} aria-label={t('settings.done')} onClick={onClose}><IconCloseOutlineRegular size={16} /></button>
          </header>
          <div className={css.paneBody}>
            {status && (
              <Group>
                <Row label={status.text}><Button size="sm" variant="primary" onClick={status.run}>{status.action}</Button></Row>
              </Group>
            )}
            {page === 'devices' && <DevicesPage {...props} />}
            {page === 'talk' && <TalkPage {...props} />}
            {page === 'recognition' && <RecognitionPage {...props} onManageModel={() => { setPage('model') }} onManageCloud={() => { setPage('cloud') }} />}
            {page === 'cloud' && <CloudPage {...props} />}
            {page === 'model' && <ModelPage {...props} />}
            {page === 'read' && <ReadPage {...props} />}
            {page === 'shortcuts' && <ShortcutsPage {...props} />}
            {page === 'guide' && <GuidePage t={t} doubleTap={doubleTapModel(props)} headMotion={/^airpods-(pro|3|4|max)/.test(props.snapshot.devices.find(item => item.connected)?.model ?? '')}
              image={guideImage} glyph={glyph(48)} onOpenBluetooth={props.onOpenBluetooth} />}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (<>
    {title && <h3 className={css.groupTitle}>{title}</h3>}
    <div className={css.group}>{children}</div>
  </>)
}

function Row({ label, detail, leading, children }: {
  label: string
  detail?: string | undefined
  leading?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={css.row}>
      {leading}
      <span className={css.text}><span className={css.label}>{label}</span>{detail && <span className={css.detail}>{detail}</span>}</span>
      {children}
    </div>
  )
}

/** Product render for a model, loaded once per model key. */
function useDeviceImage(model: string | undefined, load: (model: string) => Promise<string>): string {
  const [image, setImage] = useState('')
  useEffect(() => {
    let live = true
    setImage('')
    if (model) void load(model).then((url) => { if (live) setImage(url) })
    return () => { live = false }
  }, [model, load])
  return image
}

function DeviceArt({ model, size, props }: { model: string; size: number; props: SettingsDialogProps }) {
  const image = useDeviceImage(model, props.deviceImage)
  return <span className={css.art} style={{ width: size, height: size }}>{image ? <img src={image} alt="" /> : props.glyph(Math.round(size * 0.6))}</span>
}

function DevicesPage(props: SettingsDialogProps) {
  const { snapshot, onConnect, onPair, t } = props
  const connected = snapshot.devices.find(device => device.connected)
  const connection = (device: DeviceInfo): string => snapshot.connecting === device.address ? t('menu.connecting')
    : snapshot.connectFailed === device.address ? t('dev.failed')
      : device.connected ? t('dev.connected') : t('dev.notConnected')
  const status = (device: DeviceInfo): string => `${productName(device.model, t)} · ${connection(device)}`
  return (<>
    {connected && (
      <div className={css.hero}>
        <DeviceArt model={connected.model} size={88} props={props} />
        <div className={css.heroText}>
          <span className={css.heroName}>{connected.name}</span>
          <span className={css.detail}>{productName(connected.model, t)}</span>
          <div className={css.batteries}>
            <Battery label={t('dev.left')} value={connected.batteries.left} />
            <Battery label={t('dev.right')} value={connected.batteries.right} />
            <Battery label={t('dev.case')} value={connected.batteries.case} />
          </div>
        </div>
      </div>
    )}
    <Group title={t('dev.mine')}>
      {snapshot.devices.length === 0 && (
        <div className={css.emptyDevices}>
          <span className={css.emptyGlyph}>{props.glyph(40)}</span>
          <span className={css.label}>{t('dev.none')}</span>
          <span className={css.detail}>{t('dev.noneDetail')}</span>
          <Button size="sm" variant="primary" onClick={onPair}>{t('dev.pairAction')}</Button>
        </div>
      )}
      {snapshot.devices.map(device => (
        <Row key={device.address} label={device.name} detail={status(device)}
          leading={<DeviceArt model={device.model} size={32} props={props} />}>
          {!device.connected && (
            <Button size="sm" variant="outline" disabled={snapshot.connecting !== undefined} onClick={() => { onConnect(device.address) }}>
              {t(snapshot.connectFailed === device.address ? 'dev.retry' : 'dev.connect')}
            </Button>
          )}
        </Row>
      ))}
    </Group>
    <Group>
      <Row label={t('dev.popup')} detail={t('dev.popupDetail')}>
        <Switch checked={props.preferences.popupCard} label={t('dev.popup')} onChange={(popupCard) => { props.onPreferences({ ...props.preferences, popupCard }) }} />
      </Row>
      <Row label={t('dev.nearby')} detail={t('dev.nearbyDetail')}>
        <Switch checked={props.preferences.nearbyUnpaired} disabled={!props.preferences.popupCard} label={t('dev.nearby')}
          onChange={(nearbyUnpaired) => { props.onPreferences({ ...props.preferences, nearbyUnpaired }) }} />
      </Row>
      <Row label={t('dev.pair')}><Button size="sm" variant="outline" onClick={onPair}>{t('dev.pairAction')}</Button></Row>
    </Group>
  </>)
}

function Battery({ label, value }: { label: string; value: number | null }) {
  return (
    <span className={css.battery}>
      <span className={css.batteryBar}><span style={{ width: `${value ?? 0}%` }} data-low={value !== null && value < 20} /></span>
      <span className={css.detail}>{label} {percent(value)}</span>
    </span>
  )
}

function TalkPage({ snapshot, preferences, onPreferences, onSetup, t }: SettingsDialogProps) {
  const doubleTap = doubleTapModel({ snapshot })
  return (<>
    <Group title={t('gesture.title')}>
      <Row label={t(doubleTap ? 'gesture.tapTalk' : 'gesture.pressOnce')} detail={t(doubleTap ? 'gesture.tapTalkAction' : 'gesture.talkAction')} />
      <Row label={t(doubleTap ? 'gesture.tapNext' : 'gesture.pressTwice')} detail={doubleTap ? t('gesture.tapNextDetail') : undefined}>
        <ActionPicker value={preferences.nextAction} t={t}
          onChange={(nextAction) => { onPreferences({ ...preferences, nextAction }) }} />
      </Row>
      <Row label={t(doubleTap ? 'gesture.tapPrevious' : 'gesture.pressThrice')} detail={doubleTap ? t('gesture.tapPreviousDetail') : undefined}>
        <ActionPicker value={preferences.previousAction} t={t}
          onChange={(previousAction) => { onPreferences({ ...preferences, previousAction }) }} />
      </Row>
      {!doubleTap && <Row label={t('gesture.hold')} detail={t('gesture.holdDetail')} />}
    </Group>
    <Group>
      <Row label={t('menu.sendMode')} detail={t(preferences.sendMode === 'voice' ? 'send.voiceDetail' : 'send.pauseDetail', { seconds: String(preferences.pauseSeconds) })}>
        <SegmentedControl id="airpods-send-mode" label={t('menu.sendMode')} value={preferences.sendMode}
          onChange={(sendMode) => { onPreferences({ ...preferences, sendMode }) }}
          options={[{ value: 'voice', label: t('send.voice') }, { value: 'pause', label: t('send.pause') }]} />
      </Row>
      {preferences.sendMode === 'pause' && (
        <Row label={t('send.wait')}>
          <SegmentedControl id="airpods-pause-seconds" label={t('send.wait')} value={String(preferences.pauseSeconds) as '1' | '2' | '3'}
            onChange={(value) => { onPreferences({ ...preferences, pauseSeconds: Number(value) as 1 | 2 | 3 }) }}
            options={(['1', '2', '3'] as const).map(value => ({ value, label: t('send.seconds', { seconds: value }) }))} />
        </Row>
      )}
      <Row label={t('menu.setup')}><Button size="sm" variant="outline" onClick={onSetup}>{t('settings.restart')}</Button></Row>
    </Group>
  </>)
}

const ACTIONS: readonly GestureAction[] = ['send', 'interrupt', 'steer', 'undo', 'read', 'none']

/** Dropdown of gesture actions, anchored like the composer's model selector. */
function ActionPicker({ value, onChange, t }: { value: GestureAction; onChange: (action: GestureAction) => void; t: SettingsDialogProps['t'] }) {
  const [open, setOpen] = useState(false)
  return (
    <Menu open={open} portal side="bottom" align="end" selectedIds={[value]} onClose={() => { setOpen(false) }}
      onSelect={(id) => { setOpen(false); onChange(id as GestureAction) }}
      items={ACTIONS.map(action => ({ id: action, label: t(`action.${action}`) }))}
      anchor={(
        <Button size="sm" variant="outline" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>
          {t(`action.${value}`)} ▾
        </Button>
      )} />
  )
}

function RecognitionPage({ snapshot, preferences, onPreferences, onManageModel, onManageCloud, t }: SettingsDialogProps & {
  onManageModel: () => void
  onManageCloud: () => void
}) {
  const model = snapshot.model
  const downloading = model.phase === 'downloading' || model.phase === 'preparing'
  const progress = model.totalBytes ? Math.floor((model.completedBytes ?? 0) / model.totalBytes * 100) : 0
  const choice = (id: Preferences['asrSource'], label: string, state: string, action?: ReactNode) => (
    <div className={css.row}>
      <button type="button" role="radio" aria-checked={preferences.asrSource === id} className={css.choice}
        onClick={() => { onPreferences({ ...preferences, asrSource: id }) }}>
        <span className={css.radio} data-on={preferences.asrSource === id} aria-hidden />
        <span className={css.text}><span className={css.label}>{label}</span><span className={css.detail}>{state}</span></span>
      </button>
      {action}
    </div>
  )
  return (
    <Group>
      <div role="radiogroup" aria-label={t('menu.asr')} className={css.radioGroup}>
        {choice('apple', t('rec.apple'), t(snapshot.permissions.speech === 'granted' ? 'rec.allowed' : snapshot.permissions.speech === 'denied' ? 'rec.denied' : 'rec.askFirst'))}
        {choice('cloud', t('rec.cloud'), t('rec.network'),
          <Button size="sm" variant="outline" onClick={onManageCloud}>{t('rec.manage')}</Button>)}
        {choice('local', t('rec.local'),
          model.phase === 'ready' ? t('rec.downloaded') : downloading ? t('rec.downloading', { percent: `${progress}%` }) : model.phase === 'failed' ? t('rec.downloadFailed') : t('rec.notDownloaded'),
          <Button size="sm" variant="outline" onClick={onManageModel}>{t('rec.manage')}</Button>)}
      </div>
    </Group>
  )
}

function ReadPage({ preferences, onPreferences, onSpeak, onChime, t }: SettingsDialogProps) {
  return (
    <Group>
      <Row label={t('read.reply')}>
        <Button size="sm" variant="ghost" onClick={() => { onSpeak(t('read.sample')) }}>{t('read.play')}</Button>
        <Switch checked={preferences.autoRead} label={t('read.reply')} onChange={(autoRead) => { onPreferences({ ...preferences, autoRead }) }} />
      </Row>
      <Row label={t('sound.listen')} detail={t('sound.listenDetail')}>
        <Switch checked={preferences.earcons} label={t('sound.listen')} onChange={(earcons) => { onPreferences({ ...preferences, earcons }) }} />
      </Row>
      <Row label={t('sound.approval')} detail={t('sound.approvalDetail')}>
        <Switch checked={preferences.readApproval} label={t('sound.approval')}
          onChange={(readApproval) => { onPreferences({ ...preferences, readApproval }) }} />
      </Row>
      <Row label={t('sound.progress')} detail={t('sound.progressDetail')}>
        <Switch checked={preferences.progress} label={t('sound.progress')}
          onChange={(progress) => { onPreferences({ ...preferences, progress }) }} />
      </Row>
      <Row label={t('sound.done')} detail={t('sound.doneDetail')}>
        <Button size="sm" variant="ghost" onClick={() => { onChime('done') }}>{t('read.play')}</Button>
        <Switch checked={preferences.doneSound} label={t('sound.done')}
          onChange={(doneSound) => { onPreferences({ ...preferences, doneSound }) }} />
      </Row>
    </Group>
  )
}

function ShortcutsPage({ preferences, onPreferences, t }: SettingsDialogProps) {
  const toggle = (key: 'quickInterrupt' | 'quickInsert' | 'voiceCommands', label: string, detail: string) => (
    <Row label={label} detail={detail}>
      <Switch checked={preferences[key]} label={label} onChange={(on) => { onPreferences({ ...preferences, [key]: on }) }} />
    </Row>
  )
  return (
    <Group>
      {toggle('quickInterrupt', t('quick.interrupt'), t('quick.interruptDetail'))}
      {toggle('quickInsert', t('quick.insert'), t('quick.insertDetail'))}
      {toggle('voiceCommands', t('quick.commands'), t('quick.commandsDetail'))}
    </Group>
  )
}

/** AirPods 1/2 talk with a double-tap (or no pair connected yet); later models press the stem. */
function doubleTapModel({ snapshot }: Pick<SettingsDialogProps, 'snapshot'>): boolean {
  const connected = snapshot.devices.find(device => device.connected)
  return !connected || connected.model === 'airpods-1' || connected.model === 'airpods-2'
}


const formatBytes = (bytes: number): string => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`

function ModelPage({ snapshot, preferences, onPreferences, onDownload, onCancelDownload, modelInfo, onDeleteModel, onRevealModel,
  t }: SettingsDialogProps) {
  const [info, setInfo] = useState<{ dir: string; bytes: number } | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const model = snapshot.model
  useEffect(() => { void modelInfo().then(setInfo) }, [model.phase, modelInfo])
  const downloading = model.phase === 'downloading' || model.phase === 'preparing'
  const progress = model.totalBytes ? Math.floor((model.completedBytes ?? 0) / model.totalBytes * 100) : 0
  const ready = model.phase === 'ready'
  const state = ready ? t('model.ready', { size: formatBytes(info?.bytes ?? 0) })
    : downloading ? t('rec.downloading', { percent: `${progress}%` })
      : model.phase === 'failed' ? t('rec.downloadFailed') : t('rec.notDownloaded')
  return (<>
    <Group>
      <Row label={t('model.name')} detail={state}>
        {downloading && <Button size="sm" variant="outline" onClick={onCancelDownload}>{t('settings.cancelAction')}</Button>}
        {!ready && !downloading && <Button size="sm" variant="primary" onClick={onDownload}>{t('model.download')}</Button>}
      </Row>
      {downloading && (
        <div className={css.row}><span className={css.progress}><span style={{ width: `${progress}%` }} /></span></div>
      )}
      <Row label={t('model.use')}>
        <Switch checked={preferences.asrSource === 'local'} disabled={!ready} label={t('model.use')}
          onChange={(on) => { onPreferences({ ...preferences, asrSource: on ? 'local' : 'apple' }) }} />
      </Row>
    </Group>
    <Group title={t('model.storage')}>
      <Row label={t('model.location')} detail={info?.dir ?? ''}>
        <Button size="sm" variant="outline" disabled={!ready} onClick={onRevealModel}>{t('model.reveal')}</Button>
      </Row>
      <Row label={t('model.delete')} detail={t('model.deleteDetail')}>
        {confirming
          ? <><Button size="sm" variant="ghost" onClick={() => { setConfirming(false) }}>{t('settings.cancelAction')}</Button>
            <Button size="sm" variant="primary" onClick={() => {
              setConfirming(false)
              if (preferences.asrSource === 'local') onPreferences({ ...preferences, asrSource: 'apple' })
              void onDeleteModel().then(() => modelInfo().then(setInfo))
            }}>{t('model.confirmDelete')}</Button></>
          : <Button size="sm" variant="outline" disabled={!ready && (info?.bytes ?? 0) === 0} onClick={() => { setConfirming(true) }}>{t('model.deleteAction')}</Button>}
      </Row>
    </Group>
  </>)
}

function CloudPage({ preferences, onPreferences, cloudKeyStatus, onSaveCloudKey, onDeleteCloudKey, onTestCloud,
  onOpenLink, t }: SettingsDialogProps) {
  const [key, setKey] = useState<{ saved: boolean; hint: string } | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [test, setTest] = useState<'idle' | 'testing' | { ok: boolean; ms: number; message: string }>('idle')
  const refresh = (): void => { void cloudKeyStatus().then(setKey) }
  useEffect(refresh, [cloudKeyStatus])
  const testText = test === 'idle' ? t('cloud.testIdle') : test === 'testing' ? t('cloud.testing')
    : test.ok ? t('cloud.testOk', { ms: String(test.ms) }) : t('cloud.testFailed', { message: test.message })
  return (<>
    <Group>
      <Row label={t('cloud.use')}>
        <Switch checked={preferences.asrSource === 'cloud'} disabled={key?.saved !== true} label={t('cloud.use')}
          onChange={(on) => { onPreferences({ ...preferences, asrSource: on ? 'cloud' : 'apple' }) }} />
      </Row>
    </Group>
    <Group title={t('cloud.key')}>
      <Row label={t('cloud.keyLabel')} detail={key === undefined ? '' : key.saved ? t('cloud.saved', { hint: key.hint }) : t('cloud.notSaved')}>
        <Button size="sm" variant="outline" onClick={() => { setEditing(!editing) }}>{t(key?.saved ? 'cloud.replace' : 'cloud.add')}</Button>
        {key?.saved && <Button size="sm" variant="ghost" onClick={() => {
          if (preferences.asrSource === 'cloud') onPreferences({ ...preferences, asrSource: 'apple' })
          void onDeleteCloudKey().then(refresh); setTest('idle')
        }}>{t('cloud.remove')}</Button>}
      </Row>
      {editing && <div className={css.sub}><CloudKeyField t={t} onSaveCloudKey={async (value) => {
        const ok = await onSaveCloudKey(value)
        if (ok) { setEditing(false); refresh(); setTest('idle') }
        return ok
      }} /></div>}
      <Row label={t('cloud.test')} detail={testText}>
        <Button size="sm" variant="outline" disabled={key?.saved !== true || test === 'testing'}
          onClick={() => { setTest('testing'); void onTestCloud().then(setTest) }}>{t('cloud.testAction')}</Button>
      </Row>
    </Group>
    <Group title={t('cloud.getKey')}>
      <Row label={t('cloud.console')} detail={t('cloud.consoleDetail')}>
        <Button size="sm" variant="outline" onClick={() => { onOpenLink('aliyun-console') }}>{t('cloud.open')}</Button>
      </Row>
      <Row label={t('cloud.help')}>
        <Button size="sm" variant="outline" onClick={() => { onOpenLink('aliyun-help') }}>{t('settings.view')}</Button>
      </Row>
    </Group>
  </>)
}

/** Apple's product name for a model key, localized; unknown keys show plain "AirPods". */
function productName(model: string, t: SettingsDialogProps['t']): string {
  const key = `product.${model}` as AirpodsKey
  return PRODUCT_KEYS.has(key) ? t(key) : 'AirPods'
}
const PRODUCT_KEYS = new Set<string>(['airpods-1', 'airpods-2', 'airpods-3', 'airpods-4', 'airpods-4-anc', 'airpods-pro', 'airpods-pro-2', 'airpods-pro-2-usbc', 'airpods-pro-3', 'airpods-max', 'airpods-max-usbc'].map(model => `product.${model}`))
