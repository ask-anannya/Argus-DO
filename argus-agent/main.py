# argus-agent/main.py
import os
import json
import datetime
import httpx
from typing import Annotated
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.graph.message import AnyMessage, add_messages
from typing import TypedDict
from gradient_adk import entrypoint

# ── Config ────────────────────────────────────────────────────────────────────

ARGUS_BACKEND  = os.environ["ARGUS_BACKEND_URL"]
INTERNAL_TOKEN = os.environ["INTERNAL_API_SECRET"]
HEADERS        = {"x-internal-secret": INTERNAL_TOKEN, "Content-Type": "application/json"}

llm = ChatOpenAI(
    model="llama3.3-70b-instruct",
    base_url="https://inference.do-ai.run/v1",
    api_key=os.environ["GRADIENT_MODEL_ACCESS_KEY"],
    temperature=0.3,
)

# ── Tools ─────────────────────────────────────────────────────────────────────

@tool
def search_events(query: str) -> str:
    """Search the user's WhatsApp memory for relevant events, tasks, reminders,
    and commitments. Use this whenever the user asks about past plans, deadlines,
    recommendations, or anything they may have discussed in WhatsApp."""
    resp = httpx.post(
        f"{ARGUS_BACKEND}/api/internal/search",
        headers=HEADERS,
        json={"query": query},
        timeout=10.0,
    )
    resp.raise_for_status()
    events = resp.json().get("events", [])
    if not events:
        return "No relevant events found in memory."
    return json.dumps(events, indent=2)


@tool
def get_event(event_id: int) -> str:
    """Retrieve full details of a specific event by its ID. Use this after
    search_events returns results and you need complete information about
    a particular event."""
    resp = httpx.get(
        f"{ARGUS_BACKEND}/api/internal/events/{event_id}",
        headers=HEADERS,
        timeout=10.0,
    )
    if resp.status_code == 404:
        return f"Event {event_id} not found."
    resp.raise_for_status()
    return json.dumps(resp.json().get("event", {}), indent=2)


tools = [search_events, get_event]
llm_with_tools = llm.bind_tools(tools)

# ── LangGraph state ───────────────────────────────────────────────────────────

class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]

SYSTEM_PROMPT = """You are Argus, a proactive memory assistant. You have access to the
user's WhatsApp conversation history, stored as structured events (appointments, tasks,
reminders, recommendations, deadlines, subscriptions).

Your job:
1. Search memory using the search_events tool before answering any factual question
2. Be specific — cite exact event titles, dates, and contacts when relevant
3. If multiple events match, summarise all of them
4. If nothing is found, say so clearly — never hallucinate events
5. Keep answers concise and actionable

Today's date: {date}"""


def call_model(state: AgentState) -> AgentState:
    system = SYSTEM_PROMPT.format(date=datetime.date.today().isoformat())
    response = llm_with_tools.invoke(
        [SystemMessage(content=system)] + state["messages"]
    )
    return {"messages": [response]}

# ── Build LangGraph workflow ───────────────────────────────────────────────────

workflow = StateGraph(AgentState)
workflow.add_node("agent",  call_model)
workflow.add_node("tools",  ToolNode(tools))
workflow.set_entry_point("agent")
workflow.add_conditional_edges("agent", tools_condition)
workflow.add_edge("tools", "agent")
graph = workflow.compile()

# ── ADK Entrypoint ────────────────────────────────────────────────────────────

@entrypoint
def entry(payload: dict, context: dict) -> dict:
    query   = payload.get("prompt", "")
    history = payload.get("messages", [])

    messages = [HumanMessage(content=msg) for msg in history]
    messages.append(HumanMessage(content=query))

    result = graph.invoke({"messages": messages})
    last   = result["messages"][-1]
    return {"response": last.content}
