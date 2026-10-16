
from datetime import datetime
from langchain.tools import tool

@tool
def get_date_time() -> str:
    """Get the current local date, time and UTC offset.""" 
    return datetime.now().astimezone().isoformat()
