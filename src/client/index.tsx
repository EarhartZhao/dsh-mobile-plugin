/**
 * Browser half: the bridge's configuration on the Plugins page.
 *
 * Upstream retired the Settings section's plugin-card list (the
 * `settings.plugin.item` slot): the sidebar's Plugins page now hosts plugin
 * configuration, and a bundle contributes its form through
 * `plugins.bundle.config`, keyed by its package name, while the page draws the
 * title, crumb, and chrome itself. This entry therefore renders the console
 * body alone, embedded in an iframe so the page and the standalone
 * `/mobile-bridge` page share one backend.
 *
 * Bundle format: lazy-CJS factory (see scripts/build-client.mjs) served by
 * the dsh client module system at /plugins/dsh-mobile-plugin/client.js.
 */
import { createElement } from 'react'

/** The package name the Plugins page keys this bundle's configuration by. */
const BUNDLE_NAME = 'dsh-mobile-plugin'

/** Props the Plugins page binds for one bundle configuration entry. */
interface ConfigViewProps {
  /** `summary` renders inline text only; `page` renders the configuration body. */
  view: 'summary' | 'page'
}

/** Minimal structural view of the slots service this page consumes. */
interface SlotsService {
  inject(slot: string, callback: () => unknown): void
  register(options: { name: string; key: string }, component: unknown): () => void
}

interface ClientContext {
  slots: SlotsService
}

function MobileBridgeConfig({ view }: ConfigViewProps) {
  if (view !== 'page') return null
  return createElement('iframe', {
    src: '/mobile-bridge',
    title: 'dsh-mobile 桥接配置',
    style: {
      display: 'block',
      width: '100%',
      height: 640,
      maxHeight: 640,
      border: 'none',
      borderRadius: 16,
      background: 'var(--dsw-alias-bg-layer-2)',
    },
  })
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
    }, MobileBridgeConfig))
}
