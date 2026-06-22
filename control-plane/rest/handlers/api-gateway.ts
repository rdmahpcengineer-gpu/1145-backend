/**
 * control-plane/rest/handlers/api-gateway — narrow API Gateway proxy shapes.
 *
 * The CP-2 command handler runs behind an API Gateway REST API (a
 * `SpecRestApi`, task 6.1) with the CP-1 Cognito authorizer attached to every
 * method. Rather than depend on `aws-lambda` types (not a dependency of this
 * CDK workspace), this module declares the SMALL subset of the proxy
 * event/result the handler actually reads — plus the helpers that pull the
 * verified Cognito claims out of the authorizer context.
 *
 * The crucial isolation point lives here: the operative tenant is read from the
 * **authorizer claims** (which API Gateway populated from the token the CP-1
 * authorizer verified), never from the request body or a header. The
 * client-supplied tenant, if any, is extracted separately and passed through
 * the `control-plane/auth` choke point ONLY to demonstrate it is ignored.
 *
 * _Requirements: 2.3, 2.5_
 */

/**
 * The authorizer block API Gateway attaches to a request after the CP-1 Cognito
 * authorizer runs. For a Cognito user-pools authorizer, the verified token
 * claims are surfaced under `claims`.
 */
export interface ApiGatewayAuthorizer {
  /** Verified Cognito token claims (string-valued in REST proxy events). */
  readonly claims?: Record<string, unknown> | null;
  /** Other authorizer context values are permitted but unused here. */
  readonly [key: string]: unknown;
}

/** The request-context subset the handler reads. */
export interface ApiGatewayRequestContext {
  readonly authorizer?: ApiGatewayAuthorizer | null;
  readonly [key: string]: unknown;
}

/** The API Gateway REST proxy event subset the handler reads. */
export interface ApiGatewayProxyEventLike {
  /** The matched API resource path template, e.g. `/commands/bookings`. */
  readonly resource?: string | null;
  /** The actual request path (fallback when `resource` is absent). */
  readonly path?: string | null;
  /** HTTP method, e.g. `POST`. */
  readonly httpMethod?: string | null;
  /** Raw request body (a JSON string for command requests), if any. */
  readonly body?: string | null;
  /** Whether {@link body} is base64-encoded. */
  readonly isBase64Encoded?: boolean;
  /** Request headers (case preserved as delivered). */
  readonly headers?: Record<string, string | undefined> | null;
  /** The request context, carrying the authorizer claims. */
  readonly requestContext?: ApiGatewayRequestContext | null;
}

/** The API Gateway REST proxy result the handler returns. */
export interface ApiGatewayProxyResultLike {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

/**
 * Extract the verified Cognito claims from the authorizer context, or `null`
 * when there is no authorizer/claims block. A `null` result means "no
 * Validated_Session", which `control-plane/auth` turns into an authorization
 * error — so a request that somehow bypassed the authorizer can never derive a
 * tenant (design Property 2).
 */
export function extractAuthorizerClaims(
  event: ApiGatewayProxyEventLike,
): Record<string, unknown> | null {
  const claims = event.requestContext?.authorizer?.claims;
  if (!claims || typeof claims !== 'object') {
    return null;
  }
  return claims as Record<string, unknown>;
}

/**
 * Extract whatever tenant value the CLIENT put on the wire — a `tenantId` field
 * in the parsed body or an `x-tenant-id` header. This value is DELIBERATELY
 * captured only so it can be fed through the tenant-derivation choke point and
 * proven to have no effect (design Property 1). It is never used as a tenant.
 */
export function extractClientSuppliedTenant(
  event: ApiGatewayProxyEventLike,
  parsedBody: Record<string, unknown> | undefined,
): unknown {
  const headers = event.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-tenant-id') {
      return value;
    }
  }
  return parsedBody?.tenantId;
}

/** Build a JSON proxy result with the given status code and payload. */
export function jsonResponse(
  statusCode: number,
  payload: unknown,
): ApiGatewayProxyResultLike {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/** Decode the proxy event body to a string, honoring base64 transport. */
export function decodeBody(event: ApiGatewayProxyEventLike): string | undefined {
  const { body } = event;
  if (body === undefined || body === null) {
    return undefined;
  }
  if (event.isBase64Encoded) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  return body;
}
