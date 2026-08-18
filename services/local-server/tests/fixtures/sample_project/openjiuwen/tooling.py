"""Tool definitions."""

from openjiuwen.core.foundation.tool import ToolCard, tool


class BaseTool:
    """Base tool contract."""


class WeatherTool(BaseTool):
    """Returns deterministic weather in tests."""

    card = ToolCard(
        name="weather_lookup",
        description="Look up deterministic weather.",
        stateless=True,
        parallel_safe=True,
        idempotent=True,
    )

    def invoke(self, city: str) -> str:
        return city


@tool(name="city_search", description="Search a city.", stateless=True)
def search_city(query: str, limit: int = 5) -> list[str]:
    """Return synthetic city matches."""

    return [query][:limit]


CITY_CARD = ToolCard(
    name="city_card",
    description="Card-only fixture.",
    input_params={"type": "object", "properties": {"city": {"type": "string"}}},
)


def bind_tools(agent, resource_manager) -> None:
    """Exercise exact, inferred and dynamic registration paths."""

    weather = WeatherTool()
    agent.ability_manager.add_ability(weather.card, weather)
    agent.ability_manager.add(CITY_CARD)
    resource_manager.resource_mgr.add_tool(search_city)
    agent.ability_manager.add(runtime_card)


def helper() -> str:
    return "not indexed unless includeFunctions is enabled"
