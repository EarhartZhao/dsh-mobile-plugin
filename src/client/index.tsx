/**
 * Browser half: the settings card registered under the `mobile-bridge`
 * namespace. It embeds the loopback console page in an iframe, so the card
 * and the standalone page share one backend and never diverge.
 *
 * The card is collapsible: a header row with the title and a chevron toggle;
 * the collapsed state persists in localStorage.
 *
 * Bundle format: lazy-CJS factory (see scripts/build-client.mjs) served by
 * the dsh client module system at /plugins/dsh-mobile-plugin/client.js.
 */
import { createElement, useState } from 'react'

/** Minimal structural view of the slots service this card consumes. */
interface SlotsService {
  inject(slot: string, callback: () => unknown): void
  register(options: { name: string, key: string }, component: unknown): () => void
}

interface ClientContext {
  slots: SlotsService
}

const COLLAPSE_KEY = 'dsh-mobile-bridge-card-collapsed'

function MobileBridgeCard() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })

  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        // storage unavailable (private mode etc.): collapse still works in-session
      }
      return next
    })
  }

  return createElement('div', {
    style: {
      border: '1px solid var(--border, #8884)',
      borderRadius: 8,
      overflow: 'hidden',
    },
  },
    createElement('button', {
      type: 'button',
      onClick: toggle,
      'aria-expanded': String(!collapsed),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '10px 14px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontWeight: 600,
        cursor: 'pointer',
        textAlign: 'left',
      },
    },
      createElement('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-block',
          transition: 'transform 150ms ease',
          transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
        },
      }, '▸'),
      createElement('span', null, 'dsh-mobile 桥接配置'),
    ),
    collapsed ? null : createElement('iframe', {
      src: '/mobile-bridge',
      title: 'dsh-mobile 桥接配置',
      style: {
        display: 'block',
        width: '100%',
        minHeight: 620,
        border: 'none',
        borderTop: '1px solid var(--border, #8884)',
        background: 'var(--background, transparent)',
      },
    }),
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'mobile-bridge',
    }, MobileBridgeCard))
}
