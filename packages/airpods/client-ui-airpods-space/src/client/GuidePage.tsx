/** Step-by-step usage guide shown inside settings: one topic per page, with Back/Next and page dots. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AirpodsKey, NS } from './locales.ts'
import css from './SettingsDialog.module.css'

export interface GuidePageProps extends PropsLocale<typeof NS> {
  /** AirPods 1/2 talk with a double-tap; other models press the stem. */
  doubleTap: boolean
  /** Head gestures need AirPods Pro, 3, 4 or Max. */
  headMotion: boolean
  /** Earbuds render as a data URL, or empty for the glyph. */
  image: string
  glyph: ReactNode
  onOpenBluetooth: () => void
}

/** Animation drawn over the earbuds for a step. */
type Motion = 'setup' | 'talk' | 'send' | 'stop' | 'commands' | 'head' | 'tips'
interface Step { motion: Motion; title: AirpodsKey; lines: readonly AirpodsKey[]; action?: 'bluetooth' }

/**
 * Guide pages for the connected model.
 * @param props - model capabilities, artwork and the Bluetooth shortcut.
 * @returns the paged guide.
 */
export function GuidePage({ doubleTap, headMotion, image, glyph, onOpenBluetooth, t }: GuidePageProps) {
  const steps: Step[] = [
    ...doubleTap ? [{ motion: 'setup', title: 'guide.setupTitle', lines: ['guide.setup1', 'guide.setup2', 'guide.setup3'], action: 'bluetooth' } as Step] : [],
    { motion: 'talk', title: 'guide.talkTitle', lines: [doubleTap ? 'guide.talk1Tap' : 'guide.talk1Press', 'guide.talk2', doubleTap ? 'guide.talk3' : 'guide.talk3Press'] },
    { motion: 'send', title: 'guide.sendTitle', lines: [doubleTap ? 'guide.send1Tap' : 'guide.send1Press', 'guide.send2', doubleTap ? 'guide.send3' : 'guide.send3Press'] },
    { motion: 'stop', title: 'guide.stopTitle', lines: [doubleTap ? 'guide.stop1Tap' : 'guide.stop1Press', 'guide.stop2', 'guide.stop3'] },
    { motion: 'commands', title: 'guide.commandsTitle', lines: ['guide.commands1', 'guide.commands2', 'guide.commands3'] },
    ...headMotion ? [{ motion: 'head', title: 'guide.headTitle', lines: ['guide.head1', 'guide.head2'] } as Step] : [],
    { motion: 'tips', title: 'guide.tipsTitle', lines: ['guide.tips1', 'guide.tips2', 'guide.tips3'] },
  ]
  const [index, setIndex] = useState(0)
  const step = steps[Math.min(index, steps.length - 1)]
  if (step === undefined) throw new Error('GuidePage has no steps')
  return (
    <div className={css.guide}>
      <Stage key={step.motion} motion={step.motion} image={image} glyph={glyph} />
      <div className={css.guideCount}>{t('guide.count', { step: String(index + 1), total: String(steps.length) })}</div>
      <h3 className={css.guideTitle}>{t(step.title)}</h3>
      <ol className={css.guideLines}>{step.lines.map(line => <li key={line}>{t(line)}</li>)}</ol>
      {step.action === 'bluetooth' && <div><Button size="sm" variant="outline" onClick={onOpenBluetooth}>{t('menu.bluetooth')}</Button></div>}
      <div className={css.guideNav}>
        <div className={css.dots} aria-hidden>{steps.map((item, i) => <span key={item.title} data-on={i === index} />)}</div>
        <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => { setIndex(index - 1) }}>{t('setup.back')}</Button>
        <Button size="sm" variant="primary" disabled={index === steps.length - 1} onClick={() => { setIndex(index + 1) }}>{t('setup.next')}</Button>
      </div>
    </div>
  )
}

/**
 * The earbuds with the step's gesture played on a loop: a double ripple on the tapped bud, sound bars while talking,
 * an arrow leaving on send, a nod and a shake for head gestures.
 */
function Stage({ motion, image, glyph }: { motion: Motion; image: string; glyph: ReactNode }) {
  return (
    <div className={css.stage} data-motion={motion} aria-hidden>
      <div className={css.stageBuds}>{image ? <img src={image} alt="" /> : glyph}</div>
      {(motion === 'setup' || motion === 'talk' || motion === 'send') && <span className={css.ripple} data-side="left"><i /><i /></span>}
      {motion === 'stop' && <span className={css.ripple} data-side="right"><i /><i /></span>}
      {motion === 'talk' && <span className={css.bars}><i /><i /><i /><i /><i /></span>}
      {motion === 'send' && <span className={css.arrow}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg></span>}
      {motion === 'commands' && <span className={css.bubble}><i /><i /><i /></span>}
    </div>
  )
}
