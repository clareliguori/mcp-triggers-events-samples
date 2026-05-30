/**
 * Data API Lambda entry point.
 *
 * The CDK `DataApiStack` configures the Lambda with `entry: src/index.ts` and
 * `handler: "handler"`, so we re-export the implementation from `handler.ts`.
 * Routing and authorization live in `handler.ts`; the per-route persistence
 * logic lives in the `routes/*` modules.
 */

export { handler } from "./handler.js";
