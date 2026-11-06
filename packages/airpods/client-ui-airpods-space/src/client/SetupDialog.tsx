/**
 * First-run setup as four steps, each marked required or optional: recognition source, microphone, headset gestures,
 * and a live try. Required steps keep Next disabled until done.
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AirpodsSnapshot, Preferences } from '@dshub/airpods-space/types'
import type { NS } from './locales.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SourcePicker } from './SourcePicker.tsx'
import css from './SetupDialog.module.css'

export interface SetupDialogProps extends PropsLocale<typeof NS> {
  open: boolean
  snapshot: AirpodsSnapshot
  preferences: Preferences
  onDone: (preferences: Preferences) => void
  onLater: () => void
  onAllowMicrophone: () => void
  onGuide: () => void
  onOpenBluetooth: () => void
  /** Save the Aliyun key to the Keychain; resolves whether it was saved. */
  onSaveCloudKey: (apiKey: string) => Promise<boolean>
}

const STEPS = 4

/**
 * DSH-styled step-by-step setup.
 * @param props - current Host state, stored preferences and actions.
 * @returns the dialog, or nothing while closed.
 */
export function SetupDialog({ open, snapshot, preferences, onDone, onLater, onAllowMicrophone, onGuide, onOpenBluetooth,
  onSaveCloudKey, t }: SetupDialogProps) {
  const [step, setStep] = useState(0)
  const [source, setSource] = useState(preferences.asrSource)
  const microphone = snapshot.permissions.microphone
  const connected = snapshot.devices.find(device => device.connected)
  const doubleTap = connected ? connected.model === 'airpods-1' || connected.model === 'airpods-2' : true
  const heard = snapshot.talk !== 'idle'

  const required = step === 1 || (step === 2 && doubleTap)
  const canNext = step === 1 ? microphone === 'granted' : true
  const finish = (): void => { onDone({ ...preferences, asrSource: source, onboarded: true }) }

  const title = t(step === 0 ? 'setup.step1' : step === 1 ? 'setup.step2' : step === 2 ? 'setup.step3' : 'setup.step4')
  return (
    <Modal open={open} onClose={onLater} title={t('setup.title')} closeLabel={t('setup.later')}
      footer={<>
        <Button variant="ghost" onClick={onLater}>{t('setup.later')}</Button>
        {step > 0 && <Button variant="outline" onClick={() => { setStep(step - 1) }}>{t('setup.back')}</Button>}
        {step < STEPS - 1
          ? <Button variant="primary" autoFocus disabled={!canNext} onClick={() => { setStep(step + 1) }}>{t('setup.next')}</Button>
          : <Button variant="primary" autoFocus onClick={finish}>{t('setup.done')}</Button>}
      </>}>
      <div className={css.body}>
        <div className={css.progress} aria-hidden>
          {Array.from({ length: STEPS }, (_, index) => <span key={index} className={css.dot} data-state={index < step ? 'done' : index === step ? 'current' : 'todo'} />)}
        </div>
        <div className={css.stepHead}>
          <span className={css.stepCount}>{t('setup.stepOf', { step: String(step + 1), total: String(STEPS) })}</span>
          <span className={css.badge} data-required={required}>{t(required ? 'setup.required' : 'setup.optional')}</span>
        </div>
        <div className={css.stepTitle}>{title}</div>

        {step === 0 && <>
          <div className={css.detail}>{t('setup.step1Detail')}</div>
          <SourcePicker source={source} onSource={setSource} onSaveCloudKey={onSaveCloudKey} t={t} />
        </>}

        {step === 1 && <>
          <div className={css.detail}>{t('setup.step2Detail')}</div>
          <div className={css.status} data-ok={microphone === 'granted'}>
            <span className={css.title}>{t(microphone === 'granted' ? 'setup.microphoneGranted' : microphone === 'denied' ? 'permission.denied' : 'setup.microphoneDetail')}</span>
            {microphone !== 'granted' && <Button size="sm" variant="primary" onClick={onAllowMicrophone}>{t(microphone === 'denied' ? 'menu.settings' : 'menu.allow')}</Button>}
          </div>
          {microphone !== 'granted' && <div className={css.detail}>{t('setup.step2Blocked')}</div>}
        </>}

        {step === 2 && <>
          <div className={css.detail}>{t(doubleTap ? 'setup.step3DoubleTap' : 'setup.step3Press')}</div>
          {doubleTap && <ol className={css.list}>
            <li>{t('setup.step3a')}</li>
            <li>{t('setup.step3b', { name: connected?.name ?? 'AirPods' })}</li>
            <li>{t('setup.step3c')}</li>
          </ol>}
          <div className={css.actions}>
            {doubleTap && <Button size="sm" variant="outline" onClick={onOpenBluetooth}>{t('menu.bluetooth')}</Button>}
            <Button size="sm" variant="ghost" onClick={onGuide}>{t('menu.guide')}</Button>
          </div>
        </>}

        {step === 3 && <>
          <div className={css.detail}>{t(doubleTap ? 'setup.step4DoubleTap' : 'setup.step4Press')}</div>
          <div className={css.status} data-ok={heard}>
            <span className={css.title}>{t(!connected ? 'state.disconnected' : heard ? 'setup.step4Heard' : 'setup.step4Waiting')}</span>
          </div>
        </>}
      </div>
    </Modal>
  )
}
