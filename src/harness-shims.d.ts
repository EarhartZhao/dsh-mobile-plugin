/**
 * Compile-time shims for the host packages this plugin consumes.
 *
 * dsh 0.1.2-alpha.2 removed `@deepseek-ai/dsh-host-apiproxy`; the equivalent
 * surface is now split across `@deepseek-ai/dsh-client-connection` (unary RPC
 * dispatch via `ctx.connection`) and `@deepseek-ai/dsh-api-gateway` (event
 * streaming via `ctx.typertGateway`). We declare structural views here so the
 * plugin compiles without a full host build; at runtime inside dsh the imports
 * resolve to the real services through the cordis service registry.
 */

/** Host Connection service: registers fetch routes and shared-channel RPC. */
declare module '@deepseek-ai/dsh-client-connection' {
  /** Transport-independent Fetch handler dispatched after auth. */
  export interface ConnectionFetchHandler {
    fetch(request: Request): Promise<Response>
  }

  /** Shape exposed as `ctx.connection`. */
  export interface HostConnectionHandle {
    createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler
  }
}

/** Typert Gateway: opens live Remote event and stream channels. */
declare module '@deepseek-ai/dsh-api-gateway' {
  /** Carrier-facing access to decoded Remote streams. */
  export interface TypertGatewayWireStream {
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
    failure(error: unknown): { code: string, message: string, details: object }
  }

  /** Shape exposed as `ctx.typertGateway`. */
  export interface TypertGateway {
    wireStream: TypertGatewayWireStream
  }
}
