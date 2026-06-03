/**
 * MonitoringStack - aggregate composite alarm for the Earthquake Agent system.
 *
 * Creates a single composite alarm that enters ALARM state when ANY of the
 * individual component alarms fire. This gives operators a single pane of
 * glass: if the composite alarm is OK, the whole system is healthy.
 */

import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

/** All alarm names created by addLambdaAlarms and addApiGatewayAlarms across stacks. */
const CHILD_ALARM_NAMES = [
  // AgentStack
  "earthquake-agent-agent-errors",
  "earthquake-agent-agent-throttles",
  // DataApiStack
  "earthquake-agent-data-api-errors",
  "earthquake-agent-data-api-throttles",
  "earthquake-agent-data-api-5xx",
  // WebhookReceiverStack
  "earthquake-agent-webhook-receiver-errors",
  "earthquake-agent-webhook-receiver-throttles",
  "earthquake-agent-webhook-api-5xx",
  // SubscriptionManagerStack
  "earthquake-agent-subscription-manager-errors",
  "earthquake-agent-subscription-manager-throttles",
  // UsgsServerStack (via McpServerConstruct, exportPrefix = "UsgsMcp")
  "earthquake-agent-usgsmcp-errors",
  "earthquake-agent-usgsmcp-throttles",
  "earthquake-agent-usgsmcp-5xx",
  // SchedulerServerStack (via McpServerConstruct, exportPrefix = "SchedulerMcp")
  "earthquake-agent-schedulermcp-errors",
  "earthquake-agent-schedulermcp-throttles",
  "earthquake-agent-schedulermcp-5xx",
  // WebhookReceiverStack DLQ alarm (pre-existing)
  "earthquake-agent-webhook-dlq-depth",
  // Log-based error alarms (application-level errors)
  "earthquake-agent-agent-log-errors",
  "earthquake-agent-data-api-log-errors",
  "earthquake-agent-webhook-receiver-log-errors",
  "earthquake-agent-subscription-manager-log-errors",
  "earthquake-agent-usgsmcp-log-errors",
  "earthquake-agent-schedulermcp-log-errors",
];

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const childAlarms = CHILD_ALARM_NAMES.map((name) =>
      cloudwatch.Alarm.fromAlarmName(this, name, name),
    );

    const topic = new sns.Topic(this, "AlarmTopic", {
      topicName: "earthquake-agent-alarms",
      displayName: "Earthquake Agent System Alarms",
    });

    const compositeAlarm = new cloudwatch.CompositeAlarm(this, "SystemHealthAlarm", {
      compositeAlarmName: "earthquake-agent-system-health",
      alarmDescription:
        "Aggregate alarm for the Earthquake Agent system - fires when any component alarm is in ALARM state",
      alarmRule: cloudwatch.AlarmRule.anyOf(...childAlarms),
    });

    compositeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value: topic.topicArn,
      description: "SNS topic ARN for system health alarm notifications",
      exportName: "EarthquakeAgent-AlarmTopicArn",
    });
  }
}
