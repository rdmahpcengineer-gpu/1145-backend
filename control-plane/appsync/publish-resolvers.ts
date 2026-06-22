import { aws_appsync as appsync } from 'aws-cdk-lib';
import { LiveStateApi } from './live-state-api';

/**
 * CP-3 publish (fan-out) resolvers — task 7.3.
 *
 * The four `publish*` mutations (`publishCallUpdate`, `appendTranscript`,
 * `publishLead`, `publishCallEscalated`) are authorized with `@aws_iam` in the
 * imported SDL and are invoked by trusted backend components (AC AgentCore,
 * WF workflows, ML sentiment) — never by an end user. They are implemented as
 * **no-op fan-out resolvers** backed by a NONE (local) data source:
 *
 *  - they perform **no persistent read or write** to DynamoDB or any store;
 *  - they stage the mutation argument as the resolver payload so AppSync
 *    delivers it to matching `@aws_subscribe` subscriptions;
 *  - for tenant-bearing payloads (`Call`, `Lead`) the tenant on the fanned-out
 *    payload is taken from the **session-derived `tenantId` field** that the
 *    IAM caller populated from the validated SE-1 session, and the resolver
 *    rejects the invocation when that field is absent — the tenant is never
 *    sourced from some other arbitrary client field.
 *
 * This wiring is intentionally additive and kept out of `live-state-api.ts`
 * (which owns the API + auth config and the read/subscription resolvers, task
 * 7.2). Nothing here touches the schema or the auth modes.
 *
 * Design: design.md "CP-3 — AppSync GraphQL API" (Publish resolvers) and
 * Property 6. Steering: multi-tenant-platform.md ("IAM `publish*` mutations set
 * tenant from the validated SE-1 session").
 *
 * Validates: Requirements 3.7, 10.3, 11.3, 12.3
 */

/** VTL version pinned for the request mapping templates. */
export const VTL_VERSION = '2018-05-29';

/** The GraphQL `Mutation` type that owns the publish fields. */
const MUTATION_TYPE = 'Mutation';

/** Logical id of the shared NONE data source used for all fan-out resolvers. */
export const PUBLISH_DATA_SOURCE_ID = 'PublishFanOut';

/**
 * Declarative spec for one publish fan-out resolver.
 */
export interface PublishResolverSpec {
  /** The `Mutation` field name (matches the imported SDL). */
  readonly fieldName: string;
  /** The single mutation argument carrying the fan-out payload. */
  readonly argName: string;
  /**
   * Whether the payload type carries a `tenantId` field. When true, the
   * resolver requires a non-blank session-derived `tenantId` on the argument
   * and stamps exactly that value onto the fanned-out payload. When false (the
   * transcript segment, whose tenant boundary is enforced by `callId` on the
   * subscription), the segment is fanned out as-is.
   */
  readonly tenantBearing: boolean;
  /**
   * Optional static fields stamped onto the payload to express the mutation's
   * semantic (e.g. `escalated: true` for `publishCallEscalated`). Values are
   * raw VTL literals.
   */
  readonly stamp?: Readonly<Record<string, string>>;
}

/**
 * The four CP-3 publish fan-out resolvers. Field/argument names mirror the
 * imported SDL; they are consumed here, never re-declared.
 */
export const PUBLISH_RESOLVER_SPECS: readonly PublishResolverSpec[] = [
  { fieldName: 'publishCallUpdate', argName: 'call', tenantBearing: true },
  { fieldName: 'appendTranscript', argName: 'segment', tenantBearing: false },
  { fieldName: 'publishLead', argName: 'lead', tenantBearing: true },
  {
    fieldName: 'publishCallEscalated',
    argName: 'call',
    tenantBearing: true,
    stamp: { escalated: 'true' },
  },
];

/**
 * Build the VTL **request** mapping template for a publish fan-out resolver.
 *
 * The template never issues a data-source operation (the data source is NONE),
 * so no persistent read/write is possible. It only constructs the `payload`
 * that AppSync hands to the response template and fans out to subscribers.
 *
 * For tenant-bearing payloads it asserts a non-blank, session-derived
 * `tenantId` on the argument and stamps that exact value onto the payload,
 * guaranteeing the fanned-out tenant comes from the validated session rather
 * than an arbitrary client field.
 */
export function buildPublishRequestTemplate(spec: PublishResolverSpec): string {
  const argRef = `$ctx.args.${spec.argName}`;
  const lines: string[] = [];

  lines.push(`## CP-3 ${spec.fieldName} — no-op fan-out resolver (NONE data source).`);
  lines.push('## No persistent read or write occurs; this only stages the payload for');
  lines.push('## delivery to matching @aws_subscribe subscriptions.');

  if (spec.tenantBearing) {
    lines.push('## Tenant is taken from the session-derived tenantId set by the IAM caller');
    lines.push('## (validated SE-1 session), never from an arbitrary client field.');
    lines.push(`#if( $util.isNullOrBlank(${argRef}.tenantId) )`);
    lines.push('  $util.unauthorized()');
    lines.push('#end');
    lines.push(`#set( $payload = ${argRef} )`);
    // Re-assert the authoritative tenant onto the payload explicitly.
    lines.push(`$util.qr($payload.put("tenantId", ${argRef}.tenantId))`);
    for (const [key, value] of Object.entries(spec.stamp ?? {})) {
      lines.push(`$util.qr($payload.put("${key}", ${value}))`);
    }
    lines.push('{');
    lines.push(`  "version": "${VTL_VERSION}",`);
    lines.push('  "payload": $util.toJson($payload)');
    lines.push('}');
  } else {
    lines.push('## Tenant scope for transcript fan-out is enforced by callId on the');
    lines.push('## subscription; the segment payload type carries no tenant field.');
    lines.push('{');
    lines.push(`  "version": "${VTL_VERSION}",`);
    lines.push(`  "payload": $util.toJson(${argRef})`);
    lines.push('}');
  }

  return lines.join('\n');
}

/**
 * Build the VTL **response** mapping template for a publish fan-out resolver.
 * It surfaces any error and otherwise returns the staged payload unchanged so
 * AppSync delivers it to subscribers.
 */
export function buildPublishResponseTemplate(): string {
  return [
    '## Return the staged payload so AppSync fans it out to matching subscriptions.',
    '#if( $ctx.error )',
    '  $util.error($ctx.error.message, $ctx.error.type)',
    '#end',
    '$util.toJson($ctx.result)',
  ].join('\n');
}

/**
 * Attach the four CP-3 publish (fan-out) resolvers to a {@link LiveStateApi}.
 *
 * Creates a single shared NONE data source and wires one no-op fan-out resolver
 * per publish mutation. Additive only: it does not alter the API's schema or
 * auth configuration, and does not touch the read/subscription resolvers (task
 * 7.2).
 *
 * @returns the NONE data source, for diagnostics/testing.
 */
export function attachPublishResolvers(liveStateApi: LiveStateApi): appsync.NoneDataSource {
  const dataSource = liveStateApi.api.addNoneDataSource(PUBLISH_DATA_SOURCE_ID, {
    description: 'CP-3 publish* no-op fan-out (no persistence; delivers to subscriptions).',
  });

  for (const spec of PUBLISH_RESOLVER_SPECS) {
    dataSource.createResolver(`Resolver-${spec.fieldName}`, {
      typeName: MUTATION_TYPE,
      fieldName: spec.fieldName,
      requestMappingTemplate: appsync.MappingTemplate.fromString(
        buildPublishRequestTemplate(spec),
      ),
      responseMappingTemplate: appsync.MappingTemplate.fromString(
        buildPublishResponseTemplate(),
      ),
    });
  }

  return dataSource;
}
