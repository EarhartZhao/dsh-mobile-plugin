/**
 * Compile-time shim for the host ApiProxy package.
 *
 * The published `@deepseek-ai/dsh-host-apiproxy@0.0.1-rc.1` is uninstallable
 * (depends on unpublished packages), and the local fork builds types only
 * after a full repo build. The plugin's runtime usage is exactly one function
 * (`toFetchHandler`), so we declare it here against a structural type.
 * At runtime inside dsh the import resolves to the real built package.
 */
declare module '@deepseek-ai/dsh-host-apiproxy' {
  /** Structural view of the host ApiProxy face this plugin consumes. */
  export interface HostApiProxy {
    events: {
      mux(request: { rpcId: string, payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<{ rpcId: string, payload: { type: string } & Record<string, unknown> }>
      host(request: { rpcId: string, payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<{ rpcId: string, payload: { type: string } & Record<string, unknown> }>
    }
  }

  /** Wraps the host API surface into a WHATWG fetch carrier (see apiproxy src/fetch/handler). */
  export function toFetchHandler(api: HostApiProxy): { fetch: typeof fetch }
}
