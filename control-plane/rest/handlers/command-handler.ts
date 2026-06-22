/**
 * control-plane/rest/handlers/command-handler — the CP-2 command Lambda handler.
 *
 * This is the integration target behind the CP-2 `SpecRestApi` (task 6.1). Every
 * method of that API is protected by the CP-1 Cognito authorizer and validated
 * against the imported `openapi.yaml`, so by the time a request reaches this
 * handler it has a verified session and a contract-conforming shape. The
 * handler's job is the tenant-isolation + routing core (R2.3–R2.6):
 *
 *   1. **Derive the tenant from the CP-1 Validated_Session, never the client
 *      (R2.3, R2.5).** The verified Cognito claims are read from the authorizer
 *      context and handed to the SINGLE tenant-derivation choke point in
 *      `control-plane/auth`. Any client-supplied tenant (body field or header)
 *      is passed through that choke point ONLY to be ignored (design Property
 *      1). A request with no verified session is rejected with an authorization
 *      error before anything is routed (design Property 2).
 *
 *   2. **Scope all data access to that tenant (R2.5).** The handler performs no
 *      direct datastore access; it routes fulfillment to WF-1 and the ONLY
 *      tenant scope it ever forwards is the one derived from the session. WF-1
 *      and the workflow services (tasks 14–17) persist through the shared
 *      tenant-guarded `data/persistence` + `data/query` wrappers, so the
 *      `TENANT#<tenantId>` partition is enforced end to end.
 *
 *   3. **Reject non-conforming requests with a validation error (R2.6).** The
 *      gateway enforces the imported contract's models; this handler adds
 *      defense-in-depth — an unparseable body, a non-object payload, or a
 *      non-command path is rejected with a {@link CommandValidationError}
 *      (4xx). It never re-declares the contract schema (R2.2).
 *
 *   4. **Route authorized commands to WF-1 (R2.4).** A normalized
 *      {@link CommandEnvelope} is handed to the injected {@link WorkflowStarter}
 *      — the narrow WF-1 client — keeping this task decoupled from the
 *      not-yet-built orchestrator (task 14.1).
 *
 * The handler is created by {@link createCommandHandler} with its dependencies
 * injected, so it is exercised in tests with a fake {@link WorkflowStarter} and
 * no AWS coupling.
 *
 * _Requirements: 2.3, 2.4, 2.5, 2.6_
 */

import {
  AuthorizationError,
  cognitoSession,
  deriveOperativeTenantId,
} from '../../auth';
import {
  ApiGatewayProxyEventLike,
  ApiGatewayProxyResultLike,
  decodeBody,
  extractAuthorizerClaims,
  extractClientSuppliedTenant,
  jsonResponse,
} from './api-gateway';
import { CommandValidationError } from './errors';
import { CommandEnvelope, WorkflowStarter } from './workflow-client';

/** Default path prefix that marks a request as a CP-2 command. */
export const DEFAULT_COMMAND_PATH_PREFIX = '/commands/';

/** HTTP methods that carry a request body the handler should parse. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Dependencies injected into {@link createCommandHandler}. */
export interface CommandHandlerDeps {
  /** The WF-1 client authorized commands are routed to (task 14.1 provides it). */
  readonly workflowStarter: WorkflowStarter;
  /**
   * Path prefix that identifies a CP-2 command route. Requests on any other
   * path are rejected as a validation error. Defaults to
   * {@link DEFAULT_COMMAND_PATH_PREFIX}.
   */
  readonly commandPathPrefix?: string;
}

/** The Lambda handler signature this module produces. */
export type CommandHandler = (
  event: ApiGatewayProxyEventLike,
) => Promise<ApiGatewayProxyResultLike>;

/**
 * Derive a stable command-type routing key from the matched route. This is a
 * routing identifier derived from the path the gateway already validated — it
 * does NOT re-declare the imported contract (R2.2).
 */
export function deriveCommandType(
  method: string,
  resourcePath: string,
): string {
  return `${method} ${resourcePath}`;
}

/**
 * Parse and structurally validate the request body for a command request.
 *
 * @returns the payload object (an empty object when no body is expected/sent).
 * @throws {CommandValidationError} when a body is present but unparseable or
 *         not a JSON object — the handler-level counterpart to the gateway's
 *         contract validation (R2.6).
 */
export function parseCommandBody(
  event: ApiGatewayProxyEventLike,
): Record<string, unknown> {
  const method = (event.httpMethod ?? '').toUpperCase();
  const raw = decodeBody(event);

  // No body: only a problem if the contract required one, which the gateway
  // already enforced. Treat an absent body as an empty payload here.
  if (raw === undefined || raw.trim() === '') {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CommandValidationError(
      'malformed-body',
      'CP-2 command request body is not valid JSON.',
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // A command body must be a JSON object; arrays/scalars cannot carry a
    // command payload. (Body-bearing methods only — a stray scalar on a GET is
    // ignored above by the empty-body path.)
    if (BODY_METHODS.has(method)) {
      throw new CommandValidationError(
        'non-object-body',
        'CP-2 command request body must be a JSON object.',
      );
    }
    return {};
  }

  return parsed as Record<string, unknown>;
}

/** Map a thrown error to the appropriate API Gateway proxy response. */
function toErrorResponse(err: unknown): ApiGatewayProxyResultLike {
  if (err instanceof AuthorizationError) {
    // No trustworthy session (R1.5) -> 401; a session that carries no/invalid
    // tenant is a forbidden request -> 403.
    const status =
      err.reason === 'missing-session' || err.reason === 'unrecognized-session'
        ? 401
        : 403;
    return jsonResponse(status, {
      error: 'Unauthorized',
      reason: err.reason,
      message: err.message,
    });
  }
  if (err instanceof CommandValidationError) {
    return jsonResponse(400, {
      error: 'ValidationError',
      reason: err.failure,
      message: err.message,
    });
  }
  // Unknown/internal failure (including a WF-1 start failure): do not leak
  // internals.
  return jsonResponse(500, {
    error: 'InternalError',
    message: 'The command could not be processed.',
  });
}

/**
 * Create the CP-2 command Lambda handler with its dependencies injected.
 *
 * The returned handler is pure with respect to its inputs (no module-level
 * AWS clients), so it can be unit-tested directly with a fake
 * {@link WorkflowStarter}. At deploy time the WorkflowStack (task 14.1)
 * supplies the concrete WF-1 client.
 */
export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const prefix = deps.commandPathPrefix ?? DEFAULT_COMMAND_PATH_PREFIX;

  return async (
    event: ApiGatewayProxyEventLike,
  ): Promise<ApiGatewayProxyResultLike> => {
    try {
      // 1. Derive the operative tenant from the CP-1 Validated_Session ONLY.
      //    The client-supplied tenant is captured and passed through the choke
      //    point purely so it can be (and is) ignored (design Property 1).
      const claims = extractAuthorizerClaims(event);
      const session = claims ? cognitoSession(claims) : null;

      const method = (event.httpMethod ?? '').toUpperCase();
      const resourcePath = event.resource ?? event.path ?? '';

      // 3a. Reject non-command routes (defense in depth; the gateway only
      //     routes contract paths). Done before body parse so the failure mode
      //     is a clear validation error.
      if (!resourcePath.startsWith(prefix)) {
        throw new CommandValidationError(
          'unknown-route',
          `Path ${JSON.stringify(resourcePath)} is not a CP-2 command route.`,
        );
      }

      // 3b. Parse + structurally validate the (contract-validated) body.
      const payload = parseCommandBody(event);

      // 1 (cont). Derive the tenant. Throws AuthorizationError before any
      //           routing if there is no trustworthy session.
      const tenantId = deriveOperativeTenantId({
        session,
        clientSuppliedTenantId: extractClientSuppliedTenant(event, payload),
      });

      // 4. Build the normalized, tenant-scoped command and route to WF-1.
      const command: CommandEnvelope = {
        tenantId,
        commandType: deriveCommandType(method, resourcePath),
        method,
        resourcePath,
        payload,
      };

      const execution = await deps.workflowStarter.start(tenantId, command);

      // 202 Accepted: the command was authorized, scoped, and handed to WF-1
      // for fulfillment.
      return jsonResponse(202, {
        status: 'accepted',
        commandType: command.commandType,
        executionId: execution.executionId,
        ...(execution.executionArn
          ? { executionArn: execution.executionArn }
          : {}),
      });
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
