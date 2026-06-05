"""Generate architecture diagrams using the diagrams library."""
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.integration import SimpleQueueServiceSqs as SQS
from diagrams.aws.integration import Eventbridge
from diagrams.aws.network import APIGateway
from diagrams.aws.storage import SimpleStorageServiceS3 as S3
from diagrams.aws.ml import Bedrock
from diagrams.aws.security import Cognito
from diagrams.aws.general import General
from diagrams.custom import Custom
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))
outdir = "diagrams"
os.makedirs(outdir, exist_ok=True)

graph_attr = {
    "fontsize": "13",
    "bgcolor": "white",
    "pad": "0.5",
    "nodesep": "0.8",
    "ranksep": "1.0",
}

# Diagram 1: High-level overview
with Diagram(
    "MCP Events - High-Level Overview",
    filename=f"{outdir}/1-overview",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
    outformat="png",
):
    usgs = General("USGS API")

    with Cluster("MCP Server 1\nUSGS Earthquake Feed"):
        s1_lambda = Lambda("Handler")
        s1_ddb = Dynamodb("Subscriptions")

    with Cluster("MCP Server 2\nMessage Scheduler"):
        s2_lambda = Lambda("Handler")
        s2_ddb = Dynamodb("Subscriptions")

    with Cluster("MCP Client/Host - Serverless Application"):
        receiver = APIGateway("Webhook\nReceiver")
        sqs = SQS("Event Queue")
        agent = Lambda("Strands Agent")
        bedrock = Bedrock("LLM")
        sessions = S3("Sessions")
        sub_mgr = Lambda("Subscription\nManager")

    usgs >> Edge(style="dashed", label="polls") >> s1_lambda
    s1_lambda >> s1_ddb

    s1_lambda >> Edge(color="darkorange", style="bold", label="earthquake.detected") >> receiver
    s2_lambda >> Edge(color="darkorange", style="bold", label="briefing.trigger") >> receiver
    s2_lambda >> s2_ddb

    sub_mgr >> Edge(style="dashed", color="steelblue", label="events/subscribe") >> s1_lambda
    sub_mgr >> Edge(style="dashed", color="steelblue", label="events/subscribe") >> s2_lambda

    receiver >> sqs >> agent
    agent >> bedrock
    agent >> sessions


# Diagram 2: Event delivery flow
with Diagram(
    "Event Delivery Flow",
    filename=f"{outdir}/2-event-delivery",
    show=False,
    direction="LR",
    graph_attr={**graph_attr, "ranksep": "1.2"},
    outformat="png",
):
    eb = Eventbridge("EventBridge\n(schedule)")

    with Cluster("MCP Server"):
        server_lambda = Lambda("Handler")
        server_ddb = Dynamodb("Subscriptions")

    with Cluster("MCP Client/Host"):
        recv = APIGateway("Webhook\nReceiver")
        sqs = SQS("Queue")
        agent = Lambda("Strands Agent")
        bedrock = Bedrock("LLM")
        s3 = S3("Session\n(S3)")

    eb >> Edge(label="triggers") >> server_lambda
    server_lambda >> server_ddb
    server_lambda >> Edge(
        color="darkorange",
        style="bold",
        label="signed POST\n+ X-MCP-Subscription-Id",
    ) >> recv
    recv >> Edge(label="validates\nHMAC") >> sqs
    sqs >> Edge(label="wakes") >> agent
    agent >> Edge(label="invokes") >> bedrock
    agent >> Edge(label="persists") >> s3


# Diagram 3: Subscription management
with Diagram(
    "Subscription Management",
    filename=f"{outdir}/3-subscriptions",
    show=False,
    direction="TB",
    graph_attr={**graph_attr, "nodesep": "1.2"},
    outformat="png",
):
    with Cluster("Triggers"):
        stream = Dynamodb("DynamoDB Stream\n(new customer)")
        eb = Eventbridge("EventBridge\n(every 5 min)")

    sub_mgr = Lambda("Subscription Manager")

    with Cluster("MCP Server 1\nUSGS Feed"):
        s1 = Lambda("Handler")

    with Cluster("MCP Server 2\nScheduler"):
        s2 = Lambda("Handler")

    data_api = APIGateway("Data API\n(stores records)")

    stream >> sub_mgr
    eb >> sub_mgr

    sub_mgr >> Edge(
        style="dashed", color="steelblue",
        label="events/subscribe\n(filters + whsec_)",
    ) >> s1

    sub_mgr >> Edge(
        style="dashed", color="steelblue",
        label="events/subscribe\n(schedule + whsec_)",
    ) >> s2

    sub_mgr >> Edge(label="stores") >> data_api
