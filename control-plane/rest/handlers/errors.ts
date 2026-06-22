/**
 * control-plane/rest/handlers/errors — typed handler-level validation error.
 *
 * The CP-2 REST API enforces the imported `openapi.yaml` contract at the
 * gateway (model + parameter validation, enabled in task 6.1), so the bulk of
 * "does this request conform to the contract?" is rejected BEFORE a handler
 * runs. A {@link CommandValidationError} is the handler's defense-in-depth
 * counterpart: it rejects a request that reached the handler but still cannot
 * be turned into a well-formed, routable command (e.g. an unparseable body, a
 * non-object payload, or a path that is not a command route). It NEVER
 * re-declares the contract's field-level schema — that lives in the imported
 * `openapi.yaml` and nowhere else (R2.2).
 *
 * It is the request-shape counterpart to `control-plane/auth`'s
 * {@link AuthorizationError} (which guards the tenant/identity boundary): a
 * validation error means "we know who you are, but this request is malformed".
 *
 * _Requirements: 2.6_
 */

/** Why a request that reached the handler could not be turned into a command. */
export type CommandValidationFailure =
  /** The request body was present but is not valid JSON. */
  | 'malformed-body'
  /** The request body parsed to something other than a JSON object. */
  | 'non-object-body'
  /** The matched path is not a CP-2 command route. */
  | 'unknown-route';

/**
 * Thrown when a CP-2 request cannot be normalized into a routable command. This
 * is a 4xx client error (a validation failure), not a transient fault: the
 * request is refused and nothing is routed to WF-1.
 */
export class CommandValidationError extends Error {
  readonly failure: CommandValidationFailure;

  constructor(failure: CommandValidationFailure, message: string) {
    super(message);
    this.name = 'CommandValidationError';
    this.failure = failure;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, CommandValidationError.prototype);
  }
}
