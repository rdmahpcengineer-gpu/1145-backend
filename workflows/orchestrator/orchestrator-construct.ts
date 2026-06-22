/**
 * workflows/orchestrator/orchestrator-construct — the WF-1 orchestrator (design WF-1).
 *
 * A Step Functions state machine fronted by an EventBridge bus (design.md
 * "WF-1 — Orchestrator"; Requirement 13.1). It:
 *
 *  - **Routes** an initiating action (from the AC-2 Tool Gateway or a CP-2
 *    command) to Booking / Orders / Notification based on `actionType`, using a
 *    `Choice` state whose branches are generated from the shared
 *    {@link ACTION_ROUTING} table so the deployed graph matches the in-process
 *    routing function (design Property 15; Requirement 13.2).
 *  - **Propagates `tenantId`** into every state's input: the execution input is
 *    rooted at `{ tenantId, actionType, payload }` and each service task is
 *    invoked with that `tenantId` carried through explicitly (design Property 7;
 *    Requirement 13.3).
 *  - **Records failures**: every service task has a `Catch` that routes to a
 *    tenant-scoped DynamoDB write of a `FAILURE#<execId>` item in the DM-2 table
 *    (`PK = TENANT#<tenantId>`), emits a CloudWatch metric, and then ends in a
 *    `Fail` state so the action's outcome is an error rather than a success
 *    (design Property 16; Requirement 13.4).
 *
 * The Orders / Notification targets are PLACEHOLDER Lambdas here — tasks 16.1
 * / 17.1 own their business logic. The Booking target is the REAL WF-2 service
 * (task 15.1). This construct keeps the routing, tenant propagation, and
 * failure handling real; the remaining tasks swap their placeholder function
 * code for the real services without changing the graph.
 */

import * as path from 'path';
import {
  Duration,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TENANT_PK_PREFIX } from '../../data/persistence';
import { BOOKING_TABLE_ENV } from '../booking';
import { ORDER_TABLE_ENV } from '../orders';
import { NOTIFICATION_FROM_ENV, NOTIFICATION_TABLE_ENV } from '../notification';
import {
  ACTION_ROUTING,
  FAILURE_SK_PREFIX,
  FAILURE_ENTITY_TYPE,
  WorkflowActionType,
  WorkflowServiceTarget,
} from '../orchestration';

/** CloudWatch namespace/metric for recorded WF-1 step failures (Requirement 13.4). */
export const WF1_METRIC_NAMESPACE = '1145/Workflows';
export const WF1_FAILURE_METRIC = 'WorkflowStepFailure';

/** Event-bus source/detail-type the orchestrator listens for. */
export const WF1_EVENT_SOURCE = '1145.workflows';
export const WF1_EVENT_DETAIL_TYPE = 'WorkflowActionRequested';

export interface WorkflowOrchestratorProps {
  /** DM-2 single table — destination for `FAILURE#<execId>` records. */
  readonly table: dynamodb.ITable;
}

export class WorkflowOrchestrator extends Construct {
  /** The WF-1 state machine. Its ARN is exported via shared/wiring by the stack. */
  readonly stateMachine: sfn.StateMachine;

  /** The EventBridge bus fronting the orchestrator. */
  readonly eventBus: events.EventBus;

  /** Placeholder service Lambdas (replaced by tasks 15.1 / 16.1 / 17.1). */
  readonly serviceFunctions: Record<WorkflowServiceTarget, lambda.Function>;

  constructor(scope: Construct, id: string, props: WorkflowOrchestratorProps) {
    super(scope, id);

    // --- Service targets -------------------------------------------------
    // WF-2 Booking and WF-3 Orders are REAL services (tasks 15.1 / 16.1): their
    // code is the workflows/booking and workflows/orders handlers, persisting
    // tenant-partitioned Booking / Order items to DM-2 via the shared
    // TenantPersistence wrapper. Notification is the REAL WF-4/5 service
    // (task 17.1): it sends an SES email and a conditional SNS SMS scoped to the
    // action's tenant and records delivery failures.
    this.serviceFunctions = {
      BookingService: this.bookingFunction(props.table),
      OrdersService: this.ordersFunction(props.table),
      NotificationService: this.notificationFunction(props.table),
    };

    // --- Failure handling chain (Requirement 13.4 / design Property 16) --
    // 1) Write a tenant-scoped FAILURE#<execId> item to DM-2. The PK is built
    //    from the SAME tenantId that rode the execution input, so the failure
    //    record is partitioned exactly like every other durable record
    //    (design Property 3); the SK reuses the shared FAILURE# format.
    const recordFailure = new tasks.DynamoPutItem(this, 'RecordFailure', {
      table: props.table,
      item: {
        PK: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format(`${TENANT_PK_PREFIX}{}`, sfn.JsonPath.stringAt('$.tenantId')),
        ),
        SK: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format(`${FAILURE_SK_PREFIX}{}`, sfn.JsonPath.stringAt('$$.Execution.Name')),
        ),
        entityType: tasks.DynamoAttributeValue.fromString(FAILURE_ENTITY_TYPE),
        tenantId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.tenantId')),
        createdAt: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt('$$.State.EnteredTime'),
        ),
        data: tasks.DynamoAttributeValue.fromMap({
          execId: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt('$$.Execution.Name'),
          ),
          actionType: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt('$.actionType'),
          ),
          error: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.error.Error')),
          cause: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.error.Cause')),
          outcome: tasks.DynamoAttributeValue.fromString('error'),
        }),
      },
      // Keep the original state (incl. tenantId + error) for the metric step.
      resultPath: sfn.JsonPath.DISCARD,
    });

    // 2) Emit a CloudWatch metric for the failure.
    const emitFailureMetric = new tasks.CallAwsService(this, 'EmitFailureMetric', {
      service: 'cloudwatch',
      action: 'putMetricData',
      parameters: {
        Namespace: WF1_METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: WF1_FAILURE_METRIC,
            Value: 1,
            Unit: 'Count',
          },
        ],
      },
      // PutMetricData is not resource-scoped.
      iamResources: ['*'],
      resultPath: sfn.JsonPath.DISCARD,
    });

    // 3) Surface the action's outcome as an error (not a success).
    const actionFailed = new sfn.Fail(this, 'ActionFailed', {
      error: 'WorkflowActionFailed',
      cause: 'A WF-1 workflow step failed; a FAILURE record was recorded.',
    });

    const failureChain = recordFailure.next(emitFailureMetric).next(actionFailed);

    // --- Terminal success -----------------------------------------------
    const actionSucceeded = new sfn.Succeed(this, 'ActionSucceeded');

    // --- Service tasks (one per routable action type) --------------------
    // Each task is invoked with the tenantId carried through explicitly so the
    // tenant rides every state's input (design Property 7), and has a Catch onto
    // the failure chain (design Property 16).
    const serviceTask = (
      actionType: WorkflowActionType,
      target: WorkflowServiceTarget,
    ): sfn.IChainable => {
      const task = new tasks.LambdaInvoke(this, `${target}Task`, {
        lambdaFunction: this.serviceFunctions[target],
        payload: sfn.TaskInput.fromObject({
          // tenantId propagated into the task input, unchanged (Property 7).
          tenantId: sfn.JsonPath.stringAt('$.tenantId'),
          actionType: sfn.JsonPath.stringAt('$.actionType'),
          // Full initiating action passed through for the service to consume.
          action: sfn.JsonPath.entirePayload,
        }),
        resultPath: '$.result',
      });
      task.addCatch(failureChain, {
        errors: ['States.ALL'],
        resultPath: '$.error',
      });
      return task.next(actionSucceeded);
    };

    // --- Routing Choice (design Property 15) -----------------------------
    // Branches generated from the shared ACTION_ROUTING table so the deployed
    // routing cannot diverge from the in-process routeActionType() function.
    const route = new sfn.Choice(this, 'RouteByActionType');
    (Object.entries(ACTION_ROUTING) as [WorkflowActionType, WorkflowServiceTarget][]).forEach(
      ([actionType, target]) => {
        route.when(
          sfn.Condition.stringEquals('$.actionType', actionType),
          serviceTask(actionType, target),
        );
      },
    );
    // Unknown action types are not routed anywhere — surface an error outcome.
    route.otherwise(
      new sfn.Fail(this, 'UnknownAction', {
        error: 'UnknownWorkflowAction',
        cause: 'No WF-1 service matches the action type.',
      }),
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: '1145-wf1-orchestrator',
      definitionBody: sfn.DefinitionBody.fromChainable(route),
      tracingEnabled: true,
      timeout: Duration.minutes(5),
    });

    // --- EventBridge bus fronting the state machine (Requirement 13.1) ---
    // An initiating action can arrive as an event on this bus (e.g. from the
    // Tool Gateway). A rule forwards the event's `detail` — which carries
    // `{ tenantId, actionType, payload }` — straight into the execution input,
    // so the tenant propagates from the producer through every state.
    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: '1145-wf1-bus',
    });

    new events.Rule(this, 'ActionRoutingRule', {
      eventBus: this.eventBus,
      ruleName: '1145-wf1-route-action',
      description: 'Route WF-1 initiating actions to the orchestrator state machine.',
      eventPattern: {
        source: [WF1_EVENT_SOURCE],
        detailType: [WF1_EVENT_DETAIL_TYPE],
      },
      targets: [
        new targets.SfnStateMachine(this.stateMachine, {
          input: events.RuleTargetInput.fromEventPath('$.detail'),
        }),
      ],
    });
  }

  /**
   * Build the REAL WF-2 Booking service Lambda (task 15.1). Its code is the
   * `workflows/booking` handler, which creates a tenant-scoped booking and
   * persists it to the DM-2 single table with `PK = TENANT#<tenantId>` via the
   * shared `TenantPersistence` wrapper (design WF-2; Requirements 14.1–14.3).
   *
   * The function is granted write access to the DM-2 table and receives the
   * table name via {@link BOOKING_TABLE_ENV}. This wiring is intentionally
   * localized to the Booking target only — Orders/Notification remain
   * placeholders owned by tasks 16.1 / 17.1.
   */
  private bookingFunction(table: dynamodb.ITable): lambda.Function {
    const fn = new lambda.Function(this, 'BookingServiceFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      timeout: Duration.seconds(30),
      description: 'WF-2 Booking service — creates tenant-scoped bookings in DM-2',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'booking')),
      environment: {
        [BOOKING_TABLE_ENV]: table.tableName,
      },
    });
    // The booking handler writes Booking items to DM-2 through TenantPersistence.
    table.grantWriteData(fn);
    return fn;
  }

  /**
   * Build the REAL WF-3 Orders service Lambda (task 16.1). Its code is the
   * `workflows/orders` handler, which creates a tenant-scoped order and
   * persists it to the DM-2 single table with `PK = TENANT#<tenantId>` via the
   * shared `TenantPersistence` wrapper using a single conditional write; an
   * invalid order is rejected with a validation error and no partial order is
   * persisted (design WF-3; Requirements 15.1–15.3).
   *
   * The function is granted write access to the DM-2 table and receives the
   * table name via {@link ORDER_TABLE_ENV}. This wiring is intentionally
   * localized to the Orders target only — Notification remains a placeholder
   * owned by task 17.1.
   */
  private ordersFunction(table: dynamodb.ITable): lambda.Function {
    const fn = new lambda.Function(this, 'OrdersServiceFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      timeout: Duration.seconds(30),
      description: 'WF-3 Orders service — creates tenant-scoped orders in DM-2',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'orders')),
      environment: {
        [ORDER_TABLE_ENV]: table.tableName,
      },
    });
    table.grantWriteData(fn);
    return fn;
  }

  /**
   * Build the REAL WF-4/5 Notification service Lambda (task 17.1). Its code is
   * the `workflows/notification` handler, which — on a confirmed booking/order —
   * sends an email confirmation via SES and, when the action carries an
   * SMS-capable contact, an SMS confirmation via SNS, scoping content and
   * recipients to the action's `tenantId`; a failed delivery attempt is recorded
   * as a tenant-scoped failure item in DM-2 and never rolls back the
   * confirmation (design WF-4/5; Requirements 16.1–16.4).
   *
   * The function is granted SES send + SNS publish permissions and write access
   * to the DM-2 table (for the delivery-failure record), and receives the table
   * name via {@link NOTIFICATION_TABLE_ENV} and the verified sender via
   * {@link NOTIFICATION_FROM_ENV}. This wiring is intentionally localized to the
   * Notification target only — Booking/Orders are untouched.
   */
  private notificationFunction(table: dynamodb.ITable): lambda.Function {
    const fn = new lambda.Function(this, 'NotificationServiceFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      timeout: Duration.seconds(30),
      description:
        'WF-4/5 Notification service — SES email + conditional SNS SMS, tenant-scoped',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'notification')),
      environment: {
        [NOTIFICATION_TABLE_ENV]: table.tableName,
        // The verified SES sender; overridable per environment via the stack.
        [NOTIFICATION_FROM_ENV]: 'no-reply@1145.ai',
      },
    });
    // The handler records delivery failures as tenant-partitioned Failure items.
    table.grantWriteData(fn);
    // SES email send + SNS SMS publish. Neither is resource-scoped here (SES
    // identities and SNS SMS publish to phone numbers are account-scoped).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        resources: ['*'],
      }),
    );
    return fn;
  }

  /**
   * Build a placeholder service Lambda. It echoes its tenant-scoped input so
   * the routing graph is exercisable end-to-end; tasks 15.1 / 16.1 / 17.1
   * replace the code with the real Booking / Orders / Notification services.
   */
  private placeholderFunction(
    id: string,
    label: string,
    ownerTask: number,
  ): lambda.Function {
    return new lambda.Function(this, `${id}Fn`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      description: `WF-1 ${label} placeholder — replaced by task ${ownerTask}.1`,
      code: lambda.Code.fromInline(
        // Echoes input (incl. tenantId) and marks itself a placeholder. The
        // real handler is provided by task ${ownerTask}.1.
        `exports.handler = async (event) => ({ ...event, status: 'placeholder', service: '${id}' });`,
      ),
    });
  }
}
