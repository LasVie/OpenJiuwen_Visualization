"""Agent definitions."""


class BaseAgent:
    """Minimal test base agent."""

    async def invoke(self, query: str) -> str:
        return query


class DeepAgent(BaseAgent):
    """Coordinates an inner ReAct loop."""

    def create_subagent(self, name: str) -> "DeepAgent":
        return DeepAgent()
