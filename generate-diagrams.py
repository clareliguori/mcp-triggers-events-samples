"""Generate architecture diagrams using the diagrams library."""
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.integration import SimpleQueueServiceSqs as SQS
from diagrams.aws.integration import Eventbridge
from diagrams.aws.network import APIGateway, CloudFront
from diagrams.aws.storage import SimpleStorageServiceS3 as S3
from diagrams.aws.ml import Bedrock
from diagrams.aws.security import Cognito
from diagrams.aws.general import General
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

# Diagram 1: High-level overview (simplified - no subscription manager)
with Diagram(
    "",
    filename=f"{outdir}/1-overview",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
    outformat="png",
):
    with Cluster("MCP Server 1\nUSGS Earthquake Feed"):
        usgs = General("USGS API")
        s1_lambda = Lambda("Handler")
        s1_ddb = Dynamodb("Subscriptions")

    with Cluster("MCP Server 2\nMessage Scheduler"):
        s2_eb = Eventbridge("EventBridge")
        s2_lambda = Lambda("Handler")
        s2_ddb = Dynamodb("Subscriptions")

    with Cluster("MCP Client/Host - Serverless Application"):
        receiver = APIGateway("Webhook\nReceiver")
        sqs = SQS("Event Queue")
        agent = Lambda("Strands Agent")
        bedrock = Bedrock("LLM")
        sessions = S3("Sessions")

    usgs >> Edge(style="dashed") >> s1_lambda
    s1_lambda >> s1_ddb
    s2_eb >> s2_lambda >> s2_ddb

    s1_lambda >> Edge(color="darkorange", style="bold") >> receiver
    s2_lambda >> Edge(color="darkorange", style="bold") >> receiver

    receiver >> sqs >> agent
    agent >> bedrock
    agent >> sessions


# Diagram 2: Event delivery flow (with lock, reports, Data API)
with Diagram(
    "",
    filename=f"{outdir}/2-event-delivery",
    show=False,
    direction="LR",
    graph_attr={**graph_attr, "ranksep": "1.0"},
    outformat="png",
):
    with Cluster("MCP Server"):
        server_lambda = Lambda("Handler")

    with Cluster("MCP Client/Host"):
        recv = APIGateway("Webhook\nReceiver\n(validates HMAC)")
        sqs = SQS("Queue")
        agent = Lambda("Strands Agent")
        lock = Dynamodb("Lock")
        bedrock = Bedrock("LLM")
        sessions = S3("Sessions")
        reports = S3("Reports")
        config_db = Dynamodb("Customer\nConfig")
        data_api = APIGateway("Data API")

    server_lambda >> Edge(
        color="darkorange",
        style="bold",
        label="signed POST\n+ X-MCP-Subscription-Id",
    ) >> recv
    recv >> Edge(label="sends\nmessage") >> sqs
    sqs >> Edge(label="wakes") >> agent
    agent >> lock
    agent >> Edge() >> bedrock
    agent >> Edge() >> sessions
    agent >> data_api
    data_api >> config_db
    data_api >> reports


# Diagram 3: Subscription management (reads from Data API too)
with Diagram(
    "",
    filename=f"{outdir}/3-subscriptions",
    show=False,
    direction="TB",
    graph_attr={**graph_attr, "nodesep": "1.2"},
    outformat="png",
):
    with Cluster("Triggers"):
        stream = Dynamodb("DynamoDB Stream\n(config change)")
        eb = Eventbridge("EventBridge\n(every 5 min)")

    sub_mgr = Lambda("Subscription Manager")

    with Cluster("MCP Server 1"):
        s1_gw = APIGateway("API Gateway")
        s1 = Lambda("USGS Feed")

    with Cluster("MCP Server 2"):
        s2_gw = APIGateway("API Gateway")
        s2 = Lambda("Scheduler")

    data_api = APIGateway("Data API")
    config_db = Dynamodb("Customer\nConfig")

    stream >> sub_mgr
    eb >> sub_mgr

    sub_mgr >> Edge(
        style="dashed", color="steelblue",
        label="events/subscribe\n(filters + whsec_)",
    ) >> s1_gw
    s1_gw >> s1

    sub_mgr >> Edge(
        style="dashed", color="steelblue",
        label="events/subscribe\n(interval + whsec_)",
    ) >> s2_gw
    s2_gw >> s2

    sub_mgr >> Edge(label="reads customers\n& stores subscriptions") >> data_api
    data_api >> config_db


# Diagram 4: Webapp
with Diagram(
    "",
    filename=f"{outdir}/4-webapp",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
    outformat="png",
):
    with Cluster("Frontend"):
        cf = CloudFront("CloudFront")
        spa = S3("SvelteKit SPA")

    cognito = Cognito("Cognito\n(auth)")

    with Cluster("Backend"):
        data_api = APIGateway("Data API")
        config_db = Dynamodb("Customer\nConfig")
        reports = S3("Reports")
        sessions = S3("Sessions\n(read-only)")

    cf >> spa
    cf >> Edge(label="Cognito JWT") >> data_api
    cognito >> Edge(style="dashed") >> cf
    data_api >> config_db
    data_api >> reports
    data_api >> sessions
