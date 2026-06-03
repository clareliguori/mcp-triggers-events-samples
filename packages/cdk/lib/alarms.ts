/**
 * Shared CloudWatch alarm helpers for the Earthquake Agent CDK stacks.
 *
 * Adds standard Lambda error/throttle alarms and API Gateway 5xx alarms
 * to keep alarm definitions consistent and DRY across stacks.
 */

import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * Add standard error and throttle alarms to a Lambda function.
 *
 * - **Errors**: alarms when there are >= 1 errors in a 5-minute window
 *   (sustained for 1 evaluation period).
 * - **Throttles**: alarms when there are >= 1 throttles in a 5-minute window.
 */
export function addLambdaAlarms(
  scope: Construct,
  id: string,
  fn: lambda.IFunction,
): { errorAlarm: cloudwatch.Alarm; throttleAlarm: cloudwatch.Alarm } {
  const errorAlarm = new cloudwatch.Alarm(scope, `${id}ErrorAlarm`, {
    alarmName: `earthquake-agent-${id}-errors`,
    alarmDescription: `Lambda errors on ${id}`,
    metric: fn.metricErrors({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  const throttleAlarm = new cloudwatch.Alarm(scope, `${id}ThrottleAlarm`, {
    alarmName: `earthquake-agent-${id}-throttles`,
    alarmDescription: `Lambda throttles on ${id}`,
    metric: fn.metricThrottles({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return { errorAlarm, throttleAlarm };
}

/**
 * Add a 5xx error alarm to a REST API Gateway.
 *
 * Alarms when there are >= 1 server errors in a 5-minute window.
 */
export function addApiGatewayAlarms(
  scope: Construct,
  id: string,
  api: apigateway.RestApi,
): { serverErrorAlarm: cloudwatch.Alarm } {
  const serverErrorAlarm = new cloudwatch.Alarm(scope, `${id}5xxAlarm`, {
    alarmName: `earthquake-agent-${id}-5xx`,
    alarmDescription: `API Gateway 5xx errors on ${id}`,
    metric: api.metricServerError({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return { serverErrorAlarm };
}

/**
 * Add an alarm that fires when the Lambda logs contain ERROR-level messages.
 *
 * This catches application-level errors that are handled gracefully (the
 * function returns success) but indicate something is wrong — e.g. a
 * subscription creation failure that is logged and skipped.
 */
export function addLogErrorAlarm(
  scope: Construct,
  id: string,
  fn: lambda.IFunction,
): { logErrorAlarm: cloudwatch.Alarm } {
  const logGroup = logs.LogGroup.fromLogGroupName(
    scope,
    `${id}LogGroup`,
    `/aws/lambda/${fn.functionName}`,
  );

  const metricFilter = new logs.MetricFilter(scope, `${id}ErrorFilter`, {
    logGroup,
    filterPattern: logs.FilterPattern.literal("ERROR"),
    metricNamespace: "EarthquakeAgent",
    metricName: `${id}-log-errors`,
    metricValue: "1",
  });

  const logErrorAlarm = new cloudwatch.Alarm(scope, `${id}LogErrorAlarm`, {
    alarmName: `earthquake-agent-${id}-log-errors`,
    alarmDescription: `Application-level ERROR messages in ${id} logs`,
    metric: metricFilter.metric({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return { logErrorAlarm };
}
