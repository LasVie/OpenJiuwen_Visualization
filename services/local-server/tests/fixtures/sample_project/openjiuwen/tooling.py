"""Tool definitions."""


class BaseTool:
    """Base tool contract."""


class WeatherTool(BaseTool):
    """Returns deterministic weather in tests."""

    def invoke(self, city: str) -> str:
        return city


def helper() -> str:
    return "not indexed unless includeFunctions is enabled"
