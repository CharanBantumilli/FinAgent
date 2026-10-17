import os
from pathlib import Path
from typing import Annotated, TypedDict
from dotenv import load_dotenv
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from tools import (
    get_date_time,
    harvest_company_graph_tool,
    query_contagion_and_sec_brain,
    query_tenant_memory_and_handoffs,
)

load_dotenv()

tools = [
    get_date_time,
    harvest_company_graph_tool,
    query_contagion_and_sec_brain,
    query_tenant_memory_and_handoffs,
]

# FIXED PATH: Reads skills/System.md directly relative to main.py
BASE_DIR = Path(__file__).resolve().parent
skills = (BASE_DIR / "skills" / "System.md").read_text(encoding="utf-8")


class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def build_langgraph_app():
    from langchain_openrouter import ChatOpenRouter

    model_name = os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")
    model = ChatOpenRouter(model=model_name, temperature=0)
    model_with_tools = model.bind_tools(tools)

    def call_model(state: AgentState):
        messages = [SystemMessage(content=skills), *state["messages"]]
        response = model_with_tools.invoke(messages)
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("assistant", call_model)
    builder.add_node("tools", ToolNode(tools))
    builder.add_edge(START, "assistant")
    builder.add_conditional_edges("assistant", tools_condition, {"tools": "tools", END: END})
    builder.add_edge("tools", "assistant")
    return builder.compile()


def run_finagent_query(question: str, ticker: str = "GOOGL", tenant_id: str = "investor_memory_tenant_1") -> str:
    """Runs the LangGraph agent with live FalkorDB context, falling back to deterministic graph synthesis if OPENROUTER_API_KEY is not configured or rate-limited."""
    ticker = ticker.upper().strip()
    graph_context = query_contagion_and_sec_brain.invoke({"ticker": ticker})
    mem_context = query_tenant_memory_and_handoffs.invoke({"tenant_id": tenant_id})

    if os.getenv("OPENROUTER_API_KEY"):
        try:
            app = build_langgraph_app()
            prompt = (
                f"User Question: {question}\n"
                f"Active Ticker: {ticker} | Active Tenant Graph: {tenant_id}\n\n"
                f"Live FalkorDB Graph Context:\n{graph_context}\n\n{mem_context}"
            )
            result = app.invoke({"messages": [HumanMessage(content=prompt)]})
            return result["messages"][-1].content
        except Exception as e:
            print(f"(OpenRouter note: falling back to direct FalkorDB graph synthesis: {e})")

    # Deterministic FalkorDB Graph-Grounded Synthesis (Always works even offline / without API key)
    return (
        f"🕸️ **FinAgent Explainable Graph Brief for `{ticker}`** *(Tenant: `{tenant_id}`)*\n\n"
        f"Here is the exact multi-hop evidence traversed from **FalkorDB**:\n\n"
        f"{graph_context}\n\n"
        f"{mem_context}\n\n"
        f"💡 **Traceability Verdict:** Every relationship above was queried directly across Track 1 (Shareholder & Supply-Chain Contagion), "
        f"Track 2 (`{tenant_id}` Episodic & Handoff Memory), and Track 3 (`[:SUPERSEDES]` SEC Filing Governance)."
    )


if __name__ == "__main__":
    print(run_finagent_query("What is the multi-hop risk and SEC filing lineage for GOOGL?", "GOOGL"))