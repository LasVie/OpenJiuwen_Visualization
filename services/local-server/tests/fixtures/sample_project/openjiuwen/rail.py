"""Rail definitions."""

from openjiuwen.deep_agent import DeepAgent


class AgentRail:
    """Base review rail."""


class SafetyRail(AgentRail):
    """Reviews a user message before invocation."""

    def before_invoke(self, message: str) -> str:
        return message


class Orchestrator(DeepAgent):
    """Confirms cross-module inheritance resolution."""
