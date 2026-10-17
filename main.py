from dotenv import load_dotenv
from typing import TypedDict, Annotated

from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_openrouter import ChatOpenRouter
from langchain_core.messages import BaseMessage, SystemMessage, HumanMessage

from tools import *
from pathlib import Path


load_dotenv()

tools = [get_date_time]

BASE_DIR = Path(__file__).resolve().parent.parent
skills = (BASE_DIR / "FinAgent" / "skills" / "System.md").read_text(
        encoding="utf-8")

Model = ChatOpenRouter(
        model="liquid/lfm-2.5-2.6b:free",
        temperature=0,
        )

model_with_tools = Model.bind_tools(tools)

class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

def call_model(state: AgentState):
    messages = [
            SystemMessage(content=skills),
            *state["messages"]
            ]
    responds = model_with_tools.invoke(messages)
    return {"messages": [responds]}

builder = StateGraph(AgentState)
builder.add_node("assistant", call_model)
builder.add_node("tools", ToolNode(tools))

builder.add_edge(START, "assistant")
builder.add_conditional_edges(
        "assistant",
        tools_condition,
        {
            "tools": "tools",
            END: END,
        },
        )
builder.add_edge("tools", "assistant")

app = builder.compile()

if __name__ == "__main__":
    result = app.invoke({
        "messages":[
            HumanMessage(
                content="what is the time now, and what can you do?"
                )
            ]
        })
    print(result["messages"][-1].content)


