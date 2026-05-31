/**
 * Public surface of the @mcp-events/mcp-server-core package.
 *
 * This package factors out the ~90% identical machinery the two MCP servers
 * (USGS / MCP Server 1 and Scheduler / MCP Server 2) used to duplicate: the
 * side-effecting client singletons + test seams, environment lookups, the
 * subscription store, signed webhook delivery, the JSON-RPC MCP transport, and
 * the dual-trigger Lambda dispatch. Each server keeps only its own domain logic
 * and wires it together with these primitives.
 *
 * Consumers should import from this barrel rather than reaching into individual
 * modules so the internal layout can be refactored freely.
 */

export * from "./clients.js";
export * from "./env.js";
export * from "./subscription-store.js";
export * from "./webhook-delivery.js";
export * from "./mcp-transport.js";
export * from "./dispatch.js";
