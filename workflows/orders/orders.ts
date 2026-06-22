/**
 * workflows/orders/orders — the WF-3 Orders Service domain logic (design WF-3).
 *
 * Pure, cloud-decoupled order logic behind Requirement 15:
 *
 *   - **R15.1 — tenant-scoped creation.** An order is created scoped to the
 *     action's `tenantId`. The `tenantId` arrives already derived from a
 *     Validated_Session (the WF-1 orchestrator propagates it into every state
 *     input — design Property 7); this module never re-derives it from the
 *     client payload.
 *   - **R15.2 — tenant-partitioned persistence.** The order is persisted to the
 *     DM-2 single table through the shared {@link TenantPersistence} wrapper, so
 *     the written item carries `PK = TENANT#<tenantId>`, `entityType = 'Order'`,
 *     and `SK = ORDER#<id>` (design "Data Models"; Property 3). Tenant logic is
 *     NOT re-implemented here — it is reused from `data/persistence`.
 *   - **R15.3 — invalid orders persist no partial state.** If the order request
 *     fails validation, an {@link OrderValidationError} is thrown and NO item is
 *     persisted (design Property 18). Validation happens BEFORE the single
 *     conditional (`createOnly`) write, so a rejected order never reaches the
 *     store — there is no partial write to roll back.
 *
 * The function takes its collaborators by injection ({@link CreateOrderDeps}),
 * so it is exercised in tests with a fake writer and zero AWS coupling.
 *
 * _Requirements: 15.1, 15.2, 15.3_
 */

import {
  EntityType,
  PersistedItem,
  TenantPersistence,
} from '../../data/persistence';

/** The entity discriminator for an order record in DM-2. */
export const ORDER_ENTITY_TYPE: EntityType = 'Order';

/** Sort-key prefix for an order record: `ORDER#<id>`. */
export const ORDER_SK_PREFIX = 'ORDER#';

/** Build the DM-2 sort key for an order: `ORDER#<id>`. */
export function orderSortKey(orderId: string): string {
  if (typeof orderId !== 'string' || orderId.length === 0) {
    throw new Error('orderSortKey requires a non-empty order id.');
  }
  return `${ORDER_SK_PREFIX}${orderId}`;
}

/**
 * A single line item on an order. The shape is owned by the imported contract
 * and treated largely opaquely here; the service only inspects the fields it
 * must validate (`quantity`) and passes the rest through untouched.
 */
export interface OrderLineItem {
  /** Identifier/SKU of the ordered good or service. */
  readonly sku: string;
  /** Quantity ordered; must be a positive integer. */
  readonly quantity: number;
  /** Remaining line payload (description, price, options …). */
  readonly [key: string]: unknown;
}

/**
 * A normalized, tenant-scoped order request handed to the service. `items` is
 * the list of ordered goods/services; `details` is the rest of the order
 * payload (customer contact, notes) passed through untouched.
 */
export interface OrderRequest {
  /** Operative tenant — derived from a Validated_Session, never the client. */
  readonly tenantId: string;
  /** The ordered line items; at least one is required (R15.3). */
  readonly items: ReadonlyArray<OrderLineItem>;
  /** Remaining order payload (contact, notes …). */
  readonly details?: Record<string, unknown>;
  /**
   * Optional caller-supplied order id. When absent the service mints one via
   * the injected id generator, so a deterministic id can be used in tests.
   */
  readonly orderId?: string;
}

/** A successfully created order. */
export interface PlacedOutcome {
  readonly status: 'placed';
  /** The fully-formed, tenant-partitioned item that was persisted. */
  readonly order: PersistedItem;
}

/** The result of an order attempt (design WF-3: `Order | ValidationError`). */
export type OrderOutcome = PlacedOutcome;

/**
 * Thrown when an order request fails validation (R15.3 / design Property 18).
 * Carries no partial state — it is raised BEFORE any write is attempted, so a
 * rejected order leaves nothing persisted.
 */
export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
    Object.setPrototypeOf(this, OrderValidationError.prototype);
  }
}

/** Collaborators injected into {@link createOrder}. */
export interface CreateOrderDeps {
  /** Shared DM-2 persistence wrapper — enforces `PK = TENANT#<tenantId>`. */
  readonly persistence: TenantPersistence;
  /** Order-id generator; defaults to a random UUID. */
  readonly newOrderId?: () => string;
}

/**
 * Validate an order request. Returns the validated, non-empty line items on
 * success; throws {@link OrderValidationError} otherwise. Pure and side-effect
 * free so it can run before any write is attempted (R15.3 / Property 18).
 */
export function validateOrderRequest(
  request: OrderRequest,
): ReadonlyArray<OrderLineItem> {
  const { tenantId, items } = request;

  // The orchestrator propagates a Validated_Session tenant into every state
  // input; defend against a missing one rather than silently mis-scoping.
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new OrderValidationError(
      'Order request is missing a tenantId (it must be propagated from the orchestrator).',
    );
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderValidationError(
      'Order request must contain at least one line item.',
    );
  }

  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new OrderValidationError(`Order line item ${index} is not an object.`);
    }
    if (typeof item.sku !== 'string' || item.sku.length === 0) {
      throw new OrderValidationError(
        `Order line item ${index} is missing a non-empty sku.`,
      );
    }
    if (
      typeof item.quantity !== 'number' ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      throw new OrderValidationError(
        `Order line item ${index} (${item.sku}) must have a positive integer quantity.`,
      );
    }
  });

  return items;
}

/**
 * Create an order for a tenant.
 *
 *  1. Validate the request (tenant present, at least one well-formed line
 *     item). A validation failure throws {@link OrderValidationError} BEFORE any
 *     write is attempted, so no partial order is persisted (R15.3 / Property 18).
 *  2. Persist a tenant-partitioned `Order` item via the shared
 *     {@link TenantPersistence} wrapper (`PK = TENANT#<tenantId>`,
 *     `SK = ORDER#<id>`) using a single atomic create, and return the `placed`
 *     outcome (R15.1, R15.2 / Property 3).
 */
export async function createOrder(
  request: OrderRequest,
  deps: CreateOrderDeps,
): Promise<OrderOutcome> {
  // R15.3 / Property 18 — validate first; throws before any write is attempted.
  const items = validateOrderRequest(request);
  const { tenantId } = request;

  const orderId =
    request.orderId && request.orderId.length > 0
      ? request.orderId
      : (deps.newOrderId ?? defaultOrderId)();

  // R15.1 + R15.2 / Property 3 — persist a tenant-partitioned Order item
  // through the shared wrapper. `createOnly` makes it a single conditional
  // create so a duplicate order id never silently overwrites an existing order
  // and a rejected order leaves no partial item.
  const order = await deps.persistence.put({
    tenantId,
    entityType: ORDER_ENTITY_TYPE,
    sk: orderSortKey(orderId),
    data: {
      orderId,
      items,
      status: 'placed',
      ...(request.details ?? {}),
    },
    createOnly: true,
  });

  return { status: 'placed', order };
}

/** Default order-id generator (Node's built-in UUID; no extra dependency). */
function defaultOrderId(): string {
  // Lazy require keeps this module import-light and test-friendly.
  // `crypto.randomUUID` is available in the Node 20 Lambda runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('crypto') as typeof import('crypto');
  return randomUUID();
}
