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
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

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
      // New installations start collapsed; only an explicit saved open state
      // opts into rendering the embedded console immediately.
      return localStorage.getItem(COLLAPSE_KEY) !== '0'
    } catch {
      return true
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

  return createElement('li', {
    style: {
      listStyle: 'none',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 16,
      background: 'var(--dsw-alias-bg-layer-3)',
      overflow: 'hidden',
      transition: 'border-color .16s, background .16s',
    },
  },
    createElement('button', {
      type: 'button',
      onClick: toggle,
      'aria-expanded': String(!collapsed),
      style: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '14px 16px',
        border: 'none',
        borderRadius: 12,
        background: 'none',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
      },
    },
      createElement('span', {
        style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      },
        createElement('span', {
          style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' },
        }, 'dsh-mobile 桥接配置'),
        createElement('span', {
          style: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
        }, '配置移动端桥接、NATS 连接与设备配对'),
      ),
      createElement(IconChevronDownOutline14, {
        style: {
          flex: 'none',
          color: 'var(--dsw-alias-label-tertiary)',
          transition: 'transform .16s',
          transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
        },
      }),
    ),
    collapsed ? null : createElement('iframe', {
      src: '/mobile-bridge',
      title: 'dsh-mobile 桥接配置',
      style: {
        display: 'block',
        width: '100%',
        height: 460,
        maxHeight: 460,
        border: 'none',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
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
