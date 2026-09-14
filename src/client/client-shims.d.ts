/**
 * Compile-time shims for the host client packages this plugin's browser half
 * consumes.
 *
 * The card imports `@deepseek-ai/dsh-client-ui-primitives` for one icon, and
 * the package ships with the dsh runtime rather than as an installable
 * dependency (`.npmrc` keeps `auto-install-peers=false`). Declaring the exact
 * slice we use is what lets `typecheck:client` run in CI without a dsh
 * checkout; at runtime the real module answers through the loader's module
 * table. Keep this view narrow: it is a promise about the host's surface, and
 * a signature change upstream must show up here.
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** Structural view of the icon components the card renders. */
  export const IconChevronDownOutline14: (props: {
    /** Inline style object accepted by the host's icon wrapper. */
    style?: import('react').CSSProperties
  }) => import('react').ReactElement
}
