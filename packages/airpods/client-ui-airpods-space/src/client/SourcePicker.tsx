/** Speech recognition source choice with the Aliyun key field, shared by setup and settings. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Preferences } from '@lmk1010/airpods-space/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './SetupDialog.module.css'

export interface SourcePickerProps extends PropsLocale<typeof NS> {
  source: Preferences['asrSource']
  onSource: (source: Preferences['asrSource']) => void
  /** Save the Aliyun key to the Keychain; resolves whether it was saved. */
  onSaveCloudKey: (apiKey: string) => Promise<boolean>
}

const SOURCES: readonly { id: Preferences['asrSource']; title: 'setup.apple' | 'setup.cloud' | 'setup.local'; detail: 'setup.appleDetail' | 'setup.cloudDetail' | 'setup.localDetail' }[] = [
  { id: 'apple', title: 'setup.apple', detail: 'setup.appleDetail' },
  { id: 'cloud', title: 'setup.cloud', detail: 'setup.cloudDetail' },
  { id: 'local', title: 'setup.local', detail: 'setup.localDetail' },
]

/**
 * Radio list of recognition sources; choosing Aliyun reveals the key field.
 * @param props - selected source, change handler and key saver.
 * @returns the picker.
 */
export function SourcePicker({ source, onSource, onSaveCloudKey, t }: SourcePickerProps) {
  return (<>
    <div className={css.options} role="radiogroup">
      {SOURCES.map(option => (
        <button key={option.id} type="button" role="radio" aria-checked={source === option.id}
          className={css.option} data-selected={source === option.id} onClick={() => { onSource(option.id) }}>
          <span className={css.radio} aria-hidden />
          <span className={css.text}>
            <span className={css.title}>{t(option.title)}</span>
            <span className={css.detail}>{t(option.detail)}</span>
          </span>
        </button>
      ))}
    </div>
    {source === 'cloud' && <CloudKeyField onSaveCloudKey={onSaveCloudKey} t={t} />}
  </>)
}

/**
 * Aliyun API key field; the key goes straight to the Keychain and is never kept in the page.
 * @param props - key saver and dictionary.
 * @returns the field with its hint.
 */
export function CloudKeyField({ onSaveCloudKey, t }: Pick<SourcePickerProps, 'onSaveCloudKey' | 't'>) {
  const [key, setKey] = useState('')
  const [keyState, setKeyState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  return (
    <div className={css.keyRow}>
      <Input type="password" autoComplete="off" spellCheck={false} placeholder={t('setup.keyPlaceholder')} value={key}
        onChange={(event) => { setKey(event.currentTarget.value); setKeyState('idle') }} />
      <Button size="sm" variant="outline" disabled={key.trim() === '' || keyState === 'saving'} onClick={() => {
        setKeyState('saving')
        void onSaveCloudKey(key).then((ok) => { setKeyState(ok ? 'saved' : 'failed'); if (ok) setKey('') })
      }}>{t(keyState === 'saved' ? 'setup.keySaved' : 'setup.keySave')}</Button>
      <span className={css.detail}>{t(keyState === 'failed' ? 'setup.keyFailed' : 'setup.keyHint')}</span>
    </div>
  )
}
