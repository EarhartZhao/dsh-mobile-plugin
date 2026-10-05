/**
 * Loader events this plugin listens to.
 *
 * `loader/volatile-update` is declared by `@deepseek-ai/cordis-plugin-loader`,
 * which a tree-out plugin does not build against; the augmentation below is
 * what makes `ctx.on('loader/volatile-update', …)` type-check. The signature
 * mirrors the host's declaration.
 */
import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One entry's schema-declared volatile config fields were committed into the
     * running instance's references in place (no remount).
     * @param paths Config paths whose references changed.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}
